import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/** The main action always uses the fallback scope; menu choices apply once. */
export function MockAction({ label, scope, options, onDefault }: {
  label: string
  scope: string
  options: { label: string; description: string; disabled?: boolean; onSelect: () => void }[]
  onDefault: () => void
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => { setPos(null); trigger.current?.focus() }
  const open = () => {
    const rect = root.current!.getBoundingClientRect()
    setPos({ left: rect.left, top: rect.bottom + 5 })
  }
  useEffect(() => {
    if (!pos) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setPos(null)
    }
    const onScroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setPos(null)
    }
    const onResize = () => setPos(null)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [pos])
  useLayoutEffect(() => {
    if (!pos || !menu.current) return
    const el = menu.current
    el.style.left = `${Math.max(8, Math.min(pos.left, innerWidth - el.offsetWidth - 8))}px`
    el.style.top = `${Math.max(8, Math.min(pos.top, innerHeight - el.offsetHeight - 8))}px`
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [pos])
  return (
    <div className="mock-action" ref={root} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setPos(null)
    }}>
      <div className="mock-action-buttons">
        <button className="mock-action-main" title={`${label}: ${scope}`} onClick={() => { setPos(null); onDefault() }}>{label}</button>
        <button className="mock-action-trigger" ref={trigger} aria-label={`Choose conditions for ${label.toLowerCase()}`}
          aria-haspopup="menu" aria-expanded={!!pos} aria-controls={pos ? id : undefined}
          onClick={() => pos ? close() : open()} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); open() }
          }}><span aria-hidden>▾</span></button>
      </div>
      {pos && <div className="ctx-menu mock-action-menu" role="menu" id={id} aria-label="Mock conditions" ref={menu}
        style={pos} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
          buttons[next]?.focus()
        }}>
        {options.map(option => <button key={option.label} className="ctx-item" role="menuitem" disabled={option.disabled}
          onClick={() => { close(); option.onSelect() }}>
          <span>{option.label}</span><small>{option.description}</small>
        </button>)}
      </div>}
    </div>
  )
}
