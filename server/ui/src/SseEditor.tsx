import { useState } from 'react'
import type { MockSseEvent, MockSseStream } from './state'

export function SseEditor({ value, onChange }: { value: MockSseStream; onChange: (value: MockSseStream) => void }) {
  const [selected, setSelected] = useState(0)
  const index = Math.min(selected, value.events.length - 1)
  const event = { data: '', delayMs: 0, ...(value.events[index] as Partial<MockSseEvent>) }
  const update = (patch: Partial<MockSseEvent>) => onChange({ ...value, events: value.events.map((e, i) => i === index ? { ...e, ...patch } : e) })
  const move = (offset: number) => {
    const events = [...value.events]; const target = index + offset
    ;[events[index], events[target]] = [events[target], events[index]]
    onChange({ ...value, events }); setSelected(target)
  }
  return <>
    <div className="sequence-controls"><label className="field">After final event <select value={value.ending ?? 'close'} onChange={e => onChange({ ...value, ending: e.target.value as MockSseStream['ending'] })}>
      <option value="close">Close normally</option><option value="open">Keep connection open</option><option value="disconnect">Simulate disconnect</option>
    </select></label><span className="hint">200 / text/event-stream</span></div>
    <p className="hint">Each matching request starts a fresh stream. Delays are measured after the previous event; the first delay starts when response headers are returned.</p>
    {value.ending === 'disconnect' && <p className="hint warn">Abrupt disconnect may discard unread buffered data. Use Close normally to deliver all events.</p>}
    <div className="sequence-editor">
      <div className="sequence-list" role="group" aria-label="SSE events">
        {value.events.map((e, i) => <button key={i} aria-pressed={index === i} onClick={() => setSelected(i)}><strong>Event {i + 1}</strong><span>{e.event || 'message'} / +{e.delayMs ?? 0} ms</span></button>)}
        <button disabled={value.events.length >= 1000} onClick={() => { onChange({ ...value, events: [...value.events, { data: '{}', delayMs: 1000 }] }); setSelected(value.events.length) }}>Add event</button>
      </div>
      <div className="sequence-detail">
        <div className="sequence-controls"><strong>Event {index + 1}</strong><span className="spacer" />
          <button disabled={index === 0} onClick={() => move(-1)}>Move up</button><button disabled={index === value.events.length - 1} onClick={() => move(1)}>Move down</button>
          <button disabled={value.events.length === 1} onClick={() => onChange({ ...value, events: value.events.filter((_, i) => i !== index) })}>Remove</button>
        </div>
        <div className="sequence-controls">
          <label className="field">Event <input aria-label="SSE event name" placeholder="message" value={event.event ?? ''} onChange={e => update({ event: e.target.value.replace(/[\r\n\0]/g, '').slice(0, 1024) || undefined })} /></label>
          <label className="field">ID <input aria-label="SSE event ID" placeholder="Optional" value={event.id ?? ''} onChange={e => update({ id: e.target.value.replace(/[\r\n\0]/g, '').slice(0, 1024) || undefined })} /></label>
        </div>
        <div className="sequence-controls">
          <label className="field">Delay ms <input className="w-delay" type="number" min="0" max="300000" value={event.delayMs} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 300000) update({ delayMs: n }) }} /></label>
          <label className="field">Retry ms <input className="w-delay" aria-label="SSE retry ms" type="number" min="0" max="300000" placeholder="Optional" value={event.retry ?? ''} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 300000) update({ retry: e.target.value === '' ? undefined : n }) }} /></label>
        </div>
        <label className="field">Data</label><textarea className="mono rule-response-editor" rows={14} aria-label="SSE event data" value={event.data} maxLength={524288} onChange={e => update({ data: e.target.value })} />
        <p className="hint">Enter plain text or JSON. Sniffer adds the SSE field prefixes and blank line. Retry is a client reconnect hint, not an event delay.</p>
      </div>
    </div>
  </>
}
