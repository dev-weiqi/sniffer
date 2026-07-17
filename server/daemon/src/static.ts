import { existsSync as defaultExistsSync } from 'node:fs'
import { readFile as defaultReadFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
}

export async function serveStatic(
  res: ServerResponse,
  pathname: string,
  deps: {
    uiDist: string
    existsSync?: (file: string) => boolean
    readFile?: (file: string) => Promise<Buffer | string>
  },
) {
  const existsSync = deps.existsSync ?? defaultExistsSync
  const readFile = deps.readFile ?? defaultReadFile
  const uiDist = normalize(deps.uiDist)
  if (!existsSync(uiDist)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Sniffer daemon is running, but the UI is not built yet: cd ui && npm install && npm run build')
    return
  }
  let file = normalize(join(uiDist, pathname === '/' ? 'index.html' : pathname))
  if (file !== uiDist && !file.startsWith(`${uiDist}${sep}`)) { res.writeHead(403); res.end(); return }
  if (!existsSync(file)) file = join(uiDist, 'index.html')
  const data = await readFile(file)
  const cacheControl = file.includes(`${sep}assets${sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': cacheControl,
  })
  res.end(data)
}
