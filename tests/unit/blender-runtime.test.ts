import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/store'
import { McpManager } from '../../src/main/mcp'
import { MediaStore } from '../../src/main/media'
import { AgentRuntime } from '../../src/main/runtime'
import type { Providers } from '../../src/main/providers'
import type { Agent } from '../../src/shared/types'

type Step = (tools: { name: string }[]) => { text: string; tokens: number; calls: { id: string; name: string; arguments: string }[] }
const call = (name: string, args: object): Step => () => ({ text: '', tokens: 1, calls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args) }] })
const say = (text: string): Step => () => ({ text, tokens: 1, calls: [] })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(steps: Step[], options: { mode?: string; permission?: Agent['permission']; agent?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-blender-rt-'))
  const log = join(directory, 'fixture.log')
  const store = new Store(directory, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
  const agent = store.state.agents.find(a => a.id === (options.agent || 'artist'))!
  agent.providerId = 'local'; agent.model = 'test-model'; agent.permission = options.permission ?? 'ask'
  store.state.providers.push({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: ['test-model'], hasKey: false, status: 'connected' })
  const server = store.state.servers.find(s => s.id === 'blender')!
  server.command = process.execPath; server.args = [join(process.cwd(), 'tests/fixtures/blender-server.mjs')]
  server.env = { BLENDER_FIXTURE: options.mode || 'ok', BLENDER_FIXTURE_LOG: log }
  store.state.sessions.push({ id: 'session', agentId: agent.id, title: 'Task', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', tokens: 0 })
  const mcp = new McpManager(store)
  const media = new MediaStore(join(directory, 'media'))
  let index = 0
  const turn = vi.fn(async (_provider: unknown, _model: string, _turns: unknown, tools: { name: string }[]) => (steps[index++] ?? say('Done.'))(tools))
  const runtime = new AgentRuntime(store, { turn } as unknown as Providers, mcp, undefined, media)
  cleanups.push(async () => { runtime.close(); await mcp.close(); rmSync(directory, { recursive: true, force: true }) })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  const run = async (message = 'Show me the model.') => { await runtime.send('session', message); await vi.waitFor(() => expect(runtime.isRunning('session')).toBe(false), { timeout: 15_000 }) }
  const toolMessages = () => store.state.sessions[0].messages.filter(m => m.role === 'tool')
  return { directory, store, mcp, media, runtime, turn, calls, run, toolMessages, source: (name: string, content: Buffer | string) => { const path = join(directory, name); writeFileSync(path, content); return path } }
}
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(64, 7)])

describe('the Blender connection', () => {
  it('shows agents the useful tools only: no data collection, no prompt field, and only looking is read-only', async () => {
    const f = await fixture([])
    await f.mcp.connect('blender')
    const tools = f.store.state.servers.find(s => s.id === 'blender')!.tools
    expect(tools.map(t => t.name).sort()).toEqual(['execute_blender_code', 'generate_3d', 'get_addon_status', 'get_scene_info', 'import_asset', 'look', 'search_assets'])
    for (const tool of tools) expect(Object.keys((tool.inputSchema.properties as object) || {})).not.toContain('user_prompt')
    expect(Object.fromEntries(tools.map(t => [t.name, t.readOnly]))).toEqual({ execute_blender_code: false, generate_3d: false, import_asset: false, get_addon_status: true, get_scene_info: true, look: true, search_assets: true })
    expect((tools.find(t => t.name === 'execute_blender_code')!.inputSchema.required as string[])).toEqual(['code'])
  })
  it('reports whether Blender answers, and what it says', async () => {
    const f = await fixture([])
    const server = f.store.state.servers.find(s => s.id === 'blender')!
    server.args = [...server.args, '--port', '1']
    expect(await f.mcp.blenderStatus()).toEqual({ reachable: false, host: 'localhost', port: 1, report: '' })
  })
})

describe('before Blender is set up', () => {
  it('tells the user what to do when uv is missing, instead of failing to start a program', async () => {
    const f = await fixture([say('unused')])
    const server = f.store.state.servers.find(s => s.id === 'blender')!
    server.command = 'uvx'
    const manager = new McpManager(f.store, { uvx: () => undefined })
    await expect(manager.connect('blender')).rejects.toThrow(/needs uv.*Install Blender add-on/)
    expect(server).toMatchObject({ status: 'error', error: expect.stringContaining('Install Blender add-on') })
    await manager.close()
  })
})

describe('render_preview', () => {
  it('waits for approval, renders, and posts a playable video in the chat', async () => {
    const f = await fixture([call('render_preview', { mode: 'turntable', frames: 12, height: 360, caption: 'Spin' }), say('Here is your preview.')])
    await f.runtime.send('session', 'Show me the model.')
    await vi.waitFor(() => expect(f.store.approvals).toHaveLength(1))
    expect(f.store.approvals[0]).toMatchObject({ tool: 'render_preview', serverId: 'blender', kind: 'tool' })
    expect(f.calls()).toEqual([])
    f.runtime.decide(f.store.approvals[0].id, true)
    await vi.waitFor(() => expect(f.runtime.isRunning('session')).toBe(false), { timeout: 15_000 })
    const message = f.toolMessages()[0]
    expect(message.media).toHaveLength(1)
    expect(message.media![0]).toMatchObject({ kind: 'video', mime: 'video/mp4', caption: 'Spin' })
    expect(message.media![0].name).toBe('turntable-360p.mp4')
    expect(f.media.locate(message.media![0].id)).toBeTruthy()
    expect(JSON.parse(f.calls().find(c => c.startsWith('options '))!.slice(8))).toMatchObject({ mode: 'turntable', frames: 12, height: 360, engine: 'eevee', focus: 'all', format: 'mp4' })
    const reply = JSON.parse((f.turn.mock.calls[1][2] as { role: string; content: string }[]).filter(t => t.role === 'tool').at(-1)!.content)
    expect(reply).toMatchObject({ shared: true, kind: 'video', mode: 'turntable', height: 360, frames: 12 })
    expect(readdirSync(join(f.media.directory, 'incoming'))).toEqual([])
    expect(f.store.state.sessions[0].messages.at(-1)?.content).toBe('Here is your preview.')
  })
  it('shares a still as an image', async () => {
    const f = await fixture([call('render_preview', { mode: 'still', height: 480 }), say('Done.')], { permission: 'unrestricted' })
    await f.run()
    expect(f.toolMessages()[0].media![0]).toMatchObject({ kind: 'image', mime: 'image/png' })
    expect(f.store.approvals).toHaveLength(0)
  })
  it('does not render when the user says no', async () => {
    const f = await fixture([call('render_preview', {}), say('Understood.')])
    await f.runtime.send('session', 'Show me the model.')
    await vi.waitFor(() => expect(f.store.approvals).toHaveLength(1))
    f.runtime.decide(f.store.approvals[0].id, false)
    await vi.waitFor(() => expect(f.runtime.isRunning('session')).toBe(false))
    expect(f.calls()).toEqual([])
    expect(f.toolMessages()[0].content).toContain('user denied')
    expect(f.toolMessages()[0].media).toBeUndefined()
  })
  it('is refused for a read-only agent', async () => {
    const f = await fixture([call('render_preview', {}), say('Ok.')], { permission: 'read-only' })
    await f.run()
    expect(f.calls()).toEqual([])
    expect(f.toolMessages()[0].content).toContain('only has read access')
  })
  it.each([['error', /Traceback: RuntimeError: Cannot render, no camera/], ['empty', /nothing was printed/]])('tells the model plainly when Blender fails (%s) and keeps nothing', async (mode, message) => {
    const f = await fixture([call('render_preview', {}), say('It failed.')], { mode, permission: 'unrestricted' })
    await f.run()
    const reply = JSON.parse((f.turn.mock.calls[1][2] as { role: string; content: string }[]).filter(t => t.role === 'tool').at(-1)!.content)
    expect(reply.error).toMatch(/Blender did not produce a preview/)
    expect(reply.error).toMatch(message)
    expect(f.toolMessages()[0].media).toBeUndefined()
    expect(readdirSync(f.media.directory).filter(n => n !== 'incoming')).toEqual([])
    expect(readdirSync(join(f.media.directory, 'incoming'))).toEqual([])
  })
})

describe('share_media', () => {
  it('shows an existing image without asking, even to a read-only agent: it changes nothing', async () => {
    const f = await fixture([null as never, say('Done.')], { permission: 'read-only' })
    const path = f.source('render.png', PNG)
    f.turn.mockReset()
    let step = 0
    f.turn.mockImplementation(async () => step++ === 0 ? call('share_media', { path, caption: 'My render' })([]) : say('Done.')([]))
    await f.run()
    expect(f.store.approvals).toHaveLength(0)
    expect(f.toolMessages()[0].media![0]).toMatchObject({ kind: 'image', caption: 'My render', name: 'render.png' })
  })
  it('refuses files that are not previews, and says why', async () => {
    const f = await fixture([call('share_media', { path: 'relative.png' }), call('share_media', { path: join(tmpdir(), 'secrets.txt') }), say('Done.')])
    await f.run()
    const errors = f.toolMessages().map(m => m.content)
    expect(errors[0]).toMatch(/full path/)
    expect(errors[1]).toMatch(/Only .* files can be shared/)
    expect(f.toolMessages().every(m => !m.media)).toBe(true)
  })
})

describe('which agents get the preview tools', () => {
  it('gives them to agents connected to Blender, with Blender\u2019s own notes in their instructions', async () => {
    const f = await fixture([say('Hi.')])
    await f.run('Hello')
    const names = (f.turn.mock.calls[0][3] as { name: string }[]).map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['search_tools', 'call_tool', 'render_preview', 'share_media']))
    expect((f.turn.mock.calls[0][2] as { content: string }[])[0].content).toContain('# Blender')
  })
  it('keeps them from agents that only work in Roblox Studio', async () => {
    const f = await fixture([say('Hi.')], { agent: 'architect' })
    await f.run('Hello')
    const names = (f.turn.mock.calls[0][3] as { name: string }[]).map(t => t.name)
    expect(names).not.toContain('render_preview')
    expect(names).not.toContain('share_media')
    expect((f.turn.mock.calls[0][2] as { content: string }[])[0].content).not.toContain('# Blender')
  })
})