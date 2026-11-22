import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/store'
import { AgentRuntime } from '../../src/main/runtime'
import { MediaStore } from '../../src/main/media'
import type { Providers, Turn } from '../../src/main/providers'
import type { McpManager } from '../../src/main/mcp'
import type { WebTools } from '../../src/main/web'

type Reply = { text?: string; calls?: { name: string; arguments: object }[] }
function fixture(script: (turns: Turn[], index: number, tools: { name: string }[]) => Reply | Promise<Reply>, web?: WebTools) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-attach-run-'))
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  store.state.providers.push({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: ['m'], hasKey: false, status: 'connected' })
  const agent = store.state.agents.find(a => !a.orchestrator)!
  Object.assign(agent, { providerId: 'local', model: 'm', permission: 'unrestricted', mcpIds: [] })
  const skillDirectory = join(directory, 'skills', 'luau-core'); mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), 'LUAU '.repeat(300))
  store.state.skills = [{ id: 'luau-core', name: 'luau-core', description: 'Luau', category: 'core', source: 'test', path: join(skillDirectory, 'SKILL.md'), builtin: true }]
  agent.skillIds = ['luau-core']
  const now = new Date().toISOString()
  store.state.sessions.push({ id: 's', agentId: agent.id, title: 'Task', messages: [], createdAt: now, updatedAt: now, status: 'idle', tokens: 0 })
  const media = new MediaStore(join(directory, 'media'))
  const calls: { turns: Turn[]; tools: { name: string }[]; options: any }[] = []
  let index = 0
  const turn = vi.fn(async (_p: unknown, _m: string, turns: Turn[], tools: any[], _s: AbortSignal, _d: unknown, options: any) => {
    calls.push({ turns: structuredClone(turns), tools, options })
    const result = await script(turns, index++, tools)
    return { text: result.text || '', tokens: 10, calls: (result.calls || []).map((c, i) => ({ id: `call-${index}-${i}`, name: c.name, arguments: JSON.stringify(c.arguments) })) }
  })
  const runtime = new AgentRuntime(store, { turn } as unknown as Providers, { connect: vi.fn(async () => {}), call: vi.fn() } as unknown as McpManager, web, media)
  const file = (name: string, content: string | Buffer) => { const path = join(directory, name); writeFileSync(path, content); return media.attach({ path, name }) }
  return { store, runtime, media, calls, file, directory, cleanup: () => { runtime.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const idle = (runtime: AgentRuntime) => vi.waitFor(() => expect(runtime.isRunning('s')).toBe(false))
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)])

describe('attachments in a conversation', () => {
  it('sends the files with their message, lists them later, and reads them on demand', async () => {
    const f = fixture((turns, index) => index === 2 ? { calls: [{ name: 'read_attachment', arguments: { media_id: turns.at(-1)!.content.match(/media_id ([0-9a-f-]{36}) · full text/)![1] } }] } : { text: 'Done.' })
    try {
      const script = f.file('Main.server.lua', 'local Players = game:GetService("Players")')
      const picture = f.media.attach({ data: new Uint8Array(jpeg), name: 'ref.jpg', frames: [new Uint8Array(jpeg)] })
      await f.runtime.send('s', 'Use these', [script, picture])
      await idle(f.runtime)
      const first = f.calls[0]
      const user = first.turns.at(-1)!
      expect(user.content).toContain('Use these')
      expect(user.content).toContain('local Players = game:GetService("Players")')
      expect(user.content).toContain('Main.server.lua')
      expect(user.images).toHaveLength(1)
      expect(first.tools.map(t => t.name)).toContain('read_attachment')
      const session = f.store.state.sessions[0]
      expect(session.messages[0].media).toHaveLength(2)
      expect(session.title).toBe('Use these')

      await f.runtime.send('s', 'Read the script again')
      await idle(f.runtime)
      const later = f.calls[1].turns
      const earlier = later.find(t => t.role === 'user' && t.content.startsWith('Use these'))!
      expect(earlier.content).toContain('Main.server.lua')
      expect(earlier.content).not.toContain('<attachment')
      expect(earlier.images).toBeUndefined()

      await f.runtime.send('s', `Now show me ${'the script'}`, [f.file('notes.md', '# Notes\nBuild a castle')])
      await idle(f.runtime)
      const read = f.calls[3].turns.at(-1)!
      expect(read.role).toBe('tool')
      expect(JSON.parse(read.content)).toMatchObject({ name: 'notes.md', content: '# Notes\nBuild a castle', nextOffset: null })
    } finally { f.cleanup() }
  })

  it('accepts a message made only of attachments and refuses attachments on commands', async () => {
    const f = fixture(() => ({ text: 'ok' }))
    try {
      const archive = f.file('data.bin', Buffer.from([0, 1, 2, 3, 0, 0, 7]))
      await f.runtime.send('s', '', [archive])
      await idle(f.runtime)
      expect(f.store.state.sessions[0].title).toBe('data.bin')
      expect(f.calls[0].turns.at(-1)!.content).toContain('binary file')
      await expect(f.runtime.send('s', '/status', [f.file('x.txt', 'x')])).rejects.toThrow('Commands do not take attachments')
      await expect(f.runtime.send('s', '   ')).rejects.toThrow('Write a message')
    } finally { f.cleanup() }
  })
})

