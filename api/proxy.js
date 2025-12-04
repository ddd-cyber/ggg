// 简单可靠的代理服务器
const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = async (req, res) => {
  // 处理CORS和预检请求
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // 解析目标URL
  const queryString = req.url.split('?')[1] || '';
  const params = new URLSearchParams(queryString);
  let targetUrl = params.get('target') || 'https://www.google.com';
  
  try {
    // 解码并验证URL
    targetUrl = decodeURIComponent(targetUrl);
    
    // 确保有协议头
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }
    
    // 提取基础URL（协议+域名+端口）
    const urlObj = new URL(targetUrl);
    const baseUrl = urlObj.origin;
    
    console.log(`代理请求到: ${baseUrl}`);
    
    // 配置代理
    const proxyOptions = {
      target: baseUrl,
      changeOrigin: true,
      secure: false,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      onProxyReq: (proxyReq, req, res) => {
        // 移除代理标识头
        proxyReq.removeHeader('x-forwarded-for');
        proxyReq.removeHeader('x-forwarded-host');
        proxyReq.removeHeader('x-vercel-id');
      },
      onProxyRes: (proxyRes, req, res) => {
        // 删除可能阻止在iframe中显示的安全头
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];
      },
      onError: (err, req, res) => {
        console.error('代理错误:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: Arial; padding: 40px;">
              <h1>代理错误</h1>
              <p>无法访问目标网站</p>
              <p><a href="/">返回首页</a></p>
            </body>
          </html>
        `);
      }
    };
    
    // 创建并执行代理
    const proxy = createProxyMiddleware(proxyOptions);
    return proxy(req, res);
    
  } catch (error) {
    console.error('URL解析错误:', error);
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <body style="font-family: Arial; padding: 40px;">
          <h1>URL格式错误</h1>
          <p>请检查您输入的网址格式是否正确</p>
          <p><a href="/">返回首页</a></p>
        </body>
      </html>
    `);
  }
};
