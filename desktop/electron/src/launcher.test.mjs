import {
  createDaemonEnv,
  daemonCommand,
  daemonCwd,
  daemonLaunchConfig,
  desktopUrl,
  normalizePort,
  isSnifferState,
  repoRootFrom,
} from './launcher.mjs'

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

console.log('launcher.test: all assertions passed')
