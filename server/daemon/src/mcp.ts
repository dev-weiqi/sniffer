import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createMcpRuntime, type McpRuntimeOptions } from './mcpCore.js'

export function createMcpServer(options: McpRuntimeOptions = {}) {
  const runtime = createMcpRuntime(options)
  const server = new Server({ name: 'sniffer', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.tools }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      const data = await runtime.call(req.params.name, req.params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    } catch (e) {
      const message = (e as Error).message
      const suffix = message.includes('fetch') ? `. Is the daemon running on ${runtime.base}? Start it with 'sniffer start'.` : ''
      return { content: [{ type: 'text' as const, text: `Error: ${message}${suffix}` }], isError: true }
    }
  })
  return server
}

export async function runMcp() {
  await createMcpServer().connect(new StdioServerTransport())
}
