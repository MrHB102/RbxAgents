import { randomUUID } from 'node:crypto'
import type { Agent, Session, Approval } from '../shared/types'
import type { Store } from './store'
import type { Providers, ToolSpec, Turn } from './providers'
import type { McpManager } from './mcp'
import { readSkill } from './skills'

export class AgentRuntime {
  private runs = new Map<string, AbortController>()
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
    session.status = 'running'
    if (!session.messages.length) session.title = content.slice(0, 65)
    session.messages.push({ id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString() })
    session.updatedAt = new Date().toISOString(); this.store.save()
    void this.execute(session, agent, provider, controller).finally(() => { this.runs.delete(sessionId); this.store.save() })
    return { started: true }
  }
  private async execute(session: Session, agent: Agent, provider: Parameters<Providers['turn']>[0], controller: AbortController) {
    const signal = controller.signal
    try {
      const selectedSkills = this.store.state.skills.filter(s => agent.skillIds.includes(s.id))
      const mandatory = selectedSkills.find(s => s.name === 'roblox-collaboration-mode')
      const catalog = selectedSkills.map(s => `- ${s.id}: ${s.description}`).join('\n')
      const instructions = [this.store.state.settings.globalPrompt, agent.systemPrompt, mandatory ? readSkill(mandatory) : '', `Available skills (load them with load_skill):\n${catalog}`, 'Tool availability is not proof that a Studio instance is connected. Inspect get_connected_instances before working. Tool calls may require user approval.'].filter(Boolean).join('\n\n')
      const history = session.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content } as Turn))
      const turns: Turn[] = [{ role: 'system', content: instructions }, ...history]
      const routes = new Map<string, { serverId: string; name: string; readOnly: boolean }>()
      const tools: ToolSpec[] = [{ name: 'load_skill', description: 'Read a selected installed skill or its reference file. Start with SKILL.md, then references/full.md when needed.', parameters: { type: 'object', properties: { skill_id: { type: 'string', enum: selectedSkills.map(s => s.id) }, file: { type: 'string', description: 'Relative file path, default SKILL.md' } }, required: ['skill_id'], additionalProperties: false } }]
      for (const id of agent.mcpIds) {
        await this.mcp.connect(id)
        signal.throwIfAborted()
        const server = this.store.state.servers.find(s => s.id === id)!
        for (const tool of server.tools) {
          if (agent.permission === 'read-only' && !tool.readOnly) continue
          const alias = `mcp_${routes.size}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64)
          routes.set(alias, { serverId: id, name: tool.name, readOnly: tool.readOnly })
          tools.push({ name: alias, description: `[${server.name}] ${tool.description}`.slice(0, 4000), parameters: tool.inputSchema })
        }
      }
      this.store.log('info', `${agent.name} started`, `${provider.name} · ${agent.model}`, agent.id)
      for (let step = 0; step < agent.maxSteps; step++) {
        signal.throwIfAborted()
        if (JSON.stringify(turns).length > 1_500_000) throw new Error('Conversation reached the context limit. Start a new conversation.')
        const message = { id: randomUUID(), role: 'assistant' as const, content: '', createdAt: new Date().toISOString() }
        session.messages.push(message)
        let lastEmit = 0
        const response = await this.providers.turn(provider, agent.model, turns, tools, signal, text => {
          message.content += this.store.redact(text)
          if (Date.now() - lastEmit > 50) { this.store.emit(); lastEmit = Date.now() }
        })
        message.content = this.store.redact(response.text)
        if (!message.content) session.messages = session.messages.filter(m => m.id !== message.id)
        session.tokens += response.tokens
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
              output = readSkill(skill, typeof args.file === 'string' ? args.file : 'SKILL.md')
            } else {
              const route = routes.get(call.name)
              if (!route) throw new Error('The model requested an unavailable tool.')
              if (!route.readOnly) {
                if (agent.permission === 'read-only') throw new Error('This agent only has read access.')
                const approved = await this.approve({ id: randomUUID(), sessionId: session.id, agentId: agent.id, serverId: route.serverId, tool: route.name, args }, signal)
                if (!approved) throw new Error('The user denied this tool call. Respect the decision and do not retry it.')
              }
              signal.throwIfAborted()
              session.status = 'running'; this.store.save()
              const result = await this.mcp.call(route.serverId, route.name, args, signal)
              output = JSON.stringify(result)
              this.store.log('tool', `${agent.name} · ${route.name}`, output.slice(0, 1000), agent.id)
            }
          } catch (error) {
            if (signal.aborted) throw error
            output = JSON.stringify({ error: this.store.redact(error instanceof Error ? error.message : String(error)) })
          }
          if (output.length > 120_000) output = JSON.stringify({ truncated: true, excerpt: output.slice(0, 100_000), instruction: 'Result exceeded the context limit. Request a smaller range.' })
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
  isRunning(id: string) { return this.runs.has(id) }
  close() { for (const controller of this.runs.values()) controller.abort() }
}
