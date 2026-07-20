// UI-side data model and /ui WebSocket stream, mirroring PROTOCOL.md

export interface Device {
  deviceId: string
  deviceName: string
  platform: string
  appId: string
  sdkVersion: string
  capabilities: string[]
  connected: boolean
}

export interface HttpMockRule {
  id: string
  /** optional user label; UI-only, ignored by the SDK */
  name?: string
  /** UI-stamped creation time; newest wins among duplicate matchers */
  createdAt?: number
  /** shared with every device of the same appId; daemon strips it before device sync */
  starred?: boolean
  enabled: boolean
  method: string | null
  urlPattern: string
  status: number
  headers: Record<string, string>
  body: string
  delayMs: number
  delayOnly: boolean
}

export interface SocketMockRule {
  id: string
  /** optional user label; UI-only, ignored by the SDK */
  name?: string
  /** UI-stamped creation time; newest wins among duplicate matchers */
  createdAt?: number
  /** shared with every device of the same appId; daemon strips it before device sync */
  starred?: boolean
  enabled: boolean
  transport: 'socketio' | 'ktor-ws'
  event: string
  ackPayload: string
  delayMs: number
}

export interface Mocks {
  http: HttpMockRule[]
  socket: SocketMockRule[]
}

export interface BreakpointRule {
  id: string
  enabled: boolean
  method: string | null
  urlPattern: string
  /** pause after the real response arrives, before the app sees it */
  phase: 'response'
}

/** A response paused on the device, waiting for the user to resume (with optional edits) or abort.
 *  method/url identify the call; status/headers/body are the editable response. */
export interface PausedHit {
  id: string
  deviceId: string
  ruleId: string
  phase: string
  method: string
  url: string
  status: number
  headers: Record<string, string>
  body: string | null
  library: string
  timestamp: number
}

export interface HttpRow {
  id: string
  deviceId: string
  ts: number
  method: string
  url: string
  library: string
  reqHeaders: Record<string, string>
  reqBody: string | null
  reqSize: number
  status?: number
  respHeaders?: Record<string, string>
  respBody?: string | null
  respBase64?: boolean
  respSize?: number
  durationMs?: number
  delayedMs?: number
  mocked?: boolean
  error?: string | null
}

export interface SocketConn {
  connectionId: string
  deviceId: string
  transport: string
  url: string
  status: string
}

export interface SocketRow {
  id: string
  connectionId: string
  deviceId: string
  ts: number
  transport: string
  direction: 'in' | 'out'
  event: string
  /** app-provided display tag, rendered as `event(label)`; `event` stays the real wire name */
  label?: string
  payload: string
  mocked: boolean
  ackPayload?: string | null
  ackMocked?: boolean
}

export interface State {
  wsConnected: boolean
  /** true when the daemon runs from repo source (not the published npm package) */
  dev: boolean
  devices: Device[]
  http: HttpRow[]
  socketConns: SocketConn[]
  /** connectionId → url, never pruned: historical events must resolve after their conn is gone */
  connUrls: Record<string, string>
  socketEvents: SocketRow[]
  mocksByDevice: Record<string, Mocks>
  breakpointsByDevice: Record<string, BreakpointRule[]>
  pausedHits: PausedHit[]
}

export type DoctorStatus = 'ok' | 'warn' | 'error' | 'skip'

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorStatus
  summary: string
  details?: string[]
}

export interface DoctorReport {
  generatedAt: number
  platform: string
  port: number
  bindHost: string
  checks: DoctorCheck[]
}

export const emptyMocks: Mocks = { http: [], socket: [] }
const MAX_MONITOR_ROWS = 500

export const initialState: State = {
  wsConnected: false,
  dev: false,
  devices: [],
  http: [],
  socketConns: [],
  connUrls: {},
  socketEvents: [],
  mocksByDevice: {},
  breakpointsByDevice: {},
  pausedHits: [],
}

type Msg = Record<string, any>

