// Decode raw Engine.IO / Socket.IO websocket text frames for display.
// ktor-ws captures the raw frame (e.g. `42/chat,["chat:new",{...}]`); this turns it
// into readable parts so the UI can show the event name + JSON instead of the raw string.
// The raw frame stays the source of truth — callers fall back to it when decode returns null.

// Engine.IO packet types (first char). Only `message` (4) carries a Socket.IO packet;
// the rest are transport/handshake control frames.
const ENGINE: Record<string, string> = {
  '0': 'open', '1': 'close', '2': 'ping', '3': 'pong',
  '4': 'message', '5': 'upgrade', '6': 'noop',
}
// Socket.IO packet types (char after Engine.IO `message`).
const SOCKET: Record<string, string> = {
  '0': 'CONNECT', '1': 'DISCONNECT', '2': 'EVENT', '3': 'ACK',
  '4': 'CONNECT_ERROR', '5': 'BINARY_EVENT', '6': 'BINARY_ACK',
}

export type EngineFrame = {
  engineLabel: string
  socketLabel?: string      // present only for Engine.IO `message` frames
  namespace?: string        // present only when a named namespace is in the frame ('/' is omitted on the wire)
  ackId?: string
  data?: string             // JSON tail, if any
  eventName?: string        // for EVENT / BINARY_EVENT: the first array element when it's a string
}

export function decodeEngineIoFrame(raw: string | null | undefined): EngineFrame | null {
  if (!raw) return null
  const engineType = raw[0]
  const engineLabel = ENGINE[engineType]
  if (!engineLabel) return null

  // Control/handshake frames (open/close/ping/pong/upgrade/noop) carry no Socket.IO packet.
  if (engineType !== '4') {
    const tail = raw.slice(1)
    return { engineLabel, data: tail || undefined }
  }

  let rest = raw.slice(1)
  const socketType = rest[0]
  const socketLabel = SOCKET[socketType]
  if (!socketLabel) return null
  rest = rest.slice(1)

  // BINARY_EVENT / BINARY_ACK carry a `<n>-` attachment count before the namespace.
  if (socketType === '5' || socketType === '6') {
    const dash = rest.indexOf('-')
    if (dash > 0 && /^\d+$/.test(rest.slice(0, dash))) rest = rest.slice(dash + 1)
  }

  // Optional namespace: starts with '/', ends at ','. JSON payloads start with '[' or '{',
  // so a leading '/' unambiguously marks a namespace.
  let namespace: string | undefined
  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',')
    if (comma === -1) { namespace = rest; rest = '' }
    else { namespace = rest.slice(0, comma); rest = rest.slice(comma + 1) }
  }

  // Optional ack id (digits) before the JSON payload.
  let ackId: string | undefined
  const ack = rest.match(/^\d+/)
  if (ack) { ackId = ack[0]; rest = rest.slice(ack[0].length) }

  const data = rest || undefined

  let eventName: string | undefined
  if ((socketType === '2' || socketType === '5') && data) {
    try {
      const arr = JSON.parse(data)
      if (Array.isArray(arr) && typeof arr[0] === 'string') eventName = arr[0]
    } catch { /* not parseable — leave eventName undefined */ }
  }

  return { engineLabel, socketLabel, namespace, ackId, data, eventName }
}

// One-line summary for the list, e.g. "EVENT /chat", "CONNECT /chat", "ping".
export function frameLabel(f: EngineFrame): string {
  const parts = [f.socketLabel ?? f.engineLabel]
  if (f.namespace) parts.push(f.namespace)
  if (f.ackId) parts.push(`ack ${f.ackId}`)
  return parts.join(' ')
}
