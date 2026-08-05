/** The order rules sit in on screen, remembered per device.

    Starring a rule hands it to the daemon's shared bucket, which is merged back ahead of the
    device's own rules -- so the rule teleports to the top of the list the moment you star it.
    Which rules exist stays the daemon's business; where they sit is a display concern, so it
    lives here (localStorage, per device) alongside the filters and push records. */

export interface MockOrder {
  http: string[]
  socket: string[]
}

export const EMPTY_ORDER: MockOrder = { http: [], socket: [] }

/** [items] rearranged to match [order]. Remembered items fill the slots they already occupy,
    so anything new (a just-added rule, one starred on another device) keeps the position it
    arrived in instead of being flushed to the end. */
export function byOrder<T extends { id: string }>(order: string[], items: T[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  const remembered = items
    .filter(item => rank.has(item.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  let next = 0
  return items.map(item => rank.has(item.id) ? remembered[next++] : item)
}

export function applyOrder<H extends { id: string }, S extends { id: string }>(
  order: MockOrder,
  mocks: { http: H[]; socket: S[] },
): { http: H[]; socket: S[] } {
  return { http: byOrder(order.http, mocks.http), socket: byOrder(order.socket, mocks.socket) }
}

export function orderOf(mocks: { http: { id: string }[]; socket: { id: string }[] }): MockOrder {
  return { http: mocks.http.map(r => r.id), socket: mocks.socket.map(r => r.id) }
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

export function loadOrder(key: string, storage: Pick<Storage, 'getItem'>): MockOrder {
  try {
    const raw = storage.getItem(key)
    if (!raw) return EMPTY_ORDER
    const parsed = JSON.parse(raw) as Partial<MockOrder>
    return { http: ids(parsed?.http), socket: ids(parsed?.socket) }
  } catch {
    return EMPTY_ORDER
  }
}

export function saveOrder(key: string, order: MockOrder, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(key, JSON.stringify(order))
  } catch {
    // storage full or unavailable: the order still holds for this session
  }
}

/** Single-list variant of [loadOrder] / [saveOrder], for the push records. */
export function loadIds(key: string, storage: Pick<Storage, 'getItem'>): string[] {
  try {
    return ids(JSON.parse(storage.getItem(key) ?? '[]'))
  } catch {
    return []
  }
}

export function saveIds(key: string, value: string[], storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // same as saveOrder: losing the remembered order is not worth breaking the panel over
  }
}