function appendCapped<T>(rows: T[], row: T): T[] {
  const next = [...rows, row]
  return next.length > MAX_MONITOR_ROWS ? next.slice(next.length - MAX_MONITOR_ROWS) : next
}

function applyDeviceMessage(state: State, deviceId: string, m: Msg): State {
  switch (m.type) {
    case 'http-request': {
      const row: HttpRow = {
        id: m.id, deviceId, ts: m.timestamp, method: m.method, url: m.url,
        library: m.library, reqHeaders: m.headers ?? {}, reqBody: m.body,
        reqSize: m.bodySize ?? 0,
      }
      return { ...state, http: appendCapped(state.http, row) }
    }
    case 'http-response': {
      const http = state.http.map(r => r.id === m.id ? {
        ...r, status: m.status, respHeaders: m.headers ?? {}, respBody: m.body,
        respBase64: m.bodyBase64 ?? false,
        respSize: m.bodySize ?? 0, durationMs: m.durationMs, mocked: m.mocked,
        error: m.error,
        // absent on follow-up updates (e.g. SSE tee) must not erase an earlier value
        delayedMs: m.delayedMs ?? r.delayedMs,
      } : r)
      return { ...state, http }
    }
    case 'socket-status': {
      const conn: SocketConn = {
        connectionId: m.connectionId, deviceId, transport: m.transport,
        url: m.url, status: m.status,
      }
      // one connection per endpoint: a fresh connect kills its predecessors, so apps
      // that recreate sockets per reconnect don't pile up zombie connections
      const connUrls = m.url ? { ...state.connUrls, [m.connectionId]: m.url } : state.connUrls
      const rest = state.socketConns.filter(c =>
        c.connectionId !== m.connectionId &&
        !(m.status === 'connected' && c.deviceId === deviceId &&
          c.transport === m.transport && c.url === m.url))
      return { ...state, socketConns: [...rest, conn], connUrls }
    }
    case 'socket-event': {
      const row: SocketRow = {
        id: m.id, connectionId: m.connectionId, deviceId, ts: m.timestamp,
        transport: m.transport, direction: m.direction, event: m.event,
        label: m.label ?? undefined,
        payload: m.payload, mocked: m.mocked,
      }
      return { ...state, socketEvents: appendCapped(state.socketEvents, row) }
    }
    case 'socket-ack': {
      const socketEvents = state.socketEvents.map(e =>
        e.id === m.id ? { ...e, ackPayload: m.payload, ackMocked: m.mocked } : e)
      return { ...state, socketEvents }
    }
    default:
      return state
  }
}

export type Action =
  | { type: 'ws'; connected: boolean }
  | { type: 'server'; msg: Msg }

