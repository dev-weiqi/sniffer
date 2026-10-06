export interface Entry {
  deviceId: string
  message: Record<string, unknown>
}

const DEFAULT_MAX_STORED_MESSAGES = 2000
const DEFAULT_CLEAR_SKEW_MS = 5000
const HTTP_ENTRY_TYPES = new Set(['http-request', 'http-response'])
const SOCKET_ENTRY_TYPES = new Set(['socket-event', 'socket-ack'])
const FIREBASE_ENTRY_TYPES = new Set(['firebase-event', 'firebase-analytics-event'])
type EntryKind = 'http' | 'socket' | 'firebase'

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
  const clearedAt = { http: 0, socket: 0, firebase: 0 }
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
      const marks = deviceWatermarks.get(deviceId) ?? { http: 0, socket: 0, firebase: 0 }
      for (const key of ['http', 'socket', 'firebase'] as const) {
        if (kind === 'all' || kind === key) marks[key] = ts
      }
      deviceWatermarks.set(deviceId, marks)
    }
  }

  return {
    pushEntry(deviceId: string, message: Record<string, unknown>) {
      const isFirebase = FIREBASE_ENTRY_TYPES.has(message.type as string)
      if (isFirebase && !validFirebaseEvent(message)) return false
      const ts = typeof message.timestamp === 'number' ? message.timestamp : Infinity
      const isHttp = HTTP_ENTRY_TYPES.has(message.type as string)
      if (message.type === 'http-request' && message.userId != null &&
        (typeof message.userId !== 'string' || message.userId.length > 1024)) return false
      const isSocket = SOCKET_ENTRY_TYPES.has(message.type as string)
      const marks = deviceWatermarks.get(deviceId)
      const watermark = marks
        ? (isHttp ? marks.http : isSocket ? marks.socket : isFirebase ? marks.firebase : 0)
        : (isHttp ? clearedAt.http : isSocket ? clearedAt.socket : isFirebase ? clearedAt.firebase : 0)
      // Acknowledge cleared or duplicate fatals too, so the SDK can retire its durable copy.
      if (isFirebase ? watermark > 0 && ts <= watermark : ts < watermark - clearSkewMs) return true
      if (isFirebase && entries.some(e => e.deviceId === deviceId &&
        e.message.type === message.type && e.message.id === message.id)) return true
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
      clearedAt.firebase = at
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
    clearFirebase() {
      clearEntriesByMessageType(FIREBASE_ENTRY_TYPES)
      clearedAt.firebase = now()
      markCleared('firebase')
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

/** Bound app-provided fields before they can enter the snapshot or React renderer. */
function validFirebaseEvent(m: Record<string, unknown>): boolean {
  const string = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (m.type === 'firebase-analytics-event') {
    try {
      return string(m.id, 128) && (m.id as string).length > 0 && string(m.name, 4096) &&
        typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > 0 &&
        string(m.userId ?? '', 1024) && object(m.params) && JSON.stringify(m.params).length <= 524288 &&
        (m.firebaseSdkCalled === undefined || typeof m.firebaseSdkCalled === 'boolean') &&
        (m.truncated === undefined || typeof m.truncated === 'boolean')
    } catch { return false }
  }
  return string(m.id, 128) && (m.id as string).length > 0 &&
    ['fatal', 'non-fatal', 'log'].includes(m.severity as string) &&
    typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > 0 &&
    string(m.message, 4096) && string(m.exception ?? '', 1024) &&
    string(m.stackTrace ?? '', 65536) && string(m.userId ?? '', 1024) && string(m.thread ?? '', 1024) &&
    (m.truncated === undefined || typeof m.truncated === 'boolean') &&
    (m.keys === undefined || (object(m.keys) && Object.keys(m.keys).length <= 64 &&
      Object.entries(m.keys).every(([key, value]) => string(key, 1024) && string(value, 1024)))) &&
    (m.logs === undefined || (Array.isArray(m.logs) && m.logs.length <= 64 && m.logs.every(log =>
      object(log) && string(log.message, 4096) && typeof log.timestamp === 'number' && Number.isFinite(log.timestamp))))
}
