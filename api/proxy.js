// api/proxy.js - 修复 content-encoding 导致的 ERR_CONTENT_DECODING_FAILED 问题
// 小提示：此实现尽量保留上游的有用 header，但会移除会导致问题或阻止嵌入的头。
// 注意：用于学习/测试。请遵守法律和服务条款。

const dns = require('dns').promises;
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
    // 获取 target
    let raw = req.query && req.query.target ? req.query.target : null;
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

    // SSRF 基本防护
    if (await isPrivate(targetUrl.hostname)) { res.statusCode = 403; res.end('forbidden target (private)'); return; }

    // 构造转发 headers（不转发 accept-encoding 等）
    const forbiddenRequestHeaders = new Set(['host','connection','content-length','accept-encoding']);
    const forwardHeaders = {};
    for (const k of Object.keys(req.headers || {})) {
      if (!forbiddenRequestHeaders.has(k.toLowerCase())) forwardHeaders[k] = req.headers[k];
    }
    forwardHeaders['user-agent'] = forwardHeaders['user-agent'] || 'Mozilla/5.0 (compatible; Proxy)';
    forwardHeaders['accept'] = forwardHeaders['accept'] || '*/*';
    forwardHeaders['host'] = targetUrl.host;

    const fetchOptions = { method: req.method || 'GET', headers: forwardHeaders, redirect: 'follow' };

    if (['POST','PUT','PATCH'].includes(fetchOptions.method.toUpperCase())) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fetchOptions.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(targetUrl.toString(), fetchOptions);

    // 将上游状态透传
    res.statusCode = upstream.status;

    // 过滤要删除的响应头
    const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
    const removeHeaders = new Set([
      'x-frame-options','frame-options',
      'content-security-policy','content-security-policy-report-only',
      'x-content-security-policy','x-content-security-policy-report-only',
      // 关键：不要把上游的 content-encoding 或 content-length 转发给浏览器，
      // 因为 node-fetch/undici 可能已经对响应解压或处理，导致头与 body 不匹配。
      'content-encoding','content-length'
    ]);

    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (hopByHop.has(lower)) return;
      if (removeHeaders.has(lower)) return;
      res.setHeader(name, value);
    });

    // 为测试方便添加 CORS（如需生产请调整）
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', '*');

    // 将 body 流回客户端
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
    console.error('proxy error', err && (err.stack || err.message || err));
    res.statusCode = 500;
    res.setHeader('content-type','text/plain; charset=utf-8');
    res.end('proxy internal error: ' + (err && err.message ? err.message : 'unknown'));
  }
};
