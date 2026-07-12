import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { deflateSync, crc32 } from 'node:zlib'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { Server as SocketIOServer } from 'socket.io'

const PORT = Number(process.env.PORT ?? 9091)
const MAX_STORED_MESSAGES = 2000
// UI location differs by layout: `ui-dist/` sits next to `dist/` in the published npm package;
// `../ui/dist` is the repo checkout (running from src/ via tsx).
const UI_DIST = [
  fileURLToPath(new URL('../ui-dist', import.meta.url)),
  fileURLToPath(new URL('../../ui/dist', import.meta.url)),
].find(existsSync) ?? fileURLToPath(new URL('../../ui/dist', import.meta.url))

// ---------- state (in-memory, cleared on restart) ----------

interface DeviceInfo {
  deviceId: string
  deviceName: string
  platform: string
  appId: string
  sdkVersion: string
  capabilities: string[]
}

interface Mocks {
  http: unknown[]
  socket: unknown[]
}

interface MockStore {
  devices: Record<string, Mocks>
}

const devices = new Map<string, { info: DeviceInfo; ws: WebSocket; connected: boolean }>()
const entries: { deviceId: string; message: Record<string, unknown> }[] = []

// mock rules survive daemon restarts and are scoped by deviceId; traffic stays in-memory by design
const MOCKS_FILE = join(homedir(), '.sniffer', 'mocks.json')
const EMPTY_MOCKS: Mocks = { http: [], socket: [] }

function normalizeMocks(value: unknown): Mocks {
  const m = value as Partial<Mocks> | null | undefined
  return {
    http: Array.isArray(m?.http) ? m.http : [],
    socket: Array.isArray(m?.socket) ? m.socket : [],
  }
}

function loadMockStore(): MockStore {
  try {
    const m = JSON.parse(readFileSync(MOCKS_FILE, 'utf8'))
    if (m.devices && typeof m.devices === 'object') {
      const scoped: Record<string, Mocks> = {}
      for (const [deviceId, mocks] of Object.entries(m.devices)) {
        scoped[deviceId] = normalizeMocks(mocks)
      }
      return { devices: scoped }
    }
    const legacy = normalizeMocks(m)
    return legacy.http.length || legacy.socket.length
      ? { devices: { 'legacy-global': legacy } }
      : { devices: {} }
  } catch {
    return { devices: {} }
  }
}
function persistMocks() {
  try {
    mkdirSync(join(homedir(), '.sniffer'), { recursive: true })
    writeFileSync(MOCKS_FILE, JSON.stringify(mockStore, null, 2))
  } catch (e) {
    console.error('failed to persist mocks:', e)
  }
}
let mockStore: MockStore = loadMockStore()
const uiClients = new Set<WebSocket>()

function broadcastToUi(msg: unknown) {
  const text = JSON.stringify(msg)
  for (const ws of uiClients) if (ws.readyState === WebSocket.OPEN) ws.send(text)
}

function pushEntry(deviceId: string, message: Record<string, unknown>) {
  entries.push({ deviceId, message })
  if (entries.length > MAX_STORED_MESSAGES) entries.splice(0, entries.length - MAX_STORED_MESSAGES)
  broadcastToUi({ type: 'event', deviceId, message })
}

function clearEntriesByMessageType(types: Set<unknown>) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (types.has(entries[i].message.type)) entries.splice(i, 1)
  }
}

function mocksFor(deviceId: string): Mocks {
  return mockStore.devices[deviceId] ?? EMPTY_MOCKS
}

function sendMocksToDevice(deviceId: string) {
  const device = devices.get(deviceId)
  if (!device?.connected) return
  device.ws.send(JSON.stringify({ type: 'mock-rules', ...mocksFor(deviceId) }))
}

function removeDeviceRecord(deviceId: string): { removed: boolean; mocksChanged: boolean } {
  const hadDevice = devices.delete(deviceId)
  let hadEntries = false
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].deviceId === deviceId) {
      entries.splice(i, 1)
      hadEntries = true
    }
  }

  let mocksChanged = false
  if (mockStore.devices[deviceId]) {
    const { [deviceId]: _, ...rest } = mockStore.devices
    mockStore = { devices: rest }
    mocksChanged = true
  }

  const removed = hadDevice || hadEntries || mocksChanged
  if (removed) broadcastToUi({ type: 'device-deleted', deviceId })
  return { removed, mocksChanged }
}

// ---------- HTTP server: /api, /test, UI static files ----------

async function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
}

