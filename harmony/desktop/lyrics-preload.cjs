const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lyricsOverlay', Object.freeze({
  control: action => ipcRenderer.send('lyrics:control', action),
  onData: callback => ipcRenderer.on('lyrics:data', (_event, data) => callback(data)),
  onLock: callback => ipcRenderer.on('lyrics:locked', (_event, locked) => callback(locked)),
}));
