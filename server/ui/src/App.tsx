import { useEffect, useMemo, useReducer, useState, useDeferredValue } from 'react'
import { connectStream, initialState, reducer, api, emptyMocks, type HttpMockRule, type SocketMockRule } from './state'
import { HttpView } from './HttpView'
import { SocketView } from './SocketView'
import { MocksView } from './MocksView'

type Tab = 'http' | 'socket' | 'mocks'
type PushPrefill = { connectionId: string; event: string; payload: string }

declare const __APP_VERSION__: string
const APP_VERSION = __APP_VERSION__


function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('sniffer-tab') as Tab) || 'http')
  const [deviceId, setDeviceId] = useState<string>(() => localStorage.getItem('sniffer-device') ?? '')
  const [search, setSearch] = useState('')
  const [pendingRule, setPendingRule] = useState<HttpMockRule | null>(null)
  const [pendingSocketRule, setPendingSocketRule] = useState<SocketMockRule | null>(null)
  const [pendingPush, setPendingPush] = useState<PushPrefill | null>(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('sniffer-theme') ?? 'light')
  const [deletingDevices, setDeletingDevices] = useState(false)
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => connectStream(dispatch), [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('sniffer-theme', theme)
  }, [theme])

  useEffect(() => { localStorage.setItem('sniffer-tab', tab) }, [tab])

  // ←/→ cycle the tabs (↑/↓ walk list rows inside a view); form fields keep their arrows
  useEffect(() => {
    const TABS: Tab[] = ['http', 'socket', 'mocks']
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      setTab(cur => {
        const i = TABS.indexOf(cur)
        return TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (deviceId) localStorage.setItem('sniffer-device', deviceId)
    else localStorage.removeItem('sniffer-device')
  }, [deviceId])

  const devices = useMemo(
    () => [...state.devices].sort((a, b) => Number(b.connected) - Number(a.connected)),
    [state.devices],
  )
  const selectedDevice = devices.find(d => d.deviceId === deviceId) ?? null
  // a stale localStorage deviceId must not surface mocks when its device is gone
  const selectedMocks = selectedDevice ? state.mocksByDevice[deviceId] ?? emptyMocks : emptyMocks
  const activeMockCount =
    selectedMocks.http.filter(r => r.enabled).length + selectedMocks.socket.filter(r => r.enabled).length
  const canDeleteDevices = Boolean(selectedDevice && !selectedDevice.connected)
  const deleteButtonTitle = !selectedDevice
    ? 'No device selected'
    : selectedDevice.connected ? 'Connected devices cannot be deleted' : 'Delete offline device'

  // deferred so typing stays snappy even when the query scans large stored bodies
  const deferredSearch = useDeferredValue(search)
  const filteredHttp = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    // bodies join the search from 2+ chars — a single char would match nearly everything
    const searchBodies = q.length >= 2
    return state.http.filter(r =>
      r.deviceId === deviceId &&
      (!q || r.url.toLowerCase().includes(q) || r.method.toLowerCase().includes(q) ||
        String(r.status ?? '').includes(q) ||
        (searchBodies && (
          (r.reqBody?.toLowerCase().includes(q) ?? false) ||
          (!r.respBase64 && (r.respBody?.toLowerCase().includes(q) ?? false))
        ))))
  }, [state.http, deviceId, deferredSearch])

  const filteredSocketEvents = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    return state.socketEvents.filter(r =>
      r.deviceId === deviceId &&
      (!q || r.event.toLowerCase().includes(q) || r.payload.toLowerCase().includes(q)))
  }, [state.socketEvents, deviceId, deferredSearch])

  const mockFromRequest = (rule: HttpMockRule, targetDeviceId: string) => {
    setDeviceId(targetDeviceId)
    setPendingRule(rule)
    setTab('mocks')
  }

  const mockFromSocketEvent = (rule: SocketMockRule, targetDeviceId: string) => {
    setDeviceId(targetDeviceId)
    setPendingSocketRule(rule)
    setTab('mocks')
  }

  const pushFromEvent = (prefill: PushPrefill) => {
    setPendingPush(prefill)
    setTab('mocks')
  }

  // no "all devices" view — always keep a single concrete device selected
  useEffect(() => {
    if (devices.length === 0) return
    if (!devices.some(d => d.deviceId === deviceId)) {
      setDeviceId((devices.find(d => d.connected) ?? devices[0]).deviceId)
    }
  }, [deviceId, devices])

  const deleteDevices = async () => {
    if (!selectedDevice || selectedDevice.connected) return

    setDeletingDevices(true)
    setDeviceNotice(null)
    try {
      const res = await api.deleteDevice(selectedDevice.deviceId)
      if (!res.ok) {
        setDeviceNotice(`Delete failed: ${await readApiError(res)}`)
        return
      }
      setDeviceId('')
    } catch (e) {
      setDeviceNotice(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeletingDevices(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/sniffer.svg" alt="" />
            <span className="brand-status" data-on={state.wsConnected || undefined} />
          </span>
          Sniffer
        </div>

        <select className="device-select" value={deviceId}
          onChange={e => setDeviceId(e.target.value)} disabled={devices.length === 0}>
          {devices.length === 0 && <option value="">No devices connected</option>}
          {devices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.connected ? '🟢' : '🔴'} {d.deviceName} · {d.appId}
            </option>
          ))}
        </select>
        {canDeleteDevices && (
          <button className="ghost danger" disabled={deletingDevices}
            title={deleteButtonTitle} onClick={deleteDevices}>
            {deletingDevices ? 'Deleting…' : 'Delete offline device'}
          </button>
        )}
        {deviceNotice && <span className="topbar-notice">{deviceNotice}</span>}

        <input
          className="search"
          placeholder="Search URL, method, status, event…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <nav className="tabs">
          <button data-active={tab === 'http' || undefined} onClick={() => setTab('http')}>
            API <span className="count">{filteredHttp.length}</span>
          </button>
          <button data-active={tab === 'socket' || undefined} onClick={() => setTab('socket')}>
            Socket <span className="count">{filteredSocketEvents.length}</span>
          </button>
          <button data-active={tab === 'mocks' || undefined} onClick={() => setTab('mocks')}>
            Mocks {activeMockCount > 0 && <span className="count accent">{activeMockCount}</span>}
          </button>
        </nav>

        <span className="spacer" />

        <button className="ghost icon-btn" title="Toggle light/dark theme" onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}>
          {theme === 'light' ? <MoonIcon /> : <SunIcon />}
        </button>

        <div className="settings">
          <button className="ghost" title="Settings" onClick={() => setShowSettings(v => !v)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {showSettings && (
            <>
              <div className="settings-backdrop" onClick={() => setShowSettings(false)} />
              <div className="settings-popover">
                <div className="settings-title">Sniffer</div>
                <div className="settings-row">
                  <span className="dim">Version</span>
                  <span className="mono">{APP_VERSION}</span>
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="content">
        {tab === 'http' && (
          <HttpView rows={filteredHttp} onMock={mockFromRequest}
            onClear={() => { if (confirm('Clear API traffic?')) api.clearHttpEntries() }} />
        )}
        {tab === 'socket' && (
          <SocketView events={filteredSocketEvents} conns={state.socketConns} connUrls={state.connUrls} deviceId={deviceId}
            onMockAck={mockFromSocketEvent} onPushPrefill={pushFromEvent}
            onClear={() => { if (confirm('Clear socket events?')) api.clearSocketEntries() }} />
        )}
        {tab === 'mocks' && (
          <MocksView deviceId={selectedDevice ? deviceId : null}
            mocks={selectedMocks}
            conns={state.socketConns}
            pendingRule={pendingRule}
            pendingSocketRule={pendingSocketRule}
            pushPrefill={pendingPush}
            onPendingConsumed={() => { setPendingRule(null); setPendingSocketRule(null); setPendingPush(null) }} />
        )}
      </main>
    </div>
  )
}

async function readApiError(res: Response): Promise<string> {
  try {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = await res.json() as { error?: unknown }
      if (typeof body.error === 'string') return `${res.status} ${body.error}`
    }
    const text = await res.text()
    return text ? `${res.status} ${text}` : `${res.status} ${res.statusText}`
  } catch {
    return `${res.status} ${res.statusText}`
  }
}
