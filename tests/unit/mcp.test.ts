import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { McpManager } from '../../src/main/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

it('waits past both old Blender limits, preserves cancellation, and does not replay mutations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-mcp-long-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const manager = new McpManager(store)
  const client = new Client({ name: 'test', version: '1' })
  const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } })
  const handler = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 181_000))
    return { content: [{ type: 'text', text: 'model created' }] }
  })
  server.setRequestHandler(CallToolRequestSchema, handler)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  ;(manager as any).clients.set('blender', client)
  vi.useFakeTimers()
  try {
    const result = manager.call('blender', 'execute_blender_code', { code: 'create_model()' })
    await vi.advanceTimersByTimeAsync(181_001)
    expect(await result).toMatchObject({ content: [{ text: 'model created' }] })
    expect(handler).toHaveBeenCalledOnce()
    const controller = new AbortController()
    const cancelled = manager.call('blender', 'execute_blender_code', {}, controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('Stop Blender')
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('Stop Blender'))
    await rejected
    expect(handler).toHaveBeenCalledTimes(2)
    const expired = manager.call('blender', 'execute_blender_code', {}, undefined, undefined, 10)
    const timeout = expect(expired).rejects.toThrow('Do not repeat creation commands')
    await vi.advanceTimersByTimeAsync(11)
    await timeout
    expect(handler).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
    await manager.close(); await server.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('cancels a queued waiter immediately without letting later calls bypass an active action', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-mcp-cancel-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const manager = new McpManager(store)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const callTool = vi.fn().mockImplementationOnce(() => hold).mockResolvedValue({ content: [] })
  // Hold the first actual dispatch to reproduce contention deterministically.
  ;(manager as any).clients.set('fixture', { callTool, close: async () => {} })
  try {
    const first = manager.call('fixture', 'first', {})
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const cancelled = manager.call('fixture', 'cancelled', {}, controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('Stop queued call')
    controller.abort(new Error('Stop queued call'))
    await rejected
    const last = manager.call('fixture', 'last', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(callTool).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, last])
    expect(callTool.mock.calls.map(c => c[0].name)).toEqual(['first', 'last'])
  } finally { release(); rmSync(directory, { recursive: true, force: true }) }
})

it('connects to a real stdio MCP process and serializes overlapping agent requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-mcp-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const manager = new McpManager(store)
  store.state.servers.push({ id: 'fixture', name: 'Isolated test bridge', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/mcp-server.mjs')], env: { MCP_FIXTURE_STDERR: '1' }, url: '', installed: false, pluginDirectory: '', status: 'disconnected', tools: [] })
  try {
    await manager.connect('fixture')
    expect(store.state.servers.find(s => s.id === 'fixture')?.tools.map(t => t.name)).toEqual(['sequence_probe'])
    const result = await Promise.all([manager.call('fixture', 'sequence_probe', {}), manager.call('fixture', 'sequence_probe', {})])
    expect((result[1] as any).content[0].text).toBe('["start:1","end:1","start:2","end:2"]')
    const inFlight = manager.call('fixture', 'sequence_probe', {})
    const queued = manager.call('fixture', 'sequence_probe', {}, undefined, () => { throw new Error('Access was revoked while queued.') })
    const blocked = expect(queued).rejects.toThrow('Access was revoked')
    await inFlight
    await blocked
    await manager.disconnect('fixture')
    expect(store.state.servers.find(s => s.id === 'fixture')?.status).toBe('disconnected')
  } finally { await manager.close(); rmSync(directory, { recursive: true, force: true }) }
})
