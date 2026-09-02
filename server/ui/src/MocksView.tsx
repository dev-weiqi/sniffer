import { useCallback, useEffect, useRef, useState } from 'react'
import type { HttpMockRule, Mocks, SocketConn, SocketMockRule } from './state'
import { api } from './state'
import { newRuleId, prettyJson, prettySocketRule, unwrapJsonString, wrapJsonString } from './util'
import { applyOrder, byOrder, loadIds, loadOrder, orderOf, saveIds, saveOrder } from './mockOrder'
import { pointAt, resolvePushTarget } from './pushTarget'
import { buildExportRules, countImportedRules, countSelectedRules, createFullExportSelection, importedCopies, parseImportedRules, type ExportRuleSelection, type ExportRulesSource, type PushEventRule } from './exportMocks'

type PushPrefill = { connectionId: string; event: string; payload: string }

const PlaceholderTokens = [
  { key: 'randomId', syntax: '${randomId}', label: 'unique random id' },
  { key: 'now', syntax: '${now}', label: 'current time, ISO-8601 UTC' },
  { key: 'randomString', syntax: '${randomString(min~max)}', label: 'lorem string, random length in the range you enter' },
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


/** Rules arrive minified from wherever they were captured; show them pretty-printed. Non-JSON
    (placeholders on their own, raw ws reply frames) is left byte-for-byte alone. */
function beautified(mocks: Mocks): Mocks {
  return {
    http: mocks.http.map(r => ({ ...r, body: prettyJson(r.body) })),
    socket: mocks.socket.map(prettySocketRule),
  }
}

function TagIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
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

function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
    </svg>
  )
}

function StarButton({ starred, onToggle }: { starred?: boolean; onToggle: () => void }) {
  return (
    <button className="ghost icon-btn star-btn" data-on={starred || undefined}
      data-tip={starred ? undefined : 'Share with all devices of this app'}
      onClick={onToggle}>
      <StarIcon filled={starred} />
    </button>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  )
}

/** Clearing the whole list is a different act from deleting one rule, so it must not wear the
    same trash can: a list with an X reads as "empty this list", not "delete this item". */
function ClearListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 6H3" />
      <path d="M13 12H3" />
      <path d="M13 18H3" />
      <path d="m16 9 5 5" />
      <path d="m21 9-5 5" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
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

// Small section-title icons (match TrashIcon's 16px stroke style); also used on the main tabs
export function HttpIcon() {
  return (
    <svg className="section-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
    </svg>
  )
}
export function SocketIcon() {
  return (
    <svg className="section-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9h11l-3-3" />
      <path d="M20 15H9l3 3" />
    </svg>
  )
}

type MockSelection = { http?: string; socket?: string; tab?: 'rules' | 'push' }
const selectionKey = 'sniffer-mock-selection'
function loadSelection(): MockSelection {
  try { return JSON.parse(localStorage.getItem(selectionKey) ?? '{}') as MockSelection } catch { return {} }
}
function saveSelection(sel: MockSelection) {
  try { localStorage.setItem(selectionKey, JSON.stringify(sel)) } catch { /* private mode */ }
}

