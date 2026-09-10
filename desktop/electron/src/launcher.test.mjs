import {
  createDaemonEnv,
  daemonCommand,
  daemonCwd,
  daemonLaunchConfig,
  desktopUrl,
  normalizePort,
  isSnifferState,
  repoRootFrom,
  waitForExit,
  waitForDaemon,
} from './launcher.mjs'
import { rejects } from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const repoRoot = repoRootFrom(new URL('file:///repo/desktop/electron/src/main.mjs'))
assert(repoRoot.endsWith('/repo'), `repo root, got ${repoRoot}`)

assert(desktopUrl(9091) === 'http://127.0.0.1:9091', 'desktop URL uses loopback')
assert(normalizePort(undefined) === 9091, 'missing port uses default')
assert(normalizePort('9092') === 9092, 'valid string port')
assert(normalizePort(65535) === 65535, 'valid numeric port')
assert(normalizePort('80') === 9091, 'privileged port falls back')
assert(normalizePort('70000') === 9091, 'out of range port falls back')
assert(normalizePort('abc') === 9091, 'invalid port falls back')
assert(daemonCwd('/repo').endsWith('/repo/server/daemon'), 'daemon cwd points at server/daemon')

const command = daemonCommand('darwin')
assert(command.file === 'npm', `darwin command, got ${command.file}`)
assert(command.args.join(' ') === 'start', `daemon args, got ${command.args.join(' ')}`)
assert(daemonCommand('win32').file === 'npm.cmd', 'windows uses npm.cmd')

const env = createDaemonEnv({ PATH: '/bin', PORT: '1234' }, 9091)
assert(env.PATH === '/bin', 'preserves parent env')
assert(env.PORT === '9091', `overrides PORT, got ${env.PORT}`)
assert(env.SNIFFER_NO_OPEN === '1', 'daemon should not open an external browser')

const devLaunch = daemonLaunchConfig({
  repoRoot: '/repo',
  platform: 'darwin',
  isPackaged: false,
  resourcesPath: '/unused',
  electronExecPath: '/Applications/Sniffer.app/Contents/MacOS/Sniffer',
})
assert(devLaunch.file === 'npm', `dev launch file, got ${devLaunch.file}`)
assert(devLaunch.args.join(' ') === 'start', `dev launch args, got ${devLaunch.args.join(' ')}`)
assert(devLaunch.cwd.endsWith('/repo/server/daemon'), `dev launch cwd, got ${devLaunch.cwd}`)

const packagedLaunch = daemonLaunchConfig({
  repoRoot: '/repo',
  platform: 'darwin',
  isPackaged: true,
  resourcesPath: '/Applications/Sniffer.app/Contents/Resources',
  electronExecPath: '/Applications/Sniffer.app/Contents/MacOS/Sniffer',
})
assert(packagedLaunch.file === '/Applications/Sniffer.app/Contents/MacOS/Sniffer',
  `packaged launch file, got ${packagedLaunch.file}`)
assert(packagedLaunch.args[0] === '/Applications/Sniffer.app/Contents/Resources/daemon/bin/sniffer.js',
  `packaged launch script, got ${packagedLaunch.args[0]}`)
assert(packagedLaunch.cwd === '/Applications/Sniffer.app/Contents/Resources/daemon',
  `packaged launch cwd, got ${packagedLaunch.cwd}`)

const packagedEnv = createDaemonEnv({ PATH: '/bin' }, 9091, { isPackaged: true })
assert(packagedEnv.ELECTRON_RUN_AS_NODE === '1', 'packaged daemon should use Electron as Node')
assert(packagedEnv.SNIFFER_DESKTOP === '1', 'packaged daemon should report desktop mode')

assert(isSnifferState({ devices: [], entryCount: 0, mocksByDevice: {} }), 'recognizes daemon state')
assert(!isSnifferState({ ok: true }), 'rejects unrelated JSON')
assert(!isSnifferState(null), 'rejects null')

