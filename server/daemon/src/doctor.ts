import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export type DoctorStatus = 'ok' | 'warn' | 'error' | 'skip'

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorStatus
  summary: string
  details?: string[]
}

export interface DoctorReport {
  generatedAt: number
  platform: string
  port: number
  bindHost: string
  checks: DoctorCheck[]
}

export interface AdbDevice {
  serial: string
  state: string
  description: string
}

type ExecFileFn = typeof execFile

interface DoctorOptions {
  port: number
  bindHost: string
  platform?: string
  nodeVersion?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  execFileFn?: ExecFileFn
}

interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export function parseAdbDevices(stdout: string): AdbDevice[] {
  return stdout
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [serial, state = '', ...rest] = line.split(/\s+/)
      return { serial, state, description: rest.join(' ') }
    })
    .filter(device => Boolean(device.serial))
}

export function buildDoctorPath(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  const paths = [
    env.PATH,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    env.ANDROID_HOME ? join(env.ANDROID_HOME, 'platform-tools') : undefined,
    env.ANDROID_SDK_ROOT ? join(env.ANDROID_SDK_ROOT, 'platform-tools') : undefined,
    join(homeDir, 'Library', 'Android', 'sdk', 'platform-tools'),
  ]
    .flatMap(value => (value ?? '').split(delimiter))
    .map(value => value.trim())
    .filter(Boolean)

  return [...new Set(paths)].join(delimiter)
}

export async function buildDoctorReport({
  port,
  bindHost,
  platform = process.platform,
  nodeVersion = process.version,
  env = process.env,
  homeDir = homedir(),
  execFileFn = execFile,
}: DoctorOptions): Promise<DoctorReport> {
  const commandEnv = { ...env, PATH: buildDoctorPath(env, homeDir) }
  const isDesktop = env.SNIFFER_DESKTOP === '1'
  const checks: DoctorCheck[] = [
    {
      id: 'daemon',
      label: 'Sniffer Daemon',
      status: 'ok',
      summary: `Listening on ${bindHost}:${port}`,
      details: [`UI URL: http://127.0.0.1:${port}`],
    },
    {
      id: 'node',
      label: 'Node.js',
      status: 'ok',
      summary: nodeVersion,
    },
  ]

  if (isDesktop) {
    checks.push({
      id: 'npm',
      label: 'npm',
      status: 'ok',
      summary: 'Not required for Sniffer Desktop',
      details: ['Sniffer Desktop runs the bundled daemon with Electron.'],
    })
  } else {
    const npm = await runCommand(execFileFn, npmCommand(platform), ['--version'], commandEnv)
    checks.push(npm.ok
      ? { id: 'npm', label: 'npm', status: 'ok', summary: npm.stdout.trim() }
      : {
          id: 'npm',
          label: 'npm',
          status: 'warn',
          summary: 'npm not found',
          details: ['Required for running Sniffer from a source checkout. A packaged desktop app should bundle what it needs.'],
        })
  }

  const adb = await runCommand(execFileFn, 'adb', ['version'], commandEnv)
  const adbAvailable = adb.ok
  checks.push(adbAvailable
    ? {
        id: 'adb',
        label: 'ADB',
        status: 'ok',
        summary: firstLine(adb.stdout),
        details: remainingLines(adb.stdout),
      }
    : {
        id: 'adb',
        label: 'ADB',
        status: 'warn',
        summary: 'ADB not found',
        details: ['Android devices and emulators need adb for localhost port forwarding.'],
      })

  if (!adbAvailable) {
    checks.push({
      id: 'devices',
      label: 'Android Devices',
      status: 'skip',
      summary: 'Skipped because ADB is unavailable',
    })
    checks.push({
      id: 'reverse',
      label: 'ADB Reverse',
      status: 'skip',
      summary: 'Skipped because ADB is unavailable',
    })
    return { generatedAt: Date.now(), platform, port, bindHost, checks }
  }

  const devicesCommand = await runCommand(execFileFn, 'adb', ['devices', '-l'], commandEnv)
  const devices = devicesCommand.ok ? parseAdbDevices(devicesCommand.stdout) : []
  const connected = devices.filter(device => device.state === 'device')
  const needsAuthorization = devices.filter(device => device.state !== 'device')

  checks.push(deviceCheck(devices, connected, needsAuthorization, devicesCommand))
  checks.push(await reverseCheck(execFileFn, connected, port, commandEnv))

  return { generatedAt: Date.now(), platform, port, bindHost, checks }
}

function npmCommand(platform: string): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? '(no output)'
}

function remainingLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(1)
}

function deviceCheck(
  devices: AdbDevice[],
  connected: AdbDevice[],
  needsAuthorization: AdbDevice[],
  command: CommandResult,
): DoctorCheck {
  if (!command.ok) {
    return {
      id: 'devices',
      label: 'Android Devices',
      status: 'warn',
      summary: 'Unable to list Android devices',
      details: [command.error ?? command.stderr].filter(Boolean),
    }
  }
  if (devices.length === 0) {
    return {
      id: 'devices',
      label: 'Android Devices',
      status: 'warn',
      summary: 'No Android devices or emulators connected',
    }
  }
  const details = devices.map(device =>
    `${device.serial}: ${device.state}${device.description ? ` ${device.description}` : ''}`)
  if (needsAuthorization.length > 0) {
    return {
      id: 'devices',
      label: 'Android Devices',
      status: 'warn',
      summary: `${connected.length} connected, ${needsAuthorization.length} needs authorization`,
      details,
    }
  }
  return {
    id: 'devices',
    label: 'Android Devices',
    status: 'ok',
    summary: `${connected.length} connected`,
    details,
  }
}

async function reverseCheck(
  execFileFn: ExecFileFn,
  connected: AdbDevice[],
  port: number,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  if (connected.length === 0) {
    return {
      id: 'reverse',
      label: 'ADB Reverse',
      status: 'skip',
      summary: 'No connected Android devices',
    }
  }

  const expected = `tcp:${port} tcp:${port}`
  const details: string[] = []
  let missing = 0

  for (const device of connected) {
    const result = await runCommand(execFileFn, 'adb', ['-s', device.serial, 'reverse', '--list'], env)
    if (!result.ok) {
      missing += 1
      details.push(`${device.serial}: unable to inspect reverse list`)
      continue
    }
    if (result.stdout.includes(expected)) {
      details.push(`${device.serial}: ${expected}`)
    } else {
      missing += 1
      details.push(`${device.serial}: missing ${expected}`)
    }
  }

  return missing === 0
    ? { id: 'reverse', label: 'ADB Reverse', status: 'ok', summary: `Port ${port} is forwarded`, details }
    : { id: 'reverse', label: 'ADB Reverse', status: 'warn', summary: `${missing} device(s) missing reverse for port ${port}`, details }
}

function runCommand(
  execFileFn: ExecFileFn,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise(resolve => {
    execFileFn(file, args, { timeout: 3000, env }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error ? String(error.message || error) : undefined,
      })
    })
  })
}
