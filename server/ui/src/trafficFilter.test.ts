import {
  EMPTY_FILTER,
  addFilterValue,
  addOrEnableValue,
  filterActive,
  loadFilter,
  passesFilter,
  saveFilter,
  setAllEnabled,
  type TrafficFilter,
} from './trafficFilter.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const exclude = (...values: string[]): TrafficFilter =>
  ({ mode: 'exclude', items: values.map(value => ({ value, enabled: true })) })

// ---- passesFilter / filterActive ----
assert(passesFilter(EMPTY_FILTER, 'anything'), 'empty filter passes everything')
assert(!filterActive(EMPTY_FILTER), 'empty filter is inactive')
assert(filterActive(exclude('x')), 'enabled item makes it active')
assert(!filterActive({ mode: 'exclude', items: [{ value: 'x', enabled: false }] }), 'all-disabled is inactive')

assert(!passesFilter(exclude('ping'), 'ping'), 'exclude hides matching rows')
assert(passesFilter(exclude('ping'), 'shopping:updated'), 'matching is exact, not substring')
assert(passesFilter(exclude('count_unread'), 'pmsg/v1/ulist'), 'exclude keeps the rest')
assert(!passesFilter(exclude('PING'), 'ping'), 'matching is case-insensitive')
assert(
  passesFilter({ mode: 'exclude', items: [{ value: 'ping', enabled: false }] }, 'ping'),
  'disabled values do not filter',
)
assert(passesFilter({ ...exclude('ping'), mode: 'include' }, 'ping'), 'include keeps matches')
assert(!passesFilter({ ...exclude('ping'), mode: 'include' }, 'pong'), 'include hides the rest')

// ---- addFilterValue ----
{
  const one = addFilterValue(EMPTY_FILTER, ' count_unread ')
  assert(one.items.length === 1 && one.items[0].value === 'count_unread', 'add trims and appends enabled')
  assert(addFilterValue(one, 'COUNT_UNREAD') === one, 'duplicate (case-insensitive) is a no-op')
  assert(addFilterValue(one, '   ') === one, 'blank is a no-op')
  assert(EMPTY_FILTER.items.length === 0, 'add never mutates the original')
}

// ---- addOrEnableValue ("From selection") ----
{
  const inc: TrafficFilter = { mode: 'include', items: [{ value: 'ping', enabled: false }] }
  const next = addOrEnableValue(inc, 'ping')
  assert(next.mode === 'include' && next.items[0].enabled, 're-enables without touching the mode')
  const added = addOrEnableValue(inc, 'pong')
  assert(added.items.length === 2 && added.items[1].value === 'pong' && added.items[1].enabled, 'appends new values enabled')
  assert(addOrEnableValue(inc, ' ') === inc, 'blank is a no-op')
}

// ---- setAllEnabled (All / None) ----
{
  const mixed: TrafficFilter = { mode: 'exclude', items: [{ value: 'a', enabled: true }, { value: 'b', enabled: false }] }
  assert(setAllEnabled(mixed, true).items.every(i => i.enabled), 'All enables every value')
  assert(setAllEnabled(mixed, false).items.every(i => !i.enabled), 'None disables every value')
  assert(setAllEnabled(mixed, false).mode === 'exclude', 'mode is untouched')
  assert(mixed.items[1].enabled === false && mixed.items[0].enabled === true, 'original is not mutated')
}

// ---- load / save round-trip ----
{
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
  const filter: TrafficFilter = { mode: 'include', items: [{ value: 'a', enabled: true }, { value: 'b', enabled: false }] }
  saveFilter('k', filter, storage)
  const loaded = loadFilter('k', storage)
  assert(JSON.stringify(loaded) === JSON.stringify(filter), 'round-trips through storage')

  assert(loadFilter('missing', storage) === EMPTY_FILTER, 'missing key → empty filter')
  store.set('bad', 'not json')
  assert(loadFilter('bad', storage) === EMPTY_FILTER, 'garbage → empty filter')
  store.set('wrong-mode', JSON.stringify({ mode: 'nope', items: [] }))
  assert(loadFilter('wrong-mode', storage) === EMPTY_FILTER, 'unknown mode → empty filter')
  store.set('wrong-items', JSON.stringify({ mode: 'exclude', items: 'x' }))
  assert(loadFilter('wrong-items', storage) === EMPTY_FILTER, 'non-array items → empty filter')
  store.set('dirty', JSON.stringify({ mode: 'exclude', items: [{ value: '' }, { value: 'ok' }, { value: 7 }] }))
  const cleaned = loadFilter('dirty', storage)
  assert(cleaned.items.length === 1 && cleaned.items[0].value === 'ok' && cleaned.items[0].enabled, 'dirty items are dropped, enabled defaults true')

  const throwing = {
    getItem: (): string | null => { throw new Error('denied') },
    setItem: (): void => { throw new Error('full') },
  }
  assert(loadFilter('k', throwing) === EMPTY_FILTER, 'throwing storage → empty filter')
  saveFilter('k', filter, throwing) // must not throw
}

console.log('trafficFilter.test: all assertions passed')
