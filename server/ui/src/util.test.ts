import {
  copyText,
  fmtDuration,
  fmtSize,
  fmtTime,
  newRuleId,
  prettyJson,
  statusClass,
  toCurl,
  urlParts,
} from './util.js'
import type { HttpRow } from './state.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

const ts = Date.UTC(2026, 0, 2, 3, 4, 5, 6)
const d = new Date(ts)
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
assertEqual(fmtTime(ts), `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`, 'fmtTime')

assertEqual(fmtSize(undefined), '', 'fmtSize undefined')
assertEqual(fmtSize(512), '512 B', 'fmtSize bytes')
assertEqual(fmtSize(2048), '2.0 kB', 'fmtSize kilobytes')
assertEqual(fmtSize(2 * 1024 * 1024), '2.0 MB', 'fmtSize megabytes')

assertEqual(fmtDuration(undefined), '', 'fmtDuration undefined')
assertEqual(fmtDuration(9999), '9999 ms', 'fmtDuration milliseconds')
assertEqual(fmtDuration(10000), '10.0 s', 'fmtDuration seconds')

const parsed = urlParts('https://example.com:9443/users?id=1&name=weiqi')
assertEqual(parsed.domain, 'example.com:9443', 'urlParts domain')
assertEqual(parsed.path, '/users', 'urlParts path')
assertEqual(parsed.query.length, 2, 'urlParts query')
assertEqual(urlParts('not a url').path, 'not a url', 'urlParts invalid fallback')

assertEqual(prettyJson(null), '', 'prettyJson null')
assertEqual(prettyJson(undefined), '', 'prettyJson undefined')
assertEqual(prettyJson('{"a":1}'), '{\n  "a": 1\n}', 'prettyJson valid')
assertEqual(prettyJson('{'), '{', 'prettyJson invalid fallback')

assertEqual(statusClass(200), 'st-ok', 'statusClass 2xx')
assertEqual(statusClass(301), 'st-info', 'statusClass 3xx')
assertEqual(statusClass(404), 'st-warn', 'statusClass 4xx')
assertEqual(statusClass(500), 'st-err', 'statusClass 5xx')
assertEqual(statusClass(0), 'st-err', 'statusClass network error')
assertEqual(statusClass(undefined), 'st-pending', 'statusClass pending')
assertEqual(statusClass(200, 'boom'), 'st-err', 'statusClass explicit error')

const row: HttpRow = {
  id: 'r1',
  deviceId: 'd1',
  ts,
  method: 'POST',
  url: "https://example.com/users?name=o'clock",
  library: 'okhttp',
  reqHeaders: {
    'content-type': 'application/json',
    "x-o'clock": "it's ok",
  },
  reqBody: '{"name":"o\'clock"}',
  reqSize: 18,
}
const curl = toCurl(row)
assert(curl.startsWith("curl -X POST 'https://example.com/users?name=o'\\''clock'"), 'toCurl escapes URL quotes')
assert(curl.includes("  -H 'x-o'\\''clock: it'\\''s ok'"), 'toCurl escapes header quotes')
assert(curl.includes("  --data-raw '{\"name\":\"o'\\''clock\"}'"), 'toCurl escapes body quotes')

const originalRandom = Math.random
Math.random = () => 0.123456
assertEqual(newRuleId(), (0.123456).toString(36).slice(2, 10), 'newRuleId uses random suffix')
Math.random = originalRandom

const originalNavigator = globalThis.navigator
const originalDocument = globalThis.document
let clipboardText = ''
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: (text: string) => { clipboardText = text; return Promise.resolve() } } },
  configurable: true,
})
copyText('from clipboard')
assertEqual(clipboardText, 'from clipboard', 'copyText uses clipboard API')

let selected = false
let removed = false
let appendedValue = ''
let execCommand = ''
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
  configurable: true,
})
Object.defineProperty(globalThis, 'document', {
  value: {
    createElement: () => ({
      value: '',
      select: () => { selected = true },
      remove: () => { removed = true },
    }),
    body: {
      appendChild: (ta: { value: string }) => { appendedValue = ta.value },
    },
    execCommand: (command: string) => { execCommand = command; return true },
  },
  configurable: true,
})
copyText('from fallback')
await Promise.resolve()
assertEqual(appendedValue, 'from fallback', 'copyText fallback appends textarea')
assertEqual(selected, true, 'copyText fallback selects textarea')
assertEqual(execCommand, 'copy', 'copyText fallback calls execCommand')
assertEqual(removed, true, 'copyText fallback removes textarea')

if (originalNavigator) {
  Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true })
} else {
  delete (globalThis as { navigator?: Navigator }).navigator
}
if (originalDocument) {
  Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true })
} else {
  delete (globalThis as { document?: Document }).document
}

console.log('util.test: all assertions passed')
