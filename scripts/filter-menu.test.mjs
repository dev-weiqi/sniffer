// Run: node scripts/filter-menu.test.mjs (requires Chrome).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'

const uiRequire = createRequire(new URL('../server/ui/package.json', import.meta.url))
const daemonRequire = createRequire(new URL('../server/daemon/package.json', import.meta.url))
const { createServer } = await import(uiRequire.resolve('vite'))
const { default: react } = await import(uiRequire.resolve('@vitejs/plugin-react'))
const { chromium } = daemonRequire('playwright-core')
const root = fileURLToPath(new URL('../server/ui', import.meta.url))
const dir = await mkdtemp(join(root, '.filter-test-'))
let server, browser
try {
  await writeFile(join(dir, 'index.html'), '<div id="root"></div><script type="module" src="./test.tsx"></script>')
  await writeFile(join(dir, 'test.tsx'), `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { FilterMenu } from '../src/FilterMenu'
    import '../src/styles.css'
    function Test() {
      const [filter, setFilter] = useState({ mode: 'exclude', items: [] })
      return <><button>Outside</button><div id="list" style={{height: 250, overflow: 'auto'}}>
        <table className="grid"><thead><tr><th><FilterMenu filter={filter}
          onChange={setFilter} placeholder="URL…" /></th></tr></thead>
          <tbody>{Array.from({length: filter.items.length ? 1 : 100}, (_, i) =>
            <tr key={i}><td>example.com/{i}</td></tr>)}</tbody>
        </table></div></>
    }
    createRoot(document.getElementById('root')).render(<Test />)
  `)
  server = await createServer({ configFile: false, root, plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(3000)
  for (const method of ['click', 'Enter']) {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${basename(dir)}/index.html`)
    await page.locator('#list').evaluate(el => { el.scrollTop = 500 })
    await page.getByTitle('Filter this column').click()
    await page.getByPlaceholder('URL…').fill('example.com/*')
    if (method === 'click') await page.getByTitle('Add filter value').click()
    else await page.getByPlaceholder('URL…').press('Enter')
    await page.waitForFunction(() => document.querySelector('#list').scrollTop === 0)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert(await page.locator('.filter-pop').isVisible(), `${method}: panel stays open after filtering shrinks the list`)
    assert(await page.getByPlaceholder('URL…').evaluate(el => el === document.activeElement), `${method}: input keeps focus`)
    assert.equal(await page.getByPlaceholder('URL…').inputValue(), '')
    await page.getByRole('button', { name: 'Outside', exact: true }).click()
    assert.equal(await page.locator('.filter-pop').count(), 0, 'outside click still closes panel')
  }
  console.log('filter-menu.test: all assertions passed')
} finally {
  await browser?.close()
  await server?.close()
  await rm(dir, { recursive: true, force: true })
}
