// Run: node scripts/tab-state.test.mjs (requires Chrome and npm run setup).
// Real UI with synthetic traffic; no daemon or personal device data is used.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const uiRequire = createRequire(new URL('../server/ui/package.json', import.meta.url))
const daemonRequire = createRequire(new URL('../server/daemon/package.json', import.meta.url))
const { createServer } = await import(uiRequire.resolve('vite'))
const { default: react } = await import(uiRequire.resolve('@vitejs/plugin-react'))
const { chromium } = daemonRequire('playwright-core')
const { WebSocketServer } = daemonRequire('ws')
const sockets = new WebSocketServer({ noServer: true })
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../server/ui', import.meta.url)),
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('test') },
  server: { host: '127.0.0.1', port: 0 },
})
let browser
let page
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const deviceId = 'tab-test'
  const timestamp = Date.now()
  const body = JSON.stringify({ items: Array.from({ length: 50 }, (_, id) => ({ id, name: `Item ${id}` })) })
  const entry = message => ({ deviceId, message })
  const traffic = i => [
    entry({ type: 'http-request', id: `h${i}`, method: 'GET', url: `https://example.test/items/${i}`, library: 'ktor', timestamp: timestamp + i }),
    entry({ type: 'http-response', id: `h${i}`, status: 200, body, durationMs: 10, timestamp: timestamp + i }),
    entry({ type: 'socket-event', id: `s${i}`, connectionId: 'c1', transport: 'socketio', direction: 'in', event: `event:${i}`, payload: body, timestamp: timestamp + i }),
  ]
  let stream
  server.httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/ui') sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws))
  })
  sockets.on('connection', ws => {
    stream = ws
    ws.send(JSON.stringify({
      type: 'init',
      devices: [{ deviceId, deviceName: 'Test phone', appId: 'test.app', platform: 'android', connected: true, capabilities: ['http', 'socketio'] }],
      entries: [
        entry({ type: 'socket-status', connectionId: 'c1', transport: 'socketio', url: 'https://example.test', status: 'connected' }),
        entry({ type: 'socket-status', connectionId: 'c2', transport: 'socketio', url: 'https://empty.test', status: 'connected' }),
        ...Array.from({ length: 80 }, (_, i) => traffic(i)).flat(),
      ],
    }))
  })
  await page.route('**/api/**', route => route.fulfill({ json: { checks: [] } }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  const pane = page.locator('.split:visible')
  const rows = pane.locator('tbody tr')
  const selected = () => pane.locator('tr[data-selected]').innerText()
  const scroll = () => pane.locator('.list-scroll').evaluate(el => el.scrollTop)
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const switchTo = async name => {
    await page.locator('nav.tabs').getByRole('button', { name }).click()
    await settle()
  }
  const position = async value => {
    await pane.locator('.list-scroll').evaluate((el, top) => { el.scrollTop = top }, value)
    await settle()
  }
  await rows.nth(20).click()
  await position(400)
  const httpSelected = await selected()
  const httpScroll = await scroll()
  assert(httpScroll > 0, 'HTTP test must start scrolled')
  await pane.getByRole('button', { name: 'Raw', exact: true }).click()
  await pane.locator('.detail-pane').evaluate(el => { el.scrollTop = 250 })
  await settle()
  const detailScroll = await pane.locator('.detail-pane').evaluate(el => el.scrollTop)
  await switchTo(/Socket/)
  await pane.getByRole('button', { name: 'socketio · https://example.test', exact: true }).click()
  await rows.nth(30).click()
  await position(650)
  const socketSelected = await selected()
  const socketScroll = await scroll()
  await switchTo(/API/)
  assert.equal(await pane.locator('tr[data-selected]').count(), 1, 'HTTP selection survives tab switch')
  assert.equal(await selected(), httpSelected)
  assert.equal(await scroll(), httpScroll, 'HTTP scroll survives tab switch')
  assert.equal(await pane.getByRole('button', { name: 'Raw', exact: true }).getAttribute('data-active'), 'true', 'Body view survives tab switch')
  assert.equal(await pane.locator('.detail-pane').evaluate(el => el.scrollTop), detailScroll, 'Detail scroll survives tab switch')
  await page.keyboard.press('ArrowDown')
  await settle()
  assert.notEqual(await selected(), httpSelected, 'HTTP keyboard navigation still works')
  const nextHttpSelected = await selected()
  await switchTo(/Socket/)
  assert.equal(await selected(), socketSelected, 'HTTP keys must not change hidden Socket selection')
  assert.equal(await pane.locator('.conn-chip[data-active="true"]').innerText(), 'socketio · https://example.test', 'Socket connection selection survives tab switch')
  assert.equal(await scroll(), socketScroll, 'Socket scroll survives tab switch')
  await page.keyboard.press('ArrowDown')
  await settle()
  assert.notEqual(await selected(), socketSelected, 'Socket keyboard navigation still works')
  await switchTo(/API/)
  assert.equal(await selected(), nextHttpSelected, 'Socket keys must not change hidden HTTP selection')
  // Hidden incoming traffic must not reset a reader's position, including with no selection.
  let nextId = 80
  for (const [current, other] of [[/API/, /Socket/], [/Socket/, /API/]]) {
    await switchTo(current)
    await page.keyboard.press('Escape')
    await position(300)
    const before = await scroll()
    await switchTo(other)
    for (const e of traffic(nextId++)) stream.send(JSON.stringify({ type: 'event', ...e }))
    await settle()
    await switchTo(current)
    assert.equal(await scroll(), before, 'Background traffic preserves scroll away from the bottom')
    assert.equal(await pane.locator('tr[data-selected]').count(), 0, 'Hidden view ignores Escape on the other tab')
  }
  // Empty states must distinguish hidden traffic from a lack of captured traffic.
  for (const name of [/API/, /Socket/]) {
    await switchTo(name)
    await page.locator('input.search').fill('no-such-traffic')
    await pane.getByText('No matching results', { exact: true }).waitFor()
    await pane.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await rows.first().waitFor()
    assert.equal(await page.locator('input.search').inputValue(), '')
    await position(0)
    await pane.getByTitle('Filter this column').click()
    await pane.locator('.filter-add input').fill('no-such-column-value')
    await pane.getByTitle('Add filter value').click()
    await pane.locator('.filter-switch').click()
    await page.locator('.brand').click()
    await pane.getByText('No matching results', { exact: true }).waitFor()
    await pane.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await rows.first().waitFor()
    await position(0)
    await pane.getByTitle('Filter this column').click()
    assert.equal(await pane.locator('.filter-value').innerText(), 'no-such-column-value', 'Clearing filters keeps saved filter values')
    await page.locator('.brand').click()
  }
  await pane.getByRole('button', { name: 'socketio · https://empty.test', exact: true }).click()
  await pane.getByText('No matching results', { exact: true }).waitFor()
  assert.equal(await pane.getByRole('button', { name: 'Scroll to bottom' }).count(), 0, 'Empty traffic has no misleading Latest button')
  if (process.env.SNIFFER_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SNIFFER_TEST_SCREENSHOT })
  await pane.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await rows.first().waitFor()
  assert.equal(await pane.locator('.conn-chip[data-active="true"]').innerText(), 'All', 'Clearing filters resets the Socket connection filter too')
  stream.send(JSON.stringify({ type: 'entries-cleared' }))
  for (const [name, message] of [[/API/, 'Waiting for requests'], [/Socket/, 'Waiting for socket events']]) {
    await switchTo(name)
    await pane.getByText(message, { exact: true }).waitFor()
    assert.equal(await pane.getByRole('button', { name: 'Clear filters' }).count(), 0)
  }
  stream.send(JSON.stringify({ type: 'device-status', deviceId, connected: false }))
  for (const name of [/API/, /Socket/]) {
    await switchTo(name)
    await pane.getByText('Device is offline', { exact: true }).waitFor()
  }
  await pane.getByRole('button', { name: 'Connection settings', exact: true }).click()
  await page.locator('.settings-popover').waitFor()
  await page.locator('.settings-backdrop').click({ position: { x: 1, y: 1 } })
  stream.send(JSON.stringify({ type: 'device-deleted', deviceId }))
  await pane.getByText('No device connected', { exact: true }).waitFor()
  stream.close()
  await pane.getByText('Monitor disconnected', { exact: true }).waitFor()
  assert.deepEqual(errors, [], 'No browser errors')
  console.log('PASS: tab state, keyboard isolation, background traffic, and actionable empty states')
} catch (error) {
  if (page) console.error(await page.locator('.split:visible').innerText())
  throw error
} finally {
  await browser?.close()
  for (const ws of sockets.clients) ws.terminate()
  sockets.close()
  await server.close()
}
