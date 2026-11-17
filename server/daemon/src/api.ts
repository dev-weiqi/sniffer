import type { createMockSync } from './mockSync.js'
import { randomUUID } from 'node:crypto'
import { buildMock } from './mcpCore.js'
import { scenarioParameters, instantiateScenario, withScenarioMocks } from './scenarios.js'
import { replaceJsonFields } from './replaceJsonFields.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { redact } from './redact.js'
import type { Entry } from './entryStore.js'
import { json, readBody } from './http.js'
import { isStarred, normalizeMocks, type MockStore, type Mocks } from './mockStore.js'

const HTTP_ENTRY_TYPES = new Set(['http-request', 'http-response'])
const SOCKET_ENTRY_TYPES = new Set(['socket-status', 'socket-event', 'socket-ack'])
interface ApiDevice {
  info: {
    deviceId: string
    appId: string
    capabilities?: string[]
  }
  connected: boolean
  ws: {
    send(text: string): void
    close(): void
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  mockSync?: ReturnType<typeof createMockSync>
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
  getBreakpoints(): Record<string, unknown[]>
  getPendingHits(): Array<{ deviceId: string; hit: Record<string, unknown> }>
  setBreakpoints(deviceId: string, rules: unknown[]): void
  sendBreakpointsToDevice(deviceId: string): void
  resolvePendingHit(id: string): void
  releasePendingHits(): void
}) {
  const commit = (next: MockStore) => {
    const previous = deps.getMockStore()
    deps.setMockStore(next)
    try { deps.persistMocks() } catch (error) { deps.setMockStore(previous); throw error }
  }
  const sync = (deviceId: string) => {
    deps.sendMocksToDevice(deviceId)
    deps.broadcastToUi({ type: 'mocks-changed', deviceId, mocks: deps.mocksFor(deviceId) })
  }
  if (url.pathname === '/api/runs/status' && req.method === 'GET') {
    const run = deps.getMockStore().runs?.find(r => r.id === url.searchParams.get('runId'))
    if (!run) return json(res, 404, { error: 'Run not found' })
    const device = deps.devices.get(run.deviceId)
    const supported = !!device?.info.capabilities?.includes('mock-observability')
    const status = deps.mockSync?.status(run.deviceId, run.ruleIds, !!run.endedAt)
    return json(res, 200, { runId: run.id, ended: !!run.endedAt, connected: !!device?.connected, supported,
      ...status, ready: supported && !!device?.connected && !!status?.ready,
      meaning: run.endedAt ? 'Device acknowledged removal' : 'Device acknowledged current rules; hits indicate matching, not UI success' })
  }
  if (url.pathname === '/api/runs' && req.method === 'GET') {
    return json(res, 200, { runs: (deps.getMockStore().runs ?? []).filter(run =>
      (!url.searchParams.has('deviceId') || run.deviceId === url.searchParams.get('deviceId')) &&
      (!url.searchParams.has('appId') || run.appId === url.searchParams.get('appId'))) })
  }
  if (url.pathname === '/api/runs' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const device = deps.devices.get(body.deviceId)
      if (!device?.connected) throw new Error('Connected device required')
      const store = deps.getMockStore()
      let mocks: Mocks = { http: [], socket: [] }
      if (body.scenarioId !== undefined) {
        const scenario = store.scenarios?.find(s => s.id === body.scenarioId && s.appId === device.info.appId)
        if (!scenario) throw new Error('Scenario not found for this app')
        mocks = instantiateScenario(scenario, body.parameters ?? {}, buildMock)
      } else if (body.parameters && Object.keys(body.parameters).length) throw new Error('parameters require scenarioId')
      if (body.name !== undefined && typeof body.name !== 'string') throw new Error('name must be a string')
      const run = { id: randomUUID(), deviceId: body.deviceId, appId: device.info.appId, name: body.name ?? '',
        startedAt: Date.now(), ruleIds: [...mocks.http, ...mocks.socket].map(r => (r as { id: string }).id) }
      commit({ ...withScenarioMocks(store, body.deviceId, mocks), runs: [...(store.runs ?? []), run] })
      sync(body.deviceId)
      return json(res, 200, { run, status: 'sent' })
    } catch (error) { return json(res, 400, { error: String(error) }) }
  }
  if (url.pathname === '/api/runs/rules' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const store = deps.getMockStore()
      const run = store.runs?.find(r => r.id === body.runId && !r.endedAt)
      if (!run || (body.deviceId !== undefined && body.deviceId !== run.deviceId)) throw new Error('Active run for this device required')
      if (deps.devices.get(run.deviceId)?.info.appId !== run.appId) throw new Error('Run device appId changed')
      const rule = { ...buildMock(body.fields), id: randomUUID(), starred: false, createdAt: Date.now() }
      const mocks = { http: body.fields.type === 'socket' ? [] : [rule], socket: body.fields.type === 'socket' ? [rule] : [] }
      commit({ ...withScenarioMocks(store, run.deviceId, mocks),
        runs: store.runs!.map(r => r.id === run.id ? { ...r, ruleIds: [...r.ruleIds, rule.id] } : r) })
      sync(run.deviceId)
      return json(res, 200, { deviceId: run.deviceId, runId: run.id, created: { id: rule.id } })
    } catch (error) { return json(res, 400, { error: String(error) }) }
  }
  if (url.pathname === '/api/runs/end' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const store = deps.getMockStore()
      const run = store.runs?.find(r => r.id === body.runId)
      if (!run) throw new Error('Run not found')
      const owned = new Set(run.ruleIds)
      if (Object.values(store.shared).some(m => [...m.http, ...m.socket].some(r => owned.has((r as { id: string }).id))))
        throw new Error('Run rules were shared; unshare them before cleanup to avoid affecting other devices')
      const current = store.devices[run.deviceId] ?? { http: [], socket: [] }
      const keep = (rules: unknown[]) => rules.filter(r => !owned.has((r as { id: string }).id))
      const remaining = { http: keep(current.http), socket: keep(current.socket) }
      commit({ ...store, devices: { ...store.devices, [run.deviceId]: remaining },
        runs: store.runs!.map(r => r.id === run.id ? { ...r, endedAt: r.endedAt ?? Date.now() } : r) })
      sync(run.deviceId)
      return json(res, 200, { runId: run.id, removed: current.http.length + current.socket.length - remaining.http.length - remaining.socket.length,
        status: deps.devices.get(run.deviceId)?.connected ? 'cleanup-sent' : 'cleanup-pending-device' })
    } catch (error) { return json(res, 400, { error: String(error) }) }
  }
  if (url.pathname === '/api/scenarios' && req.method === 'GET') {
    const scenarios = deps.getMockStore().scenarios ?? []
    return json(res, 200, { scenarios: scenarios.filter(s => !url.searchParams.has('appId') || s.appId === url.searchParams.get('appId'))
      .map(({ rules, ...metadata }) => ({ ...metadata, ruleCount: rules.length })) })
  }
  if (url.pathname === '/api/scenarios' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      if (!body || typeof body.name !== 'string' || !body.name.trim() || typeof body.appId !== 'string' || !body.appId.trim() ||
        !Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 100) throw new Error('name, appId and 1 to 100 rules required')
      body.rules.forEach((rule: Record<string, unknown>) => buildMock(rule))
      const store = deps.getMockStore()
      const scenarios = store.scenarios ?? []
      if (body.id !== undefined && (typeof body.id !== 'string' || !scenarios.some(s => s.id === body.id && s.appId === body.appId)))
        throw new Error('Scenario to update not found for this app')
      const scenario = { id: body.id ?? randomUUID(), name: body.name, appId: body.appId,
        rules: body.rules, parameters: scenarioParameters(body.rules) }
      commit({ ...store, scenarios: [...scenarios.filter(s => s.id !== scenario.id), scenario] })
      return json(res, 200, { id: scenario.id, parameters: scenario.parameters })
    } catch (error) { return json(res, 400, { error: String(error) }) }
  }
  if (url.pathname.startsWith('/api/scenarios/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/scenarios/'.length))
    const store = deps.getMockStore()
    if (!store.scenarios?.some(s => s.id === id)) return json(res, 404, { error: 'Scenario not found' })
    commit({ ...store, scenarios: store.scenarios.filter(s => s.id !== id) })
    return json(res, 200, { deleted: id })
  }
  if (url.pathname === '/api/scenarios/apply' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req))
      const device = deps.devices.get(body.deviceId)
      const scenario = deps.getMockStore().scenarios?.find(s => s.id === body.id)
      if (!device?.connected || !scenario || device.info.appId !== scenario.appId) throw new Error('Connected device must match the scenario appId')
      const mocks = instantiateScenario(scenario, body.parameters, buildMock)
      commit(withScenarioMocks(deps.getMockStore(), body.deviceId, mocks))
      sync(body.deviceId)
      return json(res, 200, { deviceId: body.deviceId, scenarioId: scenario.id,
        ruleIds: [...mocks.http, ...mocks.socket].map(r => (r as { id: string }).id), status: 'sent' })
    } catch (error) { return json(res, 400, { error: String(error) }) }
  }
  if (req.method === 'POST' && url.pathname === '/api/mock-body/replace-fields') {
    try {
      const body = JSON.parse(await readBody(req))
      return json(res, 200, replaceJsonFields(body.body, body.replacements))
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Invalid field replacements' })
    }
  }
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
        ...mockStore,
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
    if (params.has('type') && !['http', 'socket'].includes(params.get('type')!))
      return json(res, 400, { error: 'type must be http or socket' })
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
    : params.get('type') === 'socket' ? SOCKET_ENTRY_TYPES : null
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
