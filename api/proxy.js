// api/proxy.js
// Vercel serverless proxy function (Node). 用于开发/学习测试。
// WARNING: 切勿用来规避法律或侵犯服务条款。请在合法合规的前提下使用。

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
  try {
    return ipToInt(ip) >= ipToInt(start) && ipToInt(ip) <= ipToInt(end);
  } catch (e) { return false; }
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
    // 获取 target 参数
    let raw = req.query && req.query.target ? req.query.target : null;
    if (!raw) {
      // 尝试从原始 URL 解析
      try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        raw = u.searchParams.get('target');
      } catch (e) { raw = null; }
    }
    if (!raw) {
      res.statusCode = 400;
      res.end('missing target');
      return;
    }
    let target;
    try { target = decodeURIComponent(raw); } catch (e) { target = raw; }

    let targetUrl;
    try { targetUrl = new URL(target); } catch (e) {
      res.statusCode = 400; res.end('invalid target url'); return;
    }
    if (!['http:','https:'].includes(targetUrl.protocol)) {
      res.statusCode = 400; res.end('only http(s) allowed'); return;
    }

    // SSRF 防护：阻止访问内网 IP
    if (await isPrivate(targetUrl.hostname)) {
      res.statusCode = 403; res.end('forbidden target'); return;
    }

    // 构造转发 headers（过滤掉 host/connection/encoding）
    const forbidden = new Set(['host','connection','content-length','accept-encoding']);
    const forwardHeaders = {};
    for (const k of Object.keys(req.headers || {})) {
      if (!forbidden.has(k.toLowerCase())) forwardHeaders[k] = req.headers[k];
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

    res.statusCode = upstream.status;

    const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
    const removeHeaders = new Set(['x-frame-options','frame-options','content-security-policy','content-security-policy-report-only']);

    upstream.headers.forEach((v, name) => {
      const n = name.toLowerCase();
      if (hopByHop.has(n)) return;
      if (removeHeaders.has(n)) return;
      res.setHeader(name, v);
    });

    // 添加可测试的 CORS header（根据需要调整或删除）
    res.setHeader('access-control-allow-origin','*');
    res.setHeader('access-control-allow-methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers','*');

    // 流式返回 body
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
