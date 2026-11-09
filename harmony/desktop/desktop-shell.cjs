const { app, BrowserWindow, Menu, dialog, ipcMain, globalShortcut, screen } = require('electron');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

function createDesktopShell(getOrigin, getBackend) {
  if (process.env.HARMONY_USER_DATA) {
    mkdirSync(process.env.HARMONY_USER_DATA, { recursive: true });
    app.setPath('userData', process.env.HARMONY_USER_DATA);
  }
  let window, closing = false;
  function trusted(event) {
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === getOrigin();
  }
  let lyricsWindow, lyricsPayload = { title: '和音', line: '选择一首歌，开始聆听', next: '' }, lyricsLocked = false;
  function sendVisibility() { if (window && !window.isDestroyed()) window.webContents.send('lyrics:visibility', !!lyricsWindow?.isVisible()); }
  function overlayTrusted(event) { return lyricsWindow && event.sender === lyricsWindow.webContents && event.senderFrame === lyricsWindow.webContents.mainFrame; }
  function lockLyrics(locked) {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return false;
    globalShortcut.unregister('CommandOrControl+Shift+L');
    const shortcut = locked && globalShortcut.register('CommandOrControl+Shift+L', () => lockLyrics(false));
    if (locked && window && !window.isDestroyed()) window.webContents.send('lyrics:notice', shortcut ? '桌面歌词已锁定，Ctrl Shift L 解锁；也可点击「桌」关闭并解锁' : '桌面歌词已锁定，快捷键不可用，请回到和音点击「桌」关闭并解锁');
    lyricsLocked = locked; lyricsWindow.setIgnoreMouseEvents(locked, { forward: true });
    lyricsWindow.webContents.send('lyrics:locked', locked); return locked;
  }
  async function showLyrics(visible) {
    if (!visible) { lockLyrics(false); lyricsWindow?.hide(); sendVisibility(); return false; }
    if (!lyricsWindow || lyricsWindow.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      lyricsWindow = new BrowserWindow({ width: Math.min(760, area.width), height: 170, x: Math.round(area.x + (area.width - Math.min(760, area.width)) / 2), y: area.y + area.height - 210,
        minWidth: 400, minHeight: 150, maxHeight: 280, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'lyrics-preload.cjs') } });
      lyricsWindow.setMenu(null); lyricsWindow.setAlwaysOnTop(true, 'screen-saver');
      lyricsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      lyricsWindow.webContents.on('will-navigate', event => event.preventDefault());
      lyricsWindow.on('close', event => { if (!closing) { event.preventDefault(); lockLyrics(false); lyricsWindow.hide(); sendVisibility(); } });
      await lyricsWindow.loadFile(path.join(__dirname, 'lyrics.html'));
    }
    lyricsWindow.webContents.send('lyrics:data', lyricsPayload);
    lyricsWindow.showInactive(); sendVisibility(); return true;
  }
  require('./local-files.cjs')({ app, ipcMain, dialog, trusted, getWindow: () => window });
  require('./playlist-file.cjs')({ ipcMain, dialog, trusted, getWindow: () => window });
  ipcMain.handle('lyrics:visible', (event, visible) => { if (!trusted(event)) throw new Error('访问被拒绝'); return showLyrics(!!visible); });
  ipcMain.on('lyrics:update', (event, value) => {
    if (!trusted(event) || !value || typeof value !== 'object') return;
    lyricsPayload = Object.fromEntries(['title', 'line', 'next'].map(key => [key, String(value[key] || '').slice(0, 4000)]));
    lyricsPayload.playing = !!value.playing;
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.webContents.send('lyrics:data', lyricsPayload);
  });
  ipcMain.on('lyrics:control', (event, action) => {
    if (!overlayTrusted(event)) return;
    if (action === 'close') void showLyrics(false);
    else if (action === 'lock') lockLyrics(!lyricsLocked);
    else if (['previous', 'next', 'toggle-play'].includes(action) && window && !window.isDestroyed()) window.webContents.send('lyrics:control', action);
  });


  function createWindow() {
    window = new BrowserWindow({ width: 1320, height: 880, minWidth: 900, minHeight: 650, title: '和音 · One Music',
      backgroundColor: '#fcfcfa', show: false, icon: path.join(__dirname, 'icon.png'),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        preload: path.join(__dirname, 'preload.cjs'), spellcheck: false } });
    const allowed = url => { try { return new URL(url).origin === getOrigin(); } catch { return false; } };
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    window.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.on('will-download', (_event, item) => {
      item.once('done', (_event, state) => {
        if (state === 'interrupted') dialog.showErrorBox('下载未完成', '连接中断或磁盘不可写，请重新下载。');
      });
    });
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
    window.setMenu(null);
    window.on('closed', () => { lyricsWindow?.destroy(); if (!closing) app.quit(); });
    window.once('ready-to-show', () => { if (!process.env.HARMONY_TEST_HIDDEN) window.show(); });
    return window;
  }

  function start(startup) {
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
    app.whenReady().then(startup).catch(error => { dialog.showErrorBox('和音无法启动', error.message); app.quit(); });
  }
  app.on('window-all-closed', () => { if (!closing) app.quit(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', event => {
    const backend = getBackend();
    if (!backend || closing) return;
    event.preventDefault(); closing = true;
    if (window && !window.isDestroyed()) window.destroy();
    backend.close().finally(() => app.quit());
  });

  return { createWindow, start, trusted, showLyrics };
}

module.exports = { createDesktopShell };
