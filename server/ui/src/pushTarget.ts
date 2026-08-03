/** Which live connection a saved push event should fire on.

    A connectionId only identifies one connection *session*: reinstalling the app, or any
    reconnect, hands out a fresh id and strands every saved push record. The endpoint
    (transport + url) is what stays the same across those, so a record remembers it and
    re-binds to whichever live connection serves that endpoint again. */

export interface PushTargetConn {
  connectionId: string
  transport: string
  url: string
}

export interface PushTargetRecord {
  target: string
  /** endpoint of the connection this record was pointed at, for re-binding after a reconnect */
  targetEndpoint?: string
}

/** Identity of a socket endpoint -- the same pairing the connection list dedupes on. */
export function connEndpoint(conn: PushTargetConn): string {
  return `${conn.transport}|${conn.url}`
}

/** Same endpoint with the query dropped. ktor-ws reports the full request url, and a
    socket.io handshake puts a per-session `sid` (and a cache-buster `t`) in there, so the
    exact endpoint changes on every reconnect while the path stays put. */
function withoutQuery(endpoint: string): string {
  const split = endpoint.indexOf('|')
  const url = endpoint.slice(split + 1)
  return `${endpoint.slice(0, split)}|${url.split('#')[0].split('?')[0]}`
}

/** The live connectionId to send on, or '' when nothing serves the record's endpoint.
    Resolution runs per render, so a re-bind never rewrites what is stored. */
export function resolvePushTarget(record: PushTargetRecord, live: PushTargetConn[]): string {
  if (live.some(c => c.connectionId === record.target)) return record.target
  if (!record.targetEndpoint) return ''
  const exact = live.find(c => connEndpoint(c) === record.targetEndpoint)
  if (exact) return exact.connectionId
  // Queries that differ per session would strand the record, but a query can also be what
  // separates two sockets (a room, a topic) -- so ignore it only when the answer is unambiguous.
  const loose = live.filter(c => withoutQuery(connEndpoint(c)) === withoutQuery(record.targetEndpoint!))
  return loose.length === 1 ? loose[0].connectionId : ''
}

/** Point a record at [conn], remembering the endpoint so the next reconnect re-binds itself. */
export function pointAt<T extends PushTargetRecord>(
  record: T,
  conn: PushTargetConn | undefined,
): T & PushTargetRecord {
  return { ...record, target: conn?.connectionId ?? '', targetEndpoint: conn && connEndpoint(conn) }
}
