import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  desktopUrl,
  normalizePort,
  repoRootFrom,
  startDaemon,
  stopDaemon,
  waitForDaemon,
} from './launcher.mjs'

let port = DEFAULT_PORT
let url = desktopUrl(port)
let daemon = null
let mainWindow = null
let config = {}

function configPath() {
  return join(app.getPath('userData'), 'sniffer-config.json')
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function writeConfig(config) {
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`)
}

function installIpc() {
  ipcMain.handle('sniffer:get-config', async () => ({ port }))
  ipcMain.handle('sniffer:set-port', async (_event, value) => {
    const nextPort = normalizePort(value, port)
    await writeConfig({ ...(await readConfig()), port: nextPort })
    return { port: nextPort, restartRequired: nextPort !== port }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Sniffer',
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadURL(url)
  return win
}

async function boot() {
  installIpc()
  config = await readConfig()
  port = normalizePort(process.env.PORT ?? config.port)
  url = desktopUrl(port)
  const repoRoot = repoRootFrom(import.meta.url)
  await startCurrentDaemon(repoRoot)
}

async function startCurrentDaemon(repoRoot) {
  daemon = startDaemon({
    repoRoot,
    port,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    electronExecPath: process.execPath,
  })
  try {
    await waitForDaemon({ url })
  } catch (error) {
    stopDaemon(daemon)
    daemon = null
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'Sniffer failed to start',
      message: 'Sniffer daemon did not start.',
      detail: `${String(error)}\n\nTry another port if ${port} is already in use.`,
      buttons: [`Use port ${normalizePort(port + 1, DEFAULT_PORT)}`, 'Quit'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) {
      port = normalizePort(port + 1, DEFAULT_PORT)
      config = { ...config, port }
      await writeConfig(config)
      url = desktopUrl(port)
      await startCurrentDaemon(repoRoot)
      return
    }
    app.quit()
    return
  }
  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(boot)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && daemon) {
    mainWindow = createWindow()
  }
})

app.on('before-quit', () => {
  stopDaemon(daemon)
  daemon = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