export function MocksView({ scope, deviceId, appId, mocks, conns, pendingRule, pendingSocketRule, pushPrefill, onPendingConsumed, onClose }: {
  /** which panel opened it: the API panel manages HTTP rules, the Socket panel the socket ones */
  scope: 'http' | 'socket'
  deviceId: string | null
  appId: string | null
  mocks: Mocks
  conns: SocketConn[]
  pendingRule: HttpMockRule | null
  pendingSocketRule: SocketMockRule | null
  pushPrefill: PushPrefill | null
  onPendingConsumed: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Mocks>(mocks)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showPlaceholders, setShowPlaceholders] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPushRecords, setExportPushRecords] = useState<PushRecord[]>([])
  // reopening the panel restores the last selection; a stale rule id resolves to "nothing selected"
  const [selHttp, setSelHttp] = useState<string | null>(() => loadSelection().http ?? null)
  const [selSocket, setSelSocket] = useState<string | null>(() => loadSelection().socket ?? null)
  const [socketTab, setSocketTab] = useState<'rules' | 'push'>(() => loadSelection().tab ?? 'rules')
  useEffect(() => {
    saveSelection({ http: selHttp ?? undefined, socket: selSocket ?? undefined, tab: socketTab })
  }, [selHttp, selSocket, socketTab])
  const [pushCount, setPushCount] = useState(0)

  // refs so the flush below sees the latest values without re-running the effect
  const draftRef = useRef(draft); draftRef.current = draft
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const orderKey = `sniffer-mock-order:${deviceId}`

  useEffect(() => {
    setDraft(beautified(applyOrder(loadOrder(orderKey, localStorage), mocks)))
    setDirty(false)
    const id = deviceId
    return () => {
      // switching device (or leaving the tab) inside the autosave debounce must not drop edits
      if (id && dirtyRef.current) api.saveMocks(id, orderForSync(draftRef.current)).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  // sync from server when rules change and there are no unsaved local edits. Starring moves a
  // rule into the daemon's shared bucket, which merges ahead of the device's own — re-applying
  // the order already on screen is what keeps the rule from teleporting to the top.
  useEffect(() => {
    if (!dirty) setDraft(d => beautified(applyOrder(orderOf(d), mocks)))
  }, [mocks, dirty])

  // Keyed on the order's contents, not on orderKey: switching device changes the key one render
  // before the draft catches up, and saving then would file the old device's order under the new
  // device's key.
  const draftOrder = orderOf(draft)
  const draftOrderId = `${draftOrder.http.join()}|${draftOrder.socket.join()}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { saveOrder(orderKey, draftOrder, localStorage) }, [draftOrderId])

  // prefilled rules coming from the "Mock this request" / "Mock this event" actions
  useEffect(() => {
    if (pendingRule && deviceId) {
      // click-to-prefill lands on top so it's immediately visible
      setDraft(d => ({ ...d, http: [{ ...pendingRule, createdAt: Date.now() }, ...d.http] }))
      setSelHttp(pendingRule.id)
      setDirty(true)
      onPendingConsumed()
    }
  }, [deviceId, pendingRule, onPendingConsumed])

  useEffect(() => {
    if (pendingSocketRule && deviceId) {
      setDraft(d => ({ ...d, socket: [{ ...prettySocketRule(pendingSocketRule), createdAt: Date.now() }, ...d.socket] }))
      setSelSocket(pendingSocketRule.id)
      setSocketTab('rules')
      setDirty(true)
      onPendingConsumed()
    }
  }, [deviceId, pendingSocketRule, onPendingConsumed])

  // a push prefill has to land on the push tab, not behind it
  useEffect(() => { if (pushPrefill) setSocketTab('push') }, [pushPrefill])

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
  const [pushImport, setPushImport] = useState<PushRecord[] | null>(null)
  const onPushImported = useCallback(() => setPushImport(null), [])

  const exportSource: ExportRulesSource = { ...draft, push: exportPushRecords }

  const exportRules = (selection: ExportRuleSelection) => {
    const selected = buildExportRules(exportSource, selection)
    const blob = new Blob(
      [JSON.stringify(selected, null, 2)],
      { type: 'application/json' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `sniffer-mocks-${deviceId}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setExportOpen(false)
  }

  // appends (with fresh ids) instead of replacing, so an import can never destroy rules;
  // Clear all first for replace semantics
  const importRules = (file: File) => {
    file.text().then(text => {
      const v = parseImportedRules(text)
      if (!v) return alert('Not a valid mock rules JSON file')
      if (countImportedRules(v) === 0) return alert('No rules found in this file')
      if (v.http.length + v.socket.length > 0) {
        update({
          ...draft,
          http: [...draft.http, ...importedCopies(v.http, newRuleId)],
          socket: [...draft.socket, ...importedCopies(v.socket, newRuleId)],
        })
      }
      // push records live in the panel's localStorage, not in the synced mock store
      if (v.push.length > 0) setPushImport(importedCopies(v.push, newRuleId))
    }).catch(() => alert('Not a valid mock rules JSON file'))
  }

  const httpDups = duplicateIds(draft.http, httpSig)
  const socketDups = duplicateIds(draft.socket, socketSig)

  if (!deviceId) {
    return null
  }

  const httpRows: MockRow[] = draft.http.map(r => ({
    id: r.id,
    badge: r.method ?? 'ANY',
    label: r.name || r.urlPattern || '(no path)',
    sub: r.name ? r.urlPattern : undefined,
    enabled: r.enabled,
    starred: r.starred,
    dup: httpDups.has(r.id),
  }))
  const socketRows: MockRow[] = draft.socket.map(r => ({
    id: r.id,
    badge: r.transport === 'ktor-ws' ? 'WS' : 'SIO',
    label: r.name || r.event || '(no event)',
    sub: r.name ? r.event : undefined,
    enabled: r.enabled,
    starred: r.starred,
    dup: socketDups.has(r.id),
  }))

  const httpIndex = draft.http.findIndex(r => r.id === selHttp)
  const httpAt = httpIndex >= 0 ? httpIndex : (draft.http.length ? 0 : -1)
  const socketIndex = draft.socket.findIndex(r => r.id === selSocket)
  const socketAt = socketIndex >= 0 ? socketIndex : (draft.socket.length ? 0 : -1)

  const addHttp = () => {
    const rule: HttpMockRule = {
      id: newRuleId(), createdAt: Date.now(), enabled: true, method: null, urlPattern: '',
      status: 200, headers: { 'content-type': 'application/json' }, body: '{}', delayMs: 0, delayOnly: false,
    }
    update({ ...draft, http: [...draft.http, rule] })
    setSelHttp(rule.id)
  }
  const addSocket = () => {
    const rule: SocketMockRule = {
      id: newRuleId(), createdAt: Date.now(), enabled: true, transport: 'socketio',
      event: '', ackPayload: '[{"ok":true}]', delayMs: 0,
    }
    update({ ...draft, socket: [...draft.socket, rule] })
    setSelSocket(rule.id)
  }

  const title = scope === 'http' ? 'HTTP mock rules' : 'Socket mocks'
  const enabledCount = scope === 'http'
    ? draft.http.filter(r => r.enabled).length
    : draft.socket.filter(r => r.enabled).length
  const totalCount = scope === 'http' ? draft.http.length : draft.socket.length

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal mocks-modal" role="dialog" aria-modal="true" aria-label={title}
        onMouseDown={e => e.stopPropagation()}>
        <div className="mocks-modal-head">
          <h2>{title}</h2>
          <span className="dim">
            {totalCount} {totalCount === 1 ? 'rule' : 'rules'} · {enabledCount} enabled
          </span>
          <span className="spacer" />
          <button className="ghost icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
        </div>

        {scope === 'socket' && (
          <div className="mocks-modal-tabs">
            <button data-active={socketTab === 'rules' || undefined} onClick={() => setSocketTab('rules')}>
              Socket rules{draft.socket.length > 0 && <span className="tab-count">{draft.socket.length}</span>}
            </button>
            <button data-active={socketTab === 'push' || undefined} onClick={() => setSocketTab('push')}>
              Server push events{pushCount > 0 && <span className="tab-count">{pushCount}</span>}
            </button>
          </div>
        )}

        {showPlaceholders && <PlaceholderGuide />}

        {scope === 'http' && (
          <div className="mocks-md">
            <MockList rows={httpRows} selectedId={httpRows[httpAt]?.id ?? null}
              onSelect={setSelHttp} onAdd={addHttp} addLabel="Add HTTP rule"
              onToggle={id => update({ ...draft, http: draft.http.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r) })}
              onClearAll={draft.http.length > 0 ? () => update({ ...draft, http: [] }) : undefined}
              placeholdersOn={showPlaceholders} onPlaceholders={() => setShowPlaceholders(v => !v)}
            />
            <div className="mocks-detail">
              {httpAt < 0 ? <div className="empty">No HTTP rules yet — add one to start mocking</div> : (
                <HttpRuleEditor key={draft.http[httpAt].id} rule={draft.http[httpAt]} dup={httpDups.has(draft.http[httpAt].id)}
                  onDuplicate={() => {
                    const copy = { ...draft.http[httpAt], id: newRuleId(), createdAt: Date.now() }
                    update({ ...draft, http: [...draft.http.slice(0, httpAt + 1), copy, ...draft.http.slice(httpAt + 1)] })
                    setSelHttp(copy.id)
                  }}
                  onChange={next => update({ ...draft, http: draft.http.map((x, j) => j === httpAt ? next : x) })}
                  onDelete={() => update({ ...draft, http: draft.http.filter((_, j) => j !== httpAt) })}
                />
              )}
            </div>
          </div>
        )}

        {scope === 'socket' && socketTab === 'rules' && (
          <div className="mocks-md">
            <MockList rows={socketRows} selectedId={socketRows[socketAt]?.id ?? null}
              onSelect={setSelSocket} onAdd={addSocket} addLabel="Add socket rule"
              onToggle={id => update({ ...draft, socket: draft.socket.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r) })}
              onClearAll={draft.socket.length > 0 ? () => update({ ...draft, socket: [] }) : undefined}
              placeholdersOn={showPlaceholders} onPlaceholders={() => setShowPlaceholders(v => !v)}
            />
            <div className="mocks-detail">
              {socketAt < 0 ? <div className="empty">No socket rules yet — add one to start mocking</div> : (
                <SocketRuleEditor key={draft.socket[socketAt].id} rule={draft.socket[socketAt]} dup={socketDups.has(draft.socket[socketAt].id)}
                  onDuplicate={() => {
                    const copy = { ...draft.socket[socketAt], id: newRuleId(), createdAt: Date.now() }
                    update({ ...draft, socket: [...draft.socket.slice(0, socketAt + 1), copy, ...draft.socket.slice(socketAt + 1)] })
                    setSelSocket(copy.id)
                  }}
                  onChange={next => update({ ...draft, socket: draft.socket.map((x, j) => j === socketAt ? next : x) })}
                  onDelete={() => update({ ...draft, socket: draft.socket.filter((_, j) => j !== socketAt) })}
                />
              )}
            </div>
          </div>
        )}

        {scope === 'socket' && socketTab === 'push' && (
          <PushEventPanel
            conns={conns}
            deviceId={deviceId}
            appId={appId}
            prefill={pushPrefill}
            onConsumed={onPendingConsumed}
            onRecordsSnapshot={setExportPushRecords}
            onCountChange={setPushCount}
            imported={pushImport}
            onImported={onPushImported}
          />
        )}

        <div className="mocks-modal-foot">
          <span className="dim">{dirty ? 'Saving…' : saved ? 'Saved ✓' : 'Synced'}</span>
          <span className="spacer" />
          <button className="pill-btn" onClick={() => importRef.current?.click()}>Import</button>
          <button className="pill-btn" onClick={() => setExportOpen(true)}>Export</button>
          <input ref={importRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) importRules(f)
              e.target.value = ''
            }} />
        </div>
      </div>

      {exportOpen && (
        <ExportRulesModal
          source={exportSource}
          onCancel={() => setExportOpen(false)}
          onExport={exportRules}
        />
      )}
    </div>
  )
}

