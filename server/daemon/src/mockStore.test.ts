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

const queryMocks = {
  http: [
    { id: 'fallback' },
    { id: 'empty', queryParams: {} },
    { id: 'page', queryParams: { page: '2' }, starred: true },
    ...[null, [], 'page=2', { page: 2 }, { '': '2' }].map(queryParams => ({ id: 'invalid', queryParams })),
  ],
  socket: [{ id: 'socket' }],
}
const legacyWire = stripUiOnlyFields(queryMocks, ['http'])
assertEqual(legacyWire.http.length, 2, 'legacy clients only receive path-only rules')
const queryWire = stripUiOnlyFields(queryMocks, ['http', 'http-query-mocks'])
assertEqual(queryWire.http.length, 3, 'query clients receive valid query rules; malformed constraints are rejected')
assertEqual((queryWire.http[2] as { queryParams: { page: string } }).queryParams.page, '2', 'query survives device sync')
assert(!('starred' in (queryWire.http[2] as object)), 'shared query rules lose only the UI marker')
assertEqual(queryWire.socket.length, 1, 'capability filtering leaves socket rules intact')

const payloadMocks = { http: [], socket: [
  { id: 'fallback' }, { id: 'blank', payloadMatch: ' ' }, { id: 'empty', payloadMatch: '{}' },
  { id: 'page', payloadMatch: '{"page":2}', starred: true },
  ...[false, 1, [], {}, '[]', 'null', '{', '2'].map(payloadMatch => ({ id: 'invalid', payloadMatch })),
] }
assertEqual(stripUiOnlyFields(payloadMocks).socket.length, 3, 'old SDKs never receive payload conditions')
const payloadWire = stripUiOnlyFields(payloadMocks, ['socket-payload-mocks'])
assertEqual(payloadWire.socket.length, 4, 'new SDKs receive only valid payload rules')
assertEqual((payloadWire.socket[3] as { payloadMatch: string }).payloadMatch, '{"page":2}', 'payload survives sync')
const payloadStore = parseMockStoreJson(JSON.stringify({ devices: { d1: payloadMocks } }))
assertEqual((payloadStore.devices.d1.socket[3] as { payloadMatch: string }).payloadMatch, '{"page":2}', 'payload survives persistence')
assertEqual(payloadStore.devices.d1.socket.length, payloadMocks.socket.length, 'invalid drafts remain editable')

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

const bodyMocks = { http: [
  { id: 'fallback' }, { id: 'blank', bodyMatch: ' ' }, { id: 'empty', bodyMatch: '{}' },
  { id: 'body', bodyMatch: '{"limit":20}', starred: true },
  { id: 'both', queryParams: { page: '1' }, bodyMatch: '{"limit":20}' },
  ...[false, 1, [], {}, '[]', 'null', '{', '2'].map(bodyMatch => ({ id: 'invalid', bodyMatch })),
], socket: [] }
assertEqual(stripUiOnlyFields(bodyMocks, ['http-query-mocks']).http.length, 3, 'query-only SDKs cannot receive body conditions')
assertEqual(stripUiOnlyFields(bodyMocks, ['http-body-mocks']).http.length, 4, 'both conditions require both capabilities')
const bodyWire = stripUiOnlyFields(bodyMocks, ['http-query-mocks', 'http-body-mocks'])
assertEqual(bodyWire.http.length, 5, 'valid HTTP conditions survive sync')
assertEqual((bodyWire.http[3] as { bodyMatch: string }).bodyMatch, '{"limit":20}', 'HTTP body survives device sync')
assert(!('starred' in (bodyWire.http[3] as object)), 'HTTP body shared rule strips UI marker')
const bodyStore = parseMockStoreJson(JSON.stringify({ devices: { d1: bodyMocks }, shared: {} }))
assertEqual((bodyStore.devices.d1.http[3] as { bodyMatch: string }).bodyMatch, '{"limit":20}', 'HTTP body survives persistence')
