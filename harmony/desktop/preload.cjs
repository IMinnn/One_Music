const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('harmonyDesktop', Object.freeze({
  savePlaylistFile: input => ipcRenderer.invoke('playlists:save-file', input),
  listLocalFiles: () => ipcRenderer.invoke('local-files:list'),
  pickLocalFiles: kind => ipcRenderer.invoke('local-files:pick', kind),
  readLocalFile: id => ipcRenderer.invoke('local-files:read', id),
  startLocalMode: () => ipcRenderer.invoke('mode:local'),
  ...(process.platform === 'darwin' ? {} : {
    openAccountMode: () => ipcRenderer.invoke('mode:account'),
    loginAccount: input => ipcRenderer.invoke('account:login', input),
    accountSignedIn: () => ipcRenderer.invoke('account:signed-in'),
  }),
  setLyricsVisible: visible => ipcRenderer.invoke('lyrics:visible', visible),
  updateLyrics: value => ipcRenderer.send('lyrics:update', value),
  onLyricsVisibility: callback => ipcRenderer.on('lyrics:visibility', (_event, visible) => callback(visible)),
  onLyricsControl: callback => ipcRenderer.on('lyrics:control', (_event, action) => callback(action)),
  onLyricsNotice: callback => ipcRenderer.on('lyrics:notice', (_event, message) => callback(message)),
}));