async function serveStatic(res: ServerResponse, pathname: string) {
  if (!existsSync(UI_DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Sniffer daemon is running, but the UI is not built yet: cd ui && npm install && npm run build')
    return
  }
  let file = normalize(join(UI_DIST, pathname === '/' ? 'index.html' : pathname))
  if (!file.startsWith(UI_DIST)) { res.writeHead(403); res.end(); return }
  if (!existsSync(file)) file = join(UI_DIST, 'index.html') // SPA fallback
  const data = await readFile(file)
  // hashed assets are immutable; index.html must always revalidate so a new build is picked up
  const cacheControl = file.includes(`${'/'}assets${'/'}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': cacheControl,
  })
  res.end(data)
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'PUT' && url.pathname === '/api/mocks') {
    const body = JSON.parse(await readBody(req))
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
    if (!deviceId) return json(res, 400, { error: 'deviceId required' })
    const mocks = normalizeMocks(body)
    mockStore = { devices: { ...mockStore.devices, [deviceId]: mocks } }
    persistMocks()
    sendMocksToDevice(deviceId)
    broadcastToUi({ type: 'mocks-changed', deviceId, mocks })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/push-event') {
    const body = JSON.parse(await readBody(req))
    const device = devices.get(body.deviceId)
    if (!device?.connected) return json(res, 404, { error: 'device not connected' })
    device.ws.send(JSON.stringify({
      type: 'push-event', connectionId: body.connectionId ?? null,
      event: body.event, payload: body.payload,
    }))
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries') {
    entries.length = 0
    broadcastToUi({ type: 'entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/http') {
    clearEntriesByMessageType(new Set(['http-request', 'http-response']))
    broadcastToUi({ type: 'http-entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/socket') {
    clearEntriesByMessageType(new Set(['socket-event', 'socket-ack']))
    broadcastToUi({ type: 'socket-entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/devices/offline') {
    const offlineDeviceIds = [...devices.values()]
      .filter(d => !d.connected)
      .map(d => d.info.deviceId)
    let mocksChanged = false
    const deleted: string[] = []
    for (const deviceId of offlineDeviceIds) {
      const result = removeDeviceRecord(deviceId)
      if (result.removed) deleted.push(deviceId)
      mocksChanged = mocksChanged || result.mocksChanged
    }
    if (mocksChanged) persistMocks()
    return json(res, 200, { ok: true, deleted })
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
    const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length))
    if (!deviceId) return json(res, 400, { error: 'deviceId required' })
    const device = devices.get(deviceId)
    if (device?.connected) return json(res, 409, { error: 'device is connected' })
    const result = removeDeviceRecord(deviceId)
    if (result.mocksChanged) persistMocks()
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, {
      devices: [...devices.values()].map(d => ({ ...d.info, connected: d.connected })),
      entryCount: entries.length, mocksByDevice: mockStore.devices,
    })
  }
  json(res, 404, { error: 'not found' })
}

// test endpoints for the sample app
async function handleTest(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === '/test/echo') {
    const body = await readBody(req)
    return json(res, 200, {
      method: req.method, path: url.pathname + url.search,
      headers: req.headers, body: body || null, ts: Date.now(),
    })
  }
  const userMatch = url.pathname.match(/^\/test\/users\/(\w+)$/)
  if (userMatch) {
    return json(res, 200, {
      id: Number(userMatch[1]), name: `User ${userMatch[1]}`,
      email: `user${userMatch[1]}@example.com`, tags: ['alpha', 'beta'],
    })
  }
  if (url.pathname === '/test/slow') {
    const ms = Number(url.searchParams.get('ms') ?? 1500)
    await new Promise(r => setTimeout(r, ms))
    return json(res, 200, { slept: ms })
  }
  if (url.pathname === '/test/error') return json(res, 500, { error: 'boom' })
  if (url.pathname === '/test/image') {
    const png = makePng(180, 120, 74, 108, 247) // solid indigo block
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
    res.end(png)
    return
  }
  if (url.pathname === '/test/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let n = 0
    const timer = setInterval(() => {
      res.write(`data: {"tick":${++n},"ts":${Date.now()}}\n\n`)
      if (n >= 5) { clearInterval(timer); res.end() }
    }, 400)
    req.on('close', () => clearInterval(timer))
    return
  }
  json(res, 404, { error: 'not found' })
}

// minimal solid-colour PNG generator (RGB, no deps beyond node:zlib) for the /test/image endpoint
function makePng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b }
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const idat = deflateSync(raw)
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
    if (url.pathname.startsWith('/test/')) return await handleTest(req, res, url)
    if (req.method === 'GET') return await serveStatic(res, url.pathname)
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
      console.log(`[device] ${info.deviceName} (${info.appId}) connected`)
      sendMocksToDevice(deviceId)
      broadcastToUi({ type: 'device-status', deviceId, connected: true, info })
      return
    }
    if (deviceId) pushEntry(deviceId, msg)
  })
  ws.on('close', () => {
    if (!deviceId) return
    const d = devices.get(deviceId)
    if (d?.ws === ws) {
      d.connected = false
      console.log(`[device] ${d.info.deviceName} disconnected`)
      broadcastToUi({ type: 'device-status', deviceId, connected: false })
    }
  })
})

uiWss.on('connection', ws => {
  uiClients.add(ws)
  ws.send(JSON.stringify({
    type: 'init',
    devices: [...devices.values()].map(d => ({ ...d.info, connected: d.connected })),
    entries, mocksByDevice: mockStore.devices,
  }))
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
})

// ---------- adb reverse: route device/emulator localhost:9091 to this machine ----------

function adbReverse() {
  execFile('adb', ['devices'], (err, stdout) => {
    if (err) return // adb not installed, never mind
    for (const line of stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split('\t')
      if (state === 'device') {
        execFile('adb', ['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], () => {})
      }
    }
  })
}
setInterval(adbReverse, 5000)
adbReverse()

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`)
    console.error(`Free it (lsof -ti tcp:${PORT} | xargs kill) or pick another port:`)
    console.error(`  PORT=9092 npm start   — and in the app: Sniffer.start(appId, port = 9092)`)
    process.exit(1)
  }
  throw e
})

server.listen(PORT, () => {
  console.log(`Sniffer daemon: http://localhost:${PORT}`)
})
