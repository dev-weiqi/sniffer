import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { execFile, execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { WebSocketServer, WebSocket } from 'ws'
import { Server as SocketIOServer } from 'socket.io'
import { handleApi } from './api.js'
import { runAdbReverse } from './adb.js'
import { buildDoctorReport, buildDoctorPath } from './doctor.js'
import { createEntryStore } from './entryStore.js'
import { json } from './http.js'
import {
  EMPTY_MOCKS,
  loadMockStore,
  mergeMocks,
  migrateStarredToSharedStore,
  stripUiOnlyFields,
  type Mocks,
  type MockStore,
} from './mockStore.js'
import { serveStatic } from './static.js'
import { handleTest } from './testHandlers.js'

// GUI launches (Finder/launchd) get a bare PATH without adb; widen it the same
// way doctor resolves commands so `adb reverse` works from the desktop app too.
process.env.PATH = buildDoctorPath()

// Dev build vs the published npm package: the package is always installed under node_modules
// (bin/sniffer.js → dist/server.js); running from the repo source never is. The UI badges it "Dev".
const IS_DEV = process.env.SNIFFER_DESKTOP !== '1' && !import.meta.url.includes('/node_modules/')
const PORT = Number(process.env.PORT ?? 9091)
// Which interface the daemon listens on. Loopback-only by default (no network exposure):
// Android/adb reverse and the iOS simulator reach it via localhost; a real iOS device on
// wifi (hitting the host's LAN IP) needs SNIFFER_BIND=0.0.0.0.
const BIND_HOST = process.env.SNIFFER_BIND ?? '127.0.0.1'
// UI location differs by layout: `ui-dist/` sits next to `dist/` in the published npm package;
// `../ui/dist` is the repo checkout (running from src/ via tsx).
// repo layout first: a stale ui-dist/ left behind by npm pack must never shadow ui/dist
const UI_DIST = [
  fileURLToPath(new URL('../../ui/dist', import.meta.url)),
  fileURLToPath(new URL('../ui-dist', import.meta.url)),
].find(existsSync) ?? fileURLToPath(new URL('../../ui/dist', import.meta.url))
const SNIFFER_ICON = [
  fileURLToPath(new URL('../../ui/public/sniffer.svg', import.meta.url)),
  join(UI_DIST, 'sniffer.svg'),
].find(existsSync)

// ---------- state (in-memory, cleared on restart) ----------

interface DeviceInfo {
  deviceId: string
  deviceName: string
  platform: string
  appId: string
  sdkVersion: string
  capabilities: string[]
}

const devices = new Map<string, { info: DeviceInfo; ws: WebSocket; connected: boolean }>()

// mock rules survive daemon restarts and are scoped by deviceId; traffic stays in-memory by design
const MOCKS_FILE = join(homedir(), '.sniffer', 'mocks.json')
function persistMocks() {
  try {
    mkdirSync(join(homedir(), '.sniffer'), { recursive: true })
    writeFileSync(MOCKS_FILE, JSON.stringify(mockStore, null, 2))
  } catch (e) {
    console.error('failed to persist mocks:', e)
  }
}
let mockStore: MockStore = loadMockStore(MOCKS_FILE)
const uiClients = new Set<WebSocket>()

function broadcastToUi(msg: unknown) {
  const text = JSON.stringify(msg)
  for (const ws of uiClients) if (ws.readyState === WebSocket.OPEN) ws.send(text)
}

const entryStore = createEntryStore(broadcastToUi)

/** starred rules stuck in a device bucket (saved while the device/appId was unknown)
    move to the app's shared bucket once the device introduces itself */
function migrateStarredToShared(deviceId: string, appId: string): boolean {
  const result = migrateStarredToSharedStore(mockStore, deviceId, appId)
  if (!result.changed) return false
  mockStore = result.store
  persistMocks()
  return true
}

/** merged view: shared (starred) rules of the device's app pinned first, then its own rules */
function mocksFor(deviceId: string): Mocks {
  const own = mockStore.devices[deviceId] ?? EMPTY_MOCKS
  const appId = devices.get(deviceId)?.info.appId
  const shared = (appId && mockStore.shared[appId]) || EMPTY_MOCKS
  return mergeMocks(own, shared)
}

function mergedMocksByDevice(): Record<string, Mocks> {
  const out: Record<string, Mocks> = {}
  for (const id of new Set([...Object.keys(mockStore.devices), ...devices.keys()])) out[id] = mocksFor(id)
  return out
}

function sendMocksToDevice(deviceId: string) {
  const device = devices.get(deviceId)
  if (!device?.connected) return
  // `starred` is a UI/daemon concern — the SDK wire format stays unchanged
  const merged = stripUiOnlyFields(mocksFor(deviceId))
  device.ws.send(JSON.stringify({ type: 'mock-rules', http: merged.http, socket: merged.socket }))
}

// ---------- breakpoints (in-memory: ephemeral debug state, unlike persisted mocks) ----------
const breakpointsByDevice: Record<string, unknown[]> = {}
// paused responses awaiting a resolve, so the UI (incl. after a reload) can see and act on them
const pendingHits = new Map<string, { deviceId: string; hit: Record<string, unknown> }>()

function sendBreakpointsToDevice(deviceId: string) {
  const device = devices.get(deviceId)
  if (!device?.connected) return
  device.ws.send(JSON.stringify({ type: 'breakpoint-rules', rules: breakpointsByDevice[deviceId] ?? [] }))
}

/** Drops our view of a device's paused hits (the SDK auto-resumes them on disconnect). */
function clearDeviceHits(deviceId: string): boolean {
  let changed = false
  for (const [id, p] of pendingHits) if (p.deviceId === deviceId) { pendingHits.delete(id); changed = true }
  return changed
}

/** Resumes every paused response unchanged (used when traffic is cleared — a clean slate must
    not leave the app blocked, and should not fail its in-flight requests). */
function releasePendingHits() {
  for (const [id, p] of pendingHits) {
    devices.get(p.deviceId)?.ws.send(JSON.stringify({ type: 'breakpoint-resolve', id, action: 'resume' }))
    broadcastToUi({ type: 'breakpoint-resolved', deviceId: p.deviceId, id })
  }
  pendingHits.clear()
}

function removeDeviceRecord(deviceId: string): { removed: boolean; mocksChanged: boolean } {
  delete breakpointsByDevice[deviceId]
  clearDeviceHits(deviceId)
  const hadDevice = devices.delete(deviceId)
  const hadEntries = entryStore.removeDeviceEntries(deviceId)

  let mocksChanged = false
  if (mockStore.devices[deviceId]) {
    const { [deviceId]: _, ...rest } = mockStore.devices
    // shared rules belong to the app, not the device — they survive device deletion
    mockStore = { ...mockStore, devices: rest }
    mocksChanged = true
  }

  const removed = hadDevice || hadEntries || mocksChanged
  if (removed) broadcastToUi({ type: 'device-deleted', deviceId })
  return { removed, mocksChanged }
}

// ---------- HTTP server: /api, /test, UI static files ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/api/doctor') {
      return json(res, 200, await buildDoctorReport({ port: PORT, bindHost: BIND_HOST }))
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, {
      devices,
      getMockStore: () => mockStore,
      setMockStore: store => { mockStore = store },
      persistMocks,
      entryStore,
      broadcastToUi,
      sendMocksToDevice,
      mocksFor,
      mergedMocksByDevice,
      removeDeviceRecord,
      setBreakpoints: (deviceId, rules) => { breakpointsByDevice[deviceId] = rules },
      sendBreakpointsToDevice,
      resolvePendingHit: (id) => { pendingHits.delete(id) },
      releasePendingHits,
    })
    if (url.pathname.startsWith('/test/')) return await handleTest(req, res, url, { snifferIcon: SNIFFER_ICON })
    if (req.method === 'GET') return await serveStatic(res, url.pathname, { uiDist: UI_DIST })
    res.writeHead(405); res.end()
  } catch (e) {
    json(res, 500, { error: String(e) })
  }
})

