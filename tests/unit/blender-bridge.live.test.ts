import { expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpManager } from '../../src/main/mcp'
import { Store } from '../../src/main/store'
import { BLENDER_PACKAGE } from '../../src/shared/defaults'

// Opt-in: runs the pinned Python MCP server against an isolated socket, never the user's Blender.
it.skipIf(process.env.RBX_LIVE_BLENDER_MCP !== '1')('receives a 185-second Blender response through the real Python bridge', async () => {
  let executions = 0
  const addon = createServer(socket => {
    let input = ''
    socket.on('data', chunk => {
      input += chunk.toString()
      let command: { type: string }
      try { command = JSON.parse(input) } catch { return }
      input = ''
      const result = command.type === 'execute_code' ? { result: 'long model completed' } : { version: '2.2.4', protocol_version: 1 }
      const respond = () => { if (!socket.destroyed) socket.write(JSON.stringify({ status: 'success', result })) }
      if (command.type === 'execute_code') { executions++; setTimeout(respond, 185_000).unref() }
      else respond()
    })
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => addon.listen(0, '127.0.0.1', resolve))
  const directory = mkdtempSync(join(tmpdir(), 'rbx-blender-wait-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const bridge = store.state.servers.find(s => s.id === 'blender')!
  bridge.args = [BLENDER_PACKAGE, '--host', '127.0.0.1', '--port', String((addon.address() as { port: number }).port)]
  const manager = new McpManager(store)
  try {
    const result = await manager.call('blender', 'execute_blender_code', { code: 'print("isolated test")' })
    expect(JSON.stringify(result)).toContain('long model completed')
    expect(executions).toBe(1)
    expect(bridge.status).toBe('connected')
  } finally {
    await manager.close()
    addon.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 240_000)
