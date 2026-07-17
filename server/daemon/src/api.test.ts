import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleApi } from './api.js'
import type { MockStore, Mocks } from './mockStore.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

function fakeReq(method: string, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text)
    },
  } as IncomingMessage
}

function fakeRes() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    ended: '',
    writeHead(status: number, headers: Record<string, string> = {}) {
      this.status = status
      this.headers = headers
    },
    end(body?: string) {
      this.ended = body ?? ''
    },
  }
}

function bodyOf(res: ReturnType<typeof fakeRes>) {
  return JSON.parse(res.ended)
}

function makeDeps() {
  let mockStore: MockStore = { devices: {}, shared: {} }
  const sends: Array<{ deviceId: string; text: string }> = []
  const closes: string[] = []
  const broadcasts: unknown[] = []
  const sentMocks: string[] = []
  let persisted = 0
  const removed: Array<{ deviceId: string; result: { removed: boolean; mocksChanged: boolean } }> = []
  const entryCalls: string[] = []
  const breakpointSets: Array<{ deviceId: string; rules: unknown[] }> = []
  const breakpointSends: string[] = []
  const resolvedHits: string[] = []
  let releasedHits = 0
  const devices = new Map<string, {
    info: { deviceId: string; appId: string; deviceName: string }
    connected: boolean
    ws: { send(text: string): void; close(): void }
  }>()
  const addDevice = (deviceId: string, appId: string, connected: boolean) => {
    devices.set(deviceId, {
      info: { deviceId, appId, deviceName: deviceId },
      connected,
      ws: {
        send: text => sends.push({ deviceId, text }),
        close: () => closes.push(deviceId),
      },
    })
  }
  const deps = {
    devices,
    getMockStore: () => mockStore,
    setMockStore: (store: MockStore) => { mockStore = store },
    persistMocks: () => { persisted += 1 },
    entryStore: {
      clearAll: () => entryCalls.push('all'),
      clearHttp: () => entryCalls.push('http'),
      clearSocket: () => entryCalls.push('socket'),
      snapshot: () => [{ id: 'entry' }],
    },
    broadcastToUi: (msg: unknown) => broadcasts.push(msg),
    sendMocksToDevice: (deviceId: string) => sentMocks.push(deviceId),
    mocksFor: (deviceId: string): Mocks => ({ http: [{ id: `h-${deviceId}` }], socket: [] }),
    mergedMocksByDevice: () => ({ d1: { http: [{ id: 'h-d1' }], socket: [] } }),
    removeDeviceRecord: (deviceId: string) => {
      const result = { removed: deviceId !== 'noop', mocksChanged: deviceId === 'offline' || deviceId === 'd1' }
      removed.push({ deviceId, result })
      return result
    },
    setBreakpoints: (deviceId: string, rules: unknown[]) => breakpointSets.push({ deviceId, rules }),
    sendBreakpointsToDevice: (deviceId: string) => breakpointSends.push(deviceId),
    resolvePendingHit: (id: string) => resolvedHits.push(id),
    releasePendingHits: () => { releasedHits += 1 },
  }
  return { deps, addDevice, get mockStore() { return mockStore }, sends, closes, broadcasts, sentMocks, get persisted() { return persisted }, removed, entryCalls, breakpointSets, breakpointSends, resolvedHits, get releasedHits() { return releasedHits } }
}

let ctx = makeDeps()
let res = fakeRes()
await handleApi(fakeReq('PUT', { http: [] }), res as unknown as ServerResponse, new URL('http://localhost/api/mocks'), ctx.deps)
assertEqual(res.status, 400, 'PUT mocks requires deviceId')
assertEqual(bodyOf(res).error, 'deviceId required', 'PUT mocks missing device body')

ctx = makeDeps()
ctx.addDevice('d1', 'app', true)
ctx.addDevice('d2', 'app', true)
ctx.addDevice('d3', 'other', true)
res = fakeRes()
await handleApi(fakeReq('PUT', {
  deviceId: 'd1',
  http: [{ id: 'h1', starred: true }, { id: 'h2' }],
  socket: [{ id: 's1', starred: true }, { id: 's2' }],
}), res as unknown as ServerResponse, new URL('http://localhost/api/mocks'), ctx.deps)
assertEqual(res.status, 200, 'PUT mocks known app status')
assertEqual(ctx.mockStore.devices.d1.http.length, 1, 'PUT mocks keeps non-starred HTTP per-device')
assertEqual(ctx.mockStore.shared.app.http.length, 1, 'PUT mocks stores starred HTTP by app')
assertEqual(ctx.sentMocks.join(','), 'd1,d2', 'PUT mocks sends to same app devices')
assertEqual(ctx.broadcasts.length, 2, 'PUT mocks broadcasts same app device changes')
assertEqual(ctx.persisted, 1, 'PUT mocks persists once')

ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('PUT', { deviceId: 'gone', http: [{ id: 'h1' }], socket: [] }), res as unknown as ServerResponse, new URL('http://localhost/api/mocks'), ctx.deps)
assertEqual(ctx.mockStore.devices.gone.http.length, 1, 'PUT mocks unknown device stores per-device')
assertEqual(ctx.sentMocks[0], 'gone', 'PUT mocks unknown device attempts device send')
assertEqual((ctx.broadcasts[0] as { type: string }).type, 'mocks-changed', 'PUT mocks unknown device broadcasts')

ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('POST', { deviceId: 'missing' }), res as unknown as ServerResponse, new URL('http://localhost/api/push-event'), ctx.deps)
assertEqual(res.status, 404, 'push event disconnected status')

