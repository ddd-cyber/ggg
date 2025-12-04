// Simple proxy for Vercel serverless (api/proxy.js)
// WARNING: For debugging and learning only. Don't use to violate laws, TOS, or to proxy sensitive traffic.
//
// Features:
// - Validates target URL and protocol
// - Resolves hostname and blocks common private/internal IP ranges (basic SSRF protection)
// - Forwards request method and many headers (sets a safe User-Agent by default)
// - Removes hop-by-hop headers and frame-blocking headers from responses
// - Streams response (fallback to arrayBuffer if needed)
// - Adds permissive CORS for easier testing (adjust for production)

const dns = require('dns').promises;
const net = require('net');

const PRIVATE_RANGES = [
  // IPv4 ranges (start, end) in integer form
  ['10.0.0.0', '10.255.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  // IPv6 localhost & ULA
  ['::1', '::1'],
  ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']
];

function ipToInt(ip) {
  if (net.isIPv4(ip)) {
    return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  }
  return null;
}
function inRange(ip, start, end) {
  if (!net.isIPv4(ip)) return false;
  const i = ipToInt(ip);
  const s = ipToInt(start);
  const e = ipToInt(end);
  if (i === null || s === null || e === null) return false;
  return i >= s && i <= e;
}
async function isPrivateAddress(hostname) {
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    for (const [s, e] of PRIVATE_RANGES) {
      if (inRange(address, s, e)) return true;
    }
    return false;
  } catch (err) {
    // If we cannot resolve, be conservative: return false (handled later)
    return false;
  }
}

module.exports = async (req, res) => {
  try {
    // Get target from query string robustly
    let rawTarget = null;
    if (req.query && req.query.target) rawTarget = req.query.target;
    else {
      // Fallback parse from URL (when req.query not present)
      try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        rawTarget = u.searchParams.get('target');
      } catch (e) { rawTarget = null; }
    }
    if (!rawTarget) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('missing target query parameter');
      return;
    }

    // decode once (handle already encoded and plain)
    let target;
    try {
      target = decodeURIComponent(rawTarget);
    } catch (e) {
      target = rawTarget;
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('invalid target URL');
      return;
    }

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      res.statusCode = 400;
      res.end('only http(s) targets are allowed');
      return;
    }

    // Basic SSRF protection: block private IPs
    const host = targetUrl.hostname;
    if (await isPrivateAddress(host)) {
      res.statusCode = 403;
      res.end('forbidden target (private/internal address)');
      return;
    }

    // Build headers to forward (copy most, but set Host to target host)
    const incomingHeaders = req.headers || {};
    const forbiddenRequestHeaders = new Set([
      'host', 'connection', 'content-length', 'accept-encoding' // let fetch handle encoding
    ]);
    const forwardHeaders = {};
    for (const k of Object.keys(incomingHeaders)) {
      if (!forbiddenRequestHeaders.has(k.toLowerCase())) {
        forwardHeaders[k] = incomingHeaders[k];
      }
    }
    // Ensure a browser-like UA to reduce bot blocking (can change)
    forwardHeaders['user-agent'] = forwardHeaders['user-agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';
    forwardHeaders['accept'] = forwardHeaders['accept'] || '*/*';
    forwardHeaders['host'] = targetUrl.host;

    // Use global fetch (Node 18+ / Vercel). Follow redirects.
    const fetchOptions = {
      method: req.method || 'GET',
      headers: forwardHeaders,
      redirect: 'follow'
    };

    // If incoming has body, stream it (for POST, PUT)
    if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method.toUpperCase())) {
      // Collect body
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fetchOptions.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(targetUrl.toString(), fetchOptions);

    // Copy status
    res.statusCode = upstream.status;

    // Filter and copy response headers
    const hopByHop = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade'
    ]);
    const stripHeaders = new Set([
      'x-frame-options', 'frame-options',
      'content-security-policy', 'content-security-policy-report-only',
      'x-content-security-policy', 'x-content-security-policy-report-only'
    ]);
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (hopByHop.has(lower)) return;
      if (stripHeaders.has(lower)) return; // remove frame/CSP restrictions
      // do not forward set-cookie domain attributes rewriting here (complex)
      res.setHeader(name, value);
    });

    // Add permissive CORS for testing convenience (adjust in production)
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', '*');

    // Stream body if possible
    const body = upstream.body;
    if (body && typeof body.pipe === 'function') {
      // Node stream (older)
      body.pipe(res);
    } else if (body && typeof body.getReader === 'function') {
      // WHATWG readable stream (pipe to Node res)
      const reader = body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } catch (e) {
          // ignore
        } finally {
          res.end();
        }
      })();
    } else {
      // Fallback: arrayBuffer
      const ab = await upstream.arrayBuffer();
      res.end(Buffer.from(ab));
    }
  } catch (err) {
    console.error('proxy error:', err && (err.stack || err.message || err));
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('proxy internal error: ' + (err && err.message ? err.message : 'unknown'));
  }
};
