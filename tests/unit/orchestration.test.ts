import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { AgentRuntime } from '../../src/main/runtime'
import type { Providers, Turn } from '../../src/main/providers'
import type { McpManager } from '../../src/main/mcp'

type Script = (call: { who: 'master' | 'worker' | 'side'; turns: Turn[]; tools: any[]; options: any; model: string; index: number }) => Promise<{ text?: string; calls?: { name: string; arguments: object }[] }> | { text?: string; calls?: { name: string; arguments: object }[] }

function fixture(script: Script, configure: (store: Store) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-orchestration-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  store.state.providers.push({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: ['big-model', 'small-model', 'other-model'], hasKey: false, status: 'connected' })
  for (const agent of store.state.agents) { agent.providerId = 'local'; agent.model = agent.orchestrator ? 'big-model' : 'small-model'; agent.permission = 'unrestricted' }
  store.state.servers[0].status = 'connected'
  store.state.servers[0].tools = [{ name: 'get_script_source', description: 'Read a script', inputSchema: { type: 'object' }, readOnly: true }, { name: 'execute_luau', description: 'Mutate Studio', inputSchema: { type: 'object' }, readOnly: false }]
  const skillDirectory = join(directory, 'skills', 'roblox-luau-core')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), 'LUAU CORE KNOWLEDGE '.repeat(50))
  store.state.skills.push({ id: 'roblox-luau-core', name: 'roblox-luau-core', description: 'Luau', category: 'core', source: 'test', path: join(skillDirectory, 'SKILL.md'), builtin: true })
  configure(store)
  const now = new Date().toISOString()
  for (const agent of store.state.agents) store.state.sessions.push({ id: agent.id, agentId: agent.id, title: 'Task', messages: [], createdAt: now, updatedAt: now, status: 'idle', tokens: 0 })
  const calls: { who: string; turns: Turn[]; tools: any[]; options: any; model: string }[] = []
  let index = 0
  const turn = vi.fn(async (_provider: unknown, model: string, turns: Turn[], tools: any[], _signal: AbortSignal, delta: (t: string) => void, options: any) => {
    const who = tools.length === 0 && /side question/.test(turns[0].content) ? 'side' : turns[0].content.includes('# Delegated task') ? 'worker' : 'master'
    calls.push({ who, turns: structuredClone(turns), tools, options, model })
    const result = await script({ who, turns, tools, options, model, index: index++ })
    if (result.text) delta(result.text)
    return { text: result.text || '', tokens: 10, calls: (result.calls || []).map((c, i) => ({ id: `call-${index}-${i}`, name: c.name, arguments: JSON.stringify(c.arguments) })) }
  })
  const mcpCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  const runtime = new AgentRuntime(store, { turn } as unknown as Providers, { connect: vi.fn(async () => {}), call: mcpCall } as unknown as McpManager)
  return { store, runtime, turn, calls, mcpCall, cleanup: () => { runtime.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const idle = (runtime: AgentRuntime, id: string) => vi.waitFor(() => expect(runtime.isRunning(id)).toBe(false))
const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve }); return { promise, open } }

describe('messages while the agent works', () => {
  it('delivers a queued message before the next model request and keeps the run going', async () => {
    const hold = gate()
    const { store, runtime, calls, mcpCall, cleanup } = fixture(({ turns, index }) => index === 0
      ? { calls: [{ name: 'call_tool', arguments: { server_id: 'roblox', name: 'execute_luau', arguments: { code: 'print(1)' } } }] }
      : { text: turns.some(t => t.content.includes('[User update')) ? 'Adjusted.' : 'Ignored.' })
    mcpCall.mockImplementation(async () => { await hold.promise; return { content: [{ type: 'text', text: 'ok' }] } })
    try {
      await runtime.send('architect', 'Start the task.')
      await vi.waitFor(() => expect(mcpCall).toHaveBeenCalled())
      expect(await runtime.send('architect', 'Also keep the comments.')).toEqual({ queued: true })
      expect(store.state.sessions.find(s => s.id === 'architect')!.messages.at(-1)?.kind).toBe('queued')
      hold.open()
      await idle(runtime, 'architect')
      const update = calls[1].turns.find(t => t.role === 'user' && t.content.includes('[User update'))
      expect(update?.content).toContain('Also keep the comments.')
      expect(calls[1].turns.indexOf(update!)).toBeGreaterThan(calls[1].turns.findIndex(t => t.role === 'tool'))
      const session = store.state.sessions.find(s => s.id === 'architect')!
      expect(session.messages.some(m => m.kind === 'queued')).toBe(false)
      expect(session.messages.filter(m => m.role === 'assistant').at(-1)?.content).toBe('Adjusted.')
    } finally { cleanup() }
  })

  it('continues the run when a message arrives while the final answer is being written', async () => {
    const hold = gate()
    const { runtime, calls, cleanup } = fixture(async ({ index }) => { if (index === 0) await hold.promise; return { text: index === 0 ? 'First answer.' : 'Second answer.' } })
    try {
      await runtime.send('architect', 'Hello.')
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      await runtime.send('architect', 'One more thing.')
      hold.open()
      await idle(runtime, 'architect')
      expect(calls).toHaveLength(2)
      expect(calls[1].turns.at(-1)?.content).toContain('One more thing.')
    } finally { cleanup() }
  })
})

