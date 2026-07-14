export type DaemonRequest = (path: string, init?: RequestInit) => Promise<unknown>

export interface McpRuntimeOptions {
  base?: string
  port?: number
  host?: string
  appId?: string | null
  daemon?: DaemonRequest
  randomId?: () => string
}

interface DeviceState {
  deviceId: string
  appId: string
  connected: boolean
}

interface MockRule {
  id: string
  [key: string]: unknown
}

interface Mocks {
  http: MockRule[]
  socket: MockRule[]
}

export const TOOLS = [
  {
    name: 'get_state',
    description: 'Snapshot of the Sniffer daemon: connected devices, recorded entry count, and mock rules per device.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_traffic',
    description: 'List recorded HTTP/Socket traffic. Omit deviceId to default to one connected device; ambiguous reads list all devices.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        type: { type: 'string', enum: ['http', 'socket'] },
        method: { type: 'string' },
        status: { type: 'number' },
        urlContains: { type: 'string' },
        bodyContains: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_entry',
    description: 'Full data for one flow by id: all entries sharing that id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_mock',
    description: 'Add an HTTP mock rule for a device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        urlPattern: { type: 'string' },
        status: { type: 'number' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
        delayMs: { type: 'number' },
      },
      required: ['urlPattern', 'status'],
    },
  },
  {
    name: 'update_mock',
    description: 'Patch an existing mock rule by id.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        id: { type: 'string' },
        enabled: { type: 'boolean' },
        method: { type: 'string' },
        urlPattern: { type: 'string' },
        status: { type: 'number' },
        headers: { type: 'object' },
        body: { type: 'string' },
        delayMs: { type: 'number' },
        event: { type: 'string' },
        ackPayload: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_mock',
    description: 'Remove a mock rule by id.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'push_event',
    description: 'Inject a server-to-client socket event into a connected device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        event: { type: 'string' },
        payload: { type: 'string' },
        connectionId: { type: 'string' },
      },
      required: ['event', 'payload'],
    },
  },
  {
    name: 'clear_traffic',
    description: 'Clear recorded traffic. type omitted clears all; http or socket clears one kind.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['http', 'socket'] } } },
  },
]

