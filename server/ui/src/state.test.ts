import {
  api,
  connectStream,
  initialState,
  reducer,
  type Action,
  type Device,
  type Mocks,
  type SocketConn,
  type SocketRow,
  type State,
} from './state.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

function dispatch(state: State, msg: Record<string, unknown>): State {
  return reducer(state, { type: 'server', msg })
}

const device: Device = {
  deviceId: 'd1',
  deviceName: 'Pixel',
  platform: 'android',
  appId: 'com.demo',
  sdkVersion: '1',
  capabilities: ['http', 'socketio'],
  connected: true,
}

const mocks: Mocks = {
  http: [{
    id: 'h1',
    enabled: true,
    method: 'GET',
    urlPattern: '/users',
    status: 200,
    headers: {},
    body: '{}',
    delayMs: 0,
    delayOnly: false,
  }],
  socket: [{
    id: 's1',
    enabled: true,
    transport: 'socketio',
    event: 'join',
    ackPayload: '{}',
    delayMs: 0,
  }],
}

let s = reducer(initialState, { type: 'ws', connected: true })
assertEqual(s.wsConnected, true, 'ws action marks stream connected')

s = dispatch(initialState, {
  type: 'init',
  devices: [device],
  mocksByDevice: { d1: mocks },
  breakpointsByDevice: { d1: [{ id: 'b1', enabled: true, method: null, urlPattern: '/users', phase: 'response' }] },
  pausedHits: [{ deviceId: 'd1', hit: { id: 'hit1', ruleId: 'b1', phase: 'response', method: 'GET', url: 'https://example.com/users', status: 200, headers: {}, body: '{}', library: 'okhttp', timestamp: 5 } }],
  entries: [
    {
      deviceId: 'd1',
      message: {
        type: 'http-request',
        id: 'r1',
        timestamp: 10,
        method: 'GET',
        url: 'https://example.com/users',
        library: 'okhttp',
        headers: { accept: 'json' },
        body: null,
        bodySize: 0,
      },
    },
    {
      deviceId: 'd1',
      message: {
        type: 'socket-status',
        connectionId: 'c1',
        transport: 'socketio',
        url: 'ws://demo',
        status: 'connected',
      },
    },
  ],
})
assertEqual(s.wsConnected, true, 'init marks stream connected')
assertEqual(s.devices.length, 1, 'init hydrates devices')
assertEqual(s.http.length, 1, 'init replays HTTP entries')
assertEqual(s.socketConns.length, 1, 'init replays socket connections')
assertEqual(s.connUrls.c1, 'ws://demo', 'init stores connection URLs')
assertEqual(s.mocksByDevice.d1.http[0].id, 'h1', 'init hydrates mocks')
assertEqual(s.breakpointsByDevice.d1[0].id, 'b1', 'init hydrates breakpoint rules')
assertEqual(s.pausedHits[0].id, 'hit1', 'init flattens paused hits')
assertEqual(s.pausedHits[0].deviceId, 'd1', 'init tags paused hit with device')

s = dispatch(s, { type: 'server-info', dev: true })
assertEqual(s.dev, true, 'server-info updates dev flag')

s = dispatch(s, {
  type: 'event',
  deviceId: 'd1',
  message: {
    type: 'http-response',
    id: 'r1',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    bodyBase64: false,
    bodySize: 11,
    durationMs: 12,
    delayedMs: 4,
    mocked: true,
    error: null,
  },
})
assertEqual(s.http[0].status, 200, 'http-response fills status')
assertEqual(s.http[0].delayedMs, 4, 'http-response stores delay')
assertEqual(s.http[0].mocked, true, 'http-response stores mock marker')

s = dispatch(s, {
  type: 'event',
  deviceId: 'd1',
  message: {
    type: 'http-response',
    id: 'r1',
    status: 201,
    headers: {},
    body: '',
    bodySize: 0,
    durationMs: 13,
    mocked: false,
    error: null,
  },
})
assertEqual(s.http[0].delayedMs, 4, 'http-response keeps earlier delay when update omits it')

