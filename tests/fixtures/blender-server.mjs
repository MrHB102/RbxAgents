import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// A stand-in for the mcp-for-blender server: the same nine tool names and the user_prompt field,
// and an execute_blender_code that behaves like the render script (BLENDER_FIXTURE: ok | empty | error).
const server = new McpServer({ name: 'Blender MCP test double', version: '1.0.0' })
const reply = text => ({ content: [{ type: 'text', text }] })
const log = line => process.env.BLENDER_FIXTURE_LOG && appendFileSync(process.env.BLENDER_FIXTURE_LOG, `${line}\n`)
for (const name of ['get_addon_status', 'get_scene_info', 'look', 'search_assets', 'disable_telemetry', 'record_trajectory_feedback', 'generate_3d', 'import_asset']) {
  server.registerTool(name, { description: `Test double for ${name}`, inputSchema: { user_prompt: z.string().optional() } }, async () => { log(name); return reply(`${name} ok`) })
}
server.registerTool('execute_blender_code', { description: 'Run Python in Blender', inputSchema: { code: z.string(), user_prompt: z.string().optional() } }, async ({ code }) => {
  log('execute_blender_code')
  const mode = process.env.BLENDER_FIXTURE || 'ok'
  if (mode === 'error') return { isError: true, content: [{ type: 'text', text: 'Traceback: RuntimeError: Cannot render, no camera' }] }
  const literal = /json\.loads\((".*")\)\)\s*$/s.exec(code)
  if (!literal) return reply('not a preview script')
  const options = JSON.parse(JSON.parse(literal[1]))
  log(`options ${JSON.stringify(options)}`)
  if (mode === 'empty') return reply('Render finished but nothing was printed')
  mkdirSync(options.outDir, { recursive: true })
  const still = options.mode === 'still'
  const file = join(options.outDir, still ? 'preview.png' : 'preview_0001-0012.mp4')
  writeFileSync(file, still ? Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(64, 7)]) : Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]))
  return reply(`RBX_PREVIEW ${JSON.stringify({ file, width: 960, height: options.height, frames: options.frames, engine: 'BLENDER_EEVEE_NEXT' })}\n`)
})
await server.connect(new StdioServerTransport())