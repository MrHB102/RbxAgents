import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { AgentRuntime } from '../../src/main/runtime'
import { Providers } from '../../src/main/providers'
import type { ChatGPTAuth } from '../../src/main/auth'
import type { McpManager } from '../../src/main/mcp'

// Runs the installed `claude` for real, through the agent runtime and the local tool bridge.
// Uses the signed-in account, so it only runs when asked: RBX_LIVE_CLAUDE=1 npx vitest run tests/unit/claudecode.live
const live = process.env.RBX_LIVE_CLAUDE === '1'

it.skipIf(!live)('answers through the installed Claude Code and runs the app’s tools for it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-live-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  try {
    store.state.providers.push({ id: 'cc', name: 'Claude Code', kind: 'claude-code', baseUrl: '', models: [], hasKey: false, status: 'connected' })
    const agent = store.state.agents.find(a => a.id === 'scripter')!
    Object.assign(agent, { providerId: 'cc', model: 'haiku', permission: 'unrestricted', effort: 'low' })
    store.state.servers[0].status = 'connected'
    store.state.servers[0].tools = [{ name: 'get_script_source', description: 'Read the source of a script', inputSchema: { type: 'object' }, readOnly: true }]
    const now = new Date().toISOString()
    store.state.sessions.push({ id: 's', agentId: 'scripter', title: 'Live', messages: [], createdAt: now, updatedAt: now, status: 'idle', tokens: 0 })
    const providers = new Providers(store, {} as ChatGPTAuth)
    const status = await providers.claude.status('')
    expect(status.loggedIn).toBe(true)
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'PINEAPPLE = 42' }] }))
    const runtime = new AgentRuntime(store, providers, { connect: vi.fn(async () => {}), call } as unknown as McpManager)
    await runtime.send('s', 'Call search_tools with the query "script source", then use call_tool with server_id "roblox", name "get_script_source" and empty arguments. Reply with the name of the constant in the result and nothing else.')
    await vi.waitFor(() => expect(runtime.isRunning('s')).toBe(false), { timeout: 150_000, interval: 500 })
    const session = store.state.sessions[0]
    expect(session.messages.at(-1)?.content, session.messages.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')).toMatch(/pineapple/i)
    expect(call).toHaveBeenCalledOnce()
    expect(session.status).toBe('idle')
    expect(session.messages.filter(m => m.role === 'tool').map(m => m.content.split('\n')[0])).toEqual(expect.arrayContaining([expect.stringContaining('search_tools'), expect.stringContaining('get_script_source')]))
    expect(session.lastRun!.tokens).toBeGreaterThan(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 180_000)

it.skipIf(!live)('researches on the real web through the app’s web tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-live-web-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  try {
    store.state.providers.push({ id: 'cc', name: 'Claude Code', kind: 'claude-code', baseUrl: '', models: [], hasKey: false, status: 'connected' })
    Object.assign(store.state.agents.find(a => a.id === 'scripter')!, { providerId: 'cc', model: 'haiku', permission: 'unrestricted', mcpIds: [], effort: 'low' })
    const now = new Date().toISOString()
    store.state.sessions.push({ id: 'w', agentId: 'scripter', title: 'Live web', messages: [], createdAt: now, updatedAt: now, status: 'idle', tokens: 0 })
    const runtime = new AgentRuntime(store, new Providers(store, {} as ChatGPTAuth), { connect: vi.fn(async () => {}), call: vi.fn() } as unknown as McpManager)
    await runtime.send('w', 'Use web_search to find the official Roblox Creator Hub page for RunService.Heartbeat, read it with web_fetch, and answer in one sentence that includes the URL you read.')
    await vi.waitFor(() => expect(runtime.isRunning('w')).toBe(false), { timeout: 150_000, interval: 500 })
    const session = store.state.sessions[0]
    const trace = session.messages.map(m => `${m.role}: ${m.content.slice(0, 160)}`).join('\n')
    expect(session.status, trace).toBe('idle')
    const tools = session.messages.filter(m => m.role === 'tool').map(m => m.content.split('\n')[0])
    expect(tools.some(t => t.startsWith('web_search')), trace).toBe(true)
    expect(tools.some(t => t.startsWith('web_fetch')), trace).toBe(true)
    expect(session.messages.at(-1)?.content, trace).toContain('create.roblox.com')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 180_000)
