export interface Entry {
  deviceId: string
  message: Record<string, unknown>
}

const DEFAULT_MAX_STORED_MESSAGES = 2000
const DEFAULT_CLEAR_SKEW_MS = 5000
const HTTP_ENTRY_TYPES = new Set(['http-request', 'http-response'])
const SOCKET_ENTRY_TYPES = new Set(['socket-event', 'socket-ack'])

export function createEntryStore(
  broadcast: (msg: unknown) => void,
  options: {
    maxStoredMessages?: number
    clearSkewMs?: number
    now?: () => number
  } = {},
) {
  const maxStoredMessages = options.maxStoredMessages ?? DEFAULT_MAX_STORED_MESSAGES
  const clearSkewMs = options.clearSkewMs ?? DEFAULT_CLEAR_SKEW_MS
  const now = options.now ?? Date.now
  const entries: Entry[] = []
  const clearedAt = { http: 0, socket: 0 }

  function clearEntriesByMessageType(types: Set<unknown>) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (types.has(entries[i].message.type)) entries.splice(i, 1)
    }
  }

  return {
    pushEntry(deviceId: string, message: Record<string, unknown>) {
      const ts = typeof message.timestamp === 'number' ? message.timestamp : Infinity
      const watermark = HTTP_ENTRY_TYPES.has(message.type as string) ? clearedAt.http
        : SOCKET_ENTRY_TYPES.has(message.type as string) ? clearedAt.socket : 0
      if (ts < watermark - clearSkewMs) return
      entries.push({ deviceId, message })
      if (entries.length > maxStoredMessages) entries.splice(0, entries.length - maxStoredMessages)
      broadcast({ type: 'event', deviceId, message })
    },
    clearAll() {
      entries.length = 0
      const at = now()
      clearedAt.http = at
      clearedAt.socket = at
    },
    clearHttp() {
      clearEntriesByMessageType(HTTP_ENTRY_TYPES)
      clearedAt.http = now()
    },
    clearSocket() {
      clearEntriesByMessageType(SOCKET_ENTRY_TYPES)
      clearedAt.socket = now()
    },
    removeDeviceEntries(deviceId: string): boolean {
      let removed = false
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].deviceId === deviceId) {
          entries.splice(i, 1)
          removed = true
        }
      }
      return removed
    },
    snapshot(): Entry[] {
      return entries
    },
  }
}
