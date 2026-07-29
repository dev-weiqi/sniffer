import { join, delimiter } from 'node:path'
import {
  EXTRA_PATH_DIRS,
  PACKAGE_NAME,
  compareVersions,
  enrichedPath,
  fetchLatestVersion,
  findNpm,
  installRoot,
  installUpdate,
  installedDaemonDir,
  readVersion,
  resolveDaemonDir,
  stagingRoot,
  updateAvailable,
  verifyDaemonDir,
} from './updater.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function assertRejects(promise, part, message) {
  try {
    await promise
  } catch (error) {
    assert(String(error).includes(part), `${message}: got ${error}`)
    return
  }
  throw new Error(`${message}: expected rejection`)
}

// ---- compareVersions / updateAvailable ----
assert(compareVersions('0.5.3', '0.5.3') === 0, 'equal versions')
assert(compareVersions('0.5.4', '0.5.3') === 1, 'patch newer')
assert(compareVersions('0.5.3', '0.10.0') === -1, 'minor compares numerically, not lexically')
assert(compareVersions('1.0.0', '0.9.9') === 1, 'major wins')
assert(compareVersions(null, '0.1.0') === -1, 'null current loses')
assert(updateAvailable('0.5.3', '0.5.4'), 'newer latest → available')
assert(!updateAvailable('0.5.3', '0.5.3'), 'same → not available')
assert(!updateAvailable('0.5.3', null), 'no latest → not available')
assert(updateAvailable(null, '0.5.4'), 'unknown current → offer the update')

// ---- readVersion ----
assert(readVersion('/d', { read: () => '{"version":"1.2.3"}' }) === '1.2.3', 'reads version')
assert(readVersion('/d', { read: () => { throw new Error('ENOENT') } }) === null, 'missing → null')
assert(readVersion('/d', { read: () => 'not json' }) === null, 'garbage → null')

// ---- layout helpers ----
assert(installRoot('/u').endsWith(join('u', 'daemon')), 'install root under userData')
assert(stagingRoot('/u').endsWith(join('u', 'daemon-staging')), 'staging root under userData')
assert(
  installedDaemonDir('/u').endsWith(join('daemon', 'node_modules', '@dev-weiqi', 'sniffer')),
  'installed dir is the npm package dir',
)

// ---- verifyDaemonDir ----
const layout = files => path => files.some(f => path.endsWith(f))
const fullLayout = layout(['package.json', join('bin', 'sniffer.js'), join('dist', 'server.js'), join('ui-dist', 'index.html')])
assert(
  verifyDaemonDir('/d', '1.0.0', { exists: fullLayout, read: () => '{"version":"1.0.0"}' }),
  'complete layout with matching version verifies',
)
assert(
  !verifyDaemonDir('/d', '1.0.1', { exists: fullLayout, read: () => '{"version":"1.0.0"}' }),
  'version mismatch fails verification',
)
assert(
  !verifyDaemonDir('/d', null, { exists: layout(['package.json']), read: () => '{"version":"1.0.0"}' }),
  'partial extract fails verification',
)
assert(
  verifyDaemonDir('/d', null, { exists: fullLayout, read: () => '{"version":"1.0.0"}' }),
  'null expectedVersion only requires some version',
)

// ---- resolveDaemonDir ----
const versions = map => path => {
  for (const [prefix, v] of Object.entries(map)) {
    if (path.startsWith(prefix)) return `{"version":"${v}"}`
  }
  throw new Error('ENOENT')
}
{
  const r = resolveDaemonDir({ bundledDir: '/res/daemon', userDataDir: '/u', exists: () => false, read: versions({ '/res': '0.5.1' }) })
  assert(r.source === 'bundled' && r.dir === '/res/daemon' && r.version === '0.5.1', 'no install → bundled')
}
{
  const r = resolveDaemonDir({ bundledDir: '/res/daemon', userDataDir: '/u', exists: () => true, read: versions({ '/res': '0.5.1', '/u': '0.5.3' }) })
  assert(r.source === 'installed' && r.version === '0.5.3', 'newer install wins')
  assert(r.dir === installedDaemonDir('/u'), 'installed dir path')
}
{
  const r = resolveDaemonDir({ bundledDir: '/res/daemon', userDataDir: '/u', exists: () => true, read: versions({ '/res': '0.6.0', '/u': '0.5.3' }) })
  assert(r.source === 'bundled', 'older install never shadows a newer bundle')
}
{
  const r = resolveDaemonDir({ bundledDir: '/res/daemon', userDataDir: '/u', exists: () => true, read: versions({ '/res': '0.5.1', '/u': '0.5.1' }) })
  assert(r.source === 'bundled', 'equal versions prefer the bundle')
}
{
  // broken install (package.json readable but bin/dist/ui missing) → bundled
  const exists = path => !path.includes('sniffer.js')
  const r = resolveDaemonDir({ bundledDir: '/res/daemon', userDataDir: '/u', exists, read: versions({ '/res': '0.5.1', '/u': '0.9.9' }) })
  assert(r.source === 'bundled', 'incomplete install is ignored')
}

