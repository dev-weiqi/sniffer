import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnLogEntry, SocketConn, SocketMockRule, SocketRow } from './state'
import { fmtTime, newRuleId, useDetailWidth, useListKeys } from './util'
import { JsonView } from './JsonView'
import { CopyButton, KV, Section } from './HttpView'

export function SocketView({ events, conns, connUrls, connLog, deviceId, onMockAck, onPushPrefill, onClear }: {
  events: SocketRow[]
  conns: SocketConn[]
  connUrls: Record<string, string>
  connLog: ConnLogEntry[]
  deviceId: string
  onMockAck: (rule: SocketMockRule, deviceId: string) => void
  onPushPrefill: (prefill: { connectionId: string; event: string; payload: string }) => void
  onClear: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sortDesc, setSortDesc] = useState(false)
  const [showConns, setShowConns] = useState(false)
  const [connFilter, setConnFilter] = useState<string | null>(null)
  const filtered = connFilter ? events.filter(e => e.connectionId === connFilter) : events
  const selected = filtered.find(e => e.id === selectedId) ?? null
  const sorted = sortDesc ? [...filtered].reverse() : filtered
  const liveConns = conns.filter(c => c.deviceId === deviceId && c.status === 'connected')
  const ids = useMemo(() => sorted.map(e => e.id), [sorted])
  useListKeys(ids, selectedId, setSelectedId)
  const [detailWidth, startDetailDrag] = useDetailWidth()
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (el && !sortDesc && stickBottom.current && !selectedId) el.scrollTop = el.scrollHeight
  }, [events.length, selectedId, sortDesc])

  return (
    <div className="split" style={{ ['--detail-w' as string]: `${detailWidth}px` }}>
      <div className="list-pane">
        <div className="panel-toolbar">
          <span className="dim">Socket events</span>
          <button className="pill-btn" data-active={showConns || undefined}
            onClick={() => setShowConns(v => !v)}>Connections</button>
          {connFilter && (
            <button className="pill-btn" onClick={() => setConnFilter(null)}>
              {(connUrls[connFilter] || connFilter.slice(0, 8))} ✕
            </button>
          )}
          <span className="spacer" />
          <button className="clear-btn" disabled={events.length === 0} onClick={onClear}>Clear Socket</button>
        </div>
        {showConns && (
          <ConnTimeline connLog={connLog.filter(c => c.deviceId === deviceId)} events={events}
            active={connFilter} onPick={id => setConnFilter(f => f === id ? null : id)} />
        )}
        <div
          className="list-scroll"
          ref={listRef}
          onScroll={e => {
            const el = e.currentTarget
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
        {liveConns.length > 0 && (
          <div className="conn-bar">
            {liveConns.map(c => (
              <span key={c.connectionId} className="conn-chip" data-on>
                {c.transport} · {c.url || '(unknown url)'}
              </span>
            ))}
          </div>
        )}
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 90 }} className="sortable" onClick={() => setSortDesc(d => !d)}>
                Time {sortDesc ? '↓' : '↑'}
              </th>
              <th style={{ width: 36 }}></th>
              <th style={{ width: 160 }}>Event</th>
              <th>Payload</th>
              <th style={{ width: 80 }}>Ack</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(e => (
              <tr key={e.id} data-selected={e.id === selectedId || undefined}
                onClick={() => setSelectedId(e.id === selectedId ? null : e.id)}>
                <td className="mono dim">{fmtTime(e.ts)}</td>
                <td className={e.direction === 'out' ? 'dir-out' : 'dir-in'}>
                  {e.direction === 'out' ? '↑' : '↓'}
                </td>
                <td className="mono">
                  {e.mocked && <span className="badge mock">MOCK</span>}
                  {e.event}
                </td>
                <td className="mono dim ellipsis">{e.payload}</td>
                <td className="mono dim">
                  {e.ackPayload !== undefined ? (e.ackMocked ? 'mock ✓' : '✓') : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && <div className="empty">No socket events yet</div>}
        </div>
      </div>

      {selected && <div className="pane-resizer" onMouseDown={startDetailDrag} />}
      {selected && (
      <aside className="detail-pane">
            <div className="detail-toolbar">
              {selected.direction === 'out' && selected.transport === 'socketio' && (
                <button onClick={() => onMockAck(
                  {
                    id: newRuleId(), enabled: true, transport: 'socketio', event: selected.event,
                    ackPayload: selected.ackPayload ?? '[{"ok":true}]', delayMs: 0,
                  },
                  selected.deviceId,
                )}>Mock this event's ack</button>
              )}
              {selected.direction === 'out' && selected.transport === 'ktor-ws' && (
                <button onClick={() => onMockAck(
                  {
                    id: newRuleId(), enabled: true, transport: 'ktor-ws', event: selected.payload,
                    ackPayload: '{"mock":"reply"}', delayMs: 0,
                  },
                  selected.deviceId,
                )}>Mock reply for this send</button>
              )}
              {selected.direction === 'in' && (
                <button onClick={() => onPushPrefill({
                  connectionId: selected.connectionId,
                  event: selected.event,
                  payload: selected.payload,
                })}>
                  Prefill push form
                </button>
              )}
              <span className="spacer" />
              <button className="ghost" onClick={() => setSelectedId(null)}>✕</button>
            </div>
            <Section title="Event">
              <KV k="Event" v={selected.event} />
              <KV k="Direction" v={selected.direction === 'out' ? 'client → server' : 'server → client'} />
              <KV k="Transport" v={selected.transport} />
              <KV k="Connection" v={connUrls[selected.connectionId] || selected.connectionId.slice(0, 8)} />
              {selected.mocked && <KV k="Mocked" v="yes" />}
            </Section>
            <Section title="Payload" action={selected.payload ? <CopyButton text={selected.payload} /> : undefined}>
              <JsonView text={selected.payload} />
            </Section>
            {selected.ackPayload !== undefined && (
              <Section title={selected.ackMocked ? 'Ack (mock)' : 'Ack'}
                action={selected.ackPayload ? <CopyButton text={selected.ackPayload} /> : undefined}>
                <JsonView text={selected.ackPayload} />
              </Section>
            )}
      </aside>
      )}
    </div>
  )
}

interface ConnSpan {
  connectionId: string
  transport: string
  url: string
  firstTs: number
  lastTs: number
  live: boolean
  eventCount: number
}

function ConnTimeline({ connLog, events, active, onPick }: {
  connLog: ConnLogEntry[]
  events: SocketRow[]
  active: string | null
  onPick: (id: string) => void
}) {
  // fold the status history into one span per connection, grouped by endpoint
  const spans = new Map<string, ConnSpan>()
  for (const c of connLog) {
    const cur = spans.get(c.connectionId)
    if (!cur) {
      spans.set(c.connectionId, {
        connectionId: c.connectionId, transport: c.transport, url: c.url,
        firstTs: c.ts, lastTs: c.ts, live: c.status === 'connected', eventCount: 0,
      })
    } else {
      cur.lastTs = c.ts
      cur.live = c.status === 'connected'
    }
  }
  for (const e of events) {
    const span = spans.get(e.connectionId)
    if (span) span.eventCount++
  }
  const byEndpoint = new Map<string, ConnSpan[]>()
  for (const span of spans.values()) {
    const key = `${span.transport} · ${span.url || '(unknown url)'}`
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), span])
  }
  if (byEndpoint.size === 0) {
    return <div className="conn-timeline"><span className="dim">No connection history yet</span></div>
  }
  return (
    <div className="conn-timeline">
      {[...byEndpoint.entries()].map(([endpoint, list]) => (
        <div key={endpoint} className="conn-group">
          <div className="dim mono conn-endpoint">{endpoint}</div>
          {list.map(c => (
            <button key={c.connectionId} className="conn-span" data-active={c.connectionId === active || undefined}
              onClick={() => onPick(c.connectionId)}>
              <span className={c.live ? 'conn-dot on' : 'conn-dot'} />
              <span className="mono">{c.connectionId.slice(0, 8)}</span>
              <span className="mono dim">{fmtTime(c.firstTs)}</span>
              <span className="dim">→</span>
              {c.live
                ? <span className="conn-live">LIVE</span>
                : <span className="mono dim">{fmtTime(c.lastTs)}</span>}
              <span className="dim">· {fmtSpan(c.lastTs - c.firstTs, c.live)}</span>
              <span className="dim">· {c.eventCount} events</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function fmtSpan(ms: number, live: boolean): string {
  if (live) return 'still up'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
