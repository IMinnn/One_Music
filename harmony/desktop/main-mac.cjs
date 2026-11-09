const { app, ipcMain } = require('electron');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { createDesktopShell } = require('./desktop-shell.cjs');
const { setLocalSession } = require('./local-session.cjs');

const localGuestKey = randomBytes(32).toString('hex');
let backend, window, origin = '';
const { createWindow, start, trusted, showLyrics } = createDesktopShell(() => origin, () => backend);

async function openLocalProfile() {
  await setLocalSession(window.webContents.session, origin, localGuestKey);
  return { redirect: origin };
}

ipcMain.handle('mode:local', async event => {
  if (!trusted(event)) throw new Error('访问被拒绝');
  await showLyrics(false);
  return openLocalProfile();
});

start(async () => {
  const { createApp } = await import('harmony-backend/local');
  backend = createApp({
    webDir: path.join(__dirname, '../web'),
    dataDir: path.join(app.getPath('userData'), 'backend'),
    localGuestKey,
  });
  origin = await backend.listen(0);
  window = createWindow();
  await openLocalProfile();
  await window.loadURL(origin);
});
