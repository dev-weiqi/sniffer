import { redact } from './redact.js'
import { createMcpRuntime, TOOLS, type DaemonRequest } from './mcpCore.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

async function assertRejects(fn: () => Promise<unknown>, message: string, contains: string) {
  try {
    await fn()
  } catch (e) {
    assert((e as Error).message.includes(contains), message)
    return
  }
  throw new Error(`${message}: expected rejection`)
}

function makeDaemon() {
  const calls: Array<{ path: string; init?: RequestInit; body?: unknown }> = []
  const state = {
    devices: [
      { deviceId: 'd1', appId: 'app', connected: true },
      { deviceId: 'd2', appId: 'other', connected: true },
      { deviceId: 'd3', appId: 'app', connected: false },
    ],
    pausedHits: [{ deviceId: 'd1', hit: { id: 'paused', body: '{"password":"hidden"}' } }],
    mocksByDevice: {
      d1: {
        http: [{ id: 'h1', enabled: true, urlPattern: '/old', status: 200 }],
        socket: [{ id: 's1', event: 'old', ackPayload: '[]' }],
      },
    },
  }
  const entries = [
    { deviceId: 'd1', message: { id: 'flow-1', type: 'http-request' } },
    { deviceId: 'd1', message: { id: 'flow-1', type: 'http-response' } },
    { deviceId: 'd2', message: { id: 'flow-2', type: 'socket-event' } },
  ]
  const daemon: DaemonRequest = async (path, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, init, body })
    if (path === '/api/state') return state
    if (path === '/api/state?redact=1') return redact(state)
    if (path.startsWith('/api/entries')) {
      if (init?.method === 'DELETE') return { ok: true, cleared: path }
      const query = new URL(path, 'http://daemon').searchParams
      return { entries: entries.filter(entry =>
        (!query.has('id') || entry.message.id === query.get('id')) &&
        (!query.has('deviceId') || entry.deviceId === query.get('deviceId')) &&
        (!query.has('appId') || state.devices.find(d => d.deviceId === entry.deviceId)?.appId === query.get('appId'))
      ) }
    }
    if (path === '/api/breakpoints' && init?.method === 'PUT') return { ok: true, rules: body.rules }
    if (path === '/api/breakpoints/resolve' && init?.method === 'POST') return { ok: true, resolved: body }
    if (path === '/api/mocks' && init?.method === 'PUT') {
      state.mocksByDevice.d1 = body as typeof state.mocksByDevice.d1
      return { ok: true }
    }
    if (path === '/api/push-event' && init?.method === 'POST') return { ok: true, pushed: body }
    throw new Error(`unexpected daemon call ${init?.method ?? 'GET'} ${path}`)
  }
  return { daemon, calls, state }
}

assert(TOOLS.some(tool => tool.name === 'list_traffic'), 'tools include list_traffic')

let ctx = makeDaemon()
let runtime = createMcpRuntime({ daemon: ctx.daemon, appId: 'app', randomId: () => 'rule-1', host: 'localhost', port: 9191 })
assertEqual(runtime.base, 'http://localhost:9191', 'runtime base')
assertEqual((await runtime.call('get_state', {}) as { devices: unknown[] }).devices.length, 3, 'get_state')

await runtime.call('list_traffic', {
  type: 'http',
  method: 'GET',
  status: 200,
  urlContains: '/api',
  bodyContains: 'needle',
  limit: 2,
})
let trafficPath = ctx.calls.at(-1)?.path ?? ''
let params = new URL(`http://localhost${trafficPath}`).searchParams
assertEqual(params.get('deviceId'), 'd1', 'list_traffic defaults project device')
assertEqual(params.get('type'), 'http', 'list_traffic type')
assertEqual(params.get('method'), 'GET', 'list_traffic method')
assertEqual(params.get('status'), '200', 'list_traffic status')
assertEqual(params.get('urlContains'), '/api', 'list_traffic urlContains')
assertEqual(params.get('bodyContains'), 'needle', 'list_traffic bodyContains')
assertEqual(params.get('limit'), '2', 'list_traffic limit')

ctx = makeDaemon()
runtime = createMcpRuntime({ daemon: ctx.daemon })
await runtime.call('list_traffic', {})
trafficPath = ctx.calls.at(-1)?.path ?? ''
params = new URL(`http://localhost${trafficPath}`).searchParams
assertEqual(params.has('deviceId'), false, 'ambiguous list_traffic reads all devices')

let hit = await runtime.call('get_entry', { id: 'flow-1' }) as { entries: unknown[] }
assertEqual(hit.entries.length, 2, 'get_entry returns all flow entries')
await assertRejects(() => runtime.call('get_entry', { id: 'missing' }), 'get_entry missing rejects', 'no entry')

