import { useEffect, useState } from 'react'

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
