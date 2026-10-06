// Run after daemon test:unit: node scripts/firebase-panel.test.mjs (requires Chrome).
// The real UI and entry store, with synthetic records and an isolated Vite server.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEntryStore } from '../server/daemon/build/test/entryStore.js'

const uiRequire = createRequire(new URL('../server/ui/package.json', import.meta.url))
const daemonRequire = createRequire(new URL('../server/daemon/package.json', import.meta.url))
const { createServer } = await import(uiRequire.resolve('vite'))
const { default: react } = await import(uiRequire.resolve('@vitejs/plugin-react'))
const { chromium } = daemonRequire('playwright-core')
const { WebSocketServer, WebSocket } = daemonRequire('ws')
const sockets = new WebSocketServer({ noServer: true })
const broadcast = message => {
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const store = createEntryStore(broadcast)
const device = { deviceId: 'firebase-test', deviceName: 'Test phone', appId: 'test.firebase', platform: 'android', connected: true, capabilities: ['firebase'] }
const timestamp = Date.now()
const record = (id, severity, message) => ({
  type: 'firebase-event', id, severity, message, timestamp: timestamp + Number(id),
  exception: severity === 'log' ? '' : 'IllegalStateException',
  stackTrace: severity === 'log' ? '' : 'IllegalStateException: Sample checkout failed\n    at Checkout.submit(Checkout.kt:42)\nCaused by: IOException: Connection closed',
  userId: id === '1' ? '' : id === '2' ? 'second-user' : 'sample-user', keys: { screen: 'checkout', build: 'debug' }, thread: 'main',
  logs: severity === 'log' ? [] : [{ timestamp, message: 'Sample: Pay tapped' }],
})
const emit = (id, severity, message) => store.pushEntry(device.deviceId, record(id, severity, message))
emit('1', 'log', 'Sample: checkout opened')
emit('2', 'non-fatal', 'Sample: payment retry failed')
emit('3', 'fatal', 'Sample: checkout failed')
store.pushEntry('another-device', record('4', 'fatal', 'Other device only'))
const cacheDir = await mkdtemp(join(tmpdir(), 'sniffer-firebase-ui-'))
const screenshotDir = process.env.SNIFFER_SCREENSHOT_DIR ?? join(tmpdir(), 'sniffer-firebase-review')
const server = await createServer({
  configFile: false, root: fileURLToPath(new URL('../server/ui', import.meta.url)), cacheDir,
  plugins: [react()], define: { __APP_VERSION__: JSON.stringify('test') }, server: { host: '127.0.0.1', port: 0 },
})
let browser
try {
  await server.listen()
  server.httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/ui') sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws))
  })
  sockets.on('connection', ws => ws.send(JSON.stringify({ type: 'init', devices: [device], entries: store.snapshot() })))
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let failClear = false
  await page.route('**/api/**', async route => {
    if (route.request().url().endsWith('/api/entries/firebase')) {
      if (failClear) return route.fulfill({ status: 500, json: { error: 'test failure' } })
      store.clearFirebase()
      broadcast({ type: 'firebase-entries-cleared' })
    }
    await route.fulfill({ json: { checks: [] } })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  const tab = page.locator('nav.tabs').getByRole('button', { name: /Firebase Beta/ })
  const settings = page.getByTitle('Settings (⌘,)')
  const toggle = page.getByRole('switch', { name: 'Firebase Beta' })
  const panel = page.locator('.firebase-panel')
  const rows = panel.locator('.firebase-event[data-kind="firebase"]')
  const search = page.getByPlaceholder('Search exceptions, logs, keys, user ID…')
  assert.equal(await tab.count(), 0, 'Firebase is hidden by default')
  await settings.click()
  assert.equal(await toggle.isChecked(), false)
  await toggle.focus()
  await toggle.press('Space')
  await settings.click()
  await tab.click()
  await rows.first().waitFor()
  assert.equal(await rows.count(), 3, 'only the selected device is shown')
  await rows.first().hover()
  await page.mouse.down()
  assert.equal(await rows.first().evaluate(el => getComputedStyle(el).transform), 'none', 'clicking the timeline does not shrink the panel row')
  await page.mouse.up()
  assert.equal(await tab.locator('.beta-badge').innerText(), 'Beta')
  await rows.last().click()
  await panel.getByRole('complementary', { name: 'Firebase record details' }).waitFor()
  assert.match(await panel.getByRole('complementary', { name: 'Firebase record details' }).innerText(), /Checkout.kt:42/)
  assert.match(await panel.getByRole('complementary', { name: 'Firebase record details' }).innerText(), /sample-user/)
  assert.match(await panel.getByRole('complementary', { name: 'Firebase record details' }).innerText(), /Pay tapped/)
  await panel.getByLabel('Firebase severity').selectOption('non-fatal')
  assert.equal(await rows.count(), 1)
  await panel.getByLabel('Firebase severity').selectOption('all')
  const userFilter = panel.getByRole('complementary', { name: 'Firebase user filters' })
  await userFilter.getByRole('button', { name: /^No user ID/ }).click()
  assert.equal(await rows.count(), 1, 'unset user IDs can be filtered')
  assert.match(await rows.first().innerText(), /checkout opened/)
  await userFilter.getByRole('button', { name: /^second-user/ }).click()
  assert.equal(await rows.count(), 1, 'exact user ID filter')
  await panel.getByLabel('Firebase severity').selectOption('fatal')
  await panel.getByText('No matching results').waitFor()
  await panel.getByRole('button', { name: 'Clear filters' }).click()
  assert.equal(await userFilter.getByRole('button', { name: /^All users/ }).getAttribute('aria-pressed'), 'true', 'reset clears the user ID filter')
  await userFilter.getByRole('button', { name: /^sample-user/ }).click()
  await search.fill('Connection closed')
  assert.equal(await rows.count(), 1, 'search intersects the user ID filter')
  await userFilter.getByRole('button', { name: /^All users/ }).click()
  await search.fill('Connection closed')
  await page.waitForFunction(() => document.querySelectorAll('.firebase-event[data-kind="firebase"]').length === 2)
  await search.fill('no matching text')
  await panel.getByText('No matching results').waitFor()
  await panel.getByRole('button', { name: 'Clear filters' }).click()
  await rows.last().waitFor()
  await rows.last().click()
  // API user identity is captured at request time; absent identity is not anonymous identity.
  const http = (id, userId) => {
    store.pushEntry(device.deviceId, { type: 'http-request', id, timestamp: timestamp + 2,
      method: 'POST', url: 'https://example.com/checkout', library: 'okhttp', headers: {}, body: '{}', userId })
    store.pushEntry(device.deviceId, { type: 'http-response', id, timestamp: timestamp + 3,
      status: 503, headers: { 'content-type': 'application/json' }, body: '{"reason":"unavailable"}', durationMs: 820 })
  }
  http('3', 'sample-user') // Same ID as a Firebase event must remain a separate row.
  http('anonymous', '')
  http('legacy', undefined)
  const apiRows = panel.locator('.firebase-event[data-kind="http"]')
  await apiRows.last().waitFor()
  assert.equal(await apiRows.count(), 3)
  await userFilter.getByRole('button', { name: /^No user ID/ }).click()
  assert.equal(await rows.count(), 1)
  assert.equal(await apiRows.count(), 1, 'missing API identity is not treated as an anonymous user')
  await userFilter.getByRole('button', { name: /^sample-user/ }).click()
  assert.equal(await rows.count(), 1)
  assert.equal(await apiRows.count(), 1)
  await apiRows.first().click()
  await panel.getByRole('complementary', { name: 'API request details' }).waitFor()
  assert.match(await panel.getByRole('complementary', { name: 'API request details' }).innerText(), /unavailable/)
  await panel.getByLabel('Include API', { exact: true }).uncheck()
  assert.equal(await apiRows.count(), 0)
  await panel.getByLabel('Include API', { exact: true }).check()
  await userFilter.getByRole('button', { name: /^All users/ }).click()
  await rows.last().click()
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: join(screenshotDir, 'firebase-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByTitle('Toggle light/dark theme').click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.screenshot({ path: join(screenshotDir, 'firebase-dark.png'), fullPage: true, animations: 'disabled' })
  await page.getByTitle('Toggle light/dark theme').click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.locator('.topbar').count(), 1, 'only one app header is rendered')
  await page.screenshot({ path: join(screenshotDir, 'firebase-mobile.png'), fullPage: false, animations: 'disabled' })
  await panel.getByRole('complementary', { name: 'Firebase record details' }).evaluate(el => { el.scrollTop = el.scrollHeight })
  await panel.getByText('Logs before this event').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile page overflow')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await rows.first().waitFor()
  assert.equal(await tab.getAttribute('data-active'), 'true', 'enabled state and active tab survive reload')
  await page.locator('nav.tabs').getByRole('button', { name: /^API,/ }).click()
  emit('5', 'log', 'Sample: live event')
  await tab.locator('.tab-unread').waitFor()
  assert.equal(await tab.locator('.tab-unread').innerText(), '1', 'new Firebase arrivals increment unread')
  await tab.click()
  assert.equal(await rows.count(), 4)
  emit('3', 'fatal', 'Sample: checkout failed')
  assert.equal(await rows.count(), 4, 'fatal replay does not duplicate a row')
  await panel.getByLabel('Include API', { exact: true }).uncheck()
  failClear = true
  await panel.getByRole('button', { name: 'Clear Firebase' }).click()
  await panel.getByRole('alert').waitFor()
  assert.equal(await rows.count(), 4, 'failed clear keeps records')
  failClear = false
  await panel.getByRole('button', { name: 'Clear Firebase' }).click()
  await panel.getByText('Waiting for Firebase records').waitFor()
  emit('3', 'fatal', 'Sample: checkout failed')
  assert.equal(store.snapshot().filter(e => e.message.type === 'firebase-event').length, 0, 'cleared fatal replay stays cleared')
  assert.equal(store.snapshot().filter(e => e.message.type === 'http-request').length, 3, 'Firebase clear preserves API requests')
  await settings.click()
  await toggle.focus()
  await toggle.press('Space')
  await settings.click()
  assert.equal(await tab.count(), 0)
  assert.equal(await page.locator('nav.tabs').getByRole('button', { name: /^API,/ }).getAttribute('data-active'), 'true')
  emit('6', 'non-fatal', 'Sample: captured while hidden')
  await settings.click()
  await toggle.focus()
  await toggle.press('Space')
  await settings.click()
  await tab.click()
  await rows.first().waitFor()
  assert.match(await rows.first().innerText(), /captured while hidden/, 'hiding the panel does not stop capture')
  assert.deepEqual(errors, [])
  console.log('firebase-panel.test: all assertions passed')
} finally {
  await browser?.close()
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
}
