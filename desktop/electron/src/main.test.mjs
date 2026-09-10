// Run with node --experimental-vm-modules src/main.test.mjs.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule } from 'node:vm'
import * as launcher from './launcher.mjs'
import * as updater from './updater.mjs'

const handlers = new Map()
const loads = []
const states = []
let boot
let starts = 0
let failingStart = 2
class Window extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    send: (_channel, state) => states.push(state),
    setWindowOpenHandler() {},
  })
  maximize() {}
  loadURL(url) { loads.push(url); return Promise.resolve() }
}
const replacements = {
  electron: {
    app: {
      isPackaged: true,
      getPath: () => '/test-user-data',
      whenReady: () => ({ then: callback => { boot = callback } }),
      on() {},
    },
    BrowserWindow: Window,
    dialog: {},
    ipcMain: { on() {}, handle: (name, callback) => handlers.set(name, callback) },
    shell: {},
  },
  'node:fs/promises': { readFile: async () => '{}', writeFile: async () => {} },
  './launcher.mjs': {
    ...launcher,
    bundledDaemonCwd: () => '/bundled',
    startDaemon: () => ({ attempt: ++starts }),
    stopDaemon() {},
    waitForExit: async () => true,
    waitForDaemon: async () => {
      if (starts === failingStart) throw new Error('new daemon failed to start')
    },
  },
  './updater.mjs': {
    ...updater,
    resolveDaemonDir: () => ({ dir: '/bundled' }),
    readVersion: dir => dir === '/bundled' ? '0.6.2' : '0.6.13',
    fetchLatestVersion: async () => '0.6.13',
    installUpdate: async () => '/installed',
  },
}
const main = new SourceTextModule(await readFile(new URL('./main.mjs', import.meta.url), 'utf8'), {
  initializeImportMeta: meta => { meta.url = new URL('./main.mjs', import.meta.url).href },
})
await main.link(async specifier => {
  const exports = replacements[specifier] ?? await import(specifier)
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  })
})
await main.evaluate()
await boot()
assert.equal(loads.length, 1)
assert.equal((await handlers.get('sniffer:check-update')()).available, true)

const result = await handlers.get('sniffer:apply-update')(null, '0.6.13')
assert.equal(result.ok, false)
assert.equal(starts, 3, 'the old daemon is restarted after the new version fails')
assert.equal(states.at(-1).phase, 'failed')
assert.equal(loads.length, 1, 'failure must keep the page and error instead of reloading into the same update offer')
assert.equal((await handlers.get('sniffer:check-update')()).current, '0.6.2')
failingStart = null
assert.equal((await handlers.get('sniffer:apply-update')(null, '0.6.13')).ok, true)
assert.equal(loads.length, 2, 'a successful retry reloads into the updated daemon')
assert.equal((await handlers.get('sniffer:check-update')()).available, false)
console.log('main.test: all assertions passed')
