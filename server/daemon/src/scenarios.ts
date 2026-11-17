import { randomUUID } from 'node:crypto'
import type { MockStore, Mocks } from './mockStore.js'

export interface Scenario { id: string; name: string; appId: string; rules: Record<string, unknown>[]; parameters: string[] }
const token = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g

export function scenarioParameters(rules: unknown): string[] {
  const names = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') for (const match of value.matchAll(token)) names.add(match[1])
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (/\{\{/.test(key)) throw new Error('Parameter names are supported in values only')
      visit(child)
    }
  }
  visit(rules)
  return [...names].sort()
}

export function instantiateScenario(scenario: Scenario, parameters: unknown,
  build: (fields: Record<string, unknown>) => Record<string, unknown>): Mocks {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('parameters must be an object')
  const values = parameters as Record<string, unknown>
  if (Object.keys(values).some(key => !scenario.parameters.includes(key)) ||
    scenario.parameters.some(key => !Object.hasOwn(values, key))) throw new Error('Provide exactly the scenario parameters')
  for (const value of Object.values(values)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Parameters must be JSON scalars')
  }
  const render = (value: unknown, path = false): unknown => {
    if (typeof value === 'string') {
      const exact = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/.exec(value)
      if (exact && !path) return values[exact[1]]
      return value.replace(token, (_, key: string) => {
        const replacement = String(values[key])
        if (path && (!/^[A-Za-z0-9_.~-]+$/.test(replacement) || replacement === '.' || replacement === '..')) throw new Error('URL parameters must be a single nonempty path segment')
        return replacement
      })
    }
    if (Array.isArray(value)) return value.map(v => render(v))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, render(v)]))
    return value
  }
  const mocks: Mocks = { http: [], socket: [] }
  for (const template of scenario.rules) {
    const fields = { ...template }
    for (const [key, value] of Object.entries(fields)) {
      if (['body', 'bodyMatch', 'payloadMatch', 'ackPayload', 'pushPayload'].includes(key) && typeof value === 'string') {
        let json: unknown
        try { json = JSON.parse(value) } catch { fields[key] = render(value); continue }
        fields[key] = JSON.stringify(render(json))
      } else fields[key] = render(value, key === 'urlPattern')
    }
    const rule = build(fields)
    mocks[fields.type === 'socket' ? 'socket' : 'http'].push({ ...rule, id: randomUUID(), starred: false })
  }
  return mocks
}

export function withScenarioMocks(store: MockStore, deviceId: string, mocks: Mocks): MockStore {
  const existing = store.devices[deviceId] ?? { http: [], socket: [] }
  return { ...store, devices: { ...store.devices, [deviceId]: {
    http: [...mocks.http, ...existing.http], socket: [...mocks.socket, ...existing.socket],
  } } }
}
