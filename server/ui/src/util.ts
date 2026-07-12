import { useEffect, useState } from 'react'
import type { HttpRow } from './state'

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

/** Arrow-key selection over the visible row order; Esc clears. Skips key events from form fields. */
export function useListKeys(ids: string[], selectedId: string | null, select: (id: string | null) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'Escape') { select(null); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (ids.length === 0) return
      e.preventDefault()
      const i = selectedId ? ids.indexOf(selectedId) : -1
      const next = e.key === 'ArrowDown'
        ? Math.min(ids.length - 1, i + 1)
        : i === -1 ? 0 : Math.max(0, i - 1)
      select(ids[next])
      requestAnimationFrame(() => {
        document.querySelector('.list-scroll tr[data-selected]')?.scrollIntoView({ block: 'nearest' })
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ids, selectedId, select])
}

/** Draggable detail-pane width, persisted across sessions. */
export function useDetailWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sniffer-detail-w'))
    return saved >= 320 ? saved : 420
  })
  useEffect(() => { localStorage.setItem('sniffer-detail-w', String(width)) }, [width])
  const startDrag = (e: { preventDefault(): void }) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => {
      const max = Math.round(window.innerWidth * 0.6)
      setWidth(Math.min(max, Math.max(320, window.innerWidth - ev.clientX)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  return [width, startDrag] as const
}
