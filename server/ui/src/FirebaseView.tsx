import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FirebaseRow, type HttpMockRule, type HttpRow } from './state'
import { CopyButton, Highlight, HttpDetail, KV, RowMenu, Section } from './HttpView'
import { FilterMenu } from './FilterMenu'
import { loadFilter, passesFilter, saveFilter, setAllEnabled } from './trafficFilter'
import { TrafficEmpty, type TrafficEmptyProps } from './TrafficEmpty'
import { useDetailWidth, useFollowLatestRow, useListKeys, useUnreadRows } from './hooks'
import { fmtDuration, fmtTime, statusClass, statusLabel, urlParts } from './util'

export function FirebaseIcon() {
  return <img src="/firebase.svg" width="18" height="18" alt="" aria-hidden="true" />
}

const labels = { fatal: 'Fatal', 'non-fatal': 'Non-fatal', log: 'Log' }
type TimelineEntry = { id: string; ts: number; userId: string | undefined } & (
  { kind: 'firebase'; row: FirebaseRow } | { kind: 'http'; row: HttpRow }
)

function timelineName(entry: TimelineEntry): string {
  return entry.kind === 'firebase'
    ? [entry.row.exception, entry.row.message].filter(Boolean).join(': ')
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
  const [severity, setSeverity] = useState('all')
  const [userId, setUserId] = useState<string | null>(null)
  const [nameFilter, setNameFilter] = useState(() => loadFilter('sniffer-filter-firebase-name', localStorage))
  const [includeApi, setIncludeApi] = useState(() => localStorage.getItem('sniffer-firebase-api') !== 'false')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const deviceId = emptyState.device?.deviceId
  useEffect(() => { setUserId(null); setSelectedId(null); setMenu(null) }, [deviceId])
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
    return [...firebase, ...http].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
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
      if (entry.kind === 'firebase') return firebaseIds.has(entry.row.id) && (severity === 'all' || entry.row.severity === severity)
      if (!includeApi) return false
      const row = entry.row
      return !q || [row.url, row.method, row.userId ?? '', String(row.status ?? ''), row.error ?? '',
        ...Object.entries(row.reqHeaders).flat(), ...Object.entries(row.respHeaders ?? {}).flat(),
        ...(q.length >= 2 ? [row.reqBody ?? '', row.respBase64 ? '' : row.respBody ?? ''] : [])]
        .some(value => value.toLowerCase().includes(q))
    })
  }, [entries, rows, userId, severity, includeApi, query, nameFilter])
  const selectedEntry = visible.find(entry => entry.id === selectedId)
  const selected = selectedEntry?.kind === 'firebase' ? selectedEntry.row : undefined
  const ids = useMemo(() => visible.map(entry => entry.id), [visible])
  const visibleFirebase = useMemo(() => visible.filter(entry => entry.kind === 'firebase').map(entry => entry.row), [visible])
  const listRef = useRef<HTMLDivElement>(null)
  const [detailWidth, startDetailDrag] = useDetailWidth()
  useListKeys(ids, selectedId, setSelectedId, active)
  // The Firebase tab's unread badge counts Firebase events, just as the API badge counts requests.
  useUnreadRows(allRows, visibleFirebase, active, unreadScope, onUnreadChange)
  useFollowLatestRow(entries, visible, active && followLatest && !menu, unreadScope, setSelectedId, listRef)
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
  return <div className="split firebase-panel" hidden={!active} data-detail-open={selectedEntry ? true : undefined} style={{ ['--detail-w' as string]: `${detailWidth}px` }}>
    <aside className="firebase-users" aria-label="Firebase user filters">
      <div className="firebase-users-title">Users</div>
      {userButton(null, 'All users', scopedCount)}
      {userButton('', 'No user ID', counts.get('') ?? 0)}
      {userIds.map(id => userButton(id, id, counts.get(id) ?? 0))}
    </aside>
    <div className="list-pane">
      <div className="panel-toolbar">
        <select aria-label="Firebase severity" value={severity} onChange={e => setSeverity(e.target.value)}>
          <option value="all">All levels</option>
          <option value="fatal">Fatal</option>
          <option value="non-fatal">Non-fatal</option>
          <option value="log">Logs</option>
        </select>
        <span className="table-header-control"><span>Name</span><FilterMenu filter={nameFilter} onChange={setNameFilter}
          placeholder="Name contains…" selectionValue={selectedEntry ? timelineName(selectedEntry) : null} /></span>
        <label className="firebase-api-toggle"><input type="checkbox" checked={includeApi} onChange={e => setIncludeApi(e.target.checked)} />Include API</label>
        <span className="spacer" />
        <button className="clear-btn" title="Clear Firebase records for all devices; API requests are kept" disabled={clearing || !allRows.length}
          onClick={() => void clear()}>{clearing ? 'Clearing…' : 'Clear Firebase'}</button>
      </div>
      {error && <div className="pad firebase-error" role="alert">{error}</div>}
      <div className="firebase-timeline-caption"><strong>{userId === null ? 'All users' : userId || 'No user ID'}</strong><span>{visible.length} records</span></div>
      <div className="list-scroll" ref={listRef}>
        {visible.length ? <ol className="firebase-timeline" aria-label="Firebase timeline">
          {visible.map(entry => {
            const firebase = entry.kind === 'firebase' ? entry.row : undefined
            const http = entry.kind === 'http' ? entry.row : undefined
            const message = timelineName(entry)
            return <li key={entry.id}>
              <button className="firebase-event" data-kind={entry.kind} data-level={firebase?.severity ?? 'http'}
                data-selected={entry.id === selectedId || undefined} aria-pressed={entry.id === selectedId}
                onClick={() => setSelectedId(entry.id)}
                onContextMenu={event => {
                  event.preventDefault()
                  setSelectedId(entry.id)
                  setMenu({ x: event.clientX, y: event.clientY, name: message })
                }}>
                <time className="mono dim" title={new Date(entry.ts).toLocaleString()} dateTime={new Date(entry.ts).toISOString()}>{fmtTime(entry.ts)}</time>
                <span className="firebase-event-dot" aria-hidden="true" />
                <span className="firebase-event-body">
                  <span className="firebase-event-message" title={http?.url ?? message}><Highlight text={message} query={query} /></span>
                  <span className="firebase-event-meta">
                    <span className="firebase-level" data-level={firebase?.severity ?? 'http'}>{firebase ? labels[firebase.severity] : 'API'}</span>
                    {http && <><span className={statusClass(http.status)}>{statusLabel(http.status)}</span>{http.durationMs !== undefined && <span>{fmtDuration(http.durationMs)}</span>}<span className="firebase-event-host">{urlParts(http.url).domain}</span></>}
                    <span>{entry.userId === undefined ? 'User ID unavailable' : entry.userId || 'No user ID'}</span>
                  </span>
                </span>
              </button>
            </li>
          })}
        </ol> : <TrafficEmpty kind="firebase" {...emptyState} hasTraffic={scopedCount > 0}
          onResetFilters={() => { setSeverity('all'); setUserId(null); setNameFilter(filter => setAllEnabled(filter, false)); emptyState.onResetFilters() }} />}
      </div>
      {includeApi && <div className="firebase-timeline-note">Same device, ordered by capture time. API requests are context, not confirmed causes.
        {unknownApiUsers && <span> Requests without a captured User ID appear only under All users.</span>}
      </div>}
    </div>
    {active && menu && <RowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
      { label: 'Copy name', text: menu.name, icon: 'event' },
    ]} />}
    {selectedEntry && <>
      <div className="pane-resizer" onMouseDown={startDetailDrag} />
      {selectedEntry.kind === 'http' && <HttpDetail key={selectedEntry.id} row={selectedEntry.row} query={query}
        onMock={onMock} onArm={onArm} onClose={() => setSelectedId(null)} />}
      {selected && <>
      <aside className="detail-pane" aria-label="Firebase record details">
        <div className="detail-toolbar">
          <span className="firebase-level" data-level={selected.severity}>{labels[selected.severity]}</span>
          <span className="spacer" />
          <CopyButton text={JSON.stringify(selected, null, 2)} />
          <button className="ghost" aria-label="Close Firebase details" onClick={() => setSelectedId(null)}>Close</button>
        </div>
        <Section title="Exception">
          {selected.exception && <KV k="Type" v={selected.exception} query={query} />}
          <KV k="Message" v={selected.message} query={query} />
          <KV k="Time" v={new Date(selected.ts).toLocaleString()} />
          {selected.thread && <KV k="Thread" v={selected.thread} query={query} />}
          <KV k="User ID" v={selected.userId || "No user ID"} query={query} />
          {selected.truncated && <p className="pad dim">Message or stack trace truncated by the SDK.</p>}
        </Section>
        {selected.stackTrace && <Section title="Stack trace" action={<CopyButton text={selected.stackTrace} />}>
          <pre className="firebase-stack mono"><Highlight text={selected.stackTrace} query={query} /></pre>
        </Section>}
        <Section title="Custom keys">
          {Object.entries(selected.keys).length ? Object.entries(selected.keys).map(([key, value]) =>
            <KV key={key} k={key} v={value} query={query} />) : <p className="pad dim">No custom keys</p>}
        </Section>
        {selected.severity !== 'log' && <Section title="Logs before this event">
          {selected.logs.length ? selected.logs.map((log, index) => <div className="firebase-log pad" key={index}>
            <time className="mono dim">{fmtTime(log.timestamp)}</time>
            <span><Highlight text={log.message} query={query} /></span>
          </div>) : <p className="pad dim">No logs recorded before this event</p>}
        </Section>}
      </aside>
      </>}
    </>}
  </div>
}
