import {
  EMPTY_ORDER,
  applyOrder,
  byOrder,
  loadIds,
  loadOrder,
  orderOf,
  saveIds,
  saveOrder,
} from './mockOrder.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const rule = (id: string) => ({ id })
const idsOf = (items: { id: string }[]) => items.map(r => r.id).join(',')

// ---- byOrder ----
// The case this exists for: the daemon merges starred rules ahead of the device's own, so a
// rule jumps to the top the moment it is starred. The remembered order puts it back.
assert(idsOf(byOrder(['a', 'b', 'c'], [rule('b'), rule('a'), rule('c')])) === 'a,b,c',
  'a rule pinned to the front by the merge goes back where it was')
assert(idsOf(byOrder(['a', 'b', 'c'], [rule('a'), rule('b'), rule('c')])) === 'a,b,c',
  'an already-correct order is left alone')

// New rules keep the position they arrived in -- "Mock this request" prepends, "+ Add" appends
assert(idsOf(byOrder(['a', 'b'], [rule('new'), rule('a'), rule('b')])) === 'new,a,b',
  'a prepended new rule stays on top')
assert(idsOf(byOrder(['a', 'b'], [rule('a'), rule('b'), rule('new')])) === 'a,b,new',
  'an appended new rule stays at the bottom')
assert(idsOf(byOrder(['a', 'b'], [rule('a'), rule('new'), rule('b')])) === 'a,new,b',
  'a rule inserted in the middle (duplicate) keeps its slot')

// Deleted rules simply drop out; the rest keep their relative order
assert(idsOf(byOrder(['a', 'b', 'c'], [rule('c'), rule('a')])) === 'a,c', 'a deleted rule leaves no gap')
assert(idsOf(byOrder([], [rule('a'), rule('b')])) === 'a,b', 'no remembered order changes nothing')
assert(byOrder(['a'], []).length === 0, 'an empty list stays empty')

// ---- applyOrder / orderOf ----
{
  const mocks = { http: [rule('h2'), rule('h1')], socket: [rule('s2'), rule('s1')] }
  const ordered = applyOrder({ http: ['h1', 'h2'], socket: ['s1', 's2'] }, mocks)
  assert(idsOf(ordered.http) === 'h1,h2' && idsOf(ordered.socket) === 's1,s2', 'both lists are ordered')
  const round = orderOf(ordered)
  assert(round.http.join() === 'h1,h2' && round.socket.join() === 's1,s2', 'orderOf reads the ids back')
  assert(applyOrder(EMPTY_ORDER, mocks).http[0].id === 'h2', 'an empty order leaves the lists untouched')
}

// ---- storage ----
{
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
  const order = { http: ['a'], socket: ['b'] }
  saveOrder('k', order, storage)
  assert(JSON.stringify(loadOrder('k', storage)) === JSON.stringify(order), 'order round-trips')
  assert(loadOrder('missing', storage) === EMPTY_ORDER, 'missing key → empty order')

  store.set('bad', 'not json')
  assert(loadOrder('bad', storage) === EMPTY_ORDER, 'garbage → empty order')
  store.set('partial', JSON.stringify({ http: ['a', 7, null] }))
  const partial = loadOrder('partial', storage)
  assert(partial.http.join() === 'a' && partial.socket.length === 0, 'non-string ids and absent lists are dropped')

  saveIds('ids', ['x', 'y'], storage)
  assert(loadIds('ids', storage).join() === 'x,y', 'push order round-trips')
  assert(loadIds('nope', storage).length === 0, 'missing push order → empty')
  store.set('ids-bad', '{"not":"an array"}')
  assert(loadIds('ids-bad', storage).length === 0, 'non-array push order → empty')

  const throwing = {
    getItem: (): string | null => { throw new Error('denied') },
    setItem: (): void => { throw new Error('full') },
  }
  assert(loadOrder('k', throwing) === EMPTY_ORDER, 'throwing storage → empty order')
  assert(loadIds('k', throwing).length === 0, 'throwing storage → empty push order')
  saveOrder('k', order, throwing) // must not throw
  saveIds('k', ['x'], throwing)   // must not throw
}

console.log('mockOrder.test: all assertions passed')
