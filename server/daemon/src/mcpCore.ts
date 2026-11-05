import { randomUUID } from 'node:crypto'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

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

const text = { type: 'string' } as const
const identifier = { type: 'string', minLength: 1 } as const
const nullableText = { type: ['string', 'null'] } as const
const stringMap = { type: 'object', additionalProperties: text }
const commonFields = {
  enabled: { type: 'boolean' }, name: text, starred: { type: 'boolean' },
  delayMs: { type: 'integer', minimum: 0 },
}
const httpFields = {
  method: nullableText, urlPattern: identifier, status: { type: 'integer', minimum: 100, maximum: 599 },
  headers: stringMap, body: text, delayOnly: { type: 'boolean' },
  queryParams: { ...stringMap, propertyNames: { pattern: '\\S' } }, bodyMatch: nullableText,
}
const socketFields = {
  transport: { type: 'string', enum: ['socketio', 'ktor-ws'] }, event: identifier,
  ackPayload: text, pushEvent: nullableText, pushPayload: text, payloadMatch: nullableText,
}
const breakpointRule = {
  type: 'object', additionalProperties: false,
  properties: { id: identifier, enabled: { type: 'boolean' }, method: nullableText, urlPattern: identifier,
    phase: { type: 'string', enum: ['response'] } },
  required: ['id', 'urlPattern'],
}

const definitions: Tool[] = [
  {
    name: 'get_state',
    description: 'Daemon devices, mock rules, armed breakpoints and paused responses. Known secrets are masked.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_traffic',
    description: 'Read HTTP, Socket and Firebase Analytics entries. HTTP method/status/URL filters correlate request and response. Results are masked; limit counts messages, not flows.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      deviceId: identifier, type: { type: 'string', enum: ['http', 'socket', 'firebase'] },
      method: text, status: { type: 'integer', minimum: 0, maximum: 599 },
      urlContains: text, bodyContains: text, userId: text, event: text, connectionId: identifier,
      limit: { type: 'integer', minimum: 1 },
    } },
  },
  {
    name: 'get_entry', description: 'Read all messages for a captured ID, including response/ack and image metadata. Supply deviceId if the ID exists on multiple devices.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { deviceId: identifier, id: identifier }, required: ['id'] },
  },
  {
    name: 'create_mock', description: 'Create an HTTP mock (default) or socket mock. New rules take priority within their device/shared group. starred shares with the same app. Conditions require SDK support.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      deviceId: identifier, type: { type: 'string', enum: ['http', 'socket'] },
      ...commonFields, ...httpFields, ...socketFields,
    }, allOf: [{ if: { properties: { type: { const: 'socket' } }, required: ['type'] },
      then: { required: ['event'] }, else: { required: ['urlPattern'] } }] },
  },
  {
    name: 'update_mock', description: 'Patch an HTTP or socket mock by ID, retaining unspecified fields. Null clears method/bodyMatch/payloadMatch/pushEvent. Shared rules affect the same app on other devices.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      deviceId: identifier, id: identifier, ...commonFields, ...httpFields, ...socketFields,
    }, required: ['id'] },
  },
  {
    name: 'delete_mock', description: 'Delete a mock by ID. Deleting a starred rule removes it for every device of that app.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { deviceId: identifier, id: identifier }, required: ['id'] },
  },
  {
    name: 'push_event', description: 'Inject a server-to-client socket event. Socket.IO payload is a JSON argument array; Ktor WS payload is raw text. Omit connectionId to broadcast within the device.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      deviceId: identifier, event: identifier, payload: text, connectionId: nullableText,
    }, required: ['event', 'payload'] },
  },
  {
    name: 'clear_traffic', description: 'Clear traffic across ALL devices. Omit type for all kinds. Clearing HTTP/all also resumes paused responses unchanged.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', enum: ['http', 'socket', 'firebase'] } } },
  },
  {
    name: 'set_breakpoints', description: 'Replace all response breakpoints for one device; rules: [] disarms all. Does not pause SSE streams or mocked responses. Use get_state to inspect paused hits.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { deviceId: identifier, rules: { type: 'array', items: breakpointRule } }, required: ['rules'] },
  },
  {
    name: 'resolve_breakpoint', description: 'Resume or abort a paused response from get_state. Resume may override status, headers and body before returning to the app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      deviceId: identifier, id: identifier, action: { type: 'string', enum: ['resume', 'abort'] },
      status: httpFields.status, headers: stringMap, body: text,
    }, required: ['id', 'action'] },
  },
]

export const TOOLS: Tool[] = definitions.map(tool => ({ ...tool, annotations: {
  readOnlyHint: ['get_state', 'list_traffic', 'get_entry'].includes(tool.name),
  destructiveHint: !['get_state', 'list_traffic', 'get_entry'].includes(tool.name),
} }))

const validator = new AjvJsonSchemaValidator()
const validators = new Map(TOOLS.map(tool => [tool.name,
  validator.getValidator<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
]))

