const { app, dialog, ipcMain, session } = require('electron');
const { Readable } = require('node:stream');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { createDesktopShell } = require('./desktop-shell.cjs');
const { setLocalSession } = require('./local-session.cjs');

let backend, window, activeOrigin = '';
const { createWindow, start, trusted, showLyrics } = createDesktopShell(() => activeOrigin, () => backend);
let localOrigin = '', configuredOrigin = '', accountProxy = false, continuedLocalTrack = '';
const localGuestKey = randomBytes(32).toString('hex');
const modePath = () => path.join(app.getPath('userData'), 'usage-mode.json');
function readMode() { try { return JSON.parse(readFileSync(modePath(), 'utf8')).mode; } catch { return ''; } }
function saveMode(mode) { writeFileSync(modePath(), JSON.stringify({ mode })); }
const accountSession = () => session.fromPartition('persist:harmony-account');
async function ensureLocalBackend() {
  if (localOrigin) return localOrigin;
  const { createApp } = await import('harmony-backend');
  backend = createApp({ webDir: path.join(__dirname, '../web'), dataDir: path.join(app.getPath('userData'), 'backend'), production: false, secure: false, localGuestKey });
  const handle = backend.server.listeners('request')[0];
  backend.server.removeAllListeners('request');
  backend.server.on('request', async (req, res) => {
    const url = new URL(req.url, localOrigin || 'http://127.0.0.1');
    const continuing = continuedLocalTrack && [`/api/tracks/${continuedLocalTrack}/audio`, `/api/tracks/${continuedLocalTrack}/lyrics`].includes(url.pathname) && !url.searchParams.has('download');
    if (!accountProxy || !configuredOrigin || !url.pathname.startsWith('/api/') || continuing) return handle(req, res);
    if (req.headers.host !== new URL(localOrigin).host || (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== localOrigin)) { res.writeHead(403); return res.end(); }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 65536) { res.writeHead(413); return res.end(); } chunks.push(chunk); }
      const headers = { Origin: configuredOrigin };
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      if (req.headers.range) headers.Range = req.headers.range;
      const response = await accountSession().fetch(configuredOrigin + url.pathname + url.search, {
        method: req.method, headers, credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(120000),
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = new URL(response.headers.get('location') || '', configuredOrigin);
        if (!/^\/api\/platform-playlists\/[a-zA-Z0-9-]+\/cover$/.test(url.pathname) || location.protocol !== 'https:' || !['y.gtimg.cn', 'music.126.net'].some(host => location.hostname === host || location.hostname.endsWith('.' + host))) throw new Error('重定向无效');
        res.writeHead(302, { Location: location.href, 'Cache-Control': 'no-store' }); return res.end();
      }
      if (url.pathname === '/api/auth/logout' && response.ok) continuedLocalTrack = '';
      const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      for (const key of ['content-type', 'content-range', 'accept-ranges', 'content-disposition']) if (response.headers.has(key)) responseHeaders[key] = response.headers.get(key);
      // Cover redirects are handled by the remote backend; API/audio stay on the local origin.
      res.writeHead(response.status, responseHeaders);
      if (!response.body || req.method === 'HEAD') return res.end();
      const stream = Readable.fromWeb(response.body); res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch { if (res.headersSent) return res.destroy(); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '账号服务暂时无法连接，请稍后重试' })); }
  });
  localOrigin = await backend.listen(0); return localOrigin;
}
async function enterLocalProfile() {
  accountProxy = false; continuedLocalTrack = '';
  const target = await ensureLocalBackend();
  await setLocalSession(window.webContents.session, target, localGuestKey);
  saveMode('local');
  activeOrigin = target; return { redirect: target };
}
ipcMain.handle('mode:local', async event => {
  if (!trusted(event)) throw new Error('访问被拒绝');
  await showLyrics(false); return enterLocalProfile();
});
ipcMain.handle('mode:account', async event => {
  if (!trusted(event)) throw new Error('访问被拒绝');
  await showLyrics(false);
  if (activeOrigin === localOrigin) await window.webContents.session.cookies.remove(localOrigin, 'harmony_session');
  saveMode('account'); activeOrigin = configuredOrigin || await ensureLocalBackend(); return { redirect: activeOrigin };
});
ipcMain.handle('account:login', async (event, input) => {
  if (!trusted(event)) throw new Error('访问被拒绝');
  if (!configuredOrigin || activeOrigin !== localOrigin) return null;
  if (typeof input?.username !== 'string' || input.username.length > 32 || typeof input.password !== 'string' || input.password.length > 128) throw new Error('账号格式无效');
  const response = await accountSession().fetch(configuredOrigin + '/api/auth/login', { method: 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Origin: configuredOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: input.username, password: input.password, remember: true }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '登录失败，请重试');
  await accountSession().cookies.flushStore();
  continuedLocalTrack = /^[a-zA-Z0-9-]{1,100}$/.test(input.continueTrackId || '') ? input.continueTrackId : '';
  accountProxy = true; saveMode('account-proxy'); return result;
});
ipcMain.handle('account:signed-in', event => { if (!trusted(event)) throw new Error('访问被拒绝'); if (!accountProxy) saveMode('account'); });
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { return { serverUrl: '' }; }
}
function validUrl(value) {
  if (value === '') return '';
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请输入服务器网址，不要附加路径、密码或查询参数');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    throw new Error('远程服务器需要 HTTPS；本地地址可以使用 HTTP');
  return url.origin;
}
start(async () => {
  configuredOrigin = validUrl(process.env.HARMONY_SERVER_URL || readConfig().serverUrl || '');
  const mode = readMode();
  const restoreLocal = mode === 'local';
  const restoreProxy = configuredOrigin && mode === 'account-proxy';
  activeOrigin = restoreLocal || restoreProxy ? await ensureLocalBackend() : configuredOrigin || await ensureLocalBackend();
  accountProxy = !!restoreProxy;
  window = createWindow();
  try {
    if (restoreLocal) await enterLocalProfile();
    await window.loadURL(activeOrigin);
  } catch {
    if (!process.env.HARMONY_TEST_HIDDEN) window.show();
    const result = await dialog.showMessageBox(window, { type: 'error', message: '暂时无法连接账号服务', detail: '可以先使用本地模式，绑定的平台与收藏只保存在此电脑。', buttons: ['本地使用', '退出'], defaultId: 0, cancelId: 1 });
    if (result.response === 0) { await enterLocalProfile(); await window.loadURL(activeOrigin); } else app.quit();
  }
});
