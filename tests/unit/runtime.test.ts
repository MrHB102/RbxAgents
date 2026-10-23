import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { AgentRuntime } from '../../src/main/runtime'
import type { Providers } from '../../src/main/providers'
import type { McpManager } from '../../src/main/mcp'

function fixture(readOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-runtime-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const agent = store.state.agents[0]
  agent.providerId = 'local'; agent.model = 'test-model'; agent.permission = readOnly ? 'read-only' : 'ask'
  store.state.providers.push({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: ['test-model'], hasKey: false, status: 'connected' })
  const server = store.state.servers[0]
  server.status = 'connected'; server.tools = [{ name: 'execute_luau', description: 'Mutate Studio', inputSchema: { type: 'object' }, readOnly: false }]
  store.state.sessions.push({ id: 'session', agentId: agent.id, title: 'Task', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', tokens: 0 })
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'Change verified' }] }))
  let counter = 0
  const turn = vi.fn(async (_provider, _model, _turns, tools) => {
    if (counter++ === 0) {
      const tool = tools.find((t: any) => t.name.includes('execute_luau'))
      return { text: 'I will make this change.', tokens: 1, calls: tool ? [{ id: 'call', name: tool.name, arguments: '{"code":"print(1)"}' }] : [] }
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
  it('does not expose mutation tools to a read-only agent', async () => {
    const { store, runtime, call, turn, cleanup } = fixture(true)
    try {
      await runtime.send('session', 'Inspect the project.')
      await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false))
      expect(call).not.toHaveBeenCalled()
      expect(turn.mock.calls[0][3].some((tool: any) => tool.name.includes('execute_luau'))).toBe(false)
      expect(store.approvals).toHaveLength(0)
    } finally { cleanup() }
  })
})
