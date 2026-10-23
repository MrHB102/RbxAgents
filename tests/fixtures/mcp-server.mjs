import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'RBX isolated integration fixture', version: '1.0.0' })
const events = []
let sequence = 0
server.registerTool('sequence_probe', { description: 'Prove that Studio actions do not overlap.', inputSchema: {} }, async () => {
  const current = ++sequence
  events.push(`start:${current}`)
  await new Promise(resolve => setTimeout(resolve, 40))
  events.push(`end:${current}`)
  return { content: [{ type: 'text', text: JSON.stringify(events) }] }
})
await server.connect(new StdioServerTransport())
