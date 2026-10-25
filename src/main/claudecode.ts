import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Effort } from '../shared/types'
import type { ToolSpec, Turn } from './providers'
import { boundedText } from './context'

/**
 * Claude Code as a model provider.
 *
 * RBX Agents runs the user's own, unmodified `claude` program and lets it sign in with its own flow. The app never reads,
 * copies, or stores Claude credentials. Claude Code's built-in tools are switched off, so the only thing it can do is call
 * the tools the app offers through a short-lived loopback MCP server. Those calls go through the normal access modes,
 * approvals, step and token limits.
 */
export const CLAUDE_CODE_MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

export interface Launcher { command: string; args: string[] }
export interface ClaudeStatus { loggedIn: boolean; authMethod?: string; apiProvider?: string; version?: string }
export interface ClaudeTurnInput {
  executable: string; model: string; effort?: Effort; turns: Turn[]; tools: ToolSpec[]; signal: AbortSignal
  onText: (text: string) => void
  /** Runs one tool call requested by Claude Code and returns its result text. May throw to report an error. */
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
}
export interface ClaudeTurnResult { text: string; tokens: number; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }

const ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']
function environment() {
  const env: Record<string, string> = {}
  // ANTHROPIC_API_KEY and similar are deliberately not forwarded: sign-in is whatever Claude Code itself is set up with.
  for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key]!
  return env
}
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
  else child.kill('SIGTERM')
}

