import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 9091

export function normalizePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return fallback
  return port
}

export function repoRootFrom(moduleUrl) {
  const file = fileURLToPath(moduleUrl)
  return resolve(dirname(file), '../../..')
}

export function desktopUrl(port) {
  return `http://127.0.0.1:${port}`
}

export function daemonCwd(repoRoot) {
  return join(repoRoot, 'server', 'daemon')
}

export function bundledDaemonCwd(resourcesPath) {
  return join(resourcesPath, 'daemon')
}

export function daemonCommand(platform = process.platform) {
  return {
    file: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['start'],
  }
}

export function daemonLaunchConfig({
  repoRoot,
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  electronExecPath = process.execPath,
  daemonDir = null,
}) {
  if (isPackaged) {
    // daemonDir: an in-app update installed under userData outranks the bundled snapshot
    const cwd = daemonDir ?? bundledDaemonCwd(resourcesPath)
    return {
      file: electronExecPath,
      args: [join(cwd, 'bin', 'sniffer.js')],
      cwd,
    }
  }

  const command = daemonCommand(platform)
  return {
    file: command.file,
    args: command.args,
    cwd: daemonCwd(repoRoot),
  }
}

export function createDaemonEnv(parentEnv, port, { isPackaged = false } = {}) {
  const env = {
    ...parentEnv,
    PORT: String(port),
    SNIFFER_NO_OPEN: '1',
  }
  if (isPackaged) env.ELECTRON_RUN_AS_NODE = '1'
  if (isPackaged) env.SNIFFER_DESKTOP = '1'
  return env
}

export function isSnifferState(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Array.isArray(value.devices) &&
      typeof value.entryCount === 'number' &&
      value.mocksByDevice &&
      typeof value.mocksByDevice === 'object',
  )
}

export function startDaemon({
  repoRoot,
  port,
  spawnFn = spawn,
  env = process.env,
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  electronExecPath = process.execPath,
  daemonDir = null,
}) {
  const command = daemonLaunchConfig({ repoRoot, platform, isPackaged, resourcesPath, electronExecPath, daemonDir })
  const child = spawnFn(command.file, command.args, {
    cwd: command.cwd,
    env: createDaemonEnv(env, port, { isPackaged }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', data => process.stdout.write(`[daemon] ${data}`))
  child.stderr?.on('data', data => process.stderr.write(`[daemon] ${data}`))
  return child
}

export async function waitForDaemon({ url, fetchFn = fetch, timeoutMs = 15000, intervalMs = 250 }) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchFn(`${url}/api/state`)
      if (response.ok && isSnifferState(await response.json())) return
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(`Sniffer daemon did not become ready at ${url}${lastError ? `: ${lastError}` : ''}`)
}

export function stopDaemon(child) {
  if (!child || child.killed) return
  child.kill()
}

/** Resolve once the child has really exited — restarting before then races it for the port. */
export function waitForExit(child, { timeoutMs = 5000, delayFn = delay } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    child.once('exit', () => done(true))
    delayFn(timeoutMs).then(() => done(false))
  })
}
