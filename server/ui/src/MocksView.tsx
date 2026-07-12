import { useEffect, useState } from 'react'
import type { HttpMockRule, Mocks, SocketConn, SocketMockRule } from './state'
import { api } from './state'
import { newRuleId } from './util'

type PushPrefill = { connectionId: string; event: string; payload: string }

const PlaceholderTokens = [
  { key: 'id', syntax: '${id}', label: 'unique id' },
  { key: 'randomString', syntax: '${randomString(length)}', label: 'lorem string with the length you enter' },
]

export function MocksView({ deviceId, mocks, conns, pendingRule, pendingSocketRule, pushPrefill, onPendingConsumed }: {
  deviceId: string | null
  mocks: Mocks
  conns: SocketConn[]
  pendingRule: HttpMockRule | null
  pendingSocketRule: SocketMockRule | null
  pushPrefill: PushPrefill | null
  onPendingConsumed: () => void
}) {
  const [draft, setDraft] = useState<Mocks>(mocks)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showPlaceholders, setShowPlaceholders] = useState(false)

  useEffect(() => {
    setDraft(mocks)
    setDirty(false)
  }, [deviceId])

  // sync from server when rules change and there are no unsaved local edits
  useEffect(() => {
    if (!dirty) setDraft(mocks)
  }, [mocks, dirty])

  // prefilled rules coming from the "Mock this request" / "Mock this event's ack" actions
  useEffect(() => {
    if (pendingRule && deviceId) {
      setDraft(d => ({ ...d, http: [...d.http, pendingRule] }))
      setDirty(true)
      onPendingConsumed()
    }
  }, [deviceId, pendingRule, onPendingConsumed])

  useEffect(() => {
    if (pendingSocketRule && deviceId) {
      setDraft(d => ({ ...d, socket: [...d.socket, pendingSocketRule] }))
      setDirty(true)
      onPendingConsumed()
    }
  }, [deviceId, pendingSocketRule, onPendingConsumed])

  const update = (next: Mocks) => {
    setDraft(next)
    setDirty(true)
  }

  // auto-save: edits sync to the daemon after a short pause -- no explicit save step
  useEffect(() => {
    if (!dirty || !deviceId) return
    const t = setTimeout(() => {
      api.saveMocks(deviceId, draft)
        .then(() => {
          setDirty(false)
          setSaved(true)
          setTimeout(() => setSaved(false), 1200)
        })
        .catch(() => { /* daemon unreachable: stay dirty, next edit retries */ })
    }, 600)
    return () => clearTimeout(t)
  }, [draft, dirty, deviceId])

  if (!deviceId) {
    return <div className="empty">Connect a device to manage mocks</div>
  }

  return (
    <div className="mocks-pane">
      <div className="mocks-toolbar">
        <button className="pill-btn" onClick={() => setShowPlaceholders(v => !v)}>
          {showPlaceholders ? 'Hide placeholders' : 'Placeholders'}
        </button>
        <span className="spacer" />
        <span className="dim">{dirty ? 'Saving…' : saved ? 'Saved ✓' : 'Synced'}</span>
      </div>
      {showPlaceholders && <PlaceholderGuide />}

      <div className="mocks-columns">
        <section className="mocks-column http-column">
          <div className="mocks-section-head">
            <h2>HTTP rules</h2>
            {draft.http.length > 0 && (
              <button className="ghost danger"
                onClick={() => { if (confirm('Clear all HTTP mock rules?')) update({ ...draft, http: [] }) }}>Clear all</button>
            )}
          </div>
          {draft.http.map((r, i) => (
            <HttpRuleEditor key={r.id} rule={r}
              onChange={next => update({ ...draft, http: draft.http.map((x, j) => j === i ? next : x) })}
              onDelete={() => update({ ...draft, http: draft.http.filter((_, j) => j !== i) })}
            />
          ))}
          <button className="ghost add" onClick={() => update({
            ...draft,
            http: [...draft.http, {
              id: newRuleId(), enabled: true, method: null, urlPattern: '/api/',
              status: 200, headers: { 'content-type': 'application/json' }, body: '{}', delayMs: 0, delayOnly: false,
            }],
          })}>+ Add HTTP rule</button>
        </section>

        <section className="mocks-column socket-column">
          <div className="mocks-section-head">
            <h2>Socket ack rules</h2>
            {draft.socket.length > 0 && (
              <button className="ghost danger"
                onClick={() => { if (confirm('Clear all socket mock rules?')) update({ ...draft, socket: [] }) }}>Clear all</button>
            )}
          </div>
          {draft.socket.map((r, i) => (
            <SocketRuleEditor key={r.id} rule={r}
              onChange={next => update({ ...draft, socket: draft.socket.map((x, j) => j === i ? next : x) })}
              onDelete={() => update({ ...draft, socket: draft.socket.filter((_, j) => j !== i) })}
            />
          ))}
          <button className="ghost add" onClick={() => update({
            ...draft,
            socket: [...draft.socket, { id: newRuleId(), enabled: true, transport: 'socketio' as const, event: '', ackPayload: '[{"ok":true}]', delayMs: 0 }],
          })}>+ Add socket rule</button>
        </section>

        <section className="mocks-column push-column">
          <div className="mocks-section-head">
            <h2>Push Server → Client event</h2>
          </div>
          <PushEventPanel conns={conns} deviceId={deviceId} prefill={pushPrefill} onConsumed={onPendingConsumed} />
        </section>
      </div>
    </div>
  )
}