export interface MockRow {
  id: string
  badge: string
  label: string
  /** shown under the label when the rule has a name, so the path is never hidden behind it */
  sub?: string
  enabled?: boolean
  starred?: boolean
  dup?: boolean
}

/** Master list of the modal: never truncates a label -- long paths and names wrap instead. */
function MockList({ rows, selectedId, onSelect, onToggle, onAdd, addLabel, onClearAll, placeholdersOn, onPlaceholders }: {
  rows: MockRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle?: (id: string) => void
  onAdd: () => void
  addLabel: string
  onClearAll?: () => void
  placeholdersOn?: boolean
  onPlaceholders?: () => void
}) {
  return (
    <div className="mocks-list">
      <div className="mocks-list-tools">
        <button className="ghost icon-btn" title={addLabel} onClick={onAdd}><PlusIcon /></button>
        {onClearAll && (
          <button className="ghost icon-btn danger" title="Clear all" onClick={onClearAll}><ClearListIcon /></button>
        )}
        <span className="spacer" />
        {onPlaceholders && (
          <button className="pill-btn" data-on={placeholdersOn || undefined} onClick={onPlaceholders}>Placeholders</button>
        )}
      </div>
      <div className="mocks-list-scroll">
        {rows.map(row => (
          <div key={row.id} className="mocks-list-row" data-selected={row.id === selectedId || undefined}
            data-off={row.enabled === false || undefined} onClick={() => onSelect(row.id)}>
            {onToggle && (
              <label className="toggle" onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={row.enabled !== false} onChange={() => onToggle(row.id)} />
              </label>
            )}
            <span className="mocks-list-badge">{row.badge}</span>
            <span className="mocks-list-name">
              <span className="mocks-list-label">{row.label}</span>
              {row.sub && <span className="mocks-list-sub mono">{row.sub}</span>}
            </span>
            {row.dup && (
              <span className="mocks-list-dup" title="Another enabled rule has the same matcher — the newest one takes effect">
                <WarningIcon />
              </span>
            )}
            {row.starred && <span className="mocks-list-star"><StarIcon filled /></span>}
          </div>
        ))}
        {rows.length === 0 && <div className="dim hint mocks-list-empty">Nothing here yet</div>}
      </div>
    </div>
  )
}

