import { delimiter } from 'node:path'
import { buildDoctorPath, buildDoctorReport, parseAdbDevices } from './doctor.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function fakeExecFile(results: Record<string, { stdout?: string; stderr?: string } | Error>) {
  const calls: { file: string; args: readonly string[]; options: any }[] = []
  const fn = (file: string, args: readonly string[], options: unknown, callback?: Function) => {
    calls.push({ file, args, options })
    const cb = typeof options === 'function' ? options : callback
    const key = [file, ...args].join(' ')
    const result = results[key] ?? new Error(`unexpected command: ${key}`)
    queueMicrotask(() => {
      if (result instanceof Error) cb?.(result, '', '')
      else cb?.(null, result.stdout ?? '', result.stderr ?? '')
    })
    return { kill() {} }
  }
  return Object.assign(fn, { calls }) as typeof import('node:child_process').execFile & { calls: typeof calls }
}

const devices = parseAdbDevices(`List of devices attached
emulator-5554	device product:sdk_gphone64_arm64 model:Pixel_9_Pro transport_id:1
ABC123	unauthorized usb:1-1

`)
assert(devices.length === 2, `device count, got ${devices.length}`)
assert(devices[0].serial === 'emulator-5554', `serial, got ${devices[0].serial}`)
assert(devices[0].state === 'device', `state, got ${devices[0].state}`)
assert(devices[1].state === 'unauthorized', `unauthorized state, got ${devices[1].state}`)

const doctorPath = buildDoctorPath({
  PATH: `/usr/bin${delimiter}/bin`,
  ANDROID_HOME: '/android-sdk',
}, '/Users/tester')
assert(doctorPath.split(delimiter).includes('/opt/homebrew/bin'), 'doctor path includes Homebrew bin')
assert(doctorPath.split(delimiter).includes('/android-sdk/platform-tools'), 'doctor path includes ANDROID_HOME platform-tools')
assert(doctorPath.split(delimiter).includes('/Users/tester/Library/Android/sdk/platform-tools'),
  'doctor path includes default macOS Android SDK platform-tools')

const exec = fakeExecFile({
  'npm --version': { stdout: '10.9.0\n' },
  'adb version': { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.0\n' },
  'adb devices -l': { stdout: 'List of devices attached\n' },
})
await buildDoctorReport({
  port: 9091,
  bindHost: '127.0.0.1',
  env: { PATH: '/usr/bin', ANDROID_HOME: '/android-sdk' },
  homeDir: '/Users/tester',
  execFileFn: exec as never,
})
const adbVersionCall = exec.calls.find(call => call.file === 'adb' && call.args[0] === 'version')
assert(adbVersionCall, 'expected adb version call')
assert(adbVersionCall.options.env.PATH.includes('/android-sdk/platform-tools'),
  `adb PATH should include Android SDK, got ${adbVersionCall.options.env.PATH}`)

const report = await buildDoctorReport({
  port: 9091,
  bindHost: '127.0.0.1',
  platform: 'darwin',
  nodeVersion: 'v25.0.0',
  execFileFn: fakeExecFile({
    'npm --version': { stdout: '10.9.0\n' },
    'adb version': { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.0\n' },
    'adb devices -l': {
      stdout: `List of devices attached
emulator-5554	device product:sdk_gphone64_arm64 model:Pixel_9_Pro transport_id:1
ABC123	unauthorized usb:1-1
`,
    },
    'adb -s emulator-5554 reverse --list': { stdout: 'emulator-5554 tcp:9091 tcp:9091\n' },
  }) as never,
})

const byId = Object.fromEntries(report.checks.map(check => [check.id, check]))
assert(byId.daemon.status === 'ok', `daemon status, got ${byId.daemon.status}`)
assert(byId.node.summary.includes('v25.0.0'), `node summary, got ${byId.node.summary}`)
assert(byId.npm.status === 'ok' && byId.npm.summary.includes('10.9.0'), `npm summary, got ${byId.npm.summary}`)
assert(byId.adb.status === 'ok', `adb status, got ${byId.adb.status}`)
assert(byId.devices.status === 'warn', `devices status, got ${byId.devices.status}`)
assert(byId.devices.summary === '1 connected, 1 needs authorization', `devices summary, got ${byId.devices.summary}`)
assert(byId.reverse.status === 'ok', `reverse status, got ${byId.reverse.status}`)

const missingAdb = await buildDoctorReport({
  port: 9091,
  bindHost: '127.0.0.1',
  platform: 'darwin',
  nodeVersion: 'v25.0.0',
  execFileFn: fakeExecFile({
    'npm --version': { stdout: '10.9.0\n' },
    'adb version': Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }),
    'adb devices -l': Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }),
  }) as never,
})
const missingById = Object.fromEntries(missingAdb.checks.map(check => [check.id, check]))
assert(missingById.adb.status === 'warn', `missing adb status, got ${missingById.adb.status}`)
assert(missingById.adb.summary === 'ADB not found', `missing adb summary, got ${missingById.adb.summary}`)
assert(missingById.devices.status === 'skip', `devices should skip without adb, got ${missingById.devices.status}`)
assert(missingById.reverse.status === 'skip', `reverse should skip without adb, got ${missingById.reverse.status}`)

const desktopExec = fakeExecFile({
  'adb version': { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.0\n' },
  'adb devices -l': { stdout: 'List of devices attached\n' },
})
const desktopReport = await buildDoctorReport({
  port: 9091,
  bindHost: '127.0.0.1',
  env: { PATH: '/usr/bin', SNIFFER_DESKTOP: '1' },
  execFileFn: desktopExec as never,
})
const desktopById = Object.fromEntries(desktopReport.checks.map(check => [check.id, check]))
assert(desktopById.npm.status === 'ok', `desktop npm status, got ${desktopById.npm.status}`)
assert(desktopById.npm.summary === 'Not required for Sniffer Desktop',
  `desktop npm summary, got ${desktopById.npm.summary}`)
assert(!desktopExec.calls.some(call => call.file === 'npm'), 'desktop doctor should not run npm')

console.log('doctor.test: all assertions passed')