function PushEventPanel({ conns, deviceId, prefill, onConsumed }: {
  conns: SocketConn[]
  deviceId: string
  prefill: PushPrefill | null
  onConsumed: () => void
}) {
  const [target, setTarget] = useState('')
  const [event, setEvent] = useState('')
  const [payload, setPayload] = useState('{}')
  const [status, setStatus] = useState<'sent' | 'error' | null>(null)

  useEffect(() => {
    if (prefill) {
      setTarget(prefill.connectionId)
      setEvent(prefill.event)
      setPayload(prefill.payload)
      setStatus(null)
      onConsumed()
    }
  }, [prefill, onConsumed])

  const liveOptions = conns.filter(c => c.deviceId === deviceId && c.status === 'connected').map(c => ({
    key: c.connectionId,
    label: `${c.transport} · ${c.url || c.connectionId.slice(0, 8)}`,
    disabled: false,
  }))
  const targetMissing = Boolean(target && !liveOptions.some(o => o.key === target))
  const options = [
    { key: '', label: 'All connections', disabled: false },
    ...liveOptions,
    ...(targetMissing ? [{ key: target, label: 'Original connection is not active', disabled: true }] : []),
  ]

  const send = async () => {
    if (!event || targetMissing) return
    const res = await api.pushEvent(deviceId, target || null, event, payload)
    setStatus(res.ok ? 'sent' : 'error')
    setTimeout(() => setStatus(null), 1600)
  }

  const clear = () => {
    setTarget('')
    setEvent('')
    setPayload('{}')
    setStatus(null)
  }

  return (
    <div className="rule-card">
      <div className="rule-row">
        <select value={target} onChange={e => setTarget(e.target.value)}>
          {options.map(o => <option key={o.key} value={o.key} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <input className="grow mono" placeholder="event name (e.g. chat:new)" value={event}
          onChange={e => setEvent(e.target.value)} />
        <button className="ghost" onClick={clear}>Clear</button>
        <button disabled={!event || targetMissing} onClick={send}>
          {status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Failed' : 'Send'}
        </button>
      </div>
      {targetMissing && (
        <div className="dim hint">The original connection is no longer active. Clear the target or choose All connections.</div>
      )}
      {!targetMissing && liveOptions.length === 0 && (
        <div className="dim hint">No active socket connections for this device; All connections will send when the SDK has a live socket.</div>
      )}
      <textarea className="mono" rows={3} placeholder="payload (JSON or plain text)" value={payload}
        onChange={e => setPayload(e.target.value)} />
      <div className="rule-body-tools">
        <JsonTool label="Pretty JSON" body={payload} transform={v => JSON.stringify(v, null, 2)} onResult={setPayload} />
        <PlaceholderTools onInsert={token => setPayload(p => p + token)} />
      </div>
    </div>
  )
}

function HttpRuleEditor({ rule, onChange, onDelete }: {
  rule: HttpMockRule
  onChange: (r: HttpMockRule) => void
  onDelete: () => void
}) {
  const [sub, setSub] = useState<'body' | 'headers'>('body')
  const headerCount = Object.keys(rule.headers).length
  return (
    <div className="rule-card" data-disabled={!rule.enabled || undefined}>
      <div className="rule-row">
        <label className="toggle">
          <input type="checkbox" checked={rule.enabled} onChange={e => onChange({ ...rule, enabled: e.target.checked })} />
        </label>
        <select value={rule.method ?? ''} onChange={e => onChange({ ...rule, method: e.target.value || null })}>
          <option value="">ANY</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
        </select>
        <input className="grow mono" placeholder="URL contains… (substring)" value={rule.urlPattern}
          onChange={e => onChange({ ...rule, urlPattern: e.target.value })} />
        {!rule.delayOnly && (
          <label className="field">status
            <NumberField className="mono w-status" value={rule.status} fallback={200}
              onCommit={n => onChange({ ...rule, status: n })} />
          </label>
        )}
        <label className="field">delay ms
          <NumberField className="mono w-delay" value={rule.delayMs} fallback={0}
            onCommit={n => onChange({ ...rule, delayMs: n })} />
        </label>
        <label className="field checkbox-field" title="Let the real request run, only inject the delay">
          <input type="checkbox" checked={rule.delayOnly}
            onChange={e => onChange({ ...rule, delayOnly: e.target.checked })} />
          delay only
        </label>
        <button className="ghost" onClick={() => { if (confirm('Delete this rule?')) onDelete() }}>Delete</button>
      </div>
      {rule.delayOnly ? (
        <div className="dim hint">Real response passes through untouched; only the {rule.delayMs} ms delay is injected.</div>
      ) : (
        <>
          <div className="rule-tabs">
            <button type="button" data-active={sub === 'body' || undefined} onClick={() => setSub('body')}>Body</button>
            <button type="button" data-active={sub === 'headers' || undefined} onClick={() => setSub('headers')}>
              Headers{headerCount > 0 && <span className="count">{headerCount}</span>}
            </button>
          </div>
          {sub === 'body' ? (
            <>
              <textarea className="mono" rows={5} placeholder="response body" value={rule.body}
                onChange={e => onChange({ ...rule, body: e.target.value })} />
              <div className="rule-body-tools">
                <JsonTool label="Pretty JSON" body={rule.body} transform={v => JSON.stringify(v, null, 2)}
                  onResult={body => onChange({ ...rule, body })} />
                <PlaceholderTools onInsert={token => onChange({ ...rule, body: rule.body + token })} />
              </div>
            </>
          ) : (
            <HeadersEditor value={rule.headers} onChange={headers => onChange({ ...rule, headers })} />
          )}
        </>
      )}
    </div>
  )
}

// Editable response headers (key/value rows). Empty-key rows are dropped from the saved rule.
function HeadersEditor({ value, onChange }: {
  value: Record<string, string>
  onChange: (h: Record<string, string>) => void
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value))
  const commit = (next: [string, string][]) => {
    setRows(next)
    const obj: Record<string, string> = {}
    for (const [k, v] of next) if (k.trim()) obj[k] = v
    onChange(obj)
  }
  return (
    <div className="headers-editor">
      {rows.map(([k, v], i) => (
        <div className="header-row" key={i}>
          <input className="mono" placeholder="Header" value={k}
            onChange={e => commit(rows.map((r, j): [string, string] => (j === i ? [e.target.value, r[1]] : r)))} />
          <input className="grow mono" placeholder="Value" value={v}
            onChange={e => commit(rows.map((r, j): [string, string] => (j === i ? [r[0], e.target.value] : r)))} />
          <button className="ghost" title="Remove header" onClick={() => commit(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="ghost add" onClick={() => commit([...rows, ['', '']])}>+ Add header</button>
    </div>
  )
}

// Numeric field that can be fully cleared while typing; coerces to a valid number on blur
// (empty -> fallback: status 200, delay 0). No spinners.
function NumberField({ value, fallback, className, onCommit }: {
  value: number
  fallback: number
  className?: string
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  return (
    <input
      className={className}
      inputMode="numeric"
      value={text}
      onChange={e => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => {
        const n = text === '' ? fallback : Number(text)
        setText(String(n))
        onCommit(n)
      }}
    />
  )
}

function JsonTool({ label, body, transform, onResult }: {
  label: string
  body: string
  transform: (v: unknown) => string
  onResult: (body: string) => void
}) {
  const [bad, setBad] = useState(false)
  const run = () => {
    try {
      onResult(transform(JSON.parse(body)))
    } catch {
      setBad(true)
      setTimeout(() => setBad(false), 1200)
    }
  }
  return <button className="pill-btn" onClick={run}>{bad ? 'Invalid JSON' : label}</button>
}

function SocketRuleEditor({ rule, onChange, onDelete }: {
  rule: SocketMockRule
  onChange: (r: SocketMockRule) => void
  onDelete: () => void
}) {
  return (
    <div className="rule-card" data-disabled={!rule.enabled || undefined}>
      <div className="rule-row">
        <label className="toggle">
          <input type="checkbox" checked={rule.enabled} onChange={e => onChange({ ...rule, enabled: e.target.checked })} />
        </label>
        <select value={rule.transport} onChange={e => onChange({ ...rule, transport: e.target.value as SocketMockRule['transport'] })}>
          <option value="socketio">sio ack</option>
          <option value="ktor-ws">ws reply</option>
        </select>
        <input className="grow mono" placeholder={rule.transport === 'socketio' ? 'event name' : 'frame contains…'}
          value={rule.event} onChange={e => onChange({ ...rule, event: e.target.value })} />
        <label className="field">delay ms
          <NumberField className="mono w-delay" value={rule.delayMs} fallback={0}
            onCommit={n => onChange({ ...rule, delayMs: n })} />
        </label>
        <button className="ghost" onClick={() => { if (confirm('Delete this rule?')) onDelete() }}>Delete</button>
      </div>
      <div className="rule-tabs">
        <button type="button" data-active>
          {rule.transport === 'socketio' ? 'Ack payload' : 'Reply frame'}
        </button>
      </div>
      <textarea className="mono" rows={5}
        placeholder={rule.transport === 'socketio' ? 'ack payload (JSON array = multiple args)' : 'fake reply frame (raw text)'}
        value={rule.ackPayload} onChange={e => onChange({ ...rule, ackPayload: e.target.value })} />
      <div className="rule-body-tools">
        <JsonTool label="Pretty JSON" body={rule.ackPayload} transform={v => JSON.stringify(v, null, 2)}
          onResult={ackPayload => onChange({ ...rule, ackPayload })} />
        <PlaceholderTools onInsert={token => onChange({ ...rule, ackPayload: rule.ackPayload + token })} />
      </div>
    </div>
  )
}

function PlaceholderGuide() {
  return (
    <div className="rule-card placeholder-guide">
      <div className="hint">Placeholders are expanded on the device every time a mock matches.</div>
      <div className="placeholder-list">
        {PlaceholderTokens.map(item => (
          <div key={item.key} className="placeholder-item">
            <code className="placeholder-token">{item.syntax}</code>
            <span className="dim">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PlaceholderTools({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <>
      {PlaceholderTokens.map(item => (
        <button key={item.key} className="pill-btn" title={item.label} onClick={() => {
          const token = buildPlaceholderToken(item.key)
          if (token) onInsert(token)
        }}>
          {item.syntax}
        </button>
      ))}
    </>
  )
}

function buildPlaceholderToken(key: string): string | null {
  if (key === 'id') return '${id}'
  if (key === 'randomString') {
    const length = promptWholeNumber('Random string length')
    return length === null ? null : `\${randomString(${length})}`
  }
  return null
}

function promptWholeNumber(label: string): number | null {
  const value = prompt(label)
  if (value === null) return null
  const n = Number(value.trim())
  if (!Number.isInteger(n) || n < 0) {
    alert('Enter a whole number.')
    return null
  }
  return n
}

function promptRange(): { min: number; max: number } | null {
  const value = prompt('Random number range (min~max)')
  if (value === null) return null
  const match = value.trim().match(/^(-?\d+)\s*~\s*(-?\d+)$/)
  if (!match) {
    alert('Enter a range like min~max.')
    return null
  }
  const min = Number(match[1])
  const max = Number(match[2])
  if (min > max) {
    alert('Minimum must be less than or equal to maximum.')
    return null
  }
  return { min, max }
}