function validateConditions(args: Record<string, unknown>) {
  for (const field of ['bodyMatch', 'payloadMatch']) {
    const value = args[field]
    if (value == null || (typeof value === 'string' && !value.trim())) continue
    let parsed: unknown
    try { parsed = JSON.parse(String(value)) } catch { throw new Error(`${field} must contain a JSON object`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field} must contain a JSON object`)
  }
}

function validateMockFields(args: Record<string, unknown>, socket: boolean) {
  for (const key of Object.keys(socket ? httpFields : socketFields)) {
    if (key in args) throw new Error(`${key} is not a ${socket ? 'socket' : 'HTTP'} mock field`)
  }
  validateConditions(args)
}

async function defaultDaemon(base: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(base + path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`daemon ${init?.method ?? 'GET'} ${path} -> HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

export function createMcpRuntime(options: McpRuntimeOptions = {}) {
  const port = options.port ?? Number(process.env.SNIFFER_PORT ?? process.env.PORT ?? 9091)
  const host = options.host ?? process.env.SNIFFER_HOST ?? '127.0.0.1'
  const base = options.base ?? `http://${host}:${port}`
  const appId = options.appId !== undefined ? options.appId : process.env.SNIFFER_APP_ID || null
  const daemon = options.daemon ?? ((path: string, init?: RequestInit) => defaultDaemon(base, path, init))
  const randomId = options.randomId ?? randomUUID
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
    return { http: (mocks.http ?? []).map(rule => ({ ...rule })), socket: (mocks.socket ?? []).map(rule => ({ ...rule })) }
  }

  async function call(name: string, rawArgs: unknown): Promise<unknown> {
    const validate = validators.get(name)
    if (!validate) throw new Error(`unknown tool: ${name}`)
    const checked = validate(rawArgs)
    if (!checked.valid) throw new Error(`Invalid ${name} arguments: ${checked.errorMessage}`)
    const args = checked.data
    if (name === 'get_state') return daemon('/api/state?redact=1')

    if (name === 'list_traffic') {
      const query = new URLSearchParams()
      const deviceId = await resolveDevice(args.deviceId, false)
      if (deviceId) query.set('deviceId', deviceId)
      else if (appId) query.set('appId', appId)
      for (const key of ['type', 'method', 'urlContains', 'bodyContains', 'userId', 'event', 'connectionId'] as const) {
        if (typeof args[key] === 'string') query.set(key, args[key])
      }
      for (const key of ['status', 'limit'] as const) {
        if (typeof args[key] === 'number') query.set(key, String(args[key]))
      }
      const text = query.toString()
      return daemon('/api/entries' + (text ? `?${text}` : ''))
    }

    if (name === 'get_entry') {
      const query = new URLSearchParams({ id: String(args.id) })
      const deviceId = await resolveDevice(args.deviceId, false)
      if (deviceId) query.set('deviceId', deviceId)
      else if (appId) query.set('appId', appId)
      const result = await daemon(`/api/entries?${query}`) as { entries?: Array<{ deviceId: string; message?: { id?: unknown } }> }
      const entries = result.entries ?? []
      if (new Set(entries.map(entry => entry.deviceId)).size > 1) throw new Error('multiple devices have this id; pass deviceId')
      if (!entries.length) throw new Error(`no entry with id '${String(args.id)}'`)
      return { entries }
    }

    if (name === 'create_mock') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const mocks = await mocksFor(deviceId)
      const socket = args.type === 'socket'
      validateMockFields(args, socket)
      if (socket ? !args.event : !args.urlPattern) throw new Error(socket ? 'event required' : 'urlPattern required')
      const { deviceId: _, type: __, ...fields } = args
      const rule = socket ? {
        id: randomId(), enabled: true, createdAt: Date.now(), transport: 'socketio',
        ackPayload: '[]', pushPayload: '[]', delayMs: 0, ...fields,
      } : {
        id: randomId(), enabled: true, createdAt: Date.now(), method: null,
        status: 200, headers: {}, body: '', delayMs: 0, delayOnly: false, ...fields,
      }
      mocks[socket ? 'socket' : 'http'].unshift(rule)
      await put('/api/mocks', { deviceId, http: mocks.http, socket: mocks.socket })
      return { deviceId, created: { id: rule.id } }
    }

    if (name === 'update_mock') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const mocks = await mocksFor(deviceId)
      const target = [...mocks.http, ...mocks.socket].find(rule => rule.id === args.id)
      if (!target) throw new Error(`no mock rule with id '${String(args.id)}' on device '${deviceId}'`)
      validateMockFields(args, mocks.socket.includes(target))
      for (const [key, value] of Object.entries(args)) {
        if (key !== 'deviceId' && key !== 'id' && value !== undefined) target[key] = value
      }
      await put('/api/mocks', { deviceId, http: mocks.http, socket: mocks.socket })
      return { deviceId, updated: { id: target.id } }
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

    if (name === 'set_breakpoints') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const rules = args.rules as Array<{ id: string }>
      if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('Duplicate breakpoint rule IDs')
      return put('/api/breakpoints', { deviceId, rules })
    }

    if (name === 'resolve_breakpoint') {
      const deviceId = (await resolveDevice(args.deviceId, true))!
      const state = await daemon('/api/state?redact=1') as { pausedHits?: Array<{ deviceId: string; hit: { id?: string } }> }
      if (!state.pausedHits?.some(p => p.deviceId === deviceId && p.hit.id === args.id)) throw new Error('No matching paused response on this device')
      return post('/api/breakpoints/resolve', { ...args, deviceId })
    }

    if (name === 'clear_traffic') {
      const path = args.type === 'http' ? '/api/entries/http'
        : args.type === 'socket' ? '/api/entries/socket'
          : args.type === 'firebase' ? '/api/entries/firebase'
          : '/api/entries'
      return daemon(path, { method: 'DELETE' })
    }

    throw new Error(`unknown tool: ${name}`)
  }

  let pendingMutation: Promise<unknown> = Promise.resolve()
  return { base, tools: TOOLS, call: (name: string, args: unknown) => {
    if (!['create_mock', 'update_mock', 'delete_mock'].includes(name)) return call(name, args)
    // shortcut: serializes this MCP session only; avoid concurrent UI/other-session mock edits.
    const result = pendingMutation.then(() => call(name, args))
    pendingMutation = result.catch(() => {})
    return result
  } }

}