export function reducer(state: State, action: Action): State {
  if (action.type === 'ws') return { ...state, wsConnected: action.connected }
  const m = action.msg
  switch (m.type) {
    case 'init': {
      let s: State = {
        ...initialState,
        wsConnected: true,
        devices: m.devices ?? [],
        mocksByDevice: m.mocksByDevice ?? {},
        breakpointsByDevice: m.breakpointsByDevice ?? {},
        // daemon sends [{ deviceId, hit }]; flatten to the UI's PausedHit shape
        pausedHits: (m.pausedHits ?? []).map((p: any) => ({ deviceId: p.deviceId, ...p.hit })),
      }
      for (const e of m.entries ?? []) s = applyDeviceMessage(s, e.deviceId, e.message)
      return s
    }
    case 'server-info':
      return { ...state, dev: !!m.dev }
    case 'event':
      return applyDeviceMessage(state, m.deviceId, m.message)
    case 'device-status': {
      const existing = state.devices.find(d => d.deviceId === m.deviceId)
      const devices = existing
        ? state.devices.map(d => d.deviceId === m.deviceId ? { ...d, ...(m.info ?? {}), connected: m.connected } : d)
        : [...state.devices, { ...(m.info ?? {}), deviceId: m.deviceId, connected: m.connected }]
      // a dead device cannot have live sockets: without this, an app killed mid-connection
      // leaves zombie "connected" chips that nothing will ever clear
      const socketConns = m.connected
        ? state.socketConns
        : state.socketConns.map(c => c.deviceId === m.deviceId ? { ...c, status: 'disconnected' } : c)
      return { ...state, devices, socketConns }
    }
    case 'mocks-changed':
      return {
        ...state,
        mocksByDevice: { ...state.mocksByDevice, [m.deviceId]: m.mocks },
      }
    case 'breakpoints-changed':
      return {
        ...state,
        breakpointsByDevice: { ...state.breakpointsByDevice, [m.deviceId]: m.rules },
      }
    case 'breakpoint-hit':
      return { ...state, pausedHits: [...state.pausedHits, { deviceId: m.deviceId, ...m.hit }] }
    case 'breakpoint-resolved':
      return { ...state, pausedHits: state.pausedHits.filter(h => h.id !== m.id) }
    case 'breakpoints-released': // device disconnected: the SDK auto-resumed its paused calls
      return { ...state, pausedHits: state.pausedHits.filter(h => h.deviceId !== m.deviceId) }
    case 'entries-cleared':
      return { ...state, http: [], socketEvents: [], socketConns: [] }
    case 'http-entries-cleared':
      return { ...state, http: [] }
    case 'socket-entries-cleared':
      return { ...state, socketEvents: [] }
    case 'device-deleted': {
      const { [m.deviceId]: _, ...mocksByDevice } = state.mocksByDevice
      const { [m.deviceId]: __, ...breakpointsByDevice } = state.breakpointsByDevice
      return {
        ...state,
        devices: state.devices.filter(d => d.deviceId !== m.deviceId),
        http: state.http.filter(r => r.deviceId !== m.deviceId),
        socketConns: state.socketConns.filter(c => c.deviceId !== m.deviceId),
        socketEvents: state.socketEvents.filter(e => e.deviceId !== m.deviceId),
        mocksByDevice,
        breakpointsByDevice,
        pausedHits: state.pausedHits.filter(h => h.deviceId !== m.deviceId),
      }
    }
    default:
      return state
  }
}

export function connectStream(dispatch: (a: Action) => void): () => void {
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ui`)
    ws.onopen = () => dispatch({ type: 'ws', connected: true })
    ws.onmessage = ev => dispatch({ type: 'server', msg: JSON.parse(ev.data) })
    ws.onclose = () => {
      dispatch({ type: 'ws', connected: false })
      if (!closed) timer = setTimeout(open, 2000)
    }
  }
  open()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    ws?.close()
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(await readResponseError(res))
  return await res.json() as T
}

async function readResponseError(res: Response): Promise<string> {
  const text = await res.text()
  return text ? `${res.status} ${text}` : `${res.status} ${res.statusText}`
}

export const api = {
  doctor: () => getJson<DoctorReport>('/api/doctor'),
  saveMocks: (deviceId: string, mocks: Mocks) =>
    fetch('/api/mocks', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, ...mocks }) }),
  pushEvent: (deviceId: string, connectionId: string | null, event: string, payload: string) =>
    fetch('/api/push-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, connectionId, event, payload }) }),
  armBreakpoints: (deviceId: string, rules: BreakpointRule[]) =>
    fetch('/api/breakpoints', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, rules }) }),
  resolveBreakpoint: (deviceId: string, id: string, action: 'resume' | 'abort', edits?: { status?: number; headers?: Record<string, string>; body?: string }) =>
    fetch('/api/breakpoints/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, id, action, ...edits }) }),
  clearEntries: () => fetch('/api/entries', { method: 'DELETE' }),
  clearHttpEntries: () => fetch('/api/entries/http', { method: 'DELETE' }),
  clearSocketEntries: () => fetch('/api/entries/socket', { method: 'DELETE' }),
  deleteOfflineDevices: () => fetch('/api/devices/offline', { method: 'DELETE' }),
  deleteDevice: (deviceId: string) => fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }),
}
