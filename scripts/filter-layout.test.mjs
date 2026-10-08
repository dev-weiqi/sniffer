// Run: node scripts/filter-layout.test.mjs (requires Chrome).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire(new URL('../server/daemon/package.json', import.meta.url))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const css = await readFile(new URL('../server/ui/src/styles.css', import.meta.url), 'utf8')
  await page.setContent(`<style>${css}</style>
    <table class="grid"><thead><tr><th>
      <span class="table-header-control"><span class="filter-anchor">
        <div class="filter-pop"><div class="filter-item">
          <label class="toggle"><input type="checkbox" checked /></label>
          <span class="mono filter-value">https://example.com/${'long_filename_'.repeat(20)}.png</span>
          <button class="filter-round filter-remove">×</button>
        </div></div>
      </span></span>
    </th></tr></thead></table>`)
  const layout = await page.locator('.filter-value').evaluate(value => {
    const popover = value.closest('.filter-pop')
    return {
      textWidth: value.scrollWidth,
      availableWidth: value.clientWidth,
      height: value.clientHeight,
      lineHeight: parseFloat(getComputedStyle(value).lineHeight),
      removeRight: popover.querySelector('button').getBoundingClientRect().right,
      popoverRight: popover.getBoundingClientRect().right,
    }
  })
  assert(layout.textWidth <= layout.availableWidth, `filter text overflows: ${JSON.stringify(layout)}`)
  assert(layout.height > layout.lineHeight, 'long URL wraps onto multiple lines')
  assert(layout.removeRight <= layout.popoverRight, 'remove button stays inside the popover')
  console.log('filter-layout.test: all assertions passed')
} finally {
  await browser.close()
}