describe('slash commands', () => {
  it('switches model and effort for the conversation without touching the agent', async () => {
    const { store, runtime, calls, cleanup } = fixture(() => ({ text: 'Done.' }))
    try {
      await runtime.send('architect', '/model other')
      await runtime.send('architect', '/effort high')
      const session = store.state.sessions.find(s => s.id === 'architect')!
      expect(session.overrides).toMatchObject({ model: 'other-model', effort: 'high' })
      expect(store.state.agents.find(a => a.id === 'architect')!.model).toBe('small-model')
      expect(session.messages.map(m => m.content).join('\n')).toContain('Model: other-model')
      await runtime.send('architect', 'Go.')
      await idle(runtime, 'architect')
      expect(calls[0].model).toBe('other-model')
      expect(calls[0].options.effort).toBe('high')
      expect(calls[0].options.maxOutputTokens).toBeGreaterThan(4096)
      await runtime.send('architect', '/model small-model --save')
      expect(store.state.agents.find(a => a.id === 'architect')!.model).toBe('small-model')
      await runtime.send('architect', '/effort turbo')
      expect(session.messages.at(-1)?.content).toContain('Choose low')
    } finally { cleanup() }
  })

  it('applies a model change in the middle of a run', async () => {
    const hold = gate()
    const { runtime, calls, mcpCall, cleanup } = fixture(({ index }) => index === 0 ? { calls: [{ name: 'call_tool', arguments: { server_id: 'roblox', name: 'get_script_source', arguments: {} } }] } : { text: 'Done.' })
    mcpCall.mockImplementation(async () => { await hold.promise; return { content: [] } })
    try {
      await runtime.send('architect', 'Read it.')
      await vi.waitFor(() => expect(mcpCall).toHaveBeenCalled())
      await runtime.send('architect', '/model big-model')
      hold.open()
      await idle(runtime, 'architect')
      expect(calls.map(c => c.model)).toEqual(['small-model', 'big-model'])
    } finally { cleanup() }
  })

  it('answers /btw from the conversation without tools, without interrupting, and without entering context', async () => {
    const hold = gate()
    const { store, runtime, calls, mcpCall, cleanup } = fixture(({ who, turns, index }) => {
      if (who === 'side') return { text: 'It is the Lobby script.' }
      return index === 0 ? { calls: [{ name: 'call_tool', arguments: { server_id: 'roblox', name: 'get_script_source', arguments: {} } }] } : { text: `Done. saw=${turns.some(t => t.content.includes('which script'))}` }
    })
    mcpCall.mockImplementation(async () => { await hold.promise; return { content: [] } })
    try {
      await runtime.send('architect', 'Inspect the Lobby.')
      await vi.waitFor(() => expect(mcpCall).toHaveBeenCalled())
      await runtime.send('architect', '/btw which script are you reading?')
      await vi.waitFor(() => expect(store.state.sessions.find(s => s.id === 'architect')!.messages.some(m => m.kind === 'btw' && m.role === 'assistant' && m.content === 'It is the Lobby script.')).toBe(true))
      expect(runtime.isRunning('architect')).toBe(true)
      const side = calls.find(c => c.who === 'side')!
      expect(side.tools).toEqual([])
      expect(side.options.maxOutputTokens).toBe(1024)
      expect(side.turns[0].content).toContain('Inspect the Lobby.')
      hold.open()
      await idle(runtime, 'architect')
      expect(store.state.sessions.find(s => s.id === 'architect')!.messages.filter(m => m.role === 'assistant' && m.kind !== 'btw').at(-1)?.content).toBe('Done. saw=false')
    } finally { cleanup() }
  })

  it('/stop ends a running task', async () => {
    const { runtime, cleanup } = fixture(({ index }) => new Promise(() => { void index }))
    try {
      await runtime.send('architect', 'Hang.')
      await runtime.send('architect', '/stop')
      await idle(runtime, 'architect')
    } finally { cleanup() }
  })
})

