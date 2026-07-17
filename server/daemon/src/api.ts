import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBody } from './http.js'
import { isStarred, normalizeMocks, type MockStore, type Mocks } from './mockStore.js'

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
    snapshot(): unknown[]
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
  json(res, 404, { error: 'not found' })
}
