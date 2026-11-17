export interface Entry {
  deviceId: string
  message: Record<string, unknown>
}

const DEFAULT_MAX_STORED_MESSAGES = 2000
const DEFAULT_CLEAR_SKEW_MS = 5000
const HTTP_ENTRY_TYPES = new Set(['http-request', 'http-response'])
const SOCKET_ENTRY_TYPES = new Set(['socket-event', 'socket-ack'])
type EntryKind = 'http' | 'socket'

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
  // Fallback watermark on our own clock, used only for devices we have never seen a timestamp from.
  const clearedAt = { http: 0, socket: 0 }
  // A device clock is not ours — an emulator can run minutes behind — so a clear watermark taken
  // from our clock silently drops that device's live traffic. Compare inside the device's own
  // timeline instead: remember the newest timestamp seen per device and, on clear, freeze it as
  // that device's watermark. Replayed buffered messages are older than it and still get dropped.
  const lastSeen = new Map<string, number>()
  const deviceWatermarks = new Map<string, Record<EntryKind, number>>()

  function clearEntriesByMessageType(types: Set<unknown>) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (types.has(entries[i].message.type)) entries.splice(i, 1)
    }
  }

  /** freeze each device's newest timestamp as its watermark for [kind] */
  function markCleared(kind: EntryKind | 'all') {
    for (const [deviceId, ts] of lastSeen) {
      const marks = deviceWatermarks.get(deviceId) ?? { http: 0, socket: 0 }
      for (const key of ['http', 'socket'] as const) {
        if (kind === 'all' || kind === key) marks[key] = ts
      }
      deviceWatermarks.set(deviceId, marks)
    }
  }

  return {
    pushEntry(deviceId: string, message: Record<string, unknown>) {
      if (message.type === 'firebase-event' || message.type === 'firebase-analytics-event') return false
      const ts = typeof message.timestamp === 'number' ? message.timestamp : Infinity
      const isHttp = HTTP_ENTRY_TYPES.has(message.type as string)
      if (message.type === 'http-request' && message.userId != null &&
        (typeof message.userId !== 'string' || message.userId.length > 1024)) return false
      const isSocket = SOCKET_ENTRY_TYPES.has(message.type as string)
      const marks = deviceWatermarks.get(deviceId)
      const watermark = marks
        ? (isHttp ? marks.http : isSocket ? marks.socket : 0)
        : (isHttp ? clearedAt.http : isSocket ? clearedAt.socket : 0)
      if (ts < watermark - clearSkewMs) return true
      if (Number.isFinite(ts) && ts > (lastSeen.get(deviceId) ?? 0)) lastSeen.set(deviceId, ts)
      entries.push({ deviceId, message })
      if (entries.length > maxStoredMessages) entries.splice(0, entries.length - maxStoredMessages)
      broadcast({ type: 'event', deviceId, message })
      return true
    },
    clearAll() {
      entries.length = 0
      const at = now()
      clearedAt.http = at
      clearedAt.socket = at
      markCleared('all')
    },
    clearHttp() {
      clearEntriesByMessageType(HTTP_ENTRY_TYPES)
      clearedAt.http = now()
      markCleared('http')
    },
    clearSocket() {
      clearEntriesByMessageType(SOCKET_ENTRY_TYPES)
      clearedAt.socket = now()
      markCleared('socket')
    },
    removeDeviceEntries(deviceId: string): boolean {
      lastSeen.delete(deviceId)
      deviceWatermarks.delete(deviceId)
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
