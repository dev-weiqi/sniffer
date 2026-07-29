import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PACKAGE_NAME = '@dev-weiqi/sniffer'
export const REGISTRY = 'https://registry.npmjs.org'

/** Release-only x.y.z comparison — that's all we ever publish, and `latest` is never a prerelease. */
export function compareVersions(a, b) {
  const parts = v => String(v ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const [l, r] = [x[i] ?? 0, y[i] ?? 0]
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

export function readVersion(dir, { read = readFileSync } = {}) {
  try {
    return JSON.parse(read(join(dir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** npm --prefix roots; installs land in <root>/node_modules/@dev-weiqi/sniffer */
export function installRoot(userDataDir) {
  return join(userDataDir, 'daemon')
}

export function stagingRoot(userDataDir) {
  return join(userDataDir, 'daemon-staging')
}

export function installedDaemonDir(userDataDir) {
  return join(installRoot(userDataDir), 'node_modules', ...PACKAGE_NAME.split('/'))
}

/** Everything the packaged daemon needs at runtime; a partial extract must never be adopted. */
const REQUIRED_FILES = ['package.json', join('bin', 'sniffer.js'), join('dist', 'server.js'), join('ui-dist', 'index.html')]

export function verifyDaemonDir(dir, expectedVersion, { exists = existsSync, read = readFileSync } = {}) {
  if (!REQUIRED_FILES.every(f => exists(join(dir, f)))) return false
  const version = readVersion(dir, { read })
  return Boolean(version) && (!expectedVersion || version === expectedVersion)
}

/**
 * The app ships a daemon snapshot in Resources; in-app updates install newer ones under userData.
 * Run whichever is newer and intact — a broken or older install can never shadow the bundle.
 */
export function resolveDaemonDir({ bundledDir, userDataDir, exists = existsSync, read = readFileSync }) {
  const bundled = { dir: bundledDir, version: readVersion(bundledDir, { read }), source: 'bundled' }
  const dir = installedDaemonDir(userDataDir)
  if (!verifyDaemonDir(dir, null, { exists, read })) return bundled
  const version = readVersion(dir, { read })
  if (compareVersions(version, bundled.version) <= 0) return bundled
  return { dir, version, source: 'installed' }
}

export async function fetchLatestVersion({ fetchFn = fetch } = {}) {
  const response = await fetchFn(`${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}/latest`)
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
  const version = (await response.json())?.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('npm registry returned no usable version')
  }
  return version
}

export function updateAvailable(current, latest) {
  return Boolean(latest) && compareVersions(latest, current) > 0
}

/**
 * A packaged app launched from Finder gets a minimal PATH (no /usr/local/bin, no homebrew),
 * so `npm` usually isn't findable. Probe an enriched PATH and hand both back to the spawn.
 */
export const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

export function enrichedPath(parentPath = '', { extraDirs = EXTRA_PATH_DIRS } = {}) {
  const dirs = parentPath ? parentPath.split(delimiter) : []
  for (const dir of extraDirs) if (!dirs.includes(dir)) dirs.push(dir)
  return dirs.join(delimiter)
}

export function findNpm({ path = '', platform = process.platform, exists = existsSync } = {}) {
  const name = platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const dir of path.split(delimiter)) {
    if (dir && exists(join(dir, name))) return join(dir, name)
  }
  return null
}

/**
 * Install into a staging root, verify the layout is complete and the version is the one we asked
 * for, then swap it into place. A crash mid-install leaves only staging debris, never a broken
 * install that resolveDaemonDir could adopt.
 */
export async function installUpdate({
  userDataDir,
  version,
  env = process.env,
  platform = process.platform,
  run = execFileAsync,
  exists = existsSync,
  read = readFileSync,
  rm = rmSync,
  rename = renameSync,
}) {
  const path = enrichedPath(env.PATH ?? '')
  const npm = findNpm({ path, platform, exists })
  if (!npm) throw new Error('npm not found — install Node.js to enable in-app updates')

  const staging = stagingRoot(userDataDir)
  rm(staging, { recursive: true, force: true })
  await run(npm, [
    'install', `${PACKAGE_NAME}@${version}`,
    '--prefix', staging,
    '--omit=dev', '--no-audit', '--no-fund',
  ], { env: { ...env, PATH: path } })

  const stagedDir = join(staging, 'node_modules', ...PACKAGE_NAME.split('/'))
  if (!verifyDaemonDir(stagedDir, version, { exists, read })) {
    rm(staging, { recursive: true, force: true })
    throw new Error(`downloaded ${version} is incomplete`)
  }

  const root = installRoot(userDataDir)
  rm(root, { recursive: true, force: true })
  rename(staging, root)

  const dir = installedDaemonDir(userDataDir)
  if (!verifyDaemonDir(dir, version, { exists, read })) {
    throw new Error(`install of ${version} did not survive the swap`)
  }
  return dir
}
