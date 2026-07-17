import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { serveStatic } from './static.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)} but got ${String(actual)}`)
}

function fakeRes() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    ended: undefined as unknown,
    writeHead(status: number, headers: Record<string, string> = {}) {
      this.status = status
      this.headers = headers
    },
    end(body?: unknown) {
      this.ended = body
    },
  }
}

const uiDist = '/tmp/sniffer-ui'
let existing = new Set<string>()
let readFilePath = ''
const existsSync = (file: string) => existing.has(file)
const readFile = async (file: string) => {
  readFilePath = file
  return Buffer.from(`file:${file}`)
}

let res = fakeRes()
await serveStatic(res as unknown as ServerResponse, '/', { uiDist, existsSync, readFile })
assertEqual(res.status, 200, 'missing UI status')
assertEqual(res.headers['content-type'], 'text/plain; charset=utf-8', 'missing UI content type')
assert(String(res.ended).includes('UI is not built yet'), 'missing UI body')

existing = new Set([uiDist, join(uiDist, 'index.html'), join(uiDist, 'assets', 'app.js'), join(uiDist, 'asset.bin')])
res = fakeRes()
await serveStatic(res as unknown as ServerResponse, '/', { uiDist, existsSync, readFile })
assertEqual(readFilePath, join(uiDist, 'index.html'), 'root serves index')
assertEqual(res.headers['content-type'], 'text/html', 'index MIME')
assertEqual(res.headers['cache-control'], 'no-cache', 'index cache')

res = fakeRes()
await serveStatic(res as unknown as ServerResponse, '/assets/app.js', { uiDist, existsSync, readFile })
assertEqual(readFilePath, join(uiDist, 'assets', 'app.js'), 'asset path')
assertEqual(res.headers['content-type'], 'text/javascript', 'JS MIME')
assertEqual(res.headers['cache-control'], 'public, max-age=31536000, immutable', 'asset cache')

res = fakeRes()
await serveStatic(res as unknown as ServerResponse, '/missing/path', { uiDist, existsSync, readFile })
assertEqual(readFilePath, join(uiDist, 'index.html'), 'missing path falls back to index')

res = fakeRes()
await serveStatic(res as unknown as ServerResponse, '/../secret.txt', { uiDist, existsSync, readFile })
assertEqual(res.status, 403, 'path traversal forbidden')

res = fakeRes()
await serveStatic(res as unknown as ServerResponse, '/asset.bin', { uiDist, existsSync, readFile })
assertEqual(res.headers['content-type'], 'application/octet-stream', 'unknown MIME fallback')

console.log('static.test: all assertions passed')
