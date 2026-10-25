import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { ClaudeCode, renderPrompt, locateClaude } from '../../src/main/claudecode'
import { BudgetError } from '../../src/main/context'
import type { ToolSpec } from '../../src/main/providers'

const sdk = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/')).href + '/'
const directories: string[] = []
afterEach(() => { if (process.env.KEEP_FAKE) return; for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A stand-in for the `claude` program: reads the same flags, connects to the MCP bridge, and prints stream-json. */
function fakeClaude() {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-fake-claude-'))
  directories.push(directory)
  const log = join(directory, 'log.json')
  const script = join(directory, 'claude.mjs')
  writeFileSync(script, `
import { readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0) }
if (argv.includes('auth') && argv.includes('status')) { console.log(JSON.stringify({ loggedIn: !argv.includes('--logged-out'), authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0) }
const record = { argv, apiKey: process.env.ANTHROPIC_API_KEY ?? null, step: 'start' }
const save = step => { record.step = step; writeFileSync(${JSON.stringify(log)}, JSON.stringify(record)) }
process.on('uncaughtException', error => { record.error = String(error); save('crashed'); process.exit(1) })
process.on('unhandledRejection', error => { record.error = String(error); save('rejected'); process.exit(1) })
const config = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.rbx
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
record.prompt = prompt
record.system = readFileSync(argv[argv.indexOf('--system-prompt-file') + 1], 'utf8')
const emit = event => console.log(JSON.stringify(event))
if (prompt.includes('HANG')) { emit({ type: 'system', subtype: 'init' }); setInterval(() => {}, 1000); await new Promise(() => {}) }
save('read-input')
record.unauthenticated = (await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status
const { Client } = await import(${JSON.stringify(sdk + 'client/index.js')})
const { StreamableHTTPClientTransport } = await import(${JSON.stringify(sdk + 'client/streamableHttp.js')})
const client = new Client({ name: 'fake', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }))
save('connected')
record.tools = (await client.listTools()).tools.map(t => t.name)
save('listed')
record.results = []
emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking. ' } } })
for (const call of JSON.parse(prompt.split('PLAN ')[1].split('\\n')[0])) {
  emit({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 } } })
  record.results.push(await client.callTool({ name: call.name, arguments: call.args }))
}
emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } })
emit({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 } } })
emit({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 3, cache_read_input_tokens: 50, cache_creation_input_tokens: 7, output_tokens: 20 } })
save('done')
await client.close()
process.exit(0)
`)
  const claude = new ClaudeCode(() => ({ command: process.execPath, args: [script] }))
  return { claude, recorded: () => JSON.parse(readFileSync(log, 'utf8')) }
}
const tools: ToolSpec[] = [{ name: 'search_tools', description: 'Find tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'call_tool', description: 'Run a tool', parameters: { type: 'object' } }]
const plan = (...calls: { name: string; args: object }[]) => [{ role: 'system' as const, content: 'SYSTEM RULES' }, { role: 'user' as const, content: `PLAN ${JSON.stringify(calls)}\nDo it.` }]
const base = { executable: '', model: 'haiku', tools, signal: new AbortController().signal, onText: () => {}, maxToolCalls: 10, tokenLimit: 1_000_000 }

describe('Claude Code provider', () => {
  it('runs Claude Code without its own tools and serves ours through an authenticated local bridge', async () => {
    const { claude, recorded } = fakeClaude()
    const text: string[] = [], calls: string[] = []
    const result = await claude.turn({ ...base, effort: 'high', turns: plan({ name: 'search_tools', args: { query: 'scripts' } }, { name: 'call_tool', args: { name: 'x' } }), onText: t => text.push(t), execute: async (name, args) => { calls.push(`${name}:${JSON.stringify(args)}`); return `result of ${name}` } })
    expect(calls).toEqual(['search_tools:{"query":"scripts"}', 'call_tool:{"name":"x"}'])
    expect(text.join('')).toBe('Checking. Done.')
    expect(result.text).toBe('Done.')
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 20, cachedInputTokens: 50 })
    expect(result.tokens).toBe(80)
    const seen = recorded()
    expect(seen.tools).toEqual(['search_tools', 'call_tool'])
    expect(seen.unauthenticated).toBe(401)
    expect(seen.results.map((r: { content: { text: string }[] }) => r.content[0].text)).toEqual(['result of search_tools', 'result of call_tool'])
    expect(seen.system).toBe('SYSTEM RULES')
    const flags = seen.argv as string[]
    expect(flags[flags.indexOf('--tools') + 1]).toBe('')
    expect(flags).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']))
    expect(flags[flags.indexOf('--effort') + 1]).toBe('high')
    expect(flags[flags.indexOf('--model') + 1]).toBe('haiku')
    expect(flags[flags.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(seen.apiKey).toBeNull()
  })

  it('reports a failing tool back to Claude Code as an error and keeps going', async () => {
    const { claude, recorded } = fakeClaude()
    await claude.turn({ ...base, turns: plan({ name: 'call_tool', args: {} }), execute: async () => { throw new Error('Denied by the user.') } })
    expect(recorded().results[0]).toMatchObject({ isError: true, content: [{ text: 'Denied by the user.' }] })
  })

  it('refuses tool calls beyond the limit', async () => {
    const { claude, recorded } = fakeClaude()
    let executed = 0
    await claude.turn({ ...base, maxToolCalls: 1, turns: plan({ name: 'call_tool', args: {} }, { name: 'call_tool', args: {} }), execute: async () => { executed++; return 'ok' } })
    expect(executed).toBe(1)
    expect(recorded().results[1]).toMatchObject({ isError: true })
    expect(recorded().results[1].content[0].text).toContain('limit')
  })

  it('stops the process and raises a budget error when the token limit is exceeded', async () => {
    const { claude } = fakeClaude()
    await expect(claude.turn({ ...base, tokenLimit: 50, turns: plan({ name: 'call_tool', args: {} }), execute: async () => 'ok' })).rejects.toBeInstanceOf(BudgetError)
  })

  it('kills Claude Code when the run is stopped', async () => {
    const { claude } = fakeClaude()
    const controller = new AbortController()
    const pending = claude.turn({ ...base, signal: controller.signal, turns: [{ role: 'user', content: 'HANG' }], execute: async () => 'ok' })
    setTimeout(() => controller.abort(), 400)
    await expect(pending).rejects.toThrow()
  })

  it('reads sign-in status from Claude Code and never needs credentials from the app', async () => {
    const { claude } = fakeClaude()
    expect(await claude.status('')).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', version: '9.9.9' })
    const loggedOut = new ClaudeCode(() => ({ command: process.execPath, args: [join(directories[0], 'claude.mjs'), '--logged-out'] }))
    expect((await loggedOut.status('')).loggedIn).toBe(false)
  })

  it('renders a single message plainly and a longer conversation with tags', () => {
    expect(renderPrompt([{ role: 'system', content: 's' }, { role: 'user', content: 'Hello' }])).toBe('Hello')
    const long = renderPrompt([{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }, { role: 'user', content: '[User update] C' }])
    expect(long).toContain('<user>A</user>')
    expect(long).toContain('<assistant>B</assistant>')
    expect(long.trim().endsWith('continue the task.')).toBe(true)
  })

  it('locates an explicit executable and rejects .cmd wrappers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rbx-locate-')); directories.push(directory)
    const exe = join(directory, 'claude.exe'); writeFileSync(exe, '')
    const cmd = join(directory, 'claude.cmd'); writeFileSync(cmd, '')
    expect(locateClaude(exe).command).toBe(exe)
    expect(() => locateClaude(cmd)).toThrow('executable itself')
    expect(() => locateClaude(join(directory, 'missing.exe'))).toThrow('not found')
    expect(existsSync(exe)).toBe(true)
  })
})