s = dispatch(s, {
  type: 'event',
  deviceId: 'd1',
  message: {
    type: 'socket-status',
    connectionId: 'c2',
    transport: 'socketio',
    url: 'ws://demo',
    status: 'connected',
  },
})
assertEqual(s.socketConns.length, 1, 'fresh connection replaces previous endpoint connection')
assertEqual(s.socketConns[0].connectionId, 'c2', 'fresh connection is retained')

s = dispatch(s, {
  type: 'event',
  deviceId: 'd1',
  message: {
    type: 'socket-event',
    id: 'e1',
    connectionId: 'c2',
    timestamp: 20,
    transport: 'socketio',
    direction: 'out',
    event: 'join',
    payload: '["room"]',
    mocked: false,
  },
})
assertEqual(s.socketEvents.length, 1, 'socket-event appends row')
assertEqual(s.socketEvents[0].label, undefined, 'socket-event without label stays unlabeled')

s = dispatch(s, {
  type: 'event',
  deviceId: 'd1',
  message: {
    type: 'socket-event',
    id: 'e-labeled',
    connectionId: 'c2',
    timestamp: 21,
    transport: 'socketio',
    direction: 'in',
    event: 'message',
    label: 'chat',
    payload: '[{"type":"chat"}]',
    mocked: false,
  },
})
assertEqual(s.socketEvents[1].event, 'message', 'socket-event keeps wire event name')
assertEqual(s.socketEvents[1].label, 'chat', 'socket-event carries display tag')

s = dispatch(s, {
  type: 'event',
  deviceId: 'd1',
  message: { type: 'socket-ack', id: 'e1', payload: '{"ok":true}', mocked: true },
})
assertEqual(s.socketEvents[0].ackPayload, '{"ok":true}', 'socket-ack updates matching event')
assertEqual(s.socketEvents[0].ackMocked, true, 'socket-ack stores mock marker')

const beforeUnknown = s
s = dispatch(s, { type: 'event', deviceId: 'd1', message: { type: 'unknown-device-message' } })
assert(s === beforeUnknown, 'unknown device message returns original state')

s = dispatch(s, {
  type: 'device-status',
  deviceId: 'd2',
  connected: true,
  info: {
    deviceId: 'd2',
    deviceName: 'iPhone',
    platform: 'ios',
    appId: 'com.demo',
    sdkVersion: '1',
    capabilities: [],
  },
})
assertEqual(s.devices.length, 2, 'new device status inserts device')

s = dispatch(s, {
  type: 'device-status',
  deviceId: 'd1',
  connected: false,
  info: { deviceName: 'Pixel 2' },
})
assertEqual(s.devices.find(d => d.deviceId === 'd1')!.deviceName, 'Pixel 2', 'existing device status merges info')
assertEqual(s.devices.find(d => d.deviceId === 'd1')!.connected, false, 'existing device status updates connected')
assertEqual(s.socketConns.find(c => c.deviceId === 'd1')!.status, 'disconnected', 'disconnect marks sockets disconnected')

s = dispatch(s, { type: 'mocks-changed', deviceId: 'd2', mocks })
assertEqual(s.mocksByDevice.d2.socket[0].id, 's1', 'mocks-changed updates device bucket')

// breakpoints
s = dispatch(s, { type: 'breakpoints-changed', deviceId: 'd1', rules: [{ id: 'b2', enabled: true, method: 'GET', urlPattern: '/x', phase: 'response' }] })
assertEqual(s.breakpointsByDevice.d1[0].id, 'b2', 'breakpoints-changed updates device rules')

s = dispatch(s, { type: 'breakpoint-hit', deviceId: 'd1', hit: { id: 'hitA', ruleId: 'b2', phase: 'response', method: 'GET', url: 'https://example.com/x', status: 200, headers: {}, body: '{}', library: 'okhttp', timestamp: 30 } })
assertEqual(s.pausedHits.some(h => h.id === 'hitA'), true, 'breakpoint-hit adds a paused hit')
assertEqual(s.pausedHits.find(h => h.id === 'hitA')!.deviceId, 'd1', 'breakpoint-hit tags device')