// an in-app update points the packaged launch at the userData install instead of the bundle
const updatedLaunch = daemonLaunchConfig({
  repoRoot: '/repo',
  platform: 'darwin',
  isPackaged: true,
  resourcesPath: '/Applications/Sniffer.app/Contents/Resources',
  electronExecPath: '/Applications/Sniffer.app/Contents/MacOS/Sniffer',
  daemonDir: '/userData/daemon/node_modules/@dev-weiqi/sniffer',
})
assert(updatedLaunch.cwd === '/userData/daemon/node_modules/@dev-weiqi/sniffer',
  `daemonDir overrides the bundled cwd, got ${updatedLaunch.cwd}`)
assert(updatedLaunch.args[0] === '/userData/daemon/node_modules/@dev-weiqi/sniffer/bin/sniffer.js',
  `daemonDir launch script, got ${updatedLaunch.args[0]}`)
const devIgnoresOverride = daemonLaunchConfig({ repoRoot: '/repo', platform: 'darwin', isPackaged: false, daemonDir: '/x' })
assert(devIgnoresOverride.cwd.endsWith('/repo/server/daemon'), 'dev launch ignores daemonDir')

// waitForExit resolves on the child's exit event, times out otherwise, and
// treats an already-exited (or absent) child as done
{
  const listeners = {}
  const child = { exitCode: null, signalCode: null, once: (event, fn) => { listeners[event] = fn } }
  const pending = waitForExit(child, { timeoutMs: 60_000, delayFn: () => new Promise(() => {}) })
  listeners.exit()
  assert(await pending === true, 'resolves true when the child exits')
}
{
  const child = { exitCode: null, signalCode: null, once: () => {} }
  assert(await waitForExit(child, { timeoutMs: 1, delayFn: () => Promise.resolve() }) === false, 'times out as false')
}
assert(await waitForExit({ exitCode: 0, signalCode: null, once: () => { throw new Error('must not subscribe') } }) === true,
  'already-exited child resolves immediately')
assert(await waitForExit(null) === true, 'no child is already stopped')

// An existing dev daemon can answer health checks after the update's child fails to bind.
{
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  let healthChecks = 0
  const pending = waitForDaemon({
    url: desktopUrl(9091), child, timeoutMs: 100, intervalMs: 1,
    fetchFn: async () => {
      healthChecks++
      return { ok: true, json: async () => ({ devices: [], entryCount: 0, mocksByDevice: {} }) }
    },
  })
  const rejected = rejects(pending, /exited/, 'another daemon must not make the update report a successful relaunch')
  child.exitCode = 1
  child.emit('exit', 1, null)
  await rejected
  assert(healthChecks === 0, 'wait for our child to listen before checking the port')
}
{
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null })
  let healthChecks = 0
  const pending = waitForDaemon({
    url: desktopUrl(9091), child, timeoutMs: 100, intervalMs: 1,
    fetchFn: async () => {
      healthChecks++
      return { ok: true, json: async () => ({ devices: [], entryCount: 0, mocksByDevice: {} }) }
    },
  })
  child.stdout.write('Sniffer dae')
  assert(healthChecks === 0, 'partial startup output is not readiness')
  child.stdout.write('mon: http://localhost:9091\n')
  await pending
  assert(healthChecks === 1, 'check health after our child starts listening')
  assert(child.listenerCount('exit') === 0 && child.stdout.listenerCount('data') === 0, 'startup listeners are cleaned up')

  await rejects(waitForDaemon({ url: desktopUrl(9091), child, timeoutMs: 1 }), /did not start listening/)
  const failedSpawn = waitForDaemon({ url: desktopUrl(9091), child, timeoutMs: 100 })
  const rejected = rejects(failedSpawn, /ENOENT/)
  child.emit('error', new Error('ENOENT'))
  await rejected
}

console.log('launcher.test: all assertions passed')
