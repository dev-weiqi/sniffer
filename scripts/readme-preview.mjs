// Regenerates docs/assets/sniffer-api-preview.png against the current UI.
//
//   npm --prefix server/ui run build      # the daemon serves ../ui/dist
//   node scripts/readme-preview.mjs
//
// Self-contained: starts its own daemon on a spare port with an isolated HOME (your real
// ~/.sniffer is never touched), stages a fake device with the traffic shown in the README,
// screenshots the real UI, wraps it in the hero + mac window chrome, and cleans up after
// itself. Uses playwright-core from server/daemon's devDependencies and whichever Chromium
// the Playwright cache has (falling back to installed Chrome).

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(new URL('../server/daemon/package.json', import.meta.url))
const { chromium } = require('playwright-core')
const WebSocket = require('ws')

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 9094
const BASE = `http://localhost:${PORT}`
const OUT = join(ROOT, 'docs/assets/sniffer-api-preview.png')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function chromiumExecutable() {
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright')
  try {
    const dirs = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort()
    for (const dir of dirs.reverse()) {
      for (const mac of readdirSync(join(cache, dir)).filter(d => d.startsWith('chrome-mac'))) {
        const exe = join(cache, dir, mac, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
        try { readFileSync(exe).length; return exe } catch { /* try the next one */ }
      }
    }
  } catch { /* no cache — fall back to installed Chrome */ }
  return undefined
}

// ---- daemon on a spare port, isolated HOME ----
const fakeHome = mkdtempSync(join(tmpdir(), 'sniffer-preview-'))
const daemon = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: join(ROOT, 'server/daemon'),
  env: {
    ...process.env,
    HOME: fakeHome,
    PORT: String(PORT),
    SNIFFER_NO_OPEN: '1',
    SNIFFER_DESKTOP: '1', // drops the "Dev" badge from the brand
  },
  stdio: 'ignore',
})
process.on('exit', () => { daemon.kill(); rmSync(fakeHome, { recursive: true, force: true } ) })

for (let i = 0; ; i++) {
  try { await fetch(`${BASE}/api/state`); break } catch {
    if (i > 40) throw new Error('daemon did not come up')
    await sleep(500)
  }
}

// ---- staged device and traffic (times match the shot: 04:15:48.898 local, today) ----
const day = new Date(); day.setHours(4, 15, 48, 898)
const t0 = day.getTime()
const at = (s, ms) => t0 + (s - 48) * 1000 + (ms - 898)

const ws = new WebSocket(`ws://localhost:${PORT}/device`)
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
const send = m => ws.send(JSON.stringify(m))
send({
  type: 'hello', deviceId: 'previewpx9', deviceName: 'Pixel 9 Pro', platform: 'android',
  appId: 'com.example.checkout', sdkVersion: '0.5.2', capabilities: ['http', 'socketio'],
})
await sleep(300)

const rule = (id, path) => ({
  id, enabled: true, method: 'GET', urlPattern: path, status: 200,
  headers: { 'content-type': 'application/json' }, body: '{"id":"722","name":"WEIQI","plan":"pro"}',
  delayMs: 0, delayOnly: false, createdAt: Date.now(),
})
await fetch(`${BASE}/api/mocks`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    deviceId: 'previewpx9',
    http: [rule('m1', '/api/users/722'), rule('m2', '/api/checkout'), rule('m3', '/api/plans')],
    socket: [],
  }),
})

const http = (id, method, url, ts, status, size, dur, extra = {}) => {
  send({
    type: 'http-request', id, method, url, headers: { accept: 'application/json' },
    body: null, bodySize: 0, bodyTruncated: false, library: 'ktor', timestamp: ts,
  })
  send({
    type: 'http-response', id, status, headers: { 'content-type': 'application/json' },
    body: extra.body ?? '{}', bodySize: size, bodyTruncated: false, durationMs: dur,
    mocked: extra.mocked ?? false, error: null, timestamp: ts + dur,
  })
}
http('r1', 'GET', 'https://api.example.com/api/users/722', at(48, 898), 200, 38, 88,
  { mocked: true, body: '{"id":"722","name":"WEIQI","plan":"pro"}' })
http('r2', 'POST', 'https://api.example.com/api/checkout', at(57, 898), 201, 23, 241)
http('r3', 'GET', 'https://cdn.example.com/animated.webp', at(62, 898), 200, 86426, 134)
http('r4', 'GET', 'https://api.example.com/api/recommendations', at(66, 898), 500, 33, 812)

send({ type: 'socket-status', connectionId: 'pc1', transport: 'socketio', url: 'https://api.example.com', status: 'connected', timestamp: at(48, 0) })
send({ type: 'socket-event', id: 'se1', connectionId: 'pc1', transport: 'socketio', direction: 'out', event: 'cart:update', payload: '[{"sku":"pro"}]', mocked: false, timestamp: at(50, 0) })
send({ type: 'socket-event', id: 'se2', connectionId: 'pc1', transport: 'socketio', direction: 'in', event: 'cart:updated', payload: '[{"ok":true}]', mocked: false, timestamp: at(51, 0) })
await sleep(600)

// ---- shoot the app ----
const exe = chromiumExecutable()
const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1480, height: 710 }, deviceScaleFactor: 2 })
// a roomier detail pane, so the toolbar and body clear the window edge instead of clipping
await page.addInitScript(() => localStorage.setItem('sniffer-detail-w', '620'))
await page.goto(BASE)
await sleep(700)
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
await page.locator('.device-select').selectOption(
  await page.locator('.device-select option').evaluateAll(os => os.find(o => o.textContent.includes('Pixel 9 Pro')).value))
await sleep(500)
// staged marketing shot: the destructive device button is real UI but off-topic noise here
await page.evaluate(() => document.querySelector('.topbar button.ghost.danger')?.remove())
await page.locator('.list-scroll tbody tr').first().click()
await sleep(600)
const appShot = await page.screenshot()

// ---- hero + mac window chrome around it ----
const svg = readFileSync(join(ROOT, 'server/ui/public/sniffer.svg'))
const wrapper = `<!doctype html><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1560px; height: 890px; background: #f4f4f6; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    padding: 34px 40px;
  }
  .hero { display: flex; align-items: center; gap: 18px; margin: 0 0 26px 8px; }
  .hero img { width: 62px; height: 62px; }
  .hero h1 { font-size: 34px; font-weight: 750; letter-spacing: -.02em; color: #1a1c22; }
  .hero span { font-size: 20px; color: #70737c; margin-left: 6px; }
  .win {
    background: #fff; border-radius: 12px; overflow: hidden;
    box-shadow: 0 18px 50px rgb(16 18 28 / .14), 0 2px 8px rgb(16 18 28 / .08);
  }
  .bar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 16px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .app { display: block; width: 1480px; }
</style>
<div class="hero">
  <img src="data:image/svg+xml;base64,${svg.toString('base64')}">
  <h1>Sniffer Monitor</h1><span>live requests, response bodies, cURL, and one-click mocks</span>
</div>
<div class="win">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
  </div>
  <img class="app" src="data:image/png;base64,${appShot.toString('base64')}">
</div>`
const wrapperPath = join(fakeHome, 'wrapper.html')
writeFileSync(wrapperPath, wrapper)

const shot = await browser.newPage({ viewport: { width: 1560, height: 890 }, deviceScaleFactor: 2 })
await shot.goto(`file://${wrapperPath}`)
await sleep(500)
await shot.screenshot({ path: OUT })
await browser.close()
ws.close()
console.log(`written ${OUT}`)
process.exit(0)
