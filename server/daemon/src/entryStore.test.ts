import { createEntryStore } from './entryStore.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

const broadcasts: { message: { id?: string } }[] = []
/** a message is kept only if it was broadcast; dropped ones never reach the UI */
const accepted = (id: string) => broadcasts.some(b => b.message.id === id)

// our clock sits far ahead of the device clocks below — an emulator can be minutes behind,
// and every timestamp we compare must be read in that device's own timeline
let now = 1_000_000
const store = createEntryStore(msg => broadcasts.push(msg as { message: { id?: string } }), {
  maxStoredMessages: 3,
  clearSkewMs: 5_000,
  now: () => now,
})

store.pushEntry('d1', { type: 'http-request', id: 'h1', timestamp: 100_000 })
store.pushEntry('d1', { type: 'socket-event', id: 's1', timestamp: 102_000 })
assertEqual(store.snapshot().length, 2, 'pushEntry appends entries')
assertEqual(broadcasts.length, 2, 'pushEntry broadcasts appended entries')

store.pushEntry('d2', { type: 'other', id: 'o1' })
store.pushEntry('d2', { type: 'socket-ack', id: 'a1', timestamp: 50_000 })
store.pushEntry('d2', { type: 'http-response', id: 'h2', timestamp: 51_000 })
assertEqual(store.snapshot().length, 3, 'pushEntry caps stored entries')
assertEqual(store.snapshot()[0].message.id, 'o1', 'cap drops oldest entry')

now = 2_000_000
store.clearHttp()
assert(!store.snapshot().some(e => e.message.type === 'http-response'), 'clearHttp removes HTTP entries')
assert(store.snapshot().some(e => e.message.type === 'socket-ack'), 'clearHttp keeps socket entries')

// the regression this guards: a device whose clock trails ours keeps recording after a clear
store.pushEntry('d1', { type: 'http-request', id: 'fresh-http', timestamp: 103_000 })
assert(accepted('fresh-http'), 'clearHttp keeps traffic newer than the device watermark')
store.pushEntry('d1', { type: 'http-request', id: 'replayed-http', timestamp: 90_000 })
assert(!accepted('replayed-http'), 'clearHttp ignores buffered HTTP replay from before the clear')
store.pushEntry('d1', { type: 'http-request', id: 'skew-http', timestamp: 98_000 })
assert(accepted('skew-http'), 'clearHttp accepts entries inside the skew window')
// only the HTTP watermark moved
store.pushEntry('d1', { type: 'socket-event', id: 'old-socket-kept', timestamp: 60_000 })
assert(accepted('old-socket-kept'), 'clearHttp leaves the socket watermark alone')
store.pushEntry('d1', { type: 'other', id: 'untyped-kept', timestamp: 1 })
assert(accepted('untyped-kept'), 'entries of other types are never filtered')

store.clearSocket()
store.pushEntry('d1', { type: 'socket-ack', id: 'replayed-socket', timestamp: 60_000 })
assert(!accepted('replayed-socket'), 'clearSocket ignores buffered socket replay')
store.pushEntry('d1', { type: 'socket-ack', id: 'fresh-socket', timestamp: 104_000 })
assert(accepted('fresh-socket'), 'clearSocket keeps traffic newer than the device watermark')

store.pushEntry('d3', { type: 'http-request', id: 'remove-me', timestamp: 2_000_000 })
assertEqual(store.removeDeviceEntries('d3'), true, 'removeDeviceEntries reports removal')
assert(!store.snapshot().some(e => e.deviceId === 'd3'), 'removeDeviceEntries removes matching device rows')
assertEqual(store.removeDeviceEntries('missing'), false, 'removeDeviceEntries reports no-op')

store.clearAll()
assertEqual(store.snapshot().length, 0, 'clearAll removes all entries')
store.pushEntry('d1', { type: 'http-request', id: 'very-old-http', timestamp: 1 })
store.pushEntry('d1', { type: 'socket-event', id: 'very-old-socket', timestamp: 1 })
assertEqual(store.snapshot().length, 0, 'clearAll updates both watermarks')

// a device we have never timestamped falls back to our own clock, as before
store.pushEntry('d4', { type: 'http-request', id: 'd4-stale', timestamp: 1_000 })
assert(!accepted('d4-stale'), 'unseen devices fall back to the host-clock watermark')
store.pushEntry('d4', { type: 'socket-event', id: 'd4-stale-socket', timestamp: 1_000 })
assert(!accepted('d4-stale-socket'), 'host-clock fallback covers socket entries too')
store.pushEntry('d4', { type: 'http-request', id: 'd4-fresh', timestamp: 2_000_000 })
assert(accepted('d4-fresh'), 'unseen devices still record current traffic')

console.log('entryStore.test: all assertions passed')
