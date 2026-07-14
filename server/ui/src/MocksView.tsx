import { useEffect, useRef, useState } from 'react'
import type { HttpMockRule, Mocks, SocketConn, SocketMockRule } from './state'
import { api } from './state'
import { newRuleId } from './util'
import { useConfirm } from './Confirm'

type PushPrefill = { connectionId: string; event: string; payload: string }

const PlaceholderTokens = [
  { key: 'id', syntax: '${id}', label: 'unique id' },
  { key: 'randomString', syntax: '${randomString(length)}', label: 'lorem string with the length you enter' },
]


const httpSig = (r: HttpMockRule) => `${r.method ?? 'ANY'}|${r.urlPattern}`
const socketSig = (r: SocketMockRule) => `${r.transport}|${r.event}`

/** ids of enabled rules whose matcher collides with another enabled rule */
function duplicateIds<T extends { id: string; enabled: boolean }>(rules: T[], sig: (r: T) => string): Set<string> {
  const groups = new Map<string, T[]>()
  for (const r of rules) if (r.enabled) groups.set(sig(r), [...(groups.get(sig(r)) ?? []), r])
  const out = new Set<string>()
  for (const g of groups.values()) if (g.length > 1) for (const r of g) out.add(r.id)
  return out
}

/** SDK matching is first-wins: reorder duplicates newest-first in the sync payload only,
    so the newest rule takes effect while the on-screen order stays put */
function orderForSync(mocks: Mocks): Mocks {
  const reorder = <T extends { id: string; enabled: boolean; createdAt?: number }>(rules: T[], sig: (r: T) => string): T[] => {
    const dups = duplicateIds(rules, sig)
    if (dups.size === 0) return rules
    const slots = rules.map((r, i) => ({ r, i }))
    const groups = new Map<string, { r: T; i: number }[]>()
    for (const slot of slots) if (dups.has(slot.r.id)) {
      const k = sig(slot.r)
      groups.set(k, [...(groups.get(k) ?? []), slot])
    }
    const next = [...rules]
    for (const g of groups.values()) {
      const sorted = [...g].sort((a, b) => (b.r.createdAt ?? 0) - (a.r.createdAt ?? 0))
      g.forEach((slot, idx) => { next[slot.i] = sorted[idx].r })
    }
    return next
  }
  return {
    http: reorder(mocks.http as (HttpMockRule & { enabled: boolean })[], httpSig as never),
    socket: reorder(mocks.socket as (SocketMockRule & { enabled: boolean })[], socketSig as never),
  }
}



function TagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24H4a1 1 0 0 0-1 1v5.59c0 .53.21 1.04.59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.83z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function MocksView({ deviceId, mocks, conns, pendingRule, pendingSocketRule, pushPrefill, onPendingConsumed }: {
  deviceId: string | null
  mocks: Mocks
  conns: SocketConn[]
  pendingRule: HttpMockRule | null
  pendingSocketRule: SocketMockRule | null
  pushPrefill: PushPrefill | null
  onPendingConsumed: () => void
}) {
  const confirm = useConfirm()
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
      // click-to-prefill lands on top so it's immediately visible
      setDraft(d => ({ ...d, http: [{ ...pendingRule, createdAt: Date.now() }, ...d.http] }))
      setDirty(true)
      onPendingConsumed()
    }
  }, [deviceId, pendingRule, onPendingConsumed])

  useEffect(() => {
    if (pendingSocketRule && deviceId) {
      setDraft(d => ({ ...d, socket: [{ ...pendingSocketRule, createdAt: Date.now() }, ...d.socket] }))
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
      api.saveMocks(deviceId, orderForSync(draft))
        .then(() => {
          setDirty(false)
          setSaved(true)
          setTimeout(() => setSaved(false), 1200)
        })
        .catch(() => { /* daemon unreachable: stay dirty, next edit retries */ })
    }, 600)
    return () => clearTimeout(t)
  }, [draft, dirty, deviceId])

  const importRef = useRef<HTMLInputElement>(null)

  const exportRules = () => {
    const blob = new Blob(
      [JSON.stringify({ http: draft.http, socket: draft.socket }, null, 2)],
      { type: 'application/json' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `sniffer-mocks-${deviceId}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // appends (with fresh ids) instead of replacing, so an import can never destroy rules;
  // Clear all first for replace semantics
  const importRules = (file: File) => {
    file.text().then(text => {
      const v = JSON.parse(text) as Partial<Mocks>
      const http = Array.isArray(v.http) ? v.http : []
      const socket = Array.isArray(v.socket) ? v.socket : []
      if (http.length + socket.length === 0) return
      update({
        ...draft,
        http: [...draft.http, ...http.map(r => ({ ...r, id: newRuleId() }))],
        socket: [...draft.socket, ...socket.map(r => ({ ...r, id: newRuleId() }))],
      })
    }).catch(() => alert('Not a valid mock rules JSON file'))
  }

  const httpDups = duplicateIds(draft.http, httpSig)
  const socketDups = duplicateIds(draft.socket, socketSig)

  if (!deviceId) {
    return <div className="empty">Connect a device to manage mocks</div>
  }

  return (
    <div className="mocks-pane">
      <div className="mocks-toolbar">
        <button className="pill-btn" onClick={() => setShowPlaceholders(v => !v)}>
          {showPlaceholders ? 'Hide placeholders' : 'Placeholders'}
        </button>
        <button className="pill-btn" disabled={draft.http.length + draft.socket.length === 0}
          onClick={exportRules}>Export</button>
        <button className="pill-btn" onClick={() => importRef.current?.click()}>Import</button>
        <input ref={importRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) importRules(f)
            e.target.value = ''
          }} />
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
                onClick={async () => { if (await confirm('Clear all HTTP mock rules?', 'Clear all')) update({ ...draft, http: [] }) }}>Clear all</button>
            )}
          </div>
          {draft.http.map((r, i) => (
            <HttpRuleEditor key={r.id} rule={r} dup={httpDups.has(r.id)}
              onDuplicate={() => update({ ...draft, http: [
                ...draft.http.slice(0, i + 1),
                { ...r, id: newRuleId(), createdAt: Date.now() },
                ...draft.http.slice(i + 1),
              ] })}
              onChange={next => update({ ...draft, http: draft.http.map((x, j) => j === i ? next : x) })}
              onDelete={() => update({ ...draft, http: draft.http.filter((_, j) => j !== i) })}
            />
          ))}
          <button className="ghost add" onClick={() => update({
            ...draft,
            http: [...draft.http, {
              id: newRuleId(), createdAt: Date.now(), enabled: true, method: null, urlPattern: '/api/',
              status: 200, headers: { 'content-type': 'application/json' }, body: '{}', delayMs: 0, delayOnly: false,
            }],
          })}>+ Add HTTP rule</button>
        </section>

        <section className="mocks-column socket-column">
          <div className="mocks-section-head">
            <h2>Socket ack rules</h2>
            {draft.socket.length > 0 && (
              <button className="ghost danger"
                onClick={async () => { if (await confirm('Clear all socket mock rules?', 'Clear all')) update({ ...draft, socket: [] }) }}>Clear all</button>
            )}
          </div>
          {draft.socket.map((r, i) => (
            <SocketRuleEditor key={r.id} rule={r} dup={socketDups.has(r.id)}
              onDuplicate={() => update({ ...draft, socket: [
                ...draft.socket.slice(0, i + 1),
                { ...r, id: newRuleId(), createdAt: Date.now() },
                ...draft.socket.slice(i + 1),
              ] })}
              onChange={next => update({ ...draft, socket: draft.socket.map((x, j) => j === i ? next : x) })}
              onDelete={() => update({ ...draft, socket: draft.socket.filter((_, j) => j !== i) })}
            />
          ))}
          <button className="ghost add" onClick={() => update({
            ...draft,
            socket: [...draft.socket, { id: newRuleId(), createdAt: Date.now(), enabled: true, transport: 'socketio' as const, event: '', ackPayload: '[{"ok":true}]', delayMs: 0 }],
          })}>+ Add socket rule</button>
        </section>

        <section className="mocks-column push-column">
          <PushEventPanel conns={conns} deviceId={deviceId} prefill={pushPrefill} onConsumed={onPendingConsumed} />
        </section>
      </div>
    </div>
  )
}

type PushRecord = { id: string; target: string; event: string; payload: string; name?: string }

function PushEventPanel({ conns, deviceId, prefill, onConsumed }: {
  conns: SocketConn[]
  deviceId: string
  prefill: PushPrefill | null
  onConsumed: () => void
}) {
  // ponytail: push records are a UI convenience, persisted per-device in localStorage;
  // move into the daemon mock store if cross-browser sharing ever matters
  const confirm = useConfirm()
  const storageKey = `sniffer-push-${deviceId}`
  const [records, setRecords] = useState<PushRecord[]>(() => loadRecords(storageKey))

  useEffect(() => { setRecords(loadRecords(storageKey)) }, [storageKey])
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(records)) }, [records, storageKey])

  useEffect(() => {
    if (prefill) {
      setRecords(rs => [{ id: newRuleId(), target: prefill.connectionId, event: prefill.event, payload: prefill.payload }, ...rs])
      onConsumed()
    }
  }, [prefill, onConsumed])

  return (
    <>
      <div className="mocks-section-head">
        <h2>Push Server → Client event</h2>
        {records.length > 0 && (
          <button className="ghost danger"
            onClick={async () => { if (await confirm('Clear all push events?', 'Clear all')) setRecords([]) }}>Clear all</button>
        )}
      </div>
      {records.map(r => (
        <PushRecordCard key={r.id} record={r} conns={conns} deviceId={deviceId}
          onChange={next => setRecords(rs => rs.map(x => x.id === r.id ? next : x))}
          onDelete={() => setRecords(rs => rs.filter(x => x.id !== r.id))}
          onDuplicate={() => setRecords(rs => {
            const i = rs.findIndex(x => x.id === r.id)
            return [...rs.slice(0, i + 1), { ...r, id: newRuleId() }, ...rs.slice(i + 1)]
          })}
        />
      ))}
      <button className="ghost add" onClick={() =>
        setRecords(rs => [...rs, { id: newRuleId(), target: '', event: '', payload: '{}' }])
      }>+ Add push event</button>
    </>
  )
}

function loadRecords(key: string): PushRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function PushRecordCard({ record, conns, deviceId, onChange, onDelete, onDuplicate }: {
  record: PushRecord
  conns: SocketConn[]
  deviceId: string
  onChange: (r: PushRecord) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const confirm = useConfirm()
  const [status, setStatus] = useState<'sent' | 'error' | null>(null)
  const payloadRef = useRef<HTMLTextAreaElement>(null)

  const liveOptions = conns.filter(c => c.deviceId === deviceId && c.status === 'connected').map(c => ({
    key: c.connectionId,
    label: `${c.transport} · ${c.url || c.connectionId.slice(0, 8)}`,
    disabled: false,
  }))
  const targetMissing = Boolean(record.target && !liveOptions.some(o => o.key === record.target))
  const options = [
    { key: '', label: 'All connections', disabled: false },
    ...liveOptions,
    ...(targetMissing ? [{ key: record.target, label: 'Original connection is not active', disabled: true }] : []),
  ]

  const send = async () => {
    if (!record.event || targetMissing) return
    const res = await api.pushEvent(deviceId, record.target || null, record.event, record.payload)
    setStatus(res.ok ? 'sent' : 'error')
    setTimeout(() => setStatus(null), 1600)
  }

  return (
    <div className="rule-card">
      <div className="rule-name-row">
        <TagIcon />
        <input className="rule-name" placeholder="name this push… (optional)" value={record.name ?? ''}
          onChange={e => onChange({ ...record, name: e.target.value || undefined })} />
      </div>
      <div className="rule-row">
        <select value={record.target} onChange={e => onChange({ ...record, target: e.target.value })}>
          {options.map(o => <option key={o.key} value={o.key} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <input className="grow mono" placeholder="event name (e.g. chat:new)" value={record.event}
          onChange={e => onChange({ ...record, event: e.target.value })} />
        <button className="ghost icon-btn" title="Duplicate" onClick={onDuplicate}><CopyIcon /></button>
        <button className="ghost icon-btn danger" title="Delete"
          onClick={async () => { if (await confirm('Delete this push event?', 'Delete')) onDelete() }}><TrashIcon /></button>
        <button disabled={!record.event || targetMissing} onClick={send}>
          {status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Failed' : 'Send'}
        </button>
      </div>
      {targetMissing && (
        <div className="dim hint">The original connection is no longer active. Clear the target or choose All connections.</div>
      )}
      {!targetMissing && liveOptions.length === 0 && (
        <div className="dim hint">No active socket connections for this device; All connections will send when the SDK has a live socket.</div>
      )}
      <textarea ref={payloadRef} className="mono" rows={3} placeholder="payload (JSON or plain text)" value={record.payload}
        onChange={e => onChange({ ...record, payload: e.target.value })} />
      <div className="rule-body-tools">
        <JsonTool label="Pretty JSON" body={record.payload} transform={v => JSON.stringify(v, null, 2)} onResult={p => onChange({ ...record, payload: p })} />
        <PlaceholderTools value={record.payload} onValue={payload => onChange({ ...record, payload })} taRef={payloadRef} />
      </div>
    </div>
  )
}

function HttpRuleEditor({ rule, dup, onChange, onDelete, onDuplicate }: {
  rule: HttpMockRule
  dup: boolean
  onChange: (r: HttpMockRule) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const confirm = useConfirm()
  const [sub, setSub] = useState<'body' | 'headers'>('body')
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const headerCount = Object.keys(rule.headers).length
  return (
    <div className="rule-card" data-disabled={!rule.enabled || undefined}>
      <div className="rule-name-row">
        <TagIcon />
        <input className="rule-name" placeholder="name this rule… (optional)" value={rule.name ?? ''}
          onChange={e => onChange({ ...rule, name: e.target.value || undefined })} />
      </div>
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
        <button className="ghost icon-btn" title="Duplicate rule" onClick={onDuplicate}><CopyIcon /></button>
        <button className="ghost icon-btn danger" title="Delete rule"
          onClick={async () => { if (await confirm('Delete this rule?', 'Delete')) onDelete() }}><TrashIcon /></button>
      </div>
      {dup && <div className="hint dup-warning">⚠ Another enabled rule has the same matcher — the newest one takes effect.</div>}
      <div className="rule-tabs">
        {!rule.delayOnly && (
          <>
            <button type="button" data-active={sub === 'body' || undefined} onClick={() => setSub('body')}>Body</button>
            <button type="button" data-active={sub === 'headers' || undefined} onClick={() => setSub('headers')}>
              Headers{headerCount > 0 && <span className="count">{headerCount}</span>}
            </button>
          </>
        )}
        <span className="spacer" />
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
      </div>
      {rule.delayOnly ? (
        <div className="dim hint">Real response passes through untouched; only the {rule.delayMs} ms delay is injected.</div>
      ) : (
        <>
          {sub === 'body' ? (
            <>
              <textarea ref={bodyRef} className="mono" rows={5} placeholder="response body" value={rule.body}
                onChange={e => onChange({ ...rule, body: e.target.value })} />
              <div className="rule-body-tools">
                <JsonTool label="Pretty JSON" body={rule.body} transform={v => JSON.stringify(v, null, 2)}
                  onResult={body => onChange({ ...rule, body })} />
                <PlaceholderTools value={rule.body} onValue={body => onChange({ ...rule, body })} taRef={bodyRef} />
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

function SocketRuleEditor({ rule, dup, onChange, onDelete, onDuplicate }: {
  rule: SocketMockRule
  dup: boolean
  onChange: (r: SocketMockRule) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const confirm = useConfirm()
  const ackRef = useRef<HTMLTextAreaElement>(null)
  return (
    <div className="rule-card" data-disabled={!rule.enabled || undefined}>
      <div className="rule-name-row">
        <TagIcon />
        <input className="rule-name" placeholder="name this rule… (optional)" value={rule.name ?? ''}
          onChange={e => onChange({ ...rule, name: e.target.value || undefined })} />
      </div>
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
        <button className="ghost icon-btn" title="Duplicate rule" onClick={onDuplicate}><CopyIcon /></button>
        <button className="ghost icon-btn danger" title="Delete rule"
          onClick={async () => { if (await confirm('Delete this rule?', 'Delete')) onDelete() }}><TrashIcon /></button>
      </div>
      {dup && <div className="hint dup-warning">⚠ Another enabled rule has the same matcher — the newest one takes effect.</div>}
      <div className="rule-tabs">
        <button type="button" data-active>
          {rule.transport === 'socketio' ? 'Ack payload' : 'Reply frame'}
        </button>
      </div>
      <textarea ref={ackRef} className="mono" rows={5}
        placeholder={rule.transport === 'socketio' ? 'ack payload (JSON array = multiple args)' : 'fake reply frame (raw text)'}
        value={rule.ackPayload} onChange={e => onChange({ ...rule, ackPayload: e.target.value })} />
      <div className="rule-body-tools">
        <JsonTool label="Pretty JSON" body={rule.ackPayload} transform={v => JSON.stringify(v, null, 2)}
          onResult={ackPayload => onChange({ ...rule, ackPayload })} />
        <PlaceholderTools value={rule.ackPayload} onValue={ackPayload => onChange({ ...rule, ackPayload })} taRef={ackRef} />
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

function PlaceholderTools({ value, onValue, taRef }: {
  value: string
  onValue: (next: string) => void
  taRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const insert = (token: string) => {
    const ta = taRef.current
    // insert at the textarea's cursor (selection survives the button click's blur)
    const start = ta?.selectionStart ?? value.length
    const end = ta?.selectionEnd ?? start
    onValue(value.slice(0, start) + token + value.slice(end))
    if (ta) requestAnimationFrame(() => {
      ta.focus()
      const pos = start + token.length
      ta.setSelectionRange(pos, pos)
    })
  }
  return (
    <>
      {PlaceholderTokens.map(item => (
        <button key={item.key} className="pill-btn" title={item.label} onClick={() => {
          const token = buildPlaceholderToken(item.key)
          if (token) insert(token)
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
