#!/usr/bin/env node
const cmd = process.argv[2] ?? 'start'
if (cmd === 'start') {
  await import('../dist/server.js')
} else if (cmd === 'mcp') {
  const { runMcp } = await import('../dist/mcp.js')
  await runMcp()
} else {
  console.log('Usage: sniffer start        start the daemon + web UI (default port 9091)')
  console.log('       PORT=9092 sniffer start   use another port')
  console.log('       sniffer mcp          run the MCP server (stdio) for AI tools')
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1)
}
