// `npm start` entry: first-run setup if needed, then hand off to the daemon.
// Lives in a file (not an inline `node -e`) so npm's script banner stays one short line.
import { existsSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

if (!existsSync(`${root}server/ui/dist`) || !existsSync(`${root}server/daemon/node_modules`)) {
  console.log('First run — setting up…')
  execSync('npm run -s setup', { cwd: root, stdio: 'inherit' })
}

const daemon = spawn('npm', ['run', '-s', 'start'], {
  cwd: `${root}server/daemon`,
  stdio: 'inherit', // keep the TTY so the port-conflict prompt and auto-open still work
})
daemon.on('exit', code => process.exit(code ?? 0))
