import type { IncomingMessage, ServerResponse } from 'node:http'
import { redact } from './redact.js'
import type { Entry } from './entryStore.js'
import { json, readBody } from './http.js'
import { isStarred, normalizeMocks, type MockStore, type Mocks } from './mockStore.js'

const HTTP_ENTRY_TYPES = new Set(['http-request', 'http-response'])
const SOCKET_ENTRY_TYPES = new Set(['socket-status', 'socket-event', 'socket-ack'])
const FIREBASE_ENTRY_TYPES = new Set(['firebase-analytics-event'])
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
    clearFirebase(): void
    snapshot(): Entry[]
  }
  broadcastToUi(msg: unknown): void
  sendMocksToDevice(deviceId: string): void
  mocksFor(deviceId: string): Mocks
  mergedMocksByDevice(): Record<string, Mocks>
  removeDeviceRecord(deviceId: string): { removed: boolean; mocksChanged: boolean }
  getBreakpoints(): Record<string, unknown[]>
  getPendingHits(): Array<{ deviceId: string; hit: Record<string, unknown> }>
  setBreakpoints(deviceId: string, rules: unknown[]): void
  sendBreakpointsToDevice(deviceId: string): void
  resolvePendingHit(id: string): void
  releasePendingHits(): void
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
  if (req.method === 'PUT' && url.pathname === '/api/breakpoints') {
    const body = JSON.parse(await readBody(req))
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
    if (!deviceId) return json(res, 400, { error: 'deviceId required' })
    const rules = Array.isArray(body.rules) ? body.rules : []
    deps.setBreakpoints(deviceId, rules)
    deps.sendBreakpointsToDevice(deviceId)
    deps.broadcastToUi({ type: 'breakpoints-changed', deviceId, rules })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/breakpoints/resolve') {
    const body = JSON.parse(await readBody(req))
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
    const id = typeof body.id === 'string' ? body.id : ''
    if (!deviceId || !id) return json(res, 400, { error: 'deviceId and id required' })
    const device = deps.devices.get(deviceId)
    if (!device?.connected) return json(res, 404, { error: 'device not connected' })
    device.ws.send(JSON.stringify({
      type: 'breakpoint-resolve', id, action: body.action === 'abort' ? 'abort' : 'resume',
      status: body.status, headers: body.headers, body: body.body,
    }))
    deps.resolvePendingHit(id)
    deps.broadcastToUi({ type: 'breakpoint-resolved', deviceId, id })
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
    // paused responses are in-flight HTTP: a clean slate resumes them (unchanged) rather than
    // leaving the app blocked or silently killing its requests
    deps.releasePendingHits()
    deps.broadcastToUi({ type: 'entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/http') {
    deps.entryStore.clearHttp()
    deps.releasePendingHits()
    deps.broadcastToUi({ type: 'http-entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/socket') {
    deps.entryStore.clearSocket()
    deps.broadcastToUi({ type: 'socket-entries-cleared' })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'DELETE' && url.pathname === '/api/entries/firebase') {
    deps.entryStore.clearFirebase()
    deps.broadcastToUi({ type: 'firebase-entries-cleared' })
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
    const state = {
      devices: [...deps.devices.values()].map(d => ({ ...d.info, connected: d.connected })),
      entryCount: deps.entryStore.snapshot().length, mocksByDevice: deps.mergedMocksByDevice(),
      breakpointsByDevice: deps.getBreakpoints(), pausedHits: deps.getPendingHits(),
    }
    return json(res, 200, url.searchParams.get('redact') === '1' ? redact(state) : state)
  }
  if (req.method === 'GET' && url.pathname === '/api/entries') {
    const params = url.searchParams
    if (params.has('type') && !['http', 'socket', 'firebase'].includes(params.get('type')!))
      return json(res, 400, { error: 'type must be http, socket or firebase' })
    for (const key of ['limit', 'status']) {
      if (params.has(key) && (!/^\d+$/.test(params.get(key)!) || Number(params.get(key)) < (key === 'limit' ? 1 : 0)))
        return json(res, 400, { error: `${key} must be a nonnegative integer (limit must be positive)` })
    }
    const appId = params.get('appId')
    const entries = deps.entryStore.snapshot().filter(entry => !appId || deps.devices.get(entry.deviceId)?.info.appId === appId)
    return json(res, 200, { entries: queryEntries(entries, params) })
  }
  json(res, 404, { error: 'not found' })
}

function queryEntries(entries: Entry[], params: URLSearchParams): Entry[] {
  const kind = params.get('type') === 'http' ? HTTP_ENTRY_TYPES
    : params.get('type') === 'socket' ? SOCKET_ENTRY_TYPES
      : params.get('type') === 'firebase' ? FIREBASE_ENTRY_TYPES : null
  const requests = new Map<string, Record<string, unknown>>()
  const responses = new Map<string, Record<string, unknown>>()
  const events = new Map<string, Record<string, unknown>>()
  const key = (entry: Entry) => JSON.stringify([entry.deviceId, entry.message.id])
  for (const entry of entries) {
    if (entry.message.type === 'http-request') requests.set(key(entry), entry.message)
    if (entry.message.type === 'http-response') responses.set(key(entry), entry.message)
    if (entry.message.type === 'socket-event') events.set(key(entry), entry.message)
  }
  let out = entries.filter(entry => {
    const m = entry.message
    const request = HTTP_ENTRY_TYPES.has(String(m.type)) ? requests.get(key(entry)) ?? m
      : m.type === 'socket-ack' ? events.get(key(entry)) ?? m : m
    const response = HTTP_ENTRY_TYPES.has(String(m.type)) ? responses.get(key(entry)) ?? m : m
    if (params.has('deviceId') && entry.deviceId !== params.get('deviceId')) return false
    if (params.has('id') && m.id !== params.get('id')) return false
    if (kind && !kind.has(String(m.type))) return false
    if (params.has('method') && String(request.method ?? '').toUpperCase() !== params.get('method')!.toUpperCase()) return false
    if (params.has('status') && response.status !== Number(params.get('status'))) return false
    if (params.has('urlContains') && !String(request.url ?? '').includes(params.get('urlContains')!)) return false
    if (params.has('userId') && request.userId !== params.get('userId')) return false
    if (params.has('event') && (request.event ?? request.name) !== params.get('event')) return false
    if (params.has('connectionId') && request.connectionId !== params.get('connectionId')) return false
    if (params.has('bodyContains')) {
      const bodies = [m.body, m.payload, m.params].filter(value => value != null)
      if (!bodies.some(value => (typeof value === 'string' ? value : JSON.stringify(value)).includes(params.get('bodyContains')!))) return false
    }
    return true
  })
  if (params.has('limit')) out = out.slice(-Number(params.get('limit')))
  return params.get('redact') === '0' ? out : out.map(entry => redact(entry) as Entry)
}
