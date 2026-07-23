import type { HttpRow } from './state.js'

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
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

export function statusClass(status: number | undefined, error?: string | null): string {
  if (error) return 'st-err'
  if (status === undefined) return 'st-pending'
  if (status === 0 || status >= 500) return 'st-err'
  if (status >= 400) return 'st-warn'
  if (status >= 300) return 'st-info'
  return 'st-ok'
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
