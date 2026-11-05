const REDACTED = '‹redacted›'
const REDACT_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-access-token', 'api-key', 'x-csrf-token', 'x-xsrf-token',
  ...(process.env.SNIFFER_REDACT_HEADERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
])
const normKey = (k: string) => k.toLowerCase().replace(/[_-]/g, '')
const REDACT_BODY_FIELDS = new Set([
  'accesstoken', 'refreshtoken', 'idtoken', 'token', 'password', 'passwd', 'secret',
  'apikey', 'authorization', 'credential', 'credentials', 'sessiontoken', 'clientsecret', 'privatekey',
  ...(process.env.SNIFFER_REDACT_BODY_FIELDS ?? '').split(',').map(s => normKey(s.trim())).filter(Boolean),
])
const SECRET_VALUE = /eyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:Bearer|Basic)\s+[\w.~+/=-]+|-----BEGIN[\s\S]+?-----END[^-]*-----/g

/** Copy only: redaction must never change recorded traffic or persisted mock rules. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED
  if (Array.isArray(value)) return value.map(child => redact(child, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key,
      REDACT_BODY_FIELDS.has(normKey(key)) || REDACT_HEADERS.has(key.toLowerCase())
        ? REDACTED : redact(child, depth + 1),
    ]),
  )
  if (typeof value !== 'string') return value
  // JSON bodies and Socket.IO argument arrays are strings on the wire.
  if (/^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(redact(JSON.parse(value), depth + 1)) } catch { /* text below */ }
  }
  let text = value.replace(SECRET_VALUE, REDACTED)
  if (/^https?:\/\/|^wss?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      let changed = false
      if (url.username || url.password) { url.username = REDACTED; url.password = ''; changed = true }
      for (const key of [...url.searchParams.keys()]) {
        if (REDACT_BODY_FIELDS.has(normKey(key)) || REDACT_HEADERS.has(key.toLowerCase())) {
          url.searchParams.set(key, REDACTED)
          changed = true
        }
      }
      if (changed) text = url.toString()
    } catch { /* not a URL */ }
  }
  return text
}