ctx = makeDaemon()
runtime = createMcpRuntime({ daemon: ctx.daemon, appId: 'app', randomId: () => 'rule-1' })
const created = await runtime.call('create_mock', {
  urlPattern: '/new',
  status: 503,
  method: 'POST',
  headers: { 'x-test': '1' },
  body: 'down',
  delayMs: 10,
}) as { deviceId: string; created: { id: string; delayOnly: boolean } }
assertEqual(created.deviceId, 'd1', 'create_mock device')
assertEqual(created.created.id, 'rule-1', 'create_mock id')
assertEqual((ctx.calls.at(-1)?.body as { http: Array<{ delayOnly: boolean }> }).http[0].delayOnly, false, 'create_mock delayOnly')
assertEqual((ctx.calls.at(-1)?.body as { http: unknown[] }).http.length, 2, 'create_mock PUT body')

const defaultIdCreated = await createMcpRuntime({ daemon: makeDaemon().daemon, appId: 'app' }).call('create_mock', {
  urlPattern: '/default-id',
  status: 202,
}) as { created: { id: string } }
assert(defaultIdCreated.created.id.length > 0, 'create_mock default random id')

const updated = await runtime.call('update_mock', { id: 's1', event: 'new', ackPayload: '[1]' }) as { updated: { event: string } }
assertEqual((ctx.calls.at(-1)?.body as { socket: Array<{ event: string }> }).socket[0].event, 'new', 'update_mock updates socket rule')
await assertRejects(() => runtime.call('update_mock', { id: 'missing' }), 'update_mock missing rejects', 'no mock rule')

const deleted = await runtime.call('delete_mock', { id: 'h1' }) as { deleted: string }
assertEqual(deleted.deleted, 'h1', 'delete_mock result')
await assertRejects(() => runtime.call('delete_mock', { id: 'missing' }), 'delete_mock missing rejects', 'no mock rule')

const pushed = await runtime.call('push_event', { event: 'notify', payload: '{}', connectionId: 'c1' }) as { pushed: { connectionId: string } }
assertEqual(pushed.pushed.connectionId, 'c1', 'push_event explicit connection')
const broadcast = await runtime.call('push_event', { event: 'notify', payload: '{}' }) as { pushed: { connectionId: null } }
assertEqual(broadcast.pushed.connectionId, null, 'push_event default connection')

assertEqual((await runtime.call('clear_traffic', { type: 'http' }) as { cleared: string }).cleared, '/api/entries/http', 'clear http')
assertEqual((await runtime.call('clear_traffic', { type: 'socket' }) as { cleared: string }).cleared, '/api/entries/socket', 'clear socket')
assertEqual((await runtime.call('clear_traffic', {}) as { cleared: string }).cleared, '/api/entries', 'clear all')

await assertRejects(
  () => createMcpRuntime({ daemon: makeDaemon().daemon }).call('create_mock', { urlPattern: '/x', status: 500 }),
  'strict multiple devices rejects',
  'multiple devices',
)
await assertRejects(
  () => createMcpRuntime({ daemon: makeDaemon().daemon, appId: 'missing' }).call('create_mock', { urlPattern: '/x', status: 500 }),
  'strict no project device rejects',
  'no connected device',
)
await assertRejects(
  () => createMcpRuntime({ daemon: makeDaemon().daemon }).call('create_mock', { deviceId: 'gone', urlPattern: '/x', status: 500 }),
  'unknown device mocks rejects',
  'unknown deviceId',
)
await assertRejects(() => runtime.call('unknown', {}), 'unknown tool rejects', 'unknown tool')

const originalFetch = globalThis.fetch
try {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    new Response(JSON.stringify({ url: String(input), method: init?.method ?? 'GET' }), { status: 200 })) as typeof fetch
  const fetchRuntime = createMcpRuntime({ base: 'http://daemon' })
  const fetchState = await fetchRuntime.call('get_state', {}) as { url: string; method: string }
  assertEqual(fetchState.url, 'http://daemon/api/state?redact=1', 'default daemon URL')
  assertEqual(fetchState.method, 'GET', 'default daemon method')

  globalThis.fetch = (async () => new Response('bad', { status: 500 })) as typeof fetch
  await assertRejects(() => fetchRuntime.call('get_state', {}), 'default daemon HTTP error rejects', 'HTTP 500')
} finally {
  globalThis.fetch = originalFetch
}