describe('pipeline economy', () => {
  it('keeps the memory block identical across the steps of a run, so the prompt cache holds', async () => {
    const f = fixture((_turns, index) => index < 3 ? { calls: [{ name: 'load_skill', arguments: { skill_id: 'luau-core', offset: index * 500, length: 500 } }] } : { text: 'Done.' })
    try {
      await f.runtime.send('s', 'Learn Luau')
      await idle(f.runtime)
      const memories = f.calls.map(c => c.turns[1].content)
      expect(new Set(memories).size).toBe(1)
      // Every request of the conversation carries the same cache key.
      expect(new Set(f.calls.map(c => c.options.cacheKey)).size).toBe(1)
      // The next message sees what was learned.
      await f.runtime.send('s', 'Again')
      await idle(f.runtime)
      expect(f.calls.at(-1)!.turns[1].content).toContain('LUAU')
    } finally { f.cleanup() }
  })

  it('runs independent reads in parallel', async () => {
    let active = 0, peak = 0
    const web: WebTools = {
      search: async (query: string) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 30)); active--; return { backend: 'test', results: [{ title: query, url: 'https://example.com', snippet: '' }] } },
      fetch: async () => ({ url: '', title: '', text: '', truncated: false })
    } as unknown as WebTools
    const f = fixture((_t, index) => index === 0 ? { calls: [{ name: 'web_search', arguments: { query: 'a' } }, { name: 'web_search', arguments: { query: 'b' } }, { name: 'web_search', arguments: { query: 'c' } }] } : { text: 'ok' }, web)
    try {
      await f.runtime.send('s', 'Research')
      await idle(f.runtime)
      expect(peak).toBe(3)
      const tools = f.calls[1].turns.filter(t => t.role === 'tool').map(t => JSON.parse(t.content).query)
      expect(tools).toEqual(['a', 'b', 'c'])
    } finally { f.cleanup() }
  })

  it('warns, without blocking, when the same call returns the same result three times', async () => {
    const f = fixture((_t, index) => index < 3 ? { calls: [{ name: 'search_tools', arguments: { query: 'nothing' } }] } : { text: 'ok' })
    try {
      f.store.state.agents.find(a => !a.orchestrator)!.mcpIds = ['roblox']
      await f.runtime.send('s', 'Find it')
      await idle(f.runtime)
      const results = f.calls.at(-1)!.turns.filter(t => t.role === 'tool').map(t => t.content)
      expect(results).toHaveLength(3)
      expect(results[1]).not.toContain('[Note:')
      expect(results[2]).toContain('exact call 3 times')
    } finally { f.cleanup() }
  })
})
