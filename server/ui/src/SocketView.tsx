import { useState } from 'react'
import type { SocketConn, SocketMockRule, SocketRow } from './state'
import { fmtTime, newRuleId } from './util'
import { JsonView } from './JsonView'
import { KV, Section } from './HttpView'

export function SocketView({ events, conns, deviceId, onMockAck, onPushPrefill, onClear }: {
  events: SocketRow[]
  conns: SocketConn[]
  deviceId: string
  onMockAck: (rule: SocketMockRule, deviceId: string) => void
  onPushPrefill: (prefill: { connectionId: string; event: string; payload: string }) => void
  onClear: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sortDesc, setSortDesc] = useState(false)
  const selected = events.find(e => e.id === selectedId) ?? null
  const sorted = sortDesc ? [...events].reverse() : events
  const liveConns = conns.filter(c => c.deviceId === deviceId && c.status === 'connected')

  return (
    <div className="split">
      <div className="list-pane">
        <div className="panel-toolbar">
          <span className="dim">Socket events</span>
          <span className="spacer" />
          <button className="clear-btn" disabled={events.length === 0} onClick={onClear}>Clear Socket</button>
        </div>
        <div className="list-scroll">
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
                  <span className="badge lib">{e.transport === 'socketio' ? 'sio' : 'ws'}</span>
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

      <aside className="detail-pane">
        {selected ? (
          <>
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
            </div>
            <Section title="Event">
              <KV k="Event" v={selected.event} />
              <KV k="Direction" v={selected.direction === 'out' ? 'client → server' : 'server → client'} />
              <KV k="Transport" v={selected.transport} />
              <KV k="Connection" v={
                conns.find(c => c.connectionId === selected.connectionId)?.url
                  || selected.connectionId.slice(0, 8)
              } />
              {selected.mocked && <KV k="Mocked" v="yes" />}
            </Section>
            <Section title="Payload">
              <JsonView text={selected.payload} />
            </Section>
            {selected.ackPayload !== undefined && (
              <Section title={selected.ackMocked ? 'Ack (mock)' : 'Ack'}>
                <JsonView text={selected.ackPayload} />
              </Section>
            )}
          </>
        ) : (
          <div className="empty">Select an event to inspect</div>
        )}
      </aside>
    </div>
  )
}
