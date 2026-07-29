import { useEffect, useRef, useState } from 'react'
import { addFilterValue, addOrEnableValue, filterActive, setAllEnabled, type TrafficFilter } from './trafficFilter'

/** Funnel button for a column header; opens a popover managing that column's noise filter. */
export function FilterMenu({ filter, onChange, placeholder, selectionValue }: {
  filter: TrafficFilter
  onChange: (filter: TrafficFilter) => void
  placeholder: string
  /** the value of the currently selected row, fed to "From selection" */
  selectionValue?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false)
    }
    // the popover is fixed-positioned: close instead of drifting when the list scrolls under it
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const toggleOpen = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 436)) })
    }
    setOpen(v => !v)
  }

  const add = () => {
    onChange(addFilterValue(filter, draft))
    setDraft('')
  }

  return (
    <span className="filter-anchor" ref={rootRef}>
      <button className="ghost icon-btn filter-btn" data-on={filterActive(filter) || undefined}
        title="Filter this column" onClick={toggleOpen}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
      </button>
      {open && pos && (
        <div className="filter-pop" ref={popRef} style={{ top: pos.top, left: pos.left }}>
          <div className="filter-add">
            <input className="mono" placeholder={placeholder} value={draft} autoFocus
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add() }} />
            <button className="filter-round" title="Add filter value" disabled={!draft.trim()} onClick={add}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </button>
          </div>
          {filter.items.length === 0 && <div className="hint">No filter values yet</div>}
          {filter.items.map((item, index) => (
            <div key={item.value} className="filter-item">
              <label className="toggle">
                <input type="checkbox" checked={item.enabled}
                  onChange={e => onChange({
                    ...filter,
                    items: filter.items.map((it, i) => i === index ? { ...it, enabled: e.target.checked } : it),
                  })} />
              </label>
              <span className="mono filter-value">{item.value}</span>
              <button className="filter-round filter-remove" title="Remove"
                onClick={() => onChange({ ...filter, items: filter.items.filter((_, i) => i !== index) })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12h8" />
                </svg>
              </button>
            </div>
          ))}
          <label className="filter-switch">
            <input type="checkbox" checked={filter.mode === 'exclude'}
              onChange={e => onChange({ ...filter, mode: e.target.checked ? 'exclude' : 'include' })} />
            <span className="track" aria-hidden><i /></span>
            Exclude items matching filter
          </label>
          <div className="filter-footer">
            <button className="filter-link" disabled={!selectionValue}
              title={selectionValue ? `Add "${selectionValue}"` : 'Select a row first'}
              onClick={() => selectionValue && onChange(addOrEnableValue(filter, selectionValue))}>
              From selection
            </button>
            <span className="spacer" />
            <button className="filter-link" disabled={filter.items.length === 0}
              title="Enable every value" onClick={() => onChange(setAllEnabled(filter, true))}>All</button>
            <button className="filter-link" disabled={filter.items.length === 0}
              title="Disable every value" onClick={() => onChange(setAllEnabled(filter, false))}>None</button>
          </div>
        </div>
      )}
    </span>
  )
}
