import { useEffect, useMemo, useRef, useState } from 'react'
import type { SocketConn, SocketMockRule, SocketRow } from './state'
import { fmtTime, newRuleId, useDetailWidth, useListKeys } from './util'
import { JsonView } from './JsonView'
import { CopyButton, KV, Section } from './HttpView'

export function SocketView({ events, conns, connUrls, deviceId, onMockAck, onPushPrefill, onClear }: {
  events: SocketRow[]
  conns: SocketConn[]
  connUrls: Record<string, string>
  deviceId: string
  onMockAck: (rule: SocketMockRule, deviceId: string) => void
  onPushPrefill: (prefill: { connectionId: string; event: string; payload: string }) => void
  onClear: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sortDesc, setSortDesc] = useState(false)
  const [connFilter, setConnFilter] = useState<string | null>(null)
  const selected = events.find(e => e.id === selectedId) ?? null
  const liveConns = conns.filter(c => c.deviceId === deviceId && c.status === 'connected')
  const filtered = connFilter ? events.filter(e => e.connectionId === connFilter) : events
  const sorted = sortDesc ? [...filtered].reverse() : filtered

  // the filtered connection can die (or the device can change) — don't stay stuck on an invisible filter
  useEffect(() => {
    if (connFilter && !liveConns.some(c => c.connectionId === connFilter)) setConnFilter(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns, deviceId, connFilter])
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
          <span className="spacer" />
          <button className="clear-btn" disabled={events.length === 0} onClick={onClear}>Clear Socket</button>
        </div>
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
            <button className="conn-chip all" data-active={connFilter === null || undefined}
              title="Show events from all connections" onClick={() => setConnFilter(null)}>
              All
            </button>
            {liveConns.map(c => (
              <button key={c.connectionId} className="conn-chip" data-on
                data-active={c.connectionId === connFilter || undefined}
                title="Show only this connection"
                onClick={() => setConnFilter(c.connectionId)}>
                {c.transport} · {c.url || '(unknown url)'}
              </button>
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
        {sorted.length === 0 && (
          <div className="empty">{connFilter ? 'No events for this connection yet' : 'No socket events yet'}</div>
        )}
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