// ---------- WebSocket: /device and /ui ----------

const deviceWss = new WebSocketServer({ noServer: true })
const uiWss = new WebSocketServer({ noServer: true })
const testWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const route = pathname === '/device' ? deviceWss
    : pathname === '/ui' ? uiWss
    : pathname === '/test/ws' ? testWss
    : null
  if (route) route.handleUpgrade(req, socket, head, ws => route.emit('connection', ws, req))
  // other paths (e.g. /socket.io) are handled by socket.io’s own upgrade listener
})

deviceWss.on('connection', ws => {
  let deviceId: string | null = null
  ws.on('message', data => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.type === 'hello') {
      deviceId = String(msg.deviceId)
      const old = devices.get(deviceId)
      if (old?.connected && old.ws !== ws) old.ws.close()
      const { type, ...info } = msg
      devices.set(deviceId, { info: info as unknown as DeviceInfo, ws, connected: true })
      console.log(`🟢 [device] ${info.deviceName} (${info.appId}) connected`)
      const migrated = migrateStarredToShared(deviceId, String(info.appId))
      sendBreakpointsToDevice(deviceId)
      broadcastToUi({ type: 'device-status', deviceId, connected: true, info })
      // a fresh device may inherit shared (starred) rules — let the UI see its merged view;
      // after a migration every device of the app needs the update, not just this one
      for (const d of devices.values()) {
        if (d.info.deviceId !== deviceId && (!migrated || d.info.appId !== info.appId)) continue
        sendMocksToDevice(d.info.deviceId)
        broadcastToUi({ type: 'mocks-changed', deviceId: d.info.deviceId, mocks: mocksFor(d.info.deviceId) })
      }
      return
    }
    // a paused response is not recorded traffic: relay it to the UI and track it for resolve
    if (msg.type === 'breakpoint-hit' && deviceId) {
      pendingHits.set(String(msg.id), { deviceId, hit: msg })
      broadcastToUi({ type: 'breakpoint-hit', deviceId, hit: msg })
      return
    }
    if (deviceId) entryStore.pushEntry(deviceId, msg)
  })
  ws.on('close', () => {
    if (!deviceId) return
    const d = devices.get(deviceId)
    if (d?.ws === ws) {
      d.connected = false
      console.log(`🔴 [device] ${d.info.deviceName} disconnected`)
      // the SDK releases its own paused calls on disconnect; clear the UI's view of them
      if (clearDeviceHits(deviceId)) broadcastToUi({ type: 'breakpoints-released', deviceId })
      broadcastToUi({ type: 'device-status', deviceId, connected: false })
    }
  })
})