describe('memory across messages', () => {
  it('keeps a loaded skill page for later messages instead of reading it again', async () => {
    const { store, runtime, calls, cleanup } = fixture(({ turns, index }) => {
      if (index === 0) return { calls: [{ name: 'load_skill', arguments: { skill_id: 'roblox-luau-core' } }] }
      if (index === 1) return { text: 'Loaded.' }
      if (index === 2) return { calls: [{ name: 'load_skill', arguments: { skill_id: 'roblox-luau-core' } }] }
      return { text: `memory=${turns.some(t => t.role === 'system' && t.content.includes('LUAU CORE KNOWLEDGE'))}` }
    })
    try {
      await runtime.send('scripter', 'Learn Luau.')
      await idle(runtime, 'scripter')
      await runtime.send('scripter', 'Use it again.')
      await idle(runtime, 'scripter')
      const second = calls[2]
      expect(second.turns.filter(t => t.role === 'system').some(t => t.content.includes('Loaded skill pages') && t.content.includes('LUAU CORE KNOWLEDGE'))).toBe(true)
      const messages = store.state.sessions.find(s => s.id === 'scripter')!.messages
      expect(messages.filter(m => m.role === 'tool').at(-1)?.content).toContain('alreadyLoaded')
      expect(messages.at(-1)?.content).toBe('memory=true')
    } finally { cleanup() }
  })

  it('folds old exchanges into a short digest and keeps the recent ones verbatim', async () => {
    const { store, runtime, calls, cleanup } = fixture(({ index }) => ({ text: `Answer ${index}` }))
    try {
      for (let i = 0; i < 6; i++) { await runtime.send('scripter', `Request number ${i}`); await idle(runtime, 'scripter') }
      const last = calls.at(-1)!
      const users = last.turns.filter(t => t.role === 'user').map(t => t.content)
      expect(users).toEqual(['Request number 3', 'Request number 4', 'Request number 5'])
      const memory = last.turns.filter(t => t.role === 'system').map(t => t.content).join('\n')
      expect(memory).toContain('Request number 0')
      expect(memory).toContain('Request number 2')
      expect(memory).not.toContain('Request number 4')
      expect(store.state.sessions.find(s => s.id === 'scripter')!.memory?.digest).toHaveLength(3)
    } finally { cleanup() }
  })
})

