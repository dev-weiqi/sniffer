const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('snifferDesktop', {
  getConfig: () => ipcRenderer.invoke('sniffer:get-config'),
  setPort: port => ipcRenderer.invoke('sniffer:set-port', port),
})