const afterResolve = dispatch(s, { type: 'breakpoint-resolved', deviceId: 'd1', id: 'hitA' })
assertEqual(afterResolve.pausedHits.some(h => h.id === 'hitA'), false, 'breakpoint-resolved drops the hit')

const afterRelease = dispatch(s, { type: 'breakpoints-released', deviceId: 'd1' })
assertEqual(afterRelease.pausedHits.some(h => h.deviceId === 'd1'), false, 'breakpoints-released drops device hits')

let cleared = dispatch(s, { type: 'http-entries-cleared' })
assertEqual(cleared.http.length, 0, 'http clear removes HTTP rows only')
assertEqual(cleared.socketEvents.length, 2, 'http clear keeps socket rows')

cleared = dispatch(s, { type: 'socket-entries-cleared' })
assertEqual(cleared.socketEvents.length, 0, 'socket clear removes socket rows only')
assertEqual(cleared.http.length, 1, 'socket clear keeps HTTP rows')

cleared = dispatch(s, { type: 'entries-cleared' })
assertEqual(cleared.http.length, 0, 'entries clear removes HTTP rows')
assertEqual(cleared.socketEvents.length, 0, 'entries clear removes socket rows')
assertEqual(cleared.socketConns.length, 0, 'entries clear removes socket connections')

const deleted = dispatch(s, { type: 'device-deleted', deviceId: 'd1' })
assert(!deleted.devices.some(d => d.deviceId === 'd1'), 'device delete removes device')
assert(!deleted.http.some(r => r.deviceId === 'd1'), 'device delete removes HTTP rows')
assert(!deleted.socketConns.some(c => c.deviceId === 'd1'), 'device delete removes sockets')
assert(!deleted.socketEvents.some(e => e.deviceId === 'd1'), 'device delete removes socket events')
assert(!deleted.mocksByDevice.d1, 'device delete removes mocks')
assert(!deleted.breakpointsByDevice.d1, 'device delete removes breakpoint rules')
assert(!deleted.pausedHits.some(h => h.deviceId === 'd1'), 'device delete removes paused hits')

const unknownServer = dispatch(s, { type: 'unknown-server-message' })
assert(unknownServer === s, 'unknown server message returns original state')

let capped = initialState
for (let i = 0; i < 505; i++) {
  capped = dispatch(capped, {
    type: 'event',
    deviceId: 'd1',
    message: {
      type: 'http-request',
      id: `r-${i}`,
      timestamp: i,
      method: 'GET',
      url: `/r/${i}`,
      library: 'okhttp',
    },
  })
}
assertEqual(capped.http.length, 500, 'HTTP rows are capped')
assertEqual(capped.http[0].id, 'r-5', 'HTTP cap drops oldest rows')

const fetchCalls: Array<{ input: string; init?: RequestInit }> = []
const originalFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push({ input: String(input), init })
  return Promise.resolve({ ok: true } as Response)
}) as typeof fetch

await api.saveMocks('d 1', mocks)
await api.pushEvent('d1', 'c1', 'join', '{"room":1}')
await api.pushEvent('d1', null, 'notify', '{}')
await api.clearEntries()
await api.clearHttpEntries()
await api.clearSocketEntries()
await api.deleteOfflineDevices()
await api.deleteDevice('d/1')
await api.armBreakpoints('d1', [{ id: 'b1', enabled: true, method: null, urlPattern: '/x', phase: 'response' }])
await api.resolveBreakpoint('d1', 'hit1', 'resume', { status: 503, body: 'edited' })
await api.resolveBreakpoint('d1', 'hit2', 'abort')