describe('Master Agent', () => {
  const delegate = (...tasks: { agent_id: string; brief: string }[]) => ({ calls: [{ name: 'delegate', arguments: { tasks } }] })

  it('delegates a self-contained brief to a worker and receives only its report', async () => {
    const { store, runtime, calls, cleanup } = fixture(({ who, turns, index }) => who === 'worker'
      ? { text: 'Result: 3 scripts found.' }
      : index === 0 ? delegate({ agent_id: 'scripter', brief: 'List the scripts in ServerScriptService.' }) : { text: `Final: ${turns.filter(t => t.role === 'tool').at(-1)?.content.includes('3 scripts found')}` })
    try {
      await runtime.send('master', 'Audit my scripts.')
      await idle(runtime, 'master')
      const worker = calls.find(c => c.who === 'worker')!
      expect(worker.model).toBe('small-model')
      expect(worker.turns[0].content).toContain('You write production Luau')
      expect(worker.turns[0].content).toContain('# Delegated task')
      expect(worker.turns.filter(t => t.role === 'user').map(t => t.content)).toEqual(['List the scripts in ServerScriptService.'])
      const master = calls.find(c => c.who === 'master')!
      expect(master.turns[0].content).toContain('# Your team')
      expect(master.turns[0].content).toContain('"id":"scripter"')
      expect(master.tools.map(t => t.name)).toEqual(expect.arrayContaining(['delegate', 'send_to_agent', 'create_agent', 'update_plan']))
      expect(master.tools.map(t => t.name)).not.toContain('call_tool')
      const session = store.state.sessions.find(s => s.id === 'master')!
      expect(session.messages.at(-1)?.content).toBe('Final: true')
      expect(session.lastRun?.threads).toMatchObject([{ agentId: 'scripter', status: 'done', requests: 1 }])
      expect(session.lastRun?.tokens).toBe(30)
      expect(session.messages.find(m => m.role === 'tool')?.content).toContain('delegate → Scripter')
    } finally { cleanup() }
  })

  it('runs independent workers in parallel and continues a thread with send_to_agent', async () => {
    let active = 0, peak = 0
    const { runtime, calls, cleanup } = fixture(async ({ who, index, turns }) => {
      if (who === 'worker') {
        active++; peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 25)); active--
        return { text: `Report ${turns.filter(t => t.role === 'user').length}` }
      }
      if (index === 0) return delegate({ agent_id: 'scripter', brief: 'A' }, { agent_id: 'reviewer', brief: 'B' })
      if (calls.filter(c => c.who === 'master').length === 2) return { calls: [{ name: 'send_to_agent', arguments: { thread_id: 'scripter-1', message: 'Now fix it.' } }] }
      return { text: 'Finished.' }
    })
    try {
      await runtime.send('master', 'Do both.')
      await idle(runtime, 'master')
      expect(peak).toBe(2)
      const followUp = calls.filter(c => c.who === 'worker').at(-1)!
      expect(followUp.turns.filter(t => t.role === 'user').map(t => t.content)).toEqual(['A', 'Now fix it.'])
    } finally { cleanup() }
  })

  it('returns a worker that is out of budget as a result instead of failing the run', async () => {
    const { store, runtime, cleanup } = fixture(({ who, index }) => who === 'worker' ? { text: 'x'.repeat(10) } : index === 0 ? delegate({ agent_id: 'scripter', brief: 'A' }) : { text: 'Handled.' }, s => { s.state.agents.find(a => a.id === 'scripter')!.tokenBudget = 1000 })
    try {
      await runtime.send('master', 'Go.')
      await idle(runtime, 'master')
      const session = store.state.sessions.find(s => s.id === 'master')!
      expect(session.status).toBe('idle')
      expect(session.messages.at(-1)?.content).toBe('Handled.')
    } finally { cleanup() }
  })

  it('refuses unknown or unconfigured workers', async () => {
    const { store, runtime, cleanup } = fixture(({ who, index }) => who === 'master' && index === 0 ? delegate({ agent_id: 'nobody', brief: 'A' }) : { text: 'ok' })
    try {
      await runtime.send('master', 'Go.')
      await idle(runtime, 'master')
      expect(store.state.sessions.find(s => s.id === 'master')!.messages.find(m => m.role === 'tool')?.content).toContain('Unknown worker')
    } finally { cleanup() }
  })

  it('always asks before creating an agent, even in Unrestricted mode, and never auto-approves it', async () => {
    const create = { name: 'Animator', role: 'Animation', description: 'Builds animations', system_prompt: 'You animate rigs.', skill_ids: ['roblox-luau-core'], reason: 'No worker covers animation.' }
    const { store, runtime, cleanup } = fixture(({ who, index }) => who === 'master' && index === 0 ? { calls: [{ name: 'create_agent', arguments: create }] } : { text: 'Done.' })
    try {
      await runtime.send('master', 'I need animation work.')
      await vi.waitFor(() => expect(store.approvals).toHaveLength(1))
      expect(store.approvals[0]).toMatchObject({ kind: 'create-agent', tool: 'create_agent', agentId: 'master' })
      expect(store.approvals[0].args).toMatchObject({ name: 'Animator', access: 'ask' })
      runtime.setAccess('master', 'unrestricted')
      expect(store.approvals).toHaveLength(1)
      expect(store.state.agents.some(a => a.name === 'Animator')).toBe(false)
      runtime.decide(store.approvals[0].id, true)
      await idle(runtime, 'master')
      const created = store.state.agents.find(a => a.name === 'Animator')!
      expect(created).toMatchObject({ permission: 'ask', model: 'small-model', providerId: 'local' })
      expect(created.orchestrator).toBeUndefined()
    } finally { cleanup() }
  })

  it('does not create the agent when the user declines', async () => {
    const create = { name: 'Animator', role: 'Animation', description: 'Builds animations', system_prompt: 'You animate rigs.', reason: 'Needed.' }
    const { store, runtime, cleanup } = fixture(({ who, index }) => who === 'master' && index === 0 ? { calls: [{ name: 'create_agent', arguments: create }] } : { text: 'Understood.' })
    try {
      await runtime.send('master', 'Make an animator.')
      await vi.waitFor(() => expect(store.approvals).toHaveLength(1))
      runtime.decide(store.approvals[0].id, false)
      await idle(runtime, 'master')
      expect(store.state.agents.some(a => a.name === 'Animator')).toBe(false)
      expect(store.state.sessions.find(s => s.id === 'master')!.messages.find(m => m.role === 'tool')?.content).toContain('declined')
    } finally { cleanup() }
  })

  it('records the plan, keeps it in memory, and shows it to the next message', async () => {
    const { store, runtime, calls, cleanup } = fixture(({ who, index }) => who === 'master' && index === 0 ? { calls: [{ name: 'update_plan', arguments: { steps: [{ id: 's1', title: 'Inspect', status: 'done' }, { id: 's2', title: 'Build', status: 'pending', agent_id: 'builder' }] } }] } : { text: 'ok' })
    try {
      await runtime.send('master', 'Plan it.')
      await idle(runtime, 'master')
      expect(store.state.sessions.find(s => s.id === 'master')!.plan).toHaveLength(2)
      await runtime.send('master', 'Continue.')
      await idle(runtime, 'master')
      expect(calls.at(-1)!.turns.filter(t => t.role === 'system').map(t => t.content).join('\n')).toContain('[ ] s2: Build (builder)')
    } finally { cleanup() }
  })
})
