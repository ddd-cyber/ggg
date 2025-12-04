const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = async (req, res) => {
  // 处理CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // 获取目标URL
  const url = req.url || '';
  const queryIndex = url.indexOf('?');
  let target = 'https://www.google.com';
  
  if (queryIndex !== -1) {
    const queryString = url.substring(queryIndex + 1);
    const params = new URLSearchParams(queryString);
    const targetParam = params.get('target');
    
    if (targetParam) {
      try {
        target = decodeURIComponent(targetParam);
        // 确保URL有协议
        if (!target.startsWith('http://') && !target.startsWith('https://')) {
          target = 'https://' + target;
        }
      } catch (e) {
        console.log('URL解码错误:', e);
      }
    }
  }
  
  console.log(`目标URL: ${target}`);
  
  // 提取基础URL
  let baseUrl;
  try {
    const urlObj = new URL(target);
    baseUrl = urlObj.origin;
  } catch (e) {
    baseUrl = 'https://www.google.com';
  }
  
  // 创建代理
  try {
    const proxy = createProxyMiddleware({
      target: baseUrl,
      changeOrigin: true,
      secure: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      onProxyRes: (proxyRes, req, res) => {
        // 删除可能阻止iframe的安全头
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
      }
    });
    
    proxy(req, res);
  } catch (error) {
    console.error('代理错误:', error);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1>代理错误</h1>
          <p>无法访问目标网站: ${target}</p>
          <p>错误: ${error.message}</p>
          <p><a href="/">返回首页</a></p>
        </body>
      </html>
    `);
  }
};
