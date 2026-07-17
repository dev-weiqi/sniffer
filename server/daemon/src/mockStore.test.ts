import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_MOCKS,
  isStarred,
  loadMockStore,
  mergeMocks,
  migrateStarredToSharedStore,
  normalizeMocks,
  parseMockStoreJson,
  stripUiOnlyFields,
} from './mockStore.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

assertEqual(EMPTY_MOCKS.http.length, 0, 'EMPTY_MOCKS HTTP starts empty')
assertEqual(EMPTY_MOCKS.socket.length, 0, 'EMPTY_MOCKS socket starts empty')

const normalized = normalizeMocks({
  http: [{ id: 'h1' }],
  socket: 'bad',
})
assertEqual(normalized.http.length, 1, 'normalizeMocks keeps HTTP arrays')
assertEqual(normalized.socket.length, 0, 'normalizeMocks drops invalid socket value')
assertEqual(normalizeMocks(null).http.length, 0, 'normalizeMocks handles null')

assertEqual(isStarred({ starred: true }), true, 'isStarred detects true')
assertEqual(isStarred({ starred: false }), false, 'isStarred ignores false')
assertEqual(isStarred(null), false, 'isStarred handles null')

const own = { http: [{ id: 'own-http' }], socket: [{ id: 'own-socket' }] }
assert(mergeMocks(own, EMPTY_MOCKS) === own, 'mergeMocks returns own when shared is empty')
const merged = mergeMocks(own, { http: [{ id: 'shared-http' }], socket: [] })
assertEqual((merged.http[0] as { id: string }).id, 'shared-http', 'mergeMocks pins shared HTTP first')
assertEqual((merged.http[1] as { id: string }).id, 'own-http', 'mergeMocks keeps own HTTP second')

const stripped = stripUiOnlyFields({
  http: [{ id: 'h1', starred: true, status: 200 }],
  socket: [{ id: 's1', starred: true, event: 'join' }],
})
assert(!('starred' in (stripped.http[0] as Record<string, unknown>)), 'stripUiOnlyFields removes HTTP starred marker')
assert(!('starred' in (stripped.socket[0] as Record<string, unknown>)), 'stripUiOnlyFields removes socket starred marker')

const migration = migrateStarredToSharedStore({
  devices: {
    d1: {
      http: [{ id: 'h1', starred: true }, { id: 'h2' }],
      socket: [{ id: 's1', starred: true }],
    },
  },
  shared: {
    app: { http: [{ id: 'h1', starred: true }], socket: [] },
  },
}, 'd1', 'app')
assertEqual(migration.changed, true, 'migrateStarredToSharedStore reports changed')
assertEqual(migration.store.devices.d1.http.length, 1, 'migration removes starred HTTP from device bucket')
assertEqual(migration.store.shared.app.http.length, 1, 'migration does not duplicate shared HTTP by id')
assertEqual(migration.store.shared.app.socket.length, 1, 'migration adds fresh shared socket')

const noMigration = migrateStarredToSharedStore({ devices: { d1: own }, shared: {} }, 'd1', 'app')
assertEqual(noMigration.changed, false, 'migration reports no-op without starred rules')
assert(noMigration.store.devices.d1 === own, 'migration returns original store on no-op')

const scoped = parseMockStoreJson(JSON.stringify({
  devices: {
    d1: { http: [{ id: 'h1' }], socket: [{ id: 's1' }] },
    d2: { http: 'bad' },
  },
  shared: {
    app: { socket: [{ id: 'shared' }] },
  },
}))
assertEqual(scoped.devices.d1.http.length, 1, 'parseMockStoreJson reads scoped HTTP mocks')
assertEqual(scoped.devices.d2.http.length, 0, 'parseMockStoreJson normalizes scoped mocks')
assertEqual(scoped.shared.app.socket.length, 1, 'parseMockStoreJson reads shared mocks')

const legacyHttp = parseMockStoreJson(JSON.stringify({ http: [{ id: 'legacy' }], socket: [] }))
assertEqual(legacyHttp.devices['legacy-global'].http.length, 1, 'legacy HTTP mocks move to legacy-global')
assertEqual(Object.keys(legacyHttp.shared).length, 0, 'legacy store has no shared mocks')

const legacyEmpty = parseMockStoreJson(JSON.stringify({ http: [], socket: [] }))
assertEqual(Object.keys(legacyEmpty.devices).length, 0, 'empty legacy store stays empty')

const dir = mkdtempSync(join(tmpdir(), 'sniffer-mocks-'))
const file = join(dir, 'mocks.json')
writeFileSync(file, JSON.stringify({ devices: { d3: { socket: [{ id: 'from-file' }] } } }))
assertEqual(loadMockStore(file).devices.d3.socket.length, 1, 'loadMockStore reads existing file')
assertEqual(Object.keys(loadMockStore(join(dir, 'missing.json')).devices).length, 0, 'loadMockStore handles missing file')
writeFileSync(file, '{')
assertEqual(Object.keys(loadMockStore(file).devices).length, 0, 'loadMockStore handles malformed JSON')

console.log('mockStore.test: all assertions passed')
