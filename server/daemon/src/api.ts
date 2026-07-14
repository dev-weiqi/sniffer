import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Entry } from './entryStore.js'
import { json, readBody } from './http.js'
import { isStarred, normalizeMocks, type MockStore, type Mocks } from './mockStore.js'

const HTTP_ENTRY_TYPES = new Set(['http-request', 'http-response'])
const SOCKET_ENTRY_TYPES = new Set(['socket-event', 'socket-ack'])
const REDACTED = '‹redacted›'
const REDACT_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-access-token', 'api-key', 'x-csrf-token', 'x-xsrf-token',
  ...(process.env.SNIFFER_REDACT_HEADERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
])
const normKey = (k: string) => k.toLowerCase().replace(/[_-]/g, '')
const REDACT_BODY_FIELDS = new Set([
  'accesstoken', 'refreshtoken', 'idtoken', 'token', 'password', 'passwd', 'secret',
  'apikey', 'authorization', 'credential', 'credentials', 'sessiontoken', 'clientsecret', 'privatekey',
  ...(process.env.SNIFFER_REDACT_BODY_FIELDS ?? '').split(',').map(s => normKey(s.trim())).filter(Boolean),
])
const SECRET_VALUE = /eyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:Bearer|Basic)\s+[\w.~+/=-]+|-----BEGIN[\s\S]+?-----END[^-]*-----/g

interface ApiDevice {
  info: {
    deviceId: string
    appId: string
  }
  connected: boolean
  ws: {
    send(text: string): void
    close(): void
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  devices: Map<string, ApiDevice>
  getMockStore(): MockStore
  setMockStore(store: MockStore): void
  persistMocks(): void
  entryStore: {
    clearAll(): void
    clearHttp(): void
    clearSocket(): void
    snapshot(): Entry[]
  }
  broadcastToUi(msg: unknown): void
  sendMocksToDevice(deviceId: string): void
  mocksFor(deviceId: string): Mocks
  mergedMocksByDevice(): Record<string, Mocks>
  removeDeviceRecord(deviceId: string): { removed: boolean; mocksChanged: boolean }
}) {
  if (req.method === 'PUT' && url.pathname === '/api/mocks') {
    const body = JSON.parse(await readBody(req))
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
    if (!deviceId) return json(res, 400, { error: 'deviceId required' })
    const mocks = normalizeMocks(body)
    const appId = deps.devices.get(deviceId)?.info.appId
    if (appId) {
      const own = { http: mocks.http.filter(r => !isStarred(r)), socket: mocks.socket.filter(r => !isStarred(r)) }
      const shared = { http: mocks.http.filter(isStarred), socket: mocks.socket.filter(isStarred) }
      const mockStore = deps.getMockStore()
      deps.setMockStore({
        devices: { ...mockStore.devices, [deviceId]: own },
        shared: { ...mockStore.shared, [appId]: shared },
      })
      deps.persistMocks()
      for (const d of deps.devices.values()) {
        if (d.info.appId !== appId) continue
        deps.sendMocksToDevice(d.info.deviceId)
        deps.broadcastToUi({ type: 'mocks-changed', deviceId: d.info.deviceId, mocks: deps.mocksFor(d.info.deviceId) })
      }
    } else {
      const mockStore = deps.getMockStore()
      deps.setMockStore({ ...mockStore, devices: { ...mockStore.devices, [deviceId]: mocks } })
      deps.persistMocks()
      deps.sendMocksToDevice(deviceId)
      deps.broadcastToUi({ type: 'mocks-changed', deviceId, mocks })
    }
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/push-event') {
    const body = JSON.parse(await readBody(req))
    const device = deps.devices.get(body.deviceId)
    if (!device?.connected) return json(res, 404, { error: 'device not connected' })
    device.ws.send(JSON.stringify({
      type: 'push-event', connectionId: body.connectionId ?? null,
      event: body.event, payload: body.payload,
    }))
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries') {
    deps.entryStore.clearAll()
    deps.broadcastToUi({ type: 'entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/http') {
    deps.entryStore.clearHttp()
    deps.broadcastToUi({ type: 'http-entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/socket') {
    deps.entryStore.clearSocket()
    deps.broadcastToUi({ type: 'socket-entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/devices/offline') {
    const offlineDeviceIds = [...deps.devices.values()]
      .filter(d => !d.connected)
      .map(d => d.info.deviceId)
    let mocksChanged = false
    const deleted: string[] = []
    for (const deviceId of offlineDeviceIds) {
      const result = deps.removeDeviceRecord(deviceId)
      if (result.removed) deleted.push(deviceId)
      mocksChanged = mocksChanged || result.mocksChanged
    }
    if (mocksChanged) deps.persistMocks()
    return json(res, 200, { ok: true, deleted })
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
    const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length))
    if (!deviceId) return json(res, 400, { error: 'deviceId required' })
    const device = deps.devices.get(deviceId)
    const result = deps.removeDeviceRecord(deviceId)
    if (result.mocksChanged) deps.persistMocks()
    if (device?.connected) device.ws.close()
    return json(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, {
      devices: [...deps.devices.values()].map(d => ({ ...d.info, connected: d.connected })),
      entryCount: deps.entryStore.snapshot().length, mocksByDevice: deps.mergedMocksByDevice(),
    })
  }
  if (req.method === 'GET' && url.pathname === '/api/entries') {
    return json(res, 200, { entries: queryEntries(deps.entryStore.snapshot(), url.searchParams) })
  }
  json(res, 404, { error: 'not found' })
}

function redactBody(body: string): string {
  let text = body
  try {
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk)
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(value)) {
          out[key] = REDACT_BODY_FIELDS.has(normKey(key)) ? REDACTED : walk(child)
        }
        return out
      }
      return value
    }
    text = JSON.stringify(walk(JSON.parse(body)))
  } catch {
    // Non-JSON bodies still get value-shape redaction below.
  }
  return text.replace(SECRET_VALUE, REDACTED)
}

