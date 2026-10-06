import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type FirebaseRow, type HttpMockRule, type HttpRow } from './state'
import { CopyButton, Highlight, HttpDetail, RowMenu } from './HttpView'
import { FilterMenu } from './FilterMenu'
import { loadFilter, passesFilter, saveFilter, setAllEnabled } from './trafficFilter'
import { TrafficEmpty, type TrafficEmptyProps } from './TrafficEmpty'
import { useDetailWidth, useFollowLatestRow, useListKeys, useUnreadRows } from './hooks'
import { fmtDuration, fmtTime, statusClass, statusLabel, urlParts } from './util'

export function FirebaseIcon() {
  return <img src="/firebase.svg" width="18" height="18" alt="" aria-hidden="true" />
}

type TimelineEntry = { id: string; ts: number; userId: string | undefined } & (
  { kind: 'firebase'; row: FirebaseRow } | { kind: 'http'; row: HttpRow }
)

function timelineName(entry: TimelineEntry): string {
  return entry.kind === 'firebase'
    ? entry.row.message
    : `${entry.row.method} ${urlParts(entry.row.url).path}`
}

export function FirebaseView({ active, rows, allRows, httpRows, query, followLatest, unreadScope, onUnreadChange, emptyState, onMock, onArm }: {
  active: boolean
  rows: FirebaseRow[]
  allRows: FirebaseRow[]
  httpRows: HttpRow[]
  query: string
  followLatest: boolean
  unreadScope: string
  onUnreadChange: (count: number) => void
  emptyState: TrafficEmptyProps
  onMock: (rule: HttpMockRule, deviceId: string) => void
  onArm: (row: HttpRow) => void
}) {
  const [userId, setUserId] = useState<string | null>(null)
  const [nameFilter, setNameFilter] = useState(() => loadFilter('sniffer-filter-firebase-name', localStorage))
  const [includeApi, setIncludeApi] = useState(() => localStorage.getItem('sniffer-firebase-api') !== 'false')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const deviceId = emptyState.device?.deviceId
  useEffect(() => { setUserId(null); setSelectedId(null); setExpandedIds(new Set()); setMenu(null) }, [deviceId])
  useEffect(() => {
    const ids = new Set(allRows.map(row => `firebase:${row.deviceId}:${row.id}`))
    setExpandedIds(previous => [...previous].every(id => ids.has(id))
      ? previous : new Set([...previous].filter(id => ids.has(id))))
  }, [allRows])
  useEffect(() => { if (!active) setMenu(null) }, [active])
  useEffect(() => { saveFilter('sniffer-filter-firebase-name', nameFilter, localStorage) }, [nameFilter])
  useEffect(() => { localStorage.setItem('sniffer-firebase-api', String(includeApi)) }, [includeApi])
  const entries = useMemo(() => {
    const firebase: TimelineEntry[] = allRows.filter(row => row.deviceId === deviceId).map(row => ({
      id: `firebase:${row.deviceId}:${row.id}`, ts: row.ts, userId: row.userId, kind: 'firebase', row,
    }))
    const http: TimelineEntry[] = httpRows.filter(row => row.deviceId === deviceId).map(row => ({
      id: `http:${row.deviceId}:${row.id}`, ts: row.ts, userId: row.userId, kind: 'http', row,
    }))
    return [...firebase, ...http].sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
  }, [allRows, httpRows, deviceId])
  const counts = useMemo(() => {
    const result = new Map<string, number>([['', 0]])
    for (const entry of entries) {
      if ((includeApi || entry.kind === 'firebase') && entry.userId !== undefined) {
        result.set(entry.userId, (result.get(entry.userId) ?? 0) + 1)
      }
    }
    if (userId !== null && !result.has(userId)) result.set(userId, 0)
    return result
  }, [entries, includeApi, userId])
  const userIds = [...counts.keys()].filter(Boolean).sort()
  const visible = useMemo(() => {
    const firebaseIds = new Set(rows.map(row => row.id))
    const q = query.trim().toLowerCase()
    return entries.filter(entry => {
      if (!passesFilter(nameFilter, timelineName(entry), 'contains')) return false
      if (userId !== null && entry.userId !== userId) return false
      if (entry.kind === 'firebase') return firebaseIds.has(entry.row.id)
      if (!includeApi) return false
      const row = entry.row
      return !q || [row.url, row.method, row.userId ?? '', String(row.status ?? ''), row.error ?? '',
        ...Object.entries(row.reqHeaders).flat(), ...Object.entries(row.respHeaders ?? {}).flat(),
        ...(q.length >= 2 ? [row.reqBody ?? '', row.respBase64 ? '' : row.respBody ?? ''] : [])]
        .some(value => value.toLowerCase().includes(q))
    })
  }, [entries, rows, userId, includeApi, query, nameFilter])
  const selectedEntry = visible.find(entry => entry.id === selectedId)
  const ids = useMemo(() => visible.map(entry => entry.id), [visible])
  const visibleFirebase = useMemo(() => visible.filter(entry => entry.kind === 'firebase').map(entry => entry.row), [visible])
  const listRef = useRef<HTMLDivElement>(null)
  const previousEvents = useRef({ scope: unreadScope, ids: new Set(entries.map(entry => entry.id)) })
  useLayoutEffect(() => {
    const previous = previousEvents.current
    previousEvents.current = { scope: unreadScope, ids: new Set(entries.map(entry => entry.id)) }
    if (!active || previous.scope !== unreadScope) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const element of listRef.current?.querySelectorAll<HTMLElement>('.firebase-event[data-kind="firebase"]') ?? []) {
      if (previous.ids.has(element.dataset.entryId!)) continue
      element.querySelector('.firebase-event-body')?.animate(reduceMotion
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    }
  }, [entries, visible, active, unreadScope])
  const [detailWidth, startDetailDrag] = useDetailWidth()
  useListKeys(ids, selectedId, setSelectedId, active)
  // The Firebase tab's unread badge counts Firebase events, just as the API badge counts requests.
  useUnreadRows(allRows, visibleFirebase, active, unreadScope, onUnreadChange)
  useFollowLatestRow(entries, visible, active && followLatest && !menu, unreadScope, setSelectedId, listRef, true)
  const clear = async () => {
    setClearing(true)
    setError('')
    try {
      const response = await api.clearFirebaseEntries()
      if (!response.ok) throw new Error(`Server returned ${response.status}`)
    } catch (error) {
      setError(`Could not clear Firebase records. ${error instanceof Error ? error.message : String(error)}. Try again.`)
    } finally { setClearing(false) }
  }
  const chooseUser = (id: string | null) => { setUserId(id); setSelectedId(null) }
  const userButton = (id: string | null, label: string, count: number) => <button key={id ?? '__all__'}
    className="firebase-user" aria-pressed={userId === id} title={label} onClick={() => chooseUser(id)}>
    <span>{label}</span><span className="count">{count}</span>
  </button>
  const scopedCount = entries.filter(entry => includeApi || entry.kind === 'firebase').length
  const unknownApiUsers = includeApi && entries.some(entry => entry.kind === 'http' && entry.userId === undefined)
  return <div className="split firebase-panel" hidden={!active} data-detail-open={selectedEntry?.kind === 'http' ? true : undefined} style={{ ['--detail-w' as string]: `${detailWidth}px` }}>
    <aside className="firebase-users" aria-label="Firebase user filters">
      <div className="firebase-users-title">Users</div>
      {userButton(null, 'All users', scopedCount)}
      {userButton('', 'No user ID', counts.get('') ?? 0)}
      {userIds.map(id => userButton(id, id, counts.get(id) ?? 0))}
    </aside>
    <div className="list-pane">
      <div className="panel-toolbar">
        <span className="table-header-control"><span>Name</span><FilterMenu filter={nameFilter} onChange={setNameFilter}
          placeholder="Name contains…" selectionValue={selectedEntry ? timelineName(selectedEntry) : null} /></span>
        <label className="firebase-api-toggle"><input type="checkbox" checked={includeApi} onChange={e => setIncludeApi(e.target.checked)} />Include API</label>
        <span className="spacer" />
        <button className="clear-btn" title="Clear Firebase records for all devices; API requests are kept" disabled={clearing || !allRows.length}
          onClick={() => void clear()}>{clearing ? 'Clearing…' : 'Clear Firebase'}</button>
      </div>
      {error && <div className="pad firebase-error" role="alert">{error}</div>}
      <div className="firebase-timeline-caption">
        <strong>{userId === null ? 'All users' : userId || 'No user ID'}</strong>
        <span className="firebase-record-actions">
          <button className="ghost icon-btn" title="Collapse all" aria-label="Collapse all" disabled={!expandedIds.size}
            onClick={() => setExpandedIds(new Set())}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 3 5 5 5-5M5 12h14M7 21l5-5 5 5" />
            </svg>
          </button>
          <span>{visible.length} records</span>
        </span>
      </div>
      <div className="list-scroll" ref={listRef}>
        {visible.length ? <ol className="firebase-timeline" aria-label="Firebase timeline">
          {visible.map(entry => {
            const firebase = entry.kind === 'firebase' ? entry.row : undefined
            const http = entry.kind === 'http' ? entry.row : undefined
            const message = timelineName(entry)
            const expanded = expandedIds.has(entry.id)
            return <li key={entry.id}>
              <button className="firebase-event" data-kind={entry.kind} data-level={firebase ? 'analytics' : 'http'}
                data-entry-id={entry.id}
                data-latest={entry.id === visible[0]?.id || undefined}
                data-selected={entry.id === selectedId || undefined} aria-pressed={entry.id === selectedId}
                aria-expanded={firebase ? expanded : undefined}
                aria-controls={firebase && expanded ? `params-${entry.id}` : undefined}
                onClick={() => {
                  setSelectedId(entry.id)
                  if (firebase) setExpandedIds(previous => {
                    const next = new Set(previous)
                    if (next.has(entry.id)) next.delete(entry.id)
                    else next.add(entry.id)
                    return next
                  })
                }}
                onContextMenu={event => {
                  event.preventDefault()
                  setSelectedId(entry.id)
                  setMenu({ x: event.clientX, y: event.clientY, name: message })
                }}>
                <time className="mono dim" title={new Date(entry.ts).toLocaleString()} dateTime={new Date(entry.ts).toISOString()}>{fmtTime(entry.ts)}</time>
                <span className="firebase-event-dot" aria-hidden="true" />
                <span className="firebase-event-body">
                  <span className={`firebase-event-message${firebase ? ' mono' : ''}`} title={http?.url ?? message}>
                    <Highlight text={message} query={query} />
                  </span>
                  {firebase && <span className="firebase-param-toggle">{expanded ? 'Hide params' : `Params ${Object.keys(firebase.params ?? {}).length}`}</span>}
                  {http && <span className="firebase-event-meta">
                    <span className="firebase-level" data-level="http">API</span>
                    <span className={statusClass(http.status)}>{statusLabel(http.status)}</span>{http.durationMs !== undefined && <span>{fmtDuration(http.durationMs)}</span>}<span className="firebase-event-host">{urlParts(http.url).domain}</span>
                    <span>{entry.userId === undefined ? 'User ID unavailable' : entry.userId || 'No user ID'}</span>
                  </span>}
                </span>
              </button>
              {firebase && expanded && <div className="firebase-inline-params" id={`params-${entry.id}`}
                role="region" aria-label={`Parameters for ${message}`}>
                <div className="firebase-params-toolbar"><span>Parameters</span><CopyButton text={JSON.stringify(firebase.params ?? {}, null, 2)} /></div>
                {Object.entries(firebase.params ?? {}).length ? <div className="firebase-param-grid">{Object.entries(firebase.params ?? {}).map(([key, value]) =>
                  <div className="kv" key={key}>
                    <span className="kv-k mono"><Highlight text={key} query={query} /></span>
                    <span className="kv-v mono" data-type={value === null ? 'null' : typeof value}><Highlight text={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} query={query} /></span>
                    <span className="firebase-param-type">{value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}</span>
                    <span className="firebase-param-copy" title={`Copy ${key}`}><CopyButton text={JSON.stringify({ [key]: value }, null, 2)} /></span>
                  </div>
                )}</div> : <p className="pad dim">No parameters</p>}
                {firebase.truncated && <p className="pad dim">Parameters truncated by the SDK.</p>}
              </div>}
            </li>
          })}
        </ol> : <TrafficEmpty kind="firebase" {...emptyState} hasTraffic={scopedCount > 0}
          onResetFilters={() => { setUserId(null); setNameFilter(filter => setAllEnabled(filter, false)); emptyState.onResetFilters() }} />}
      </div>
      {includeApi && <div className="firebase-timeline-note">Same device, ordered by capture time. API requests are context, not confirmed causes.
        {unknownApiUsers && <span> Requests without a captured User ID appear only under All users.</span>}
      </div>}
    </div>
    {active && menu && <RowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
      { label: 'Copy name', text: menu.name, icon: 'event' },
    ]} />}
    {selectedEntry?.kind === 'http' && <>
      <div className="pane-resizer" onMouseDown={startDetailDrag} />
      <HttpDetail key={selectedEntry.id} row={selectedEntry.row} query={query}
        onMock={onMock} onArm={onArm} onClose={() => setSelectedId(null)} />
    </>}

  </div>
}