async function defaultDaemon(base: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(base + path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`daemon ${init?.method ?? 'GET'} ${path} -> HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

function asArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? args as Record<string, unknown> : {}
}

export function createMcpRuntime(options: McpRuntimeOptions = {}) {
  const port = options.port ?? Number(process.env.SNIFFER_PORT ?? process.env.PORT ?? 9091)
  const host = options.host ?? process.env.SNIFFER_HOST ?? '127.0.0.1'
  const base = options.base ?? `http://${host}:${port}`
  const appId = options.appId !== undefined ? options.appId : process.env.SNIFFER_APP_ID || null
  const daemon = options.daemon ?? ((path: string, init?: RequestInit) => defaultDaemon(base, path, init))
  const randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10))
  const put = (path: string, body: unknown) =>
    daemon(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const post = (path: string, body: unknown) =>
    daemon(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  async function resolveDevice(explicit: unknown, strict: boolean): Promise<string | null> {
    if (typeof explicit === 'string' && explicit) return explicit
    const state = await daemon('/api/state') as { devices?: DeviceState[] }
    const devices = state.devices ?? []
    let pool = devices.filter(device => device.connected)
    if (appId) pool = pool.filter(device => device.appId === appId)
    if (pool.length === 1) return pool[0].deviceId
    if (!strict) return null
    const scope = appId ? ` for appId '${appId}'` : ''
    const known = devices.map(device => `${device.deviceId} (${device.appId}${device.connected ? '' : ', offline'})`).join('; ') || 'none'
    throw new Error(pool.length === 0
      ? `no connected device${scope} to default to — pass deviceId. Known: ${known}`
      : `multiple devices${scope} — pass deviceId. Connected: ${pool.map(device => device.deviceId).join(', ')}`)
  }

  async function mocksFor(deviceId: string): Promise<Mocks> {
    const state = await daemon('/api/state') as { mocksByDevice?: Record<string, Mocks> }
    const mocks = state.mocksByDevice?.[deviceId]
    if (!mocks) throw new Error(`unknown deviceId '${deviceId}'. Call get_state for the current device list.`)
    return { http: [...(mocks.http ?? [])], socket: [...(mocks.socket ?? [])] }
  }

  async function call(name: string, rawArgs: unknown): Promise<unknown> {
    const args = asArgs(rawArgs)
    if (name === 'get_state') return daemon('/api/state')

    if (name === 'list_traffic') {
      const query = new URLSearchParams()
      const deviceId = await resolveDevice(args.deviceId, false)
      if (deviceId) query.set('deviceId', deviceId)
      for (const key of ['type', 'method', 'urlContains', 'bodyContains'] as const) {
        if (typeof args[key] === 'string') query.set(key, args[key])
      }
      for (const key of ['status', 'limit'] as const) {
        if (typeof args[key] === 'number') query.set(key, String(args[key]))
      }
      const text = query.toString()
      return daemon('/api/entries' + (text ? `?${text}` : ''))
    }

    if (name === 'get_entry') {
      const result = await daemon('/api/entries') as { entries?: Array<{ message?: { id?: unknown } }> }
      const entries = (result.entries ?? []).filter(entry => entry.message?.id === args.id)
      if (!entries.length) throw new Error(`no entry with id '${String(args.id)}'`)
      return { entries }
    }

    if (name === 'create_mock') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const mocks = await mocksFor(deviceId)
      const rule = {
        id: randomId(),
        enabled: true,
        method: typeof args.method === 'string' ? args.method : null,
        urlPattern: args.urlPattern,
        status: args.status,
        headers: args.headers ?? {},
        body: typeof args.body === 'string' ? args.body : '',
        delayMs: typeof args.delayMs === 'number' ? args.delayMs : 0,
        delayOnly: false,
      }
      mocks.http.push(rule)
      await put('/api/mocks', { deviceId, http: mocks.http, socket: mocks.socket })
      return { deviceId, created: rule }
    }

    if (name === 'update_mock') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const mocks = await mocksFor(deviceId)
      const target = [...mocks.http, ...mocks.socket].find(rule => rule.id === args.id)
      if (!target) throw new Error(`no mock rule with id '${String(args.id)}' on device '${deviceId}'`)
      for (const [key, value] of Object.entries(args)) {
        if (key !== 'deviceId' && key !== 'id' && value !== undefined) target[key] = value
      }
      await put('/api/mocks', { deviceId, http: mocks.http, socket: mocks.socket })
      return { deviceId, updated: target }
    }

    if (name === 'delete_mock') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const mocks = await mocksFor(deviceId)
      const before = mocks.http.length + mocks.socket.length
      mocks.http = mocks.http.filter(rule => rule.id !== args.id)
      mocks.socket = mocks.socket.filter(rule => rule.id !== args.id)
      if (mocks.http.length + mocks.socket.length === before) {
        throw new Error(`no mock rule with id '${String(args.id)}' on device '${deviceId}'`)
      }
      await put('/api/mocks', { deviceId, http: mocks.http, socket: mocks.socket })
      return { deviceId, deleted: args.id }
    }

    if (name === 'push_event') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      return post('/api/push-event', {
        deviceId,
        connectionId: args.connectionId ?? null,
        event: args.event,
        payload: args.payload,
      })
    }

    if (name === 'clear_traffic') {
      const path = args.type === 'http' ? '/api/entries/http'
        : args.type === 'socket' ? '/api/entries/socket'
          : '/api/entries'
      return daemon(path, { method: 'DELETE' })
    }

    throw new Error(`unknown tool: ${name}`)
  }

  return { base, tools: TOOLS, call }
}
