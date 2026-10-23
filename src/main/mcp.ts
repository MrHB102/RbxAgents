import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Store } from './store'
import type { McpServer } from '../shared/types'
import { validateEndpoint } from './http'

export const READ_TOOLS = new Set(['get_connected_instances', 'get_studio_state', 'get_game_info', 'get_project_structure', 'get_instance_properties', 'get_instance_children', 'get_script_source', 'get_runtime_logs', 'get_console_output', 'search_game_tree', 'search_files', 'search_objects', 'script_read', 'script_search', 'script_grep', 'get_roblox_docs', 'get_roblox_skills', 'get_asset_details', 'selection_get'])
const mcpRequire = createRequire(import.meta.url)
export function bundledMcpPath() { return mcpRequire.resolve('@chrrxs/robloxstudio-mcp').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') }
export function childEnvironment(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'LANG']) if (process.env[key]) env[key] = process.env[key]!
  return { ...env, ...extra }
}

export class McpManager {
  private clients = new Map<string, Client>()
  private connections = new Map<string, Promise<void>>()
  private queues = new Map<string, Promise<unknown>>()
  private installing = new Set<string>()
  constructor(private store: Store) {}
  async connect(id: string) {
    if (this.clients.has(id)) return
    const current = this.connections.get(id)
    if (current) return current
    const pending = this.open(id).catch(error => {
      const server = this.server(id)
      server.status = 'error'; server.error = this.store.redact(error instanceof Error ? error.message : String(error)); server.tools = []
      this.store.save(); throw error
    }).finally(() => this.connections.delete(id))
    this.connections.set(id, pending)
    return pending
  }
  private async open(id: string) {
    const server = this.server(id)
    server.status = 'connecting'; server.error = undefined; this.store.save()
    const client = new Client({ name: 'RBX Agents', version: '0.1.0' })
    let transport
    if (server.transport === 'bundled') {
      transport = new StdioClientTransport({ command: process.execPath, args: [bundledMcpPath()], env: childEnvironment({ ELECTRON_RUN_AS_NODE: '1', ...(server.pluginDirectory ? { MCP_PLUGINS_DIR: server.pluginDirectory } : {}), ...server.env }), stderr: 'pipe' })
    } else if (server.transport === 'stdio') {
      if (!server.command.trim()) throw new Error('Set the MCP executable first.')
      transport = new StdioClientTransport({ command: server.command, args: server.args, env: childEnvironment(server.env), stderr: 'pipe' })
    } else {
      const url = new URL(validateEndpoint(server.url))
      const token = this.store.secret(`mcp:${id}`)
      const options = token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}
      transport = server.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options)
    }
    client.onclose = () => {
      if (this.clients.get(id) === client) { this.clients.delete(id); server.status = 'disconnected'; server.tools = []; this.store.save() }
    }
    try {
      await client.connect(transport, { timeout: 30_000 })
      const tools = []
      let cursor: string | undefined
      do {
        const page = await client.listTools({ cursor })
        tools.push(...page.tools); cursor = page.nextCursor
        if (tools.length > 1000) throw new Error('The server exceeded the tool catalog limit.')
      } while (cursor)
      server.tools = tools.map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema, readOnly: READ_TOOLS.has(tool.name) }))
      this.clients.set(id, client); server.status = 'connected'
      this.store.log('success', `${server.name} bridge connected`, `${tools.length} MCP tools discovered. Studio instance availability is checked separately.`)
    } catch (error) {
      await client.close().catch(() => {})
      server.status = 'error'; server.error = this.store.redact(error instanceof Error ? error.message : String(error)); server.tools = []
      this.store.save(); throw error
    }
  }
  async disconnect(id: string) {
    await this.connections.get(id)?.catch(() => {})
    const client = this.clients.get(id)
    this.clients.delete(id)
    await client?.close()
    const server = this.server(id); server.status = 'disconnected'; server.tools = []; this.store.save()
  }
  private server(id: string): McpServer {
    const server = this.store.state.servers.find(s => s.id === id)
    if (!server) throw new Error('MCP server not found.')
    return server
  }
  async call(id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    // Serialize calls across agents to prevent interleaved mutations in one Studio.
    const previous = this.queues.get(id) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      await this.connect(id)
      signal?.throwIfAborted()
      const client = this.clients.get(id)
      if (!client) throw new Error('MCP bridge disconnected.')
      return client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, signal })
    })
    this.queues.set(id, pending)
    try { return await pending } finally { if (this.queues.get(id) === pending) this.queues.delete(id) }
  }
  async install(id: string) {
    const server = this.server(id)
    if (server.transport !== 'bundled') throw new Error('Automatic installation is available for the bundled Roblox MCP.')
    if (this.installing.has(id)) throw new Error('The plugin installer is already running.')
    if (process.platform === 'linux' && !server.pluginDirectory) throw new Error('Choose the Studio Plugins folder inside your Wine prefix first.')
    this.installing.add(id)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [bundledMcpPath(), '--install-plugin'], { windowsHide: true, shell: false, env: childEnvironment({ ELECTRON_RUN_AS_NODE: '1', ...(server.pluginDirectory ? { MCP_PLUGINS_DIR: server.pluginDirectory } : {}) }), stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-6000) }
        child.stdout.on('data', capture); child.stderr.on('data', capture)
        const timer = setTimeout(() => { child.kill(); reject(new Error('Plugin installation timed out.')) }, 60_000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Plugin installation failed. ${this.store.redact(output)}`)) })
      })
      server.installed = true; this.store.log('success', 'Studio plugin installed', 'Restart Roblox Studio completely, enable HTTP requests if prompted, and connect the plugin.')
      return { message: 'Plugin installed. Fully close and reopen Roblox Studio, then connect the plugin.' }
    } finally { this.installing.delete(id) }
  }
  async close() { await Promise.allSettled([...this.clients.keys()].map(id => this.disconnect(id))) }
}