type ExportCategory = {
  key: 'http' | 'socket' | 'push'
  title: string
  count: number
}

function exportCategories(source: ExportRulesSource): ExportCategory[] {
  return [
    {
      key: 'http',
      title: 'HTTP rules',
      count: source.http.length,
    },
    {
      key: 'socket',
      title: 'Socket rules',
      count: source.socket.length,
    },
    {
      key: 'push',
      title: 'Server push events',
      count: source.push.length,
    },
  ]
}

type MutableExportRuleSelection = {
  http: boolean
  socket: boolean
  push: boolean
}

function toMutableSelection(selection: ExportRuleSelection): MutableExportRuleSelection {
  return { ...selection }
}

function emptyExportSelection(): MutableExportRuleSelection {
  return { http: false, socket: false, push: false }
}

function selectionHas(selection: MutableExportRuleSelection, category: ExportCategory): boolean {
  return selection[category.key]
}

function SelectAllCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean
  indeterminate: boolean
  onChange: (checked: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      aria-label="Select all rules"
    />
  )
}

function ExportRulesModal({ source, onCancel, onExport }: {
  source: ExportRulesSource
  onCancel: () => void
  onExport: (selection: ExportRuleSelection) => void
}) {
  const [selection, setSelection] = useState<MutableExportRuleSelection>(() =>
    toMutableSelection(createFullExportSelection(source)))
  const categories = exportCategories(source)
  const selectedCount = countSelectedRules(selection)
  const allSelected = selectedCount === categories.length
  const partiallySelected = selectedCount > 0 && selectedCount < categories.length

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const setAll = (checked: boolean) => {
    setSelection(checked ? toMutableSelection(createFullExportSelection(source)) : emptyExportSelection())
  }

  const setCategory = (category: ExportCategory, checked: boolean) => {
    setSelection(current => {
      const next = toMutableSelection(current)
      next[category.key] = checked
      return next
    })
  }

  const toggleCategory = (category: ExportCategory) => setCategory(category, !selectionHas(selection, category))
  const countLabel = (count: number) => `${count} ${count === 1 ? 'rule' : 'rules'}`

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-rules-title"
        onMouseDown={e => e.stopPropagation()}>
        <div className="export-modal-head">
          <h2 id="export-rules-title">Export rules</h2>
        </div>

        <div className="export-table-actions">
          <label className="field checkbox-field">
            <SelectAllCheckbox checked={allSelected} indeterminate={partiallySelected} onChange={setAll} />
            All
          </label>
        </div>

        <div className="export-table-wrap">
          <table className="grid export-grid">
            <thead>
              <tr>
                <th></th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {categories.map(category => (
                <tr key={category.key} className="export-category-row"
                  data-selected={selectionHas(selection, category) || undefined}
                  onClick={() => toggleCategory(category)}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectionHas(selection, category)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setCategory(category, e.target.checked)}
                      aria-label={`Export ${category.title}`}
                    />
                  </td>
                  <td className="export-rule-cell">
                    <span className="export-rule-name">{category.title}</span>
                    <span className="dim">{countLabel(category.count)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button className="modal-primary" disabled={selectedCount === 0} autoFocus onClick={() => onExport(selection)}>Export</button>
        </div>
      </div>
    </div>
  )
}

type PushRecord = PushEventRule

function PushEventPanel({ conns, deviceId, appId, prefill, onConsumed, onRecordsSnapshot, onCountChange, imported, onImported }: {
  conns: SocketConn[]
  deviceId: string
  appId: string | null
  prefill: PushPrefill | null
  onConsumed: () => void
  onRecordsSnapshot: (records: PushRecord[]) => void
  onCountChange: (count: number) => void
  imported: PushRecord[] | null
  onImported: () => void
}) {
  // ponytail: push records are a UI convenience, persisted in localStorage; starred ones
  // live in a per-appId bucket so every device of the app (current and future) sees them
  const storageKey = `sniffer-push-${deviceId}`
  const pushOrderKey = `sniffer-push-order:${deviceId}`
  const sharedKey = appId ? `sniffer-push-shared-${appId}` : null
  const [records, setRecords] = useState<PushRecord[]>(() => loadRecords(storageKey))
  const [sharedRecords, setSharedRecords] = useState<PushRecord[]>(() => loadShared(sharedKey))
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => { setRecords(loadRecords(storageKey)) }, [storageKey])
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(records)) }, [records, storageKey])
  useEffect(() => { setSharedRecords(loadShared(sharedKey)) }, [sharedKey])
  useEffect(() => { if (sharedKey) localStorage.setItem(sharedKey, JSON.stringify(sharedRecords)) }, [sharedRecords, sharedKey])

  useEffect(() => {
    if (prefill) {
      const conn = conns.find(c => c.connectionId === prefill.connectionId)
      const record = pointAt({ id: newRuleId(), target: '', event: prefill.event, payload: prettyJson(prefill.payload) }, conn)
      setRecords(rs => [record, ...rs])
      setSelected(record.id)
      onConsumed()
    }
  }, [prefill, onConsumed, conns])

  useEffect(() => {
    if (!imported) return
    setRecords(rs => [...imported, ...rs])
    onImported()
  }, [imported, onImported])

  // starred records live in the shared bucket, which lists first — the remembered order
  // (same idea as the mock rules above) is what keeps a card where the user left it
  const [pushOrder, setPushOrder] = useState<string[]>(() => loadIds(pushOrderKey, localStorage))
  useEffect(() => { setPushOrder(loadIds(pushOrderKey, localStorage)) }, [pushOrderKey])
  const all = byOrder(pushOrder, [...sharedRecords, ...records])

  useEffect(() => { onRecordsSnapshot(all) }, [records, sharedRecords, onRecordsSnapshot])
  useEffect(() => { onCountChange(all.length) }, [records, sharedRecords, onCountChange])

  const displayedIds = all.map(r => r.id).join()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!displayedIds) return
    const ids = displayedIds.split(',')
    saveIds(pushOrderKey, ids, localStorage)
    setPushOrder(ids) // absorbs records added since the load, so starring one keeps its place
  }, [displayedIds])

  // a starred record moves to the shared bucket (and back); other edits stay in place
  const changeRecord = (next: PushRecord) => {
    const wasShared = sharedRecords.some(x => x.id === next.id)
    const nowShared = Boolean(next.starred && sharedKey)
    if (nowShared === wasShared) {
      const set = nowShared ? setSharedRecords : setRecords
      set(rs => rs.map(x => x.id === next.id ? next : x))
    } else if (nowShared) {
      setRecords(rs => rs.filter(x => x.id !== next.id))
      setSharedRecords(rs => [...rs, next])
    } else {
      setSharedRecords(rs => rs.filter(x => x.id !== next.id))
      setRecords(rs => [...rs, { ...next, starred: undefined }])
    }
  }
  const deleteRecord = (id: string) => {
    setRecords(rs => rs.filter(x => x.id !== id))
    setSharedRecords(rs => rs.filter(x => x.id !== id))
  }
  const duplicateRecord = (r: PushRecord) => {
    const set = sharedRecords.some(x => x.id === r.id) ? setSharedRecords : setRecords
    set(rs => {
      const i = rs.findIndex(x => x.id === r.id)
      return [...rs.slice(0, i + 1), { ...r, id: newRuleId() }, ...rs.slice(i + 1)]
    })
  }

  const at = all.findIndex(r => r.id === selected)
  const current = at >= 0 ? all[at] : all[0]

  const rows: MockRow[] = all.map(r => ({
    id: r.id,
    badge: 'SIO',
    label: r.name || r.event || '(no event)',
    sub: r.name ? r.event : undefined,
    starred: r.starred,
  }))

  const addRecord = () => {
    const record = { id: newRuleId(), target: '', event: '', payload: '{}' }
    setRecords(rs => [...rs, record])
    setSelected(record.id)
  }

  return (
    <div className="mocks-md">
      <MockList rows={rows} selectedId={current?.id ?? null} onSelect={setSelected}
        onAdd={addRecord} addLabel="Add push event"
        onClearAll={all.length > 0 ? () => { setRecords([]); setSharedRecords([]) } : undefined}
      />
      <div className="mocks-detail">
        {!current ? <div className="empty">No push events yet — add one to send a server event</div> : (
          <PushRecordCard key={current.id} record={current} conns={conns} deviceId={deviceId} canStar={sharedKey !== null}
            onChange={changeRecord}
            onDelete={() => deleteRecord(current.id)}
            onDuplicate={() => duplicateRecord(current)}
          />
        )}
      </div>
    </div>
  )
}

