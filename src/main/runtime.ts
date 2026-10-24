import { randomUUID } from 'node:crypto'
import type { Agent, Session, Approval } from '../shared/types'
import type { Store } from './store'
import type { Providers, ToolSpec, Turn } from './providers'
import type { McpManager } from './mcp'
import { readSkill } from './skills'
import { boundedText, compactTurns, findTools, skillPage, toolResultText, CONTEXT_CHARACTERS, DEFAULT_TOKEN_BUDGET, MAX_OUTPUT_TOKENS } from './context'

export class AgentRuntime {
  private runs = new Map<string, AbortController>()
  private runAgents = new Map<string, Agent>()
  private decisions = new Map<string, (allow: boolean) => void>()
  constructor(private store: Store, private providers: Providers, private mcp: McpManager) {}
  async send(sessionId: string, content: string) {
    if (this.runs.has(sessionId)) throw new Error('This conversation is already running.')
    if (this.runs.size >= this.store.state.settings.maxConcurrent) throw new Error('The concurrent agent limit has been reached. Wait for a run to finish.')
    const session = this.store.state.sessions.find(s => s.id === sessionId)
    if (!session) throw new Error('Conversation not found.')
    const agent = structuredClone(this.store.state.agents.find(a => a.id === session.agentId))
    if (!agent?.enabled) throw new Error('This agent is paused or no longer exists.')
    const provider = structuredClone(this.store.state.providers.find(p => p.id === agent.providerId))
    if (!provider || !agent.model.trim()) throw new Error('Choose a provider and model in the agent settings first.')
    const controller = new AbortController()
    this.runs.set(sessionId, controller)
    this.runAgents.set(sessionId, agent)
    session.lastRun = { tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, contextCharacters: 0, budget: agent.tokenBudget ?? DEFAULT_TOKEN_BUDGET, estimated: false }
    session.status = 'running'
    if (!session.messages.length) session.title = content.slice(0, 65)
    session.messages.push({ id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString() })
    session.updatedAt = new Date().toISOString(); this.store.save()
    void this.execute(session, agent, provider, controller).finally(() => { this.runs.delete(sessionId); this.runAgents.delete(sessionId); this.store.save() })
    return { started: true }
  }
  private async execute(session: Session, agent: Agent, provider: Parameters<Providers['turn']>[0], controller: AbortController) {
    const signal = controller.signal
    try {
      const selectedSkills = this.store.state.skills.filter(s => agent.skillIds.includes(s.id))
      const catalog = selectedSkills.map(s => `- ${s.id}: ${s.description.slice(0, 100)}`).join('\n')
      const permission = () => agent.permission === 'unrestricted'
        ? 'The user enabled Unrestricted access for this agent. Execute available tools without asking for approval, including writes. This access setting overrides generic approval guidance in prompts and skills. Stay within the task; respect Stop and token limits.'
        : agent.permission === 'read-only' ? 'Read-only access: do not perform mutations.' : 'Ask before changes: mutation tools require application approval.'
      const instructions = [this.store.state.settings.globalPrompt, agent.systemPrompt, `Available skills (load only relevant pages with load_skill):\n${catalog}`, 'Economy mode: keep replies concise. Search for a specific MCP tool with search_tools, then execute it with call_tool. Load skills only when needed; do not repeatedly load the same page. Request bounded script/log ranges. Older context may be omitted to save tokens; re-inspect if needed. Tool availability is not proof of a connected Studio: inspect get_connected_instances first.', `MCP connections: ${agent.mcpIds.join(', ') || 'none'}.`].filter(Boolean).join('\n\n')
      const history = session.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content } as Turn))
      let turns: Turn[] = [{ role: 'system', content: `${instructions}\n\n${permission()}` }, ...history]
      const servers = []
      const loadedPages = new Map<string, string>()
      const tools: ToolSpec[] = selectedSkills.length ? [{ name: 'load_skill', description: 'Read one page of an enabled skill. Start with SKILL.md; use references/full.md for details. Continue at nextOffset only when needed.', parameters: { type: 'object', properties: { skill_id: { type: 'string', enum: selectedSkills.map(s => s.id) }, file: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 500, maximum: 5000 } }, required: ['skill_id'], additionalProperties: false } }] : []
      for (const id of agent.mcpIds) {
        await this.mcp.connect(id)
        signal.throwIfAborted()
        const server = this.store.state.servers.find(s => s.id === id)!
        servers.push(structuredClone(server))
      }
      if (servers.length) tools.push(
        { name: 'search_tools', description: 'Find relevant MCP tools and their argument schemas. Search specific actions, for example connected instances, read script, or execute_luau.', parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['query'], additionalProperties: false } },
        { name: 'call_tool', description: 'Execute a tool discovered with search_tools. Use its exact server_id, tool name, and arguments. Access mode is enforced by the application.', parameters: { type: 'object', properties: { server_id: { type: 'string', enum: servers.map(s => s.id) }, name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['server_id', 'name', 'arguments'], additionalProperties: false } }
      )
      const toolCharacters = JSON.stringify(tools).length
      this.store.log('info', `${agent.name} started`, `${provider.name} · ${agent.model}`, agent.id)
      for (let step = 0; step < agent.maxSteps; step++) {
        signal.throwIfAborted()
        turns[0].content = `${instructions}\n\n${permission()}`
        turns = compactTurns(turns, CONTEXT_CHARACTERS - toolCharacters)
        const usage = session.lastRun!
        usage.contextCharacters = JSON.stringify(turns).length + toolCharacters
        const estimatedInput = Math.ceil(usage.contextCharacters / 3)
        const remaining = usage.budget - usage.tokens
        if (estimatedInput + 128 > remaining) throw new Error('Token budget reached for this message. Progress is saved. Send another message to continue, or change the agent’s token budget.')
        usage.requests++
        const message = { id: randomUUID(), role: 'assistant' as const, content: '', createdAt: new Date().toISOString() }
        session.messages.push(message)
        let lastEmit = 0
        const response = await this.providers.turn(provider, agent.model, turns, tools, signal, text => {
          message.content += this.store.redact(text)
          if (Date.now() - lastEmit > 50) { this.store.emit(); lastEmit = Date.now() }
        }, { maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, remaining - estimatedInput) })
        message.content = this.store.redact(response.text)
        if (!message.content) session.messages = session.messages.filter(m => m.id !== message.id)
        const used = response.tokens || estimatedInput + Math.ceil(response.text.length / 3) + Math.ceil(JSON.stringify(response.calls).length / 3)
        session.tokens += used; usage.tokens += used
        usage.inputTokens += response.usage?.inputTokens || (response.tokens ? 0 : estimatedInput)
        usage.outputTokens += response.usage?.outputTokens || 0
        usage.cachedInputTokens += response.usage?.cachedInputTokens || 0
        usage.estimated ||= !response.tokens
        if (!response.calls.length) {
          session.status = 'idle'; this.store.log('success', `${agent.name} finished`, session.title, agent.id); return
        }
        if (response.calls.length > 32) throw new Error('The model requested too many tools in one step.')
        turns.push({ role: 'assistant', content: response.text, tool_calls: response.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) })
        for (const call of response.calls) {
          signal.throwIfAborted()
          let output: string
          try {
            const args = JSON.parse(call.arguments)
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.')
            if (call.name === 'load_skill') {
              const skill = selectedSkills.find(s => s.id === args.skill_id)
              if (!skill) throw new Error('This skill is not enabled for the agent.')
              const file = typeof args.file === 'string' ? args.file : 'SKILL.md'
              const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
              const length = Number.isSafeInteger(args.length) ? Math.min(5000, Math.max(500, args.length)) : 4000
              const key = `${skill.id}:${file}:${offset}:${length}`
              const previous = loadedPages.get(key)
              if (previous && turns.some(t => t.role === 'tool' && t.content === previous)) output = JSON.stringify({ alreadyLoaded: true, skill_id: skill.id, file, offset, instruction: 'Reuse the page already in context; load a different offset only if needed.' })
              else {
                const text = readSkill(skill, file)
                output = skillPage(text, skill.id, file, offset, length)
                loadedPages.set(key, output)
              }
            } else if (call.name === 'search_tools') {
              if (typeof args.query !== 'string' || args.query.length > 200) throw new Error('Provide a short tool search query.')
              output = JSON.stringify(findTools(servers, args.query, agent.permission === 'read-only', Number.isSafeInteger(args.limit) ? args.limit : 3))
            } else {
              if (call.name !== 'call_tool') throw new Error('The model requested an unavailable tool.')
              const server = servers.find(s => s.id === args.server_id)
              const tool = server?.tools.find(t => t.name === args.name)
              if (!server || !tool) throw new Error('The model requested an unavailable tool.')
              const toolArgs = args.arguments
              if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) throw new Error('Tool arguments must be an object.')
              if (!tool.readOnly) {
                if (agent.permission === 'read-only') throw new Error('This agent only has read access.')
                if (agent.permission !== 'unrestricted') {
                  const approved = await this.approve({ id: randomUUID(), sessionId: session.id, agentId: agent.id, serverId: server.id, tool: tool.name, args: toolArgs }, signal)
                  if (!approved) throw new Error('The user denied this tool call. Respect the decision and do not retry it.')
                }
              }
              signal.throwIfAborted()
              if (!tool.readOnly && agent.permission === 'read-only') throw new Error('This agent only has read access.')
              session.status = 'running'; this.store.save()
              const accessAtDispatch = agent.permission
              const result = await this.mcp.call(server.id, tool.name, toolArgs, signal, () => {
                if (!tool.readOnly && agent.permission === 'read-only') throw new Error('This agent only has read access.')
                if (!tool.readOnly && accessAtDispatch === 'unrestricted' && agent.permission === 'ask') throw new Error('The access mode changed before this queued action ran. Request the tool again to obtain approval.')
              })
              output = toolResultText(result)
              this.store.log('tool', `${agent.name} · ${tool.name}`, output.slice(0, 1000), agent.id)
            }
          } catch (error) {
            if (signal.aborted) throw error
            output = JSON.stringify({ error: this.store.redact(error instanceof Error ? error.message : String(error)) })
          }
          output = boundedText(output)
          turns.push({ role: 'tool', content: output, tool_call_id: call.id })
          session.messages.push({ id: randomUUID(), role: 'tool', content: `${call.name}\n${this.store.redact(output)}`, createdAt: new Date().toISOString() })
          this.store.save()
        }
      }
      throw new Error(`Stopped after ${agent.maxSteps} model steps. Review progress and send another message to continue.`)
    } catch (error) {
      session.status = signal.aborted ? 'idle' : 'error'
      const detail = signal.aborted ? 'Run stopped by you.' : this.store.redact(error instanceof Error ? error.message : String(error))
      session.messages.push({ id: randomUUID(), role: 'system', content: detail, createdAt: new Date().toISOString() })
      this.store.log(signal.aborted ? 'info' : 'error', `${agent.name} ${signal.aborted ? 'stopped' : 'needs attention'}`, detail, agent.id)
    } finally {
      session.updatedAt = new Date().toISOString()
      for (const approval of this.store.approvals.filter(a => a.sessionId === session.id)) this.decide(approval.id, false)
    }
  }
  private approve(approval: Approval, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    this.store.approvals.push(approval)
    const session = this.store.state.sessions.find(s => s.id === approval.sessionId)
    if (session) session.status = 'waiting'
    this.store.save()
    return new Promise(resolve => {
      const abort = () => this.decide(approval.id, false)
      this.decisions.set(approval.id, allow => { signal.removeEventListener('abort', abort); resolve(allow) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  decide(id: string, allow: boolean) {
    const resolve = this.decisions.get(id)
    if (!resolve) return
    this.decisions.delete(id); this.store.approvals = this.store.approvals.filter(a => a.id !== id)
    resolve(allow); this.store.emit()
  }
  stop(id: string) { this.runs.get(id)?.abort() }
  setAccess(agentId: string, permission: Agent['permission']) {
    for (const agent of this.runAgents.values()) if (agent.id === agentId) agent.permission = permission
    if (permission !== 'ask') for (const approval of [...this.store.approvals]) if (approval.agentId === agentId) this.decide(approval.id, permission === 'unrestricted')
  }
  isRunning(id: string) { return this.runs.has(id) }
  close() { for (const controller of this.runs.values()) controller.abort() }
}
