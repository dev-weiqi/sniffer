import { mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleTest } from './testHandlers.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

function fakeReq({ method = 'GET', headers = {}, body = '' }: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}) {
  const closeHandlers: Array<() => void> = []
  return {
    method,
    headers,
    closeHandlers,
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler)
      return this
    },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  } as unknown as IncomingMessage & { closeHandlers: Array<() => void> }
}

function fakeRes() {
  return {
    status: 0,
    headers: {} as Record<string, string | number>,
    ended: undefined as unknown,
    writes: [] as string[],
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      this.status = status
      this.headers = headers
    },
    write(chunk: string) {
      this.writes.push(chunk)
    },
    end(body?: unknown) {
      this.ended = body ?? ''
    },
  }
}

function bodyOf(res: ReturnType<typeof fakeRes>) {
  return JSON.parse(String(res.ended))
}

let req = fakeReq({ method: 'POST', headers: { 'x-test': '1' }, body: 'hello' })
let res = fakeRes()
await handleTest(req, res as unknown as ServerResponse, new URL('http://localhost/test/echo?x=1'), { now: () => 123 })
assertEqual(res.status, 200, 'echo status')
assertEqual(bodyOf(res).method, 'POST', 'echo method')
assertEqual(bodyOf(res).path, '/test/echo?x=1', 'echo path')
assertEqual(bodyOf(res).body, 'hello', 'echo body')
assertEqual(bodyOf(res).ts, 123, 'echo timestamp')

req = fakeReq()
res = fakeRes()
await handleTest(req, res as unknown as ServerResponse, new URL('http://localhost/test/echo'), { now: () => 124 })
assertEqual(bodyOf(res).body, null, 'empty echo body becomes null')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/users/42'))
assertEqual(bodyOf(res).id, 42, 'user id')
assertEqual(bodyOf(res).email, 'user42@example.com', 'user email')

let delayed = 0
res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/slow?ms=25'), {
  delay: async ms => { delayed = ms },
})
assertEqual(delayed, 25, 'slow custom delay')
assertEqual(bodyOf(res).slept, 25, 'slow response')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/slow'), {
  delay: async ms => { delayed = ms },
})
assertEqual(delayed, 1500, 'slow default delay')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/slow?ms=0'))
assertEqual(bodyOf(res).slept, 0, 'slow fallback delay response')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/error'))
assertEqual(res.status, 500, 'error status')
assertEqual(bodyOf(res).error, 'boom', 'error body')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/image'), {
  snifferIcon: '/icon.svg',
  readFileSync: file => Buffer.from(`<svg>${file}</svg>`),
})
assertEqual(res.headers['content-type'], 'image/svg+xml; charset=utf-8', 'icon content type')
assertEqual(res.headers['content-length'], String('<svg>/icon.svg</svg>').length, 'icon content length')
assert(String(res.ended).includes('/icon.svg'), 'icon body')

const iconDir = mkdtempSync(join(tmpdir(), 'sniffer-test-icon-'))
const iconPath = join(iconDir, 'icon.svg')
writeFileSync(iconPath, '<svg>sniffer</svg>')
res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/image'), {
  snifferIcon: iconPath,
})
assertEqual(res.headers['content-type'], 'image/svg+xml; charset=utf-8', 'default icon content type')
assertEqual(String(res.ended), '<svg>sniffer</svg>', 'default icon body')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/image'), {
  makePng: (w, h, r, g, b) => Buffer.from(`${w}:${h}:${r}:${g}:${b}`),
})
assertEqual(res.headers['content-type'], 'image/png', 'fallback image content type')
assertEqual(String(res.ended), '180:120:74:108:247', 'fallback image body')

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/image'))
assertEqual(res.headers['content-type'], 'image/png', 'default image content type')
assert(Buffer.isBuffer(res.ended), 'default image body')

const intervalCallbacks: Array<() => void> = []
const cleared: unknown[] = []
req = fakeReq()
res = fakeRes()
await handleTest(req, res as unknown as ServerResponse, new URL('http://localhost/test/sse'), {
  now: () => 456,
  setInterval: callback => { intervalCallbacks.push(callback); return 'timer-1' },
  clearInterval: timer => { cleared.push(timer) },
})
assertEqual(res.headers['content-type'], 'text/event-stream', 'SSE content type')
for (let i = 0; i < 5; i++) intervalCallbacks[0]()
assertEqual(res.writes.length, 5, 'SSE writes five events')
assert(res.writes[0].includes('"tick":1'), 'SSE first tick')
assertEqual(res.ended, '', 'SSE ends after fifth tick')
assertEqual(cleared[0], 'timer-1', 'SSE clears timer after fifth tick')
req.closeHandlers[0]()
assertEqual(cleared[1], 'timer-1', 'SSE close clears timer')

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const fallbackCallbacks: Array<() => void> = []
const fallbackCleared: unknown[] = []
globalThis.setInterval = ((callback: () => void) => {
  fallbackCallbacks.push(callback)
  return 'timer-2' as unknown as ReturnType<typeof globalThis.setInterval>
}) as typeof globalThis.setInterval
globalThis.clearInterval = ((timer: unknown) => {
  fallbackCleared.push(timer)
}) as typeof globalThis.clearInterval
try {
  req = fakeReq()
  res = fakeRes()
  await handleTest(req, res as unknown as ServerResponse, new URL('http://localhost/test/sse'), { now: () => 789 })
  for (let i = 0; i < 5; i++) fallbackCallbacks[0]()
  assertEqual(res.writes.length, 5, 'SSE default interval writes five events')
  assert(res.writes[0].includes('"ts":789'), 'SSE default interval timestamp')
  assertEqual(res.ended, '', 'SSE default interval ends after fifth tick')
  assertEqual(fallbackCleared[0], 'timer-2', 'SSE default clear after fifth tick')
  req.closeHandlers[0]()
  assertEqual(fallbackCleared[1], 'timer-2', 'SSE default close clears timer')
} finally {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
}

res = fakeRes()
await handleTest(fakeReq(), res as unknown as ServerResponse, new URL('http://localhost/test/missing'))
assertEqual(res.status, 404, 'missing test endpoint status')
assertEqual(bodyOf(res).error, 'not found', 'missing test endpoint body')

console.log('testHandlers.test: all assertions passed')
