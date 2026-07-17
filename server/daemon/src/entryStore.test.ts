import { createEntryStore } from './entryStore.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

const broadcasts: unknown[] = []
let now = 10_000
const store = createEntryStore(msg => broadcasts.push(msg), {
  maxStoredMessages: 3,
  clearSkewMs: 5_000,
  now: () => now,
})

store.pushEntry('d1', { type: 'http-request', id: 'h1', timestamp: 1 })
store.pushEntry('d1', { type: 'socket-event', id: 's1', timestamp: 2 })
assertEqual(store.snapshot().length, 2, 'pushEntry appends entries')
assertEqual(broadcasts.length, 2, 'pushEntry broadcasts appended entries')

store.pushEntry('d2', { type: 'other', id: 'o1' })
store.pushEntry('d2', { type: 'http-response', id: 'h2', timestamp: 3 })
assertEqual(store.snapshot().length, 3, 'pushEntry caps stored entries')
assertEqual(store.snapshot()[0].message.id, 's1', 'cap drops oldest entry')

store.clearHttp()
assert(!store.snapshot().some(e => e.message.type === 'http-response'), 'clearHttp removes HTTP entries')
assert(store.snapshot().some(e => e.message.type === 'socket-event'), 'clearHttp keeps socket entries')
store.pushEntry('d1', { type: 'http-request', id: 'old-http', timestamp: 4_000 })
assert(!store.snapshot().some(e => e.message.id === 'old-http'), 'clearHttp ignores old buffered HTTP replay')
store.pushEntry('d1', { type: 'http-request', id: 'fresh-http', timestamp: 6_000 })
assert(store.snapshot().some(e => e.message.id === 'fresh-http'), 'clearHttp accepts entries inside skew window')

now = 20_000
store.clearSocket()
assert(!store.snapshot().some(e => e.message.type === 'socket-event'), 'clearSocket removes socket entries')
store.pushEntry('d1', { type: 'socket-ack', id: 'old-socket', timestamp: 10_000 })
assert(!store.snapshot().some(e => e.message.id === 'old-socket'), 'clearSocket ignores old buffered socket replay')

store.pushEntry('d3', { type: 'http-request', id: 'remove-me', timestamp: 20_000 })
assertEqual(store.removeDeviceEntries('d3'), true, 'removeDeviceEntries reports removal')
assert(!store.snapshot().some(e => e.deviceId === 'd3'), 'removeDeviceEntries removes matching device rows')
assertEqual(store.removeDeviceEntries('missing'), false, 'removeDeviceEntries reports no-op')

store.clearAll()
assertEqual(store.snapshot().length, 0, 'clearAll removes all entries')
store.pushEntry('d1', { type: 'http-request', id: 'very-old-http', timestamp: 1 })
store.pushEntry('d1', { type: 'socket-event', id: 'very-old-socket', timestamp: 1 })
assertEqual(store.snapshot().length, 0, 'clearAll updates both watermarks')

console.log('entryStore.test: all assertions passed')
