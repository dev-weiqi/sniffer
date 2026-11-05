import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { handleApi } from './api.js'
import { createEntryStore } from './entryStore.js'
import { normalizeMocks, type MockStore } from './mockStore.js'

const entryStore = createEntryStore(() => {})
entryStore.pushEntry('d1', { type: 'firebase-analytics-event', id: 'a1', timestamp: Date.now(), name: 'screen_view', userId: 'user-7', params: { screen: 'home', token: 'private' }, firebaseSdkCalled: true })
entryStore.pushEntry('d1', { type: 'http-request', id: 'h1', timestamp: Date.now(), method: 'GET', url: 'https://host/orders', headers: { Authorization: 'Bearer hidden' } })
entryStore.pushEntry('d1', { type: 'http-response', id: 'h1', timestamp: Date.now(), status: 503, body: 'failed' })
let store: MockStore = { devices: { d1: { http: [], socket: [] } }, shared: {} }
let breakpoints: unknown[] = []
const hits = new Map([['h1', { deviceId: 'd1', hit: { id: 'h1', status: 503, body: 'failed' } }]])
const sent: Array<Record<string, unknown>> = []
const devices = new Map([['d1', {
  info: { deviceId: 'd1', appId: 'test' }, connected: true,
  ws: { send: (text: string) => { sent.push(JSON.parse(text)) }, close: () => {} },
}]])
const daemon = createServer((req, res) => {
  void handleApi(req, res, new URL(req.url!, 'http://localhost'), {
    devices, entryStore,
    getMockStore: () => store, setMockStore: next => { store = next }, persistMocks: () => {},
    broadcastToUi: () => {}, sendMocksToDevice: () => {},
    mocksFor: id => normalizeMocks(store.devices[id]), mergedMocksByDevice: () => store.devices,
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
  const result = await client.callTool({ name, arguments: args })
  assert(!result.isError, JSON.stringify(result))
  const content = result.content as Array<{ type: string; text: string }>
  return JSON.parse(content[0].text)
}
try {
  await client.connect(transport)
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 10)
  assert.equal(listed.tools.find(t => t.name === 'get_state')?.annotations?.readOnlyHint, true)
  const analytics = await call('list_traffic', { type: 'firebase', event: 'screen_view', userId: 'user-7' })
  assert.equal(analytics.entries[0].message.params.token, '‹redacted›')
  assert.equal(analytics.entries[0].message.firebaseSdkCalled, true)
  const flow = await call('list_traffic', { type: 'http', method: 'GET', status: 503, urlContains: '/orders' })
  assert.equal(flow.entries.length, 2)
  assert.equal(flow.entries[0].message.headers.Authorization, '‹redacted›')
  assert.equal((await call('get_entry', { id: 'h1' })).entries.length, 2)
  const created = await call('create_mock', { urlPattern: '/orders', queryParams: { page: '2' }, bodyMatch: '{"limit":20}', delayOnly: true, delayMs: 50 })
  await call('update_mock', { id: created.created.id, bodyMatch: null })
  assert.equal((store.devices.d1.http[0] as Record<string, unknown>).bodyMatch, null)
  await call('create_mock', { type: 'socket', event: 'get', payloadMatch: '{"page":2}', pushEvent: 'result', pushPayload: '[1]' })
  assert.equal((store.devices.d1.socket[0] as Record<string, unknown>).pushEvent, 'result')
  await call('set_breakpoints', { rules: [{ id: 'b1', urlPattern: '/orders' }] })
  assert.equal((await call('get_state', {})).breakpointsByDevice.d1.length, 1)
  await call('resolve_breakpoint', { id: 'h1', action: 'resume', status: 200, body: 'edited' })
  assert.equal(sent.at(-1)?.type, 'breakpoint-resolve')
  assert.equal(sent.at(-1)?.body, 'edited')
  assert.equal(hits.size, 0)
  const bad = await client.callTool({ name: 'clear_traffic', arguments: { type: 'typo' } })
  assert.equal(bad.isError, true)
  assert.equal(entryStore.snapshot().length, 3)
  await call('clear_traffic', { type: 'firebase' })
  assert.equal(entryStore.snapshot().length, 2)
  assert.equal(stderr, '')
} finally {
  await client.close()
  daemon.closeAllConnections()
  await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve()))
}
console.log('mcp.test: stdio and daemon integration passed')
