# 简单网页代理（Vercel 部署示例）

说明
- 这是一个演示用的简单网页代理（index.html + api/proxy.js），适合部署到 Vercel 做学习、测试用。
- 强烈提醒：不要用来规避法律或服务条款。请在合法合规环境下使用。

文件
- index.html — 前端 UI（根目录）
- api/proxy.js — Vercel serverless proxy（Node）
- package.json — 指定 Node 版本与本地 dev 命令

快速本地运行（开发）
1. 安装依赖（项目很小，无额外依赖）：
   - git clone <your-repo>
   - cd <your-repo>
   - npm install

2. 安装 vercel CLI 并登录：
   - npm i -g vercel
   - vercel login

3. 在本地运行：
   - vercel dev
   - 打开 http://localhost:3000

部署到 Vercel（Web 控制台）
1. 在 GitHub 创建一个新仓库（例如 simple-vercel-proxy），把本项目文件 push 到该仓库（主分支）。
2. 登录 vercel.com → New Project → Import Git Repository → 选择你的仓库。
3. 在 Configure Project 页面：
   - Framework Preset：Other
   - Build & Output settings：通常无需 build（留空）
   - Root Directory：项目根目录（默认）
4. 点击 Deploy，等待完成。部署后会得到一个 *.vercel.app 域名。

部署到 Vercel（CLI）
1. git push 到你的仓库
2. 在本地运行：
   - vercel --prod
   - 按提示选择项目 / 创建新项目，完成后会返回生产域名

测试
- 在浏览器打开你的部署域名（例如 https://your-project.vercel.app）
- 在输入框输入完整 URL（必须包含 https://），点击“访问网站”
- 若 iframe 无法显示，请点击“新窗口打开”按钮在新标签页打开代理页面（/proxy?target=...）

排错步骤（遇到“代理错误”或空白）
1. 打开浏览器 DevTools → Network → 找到 /api/proxy 请求：
   - 记录 HTTP 状态码、Response headers、Response body 的错误信息
2. 在终端使用 curl 测试：
   - curl -v "https://your-deploy.vercel.app/api/proxy?target=https%3A%2F%2Ftwitter.com"
   - curl -I "https://your-deploy.vercel.app/api/proxy?target=https%3A%2F%2Ftwitter.com"
3. 查看 Vercel 日志：
   - Dashboard → Projects → 选择项目 → Deployments → 点击最近一次 → Logs
   - 或者本地用 vercel logs <deployment>（需要 vercel CLI）
4. 常见问题：
   - 5xx 错误：查看函数日志（可能是超时、fetch 异常）
   - 403/403-like：目标站拦截（需要尝试改 UA 或目标站 IP 问题）
   - iframe 空白但返回 200：通常是 X-Frame-Options 或 CSP 导致（本 proxy 已尝试移除这些 header，但某些站点仍然通过 meta 或脚本限制）
   - 如果是证书/TLS 问题，后端 fetch 可能失败（会在日志看到）

安全与限制
- 我在 proxy 中加入了基本的内部网段阻断（防 SSRF）。
- Vercel 的 serverless 函数有执行时长与带宽限制；大量流量会产生费用或被限制。
- 在中国大陆访问海外 Vercel 节点可能受 GFW 干扰或丢包，访问速度与稳定性无法保证。

如需更多帮助
- 如果部署后你把浏览器 Network 的 /api/proxy 请求的状态码、响应头和 Vercel 日志贴上来，我会基于具体错误给出修复建议或可替换的代码。
- 我也可以直接把这些文件以 PR 形式推到你指定的仓库（如果你授权并给我仓库路径与权限）。  
