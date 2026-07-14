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
    if (path.startsWith('/api/entries')) return init?.method === 'DELETE' ? { ok: true, cleared: path } : { entries }
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
assertEqual(created.created.delayOnly, false, 'create_mock delayOnly')
assertEqual((ctx.calls.at(-1)?.body as { http: unknown[] }).http.length, 2, 'create_mock PUT body')

const defaultIdCreated = await createMcpRuntime({ daemon: makeDaemon().daemon, appId: 'app' }).call('create_mock', {
  urlPattern: '/default-id',
  status: 202,
}) as { created: { id: string } }
assert(defaultIdCreated.created.id.length > 0, 'create_mock default random id')

const updated = await runtime.call('update_mock', { id: 's1', event: 'new', ackPayload: '[1]' }) as { updated: { event: string } }
assertEqual(updated.updated.event, 'new', 'update_mock updates socket rule')
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
  assertEqual(fetchState.url, 'http://daemon/api/state', 'default daemon URL')
  assertEqual(fetchState.method, 'GET', 'default daemon method')

  globalThis.fetch = (async () => new Response('bad', { status: 500 })) as typeof fetch
  await assertRejects(() => fetchRuntime.call('get_state', {}), 'default daemon HTTP error rejects', 'HTTP 500')
} finally {
  globalThis.fetch = originalFetch
}

console.log('mcpCore.test: all assertions passed')
