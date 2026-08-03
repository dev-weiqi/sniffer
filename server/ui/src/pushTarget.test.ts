import { connEndpoint, pointAt, resolvePushTarget, type PushTargetConn } from './pushTarget.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const conn = (connectionId: string, url = 'https://api.example.com', transport = 'socketio'): PushTargetConn =>
  ({ connectionId, url, transport })

const old = conn('conn-old')
const fresh = conn('conn-new')
const other = conn('conn-other', 'https://chat.example.com')

// ---- connEndpoint ----
assert(connEndpoint(old) === connEndpoint(fresh), 'the same endpoint survives a new connectionId')
assert(connEndpoint(old) !== connEndpoint(other), 'a different url is a different endpoint')
assert(connEndpoint(conn('a')) !== connEndpoint(conn('a', 'https://api.example.com', 'ktor-ws')),
  'a different transport is a different endpoint')

// ---- resolvePushTarget ----
const record = pointAt({ target: '', event: 'x' }, old)
assert(record.target === 'conn-old' && record.targetEndpoint === connEndpoint(old), 'pointAt stores id and endpoint')
assert(record.event === 'x', 'pointAt keeps the rest of the record')

assert(resolvePushTarget(record, [old, other]) === 'conn-old', 'a live original target is used as-is')
assert(resolvePushTarget(record, [fresh, other]) === 'conn-new',
  'a reconnect re-binds to the live connection on the same endpoint')
assert(resolvePushTarget(record, [other]) === '', 'no connection on that endpoint resolves to nothing')
assert(resolvePushTarget(record, []) === '', 'nothing is live')

// records saved before endpoints were remembered: one manual pick re-arms them
assert(resolvePushTarget({ target: 'conn-old' }, [fresh]) === '',
  'without a remembered endpoint a stale id cannot re-bind')
assert(resolvePushTarget({ target: 'conn-old' }, [old]) === 'conn-old',
  'without an endpoint a still-live id keeps working')

// a record that was never pointed anywhere stays unresolved rather than grabbing a connection
assert(resolvePushTarget({ target: '' }, [fresh]) === '', 'an unset target does not auto-pick')

// ---- per-session query in the url (ktor-ws reports the full socket.io handshake url) ----
const wsUrl = 'wss://api.example.com/socket.io/?EIO=4&transport=websocket'
const session1 = conn('ws-1', `${wsUrl}&sid=aaa`, 'ktor-ws')
const session2 = conn('ws-2', `${wsUrl}&sid=bbb`, 'ktor-ws')
const wsRecord = pointAt({ target: '' }, session1)
assert(resolvePushTarget(wsRecord, [session2]) === 'ws-2',
  'a per-session sid does not strand the record')
assert(resolvePushTarget(wsRecord, [session2, conn('ws-3', `${wsUrl}&sid=ccc`, 'ktor-ws')]) === '',
  'two candidates on the same path are ambiguous, so nothing is picked')
assert(resolvePushTarget(wsRecord, [conn('ws-4', 'wss://api.example.com/other?sid=aaa', 'ktor-ws')]) === '',
  'a different path is a different endpoint even ignoring the query')
assert(resolvePushTarget(pointAt({ target: '' }, conn('h-1', 'wss://h/ws#frag', 'ktor-ws')),
  [conn('h-2', 'wss://h/ws#other', 'ktor-ws')]) === 'h-2', 'a fragment is ignored too')

// ---- pointAt with no connection (the "Select a connection…" placeholder) ----
const cleared = pointAt(record, undefined)
assert(cleared.target === '' && cleared.targetEndpoint === undefined, 'clearing drops both id and endpoint')

console.log('pushTarget.test: all assertions passed')
