import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(electronRoot, '../..')
const daemonRoot = join(repoRoot, 'server', 'daemon')
const uiRoot = join(repoRoot, 'server', 'ui')
const out = join(electronRoot, 'build', 'daemon')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const file of ['package.json', 'package-lock.json']) {
  cpSync(join(daemonRoot, file), join(out, file))
}

for (const dir of ['bin', 'dist']) {
  cpSync(join(daemonRoot, dir), join(out, dir), { recursive: true })
}

cpSync(join(uiRoot, 'dist'), join(out, 'ui-dist'), { recursive: true })

if (!existsSync(join(out, 'dist', 'server.js'))) {
  throw new Error('Missing daemon build output: dist/server.js')
}
if (!existsSync(join(out, 'ui-dist', 'index.html'))) {
  throw new Error('Missing UI build output: ui-dist/index.html')
}

execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
  cwd: out,
  stdio: 'inherit',
})