ctx.addDevice('d1', 'app', true)
res = fakeRes()
await handleApi(fakeReq('POST', { deviceId: 'd1', event: 'notify', payload: '{}', connectionId: undefined }), res as unknown as ServerResponse, new URL('http://localhost/api/push-event'), ctx.deps)
assertEqual(res.status, 200, 'push event connected status')
assertEqual(JSON.parse(ctx.sends[0].text).connectionId, null, 'push event defaults null connection')

// breakpoints: arm rules
ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('PUT', { rules: [] }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints'), ctx.deps)
assertEqual(res.status, 400, 'PUT breakpoints requires deviceId')

ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('PUT', { deviceId: 'd1', rules: [{ id: 'b1' }] }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints'), ctx.deps)
assertEqual(res.status, 200, 'PUT breakpoints status')
assertEqual(ctx.breakpointSets[0].deviceId, 'd1', 'PUT breakpoints stores rules for device')
assertEqual(ctx.breakpointSends[0], 'd1', 'PUT breakpoints syncs to device')
assertEqual((ctx.broadcasts[0] as { type: string }).type, 'breakpoints-changed', 'PUT breakpoints broadcasts')

// breakpoints: non-array rules default to empty
ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('PUT', { deviceId: 'd1' }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints'), ctx.deps)
assertEqual(ctx.breakpointSets[0].rules.length, 0, 'PUT breakpoints missing rules is empty')

// breakpoints: resolve requires deviceId + id
ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('POST', { deviceId: 'd1' }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints/resolve'), ctx.deps)
assertEqual(res.status, 400, 'resolve requires id')

// breakpoints: resolve on disconnected device
ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('POST', { deviceId: 'gone', id: 'h1' }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints/resolve'), ctx.deps)
assertEqual(res.status, 404, 'resolve disconnected device')

// breakpoints: resolve resume with edits
ctx = makeDeps()
ctx.addDevice('d1', 'app', true)
res = fakeRes()
await handleApi(fakeReq('POST', { deviceId: 'd1', id: 'h1', action: 'resume', status: 503, body: 'x' }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints/resolve'), ctx.deps)
assertEqual(res.status, 200, 'resolve resume status')
assertEqual(JSON.parse(ctx.sends[0].text).action, 'resume', 'resolve sends resume to device')
assertEqual(JSON.parse(ctx.sends[0].text).status, 503, 'resolve carries edited status')
assertEqual(ctx.resolvedHits[0], 'h1', 'resolve drops the pending hit')
assertEqual((ctx.broadcasts[0] as { type: string }).type, 'breakpoint-resolved', 'resolve broadcasts')

// breakpoints: resolve abort maps action
ctx = makeDeps()
ctx.addDevice('d1', 'app', true)
res = fakeRes()
await handleApi(fakeReq('POST', { deviceId: 'd1', id: 'h1', action: 'abort' }), res as unknown as ServerResponse, new URL('http://localhost/api/breakpoints/resolve'), ctx.deps)
assertEqual(JSON.parse(ctx.sends[0].text).action, 'abort', 'resolve maps abort action')

for (const [path, call, event, releases] of [
  ['/api/entries', 'all', 'entries-cleared', 1],
  ['/api/entries/http', 'http', 'http-entries-cleared', 1],
  ['/api/entries/socket', 'socket', 'socket-entries-cleared', 0],
] as const) {
  ctx = makeDeps()
  res = fakeRes()
  await handleApi(fakeReq('DELETE'), res as unknown as ServerResponse, new URL(`http://localhost${path}`), ctx.deps)
  assertEqual(ctx.entryCalls[0], call, `${path} entry call`)
  assertEqual((ctx.broadcasts[0] as { type: string }).type, event, `${path} broadcast`)
  assertEqual(ctx.releasedHits, releases, `${path} releases paused hits`)
}

ctx = makeDeps()
ctx.addDevice('online', 'app', true)
ctx.addDevice('offline', 'app', false)
res = fakeRes()
await handleApi(fakeReq('DELETE'), res as unknown as ServerResponse, new URL('http://localhost/api/devices/offline'), ctx.deps)
assertEqual(ctx.removed[0].deviceId, 'offline', 'delete offline removes offline only')
assertEqual(bodyOf(res).deleted[0], 'offline', 'delete offline response')
assertEqual(ctx.persisted, 1, 'delete offline persists when mocks changed')

ctx = makeDeps()
res = fakeRes()
await handleApi(fakeReq('DELETE'), res as unknown as ServerResponse, new URL('http://localhost/api/devices/'), ctx.deps)
assertEqual(res.status, 400, 'delete device requires id')

ctx.addDevice('d1', 'app', true)
res = fakeRes()
await handleApi(fakeReq('DELETE'), res as unknown as ServerResponse, new URL('http://localhost/api/devices/d1'), ctx.deps)
assertEqual(ctx.removed[0].deviceId, 'd1', 'delete device removes id')
assertEqual(ctx.closes[0], 'd1', 'delete connected device closes websocket')
assertEqual(ctx.persisted, 1, 'delete device persists when mocks changed')

res = fakeRes()
await handleApi(fakeReq('GET'), res as unknown as ServerResponse, new URL('http://localhost/api/state'), ctx.deps)
assertEqual(bodyOf(res).devices.length, 1, 'state devices')
assertEqual(bodyOf(res).entryCount, 1, 'state entry count')
assertEqual(bodyOf(res).mocksByDevice.d1.http[0].id, 'h-d1', 'state mocks')

res = fakeRes()
await handleApi(fakeReq('GET'), res as unknown as ServerResponse, new URL('http://localhost/api/missing'), ctx.deps)
assertEqual(res.status, 404, 'unknown API status')
assertEqual(bodyOf(res).error, 'not found', 'unknown API body')

console.log('api.test: all assertions passed')