uiWss.on('connection', ws => {
  uiClients.add(ws)
  ws.send(JSON.stringify({
    type: 'init',
    devices: [...devices.values()].map(d => ({ ...d.info, connected: d.connected })),
    entries: entryStore.snapshot(), mocksByDevice: mergedMocksByDevice(),
    breakpointsByDevice, pausedHits: [...pendingHits.values()],
  }))
  // sent after init (init resets state): tells the UI whether this is a dev or published build
  ws.send(JSON.stringify({ type: 'server-info', dev: IS_DEV }))
  ws.on('close', () => uiClients.delete(ws))
})

testWss.on('connection', ws => {
  ws.on('message', data => ws.send(JSON.stringify({ echo: data.toString(), ts: Date.now() })))
})

// ---------- test socket.io server (for the sample app) ----------

const io = new SocketIOServer(server, {
  // required: by default socket.io destroys non-socket.io upgrade requests, killing /device connections
  destroyUpgrade: false,
  cors: { origin: '*' },
})

io.on('connection', socket => {
  socket.on('chat:send', (msg, ack) => {
    ack?.({ ok: true, echo: msg, ts: Date.now() })
    socket.broadcast.emit('chat:new', { from: socket.id, msg })
  })
  socket.on('echo', (data, ack) => ack?.(data))
  // request/response without an ack: the answer comes back as its own event
  socket.on('user:get', id => socket.emit('user:result', { id, name: `user-${id}`, ts: Date.now() }))
})

// ---------- adb reverse: route device/emulator localhost:9091 to this machine ----------

function adbReverse() {
  runAdbReverse({ port: PORT, execFile })
}
setInterval(adbReverse, 5000)
adbReverse()

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`)
    if (!process.stdin.isTTY) {
      console.error(`Free it (lsof -ti tcp:${PORT} | xargs kill) or pick another port:`)
      console.error(`  PORT=9092 npm start   — and in the app: Sniffer.start(appId, port = 9092)`)
      process.exit(1)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`Kill the process using port ${PORT} and start here instead? [y/N] `, answer => {
      rl.close()
      if (answer.trim().toLowerCase() !== 'y') {
        console.error(`Pick another port: PORT=9092 npm start — and in the app: Sniffer.start(appId, port = 9092)`)
        process.exit(1)
      }
      try { execSync(`lsof -ti tcp:${PORT} | xargs kill`, { stdio: 'ignore' }) } catch { /* already gone */ }
      // SIGTERM needs a moment to release the port; if it's still held, this handler asks again
      setTimeout(() => server.listen(PORT, BIND_HOST), 700)
    })
  } else {
    throw e
  }
})

function openBrowser(url: string) {
  // best-effort; a headless machine just skips it
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {})
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {})
}

server.listen(PORT, BIND_HOST, () => {
  console.log(`Sniffer daemon: http://localhost:${PORT}`)
  // SNIFFER_NO_OPEN=1 opts out (set by `npm run dev` so watch restarts don't spam tabs)
  if (process.stdin.isTTY && process.env.SNIFFER_NO_OPEN !== '1') openBrowser(`http://localhost:${PORT}`)
})
