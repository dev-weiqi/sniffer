import { buildExportRules, countSelectedRules, createFullExportSelection } from './exportMocks.js'
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