function loadShared(key: string | null): PushRecord[] {
  if (!key) return []
  return loadRecords(key).map(r => ({ ...r, starred: true }))
}

function loadRecords(key: string): PushRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function PushRecordCard({ record, conns, deviceId, canStar, onChange, onDelete, onDuplicate }: {
  record: PushRecord
  conns: SocketConn[]
  deviceId: string
  canStar: boolean
  onChange: (r: PushRecord) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const [status, setStatus] = useState<'sent' | 'error' | null>(null)
  const payloadRef = useRef<HTMLTextAreaElement>(null)
  const payloadView = useJsonStringView(record.payload, payload => onChange({ ...record, payload }), 'args')

  const live = conns.filter(c => c.deviceId === deviceId && c.status === 'connected')
  const liveOptions = live.map(c => ({
    key: c.connectionId,
    label: `${c.transport} · ${c.url || c.connectionId.slice(0, 8)}`,
    disabled: false,
  }))
  // reconnects hand out a new connectionId; the record re-binds by endpoint on its own
  const target = resolvePushTarget(record, live)
  const targetMissing = Boolean(record.target) && target === ''
  const options = [{ key: '', label: 'Select a connection…', disabled: true }, ...liveOptions]
  // a push must target a specific live connection — no broadcast to all
  const canSend = Boolean(record.event) && target !== ''

  const send = async () => {
    if (!canSend) return
    const res = await api.pushEvent(deviceId, target, record.event, record.payload)
    setStatus(res.ok ? 'sent' : 'error')
    setTimeout(() => setStatus(null), 1600)
  }

  return (
    <div className="rule-card">
      <div className="rule-name-row">
        <TagIcon />
        <input className="rule-name" placeholder="name this push… (optional)" value={record.name ?? ''}
          onChange={e => onChange({ ...record, name: e.target.value || undefined })} />
        {canStar && <StarButton starred={record.starred} onToggle={() => onChange({ ...record, starred: !record.starred || undefined })} />}
      </div>
      <div className="rule-row">
        <select value={target}
          onChange={e => onChange(pointAt(record, live.find(c => c.connectionId === e.target.value)))}>
          {options.map(o => <option key={o.key} value={o.key} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <input className="grow mono" placeholder="event name (e.g. chat:new)" value={record.event}
          onChange={e => onChange({ ...record, event: e.target.value })} />
        <button className="ghost icon-btn" title="Duplicate" onClick={onDuplicate}><CopyIcon /></button>
        <button className="ghost icon-btn danger" title="Delete" onClick={onDelete}><TrashIcon /></button>
        <button disabled={!canSend} onClick={send}>
          {status === 'sent' ? 'Sent ✓' : status === 'error' ? 'Failed' : 'Send'}
        </button>
      </div>
      {targetMissing && (
        <div className="hint warn">⚠ The connection this push was pointed at is gone. Choose a live one.</div>
      )}
      {!targetMissing && liveOptions.length === 0 && (
        <div className="dim hint">No active socket connections for this device. Connect one to send a push.</div>
      )}
      <textarea ref={payloadRef} className="mono" rows={8} placeholder="payload (JSON or plain text)"
        value={payloadView.text} onChange={e => payloadView.onText(e.target.value)} />
      <div className="rule-body-tools">
        <JsonTool label="Pretty JSON" body={payloadView.text} transform={v => JSON.stringify(v, null, 2)} onResult={payloadView.onText} />
        <JsonStringToggle view={payloadView} />
        <PlaceholderTools value={payloadView.text} onValue={payloadView.onText} taRef={payloadRef} />
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
  const [sub, setSub] = useState<'body' | 'headers'>('body')
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const bodyView = useJsonStringView(rule.body, body => onChange({ ...rule, body }))
  const headerCount = Object.keys(rule.headers).length
  // paths share their head (/api/systems/v1/…), so show the tail — but never yank the view
  // out from under someone editing the field
  useEffect(() => {
    const el = urlRef.current
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth
  }, [rule.urlPattern])
  return (
    <div className="rule-card" data-disabled={!rule.enabled || undefined}>
      <div className="rule-name-row">
        <TagIcon />
        <input className="rule-name" placeholder="name this rule… (optional)" value={rule.name ?? ''}
          onChange={e => onChange({ ...rule, name: e.target.value || undefined })} />
        <StarButton starred={rule.starred} onToggle={() => onChange({ ...rule, starred: !rule.starred || undefined })} />
      </div>
      <div className="rule-row">
        <label className="toggle">
          <input type="checkbox" checked={rule.enabled} onChange={e => onChange({ ...rule, enabled: e.target.checked })} />
        </label>
        <select value={rule.method ?? ''} onChange={e => onChange({ ...rule, method: e.target.value || null })}>
          <option value="">ANY</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}
        </select>
        <input ref={urlRef} className="grow mono" placeholder="exact path, e.g. /api/users/3" value={rule.urlPattern}
          onChange={e => onChange({ ...rule, urlPattern: e.target.value })} />
        <button className="ghost icon-btn" title="Duplicate rule" onClick={onDuplicate}><CopyIcon /></button>
        <button className="ghost icon-btn danger" title="Delete rule" onClick={onDelete}><TrashIcon /></button>
      </div>
      {dup && (
        <div className="hint dup-warning"><WarningIcon />Another enabled rule has the same matcher — the newest one takes effect.</div>
      )}
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
              <textarea ref={bodyRef} className="mono" rows={14} placeholder="response body"
                value={bodyView.text} onChange={e => bodyView.onText(e.target.value)} />
              <div className="rule-body-tools">
                <JsonTool label="Pretty JSON" body={bodyView.text} transform={v => JSON.stringify(v, null, 2)}
                  onResult={bodyView.onText} />
                <JsonStringToggle view={bodyView} />
                <PlaceholderTools value={bodyView.text} onValue={bodyView.onText} taRef={bodyRef} />
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
export function HeadersEditor({ value, onChange }: {
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
  return <button className="tool-btn" onClick={run}>{bad ? 'Invalid JSON' : label}</button>
}

/** Two jobs behind one control, because they are the same question asked from opposite sides:
    "this payload is JSON inside a string — let me read it" and "this payload should go out as a
    string like the server sends".

    Expanding is presentation only: the value handed back stays the wire string, so how you look
    at it can never change what the app receives. Wrapping is a deliberate conversion — it is the
    only way to turn a plain payload into the single string an app expects to JSON.parse, so it
    says so on the button. Edits made while expanded are re-encoded on the way out; text that is
    not valid JSON yet is simply not written back, and the toggle says so. */
function useJsonStringView(value: string, onValue: (next: string) => void, kind: 'args' | 'body' = 'body') {
  const [open, setOpen] = useState(() => unwrapJsonString(value) !== null)
  // holds exactly what the user typed, so re-encoding never reformats under their cursor
  const [buffer, setBuffer] = useState<string | null>(null)

  const inner = unwrapJsonString(value)
  const showing = open && inner !== null
  const text = showing ? buffer ?? inner : value
  const invalid = showing && buffer !== null && wrapJsonString(buffer) === null

  const onText = (next: string) => {
    if (!showing) return onValue(next)
    // Pasting a whole wire payload into the expanded view means "replace the payload", not
    // "this is the inner value" -- re-encoding it here would wrap an already-wrapped payload.
    if (unwrapJsonString(next) !== null) {
      setBuffer(null)
      return onValue(next)
    }
    setBuffer(next)
    const wrapped = wrapJsonString(next)
    if (wrapped !== null) onValue(wrapped)
  }

  return {
    text,
    onText,
    invalid,
    /** already a JSON string: the toggle only changes the view */
    isString: inner !== null,
    showing,
    // Offered narrowly on purpose. Socket payloads are an argument list, so a bare object means
    // "one object argument" -- the shape you get by pasting the inner JSON of a server that
    // stringifies its payloads, and the only case where wrapping is what you meant. An argument
    // list that is already an array, or an HTTP body, is left alone: a Wrap button there is noise
    // on every payload and quietly corrupts the one you press it on.
    canWrap: kind === 'args' && inner === null && isBareObject(value),
    toggle: () => { setBuffer(null); setOpen(o => !o) },
    // The wrapped value itself restores this view when switching away and back to the rule.
    wrap: () => {
      const wrapped = wrapJsonString(value)
      if (wrapped === null) return
      setBuffer(null)
      setOpen(true)
      onValue(wrapped)
    },
  }
}

function isBareObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

type JsonStringView = ReturnType<typeof useJsonStringView>

function JsonStringToggle({ view }: { view: JsonStringView }) {
  if (view.isString) {
    return (
      <>
        <button className="tool-btn" data-on={view.showing || undefined}
          title="JSON inside a string. Expanding only changes the view — the payload stays a string."
          onClick={view.toggle}>
          {view.showing ? 'Show as string' : 'Expand string'}
        </button>
        {view.invalid && <span className="hint warn">Invalid JSON — not saved yet</span>}
      </>
    )
  }
  if (!view.canWrap) return null
  return (
    <button className="tool-btn" onClick={view.wrap}
      title="Send this as one JSON string, the way a server that emits JSON.stringify(payload) does">
      Wrap as string
    </button>
  )
}

function SocketRuleEditor({ rule, dup, onChange, onDelete, onDuplicate }: {
  rule: SocketMockRule
  dup: boolean
  onChange: (r: SocketMockRule) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const ackRef = useRef<HTMLTextAreaElement>(null)
  const pushRef = useRef<HTMLTextAreaElement>(null)
  const ackView = useJsonStringView(rule.ackPayload, ackPayload => onChange({ ...rule, ackPayload }), 'args')
  const pushView = useJsonStringView(rule.pushPayload ?? '[]', pushPayload => onChange({ ...rule, pushPayload }), 'args')
  const mode = rule.transport === 'ktor-ws' ? 'ws' : rule.pushEvent != null ? 'sio-event' : 'sio-ack'
  return (
    <div className="rule-card" data-disabled={!rule.enabled || undefined}>
      <div className="rule-name-row">
        <TagIcon />
        <input className="rule-name" placeholder="name this rule… (optional)" value={rule.name ?? ''}
          onChange={e => onChange({ ...rule, name: e.target.value || undefined })} />
        <StarButton starred={rule.starred} onToggle={() => onChange({ ...rule, starred: !rule.starred || undefined })} />
      </div>
      <div className="rule-row">
        <label className="toggle">
          <input type="checkbox" checked={rule.enabled} onChange={e => onChange({ ...rule, enabled: e.target.checked })} />
        </label>
        {/* the wire has one socketio transport; the two sio modes differ by how the emit is answered
            (fake ack vs pushed-back event) — pushEvent present picks the event mode. Switching keeps
            both payloads so nothing typed is lost; the event mode starts from the ack JSON. */}
        <select value={mode} onChange={e => onChange(
          e.target.value === 'ws' ? { ...rule, transport: 'ktor-ws', pushEvent: undefined }
            : e.target.value === 'sio-event'
              ? { ...rule, transport: 'socketio', pushEvent: rule.pushEvent ?? '', pushPayload: rule.pushPayload ?? rule.ackPayload }
              : { ...rule, transport: 'socketio', pushEvent: undefined })}>
          <option value="sio-ack">socketIO ack</option>
          <option value="sio-event">socketIO event</option>
          <option value="ws">ws reply</option>
        </select>
        <input className="grow mono" placeholder={rule.transport === 'socketio' ? 'event name' : 'frame contains…'}
          value={rule.event} onChange={e => onChange({ ...rule, event: e.target.value })} />
        <button className="ghost icon-btn" title="Duplicate rule" onClick={onDuplicate}><CopyIcon /></button>
        <button className="ghost icon-btn danger" title="Delete rule" onClick={onDelete}><TrashIcon /></button>
      </div>
      {dup && (
        <div className="hint dup-warning"><WarningIcon />Another enabled rule has the same matcher — the newest one takes effect.</div>
      )}
      {mode === 'sio-event' ? (
        <>
          <div className="rule-tabs">
            <button type="button" data-active>Response event</button>
            <input className="mono w-event" placeholder="event pushed back…"
              value={rule.pushEvent ?? ''} onChange={e => onChange({ ...rule, pushEvent: e.target.value })} />
            <span className="spacer" />
            <label className="field">delay ms
              <NumberField className="mono w-delay" value={rule.delayMs} fallback={0}
                onCommit={n => onChange({ ...rule, delayMs: n })} />
            </label>
          </div>
          <textarea ref={pushRef} className="mono" rows={14}
            placeholder="pushed payload (JSON array = multiple args)"
            value={pushView.text} onChange={e => pushView.onText(e.target.value)} />
          <div className="rule-body-tools">
            <JsonTool label="Pretty JSON" body={pushView.text} transform={v => JSON.stringify(v, null, 2)}
              onResult={pushView.onText} />
            <JsonStringToggle view={pushView} />
            <PlaceholderTools value={pushView.text} onValue={pushView.onText} taRef={pushRef} />
          </div>
        </>
      ) : (
        <>
          <div className="rule-tabs">
            <span className="spacer" />
            <label className="field">delay ms
              <NumberField className="mono w-delay" value={rule.delayMs} fallback={0}
                onCommit={n => onChange({ ...rule, delayMs: n })} />
            </label>
          </div>
          <textarea ref={ackRef} className="mono" rows={14}
            placeholder={rule.transport === 'socketio' ? 'ack payload (JSON array = multiple args)' : 'fake reply frame (raw text)'}
            value={ackView.text} onChange={e => ackView.onText(e.target.value)} />
          <div className="rule-body-tools">
            <JsonTool label="Pretty JSON" body={ackView.text} transform={v => JSON.stringify(v, null, 2)}
              onResult={ackView.onText} />
            <JsonStringToggle view={ackView} />
            <PlaceholderTools value={ackView.text} onValue={ackView.onText} taRef={ackRef} />
          </div>
        </>
      )}
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
      <span className="tools-sep" aria-hidden />
      {PlaceholderTokens.map(item => (
        <button key={item.key} className="token-btn" title={`Insert ${item.syntax} — ${item.label}`} onClick={() => {
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
  if (key === 'randomId') return '${randomId}'
  if (key === 'now') return '${now}'
  if (key === 'randomString') {
    const range = promptRange()
    return range === null ? null : `\${randomString(${range.min}~${range.max})}`
  }
  return null
}

function promptRange(): { min: number; max: number } | null {
  const value = prompt('Random string length range (min~max)')
  if (value === null) return null
  const match = value.trim().match(/^(\d+)\s*~\s*(\d+)$/)
  if (!match) {
    alert('Enter a range of whole numbers like min~max.')
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
