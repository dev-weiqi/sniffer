import { buildExportRules, countImportedRules, countSelectedRules, createFullExportSelection, importedCopies, parseImportedRules } from './exportMocks.js'
import type { Mocks } from './state.js'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function assertIds(actual: { id: string }[], expected: string[], label: string) {
  const ids = actual.map(r => r.id)
  assert(ids.length === expected.length && ids.every((id, i) => id === expected[i]),
    `${label}: expected ${expected.join(',')} but got ${ids.join(',')}`)
}

const mocks: Mocks = {
  http: [
    {
      id: 'http-1',
      name: 'users',
      enabled: true,
      method: 'GET',
      urlPattern: '/users',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      delayMs: 0,
      delayOnly: false,
    },
    {
      id: 'http-2',
      enabled: false,
      method: null,
      urlPattern: '/health',
      status: 204,
      headers: {},
      body: '',
      delayMs: 25,
      delayOnly: true,
    },
  ],
  socket: [
    {
      id: 'socket-1',
      enabled: true,
      transport: 'socketio',
      event: 'join',
      ackPayload: '[{"ok":true}]',
      delayMs: 0,
    },
    {
      id: 'socket-2',
      enabled: true,
      transport: 'ktor-ws',
      event: 'ping',
      ackPayload: 'pong',
      delayMs: 10,
    },
  ],
}

const push = [
  {
    id: 'push-1',
    name: 'notify',
    target: '',
    event: 'notify:new',
    payload: '{"ok":true}',
  },
  {
    id: 'push-2',
    target: 'conn-1',
    event: 'presence:update',
    payload: '{}',
    starred: true,
  },
]

const source = { ...mocks, push }

const fullSelection = createFullExportSelection(source)
const full = buildExportRules(source, fullSelection)
assertIds(full.http, ['http-1', 'http-2'], 'full HTTP export')
assertIds(full.socket, ['socket-1', 'socket-2'], 'full socket export')
assertIds(full.push, ['push-1', 'push-2'], 'full push export')
assert(full.http[1].enabled === false, 'exports disabled HTTP rules too')
assert(countSelectedRules(fullSelection) === 3, 'full selection includes every rule category')

const partial = buildExportRules(source, {
  http: true,
  socket: false,
  push: true,
})
assertIds(partial.http, ['http-1', 'http-2'], 'category-selected HTTP export')
assertIds(partial.socket, [], 'unselected socket category is omitted')
assertIds(partial.push, ['push-1', 'push-2'], 'category-selected push export')
assert(partial.http[1].enabled === false, 'category export includes disabled rules too')
assert(countSelectedRules({ http: true, socket: false, push: true }) === 2,
  'counts selected rule categories')

const emptySelection = createFullExportSelection({ http: [], socket: [], push: [] })
const empty = buildExportRules({ http: [], socket: [], push: [] }, emptySelection)
assert(empty.http.length === 0 && empty.socket.length === 0 && empty.push.length === 0,
  'keeps every export category even when empty')
assert(countSelectedRules(emptySelection) === 3, 'empty export source still selects every category')

// ---- parseImportedRules ----
// Symmetry: every category the exporter writes must come back through the parser, or
// those rules vanish silently on import (push events did exactly that).
const roundTrip = parseImportedRules(JSON.stringify(full))
assert(roundTrip !== null, 'a full export parses back')
for (const key of Object.keys(full) as (keyof typeof full)[]) {
  assert(roundTrip![key].length === full[key].length,
    `import drops the "${key}" category the export writes`)
}
assertIds(roundTrip!.push, ['push-1', 'push-2'], 'push events survive a round trip')
assert(countImportedRules(roundTrip!) === 6, 'counts every imported rule')

// a file holding only push events still carries rules -- importing it must not be a no-op
const pushOnly = parseImportedRules(JSON.stringify(buildExportRules(source, { http: false, socket: false, push: true })))
assert(countImportedRules(pushOnly!) === 2, 'a push-only export is not empty on import')

// missing categories default to empty rather than throwing (older files, hand-edited files)
const legacy = parseImportedRules('{"http":[{"id":"a"}]}')
assert(legacy !== null && legacy.http.length === 1 && legacy.socket.length === 0 && legacy.push.length === 0,
  'absent categories parse as empty')
assert(countImportedRules({ http: [], socket: [], push: [] }) === 0, 'an empty file counts zero rules')

// non-rule input is rejected so the caller can tell "bad file" from "no rules"
assert(parseImportedRules('not json') === null, 'garbage is not a rules file')
assert(parseImportedRules('null') === null, 'null is not a rules file')
assert(parseImportedRules('[1,2]') === null, 'an array is not a rules file')
assert(parseImportedRules('"text"') === null, 'a bare string is not a rules file')
const wrongTypes = parseImportedRules('{"http":"x","socket":3,"push":null}')
assert(wrongTypes !== null && countImportedRules(wrongTypes) === 0, 'non-array categories parse as empty')

// ---- importedCopies ----
// A starred rule is app-wide: the daemon's PUT replaces shared[appId] with every starred rule
// in the payload, so importing one as-is would rewrite rules for every device of that app.
let seq = 0
const freshId = () => `new-${++seq}`
const copies = importedCopies(
  [{ id: 'push-1', starred: true, event: 'a' }, { id: 'push-2', event: 'b' }],
  freshId,
)
assertIds(copies, ['new-1', 'new-2'], 'imported rules get fresh ids')
assert(copies.every(r => r.starred === undefined), 'imported rules are never starred')
assert(copies[0].event === 'a' && copies[1].event === 'b', 'every other field survives the copy')
assert(importedCopies([], freshId).length === 0, 'copying an empty category is empty')

console.log('exportMocks.test: all assertions passed')