// ---- fetchLatestVersion ----
{
  const calls = []
  const ok = body => ({ ok: true, json: async () => body })
  const version = await fetchLatestVersion({ fetchFn: async url => { calls.push(url); return ok({ version: '9.9.9' }) } })
  assert(version === '9.9.9', 'returns registry version')
  assert(calls[0] === `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, `registry url, got ${calls[0]}`)
  await assertRejects(fetchLatestVersion({ fetchFn: async () => ({ ok: false, status: 500 }) }), '500', 'http error rejects')
  await assertRejects(fetchLatestVersion({ fetchFn: async () => ok({}) }), 'no usable version', 'missing version rejects')
  await assertRejects(fetchLatestVersion({ fetchFn: async () => ok({ version: '1.0.0-beta.1' }) }), 'no usable version', 'prerelease rejects')
}

// ---- enrichedPath / findNpm ----
{
  const path = enrichedPath(['/usr/bin', '/bin'].join(delimiter))
  for (const dir of EXTRA_PATH_DIRS) assert(path.split(delimiter).includes(dir), `enriched path has ${dir}`)
  assert(path.split(delimiter).filter(d => d === '/usr/bin').length === 1, 'no duplicate dirs')
  assert(enrichedPath('').split(delimiter)[0] === EXTRA_PATH_DIRS[0], 'empty parent PATH still yields probe dirs')
}
{
  const found = findNpm({ path: ['/nope', '/opt/homebrew/bin'].join(delimiter), platform: 'darwin', exists: p => p === join('/opt/homebrew/bin', 'npm') })
  assert(found === join('/opt/homebrew/bin', 'npm'), 'finds npm on the enriched path')
  assert(findNpm({ path: '/nope', platform: 'darwin', exists: () => false }) === null, 'missing npm → null')
  const win = findNpm({ path: 'C:\\npm', platform: 'win32', exists: p => p.endsWith('npm.cmd') })
  assert(win !== null && win.endsWith('npm.cmd'), 'windows probes npm.cmd')
}

// ---- installUpdate ----
function fakeFs(state) {
  return {
    exists: path => state.files.some(f => path.endsWith(f) || path.includes(f)),
    read: () => `{"version":"${state.version}"}`,
    rm: path => state.log.push(['rm', path]),
    rename: (from, to) => state.log.push(['rename', from, to]),
  }
}
{
  // happy path: staging cleared → npm install into staging → verify → swap → verify
  const state = { files: ['package.json', 'bin/sniffer.js', 'dist/server.js', 'ui-dist/index.html'], version: '0.5.4', log: [] }
  const runs = []
  const fs = fakeFs(state)
  const dir = await installUpdate({
    userDataDir: '/u', version: '0.5.4',
    env: { PATH: '/usr/bin' }, platform: 'darwin',
    run: async (file, args, opts) => { runs.push({ file, args, opts }) },
    ...fs,
    exists: p => p.endsWith('npm') || fs.exists(p),
  })
  assert(dir === installedDaemonDir('/u'), 'returns the final install dir')
  assert(runs.length === 1 && runs[0].file.endsWith('npm'), 'invokes npm once')
  const args = runs[0].args.join(' ')
  assert(args.includes(`${PACKAGE_NAME}@0.5.4`), `pins the exact version, got ${args}`)
  assert(args.includes(`--prefix ${stagingRoot('/u')}`), 'installs into staging, not the live root')
  assert(runs[0].opts.env.PATH.split(delimiter).includes('/opt/homebrew/bin'), 'npm runs with the enriched PATH')
  const rename = state.log.find(e => e[0] === 'rename')
  assert(rename && rename[1] === stagingRoot('/u') && rename[2] === installRoot('/u'), 'staging swaps into place')
  const lastRmBeforeRename = state.log.filter(e => e[0] === 'rm').map(e => e[1])
  assert(lastRmBeforeRename.includes(installRoot('/u')), 'old install is cleared before the swap')
}
await assertRejects(
  installUpdate({ userDataDir: '/u', version: '0.5.4', env: { PATH: '' }, platform: 'darwin', run: async () => {}, exists: () => false, read: () => '{}', rm: () => {}, rename: () => {} }),
  'npm not found', 'no npm anywhere → clear error',
)
{
  // incomplete download: verification fails before the swap, staging is discarded
  const state = { files: ['package.json'], version: '0.5.4', log: [] }
  const fs = fakeFs(state)
  // npm exists, but the staged package is partial
  fs.exists = path => path.endsWith('npm') || path.endsWith('package.json')
  await assertRejects(
    installUpdate({ userDataDir: '/u', version: '0.5.4', env: { PATH: '/usr/bin' }, platform: 'darwin', run: async () => {}, ...fakeFs(state), exists: fs.exists }),
    'incomplete', 'partial staging never swaps in',
  )
  assert(!state.log.some(e => e[0] === 'rename'), 'no rename on failed verification')
}
{
  // wrong version delivered (e.g. tag moved mid-flight) → refuse
  const state = { files: ['package.json', 'bin/sniffer.js', 'dist/server.js', 'ui-dist/index.html'], version: '0.5.3', log: [] }
  const fs = fakeFs(state)
  const exists = path => path.endsWith('npm') || fs.exists(path)
  await assertRejects(
    installUpdate({ userDataDir: '/u', version: '0.5.4', env: { PATH: '/usr/bin' }, platform: 'darwin', run: async () => {}, ...fs, exists }),
    'incomplete', 'version mismatch never swaps in',
  )
}

console.log('updater.test: all assertions passed')
