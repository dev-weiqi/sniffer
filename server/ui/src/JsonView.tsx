import { Icon } from './Icon'
import { useEffect, useId, useState, type CSSProperties, type FocusEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { localTimestamp } from './util'
import { Highlight, LinkText } from './HttpView'

// Collapsible JSON tree; falls back to raw text when the body isn't JSON.
export function JsonView({ text, query = '', view, expandAll }: {
  text: string | null | undefined
  query?: string
  view?: 'raw' | 'tree'
  expandAll?: boolean | null
}) {
  const [raw, setRaw] = useState(false)
  if (!text) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return <pre className="body-pre"><LinkText text={text} query={query} /></pre>
  }
  const showRaw = view ? view === 'raw' : raw
  return (
    <div className="json-view">
      {!view && <button className="jn-toggle" onClick={() => setRaw(r => !r)}>{raw ? 'Tree' : 'Raw'}</button>}
      {showRaw ? (
        <pre className="body-pre"><LinkText text={JSON.stringify(data, null, 2)} query={query} /></pre>
      ) : (
        <div className="json-tree body-pre">
          <Node name={null} value={data} depth={0} query={query} expandAll={expandAll} />
        </div>
      )}
    </div>
  )
}

function Node({ name, value, depth, query, expandAll }: {
  name: string | number | null
  value: unknown
  depth: number
  query: string
  expandAll?: boolean | null
}) {
  // socket.io / double-encoded APIs often nest JSON inside string values —
  // parse those for display (Raw view keeps the literal truth)
  let display = value
  let fromString = false
  if (typeof value === 'string') {
    const t = value.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const inner = JSON.parse(t)
        if (inner !== null && typeof inner === 'object') {
          display = inner
          fromString = true
        }
      } catch { /* not JSON after all — show as plain string */ }
    }
  }
  const isArray = Array.isArray(display)
  const isObject = !isArray && display !== null && typeof display === 'object'
  const [open, setOpen] = useState(expandAll ?? depth < 2)
  useEffect(() => {
    if (expandAll !== null && expandAll !== undefined) setOpen(expandAll)
  }, [expandAll])

  const key = name !== null ? <span className="jn-key"><Highlight text={String(name)} query={query} /></span> : null
  const sep = name !== null ? <span className="jn-punc">: </span> : null

  if (isArray || isObject) {
    const entries: [string | number, unknown][] = isArray
      ? (display as unknown[]).map((v, i) => [i, v])
      : Object.entries(display as Record<string, unknown>)
    const openB = isArray ? '[' : '{'
    const closeB = isArray ? ']' : '}'
    return (
      <div className="jn-node">
        <div className="jn-head" onClick={() => setOpen(o => !o)}
          title={fromString ? 'String value containing JSON — parsed for display' : undefined}>
          <Icon name="chevron-right" size={14} className="jn-chev" data-open={open || undefined} />
          {key}{sep}
          {fromString && <span className="jn-str-mark">"</span>}
          <span className="jn-punc">{openB}</span>
          {!open && (
            <>
              <span className="jn-count">{entries.length}</span>
              <span className="jn-punc">{closeB}</span>
            </>
          )}
        </div>
        {open && (
          <>
            <div className="jn-children">
              {entries.map(([k, v]) => <Node key={String(k)} name={k} value={v} depth={depth + 1} query={query} expandAll={expandAll} />)}
            </div>
            <div className="jn-punc jn-close">{closeB}</div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="jn-node jn-leaf">
      <span className="jn-chev-spacer" />
      {key}{sep}
      <Value value={value} query={query} />
    </div>
  )
}

function Value({ value, query }: { value: unknown; query: string }) {
  const local = localTimestamp(value)
  const id = useId()
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useEffect(() => {
    if (!position) return
    const hide = () => setPosition(null)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); hide() }
    }
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('keydown', escape, true)
    }
  }, [position])
  const show = (event: MouseEvent<HTMLSpanElement> | FocusEvent<HTMLSpanElement>) => {
    if (!local) return
    const rect = event.currentTarget.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
      ...(window.innerHeight - rect.bottom >= 110 ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) })
  }
  return <>
    <span className={'jn-val ' + valClass(value) + (local ? ' jn-timestamp' : '')}
      tabIndex={local ? 0 : undefined} aria-describedby={local && position ? id : undefined}
      onMouseEnter={show} onFocus={show} onMouseLeave={() => setPosition(null)} onBlur={() => setPosition(null)}>
      <LinkText text={fmt(value)} query={query} />
    </span>
    {local && position && createPortal(<div className="jn-time-tooltip" role="tooltip" id={id} style={position}>
      <span className="dim">Local time</span>
      <div className="jn-local-time">{local}</div>
      <span className="dim">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
    </div>, document.body)}
  </>
}

function valClass(v: unknown): string {
  if (typeof v === 'string') return 'jn-string'
  if (typeof v === 'number') return 'jn-number'
  if (typeof v === 'boolean') return 'jn-boolean'
  if (v === null) return 'jn-null'
  return ''
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`
  if (v === null) return 'null'
  return String(v)
}
