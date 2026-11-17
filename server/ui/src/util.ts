import type { HttpMockRule, HttpRow, SocketMockRule, SocketRow } from './state.js'

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** Only zoned ISO timestamps are safe to interpret without guessing a timezone or unit. */
export function localTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 ||
      Number(minute) > 59 || Number(second) > 59 || zone === '-00:00') return null
  if (zone.toUpperCase() !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone.toUpperCase()}`)
  if (!Number.isFinite(date.getTime())) return null
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const local = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${fraction}`
  return `${local} UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

export function fmtSize(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

export function urlParts(url: string): { domain: string; path: string; query: [string, string][] } {
  try {
    const u = new URL(url)
    return { domain: u.host, path: u.pathname, query: [...u.searchParams.entries()] }
  } catch {
    return { domain: '', path: url, query: [] }
  }
}

export function prettyJson(text: string | null | undefined): string {
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function prettySocketRule(rule: SocketMockRule): SocketMockRule {
  return {
    ...rule,
    ackPayload: prettyJson(rule.ackPayload),
    ...(rule.pushPayload === undefined ? {} : { pushPayload: prettyJson(rule.pushPayload) }),
  }
}

/** socket.io backends commonly emit `JSON.stringify(payload)`, so the recorded argument list is
    an array holding one JSON *string*: `["{\"a\":1}"]`. JSON has no way to format inside a
    string, which is why Pretty JSON leaves those unreadable. Returns the inner value formatted,
    or null when the text is not that shape -- the caller uses null to hide the action. */
export function unwrapJsonString(text: string): string | null {
  let outer: unknown
  try {
    outer = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(outer) || outer.length !== 1 || typeof outer[0] !== 'string') return null
  try {
    const inner: unknown = JSON.parse(outer[0])
    if (inner === null || typeof inner !== 'object') return null
    return JSON.stringify(inner, null, 2)
  } catch {
    return null
  }
}

/** Inverse of [unwrapJsonString]: back to the single-string argument the app parses. The inner
    JSON is re-serialized, so whitespace and key order come from the editor, not the original
    capture -- the parsed value is the same, the bytes need not be. */
export function wrapJsonString(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object') return null
    return JSON.stringify([JSON.stringify(value)])
  } catch {
    return null
  }
}

export function statusClass(status: number | undefined, error?: string | null): string {
  if (error) return 'st-err'
  if (status === undefined) return 'st-pending'
  if (status === 0 || status >= 500) return 'st-err'
  if (status >= 400) return 'st-warn'
  if (status >= 300) return 'st-info'
  return 'st-ok'
}

export function statusLabel(status: number | undefined, error?: string | null): string {
  // ponytail: classify the SDK's current error text; add a protocol errorKind if more cancellation forms appear.
  if (status === 0) return error?.includes('CancellationException') ? 'CANCEL' : 'ERROR'
  return String(status ?? '…')
}

export function toCurl(row: HttpRow): string {
  const parts = [`curl -X ${row.method} '${row.url.replace(/'/g, "'\\''")}'`]
  for (const [k, v] of Object.entries(row.reqHeaders)) {
    parts.push(`  -H '${`${k}: ${v}`.replace(/'/g, "'\\''")}'`)
  }
  if (row.reqBody) parts.push(`  --data-raw '${row.reqBody.replace(/'/g, "'\\''")}'`)
  return parts.join(' \\\n')
}

export function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  })
}

export function newRuleId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Split text into segments, flagging the http(s) URLs inside it. */
export function splitLinks(text: string): Array<{ text: string; link: boolean }> {
  const out: Array<{ text: string; link: boolean }> = []
  // stop at quotes/brackets so a URL embedded in raw JSON doesn't swallow `",`
  const re = /https?:\/\/[^\s"'`<>\\)\]}]+/g
  let from = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // trailing punctuation is almost always prose, not part of the URL
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (m.index > from) out.push({ text: text.slice(from, m.index), link: false })
    out.push({ text: url, link: true })
    from = m.index + url.length
  }
  if (from < text.length) out.push({ text: text.slice(from), link: false })
  return out
}

/** Split text into segments, flagging which match the query (case-insensitive). Blank query → the whole text as one non-match. */
export function splitHighlight(text: string, query: string): Array<{ text: string; match: boolean }> {
  const q = query.trim().toLowerCase()
  if (!q || !text) return text ? [{ text, match: false }] : []
  const out: Array<{ text: string; match: boolean }> = []
  const lower = text.toLowerCase()
  let from = 0
  let i = lower.indexOf(q, from)
  while (i !== -1) {
    if (i > from) out.push({ text: text.slice(from, i), match: false })
    out.push({ text: text.slice(i, i + q.length), match: true })
    from = i + q.length
    i = lower.indexOf(q, from)
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false })
  return out
}

/** Only nonempty JSON objects can add conditions; Socket.IO matches the first argument. */
export function jsonObjectCondition(text: string | null | undefined, firstArgument = false): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text ?? '')
    const value = firstArgument ? (Array.isArray(parsed) ? parsed[0] : undefined) : parsed
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      return JSON.stringify(value, null, 2)
    }
  } catch { /* Incomplete and non-JSON captures cannot seed conditions. */ }
  return undefined
}

/** Seed only explicitly selected constraints, separately from the mocked response. */
export function httpMockFromRequest(row: HttpRow, conditions: 'none' | 'query' | 'body' | 'both' = 'none'): HttpMockRule {
  const { path, query } = urlParts(row.url)
  return {
    id: newRuleId(), enabled: true, method: row.method, urlPattern: path,
    queryParams: conditions === 'query' || conditions === 'both' ? Object.fromEntries(query) : undefined,
    bodyMatch: !row.reqTruncated && (conditions === 'body' || conditions === 'both') ? jsonObjectCondition(row.reqBody) : undefined,
    status: row.status && row.status > 0 ? row.status : 200,
    headers: { 'content-type': row.respHeaders?.['content-type'] ?? 'application/json' },
    body: prettyJson(row.respBody), delayMs: 0, delayOnly: false,
  }
}

export function socketAckMockFromEvent(row: SocketRow, withPayload = false): SocketMockRule {
  return {
    id: newRuleId(), enabled: true, transport: 'socketio', event: row.event,
    ackPayload: row.ackPayload ?? '[{"ok":true}]', delayMs: 0,
    payloadMatch: withPayload ? jsonObjectCondition(row.payload, true) : undefined,
  }
}
