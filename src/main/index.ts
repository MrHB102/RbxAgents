import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { Store } from './store'
import { scanSkills, readSkill, importSkillFolder } from './skills'
import { ChatGPTAuth } from './auth'
import { Providers } from './providers'
import { McpManager } from './mcp'
import { AgentRuntime } from './runtime'
import { validateEndpoint } from './http'
import { CLAUDE_CODE_MODELS } from './claudecode'
import { EFFORTS } from '../shared/commands'
import type { Agent, McpServer, Provider } from '../shared/types'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const short = z.string().trim().min(1).max(200)
const agentSchema = z.object({
  id, name: short, role: short, description: z.string().max(2000), color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  providerId: z.string().max(100), model: z.string().max(200), systemPrompt: z.string().max(100_000), skillIds: z.array(id).max(300), mcpIds: z.array(id).max(30), enabled: z.boolean(), permission: z.enum(['ask', 'read-only', 'unrestricted']), maxSteps: z.number().int().min(1).max(100), tokenBudget: z.number().int().min(1000).max(1_000_000).default(30_000),
  effort: z.enum(EFFORTS).optional(), orchestrator: z.boolean().optional(), web: z.boolean().optional()
})
const providerSchema = z.object({ id, name: short, kind: z.enum(['openai', 'anthropic', 'chatgpt', 'claude-code']), baseUrl: z.string().max(2000), apiKey: z.string().max(20_000).optional(), models: z.array(z.string().max(200)).max(1000).default([]) })
const serverSchema = z.object({ id, name: short, transport: z.enum(['bundled', 'stdio', 'http', 'sse']), command: z.string().max(4000), args: z.array(z.string().max(4000)).max(100), url: z.string().max(2000), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)), pluginDirectory: z.string().max(4000), token: z.string().max(20_000).optional() })

let mainWindow: BrowserWindow | null = null
let store: Store
let auth: ChatGPTAuth
let providers: Providers
let mcp: McpManager
let runtime: AgentRuntime
let quitting = false
const claudeLogins = new Map<string, AbortController>()
const rendererFile = join(import.meta.dirname, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const testDirectory = !app.isPackaged ? process.env.RBX_AGENTS_TEST_DATA : undefined
if (testDirectory) app.setPath('userData', testDirectory)
if (!app.requestSingleInstanceLock()) app.quit()

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'RBX Agents', width: 1440, height: 960, minWidth: 1040, minHeight: 720, backgroundColor: '#1e1f29', show: false,
    frame: false, autoHideMenuBar: true, icon: app.isPackaged ? join(process.resourcesPath, 'resources', 'icon.png') : join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== (devUrl || pathToFileURL(rendererFile).href)) event.preventDefault() })
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(rendererFile)
}

