// api/proxy.js (debug mode)
// TEMPORARY debug proxy: if ?debug=1 is present it will return JSON with upstream status/headers/body-snippet
// WARNING: 用于调试，排查完成后请恢复为正常的 proxy 实现或删除 debug 逻辑。

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const PRIVATE_RANGES = [
  ['10.0.0.0','10.255.255.255'],
  ['127.0.0.0','127.255.255.255'],
  ['172.16.0.0','172.31.255.255'],
  ['192.168.0.0','192.168.255.255'],
  ['169.254.0.0','169.254.255.255']
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct,10), 0) >>> 0;
}
function inRange(ip, start, end) {
  try { return ipToInt(ip) >= ipToInt(start) && ipToInt(ip) <= ipToInt(end); }
  catch (e) { return false; }
}
async function isPrivate(hostname) {
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    for (const [s,e] of PRIVATE_RANGES) if (inRange(address, s, e)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  try {
    // 解析 target 和 debug 参数
    const qs = req.query || {};
    let raw = qs.target || null;
    if (!raw) {
      try { raw = (new URL(req.url, `http://${req.headers.host}`)).searchParams.get('target'); }
      catch (e) { raw = null; }
    }
    if (!raw) { res.statusCode = 400; res.end('missing target'); return; }
    let target;
    try { target = decodeURIComponent(raw); } catch { target = raw; }

    let targetUrl;
    try { targetUrl = new URL(target); } catch (e) { res.statusCode = 400; res.end('invalid target url'); return; }
    if (!['http:','https:'].includes(targetUrl.protocol)) { res.statusCode = 400; res.end('only http(s) allowed'); return; }

    // SSRF 基本防护：阻止内网
    if (await isPrivate(targetUrl.hostname)) { res.statusCode = 403; res.end('forbidden target (private)'); return; }

    // 构造转发 headers
    const forbidden = new Set(['host','connection','content-length','accept-encoding']);
    const forwardHeaders = {};
    for (const k of Object.keys(req.headers || {})) {
      if (!forbidden.has(k.toLowerCase())) forwardHeaders[k] = req.headers[k];
    }
    forwardHeaders['user-agent'] = forwardHeaders['user-agent'] || 'Mozilla/5.0 (compatible; ProxyDebug)';
    forwardHeaders['accept'] = forwardHeaders['accept'] || '*/*';
    forwardHeaders['host'] = targetUrl.host;

    const fetchOptions = { method: req.method || 'GET', headers: forwardHeaders, redirect: 'follow' };
    if (['POST','PUT','PATCH'].includes(fetchOptions.method.toUpperCase())) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fetchOptions.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(targetUrl.toString(), fetchOptions);

    // 如果请求包含 debug=1，则返回 JSON 调试信息，而不是直接流式转发
    const debugRequested = (qs.debug === '1' || qs.debug === 1 || (new URL(req.url, `http://${req.headers.host}`)).searchParams.get('debug') === '1');

    if (debugRequested) {
      // 收集 body snippet（仅限文本类型）
      const ct = upstream.headers.get('content-type') || '';
      let snippet = null;
      try {
        if (ct.startsWith('text/') || ct.includes('json') || ct.includes('html') || ct.includes('xml')) {
          const text = await upstream.text();
          snippet = text.slice(0, 2000); // 前 2000 字符
        } else {
          snippet = `<non-text content-type: ${ct}>`;
        }
      } catch (e) {
        snippet = `<failed to read body: ${e && e.message ? e.message : e}>`;
      }

      // 构造 headers 对象（转为普通 JSON）
      const hdrs = {};
      upstream.headers.forEach((v, k) => { hdrs[k] = v; });

      res.setHeader('content-type', 'application/json; charset=utf-8');
      // 允许跨域以便直接在浏览器 fetch 调试
      res.setHeader('access-control-allow-origin', '*');

      res.end(JSON.stringify({
        requestedTarget: targetUrl.toString(),
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        upstreamHeaders: hdrs,
        bodySnippet: snippet
      }, null, 2));
      return;
    }

    // 非 debug 模式：正常转发（移除会阻止嵌入的 header）
    res.statusCode = upstream.status;
    const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
    const removeHeaders = new Set(['x-frame-options','frame-options','content-security-policy','content-security-policy-report-only']);
    upstream.headers.forEach((v, name) => {
      const n = name.toLowerCase();
      if (hopByHop.has(n)) return;
      if (removeHeaders.has(n)) return;
      res.setHeader(name, v);
    });
    res.setHeader('access-control-allow-origin', '*');

    // 尝试流式返回
    const body = upstream.body;
    if (body && typeof body.pipe === 'function') {
      body.pipe(res);
    } else if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } catch (e) { /* ignore */ } finally { res.end(); }
      })();
    } else {
      const ab = await upstream.arrayBuffer();
      res.end(Buffer.from(ab));
    }
  } catch (err) {
    console.error('proxy debug error', err && (err.stack || err.message || err));
    res.statusCode = 500;
    res.setHeader('content-type','text/plain; charset=utf-8');
    res.end('proxy internal error: ' + (err && err.message ? err.message : 'unknown'));
  }
};
