import { readFileSync as defaultReadFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBody } from './http.js'
import { makePng as defaultMakePng } from './png.js'

export async function handleTest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: {
    snifferIcon?: string
    readFileSync?: (file: string) => Buffer
    makePng?: (w: number, h: number, r: number, g: number, b: number) => Buffer
    now?: () => number
    delay?: (ms: number) => Promise<void>
    setInterval?: (callback: () => void, ms: number) => unknown
    clearInterval?: (timer: unknown) => void
  } = {},
) {
  const now = deps.now ?? Date.now
  if (url.pathname === '/test/echo') {
    const body = await readBody(req)
    return json(res, 200, {
      method: req.method, path: url.pathname + url.search,
      headers: req.headers, body: body || null, ts: now(),
    })
  }
  const userMatch = url.pathname.match(/^\/test\/users\/(\w+)$/)
  if (userMatch) {
    return json(res, 200, {
      id: Number(userMatch[1]), name: `User ${userMatch[1]}`,
      email: `user${userMatch[1]}@example.com`, tags: ['alpha', 'beta'],
    })
  }
  if (url.pathname === '/test/slow') {
    const ms = Number(url.searchParams.get('ms') ?? 1500)
    await (deps.delay ?? (delayMs => new Promise<void>(r => setTimeout(r, delayMs))))(ms)
    return json(res, 200, { slept: ms })
  }
  if (url.pathname === '/test/error') return json(res, 500, { error: 'boom' })
  if (url.pathname === '/test/image') {
    if (deps.snifferIcon) {
      const icon = (deps.readFileSync ?? defaultReadFileSync)(deps.snifferIcon)
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'content-length': icon.length,
      })
      res.end(icon)
      return
    }
    const png = (deps.makePng ?? defaultMakePng)(180, 120, 74, 108, 247)
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
    res.end(png)
    return
  }
  if (url.pathname === '/test/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let n = 0
    const clearInterval = deps.clearInterval ?? ((timer: unknown) => globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>))
    const timer = (deps.setInterval ?? globalThis.setInterval)(() => {
      res.write(`data: {"tick":${++n},"ts":${now()}}\n\n`)
      if (n >= 5) { clearInterval(timer); res.end() }
    }, 400)
    req.on('close', () => clearInterval(timer))
    return
  }
  json(res, 404, { error: 'not found' })
}
