import { useEffect, useRef, useState } from 'react'

/**
 * Cmd/Ctrl+F find-in-page bar. Desktop (Electron) only: the browser already has its own,
 * so this renders nothing unless the desktop bridge exposes `find`.
 */
export function FindBar() {
  const desktop = window.snifferDesktop
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const supported = !!desktop?.find

  useEffect(() => {
    if (!supported) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setOpen(true)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [supported])

  useEffect(() => {
    if (!supported) return
    return desktop!.onFindResult!(setResult)
  }, [supported, desktop])

  if (!supported || !open) return null

  const search = (text: string) => {
    setQuery(text)
    if (text) {
      desktop!.find!(text, { first: true, forward: true })
    } else {
      desktop!.stopFind!()
      setResult(null)
    }
  }

  const step = (forward: boolean) => {
    if (query) desktop!.find!(query, { first: false, forward })
  }

  const close = () => {
    desktop!.stopFind!()
    setResult(null)
    setOpen(false)
  }

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="mono"
        placeholder="Find in page…"
        value={query}
        onChange={e => search(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') step(!e.shiftKey)
          if (e.key === 'Escape') close()
        }}
      />
      <span className="dim mono find-count">
        {query ? (result ? `${result.active}/${result.matches}` : '0/0') : ''}
      </span>
      <button className="ghost icon-btn" title="Previous (Shift+Enter)" onClick={() => step(false)}>↑</button>
      <button className="ghost icon-btn" title="Next (Enter)" onClick={() => step(true)}>↓</button>
      <button className="ghost icon-btn" title="Close (Esc)" onClick={close}>✕</button>
    </div>
  )
}
