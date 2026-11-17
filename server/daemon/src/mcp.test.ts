import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { handleApi } from './api.js'
import { createEntryStore } from './entryStore.js'
import { createMockSync } from './mockSync.js'
import { normalizeMocks, type MockStore } from './mockStore.js'

const sync = createMockSync()
const exercised = new Set<string>()
const entryStore = createEntryStore(() => {})
entryStore.pushEntry('d1', { type: 'http-request', id: 'h1', timestamp: Date.now(), method: 'GET', url: 'https://host/orders', headers: { Authorization: 'Bearer hidden' } })
entryStore.pushEntry('d1', { type: 'http-response', id: 'h1', timestamp: Date.now(), status: 503, body: 'failed' })
let store: MockStore = { devices: { d1: { http: [], socket: [] } }, shared: {} }
let breakpoints: unknown[] = []
const hits = new Map([['h1', { deviceId: 'd1', hit: { id: 'h1', status: 503, body: 'failed' } }]])
const sent: Array<Record<string, unknown>> = []
const devices = new Map([['d1', {
  info: { deviceId: 'd1', appId: 'test', capabilities: [] as string[] }, connected: true,
  ws: { send: (text: string) => { sent.push(JSON.parse(text)) }, close: () => {} },
}]])
const daemon = createServer((req, res) => {
  void handleApi(req, res, new URL(req.url!, 'http://localhost'), {
    devices, entryStore, mockSync: sync,
    getMockStore: () => store, setMockStore: next => { store = next }, persistMocks: () => {},
    broadcastToUi: () => {}, sendMocksToDevice: id => { sync.sent(id, normalizeMocks(store.devices[id])) },
    mocksFor: id => ({ http: [...(store.shared.test?.http ?? []), ...normalizeMocks(store.devices[id]).http], socket: [...(store.shared.test?.socket ?? []), ...normalizeMocks(store.devices[id]).socket] }), mergedMocksByDevice: () => Object.fromEntries(Object.entries(store.devices).map(([id, own]) => [id, { http: [...(store.shared.test?.http ?? []), ...own.http], socket: [...(store.shared.test?.socket ?? []), ...own.socket] }])),
    removeDeviceRecord: () => ({ removed: false, mocksChanged: false }),
    getBreakpoints: () => ({ d1: breakpoints }), getPendingHits: () => [...hits.values()],
    setBreakpoints: (_id, rules) => { breakpoints = rules }, sendBreakpointsToDevice: () => {},
    resolvePendingHit: id => { hits.delete(id) }, releasePendingHits: () => { hits.clear() },
  }).catch(error => { res.writeHead(500); res.end(String(error)) })
})
await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve))
const address = daemon.address()
assert(address && typeof address === 'object')
// Real stdio process and real HTTP API, without launching adb/usbmux or touching local user data.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--input-type=module', '-e', `import { runMcp } from ${JSON.stringify(new URL('./mcp.js', import.meta.url).href)}; await runMcp()`],
  env: { SNIFFER_HOST: '127.0.0.1', SNIFFER_PORT: String(address.port) }, stderr: 'pipe',
})
const client = new Client({ name: 'sniffer-test', version: '1' })
let stderr = ''
transport.stderr?.on('data', data => { stderr += String(data) })
async function call(name: string, args: Record<string, unknown>) {
  exercised.add(name)
  const result = await client.callTool({ name, arguments: args })
  assert(!result.isError, JSON.stringify(result))
  const content = result.content as Array<{ type: string; text: string }>
  return JSON.parse(content[0].text)
}
try {
  await client.connect(transport)
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 19)
  assert.equal(listed.tools.find(t => t.name === 'get_state')?.annotations?.readOnlyHint, true)
  const flow = await call('list_traffic', { type: 'http', method: 'GET', status: 503, urlContains: '/orders' })
  assert.equal(flow.entries.length, 2)
  assert.equal(flow.entries[0].message.headers.Authorization, '‹redacted›')
  assert.equal((await call('get_entry', { id: 'h1' })).entries.length, 2)
  const created = await call('create_mock', { urlPattern: '/orders', queryParams: { page: '2' }, bodyMatch: '{"limit":20}', delayOnly: true, delayMs: 50 })
  await call('update_mock', { id: created.created.id, bodyMatch: null })
  assert.equal((store.devices.d1.http[0] as Record<string, unknown>).bodyMatch, null)
  await call('create_mock', { type: 'socket', event: 'get', payloadMatch: '{"page":2}', pushEvent: 'result', pushPayload: '[1]' })
  assert.equal((store.devices.d1.socket[0] as Record<string, unknown>).pushEvent, 'result')
  const source = await call('create_mock', { urlPattern: '/comments', body: '{"data":{"commentCount":0},"token":"secret"}', queryParams: { page: '2' } })
  const copied = await call('copy_mock_with_fields', { id: source.created.id, replacements: [{ path: '/data/commentCount', value: 36 }] })
  const copy = store.devices.d1.http.find(r => (r as { id: string }).id === copied.created.id) as Record<string, unknown>
  assert.equal(JSON.parse(String(copy.body)).data.commentCount, 36)
  assert.equal(copy.enabled, false)
  assert.equal(copy.starred, false)
  assert.deepEqual(copy.queryParams, { page: '2' })
  assert(!JSON.stringify(copied).includes('secret'))
  const beforeInvalid = JSON.stringify(store)
  const invalidCopy = await client.callTool({ name: 'copy_mock_with_fields', arguments: { id: source.created.id, replacements: [{ path: '/data/missing', value: 1 }] } })
  assert.equal(invalidCopy.isError, true)
  assert.equal(JSON.stringify(store), beforeInvalid)
  const scenario = await call('save_scenario', { name: 'Comments', appId: 'test', rules: [
    { urlPattern: '/characters/{{characterId}}/comments', body: '{"count":"{{count}}","label":"{{label}}"}' },
    { type: 'socket', event: 'comments', ackPayload: '[{"count":"{{count}}"}]' },
  ] })
  assert.deepEqual(scenario.parameters, ['characterId', 'count', 'label'])
  assert.equal((await call('list_scenarios', {})).scenarios[0].ruleCount, 2)
  assert.equal((await call('list_scenarios', { appId: 'other' })).scenarios.length, 0)
  const existingIds = store.devices.d1.http.map(r => (r as { id: string }).id)
  const applied = await call('apply_scenario', { id: scenario.id, parameters: { characterId: '194', count: 36, label: 'a"b' } })
  assert.equal(applied.ruleIds.length, 2)
  const scenarioHttp = store.devices.d1.http[0] as Record<string, unknown>
  assert.equal(scenarioHttp.urlPattern, '/characters/194/comments')
  assert.deepEqual(JSON.parse(String(scenarioHttp.body)), { count: 36, label: 'a"b' })
  assert.equal(scenarioHttp.starred, false)
  assert(existingIds.every(id => store.devices.d1.http.some(r => (r as { id: string }).id === id)))
  const beforeBadScenario = JSON.stringify(store)
  for (const parameters of [{ characterId: '../other', count: 1, label: 'x' }, { characterId: '194' }]) {
    assert.equal((await client.callTool({ name: 'apply_scenario', arguments: { id: scenario.id, parameters } })).isError, true)
    assert.equal(JSON.stringify(store), beforeBadScenario)
  }
  await call('update_mock', { id: copied.created.id, name: 'Retained metadata' })
  assert.equal((await call('list_scenarios', {})).scenarios.length, 1)
  const sequential = await call('create_mock', { urlPattern: '/sequence', sequence: {
    steps: [{ status: 503, body: 'first' }, { status: 200, body: 'second' }], onExhausted: 'stop', resetToken: '' } })
  await call('update_mock', { id: sequential.created.id, sequence: {
    steps: [{ status: 503 }, { status: 200 }], onExhausted: 'last', resetToken: 'reset' } })
  assert.equal((store.devices.d1.http.find(r => (r as any).id === sequential.created.id) as any).sequence.resetToken, 'reset')
  assert.equal((await client.callTool({ name: 'update_mock', arguments: { id: sequential.created.id, delayOnly: true } })).isError, true)
  for (const sequence of [{ steps: [] }, { steps: [{ delayMs: -1 }] }, { steps: [{}], onExhausted: 'invalid' }]) {
    assert.equal((await client.callTool({ name: 'create_mock', arguments: { urlPattern: '/bad', sequence } })).isError, true)
  }
  await call('delete_mock', { id: sequential.created.id })
  const stream = await call('create_mock', { urlPattern: '/events', sse: {
    events: [{ data: 'first', delayMs: 100 }, { event: 'done', data: 'second', id: '2', retry: 1000, delayMs: 200 }], ending: 'open' } })
  assert.equal((store.devices.d1.http.find(r => (r as any).id === stream.created.id) as any).sse.events.length, 2)
  for (const patch of [{ status: 500 }, { delayOnly: true }, { sequence: { steps: [{}] } }, { sse: { events: [{ id: 'bad\nid' }] } }]) {
    assert.equal((await client.callTool({ name: 'update_mock', arguments: { id: stream.created.id, ...patch } })).isError, true)
  }
  await call('update_mock', { id: stream.created.id, sse: null })
  await call('delete_mock', { id: stream.created.id })
  await call('push_event', { event: 'preview', payload: '["hello"]' })
  assert.equal(sent.at(-1)?.type, 'push-event')
  assert.equal(sent.at(-1)?.event, 'preview')
  const nested = await call('save_scenario', { name: 'Timed templates', appId: 'test', rules: [
    { urlPattern: '/nested', sequence: { steps: [{ body: '{"label":"{{label}}"}' }] } },
    { urlPattern: '/stream-template', sse: { events: [{ data: '{"label":"{{label}}"}' }] } },
  ] })
  const nestedRun = await call('start_run', { scenarioId: nested.id, parameters: { label: 'quote"value' } })
  const nestedRules = store.devices.d1.http as Array<Record<string, any>>
  assert.equal(JSON.parse(nestedRules.find(r => r.urlPattern === '/nested')!.sequence.steps[0].body).label, 'quote"value')
  assert.equal(JSON.parse(nestedRules.find(r => r.urlPattern === '/stream-template')!.sse.events[0].data).label, 'quote"value')
  await call('end_run', { runId: nestedRun.run.id })
  await call('delete_scenario', { id: nested.id })
  const runOne = await call('start_run', { scenarioId: scenario.id, parameters: { characterId: '194', count: 0, label: 'empty' } })
  const runTwo = await call('start_run', { name: 'Independent run' })
  const runTwoRule = await call('create_mock', { runId: runTwo.run.id, urlPattern: '/other-run' })
  assert.equal((await call('list_runs', {})).runs.length, 3)
  assert.equal((await call('get_run_status', { runId: runOne.run.id })).supported, false)
  devices.get('d1')!.info.capabilities = ['mock-observability', 'http-sequences', 'http-sse-mocks']
  assert.equal((await call('get_run_status', { runId: runOne.run.id })).ready, false)
  const revision = sync.status('d1', runOne.run.ruleIds, false).revision!
  sync.receive('d1', { type: 'mock-rules-applied', revision: 'stale' })
  assert.equal((await call('get_run_status', { runId: runOne.run.id })).ready, false)
  sync.receive('d1', { type: 'mock-rules-applied', revision })
  sync.receive('d1', { type: 'mock-hit', revision, ruleId: runOne.run.ruleIds[0], stepIndex: 1 })
  const observed = await call('get_run_status', { runId: runOne.run.id, waitMs: 50 })
  assert.equal(observed.ready, true)
  assert.equal(observed.hits[0].stepIndex, 1)
  assert.equal((await call('end_run', { runId: runOne.run.id })).removed, 2)
  assert(store.devices.d1.http.some(r => (r as { id: string }).id === runTwoRule.created.id))
  assert(store.devices.d1.http.some(r => (r as { id: string }).id === source.created.id))
  assert.equal((await call('end_run', { runId: runOne.run.id })).removed, 0)
  await call('update_mock', { id: runTwoRule.created.id, starred: true })
  assert.equal((await client.callTool({ name: 'end_run', arguments: { runId: runTwo.run.id } })).isError, true)
  assert(store.shared.test.http.some(r => (r as { id: string }).id === runTwoRule.created.id))
  await call('update_mock', { id: runTwoRule.created.id, starred: false })
  devices.get('d1')!.connected = false
  assert.equal((await call('end_run', { runId: runTwo.run.id })).status, 'cleanup-pending-device')
  devices.get('d1')!.connected = true
  await call('delete_scenario', { id: scenario.id })
  assert.equal((await call('list_scenarios', {})).scenarios.length, 0)
  assert(store.devices.d1.http.some(r => (r as { id: string }).id === applied.ruleIds[0]))
  await call('set_breakpoints', { rules: [{ id: 'b1', urlPattern: '/orders' }] })
  assert.equal((await call('get_state', {})).breakpointsByDevice.d1.length, 1)
  await call('resolve_breakpoint', { id: 'h1', action: 'resume', status: 200, body: 'edited' })
  assert.equal(sent.at(-1)?.type, 'breakpoint-resolve')
  assert.equal(sent.at(-1)?.body, 'edited')
  assert.equal(hits.size, 0)
  const bad = await client.callTool({ name: 'clear_traffic', arguments: { type: 'typo' } })
  assert.equal(bad.isError, true)
  assert.equal(entryStore.snapshot().length, 2)
  await call('clear_traffic', { type: 'socket' })
  assert.equal(entryStore.snapshot().length, 2)
  assert.deepEqual([...exercised].sort(), listed.tools.map(t => t.name).sort(), 'every advertised MCP tool exercised over stdio')
  assert.equal(stderr, '')
} finally {
  await client.close()
  daemon.closeAllConnections()
  await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve()))
}
console.log('mcp.test: stdio and daemon integration passed')