function redactEntry(entry: Entry): Entry {
  let message = entry.message
  const headers = message.headers
  if (headers && typeof headers === 'object') {
    let changed = false
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (REDACT_HEADERS.has(key.toLowerCase())) {
        clean[key] = REDACTED
        changed = true
      } else {
        clean[key] = value
      }
    }
    if (changed) message = { ...message, headers: clean }
  }
  if (typeof message.body === 'string' && message.body) {
    const body = redactBody(message.body)
    if (body !== message.body) message = { ...message, body }
  }
  return message === entry.message ? entry : { ...entry, message }
}

function queryEntries(entries: Entry[], params: URLSearchParams): Entry[] {
  const deviceId = params.get('deviceId')
  const type = params.get('type')
  const kind = type === 'http' ? HTTP_ENTRY_TYPES : type === 'socket' ? SOCKET_ENTRY_TYPES : null
  const method = params.get('method')?.toUpperCase()
  const rawStatus = params.get('status')
  const status = rawStatus === null ? null : Number(rawStatus)
  const urlContains = params.get('urlContains')
  const bodyContains = params.get('bodyContains')
  let out = entries
  if (deviceId) out = out.filter(entry => entry.deviceId === deviceId)
  if (kind) out = out.filter(entry => kind.has(entry.message.type as string))
  if (method) out = out.filter(entry => (entry.message.method as string | undefined)?.toUpperCase() === method)
  if (status !== null && Number.isFinite(status)) out = out.filter(entry => entry.message.status === status)
  if (urlContains) out = out.filter(entry => String(entry.message.url ?? '').includes(urlContains))
  if (bodyContains) out = out.filter(entry => {
    const body = entry.message.body
    return (typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body)).includes(bodyContains)
  })
  const limit = Number(params.get('limit'))
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) out = out.slice(-limit)
  return params.get('redact') === '0' ? out : out.map(redactEntry)
}