function requireIdleProvider(providerId: string) {
  if (store.state.sessions.some(s => runtime.isRunning(s.id) && store.state.agents.find(a => a.id === s.agentId)?.providerId === providerId)) throw new Error('Stop the agents using this provider before changing its connection.')
}
function providerFor(providerId: string) {
  const provider = store.state.providers.find(p => p.id === providerId)
  if (!provider) throw new Error('Provider not found.')
  return provider
}
async function action(name: string, payload: unknown): Promise<unknown> {
  switch (name) {
    case 'state': return store.snapshot(app.getVersion())
    case 'window:minimize': mainWindow?.minimize(); return
    case 'window:maximize': if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); return
    case 'window:close': mainWindow?.close(); return
    case 'agent:save': {
      const agent = agentSchema.parse(payload) as Agent
      if (agent.providerId && !store.state.providers.some(p => p.id === agent.providerId)) throw new Error('Select an existing provider.')
      if (agent.skillIds.some(skillId => !store.state.skills.some(s => s.id === skillId))) throw new Error('An enabled skill is no longer installed.')
      if (agent.mcpIds.some(serverId => !store.state.servers.some(s => s.id === serverId))) throw new Error('An enabled MCP server no longer exists.')
      const index = store.state.agents.findIndex(a => a.id === agent.id)
      if (index < 0) store.state.agents.push(agent); else store.state.agents[index] = agent
      runtime.setAccess(agent.id, agent.permission)
      store.save(); return agent
    }
    case 'agent:delete': {
      const agentId = id.parse(payload)
      if (store.state.sessions.some(s => s.agentId === agentId && runtime.isRunning(s.id))) throw new Error('Stop this agent before deleting it.')
      store.state.agents = store.state.agents.filter(a => a.id !== agentId)
      store.state.sessions = store.state.sessions.filter(s => s.agentId !== agentId)
      store.save(); return
    }
    case 'provider:save': {
      const data = providerSchema.parse(payload)
      requireIdleProvider(data.id)
      if (data.kind === 'chatgpt') data.baseUrl = 'https://api.openai.com/v1'
      // For Claude Code the endpoint field holds an optional path to the claude executable.
      const baseUrl = data.kind === 'claude-code' ? data.baseUrl.trim() : validateEndpoint(data.baseUrl)
      const existing = store.state.providers.find(p => p.id === data.id)
      if (existing && existing.kind !== data.kind) throw new Error('Create a new provider to change its type.')
      if (existing && existing.baseUrl !== baseUrl && data.apiKey === undefined && store.secret(`provider:${data.id}`)) throw new Error('Enter the API key again when changing its endpoint.')
      if (data.apiKey !== undefined) store.setSecret(`provider:${data.id}`, data.apiKey.trim())
      const provider: Provider = { id: data.id, name: data.name, kind: data.kind, baseUrl, models: data.kind === 'claude-code' ? CLAUDE_CODE_MODELS : data.models, hasKey: data.kind === 'chatgpt' ? !!auth.account(data.id)?.accessToken : !!store.secret(`provider:${data.id}`), status: 'disconnected', account: existing?.account }
      if (existing) store.state.providers[store.state.providers.indexOf(existing)] = provider
      else store.state.providers.push(provider)
      store.save(); return provider
    }
    case 'provider:test': {
      const provider = providerFor(id.parse(payload))
      try {
        if (provider.kind === 'claude-code') {
          const status = await providers.claude.status(provider.baseUrl)
          if (!status.loggedIn) throw new Error('Claude Code is installed but not signed in. Select Sign in with Claude.')
          provider.account = `${status.authMethod === 'claude.ai' ? 'Claude subscription' : status.apiProvider && status.apiProvider !== 'firstParty' ? `Claude via ${status.apiProvider}` : 'Anthropic Console'}${status.version ? ` · Claude Code ${status.version}` : ''}`
        }
        provider.models = await providers.models(provider); provider.status = 'connected'; provider.error = undefined
        store.log('success', `${provider.name} connected`, `${provider.models.length} models available.`)
        return provider.models
      } catch (error) { provider.status = 'error'; provider.error = store.redact(error instanceof Error ? error.message : String(error)); store.save(); throw error }
    }
    case 'provider:login': {
      const provider = providerFor(id.parse(payload))
      if (provider.kind === 'claude-code') {
        // Claude Code runs its own sign-in on Anthropic's site. This app never receives the credentials.
        if (claudeLogins.has(provider.id)) throw new Error('A sign-in is already waiting. Finish it in your browser or cancel it.')
        const controller = new AbortController(); claudeLogins.set(provider.id, controller)
        try {
          await providers.claude.login(provider.baseUrl, controller.signal, url => { provider.loginUrl = url; store.emit() })
          return await action('provider:test', provider.id)
        } finally { claudeLogins.delete(provider.id); provider.loginUrl = undefined; store.emit() }
      }
      if (provider.kind !== 'chatgpt') throw new Error('Browser sign-in is available for ChatGPT connections.')
      requireIdleProvider(provider.id)
      await auth.signIn(provider.id)
      if (provider.status === 'connected') return action('provider:test', provider.id)
      return
    }
    case 'provider:cancel': { const providerId = id.parse(payload); claudeLogins.get(providerId)?.abort(); auth.cancel(providerId); return }
    case 'provider:logout': {
      const provider = providerFor(id.parse(payload)); requireIdleProvider(provider.id)
      const result = provider.kind === 'chatgpt' ? await auth.logout(provider.id) : { revoked: true }
      if (provider.kind !== 'chatgpt') store.setSecret(`provider:${provider.id}`, '')
      provider.hasKey = false; provider.status = 'disconnected'; provider.models = []; store.save()
      if (!result.revoked) store.log('error', 'Signed out locally', 'Remote revocation could not be confirmed. Disconnect RBX Agents in ChatGPT Settings → Usage.')
      return result
    }
    case 'provider:delete': {
      const provider = providerFor(id.parse(payload)); requireIdleProvider(provider.id)
      await action('provider:logout', provider.id)
      store.state.providers = store.state.providers.filter(p => p.id !== provider.id)
      for (const agent of store.state.agents) if (agent.providerId === provider.id) { agent.providerId = ''; agent.model = '' }
      store.save(); return
    }
    case 'mcp:save': {
      const data = serverSchema.parse(payload)
      const existing = store.state.servers.find(s => s.id === data.id)
      if (store.state.sessions.some(s => runtime.isRunning(s.id) && store.state.agents.find(a => a.id === s.agentId)?.mcpIds.includes(data.id))) throw new Error('Stop the agents using this bridge before changing it.')
      if (data.transport === 'bundled' && data.id !== 'roblox') throw new Error('The bundled bridge uses the reserved Roblox connection.')
      if (data.id === 'roblox' && data.transport !== 'bundled') throw new Error('The built-in Roblox bridge must use the bundled transport.')
      if (data.transport === 'http' || data.transport === 'sse') data.url = validateEndpoint(data.url)
      if (existing) await mcp.disconnect(data.id)
      if (data.token !== undefined) store.setSecret(`mcp:${data.id}`, data.token)
      const { token: _token, ...config } = data
      const server: McpServer = { ...config, status: 'disconnected', tools: [], installed: existing?.installed || false }
      if (existing) store.state.servers[store.state.servers.indexOf(existing)] = server
      else store.state.servers.push(server)
      store.save(); return server
    }
    case 'mcp:install': return mcp.install(id.parse(payload))
    case 'mcp:connect': await mcp.connect(id.parse(payload)); return
    case 'mcp:disconnect': {
      const serverId = id.parse(payload)
      if (store.state.sessions.some(s => runtime.isRunning(s.id) && store.state.agents.find(a => a.id === s.agentId)?.mcpIds.includes(serverId))) throw new Error('Stop the agents using this bridge before disconnecting it.')
      await mcp.disconnect(serverId); return
    }
    case 'mcp:instances': return mcp.call('roblox', 'get_connected_instances', {})
    case 'mcp:directory': {
      const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose the Roblox Studio Plugins folder', properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    }
    case 'skill:read': {
      const data = z.object({ id, file: z.string().max(1000).optional() }).parse(payload)
      const skill = store.state.skills.find(s => s.id === data.id)
      if (!skill) throw new Error('Skill not found.')
      return readSkill(skill, data.file)
    }
    case 'skill:import': {
      const result = await dialog.showOpenDialog(mainWindow!, { title: 'Import a skill or collection containing SKILL.md files', properties: ['openDirectory'] })
      if (result.canceled) return 0
      const skills = importSkillFolder(result.filePaths[0], join(app.getPath('userData'), 'skills', randomUUID()))
      store.state.skills.push(...skills); store.log('success', 'Skills imported', `${skills.length} skills added to your library.`); return skills.length
    }
    case 'session:create': {
      const agentId = id.parse(payload)
      if (!store.state.agents.some(a => a.id === agentId)) throw new Error('Agent not found.')
      const now = new Date().toISOString()
      const session = { id: randomUUID(), agentId, title: 'New conversation', messages: [], createdAt: now, updatedAt: now, tokens: 0, status: 'idle' as const }
      store.state.sessions.unshift(session); store.save(); return session.id
    }
    case 'session:delete': {
      const sessionId = id.parse(payload)
      if (runtime.isRunning(sessionId)) throw new Error('Stop this conversation before deleting it.')
      store.state.sessions = store.state.sessions.filter(s => s.id !== sessionId); store.save(); return
    }
    case 'session:send': {
      const data = z.object({ id, content: z.string().trim().min(1).max(100_000) }).parse(payload)
      return runtime.send(data.id, data.content)
    }
    case 'session:stop': runtime.stop(id.parse(payload)); return
    case 'session:model': {
      const data = z.object({ id, model: z.string().trim().min(1).max(300), save: z.boolean().optional() }).parse(payload)
      return runtime.setModel(data.id, data.model, data.save)
    }
    case 'session:effort': {
      const data = z.object({ id, effort: z.enum([...EFFORTS, 'default']) }).parse(payload)
      return runtime.setEffort(data.id, data.effort)
    }
    case 'approval:decide': {
      const data = z.object({ id, allow: z.boolean() }).parse(payload)
      runtime.decide(data.id, data.allow); return
    }
    case 'settings:save': {
      const settings = z.object({ workspace: z.string().max(4000), globalPrompt: z.string().max(100_000), maxConcurrent: z.number().int().min(1).max(8) }).parse(payload)
      store.state.settings = settings; store.save(); return
    }
    case 'web:key': {
      // Optional Brave Search API key. Without it, search uses DuckDuckGo.
      const key = z.string().trim().max(500).parse(payload)
      store.setSecret('web:brave', key); store.save(); return
    }
    case 'settings:workspace': {
      const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose your Roblox project folder', properties: ['openDirectory'] })
      if (result.canceled) return null
      store.state.settings.workspace = result.filePaths[0]; store.save(); return result.filePaths[0]
    }
    case 'settings:export': {
      const result = await dialog.showSaveDialog(mainWindow!, { title: 'Export agent configuration', defaultPath: 'rbx-agents-config.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (result.canceled || !result.filePath) return false
      writeFileSync(result.filePath, JSON.stringify({ version: 1, agents: store.state.agents, globalPrompt: store.state.settings.globalPrompt }, null, 2), { mode: 0o600 })
      return true
    }
    case 'external:open': {
      const url = z.string().url().parse(payload)
      const allowed = ['https://github.com/tabooharmony/roblox-brain', 'https://github.com/Chrrxs/robloxstudio-mcp', 'https://chatgpt.com/settings/usage', 'https://platform.openai.com/api-keys', 'https://console.anthropic.com', 'https://code.claude.com/docs/en/legal-and-compliance']
      if (!allowed.includes(url)) throw new Error('This external link is not allowed.')
      await shell.openExternal(url); return
    }
    default: throw new Error('Unknown application action.')
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  store = new Store(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value)
  })
  const resourceRoot = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  store.state.skills = [...scanSkills(join(resourceRoot, 'roblox-brain', 'skills'), true, 'TabooHarmony/roblox-brain'), ...scanSkills(join(app.getPath('userData'), 'skills'), false, 'Local import')]
  mkdirSync(join(app.getPath('userData'), 'skills'), { recursive: true })
  auth = new ChatGPTAuth(store, url => shell.openExternal(url))
  providers = new Providers(store, auth); mcp = new McpManager(store); runtime = new AgentRuntime(store, providers, mcp)
  store.subscribe(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rbx:state', store.snapshot(app.getVersion())) })
  ipcMain.handle('rbx:action', async (event, name: unknown, payload: unknown) => {
    const sender = event.senderFrame
    const expected = devUrl ? new URL(devUrl).origin : pathToFileURL(rendererFile).href
    if (!sender || sender !== event.sender.mainFrame || (devUrl ? new URL(sender.url).origin !== expected : sender.url !== expected)) throw new Error('Untrusted application frame.')
    try { return await action(z.string().max(100).parse(name), payload) }
    catch (error) { throw new Error(store.redact(error instanceof z.ZodError ? 'Check the form fields and try again.' : error instanceof Error ? error.message : String(error))) }
  })
  createWindow()
  app.on('activate', () => { if (!mainWindow) createWindow() })
})
app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus() })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (quitting || !runtime) return
  event.preventDefault(); quitting = true; runtime.close(); auth.close()
  void Promise.race([mcp.close(), new Promise(resolve => setTimeout(resolve, 3000))]).finally(() => { store.save(); app.quit() })
})
