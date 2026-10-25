import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { AgentRuntime } from '../../src/main/runtime'
import type { Providers } from '../../src/main/providers'
import type { McpManager } from '../../src/main/mcp'

function fixture(readOnly = false, unrestricted = false) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-runtime-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const agent = store.state.agents.find(a => a.id === 'architect')!
  agent.providerId = 'local'; agent.model = 'test-model'; agent.permission = readOnly ? 'read-only' : unrestricted ? 'unrestricted' : 'ask'
  store.state.providers.push({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: ['test-model'], hasKey: false, status: 'connected' })
  const server = store.state.servers[0]
  server.status = 'connected'; server.tools = [{ name: 'execute_luau', description: 'Mutate Studio', inputSchema: { type: 'object' }, readOnly: false }]
  store.state.sessions.push({ id: 'session', agentId: agent.id, title: 'Task', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', tokens: 0 })
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'Change verified' }] }))
  let counter = 0
  const turn = vi.fn(async (_provider, _model, _turns, tools) => {
    if (counter++ === 0) {
      const tool = tools.find((t: any) => t.name === 'call_tool')
      return { text: 'I will make this change.', tokens: 1, calls: tool ? [{ id: 'call', name: tool.name, arguments: '{"server_id":"roblox","name":"execute_luau","arguments":{"code":"print(1)"}}' }] : [] }
    }
    return { text: 'Finished.', tokens: 1, calls: [] }
  })
  const runtime = new AgentRuntime(store, { turn } as unknown as Providers, { connect: vi.fn(async () => {}), call } as unknown as McpManager)
  const cleanup = () => { runtime.close(); rmSync(directory, { recursive: true, force: true }) }
  return { store, runtime, call, turn, cleanup }
}

describe('agent tool permissions', () => {
  it('does not execute a mutation until explicitly approved', async () => {
    const { store, runtime, call, cleanup } = fixture()
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(store.approvals).toHaveLength(1))
      expect(call).not.toHaveBeenCalled()
      runtime.decide(store.approvals[0].id, true)
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).toHaveBeenCalledOnce()
      expect(store.state.sessions[0].status).toBe('idle')
      expect(store.approvals).toHaveLength(0)
    } finally { cleanup() }
  })
  it('returns a denial to the model and never executes the denied tool', async () => {
    const { store, runtime, call, cleanup } = fixture()
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(store.approvals).toHaveLength(1))
      runtime.decide(store.approvals[0].id, false)
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).not.toHaveBeenCalled()
      expect(store.state.sessions[0].messages.find(m => m.role === 'tool')?.content).toContain('user denied')
    } finally { cleanup() }
  })
  it('cancels a pending approval when stopped', async () => {
    const { store, runtime, call, cleanup } = fixture()
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(store.approvals).toHaveLength(1))
      runtime.stop('session')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).not.toHaveBeenCalled()
      expect(store.approvals).toHaveLength(0)
      expect(store.state.sessions[0].messages.at(-1)?.content).toContain('stopped by you')
    } finally { cleanup() }
  })
  it('blocks mutation through the generic tool gateway for read-only agents', async () => {
    const { store, runtime, call, turn, cleanup } = fixture(true)
    try {
      await runtime.send('session', 'Inspect the project.')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).not.toHaveBeenCalled()
      expect(turn.mock.calls[0][3].some((tool: any) => tool.name.includes('execute_luau'))).toBe(false)
      expect(store.state.sessions[0].messages.find(m => m.role === 'tool')?.content).toContain('only has read access')
      expect(store.approvals).toHaveLength(0)
    } finally { cleanup() }
  })
  it('executes mutations without approval in Unrestricted access mode', async () => {
    const { store, runtime, call, cleanup } = fixture(false, true)
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).toHaveBeenCalledOnce()
      expect(call.mock.calls[0].slice(0, 3)).toEqual(['roblox', 'execute_luau', { code: 'print(1)' }])
      expect(store.approvals).toHaveLength(0)
      expect(store.state.sessions[0].status).toBe('idle')
    } finally { cleanup() }
  })
  it('continues a pending tool call when the user switches to Unrestricted access', async () => {
    const { store, runtime, call, cleanup } = fixture()
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(store.approvals).toHaveLength(1))
      runtime.setAccess('architect', 'unrestricted')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).toHaveBeenCalledOnce()
      expect(store.approvals).toHaveLength(0)
    } finally { cleanup() }
  })
  it('sends a small tool gateway instead of the full catalog and separates last-run usage', async () => {
    const { store, runtime, turn, cleanup } = fixture(false, true)
    store.state.sessions[0].tokens = 400_000
    for (let i = 0; i < 50; i++) store.state.servers[0].tools.push({ name: `large_tool_${i}`, description: 'Long server documentation. '.repeat(500), inputSchema: { type: 'object' }, readOnly: false })
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      const requestTools = turn.mock.calls[0][3]
      expect(requestTools.map((t: any) => t.name)).toEqual(['search_tools', 'call_tool', 'web_search', 'web_fetch'])
      // The 50 large MCP tools add nothing: the gateway is the same small pair, and the web pair is fixed-size.
      expect(JSON.stringify(requestTools.slice(0, 2)).length).toBeLessThan(2000)
      expect(JSON.stringify(requestTools).length).toBeLessThan(3500)
      expect(store.state.sessions[0].lastRun?.tokens).toBe(2)
      expect(store.state.sessions[0].tokens).toBe(400_002)
      expect(store.state.sessions[0].lastRun?.requests).toBe(2)
      expect(store.state.sessions[0].lastRun?.contextCharacters).toBeLessThanOrEqual(36_000)
    } finally { cleanup() }
  })
  it('stops before another model request when the run budget is consumed', async () => {
    const { store, runtime, turn, cleanup } = fixture(false, true)
    store.state.agents.find(a => a.id === 'architect')!.tokenBudget = 10_000
    turn.mockImplementation(async () => ({ text: '', tokens: 10_000, calls: [{ id: 'call', name: 'search_tools', arguments: '{"query":"execute_luau"}' }] }))
    try {
      await runtime.send('session', 'Make the change.')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(turn).toHaveBeenCalledOnce()
      expect(store.state.sessions[0].messages.at(-1)?.content).toContain('Token budget reached')
    } finally { cleanup() }
  })
})
