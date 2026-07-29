import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  bundledDaemonCwd,
  desktopUrl,
  normalizePort,
  repoRootFrom,
  startDaemon,
  stopDaemon,
  waitForDaemon,
  waitForExit,
} from './launcher.mjs'
import {
  fetchLatestVersion,
  installUpdate,
  readVersion,
  resolveDaemonDir,
  updateAvailable,
} from './updater.mjs'

let port = DEFAULT_PORT
let url = desktopUrl(port)
let daemon = null
let mainWindow = null
let config = {}
// null in dev (repo daemon via npm start); resolved bundled-vs-installed dir when packaged
let activeDaemonDir = null
let updating = false

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

function currentDaemonVersion() {
  return activeDaemonDir ? readVersion(activeDaemonDir) : null
}

function pushUpdateState(state) {
  mainWindow?.webContents.send('sniffer:update-state', state)
}

function installIpc() {
  ipcMain.handle('sniffer:get-config', async () => ({ port }))
  ipcMain.handle('sniffer:set-port', async (_event, value) => {
    const nextPort = normalizePort(value, port)
    await writeConfig({ ...(await readConfig()), port: nextPort })
    return { port: nextPort, restartRequired: nextPort !== port }
  })
  ipcMain.handle('sniffer:check-update', async () => {
    // dev runs the repo daemon; there is nothing meaningful to update against
    if (!app.isPackaged) return { supported: false }
    const current = currentDaemonVersion()
    try {
      const latest = await fetchLatestVersion()
      return { supported: true, current, latest, available: updateAvailable(current, latest) }
    } catch (error) {
      // offline is a normal state for a dev tool — report "no update", not an error
      return { supported: true, current, latest: null, available: false, error: String(error) }
    }
  })
  ipcMain.handle('sniffer:apply-update', async (_event, version) => {
    if (!app.isPackaged) return { ok: false, error: 'updates only apply to the packaged app' }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      return { ok: false, error: `not a release version: ${String(version)}` }
    }
    if (updating) return { ok: false, error: 'update already in progress' }
    updating = true
    const previousDir = activeDaemonDir
    try {
      pushUpdateState({ phase: 'downloading', version })
      const dir = await installUpdate({ userDataDir: app.getPath('userData'), version })

      pushUpdateState({ phase: 'relaunching', version })
      stopDaemon(daemon)
      await waitForExit(daemon)
      activeDaemonDir = dir
      await startCurrentDaemon(repoRootFrom(import.meta.url), { interactive: false })
      mainWindow?.loadURL(url)
      return { ok: true, version }
    } catch (error) {
      // never leave the app daemon-less: fall back to the version that was running
      try {
        stopDaemon(daemon)
        await waitForExit(daemon)
        activeDaemonDir = previousDir
        await startCurrentDaemon(repoRootFrom(import.meta.url), { interactive: false })
        mainWindow?.loadURL(url)
      } catch {
        // fallback restart failed too; surface the original error, the window shows the dialog path
      }
      pushUpdateState({ phase: 'failed', version, error: String(error) })
      return { ok: false, error: String(error) }
    } finally {
      updating = false
    }
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
  if (app.isPackaged) {
    activeDaemonDir = resolveDaemonDir({
      bundledDir: bundledDaemonCwd(process.resourcesPath),
      userDataDir: app.getPath('userData'),
    }).dir
  }
  const repoRoot = repoRootFrom(import.meta.url)
  await startCurrentDaemon(repoRoot)
}

async function startCurrentDaemon(repoRoot, { interactive = true } = {}) {
  daemon = startDaemon({
    repoRoot,
    port,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    electronExecPath: process.execPath,
    daemonDir: activeDaemonDir,
  })
  try {
    await waitForDaemon({ url })
  } catch (error) {
    stopDaemon(daemon)
    daemon = null
    // programmatic restarts (in-app update, its fallback) surface errors to their caller
    if (!interactive) throw error
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
  // update restarts reuse the existing window — only the first boot creates one
  if (!mainWindow) {
    mainWindow = createWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  }
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