assertEqual(fetchCalls[0].input, '/api/mocks', 'saveMocks URL')
assertEqual(fetchCalls[0].init?.method, 'PUT', 'saveMocks method')
assert(String(fetchCalls[0].init?.body).includes('"deviceId":"d 1"'), 'saveMocks includes deviceId')
assertEqual(fetchCalls[1].input, '/api/push-event', 'pushEvent URL')
assertEqual(fetchCalls[1].init?.method, 'POST', 'pushEvent method')
assert(String(fetchCalls[2].init?.body).includes('"connectionId":null'), 'pushEvent preserves null connection')
assertEqual(fetchCalls[3].input, '/api/entries', 'clear entries URL')
assertEqual(fetchCalls[4].input, '/api/entries/http', 'clear HTTP URL')
assertEqual(fetchCalls[5].input, '/api/entries/socket', 'clear socket URL')
assertEqual(fetchCalls[6].input, '/api/devices/offline', 'delete offline URL')
assertEqual(fetchCalls[7].input, '/api/devices/d%2F1', 'delete device URL encodes id')
assertEqual(fetchCalls[8].input, '/api/breakpoints', 'armBreakpoints URL')
assertEqual(fetchCalls[8].init?.method, 'PUT', 'armBreakpoints method')
assertEqual(fetchCalls[9].input, '/api/breakpoints/resolve', 'resolveBreakpoint URL')
assert(String(fetchCalls[9].init?.body).includes('"status":503'), 'resolveBreakpoint carries edits')
assert(String(fetchCalls[10].init?.body).includes('"action":"abort"'), 'resolveBreakpoint abort action')
globalThis.fetch = originalFetch

const wsActions: Action[] = []
const originalLocation = globalThis.location
const originalWebSocket = globalThis.WebSocket
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
let timerHandle = 0
let clearedTimer: unknown = null

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  close() {
    this.closed = true
  }
}

Object.defineProperty(globalThis, 'location', {
  value: { protocol: 'https:', host: 'sniffer.local' },
  configurable: true,
})
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => {
  timerHandle += 1
  return timerHandle as unknown as ReturnType<typeof setTimeout>
}) as typeof setTimeout
globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
  clearedTimer = handle
}) as typeof clearTimeout

const stopStream = connectStream(action => wsActions.push(action))
const fake = FakeWebSocket.instances[0]
assertEqual(fake.url, 'wss://sniffer.local/ui', 'connectStream uses secure websocket for https')
fake.onopen?.()
fake.onmessage?.({ data: JSON.stringify({ type: 'server-info', dev: false }) })
fake.onclose?.()
stopStream()

assertEqual(wsActions[0].type, 'ws', 'connectStream dispatches open')
assertEqual((wsActions[0] as Extract<Action, { type: 'ws' }>).connected, true, 'connectStream open is connected')
assertEqual(wsActions[1].type, 'server', 'connectStream dispatches server message')
assertEqual(wsActions[2].type, 'ws', 'connectStream dispatches close')
assertEqual((wsActions[2] as Extract<Action, { type: 'ws' }>).connected, false, 'connectStream close is disconnected')
assertEqual(fake.closed, true, 'connectStream cleanup closes websocket')
assertEqual(clearedTimer, timerHandle, 'connectStream cleanup clears reconnect timer')

if (originalLocation) {
  Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true })
} else {
  delete (globalThis as { location?: Location }).location
}
globalThis.WebSocket = originalWebSocket
globalThis.setTimeout = originalSetTimeout
globalThis.clearTimeout = originalClearTimeout

try {
  const sample = {
    generatedAt: 1,
    platform: 'darwin',
    port: 9091,
    bindHost: '127.0.0.1',
    checks: [
      { id: 'daemon', label: 'Sniffer Daemon', status: 'ok', summary: 'Listening' },
    ],
  }
  let requestUrl = ''
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input)
    assert(init === undefined, 'doctor request should not send custom fetch options')
    return Promise.resolve(new Response(JSON.stringify(sample), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch

  const report = await api.doctor()
  assertEqual(requestUrl, '/api/doctor', 'doctor URL')
  assertEqual(report.port, 9091, 'doctor port')
  assertEqual(report.checks[0].id, 'daemon', 'doctor check id')

  globalThis.fetch = (() => Promise.resolve(new Response('boom', {
    status: 500,
    statusText: 'Server Error',
  }))) as typeof fetch

  let errorMessage = ''
  try {
    await api.doctor()
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
  }
  assert(errorMessage.includes('500'), `doctor error should include status, got ${errorMessage}`)
} finally {
  globalThis.fetch = originalFetch
}

console.log('state.test: all assertions passed')
