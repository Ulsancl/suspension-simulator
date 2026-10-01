const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('suspensionDesktop', {
  isDesktop: true,
  platform: process.platform,
  openProject: () => ipcRenderer.invoke('suspension:open-project'),
  saveProject: payload => ipcRenderer.invoke('suspension:save-project', payload),
  setBusy: busy => ipcRenderer.send('suspension:busy', busy === true),
  onCommand: callback => subscribe('suspension:command', callback),
  onSaveResult: callback => subscribe('suspension:save-result', callback),
});