/** Finds the Claude Code executable: an explicit path, PATH, or the default install folder. */
export function locateClaude(hint: string): Launcher {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  const explicit = hint.trim()
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Claude Code was not found at "${explicit}".`)
    if (/\.(cmd|bat)$/i.test(explicit)) throw new Error('Choose the claude executable itself, not a .cmd wrapper. Claude Code’s native installer provides claude.exe.')
    return { command: explicit, args: [] }
  }
  const directories = [...(process.env.PATH || process.env.Path || '').split(delimiter), join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')].filter(Boolean)
  for (const directory of directories) for (const name of names) { const candidate = join(directory, name); if (existsSync(candidate)) return { command: candidate, args: [] } }
  throw new Error('Claude Code is not installed. Install it from claude.com/claude-code, then check the connection again.')
}

function run(launcher: Launcher, args: string[], timeout: number, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...launcher.args, ...args], { env: environment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = (chunk: Buffer) => { const text = chunk.toString(); output = (output + text).slice(-20_000); onOutput?.(text) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    const timer = setTimeout(() => { killTree(child); reject(new Error('Claude Code did not respond in time.')) }, timeout)
    const abort = () => { killTree(child); reject(new Error('Cancelled.')) }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, output }) })
  })
}

/** Turns the conversation into one prompt. Claude Code is stateless here: every turn carries what it needs. */
export function renderPrompt(turns: Turn[]) {
  const conversation = turns.filter(t => t.role !== 'system')
  if (conversation.length === 1 && conversation[0].role === 'user') return conversation[0].content
  const body = conversation.map(turn => {
    if (turn.role === 'tool') return `<tool_result>${turn.content}</tool_result>`
    const calls = (turn.tool_calls || []).map(c => `<tool_call name="${c.function.name}">${c.function.arguments}</tool_call>`).join('\n')
    return `<${turn.role}>${[turn.content, calls].filter(Boolean).join('\n')}</${turn.role}>`
  }).join('\n\n')
  return `The conversation so far:\n\n${body}\n\nReply to the last <user> message and continue the task.`
}

export class ClaudeCode {
  constructor(private resolve: (hint: string) => Launcher = locateClaude) {}

  async status(hint: string): Promise<ClaudeStatus> {
    const launcher = this.resolve(hint)
    const [version, auth] = await Promise.all([run(launcher, ['--version'], 15_000).catch(() => undefined), run(launcher, ['auth', 'status'], 20_000)])
    let parsed: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } = {}
    try { parsed = JSON.parse(auth.output.slice(auth.output.indexOf('{'))) } catch { /* Older versions print text. */ }
    const loggedIn = parsed.loggedIn ?? (auth.code === 0 && !/not logged in|not signed in/i.test(auth.output))
    return { loggedIn, authMethod: parsed.authMethod, apiProvider: parsed.apiProvider, version: version?.output.trim().split(/\s+/)[0] }
  }

  /** Runs Claude Code's own `auth login`, which opens Anthropic's sign-in page. We only relay the link in case no browser opens. */
  async login(hint: string, signal: AbortSignal, onUrl: (url: string) => void) {
    const launcher = this.resolve(hint)
    const seen = new Set<string>()
    const result = await run(launcher, ['auth', 'login', '--claudeai'], 10 * 60_000, signal, text => {
      for (const url of text.match(/https:\/\/[^\s"'<>]+/g) || []) if (!seen.has(url) && /^https:\/\/([a-z0-9-]+\.)*(claude\.(ai|com)|anthropic\.com)\//i.test(url)) { seen.add(url); onUrl(url) }
    })
    if (result.code !== 0) throw new Error(`Claude Code sign-in did not finish. ${result.output.trim().slice(-300)}`)
  }

  async turn(input: ClaudeTurnInput): Promise<ClaudeTurnResult> {
    const { signal } = input
    signal.throwIfAborted()
    const launcher = this.resolve(input.executable)
    const directory = mkdtempSync(join(tmpdir(), 'rbx-claude-'))
    const token = randomBytes(24).toString('hex')
    let child: ChildProcess | undefined
    let bridge: HttpServer | undefined
    try {
      bridge = createServer(async (req, res) => {
        // Only the Claude Code process started for this turn knows the token.
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
        let body = ''
        for await (const chunk of req) body += chunk
        const server = new Server({ name: 'rbx', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: input.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: 'object' } })) }))
        server.setRequestHandler(CallToolRequestSchema, async request => {
          try {
            const args = request.params.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {}
            return { content: [{ type: 'text' as const, text: await input.execute(request.params.name, args) }] }
          } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] } }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { void transport.close(); void server.close() })
        try { await server.connect(transport); await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined) }
        catch { if (!res.headersSent) res.writeHead(400).end() }
      })
      await new Promise<void>((resolve, reject) => { bridge!.once('error', reject); bridge!.listen(0, '127.0.0.1', resolve) })
      const port = (bridge.address() as { port: number }).port
      const system = join(directory, 'system.md')
      const config = join(directory, 'mcp.json')
      writeFileSync(system, input.turns.filter(t => t.role === 'system').map(t => t.content).join('\n\n'))
      writeFileSync(config, JSON.stringify({ mcpServers: { rbx: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }))
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', input.model,
        '--system-prompt-file', system, '--tools', '', '--strict-mcp-config', '--mcp-config', config, '--allowedTools', 'mcp__rbx__*',
        '--permission-mode', 'dontAsk', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', 'project', ...(input.effort ? ['--effort', input.effort] : [])]
      // An empty working folder keeps project settings, memory files, and hooks from reaching the run.
      child = spawn(launcher.command, [...launcher.args, ...args], { cwd: directory, env: environment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
      const abort = () => child && killTree(child)
      signal.addEventListener('abort', abort, { once: true })
      child.stdin!.on('error', () => {})
      child.stdin!.end(renderPrompt(input.turns))
      let stderr = ''
      child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
      let text = ''
      let final: { is_error?: boolean; result?: string; usage?: Record<string, number>; subtype?: string } | undefined
      let buffer = ''
      const handle = (line: string) => {
        let event: any
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') input.onText(event.event.delta.text)
        else if (event.type === 'result') {
          final = event; text = typeof event.result === 'string' ? event.result : text
          // The answer is complete; do not wait on a process that lingers.
          setTimeout(() => child && killTree(child), 5000).unref()
        }
      }
      child.stdout!.on('data', chunk => {
        buffer += chunk
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, index)); buffer = buffer.slice(index + 1) }
      })
      const code = await new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve) })
      signal.removeEventListener('abort', abort)
      if (buffer.trim()) handle(buffer)
      signal.throwIfAborted()
      if (!final) throw new Error(`Claude Code stopped without an answer${code ? ` (exit ${code})` : ''}. ${boundedText(stderr.trim(), 400)}`.trim())
      if (final.is_error) {
        const message = String(final.result || final.subtype || 'Claude Code reported an error.')
        throw new Error(/login|authenticat|credential|api key|401/i.test(message) ? 'Claude Code is not signed in. Open Providers and select Sign in with Claude.' : message)
      }
      const u = final.usage || {}
      const cached = u.cache_read_input_tokens || 0
      const inputTokens = (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0)
      return { text, tokens: inputTokens + (u.output_tokens || 0), usage: { inputTokens, outputTokens: u.output_tokens || 0, cachedInputTokens: cached } }
    } finally {
      if (child) killTree(child)
      bridge?.close(); bridge?.closeAllConnections?.()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
