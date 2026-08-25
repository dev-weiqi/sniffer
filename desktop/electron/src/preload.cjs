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
  find: (text, opts) => ipcRenderer.send('sniffer:find', text, opts),
  stopFind: () => ipcRenderer.send('sniffer:find-stop'),
  onFindResult: callback => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('sniffer:find-result', listener)
    return () => ipcRenderer.removeListener('sniffer:find-result', listener)
  },
})
