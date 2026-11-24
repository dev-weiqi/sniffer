import type { Scenario } from './scenarios.js'
import { readFileSync } from 'node:fs'

export interface Mocks {
  http: unknown[]
  socket: unknown[]
}

export interface VerificationRun {
  id: string
  deviceId: string
  appId: string
  name: string
  startedAt: number
  endedAt?: number
  ruleIds: string[]
}

export interface MockStore {
  runs?: VerificationRun[]
  scenarios?: Scenario[]
  devices: Record<string, Mocks>
  shared: Record<string, Mocks>
}

export const EMPTY_MOCKS: Mocks = { http: [], socket: [] }

export function normalizeMocks(value: unknown): Mocks {
  const m = value as Partial<Mocks> | null | undefined
  return {
    http: Array.isArray(m?.http) ? m.http : [],
    socket: Array.isArray(m?.socket) ? m.socket : [],
  }
}

export const isStarred = (r: unknown) => (r as { starred?: unknown } | null)?.starred === true

export function mergeMocks(own: Mocks, shared: Mocks): Mocks {
  if (shared.http.length + shared.socket.length === 0) return own
  return { http: [...shared.http, ...own.http], socket: [...shared.socket, ...own.socket] }
}

export function validSequence(rule: Record<string, unknown>): boolean {
  if (!rule || typeof rule !== 'object') return false
  const s = rule.sequence as Record<string, unknown> | null | undefined
  if (s == null) return true
  if (typeof s !== 'object' || Array.isArray(s) || rule.delayOnly === true ||
    !Array.isArray(s.steps) || s.steps.length < 1 || s.steps.length > 100 ||
    (s.onExhausted !== undefined && !['last', 'loop', 'stop'].includes(String(s.onExhausted))) ||
    (s.resetToken !== undefined && typeof s.resetToken !== 'string')) return false
  return s.steps.every(step => step && typeof step === 'object' && !Array.isArray(step) &&
    (step.status === undefined || (Number.isInteger(step.status) && step.status >= 100 && step.status <= 599)) &&
    (step.delayMs === undefined || (Number.isInteger(step.delayMs) && step.delayMs >= 0 && step.delayMs <= 300000)) &&
    (step.body === undefined || typeof step.body === 'string') &&
    (step.headers === undefined || (step.headers && typeof step.headers === 'object' && !Array.isArray(step.headers) && Object.values(step.headers).every(v => typeof v === 'string'))))
}

export function validSse(rule: Record<string, unknown>): boolean {
  if (!rule || typeof rule !== 'object') return false
  const stream = rule.sse as Record<string, unknown> | null | undefined
  if (stream == null) return true
  if (typeof stream !== 'object' || Array.isArray(stream) || rule.sequence != null || rule.delayOnly === true ||
    (rule.status != null && rule.status !== 200) ||
    (stream.ending !== undefined && !['close', 'open', 'disconnect'].includes(String(stream.ending))) ||
    !Array.isArray(stream.events) || stream.events.length < 1 || stream.events.length > 1000) return false
  return stream.events.every(e => e && typeof e === 'object' && !Array.isArray(e) &&
    (e.data === undefined || (typeof e.data === 'string' && e.data.length <= 524288)) &&
    [e.event, e.id].every(v => v === undefined || (typeof v === 'string' && v.length <= 1024 && !/[\r\n\u0000]/.test(v))) &&
    [e.retry, e.delayMs].every(v => v === undefined || (Number.isInteger(v) && v >= 0 && v <= 300000)))
}

export function stripUiOnlyFields(mocks: Mocks, capabilities: string[] = []): Mocks {
  const strip = (rules: unknown[]) => rules.map(r => {
    const { starred: _, ...rest } = r as Record<string, unknown>
    return rest
  })
  const supportsCondition = (condition: unknown, capability: string): boolean => {
    if (condition == null) return true
    if (typeof condition !== 'string') return false
    if (!condition.trim()) return true
    try {
      const expected = JSON.parse(condition)
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false
      return Object.keys(expected).length === 0 || capabilities.includes(capability)
    } catch { return false }
  }
  const http = mocks.http.filter(r => {
    const rule = r as { urlPattern?: string; queryParams?: unknown; bodyMatch?: unknown; sequence?: unknown; sse?: unknown; delayOnly?: unknown } | null
    if (rule?.sse != null && (!capabilities.includes('http-sse-mocks') || !validSse(rule))) return false
    if (rule?.sequence != null && (!capabilities.includes('http-sequences') || !validSequence(rule))) return false
    if (!supportsCondition(rule?.bodyMatch, 'http-body-mocks')) return false
    if (typeof rule?.urlPattern === 'string' && rule.urlPattern.split('/').some(part => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(part)) &&
        !capabilities.includes('http-path-templates')) return false
    const query = rule?.queryParams
    if (query === undefined) return true
    if (!query || typeof query !== 'object' || Array.isArray(query)) return false
    const entries = Object.entries(query)
    if (entries.some(([key, value]) => !key.trim() || typeof value !== 'string')) return false
    // Older SDKs ignore unknown fields; never turn a conditional mock into a path-only mock.
    return entries.length === 0 || capabilities.includes('http-query-mocks')
  })
  const socket = mocks.socket.filter(r => supportsCondition(
    (r as { payloadMatch?: unknown } | null)?.payloadMatch, 'socket-payload-mocks',
  ))
  return { http: strip(http), socket: strip(socket) }
}

export function migrateStarredToSharedStore(
  store: MockStore,
  deviceId: string,
  appId: string,
): { changed: boolean; store: MockStore } {
  const own = store.devices[deviceId]
  if (!own || !(own.http.some(isStarred) || own.socket.some(isStarred))) return { changed: false, store }
  const shared = store.shared[appId] ?? EMPTY_MOCKS
  const fresh = (rules: unknown[], into: unknown[]) =>
    rules.filter(isStarred).filter(r => !into.some(x => (x as { id?: unknown }).id === (r as { id?: unknown }).id))
  return {
    changed: true,
    store: {
      ...store,
      devices: {
        ...store.devices,
        [deviceId]: { http: own.http.filter(r => !isStarred(r)), socket: own.socket.filter(r => !isStarred(r)) },
      },
      shared: {
        ...store.shared,
        [appId]: { http: [...shared.http, ...fresh(own.http, shared.http)], socket: [...shared.socket, ...fresh(own.socket, shared.socket)] },
      },
    },
  }
}

export function parseMockStoreJson(text: string): MockStore {
  const m = JSON.parse(text)
  if (m.devices && typeof m.devices === 'object') {
    const scoped: Record<string, Mocks> = {}
    for (const [deviceId, mocks] of Object.entries(m.devices)) {
      scoped[deviceId] = normalizeMocks(mocks)
    }
    const shared: Record<string, Mocks> = {}
    if (m.shared && typeof m.shared === 'object') {
      for (const [appId, mocks] of Object.entries(m.shared)) {
        shared[appId] = normalizeMocks(mocks)
      }
    }
    return { devices: scoped, shared, ...(Array.isArray(m.runs) ? { runs: m.runs } : {}), ...(Array.isArray(m.scenarios) ? { scenarios: m.scenarios } : {}) }
  }
  const legacy = normalizeMocks(m)
  return legacy.http.length || legacy.socket.length
    ? { devices: { 'legacy-global': legacy }, shared: {} }
    : { devices: {}, shared: {} }
}

export function loadMockStore(file: string): MockStore {
  try {
    return parseMockStoreJson(readFileSync(file, 'utf8'))
  } catch {
    return { devices: {}, shared: {} }
  }
}
