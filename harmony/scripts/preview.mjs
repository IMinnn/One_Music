// Local review server: the real app UI/API with a development-only browser bridge.
// This entry point is never launched or included as a running service by the desktop app.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from 'harmony-backend';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PREVIEW_PORT || 47831);
const origin = `http://127.0.0.1:${port}`;
const dataDir = join(project, '.preview-data');
const localGuestKey = randomBytes(32).toString('hex');
const app = createApp({ webDir: join(project, 'web'), dataDir, origin, localGuestKey, production: false, secure: false });
const originalHandler = app.server.listeners('request')[0];
const bridge = `
const enter = async () => {
  const response = await fetch('/preview/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('预览资料库暂时无法打开');
};
window.harmonyPreview = Object.freeze({
  ready: new URLSearchParams(location.search).has('account') ? Promise.resolve() : enter(),
  startLocalMode: async () => { await enter(); return { redirect: '/' }; },
  openAccountMode: async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { redirect: '/?account=1' }; },
});`;

app.server.removeAllListeners('request');
app.server.on('request', (req, res) => {
  if (req.headers.host !== new URL(origin).host) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, origin);
  if (url.pathname === '/preview/guest') {
    if (req.method !== 'POST' || req.headers.origin !== origin) { res.writeHead(403); return res.end(); }
    req.url = '/api/auth/guest'; req.headers['x-harmony-local-key'] = localGuestKey;
    return originalHandler(req, res);
  }
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
  if (url.pathname === '/preview-bridge.js' && req.method === 'GET') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(bridge);
  }
  if (url.pathname === '/' && req.method === 'GET') {
    const html = readFileSync(join(project, 'web/index.html'), 'utf8').replace('<script type="module"', '<script src="/preview-bridge.js"></script><script type="module"');
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://y.gtimg.cn https://*.music.126.net; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    return res.end(html);
  }
  originalHandler(req, res);
});

await app.listen(port);
console.log(`和音网页预览：${origin}`);
console.log('共用客户端 web/ 源码；预览资料独立保存在 .preview-data/。修改后刷新网页即可查看，不会生成 EXE。');
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await app.close(); process.exit(0); });
