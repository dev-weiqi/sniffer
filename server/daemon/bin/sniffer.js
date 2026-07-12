#!/usr/bin/env node
const cmd = process.argv[2] ?? 'start'
if (cmd !== 'start') {
  console.log('Usage: sniffer start        start the daemon + web UI (default port 9091)')
  console.log('       PORT=9092 sniffer start   use another port')
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1)
}
await import('../dist/server.js')
