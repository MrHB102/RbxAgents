import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { McpManager } from '../../src/main/mcp'

it('connects to a real stdio MCP process and serializes overlapping agent requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-mcp-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const manager = new McpManager(store)
  store.state.servers.push({ id: 'fixture', name: 'Isolated test bridge', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/mcp-server.mjs')], env: {}, url: '', installed: false, pluginDirectory: '', status: 'disconnected', tools: [] })
  try {
    await manager.connect('fixture')
    expect(store.state.servers.find(s => s.id === 'fixture')?.tools.map(t => t.name)).toEqual(['sequence_probe'])
    const result = await Promise.all([manager.call('fixture', 'sequence_probe', {}), manager.call('fixture', 'sequence_probe', {})])
    expect((result[1] as any).content[0].text).toBe('["start:1","end:1","start:2","end:2"]')
    await manager.disconnect('fixture')
    expect(store.state.servers.find(s => s.id === 'fixture')?.status).toBe('disconnected')
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }) }
})
