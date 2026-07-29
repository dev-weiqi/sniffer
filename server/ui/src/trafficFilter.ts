/** Per-column noise filter: hide (or keep only) rows matching user-managed substrings. */
export interface TrafficFilter {
  /** exclude: matching rows are hidden; include: only matching rows show */
  mode: 'exclude' | 'include'
  items: { value: string; enabled: boolean }[]
}

export const EMPTY_FILTER: TrafficFilter = { mode: 'exclude', items: [] }

export function filterActive(filter: TrafficFilter): boolean {
  return filter.items.some(i => i.enabled)
}

/** case-insensitive exact match against every enabled value */
export function passesFilter(filter: TrafficFilter, text: string): boolean {
  const enabled = filter.items.filter(i => i.enabled)
  if (enabled.length === 0) return true
  const haystack = text.toLowerCase()
  const matched = enabled.some(i => haystack === i.value.toLowerCase())
  return filter.mode === 'exclude' ? !matched : matched
}

/** add [value] unless blank or already present (case-insensitive) */
export function addFilterValue(filter: TrafficFilter, value: string): TrafficFilter {
  const trimmed = value.trim()
  if (!trimmed || filter.items.some(i => i.value.toLowerCase() === trimmed.toLowerCase())) return filter
  return { ...filter, items: [...filter.items, { value: trimmed, enabled: true }] }
}

/** add [value], or re-enable it when it already exists; the mode is left alone */
export function addOrEnableValue(filter: TrafficFilter, value: string): TrafficFilter {
  const trimmed = value.trim()
  if (!trimmed) return filter
  const existing = filter.items.findIndex(i => i.value.toLowerCase() === trimmed.toLowerCase())
  const items = existing >= 0
    ? filter.items.map((i, index) => index === existing ? { ...i, enabled: true } : i)
    : [...filter.items, { value: trimmed, enabled: true }]
  return { ...filter, items }
}


/** All / None: flip every value on or off in one go */
export function setAllEnabled(filter: TrafficFilter, enabled: boolean): TrafficFilter {
  return { ...filter, items: filter.items.map(i => ({ ...i, enabled })) }
}

export function loadFilter(key: string, storage: Pick<Storage, 'getItem'>): TrafficFilter {
  try {
    const raw = storage.getItem(key)
    if (!raw) return EMPTY_FILTER
    const parsed = JSON.parse(raw) as TrafficFilter
    if (parsed.mode !== 'exclude' && parsed.mode !== 'include') return EMPTY_FILTER
    if (!Array.isArray(parsed.items)) return EMPTY_FILTER
    return {
      mode: parsed.mode,
      items: parsed.items
        .filter(i => typeof i?.value === 'string' && i.value.trim() !== '')
        .map(i => ({ value: i.value, enabled: i.enabled !== false })),
    }
  } catch {
    return EMPTY_FILTER
  }
}

export function saveFilter(key: string, filter: TrafficFilter, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(key, JSON.stringify(filter))
  } catch {
    // storage full or unavailable: the filter still works for this session
  }
}
