import { readFileSync } from 'node:fs'

export interface Mocks {
  http: unknown[]
  socket: unknown[]
}

export interface MockStore {
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

export function stripUiOnlyFields(mocks: Mocks): Mocks {
  const strip = (rules: unknown[]) => rules.map(r => {
    const { starred: _, ...rest } = r as Record<string, unknown>
    return rest
  })
  return { http: strip(mocks.http), socket: strip(mocks.socket) }
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
    return { devices: scoped, shared }
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
