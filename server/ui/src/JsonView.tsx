import { useState } from 'react'

// Collapsible JSON tree; falls back to raw text when the body isn't JSON.
export function JsonView({ text }: { text: string | null | undefined }) {
  const [raw, setRaw] = useState(false)
  if (!text) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return <pre className="body-pre">{text}</pre>
  }
  return (
    <div className="json-view">
      <button className="jn-toggle" onClick={() => setRaw(r => !r)}>{raw ? 'Tree' : 'Raw'}</button>
      {raw ? (
        <pre className="body-pre">{JSON.stringify(data, null, 2)}</pre>
      ) : (
        <div className="json-tree body-pre">
          <Node name={null} value={data} depth={0} />
        </div>
      )}
    </div>
  )
}

function Node({ name, value, depth }: { name: string | number | null; value: unknown; depth: number }) {
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
  const [open, setOpen] = useState(depth < 2)

  const key = name !== null ? <span className="jn-key">{name}</span> : null
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
          <span className="jn-chev" data-open={open || undefined}>▸</span>
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
              {entries.map(([k, v]) => <Node key={String(k)} name={k} value={v} depth={depth + 1} />)}
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
      <span className={'jn-val ' + valClass(value)}>{fmt(value)}</span>
    </div>
  )
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
