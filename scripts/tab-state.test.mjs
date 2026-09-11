// Run: node scripts/tab-state.test.mjs (requires Chrome and npm run setup).
// Real UI with synthetic traffic; no daemon or personal device data is used.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const uiRequire = createRequire(new URL('../server/ui/package.json', import.meta.url))
const daemonRequire = createRequire(new URL('../server/daemon/package.json', import.meta.url))
const { createServer } = await import(uiRequire.resolve('vite'))
const { default: react } = await import(uiRequire.resolve('@vitejs/plugin-react'))
const { chromium } = daemonRequire('playwright-core')
const { WebSocketServer } = daemonRequire('ws')
const sockets = new WebSocketServer({ noServer: true })
// Tests must not replace optimized dependencies used by an open development page.
const cacheDir = await mkdtemp(join(tmpdir(), 'sniffer-tab-test-'))
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../server/ui', import.meta.url)),
  cacheDir,
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
  let savedMocks = { http: [], socket: [] }
  await page.route('**/api/**', async route => {
    if (route.request().url().endsWith('/api/mocks')) {
      const { http, socket } = route.request().postDataJSON()
      savedMocks = { http, socket }
      stream.send(JSON.stringify({ type: 'mocks-changed', deviceId, mocks: savedMocks }))
    }
    await route.fulfill({ json: { checks: [] } })
  })
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
  assert.equal(await page.locator('.tab-unread').count(), 0, 'Initial history is not unread traffic')
  for (const name of [/API/, /Socket/]) {
    await switchTo(name)
    assert.equal(await pane.locator('tr[data-latest]').count(), 1)
    const latestText = await pane.locator('tr[data-latest]').innerText()
    await pane.locator('th.sortable').click()
    assert.equal(await rows.first().innerText(), latestText, 'Newest marker follows the row when sorting')
    await pane.locator('th.sortable').click()
    assert.equal(await rows.last().innerText(), latestText)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await pane.locator('tr[data-latest] td').first().evaluate(el => getComputedStyle(el, '::after').animationName), 'none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
  await switchTo(/API/)
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
    assert.equal(await pane.locator('tr[data-latest]').count(), 1, 'Incoming traffic keeps exactly one newest marker')
    assert.equal(await rows.last().getAttribute('data-latest'), 'true', 'The marker moves to the new row')
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
  // App shortcuts work from text fields and keep existing dialogs intact.
  await page.evaluate(() => {
    window.snifferDesktop = { find() {}, stopFind() {}, onFindResult: () => () => {} }
  })
  for (const name of [/API/, /Socket/]) {
    await switchTo(name)
    await page.keyboard.press('Meta+f')
    assert.equal(await page.locator('input.search').evaluate(el => el === document.activeElement), true)
    await page.keyboard.type('no-such-traffic')
    await pane.getByText('No matching results', { exact: true }).waitFor()
    await page.locator('.brand').click()
    await page.keyboard.press('Meta+f')
    assert.deepEqual(await page.locator('input.search').evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 15])
    await page.keyboard.type('200')
    assert.equal(await page.locator('input.search').inputValue(), '200', 'Typing replaces the previous search')
    assert.equal(await page.locator('.find-bar').count(), 0, 'Desktop find bar must not steal search focus')
    await page.locator('input.search').fill('')
  }
  await page.evaluate(() => { delete window.snifferDesktop })
  for (const [name, title] of [[/API/, 'HTTP mock rules'], [/Socket/, 'Socket mocks']]) {
    await switchTo(name)
    await page.locator('input.search').focus()
    await page.keyboard.press('Meta+m')
    const mockDialog = page.getByRole('dialog', { name: title, exact: true })
    await mockDialog.waitFor()
    await page.keyboard.press('Meta+m')
    await page.keyboard.press('Meta+,')
    assert.equal(await page.getByRole('dialog').count(), 1)
    assert.equal(await page.locator('.settings-popover').count(), 0)
    await page.keyboard.press('Escape')
    await mockDialog.waitFor({ state: 'hidden' })
  }
  await page.locator('input.search').focus()
  await page.keyboard.press('m')
  assert.equal(await page.locator('input.search').inputValue(), 'm')
  await page.locator('input.search').fill('')
  await page.keyboard.press('Meta+Shift+m')
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-popover').waitFor()
  await page.locator('.settings-port input').click()
  assert.equal(await page.locator('.settings-popover').isVisible(), true, 'Clicking inside settings keeps it open')
  await page.mouse.click(640, 600)
  await page.locator('.settings-popover').waitFor({ state: 'hidden' })
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-popover').waitFor()
  await page.mouse.click(12, 12)
  await page.locator('.settings-popover').waitFor({ state: 'hidden' })
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-popover').waitFor()
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-popover').waitFor({ state: 'hidden' })
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-popover').waitFor()
  await page.keyboard.press('Meta+m')
  await page.getByRole('dialog', { name: 'Socket mocks', exact: true }).waitFor()
  assert.equal(await page.locator('.settings-popover').count(), 0)
  await page.keyboard.press('Escape')
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
  // Importing from HTTP must save all categories before ever visiting the Socket panel.
  await switchTo(/API/)
  await pane.getByRole('button', { name: /HTTP Mocks/ }).click()
  const httpMocks = page.getByRole('dialog', { name: 'HTTP mock rules', exact: true })
  const imported = {
    http: [{ id: 'import-http', enabled: true, method: 'GET', urlPattern: '/imported', status: 200, headers: {}, body: '{}', delayMs: 0, delayOnly: false }],
    socket: [{ id: 'import-socket', enabled: true, transport: 'socketio', event: 'imported:ack', ackPayload: '[true]', delayMs: 0 }],
    push: [{ id: 'import-push', target: 'c1', event: 'imported:push', payload: '{}' }],
  }
  await httpMocks.locator('input[type=file]').setInputFiles({ name: 'all-rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) })
  await httpMocks.getByText('Saved ✓', { exact: true }).waitFor()
  const importResult = page.getByRole('dialog', { name: 'Import complete', exact: true })
  await importResult.waitFor()
  assert.deepEqual(await importResult.locator('dd').allTextContents(), ['× 1', '× 1', '× 1'])
  await importResult.getByText('3 items imported', { exact: true }).waitFor()
  assert.equal(await importResult.getByRole('button', { name: 'Done' }).evaluate(el => el === document.activeElement), true)
  if (process.env.SNIFFER_IMPORT_SCREENSHOT) await page.screenshot({ path: process.env.SNIFFER_IMPORT_SCREENSHOT })
  await importResult.getByRole('button', { name: 'Done' }).click()
  assert.equal(await httpMocks.isVisible(), true, 'Done preserves the mock editor')
  assert.equal(savedMocks.http.length, 1)
  assert.equal(savedMocks.socket[0].event, 'imported:ack', 'HTTP import synchronizes Socket rules')
  const storedPush = await page.evaluate(() => JSON.parse(localStorage.getItem('sniffer-push-tab-test') ?? '[]'))
  assert.equal(storedPush.length, 1, 'HTTP import persists push events without opening the Push tab')
  assert.equal(storedPush[0].event, 'imported:push')
  await httpMocks.getByTitle('Close', { exact: true }).click()
  await switchTo(/Socket/)
  await pane.getByRole('button', { name: /Socket Mocks/ }).click()
  const importedSocket = page.getByRole('dialog', { name: 'Socket mocks', exact: true })
  await importedSocket.getByText('imported:ack', { exact: true }).waitFor()
  await importedSocket.getByRole('button', { name: /Server push events/ }).click()
  await importedSocket.getByText('imported:push', { exact: true }).waitFor()
  // A second, push-only import reports this file's counts, including zero categories.
  await importedSocket.locator('input[type=file]').setInputFiles({ name: 'push.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ push: imported.push })) })
  await importResult.waitFor()
  assert.deepEqual(await importResult.locator('dd').allTextContents(), ['× 0', '× 0', '× 1'])
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sniffer-push-tab-test')).length), 2)
  await page.keyboard.press('Escape')
  await importResult.waitFor({ state: 'hidden' })
  assert.equal(await importedSocket.isVisible(), true, 'Escape dismisses only the import result')
  // Export selection persists across categories; the download contains only selected items.
  await importedSocket.getByRole('button', { name: 'Export', exact: true }).click()
  const exportDialog = page.getByRole('dialog', { name: 'Export rules', exact: true })
  await exportDialog.getByText('Selected 4 / 4 items', { exact: true }).waitFor()
  await exportDialog.getByRole('button', { name: 'Deselect All Rules & Events', exact: true }).click()
  assert.equal(await exportDialog.getByRole('button', { name: 'Export (0)', exact: true }).isDisabled(), true)
  await exportDialog.getByRole('checkbox', { name: 'Select all HTTP rules', exact: true }).check()
  await exportDialog.getByRole('button', { name: 'Select All Rules & Events', exact: true }).click()
  await exportDialog.getByRole('tab', { name: /Socket rules/ }).click()
  await exportDialog.getByRole('checkbox', { name: 'Export imported:ack', exact: true }).uncheck()
  await exportDialog.getByRole('tab', { name: /Push events/ }).click()
  const pushItems = exportDialog.getByRole('checkbox', { name: 'Export imported:push', exact: true })
  await pushItems.first().uncheck()
  assert.equal(await exportDialog.getByRole('checkbox', { name: 'Select all Push events' }).evaluate(el => el.indeterminate), true)
  await exportDialog.getByRole('tab', { name: /HTTP rules/ }).click()
  assert.equal(await exportDialog.getByRole('checkbox', { name: 'Export /imported', exact: true }).isChecked(), true)
  await page.keyboard.press('End')
  assert.equal(await exportDialog.getByRole('tab', { name: /Push events/ }).getAttribute('aria-selected'), 'true')
  assert.equal(await pushItems.first().isChecked(), false, 'Switching categories preserves item selection')
  const expectedPush = await page.evaluate(() => JSON.parse(localStorage.getItem('sniffer-push-tab-test'))[1])
  if (process.env.SNIFFER_EXPORT_SCREENSHOT) {
    await page.screenshot({ path: process.env.SNIFFER_EXPORT_SCREENSHOT })
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()))
    await page.screenshot({ path: process.env.SNIFFER_EXPORT_SCREENSHOT.replace('.png', '-dark.png') })
  }
  const downloadReady = page.waitForEvent('download')
  await exportDialog.getByRole('button', { name: 'Export (2)', exact: true }).click()
  const download = await downloadReady
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  const exported = JSON.parse(Buffer.concat(chunks).toString())
  assert.deepEqual(exported, { http: savedMocks.http, socket: [], push: [expectedPush] }, 'Downloaded JSON contains precisely the selected rules and original fields')
  assert.equal(await importedSocket.isVisible(), true, 'Export preserves the mock editor')
  await importedSocket.getByRole('button', { name: 'Export', exact: true }).click()
  await exportDialog.getByText('Selected 4 / 4 items', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await exportDialog.waitFor({ state: 'hidden' })
  assert.equal(await importedSocket.isVisible(), true, 'Escape dismisses only the export dialog')
  await importedSocket.getByTitle('Close', { exact: true }).click()
  // Clearing push events must confirm before removing device and shared records.
  await page.evaluate(() => {
    localStorage.setItem('sniffer-push-tab-test', JSON.stringify([{ id: 'local-push', event: 'local push', payload: '{}' }]))
    localStorage.setItem('sniffer-push-shared-test.app', JSON.stringify([{ id: 'shared-push', event: 'shared push', payload: '{}', starred: true }]))
  })
  await pane.getByRole('button', { name: /Socket Mocks/ }).click()
  const mocks = page.getByRole('dialog', { name: 'Socket mocks', exact: true })
  await mocks.getByRole('button', { name: /Server push events/ }).click()
  const pushRecords = () => page.evaluate(() => [
    JSON.parse(localStorage.getItem('sniffer-push-tab-test')),
    JSON.parse(localStorage.getItem('sniffer-push-shared-test.app')),
  ])
  const beforeClear = await pushRecords()
  await mocks.getByTitle('Clear all', { exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.waitFor()
  assert.deepEqual(await pushRecords(), beforeClear, 'Opening confirmation must not clear push records')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.deepEqual(await pushRecords(), beforeClear, 'Cancel preserves local and shared push records')
  await mocks.getByTitle('Clear all', { exact: true }).click()
  await confirmation.getByRole('button', { name: 'Clear events', exact: true }).click()
  await mocks.getByText('No push events yet', { exact: false }).waitFor()
  assert.deepEqual(await pushRecords(), [[], []], 'Confirm clears local and shared push records')
  assert.equal(await mocks.getByTitle('Clear all', { exact: true }).count(), 0)
  await mocks.getByRole('button', { name: 'Export', exact: true }).click()
  await exportDialog.getByRole('tab', { name: /Push events/ }).click()
  await exportDialog.getByText('No push events to export.', { exact: true }).waitFor()
  assert.equal(await exportDialog.getByRole('checkbox', { name: 'Select all Push events' }).isDisabled(), true)
  await exportDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await mocks.getByTitle('Close', { exact: true }).click()
  // Unread badges count new visible rows, independently of totals and response/ack updates.
  const tabButton = name => page.locator('nav.tabs').getByRole('button', { name })
  let devFlag = false
  const sendMessages = async messages => {
    for (const message of messages) stream.send(JSON.stringify(message))
    devFlag = !devFlag
    stream.send(JSON.stringify({ type: 'server-info', dev: devFlag }))
    await page.waitForFunction(title => document.title === title, devFlag ? 'Sniffer Dev' : 'Sniffer')
    await settle()
  }
  const sendTraffic = async (id, transform = value => value) => sendMessages(traffic(id).map(value => ({ type: 'event', ...transform(value) })))
  // Both traffic menus copy the clicked row, including real Socket names behind display labels.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.copiedTraffic = text },
    } })
  })
  const copyFromMenu = async (row, label, expected) => {
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    assert.equal(await page.evaluate(() => window.copiedTraffic), expected)
    await page.getByRole('menu').waitFor({ state: 'hidden' })
  }
  await switchTo(/Socket/)
  const copiedId = nextId++
  await sendTraffic(copiedId, e => ({ ...e, message: { ...e.message, event: 'copy:event', label: 'Friendly label' } }))
  const socketCopyRow = rows.filter({ hasText: 'copy:event' })
  await socketCopyRow.click({ button: 'right' })
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Copy event name', 'Copy connection URL'])
  await page.getByRole('menu').screenshot({ path: '/tmp/sniffer-socket-copy-menu.png' })
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.getByRole('menuitem', { name: 'Copy connection URL' }).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Escape')
  await copyFromMenu(socketCopyRow, 'Copy event name', 'copy:event')
  await copyFromMenu(socketCopyRow, 'Copy connection URL', 'https://example.test')
  await sendMessages([{ type: 'event', ...entry({ type: 'socket-event', id: 'copy-frame', connectionId: 'unknown', transport: 'ktor-ws', direction: 'in', event: 'message', payload: '42["chat:new",{}]', timestamp }) }])
  const frameRow = rows.filter({ hasText: 'chat:new' })
  await copyFromMenu(frameRow, 'Copy event name', 'chat:new')
  await frameRow.click({ button: 'right' })
  assert.equal(await page.getByRole('menuitem', { name: 'Copy connection URL' }).isDisabled(), true, 'Missing URLs do not copy connection IDs')
  await page.locator('.brand').click()
  await page.getByRole('menu').waitFor({ state: 'hidden' })
  await switchTo(/API/)
  const httpCopyRow = rows.first()
  await httpCopyRow.click({ button: 'right' })
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Copy cURL', 'Copy URL', 'Copy path'])
  await page.keyboard.press('Escape')
  await copyFromMenu(httpCopyRow, 'Copy URL', 'https://example.test/items/0')
  await copyFromMenu(httpCopyRow, 'Copy path', '/items/0')
  for (const [current, other] of [[/API/, /Socket/], [/Socket/, /API/]]) {
    await switchTo(current)
    await switchTo(other)
    await switchTo(current)
    const id = nextId++
    await sendTraffic(id)
    assert.equal(await tabButton(other).locator('.tab-unread').innerText(), '1')
    assert.equal(await tabButton(current).locator('.tab-unread').count(), 0)
    await sendMessages([
      { type: 'event', ...traffic(id)[1] },
      { type: 'event', ...entry({ type: 'socket-ack', id: `s${id}`, payload: '[]', mocked: false }) },
    ])
    assert.equal(await tabButton(other).locator('.tab-unread').innerText(), '1', 'Responses and ACKs do not add another unread row')
    if (current.source === 'API') {
      await page.keyboard.press('Escape')
      await position(1e6)
      await page.screenshot({ path: '/tmp/sniffer-unread-production.png' })
      assert.equal(await tabButton(other).locator('.tab-unread').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(217, 45, 32)')
      assert.equal(await pane.locator('tr[data-latest] td').first().evaluate(el => getComputedStyle(el, '::after').backgroundColor), 'rgb(91, 72, 217)')
    }
    await switchTo(other)
    assert.equal(await tabButton(other).locator('.tab-unread').count(), 0, 'Opening a tab clears its badge')
  }
  await page.locator('input.search').fill('no-such-unread')
  await pane.getByText('No matching results', { exact: true }).waitFor()
  await sendTraffic(nextId++)
  assert.equal(await page.locator('.tab-unread').count(), 0, 'Search-hidden arrivals are not counted')
  await page.locator('input.search').fill('')
  await rows.first().waitFor()
  await settle()
  assert.equal(await page.locator('.tab-unread').count(), 0, 'Removing search does not turn old rows into new arrivals')
  // Both column filters and the Socket connection selector apply to unread counts.
  for (const [current, other, value] of [[/API/, /Socket/, 'https://example.test/hidden'], [/Socket/, /API/, 'hidden:event']]) {
    await switchTo(current)
    await position(0)
    await pane.getByTitle('Filter this column').click()
    await pane.locator('.filter-add input').fill(value)
    await pane.getByTitle('Add filter value').click()
    if (!await pane.locator('.filter-switch input').isChecked()) await pane.locator('.filter-switch').click()
    await page.locator('.brand').click()
    await switchTo(other)
    await sendTraffic(nextId++, e => ({ ...e, message: { ...e.message, url: 'https://example.test/hidden', event: 'hidden:event' } }))
    assert.equal(await tabButton(current).locator('.tab-unread').count(), 0, 'Column-hidden arrivals are not counted')
    await switchTo(current)
    await position(0)
    await pane.getByTitle('Filter this column').click()
    await pane.getByTitle('Disable every value').click()
    await page.locator('.brand').click()
    assert.equal(await tabButton(current).locator('.tab-unread').count(), 0)
  }
  await switchTo(/Socket/)
  await pane.getByRole('button', { name: 'socketio · https://empty.test', exact: true }).click()
  await switchTo(/API/)
  await sendTraffic(nextId++)
  assert.equal(await tabButton(/Socket/).locator('.tab-unread').count(), 0, 'Other Socket connections do not count')
  await switchTo(/Socket/)
  await pane.getByRole('button', { name: 'All', exact: true }).click()
  await switchTo(/API/)
  // The 500-row cap must not stop new counts when total length stays unchanged.
  await sendMessages(Array.from({ length: 505 }, () => traffic(nextId++).map(e => ({ type: 'event', ...e }))).flat())
  assert.equal(await tabButton(/Socket/).locator('.tab-unread').innerText(), '99+')
  assert.equal(await tabButton(/Socket/).locator('.count').innerText(), '500')
  await switchTo(/Socket/)
  await switchTo(/API/)
  await sendTraffic(nextId++)
  assert.equal(await tabButton(/Socket/).locator('.tab-unread').innerText(), '1', 'Capped lists still detect the next row')
  await sendMessages([{ type: 'socket-entries-cleared' }])
  assert.equal(await tabButton(/Socket/).locator('.tab-unread').count(), 0, 'Clearing hidden traffic clears its badge')
  await sendTraffic(nextId++)
  await sendMessages([{ type: 'device-status', deviceId: 'other-device', connected: true, info: { deviceName: 'Other phone', appId: 'test.other', platform: 'android' } }])
  await page.locator('.device-picker-trigger').click()
  await page.locator('.device-picker-option').filter({ hasText: 'Other phone' }).click()
  assert.equal(await page.locator('.tab-unread').count(), 0, 'Switching devices resets unread history')
  await page.locator('.device-picker-trigger').click()
  await page.locator('.device-picker-option').filter({ hasText: 'Test phone' }).click()
  await sendMessages([{ type: 'device-deleted', deviceId: 'other-device' }])
  assert.equal(await page.locator('.tab-unread').count(), 0, 'Device history is not newly received traffic')
  // A reconnect snapshot resets the baseline, including retained history.
  await sendTraffic(nextId++)
  await sendMessages([{ type: 'init', devices: [{ deviceId, deviceName: 'Test phone', appId: 'test.app', platform: 'android', connected: true }], entries: traffic(nextId++) }])
  assert.equal(await page.locator('.tab-unread').count(), 0, 'Reconnect replay does not create badges')
  await sendMessages([{ type: 'entries-cleared' }])
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
  await page.getByText('Not checked yet', { exact: true }).waitFor()
  const checkUpdate = page.getByRole('button', { name: 'Check for updates', exact: true })
  assert.equal(await checkUpdate.innerText(), '', 'Update check uses an icon with an accessible name')
  assert.equal(await checkUpdate.locator('svg').count(), 1)
  await checkUpdate.click()
  await page.getByText('Desktop app only', { exact: true }).waitFor()
  await page.evaluate(() => {
    window.snifferDesktop = { checkUpdate: () => new Promise(resolve => { window.finishUpdateCheck = resolve }) }
  })
  await checkUpdate.click()
  assert.equal(await checkUpdate.isDisabled(), true)
  await page.getByText('Checking…', { exact: true }).waitFor()
  await page.evaluate(() => window.finishUpdateCheck({ supported: true, available: false }))
  await page.getByText('Up to date', { exact: true }).waitFor()
  assert.equal(await checkUpdate.isEnabled(), true)
  if (process.env.SNIFFER_UPDATE_SCREENSHOT) await page.screenshot({ path: process.env.SNIFFER_UPDATE_SCREENSHOT })
  await checkUpdate.click()
  await page.evaluate(() => window.finishUpdateCheck({ supported: true, error: 'Offline' }))
  await page.getByText('Couldn’t check for updates', { exact: true }).waitFor()
  assert.equal(await checkUpdate.isEnabled(), true)
  await page.mouse.click(12, 12)
  stream.send(JSON.stringify({ type: 'device-deleted', deviceId }))
  await pane.getByText('No device connected', { exact: true }).waitFor()
  await page.keyboard.press('Meta+m')
  assert.equal(await page.getByRole('dialog').count(), 0, 'Mock shortcut requires a device')
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-popover').waitFor()
  await page.mouse.click(12, 12)
  stream.close()
  await pane.getByText('Monitor disconnected', { exact: true }).waitFor()
  assert.deepEqual(errors, [], 'No browser errors')
  console.log('PASS: tab state, keyboard isolation, background traffic, cross-tab import results, per-item exports, push clear confirmation, and actionable empty states')
} catch (error) {
  if (page) console.error(await page.locator('.split:visible').innerText())
  throw error
} finally {
  await browser?.close()
  for (const ws of sockets.clients) ws.terminate()
  sockets.close()
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
}