ctx = makeDaemon()
let nextId = 0
runtime = createMcpRuntime({ daemon: ctx.daemon, appId: 'app', randomId: () => `new-${++nextId}` })
await runtime.call('create_mock', { urlPattern: '/pages', queryParams: { page: '2' }, bodyMatch: '{"limit":20}', delayOnly: true, delayMs: 50, starred: true, name: 'Pages' })
let saved = ctx.calls.at(-1)!.body as { http: Array<Record<string, unknown>>; socket: Array<Record<string, unknown>> }
assertEqual((saved.http[0].queryParams as Record<string, string>).page, '2', 'query params saved')
assertEqual(saved.http[0].bodyMatch, '{"limit":20}', 'body condition saved')
assertEqual(saved.http[0].starred, true, 'shared flag saved')
assertEqual(saved.http[1].id, 'h1', 'existing rule retained after new priority rule')
await runtime.call('update_mock', { id: 'new-1', method: null, bodyMatch: null })
saved = ctx.calls.at(-1)!.body as typeof saved
assertEqual(saved.http[0].bodyMatch, null, 'condition can be cleared')
assertEqual((saved.http[0].queryParams as Record<string, string>).page, '2', 'unmentioned condition survives update')
await runtime.call('create_mock', { type: 'socket', event: 'pages', transport: 'socketio', payloadMatch: '{"page":2}', pushEvent: 'pages:result', pushPayload: '[{"items":[]}]' })
saved = ctx.calls.at(-1)!.body as typeof saved
assertEqual(saved.socket[0].payloadMatch, '{"page":2}', 'socket condition saved')
assertEqual(saved.socket[0].pushEvent, 'pages:result', 'event reply saved')
assertEqual(saved.socket[1].id, 's1', 'existing socket rules survive')
await runtime.call('create_mock', { type: 'socket', transport: 'ktor-ws', event: 'request', ackPayload: 'reply' })
assertEqual((ctx.calls.at(-1)!.body as typeof saved).socket[0].transport, 'ktor-ws', 'Ktor WS mock supported')
await runtime.call('list_traffic', { type: 'firebase', event: 'screen_view', userId: 'user-7', bodyContains: 'screen' })
params = new URL(ctx.calls.at(-1)!.path, 'http://daemon').searchParams
assertEqual(params.get('type'), 'firebase', 'Analytics query')
assertEqual(params.get('event'), 'screen_view', 'Analytics name query')
assertEqual(params.get('userId'), 'user-7', 'captured user identity query')
assertEqual((await runtime.call('clear_traffic', { type: 'firebase' }) as { cleared: string }).cleared, '/api/entries/firebase', 'clear Firebase only')
await runtime.call('set_breakpoints', { rules: [{ id: 'b1', urlPattern: '/pages', phase: 'response' }] })
assertEqual(ctx.calls.at(-1)!.path, '/api/breakpoints', 'breakpoint rules route')
await runtime.call('resolve_breakpoint', { id: 'paused', action: 'resume', status: 201, body: 'edited' })
assertEqual((ctx.calls.at(-1)!.body as { body: string }).body, 'edited', 'paused response edits')
await assertRejects(() => runtime.call('resolve_breakpoint', { id: 'missing', action: 'abort' }), 'unknown paused hit', 'No matching')
for (const [name, args] of [
  ['clear_traffic', { type: 'typo' }],
  ['clear_traffic', { deviceId: 'd1' }],
  ['list_traffic', { limit: -1 }],
  ['create_mock', { urlPattern: '/x', headers: { a: 123 } }],
  ['create_mock', { urlPattern: '/x', queryParams: { ' ': 'x' } }],
  ['create_mock', { urlPattern: '/x', bodyMatch: '[]' }],
  ['create_mock', { type: 'socket', event: 'x', payloadMatch: 'oops' }],
  ['create_mock', { type: 'socket', event: 'x', urlPattern: '/wrong' }],
  ['update_mock', { id: 'h1', event: 'wrong-kind' }],
  ['resolve_breakpoint', { id: 'paused', action: 'typo' }],
  ['set_breakpoints', { rules: [{ id: 'b1', urlPattern: '/' }, { id: 'b1', urlPattern: '/' }] }],
] as const) {
  const writes = ctx.calls.filter(c => c.init?.method).length
  let rejected = false
  try { await runtime.call(name, args) } catch { rejected = true }
  assert(rejected, `${name} invalid arguments rejected`)
  assertEqual(ctx.calls.filter(c => c.init?.method).length, writes, 'invalid input must not mutate daemon')
}
await runtime.call('get_entry', { deviceId: 'd1', id: 'flow-1' })
assertEqual(new URL(ctx.calls.at(-1)!.path, 'http://daemon').searchParams.get('id'), 'flow-1', 'entry ID filtered at daemon')
const scoped = createMcpRuntime({ daemon: ctx.daemon, appId: 'missing' })
await scoped.call('list_traffic', {})
assertEqual(new URL(ctx.calls.at(-1)!.path, 'http://daemon').searchParams.get('appId'), 'missing', 'missing app scope does not read other apps')
await Promise.all([
  runtime.call('create_mock', { urlPattern: '/concurrent-a' }),
  runtime.call('create_mock', { urlPattern: '/concurrent-b' }),
])
saved = ctx.calls.at(-1)!.body as typeof saved
assert(saved.http.some(r => r.urlPattern === '/concurrent-a') && saved.http.some(r => r.urlPattern === '/concurrent-b'), 'concurrent MCP mock edits retained')
console.log('mcpCore.test: all assertions passed')
