const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('snifferDesktop', {
  getConfig: () => ipcRenderer.invoke('sniffer:get-config'),
  setPort: port => ipcRenderer.invoke('sniffer:set-port', port),
  checkUpdate: () => ipcRenderer.invoke('sniffer:check-update'),
  applyUpdate: version => ipcRenderer.invoke('sniffer:apply-update', version),
  onUpdateState: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('sniffer:update-state', listener)
    return () => ipcRenderer.removeListener('sniffer:update-state', listener)
  },
})
