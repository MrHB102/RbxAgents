import { randomUUID } from 'node:crypto'
import { abortable } from './async'
import { extname } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Agent, Approval, Effort, MediaItem, McpServer, Message, PlanStep, Provider, RunUsage, Session, Skill, ThreadUsage } from '../shared/types'
import { SLASH_COMMANDS, parseCommand, parseEffort } from '../shared/commands'
import { BLENDER_ID } from '../shared/defaults'
import type { Store } from './store'
import type { Providers, ToolSpec, Turn } from './providers'
import type { McpManager } from './mcp'
import { readSkill } from './skills'
import { instructions, roster } from './prompts'
import { realWeb, webPage, type WebTools } from './web'
import { parsePreview, previewOptions, previewScript } from './blender'
import { SHAREABLE, type MediaStore } from './media'
import { boundedText, clip, compactTurns, contextSize, findTools, foldAll, foldHistory, historyTurns, memoryBlock, memoryOf, outputCap, pinPage, skillPageParts, toolResultText, CONTEXT_CHARACTERS } from './context'
import { ensureBrief, qualityReview, qualityTools, updateBrief, visualRequest } from './quality'
import { MAX_IMAGE_BYTES, visionImages, type VisionImage } from './vision'

const PALETTE = ['#bd93f9', '#50fa7b', '#8be9fd', '#ffb86c', '#ff79c6', '#f1fa8c']
const BTW_PROMPT = 'You answer a quick side question (/btw) asked while a task may be in progress. Use only the conversation excerpt and memory below. You have no tools and must not claim to have done or checked anything. If the question needs tool work or would change the task, say so in one line and suggest sending it as a normal message. Reply in the user\'s language, in at most 150 words.'
function error(value: unknown) { return value instanceof Error ? value.message : String(value) }

/** One model conversation inside a run: the primary agent, or a worker thread started by the Master. */
interface Participant {
  agent: Agent; primary: boolean; turns: Turn[]; tools: ToolSpec[]; skills: Skill[]; servers: McpServer[]
  memory: string; pinned: Set<string>; loaded: Map<string, string>
  id?: string; usage?: ThreadUsage; spent: number; busy: boolean
  /** The provider runs its own tool loop (Claude Code), so tool rounds never appear in `turns`. */
  native?: boolean
  lastReport?: string
}
interface Run {
  session: Session; controller: AbortController; signal: AbortSignal; usage: RunUsage; primary: Agent
  threads: Map<string, Participant>; queue: string[]; counter: number
  slots: { free: number; waiting: (() => void)[] }
  webPages: Map<string, { url: string; title: string; text: string; truncated: boolean }>
  revision: number; observedRevision: number; imageRevision: number; images: VisionImage[]; pendingWrites: number
  review?: { revision: number; verdict: string }; qualityReminders: number
}

/** Resolves `/model` arguments: `name`, or `Provider name:model`. Partial names match when unambiguous. */
export function resolveModel(argument: string, providers: Provider[], currentProviderId: string): { providerId: string; model: string; note?: string } | { error: string } {
  let providerId = currentProviderId
  let name = argument.trim()
  const colon = name.indexOf(':')
  if (colon > 0) {
    const named = providers.find(p => p.name.toLowerCase() === name.slice(0, colon).trim().toLowerCase() || p.id === name.slice(0, colon).trim())
    if (named) { providerId = named.id; name = name.slice(colon + 1).trim() }
  }
  const provider = providers.find(p => p.id === providerId)
  if (!provider) return { error: 'Choose a provider for this agent first (Agents → Configure).' }
  if (!name) return { error: 'Give a model name.' }
  const lower = name.toLowerCase()
  const exact = provider.models.find(m => m.toLowerCase() === lower)
  if (exact) return { providerId, model: exact }
  const partial = provider.models.filter(m => m.toLowerCase().includes(lower))
  if (partial.length === 1) return { providerId, model: partial[0] }
  if (partial.length > 1) return { error: `"${name}" matches several models: ${partial.slice(0, 8).join(', ')}${partial.length > 8 ? ', …' : ''}. Be more specific.` }
  return { providerId, model: name, note: provider.models.length ? `"${name}" is not in ${provider.name}'s discovered model list; using it as typed.` : undefined }
}

export class AgentRuntime {
  private runs = new Map<string, Run>()
  private sideRuns = new Map<string, Set<AbortController>>()
  private decisions = new Map<string, (allow: boolean) => void>()
  constructor(private store: Store, private providers: Providers, private mcp: McpManager, private web: WebTools = realWeb, private media?: MediaStore) {}

  // ---- Entry points -------------------------------------------------------------------------------------------

  async send(sessionId: string, content: string) {
    const session = this.session(sessionId)
    const command = parseCommand(content)
    if (command) { await this.command(session, command.name, command.args); return { command: true } }
    const run = this.runs.get(sessionId)
    if (run) return this.enqueue(run, session, content)
    return this.start(session, content)
  }

  private session(id: string) {
    const session = this.store.state.sessions.find(s => s.id === id)
    if (!session) throw new Error('Conversation not found.')
    return session
  }

  /** The agent is busy: the message joins the run and is delivered before the next model request. */
  private enqueue(run: Run, session: Session, content: string) {
    const message: Message = { id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString(), kind: 'queued' }
    session.messages.push(message); run.queue.push(message.id)
    session.updatedAt = message.createdAt; this.store.save()
    return { queued: true }
  }

  private start(session: Session, content: string) {
    if (this.runs.size >= this.store.state.settings.maxConcurrent) throw new Error('The concurrent agent limit has been reached. Wait for a run to finish.')
    const agent = structuredClone(this.store.state.agents.find(a => a.id === session.agentId))
    if (!agent?.enabled) throw new Error('This agent is paused or no longer exists.')
    this.config(session, agent, true)
    const controller = new AbortController()
    const usage: RunUsage = { tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, contextCharacters: 0, estimated: false, threads: [] }
    const run: Run = { session, controller, signal: controller.signal, usage, primary: agent, threads: new Map(), queue: [], counter: 0, slots: { free: Math.max(1, this.store.state.settings.maxConcurrent), waiting: [] }, webPages: new Map(), revision: 0, observedRevision: -1, imageRevision: -1, images: [], pendingWrites: 0, qualityReminders: 0 }
    this.runs.set(session.id, run)
    session.lastRun = usage
    session.status = 'running'
    if (!session.messages.some(m => m.role === 'user' && m.kind !== 'btw' && m.kind !== 'command')) session.title = content.slice(0, 65)
    session.messages.push({ id: randomUUID(), role: 'user', content, createdAt: new Date().toISOString() })
    const existingBrief = session.memory?.brief
    const brief = ensureBrief(session)
    if (session.memory?.review) session.memory.review.current = false
    if (existingBrief) {
      brief.updates.push(content)
      if (visualRequest(content)) brief.visual = true
      while (brief.updates.length > 1 && (brief.updates.length > 8 || brief.updates.join('\n').length > 16_000)) brief.updates.shift()
    }
    session.updatedAt = new Date().toISOString(); this.store.save()
    void this.execute(run).finally(() => { this.runs.delete(session.id); this.store.save() })
    return { started: true }
  }

  /** Model, provider, and effort for the next request. A `/model` or `/effort` change applies at the next step. */
  private config(source: Session | Run, agent: Agent, primary: boolean) {
    const session = 'session' in source ? source.session : source
    const override = primary ? session.overrides : undefined
    const provider = this.store.state.providers.find(p => p.id === (override?.providerId || agent.providerId))
    const model = (override?.model || agent.model).trim()
    if (!provider || !model) throw new Error('Choose a provider and model in the agent settings first.')
    return { provider: structuredClone(provider), model, effort: override?.effort ?? agent.effort }
  }

  // ---- The run ------------------------------------------------------------------------------------------------

  private async execute(run: Run) {
    const { session, signal } = run
    const agent = run.primary
    try {
      foldHistory(session)
      const primary = await this.participant(run, agent, true, historyTurns(session))
      const cfg = this.config(run, agent, true)
      this.store.log('info', `${agent.name} started`, `${cfg.provider.name} · ${cfg.model}${cfg.effort ? ` · ${cfg.effort} effort` : ''}`, agent.id)
      await this.converse(run, primary)
      session.status = 'idle'; this.store.log('success', `${agent.name} finished`, session.title, agent.id)
    } catch (e) {
      session.status = signal.aborted ? 'idle' : 'error'
      const detail = signal.aborted ? 'Run stopped by you.' : this.store.redact(error(e))
      session.messages.push({ id: randomUUID(), role: 'system', content: detail, createdAt: new Date().toISOString() })
      this.store.log(signal.aborted ? 'info' : 'error', `${agent.name} ${signal.aborted ? 'stopped' : 'needs attention'}`, detail, agent.id)
    } finally {
      // Native providers may return while a tool callback is still running. No worker outlives its run.
      run.controller.abort()
      // Updates that never reached the model stay in the transcript and join the next run's history.
      for (const message of session.messages) if (message.kind === 'queued') delete message.kind
      for (const thread of run.usage.threads || []) if (thread.status === 'running') thread.status = 'error'
      session.updatedAt = new Date().toISOString()
      for (const approval of this.store.approvals.filter(a => a.sessionId === session.id)) this.decide(approval.id, false)
    }
  }

  private serverSnapshot(ids: string[]) {
    return ids.map(id => structuredClone(this.store.state.servers.find(s => s.id === id)!))
  }

  /** Builds the system blocks, tool set, and MCP connections for one conversation participant. */
  private async participant(run: Run, agent: Agent, primary: boolean, history: Turn[]): Promise<Participant> {
    const skills = this.store.state.skills.filter(s => agent.skillIds.includes(s.id))
    for (const id of agent.mcpIds) {
      await abortable(this.mcp.connect(id), run.signal)
      run.signal.throwIfAborted()
    }
    const servers = this.serverSnapshot(agent.mcpIds)
    const tools: ToolSpec[] = []
    if (skills.length) tools.push({ name: 'load_skill', description: 'Read one page of an enabled skill. Start with SKILL.md; use references/full.md for details. Continue at nextOffset only when needed.', parameters: { type: 'object', properties: { skill_id: { type: 'string', enum: skills.map(s => s.id) }, file: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 500, maximum: 5000 } }, required: ['skill_id'], additionalProperties: false } })
    if (servers.length) tools.push(
      { name: 'search_tools', description: 'Find relevant MCP tools and their argument schemas. Search specific actions, for example connected instances, read script, or execute_luau.', parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['query'], additionalProperties: false } },
      { name: 'call_tool', description: 'Execute a tool discovered with search_tools. Use its exact server_id, tool name, and arguments. Access mode is enforced by the application.', parameters: { type: 'object', properties: { server_id: { type: 'string', enum: servers.map(s => s.id) }, name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['server_id', 'name', 'arguments'], additionalProperties: false } }
    )
    // Agents with the Blender connection can put renders and images in the chat.
    if (this.media && servers.some(s => s.id === BLENDER_ID)) tools.push(...this.mediaToolSpecs())
    if (agent.orchestrator) tools.push(...this.masterTools())
    // Orchestrators delegate research; their workers read the web.
    else if (agent.web !== false) tools.push(...this.webToolSpecs())
    tools.push(...qualityTools(primary))
    // The primary agent gets the whole memory; a worker only sees the skill pages relevant to it.
    const memory = memoryBlock(run.session, primary ? {} : { skillIds: agent.skillIds, pinsOnly: true })
    const pinned = new Set(memoryOf(run.session).pins.filter(p => primary || agent.skillIds.includes(p.skillId)).map(p => p.key))
    const turns: Turn[] = [{ role: 'system', content: '' }, { role: 'system', content: memory }, ...history]
    return { agent, primary, turns, tools, skills, servers, memory, pinned, loaded: new Map(), spent: 0, busy: false }
  }

  /** The shared agent loop: model request, tool calls, repeat. Used by the primary agent and by every worker thread. */
  private async converse(run: Run, p: Participant): Promise<{ text: string; status: 'done' }> {
    const { session, signal } = run
    const toolCharacters = JSON.stringify(p.tools).length
    let last = ''
    // No step or token limit: the run ends when the model stops calling tools, or when the user presses Stop.
    while (true) {
      signal.throwIfAborted()
      if (p.primary) this.deliverQueue(run, p)
      const cfg = this.config(run, p.agent, p.primary)
      p.turns[0].content = instructions({ global: this.store.state.settings.globalPrompt, agent: p.agent, skills: p.skills, state: this.store.state, worker: !p.primary })
      p.turns[1].content = memoryBlock(session, p.primary ? {} : { skillIds: p.agent.skillIds, pinsOnly: true })
      p.turns = compactTurns(p.turns, CONTEXT_CHARACTERS - toolCharacters)
      const context = contextSize(p.turns) + toolCharacters
      if (p.primary) run.usage.contextCharacters = context
      const estimatedInput = Math.ceil(context / 3) + p.turns.reduce((sum, t) => sum + (t.images?.length || 0) * 1500, 0)
      run.usage.requests++
      if (p.usage) p.usage.requests++
      p.native = cfg.provider.kind === 'claude-code'
      let message: Message | undefined
      const open = () => { if (p.primary && !message) { message = { id: randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString() }; session.messages.push(message) } }
      const close = () => { if (message && !message.content) session.messages = session.messages.filter(m => m.id !== message!.id); message = undefined }
      open()
      let lastEmit = 0
      // Claude Code runs the whole tool loop itself and calls back here for each tool, so rows keep their order in the transcript.
      const execute = p.native ? async (name: string, args: Record<string, unknown>) => {
        signal.throwIfAborted()
        close()
        const { output, label, media, images } = await this.runTool(run, p, { id: randomUUID(), name, arguments: JSON.stringify(args) })
        signal.throwIfAborted()
        const bounded = boundedText(output)
        session.messages.push({ id: randomUUID(), role: 'tool', content: `${label}\n${this.store.redact(bounded)}`, createdAt: new Date().toISOString(), ...(p.primary ? {} : { agentId: p.agent.id }), ...(media ? { media } : {}) })
        this.store.save()
        const update = p.primary ? this.takeQueue(run) : ''
        const text = update ? `${bounded}\n\n${update}` : bounded
        return images?.length ? { text, images } : text
      } : undefined
      const response = await abortable(this.providers.turn(cfg.provider, cfg.model, p.turns, p.tools, signal, chunk => {
        if (signal.aborted || !p.primary) return
        open()
        message!.content += this.store.redact(chunk)
        if (Date.now() - lastEmit > 50) { this.store.emit(); lastEmit = Date.now() }
      }, { maxOutputTokens: outputCap(cfg.effort), effort: cfg.effort, execute }), signal)
      signal.throwIfAborted()
      if (response.text) open()
      if (message) message.content = this.store.redact(response.text)
      const completedMessage = message
      close()
      const used = response.tokens || estimatedInput + Math.ceil(response.text.length / 3) + Math.ceil(JSON.stringify(response.calls).length / 3)
      session.tokens += used; run.usage.tokens += used; p.spent += used
      if (p.usage) p.usage.tokens += used
      run.usage.inputTokens += response.usage?.inputTokens || (response.tokens ? 0 : estimatedInput)
      run.usage.outputTokens += response.usage?.outputTokens || 0
      run.usage.cachedInputTokens += response.usage?.cachedInputTokens || 0
      run.usage.estimated ||= !response.tokens
      last = response.text || last
      if (!response.calls.length) {
        p.turns.push({ role: 'assistant', content: response.text, ...(response.responseItems ? { responseItems: response.responseItems } : {}) })
        if (p.primary && run.queue.length) continue
        if (p.primary && ensureBrief(session).visual && run.revision > 0 && (!ensureBrief(session).acceptance.length || !run.review || run.review.revision !== run.revision || run.review.verdict === 'revise')) {
          if (completedMessage) completedMessage.content = 'Checking visual acceptance before completing the task…'
          if (++run.qualityReminders > 2) throw new Error('The visual work ended without a current acceptance review. Its appearance remains unverified; capture the result and assess_quality before claiming completion.')
          p.turns.push({ role: 'user', content: 'The current visual revision has no accepted quality review. Inspect its actual image, compare each shared acceptance criterion, repair actionable defects and call assess_quality. If evidence or capability is unavailable, record verdict blocked with the concrete limitation and explain the unfinished work.' })
          continue
        }
        if (p.primary && run.review?.verdict === 'blocked') this.note(session, 'Some acceptance criteria remain unverified. The quality review records the blockers; this is not a verified visual pass.')
        return { text: response.text || last, status: 'done' }
      }
      p.turns.push({ role: 'assistant', content: response.text, tool_calls: response.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })), ...(response.thinking ? { thinking: response.thinking } : {}), ...(response.responseItems ? { responseItems: response.responseItems } : {}) })
      const delegations = p.agent.orchestrator && response.calls.length > 1 && response.calls.every(c => c.name === 'delegate' || c.name === 'send_to_agent')
      const outputs = delegations ? await Promise.all(response.calls.map(c => this.runTool(run, p, c))) : undefined
      for (const [index, call] of response.calls.entries()) {
        signal.throwIfAborted()
        const { output, label, media, images } = outputs ? outputs[index] : await this.runTool(run, p, call)
        const bounded = boundedText(output)
        p.turns.push({ role: 'tool', content: bounded, tool_call_id: call.id, ...(images?.length ? { images } : {}) })
        session.messages.push({ id: randomUUID(), role: 'tool', content: `${label}\n${this.store.redact(bounded)}`, createdAt: new Date().toISOString(), ...(p.primary ? {} : { agentId: p.agent.id }), ...(media ? { media } : {}) })
        this.store.save()
      }
    }
  }

  /** Messages typed while the agent works become user turns before the next model request. */
  private deliverQueue(run: Run, p: Participant) {
    if (!run.queue.length) return
    p.turns.push({ role: 'user', content: this.takeQueue(run) })
  }
  /** Marks queued messages as delivered and returns them as one update block. */
  private takeQueue(run: Run) {
    if (!run.queue.length) return ''
    const ids = new Set(run.queue); run.queue = []
    const delivered = run.session.messages.filter(m => ids.has(m.id))
    const brief = ensureBrief(run.session)
    brief.updates.push(...delivered.map(m => m.content))
    if (delivered.some(m => visualRequest(m.content))) brief.visual = true
    while (brief.updates.length > 1 && (brief.updates.length > 8 || brief.updates.join('\n').length > 16_000)) brief.updates.shift()
    run.review = undefined
    if (run.session.memory?.review) run.session.memory.review.current = false
    for (const message of delivered) delete message.kind
    this.store.save()
    return `[User update, sent while you were working]\n${delivered.map(m => m.content).join('\n\n')}`
  }

  // ---- Tools --------------------------------------------------------------------------------------------------

  private label(name: string, args: Record<string, unknown>, who: Participant) {
    const detail = name === 'call_tool' ? `${String(args.name || name)} ${clip(JSON.stringify(args.arguments ?? {}), 70)}`
      : name === 'load_skill' ? `load_skill ${String(args.skill_id || '')} ${String(args.file || 'SKILL.md')}${args.offset ? `@${args.offset}` : ''}`
      : name === 'delegate' && Array.isArray(args.tasks) ? `delegate → ${args.tasks.map((t: any) => this.store.state.agents.find(a => a.id === t?.agent_id)?.name || t?.agent_id).join(', ')}`
      : `${name} ${clip(JSON.stringify(args), 70)}`
    return who.primary ? detail.trim() : `${who.agent.name} · ${detail.trim()}`
  }

  private async runTool(run: Run, p: Participant, call: { id: string; name: string; arguments: string }): Promise<{ output: string; label: string; media?: MediaItem[]; images?: VisionImage[] }> {
    const { signal } = run
    let args: Record<string, any> = {}
    let output: string
    let media: MediaItem[] | undefined
    let images: VisionImage[] | undefined
    let observation = false
    try {
      signal.throwIfAborted()
      try { args = JSON.parse(call.arguments) } catch { throw new Error('Tool arguments must be valid JSON.') }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.')
      if (call.name === 'load_skill') output = this.loadSkill(run, p, args)
      else if (call.name === 'search_tools') {
        if (typeof args.query !== 'string' || args.query.length > 200) throw new Error('Provide a short tool search query.')
        output = JSON.stringify(findTools(p.servers, args.query, p.agent.permission === 'read-only', Number.isSafeInteger(args.limit) ? args.limit : 3))
      } else if (call.name === 'call_tool') { const result = await this.callTool(run, p, args); output = result.output; images = result.images; observation = result.observation }
      else if (call.name === 'set_brief' && p.primary) { output = updateBrief(run.session, args); run.review = undefined; if (run.session.memory?.review) run.session.memory.review.current = false; this.store.save() }
      else if (call.name === 'assess_quality') {
        const brief = ensureBrief(run.session)
        const review = qualityReview(args, { changed: run.revision > 0, observed: !run.pendingWrites && run.observedRevision === run.revision, visual: brief.visual, imageObserved: !run.pendingWrites && run.imageRevision === run.revision }, p.primary ? brief.acceptance : [])
        if (p.primary) { run.review = { revision: run.revision, verdict: review.verdict }; memoryOf(run.session).review = { ...review, current: true }; this.store.save() }
        output = JSON.stringify(review)
      }
      else if ((call.name === 'web_search' || call.name === 'web_fetch') && p.tools.some(t => t.name === call.name)) output = await this.webTool(run, p, call.name, args)
      else if (['render_preview', 'share_media', 'inspect_image'].includes(call.name) && p.tools.some(t => t.name === call.name)) { const shared = await this.mediaTool(run, p, call.name, args); output = shared.output; media = shared.media; images = shared.images }
      else if (p.agent.orchestrator && ['delegate', 'send_to_agent', 'read_agent_report', 'create_agent', 'update_plan', 'list_agents'].includes(call.name)) output = await this.masterTool(run, p, call.name, args)
      else throw new Error('The model requested an unavailable tool.')
      if (media?.length && call.name === 'render_preview') { images = media.flatMap(item => this.mediaImage(item)); observation = true }
      if (images?.length && observation && !run.pendingWrites) { run.images = images; run.imageRevision = run.revision; run.observedRevision = run.revision }
      if (p.agent.orchestrator && ['delegate', 'send_to_agent'].includes(call.name) && run.imageRevision === run.revision) images = run.images
      signal.throwIfAborted()
    } catch (e) {
      if (signal.aborted) throw e
      output = JSON.stringify({ error: this.store.redact(error(e)) })
    }
    return { output, label: this.label(call.name, args, p), ...(media ? { media } : {}), ...(images?.length ? { images } : {}) }
  }

  private loadSkill(run: Run, p: Participant, args: Record<string, any>) {
    const skill = p.skills.find(s => s.id === args.skill_id)
    if (!skill) throw new Error('This skill is not enabled for the agent.')
    const file = typeof args.file === 'string' ? args.file : 'SKILL.md'
    const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
    const length = Number.isSafeInteger(args.length) ? Math.min(5000, Math.max(500, args.length)) : 4000
    const key = `${skill.id}:${file}:${offset}:${length}`
    const reuse = (where: string) => JSON.stringify({ alreadyLoaded: true, skill_id: skill.id, file, offset, instruction: `This page is already ${where}. Use it; load a different offset only if you need more.` })
    if (p.pinned.has(key)) return reuse('in your Session memory above')
    const previous = p.loaded.get(key)
    if (previous && (p.native || p.turns.some(t => t.role === 'tool' && t.content === previous))) return reuse('in this conversation')
    const parts = skillPageParts(readSkill(skill, file), skill.id, file, offset, length)
    p.loaded.set(key, parts.json)
    // Remembered for later messages and for workers, so nobody pays to read the same page twice.
    pinPage(run.session, { key, skillId: skill.id, file, offset, total: parts.total, text: parts.content })
    return parts.json
  }

  private async callTool(run: Run, p: Participant, args: Record<string, any>) {
    const { session, signal } = run
    const agent = p.agent
    const server = p.servers.find(s => s.id === args.server_id)
    const tool = server?.tools.find(t => t.name === args.name)
    if (!server || !tool) throw new Error('The model requested an unavailable tool.')
    const toolArgs = args.arguments
    if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) throw new Error('Tool arguments must be an object.')
    if (!tool.readOnly && ensureBrief(session).visual && !ensureBrief(session).acceptance.length) throw new Error('Establish the visual work brief and acceptance criteria with set_brief before writing. Workers: ask the Master to set the shared brief, then continue.')
    await this.gate(run, p, server.id, tool.name, toolArgs, tool.readOnly)
    this.refreshStatus(session); this.store.save()
    if (!tool.readOnly) { run.pendingWrites++; this.invalidateReview(run) }
    let result: Awaited<ReturnType<McpManager['call']>>
    try { result = await abortable(this.mcp.call(server.id, tool.name, toolArgs, signal, this.dispatchGuard(agent, tool.readOnly)), signal) }
    finally { if (!tool.readOnly) { run.pendingWrites--; this.invalidateReview(run) } }
    signal.throwIfAborted()
    if (!result.isError && tool.readOnly && !run.pendingWrites && !['get_connected_instances', 'get_asset_thumbnail', 'get_asset_details', 'preview_asset'].includes(tool.name)) run.observedRevision = run.revision
    const output = toolResultText(result)
    this.store.log('tool', `${agent.name} · ${tool.name}`, output.slice(0, 1000), agent.id)
    return { output, images: visionImages(result), observation: ['capture_screenshot', 'look', 'get_viewport_screenshot'].includes(tool.name) }
  }

  private invalidateReview(run: Run) { run.revision++; run.images = []; run.review = undefined; if (run.session.memory?.review) run.session.memory.review.current = false }

  private mediaImage(item: MediaItem): VisionImage[] {
    if (!this.media || item.kind !== 'image' || item.bytes > MAX_IMAGE_BYTES) return []
    const file = this.media.locate(item.id)
    return file ? visionImages({ content: [{ type: 'image', mimeType: file.mime, data: readFileSync(file.path).toString('base64') }] }) : []
  }

  /** Access mode check for anything that changes something: refuses read-only agents and waits for approval in Ask mode. */
  private async gate(run: Run, p: Participant, serverId: string, tool: string, args: Record<string, unknown>, readOnly: boolean) {
    const agent = p.agent
    if (!readOnly) {
      if (agent.permission === 'read-only') throw new Error('This agent only has read access.')
      if (agent.permission !== 'unrestricted') {
        const approved = await this.approve({ id: randomUUID(), sessionId: run.session.id, agentId: agent.id, serverId, tool, args, kind: 'tool' }, run.signal)
        if (!approved) throw new Error('The user denied this tool call. Respect the decision and do not retry it.')
      }
    }
    run.signal.throwIfAborted()
    if (!readOnly && agent.permission === 'read-only') throw new Error('This agent only has read access.')
  }
  /** Runs right before a queued call is sent: the access mode may have changed while it waited. */
  private dispatchGuard(agent: Agent, readOnly: boolean) {
    const access = agent.permission
    return () => {
      if (!readOnly && agent.permission === 'read-only') throw new Error('This agent only has read access.')
      if (!readOnly && access === 'unrestricted' && agent.permission === 'ask') throw new Error('The access mode changed before this queued action ran. Request the tool again to obtain approval.')
    }
  }

  // ---- Previews in the chat -----------------------------------------------------------------------------------

  private mediaToolSpecs(): ToolSpec[] {
    const enumeration = (values: string[]) => ({ type: 'string', enum: values })
    return [
      { name: 'render_preview', description: "Render a short preview in the user's open Blender and post it in the chat as a playable video (an image for a still). turntable orbits the model once, animation plays the scene's own animation from its first frame, still renders one frame. It frames everything visible (focus 'selected' frames only the selection), uses temporary settings and a temporary camera and light when the scene has none, and puts everything back. Blender is busy while it renders, so keep frames and height small while iterating. Needs approval in Ask mode.", parameters: { type: 'object', properties: { mode: enumeration(['turntable', 'animation', 'still']), frames: { type: 'integer', minimum: 8, maximum: 240 }, height: { type: 'integer', minimum: 240, maximum: 1080 }, engine: enumeration(['eevee', 'workbench', 'scene']), format: enumeration(['mp4', 'webm']), focus: enumeration(['all', 'selected']), caption: { type: 'string', maxLength: 300 } }, additionalProperties: false } },
      { name: 'share_media', description: `Show an image or video that already exists on this computer in the chat (${SHAREABLE}). It is copied into the app and displayed to the user; its pixels are not sent to the model. Returns media_id; use inspect_image explicitly to analyze an image.`, parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 1000 }, caption: { type: 'string', maxLength: 300 } }, required: ['path'], additionalProperties: false } },
      { name: 'inspect_image', description: 'Send an image already shared in this conversation to the selected model for reference analysis. Use its media_id from share_media. Requires human approval unless access is Unrestricted. Videos need a still view instead.', parameters: { type: 'object', properties: { media_id: { type: 'string' } }, required: ['media_id'], additionalProperties: false } }
    ]
  }

  private async mediaTool(run: Run, p: Participant, name: string, args: Record<string, any>): Promise<{ output: string; media?: MediaItem[]; images?: VisionImage[] }> {
    const media = this.media
    if (!media) throw new Error('Sharing previews is not available.')
    const caption = typeof args.caption === 'string' ? args.caption : undefined
    const summary = (item: MediaItem) => ({ shared: true, media_id: item.id, kind: item.kind, name: item.name, megabytes: Math.round(item.bytes / 1e5) / 10, note: 'The user can now see it in the chat. Describe appearance only when actual image content was also delivered to you.' })
    if (name === 'inspect_image') {
      const item = run.session.messages.flatMap(m => m.media || []).find(item => item.id === args.media_id)
      if (!item || item.kind !== 'image') throw new Error('Choose an image media_id already shared in this conversation. Videos require a still view.')
      if (item.bytes > MAX_IMAGE_BYTES) throw new Error('This image is too large for model input. Share a smaller image (at most 4 MB).')
      if (p.agent.permission !== 'unrestricted') {
        const cfg = this.config(run, p.agent, p.primary)
        const approved = await this.approve({ id: randomUUID(), sessionId: run.session.id, agentId: p.agent.id, serverId: 'media', tool: 'inspect_image', kind: 'tool', args: { image: item.name, provider: cfg.provider.name, model: cfg.model, bytes: item.bytes } }, run.signal)
        if (!approved) throw new Error('The user denied sending this image to the model. Do not retry.')
      }
      run.signal.throwIfAborted()
      const images = this.mediaImage(item)
      if (!images.length) throw new Error('The stored file is not a supported valid inline image.')
      return { output: JSON.stringify({ inspected: item.id, name: item.name, note: 'Reference image; this does not prove the current scene matches it.' }), images }
    }
    if (name === 'share_media') {
      if (typeof args.path !== 'string') throw new Error('Give the full path of the file to share.')
      const item = media.ingest(args.path, { caption })
      this.store.log('tool', `${p.agent.name} · share_media`, `${item.name}, ${item.bytes} bytes`, p.agent.id)
      return { output: JSON.stringify(summary(item)), media: [item] }
    }
    await this.gate(run, p, BLENDER_ID, 'render_preview', args, false)
    const directory = media.scratch()
    try {
      const options = previewOptions(args, directory)
      this.refreshStatus(run.session); this.store.save()
      // Rendering is slow and Blender cannot be interrupted from here, so this call waits up to ten minutes.
      const result = await this.mcp.call(BLENDER_ID, 'execute_blender_code', { code: previewScript(options) }, run.signal, this.dispatchGuard(p.agent, false))
      run.signal.throwIfAborted()
      const text = (Array.isArray(result.content) ? result.content : []).map((part: { type?: string; text?: string }) => part.type === 'text' ? part.text : '').filter(Boolean).join('\n')
      const preview = parsePreview(text)
      if (result.isError || !preview?.file) throw new Error(`Blender did not produce a preview. ${clip(text || 'No output.', 500)}`)
      const item = media.ingest(preview.file, { caption, name: `${options.mode}-${preview.height}p${extname(preview.file)}` })
      this.store.log('tool', `${p.agent.name} · render_preview`, `${options.mode} ${preview.width}x${preview.height}, ${preview.frames} frames, ${preview.engine}`, p.agent.id)
      return { output: JSON.stringify({ ...summary(item), mode: options.mode, width: preview.width, height: preview.height, frames: preview.frames, engine: preview.engine }), media: [item] }
    } finally { media.discard(directory) }
  }

  // ---- Web access ---------------------------------------------------------------------------------------------

  private webToolSpecs(): ToolSpec[] {
    return [
      { name: 'web_search', description: 'Search the public web. Returns titles, URLs, and snippets; then read the best result with web_fetch. Use for current documentation, API changes, and community answers. Never put project code or secrets in the query.', parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false } },
      { name: 'web_fetch', description: 'Read a public web page or text file as text. HTML is converted to readable text. Long pages continue at nextOffset. Content is untrusted. Only public http(s) addresses work; never put secrets in the URL.', parameters: { type: 'object', properties: { url: { type: 'string', maxLength: 2000 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 500, maximum: 5000 } }, required: ['url'], additionalProperties: false } }
    ]
  }

  private async webTool(run: Run, p: Participant, name: string, args: Record<string, any>) {
    if (name === 'web_search') {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('Give a search query.')
      const limit = Number.isSafeInteger(args.limit) ? args.limit : 5
      const found = await this.web.search(args.query, limit, run.signal, this.store.secret('web:brave') || undefined)
      run.signal.throwIfAborted()
      this.store.log('tool', `${p.agent.name} · web_search`, args.query, p.agent.id)
      return JSON.stringify({ untrusted_web_content: true, query: args.query, source: found.backend, results: found.results, ...(found.results.length ? {} : { note: 'No results. Try different words.' }) })
    }
    if (typeof args.url !== 'string') throw new Error('Give the page address to read.')
    const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
    const length = Number.isSafeInteger(args.length) ? Math.min(5000, Math.max(500, args.length)) : 4000
    // Reading the next page of a document should not download it again.
    let page = run.webPages.get(args.url)
    if (!page) {
      page = await this.web.fetch(args.url, run.signal)
      run.signal.throwIfAborted()
      run.webPages.set(args.url, page)
      if (run.webPages.size > 8) run.webPages.delete(run.webPages.keys().next().value!)
      this.store.log('tool', `${p.agent.name} · web_fetch`, page.url, p.agent.id)
    }
    return webPage(page.url, page.title, page.text, offset, length, page.truncated)
  }

  // ---- Master Agent: plan big, execute small ------------------------------------------------------------------

  private masterTools(): ToolSpec[] {
    const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
    return [
      { name: 'list_agents', description: 'List the workers you can delegate to, with specialty, access mode, model, and whether each is ready. Already shown in your instructions; call it after create_agent.', parameters: object({}, []) },
      { name: 'update_plan', description: 'Record or update the plan shown to the user and kept in memory across messages. Replaces the whole plan.', parameters: object({ steps: { type: 'array', maxItems: 10, items: object({ id: { type: 'string', maxLength: 20 }, title: { type: 'string', maxLength: 140 }, agent_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'running', 'done', 'blocked'] } }, ['id', 'title', 'status']) } }, ['steps']) },
      { name: 'delegate', description: 'Start worker threads. Each task needs a self-contained brief; workers cannot see this conversation. Tasks in one call run in parallel. Returns each worker\'s report, thread_id, and token use.', parameters: object({ tasks: { type: 'array', minItems: 1, maxItems: 4, items: object({ agent_id: { type: 'string' }, brief: { type: 'string', maxLength: 6000 }, context: { type: 'string', maxLength: 4000, description: 'Facts the worker needs: instance IDs, paths, constraints, user decisions.' } }, ['agent_id', 'brief']) } }, ['tasks']) },
      { name: 'send_to_agent', description: 'Send a follow-up to a worker thread from this run. The worker keeps its earlier context.', parameters: object({ thread_id: { type: 'string' }, message: { type: 'string', maxLength: 4000 } }, ['thread_id', 'message']) },
      { name: 'read_agent_report', description: 'Read a full worker report in pages when the delegation summary is truncated. Includes acceptance evidence and unresolved defects omitted from the short summary.', parameters: object({ thread_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, ['thread_id']) },
      { name: 'create_agent', description: 'Propose a new worker agent. The user must approve it every time, even in Unrestricted mode. Use only when no listed worker fits a recurring need.', parameters: object({ name: { type: 'string', maxLength: 60 }, role: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 300 }, system_prompt: { type: 'string', maxLength: 6000 }, skill_ids: { type: 'array', maxItems: 12, items: { type: 'string' } }, permission: { type: 'string', enum: ['ask', 'read-only'] }, based_on: { type: 'string', description: 'Agent id whose provider, model, and Studio connection the new agent copies.' }, reason: { type: 'string', maxLength: 300 } }, ['name', 'role', 'description', 'system_prompt', 'reason']) }
    ]
  }

  private async masterTool(run: Run, p: Participant, name: string, args: Record<string, any>) {
    const { session } = run
    if (name === 'list_agents') return JSON.stringify(roster(this.store.state, p.agent.id))
    if (name === 'update_plan') {
      if (!Array.isArray(args.steps) || args.steps.length > 10) throw new Error('Provide up to 10 plan steps.')
      const steps: PlanStep[] = args.steps.map((s: any) => {
        if (!s || typeof s.id !== 'string' || typeof s.title !== 'string' || !['pending', 'running', 'done', 'blocked'].includes(s.status)) throw new Error('Each step needs id, title, and a valid status.')
        return { id: s.id.slice(0, 20), title: s.title.slice(0, 140), status: s.status, ...(typeof s.agent_id === 'string' ? { agentId: s.agent_id } : {}) }
      })
      session.plan = steps; this.store.save()
      return JSON.stringify({ ok: true, done: steps.filter(s => s.status === 'done').length, total: steps.length })
    }
    if (name === 'create_agent') return this.createAgent(run, p, args)
    if (name === 'read_agent_report') {
      const thread = run.threads.get(args.thread_id)
      if (!thread?.lastReport) throw new Error('No completed report for this thread in the current run.')
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > thread.lastReport.length) throw new Error('Invalid report offset.')
      return skillPageParts(thread.lastReport, thread.id!, 'worker-report', offset, 4000).json
    }
    if (name === 'send_to_agent') {
      const thread = typeof args.thread_id === 'string' ? run.threads.get(args.thread_id) : undefined
      if (!thread) throw new Error('Unknown thread_id. Threads only live for the current message; delegate again to start a new one.')
      if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('Provide a message.')
      return JSON.stringify(await this.runThread(run, thread, args.message, 4000))
    }
    // delegate
    if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 4) throw new Error('Delegate between 1 and 4 tasks per call.')
    const reportLimit = Math.max(1200, Math.floor(5400 / args.tasks.length) - 200)
    const results = await Promise.all(args.tasks.map((task: any) => this.startThread(run, task, reportLimit)))
    // Escaped reports can be much larger on the wire. Preserve valid JSON and every thread ID.
    const reports = results as Record<string, any>[]
    for (const report of reports) { if (report.error) report.error = boundedText(String(report.error), 500); if (report.partial) report.partial = boundedText(String(report.partial), 800) }
    const serialized = () => JSON.stringify(reports.length === 1 ? reports[0] : reports)
    while (serialized().length > 5900) {
      const largest = reports.filter(r => typeof r.report === 'string' && r.report.length > 200).sort((a, b) => b.report.length - a.report.length)[0]
      if (!largest) break
      largest.report = boundedText(largest.report, Math.max(200, Math.floor(largest.report.length / 2)))
      largest.truncated = true
    }
    return serialized()
  }

  private async startThread(run: Run, task: { agent_id?: unknown; brief?: unknown; context?: unknown }, reportLimit: number) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return { status: 'error', error: 'Each task must be an object with agent_id and brief.' }
    const base = this.store.state.agents.find(a => a.id === task.agent_id)
    if (!base || base.orchestrator) return { error: `Unknown worker "${String(task.agent_id)}". Call list_agents.` }
    if (!base.enabled) return { error: `${base.name} is paused.` }
    if (typeof task.brief !== 'string' || !task.brief.trim() || task.brief.length > 6000) return { error: 'Each task needs a brief of up to 6000 characters.' }
    if (!base.model.trim() || !this.store.state.providers.some(p => p.id === base.providerId)) return { error: `${base.name} has no provider or model configured.` }
    const agent = structuredClone(base)
    const id = `${agent.id}-${++run.counter}`
    const usage: ThreadUsage = { id, agentId: agent.id, agentName: agent.name, model: agent.model, tokens: 0, requests: 0, status: 'running' }
    run.usage.threads = [...(run.usage.threads || []), usage]
    this.store.emit()
    let thread: Participant
    try { thread = await this.participant(run, agent, false, []) }
    catch (e) { if (run.signal.aborted) throw e; usage.status = 'error'; return { thread_id: id, agent: agent.name, status: 'error', error: this.store.redact(error(e)) } }
    thread.id = id; thread.usage = usage
    run.threads.set(id, thread)
    const context = typeof task.context === 'string' && task.context.trim() ? `\n\nContext from the Master:\n${task.context.slice(0, 4000)}` : ''
    return this.runThread(run, thread, `${task.brief}${context}`, reportLimit)
  }

  private async runThread(run: Run, thread: Participant, message: string, reportLimit: number) {
    const usage = thread.usage!
    if (thread.busy) return { thread_id: thread.id, agent: thread.agent.name, status: 'error', error: 'This thread is still working.' }
    thread.busy = true
    let acquired = false
    const before = thread.spent
    try {
      await this.slot(run)
      acquired = true
      run.signal.throwIfAborted()
      usage.status = 'running'; this.store.emit()
      thread.turns.push({ role: 'user', content: message })
      const result = await this.converse(run, thread)
      thread.lastReport = result.text
      usage.status = 'done'
      return { thread_id: thread.id, agent: thread.agent.name, status: result.status, report: boundedText(result.text || '(The worker returned an empty report.)', reportLimit), truncated: result.text.length > reportLimit, report_characters: result.text.length, tokens: thread.spent - before }
    } catch (e) {
      if (run.signal.aborted) throw e
      usage.status = 'error'
      const lastText = [...thread.turns].reverse().find(t => t.role === 'assistant' && t.content)?.content
      return { thread_id: thread.id, agent: thread.agent.name, status: 'error', error: this.store.redact(error(e)), partial: lastText ? boundedText(lastText, 1500) : undefined, tokens: thread.spent - before }
    } finally {
      thread.busy = false
      if (run.signal.aborted) usage.status = 'error'
      if (acquired) this.release(run)
      this.store.emit()
    }
  }

  private slot(run: Run) {
    run.signal.throwIfAborted()
    if (run.slots.free > 0) { run.slots.free--; return Promise.resolve() }
    return new Promise<void>((resolve, reject) => {
      const waiter = () => { run.signal.removeEventListener('abort', onAbort); resolve() }
      const onAbort = () => { run.slots.waiting = run.slots.waiting.filter(w => w !== waiter); reject(run.signal.reason) }
      run.slots.waiting.push(waiter); run.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  private release(run: Run) { const next = run.slots.waiting.shift(); if (next) next(); else run.slots.free++ }

  private async createAgent(run: Run, p: Participant, args: Record<string, any>) {
    const { session, signal } = run
    if (p.agent.permission === 'read-only') throw new Error('A read-only Master cannot create agents.')
    const str = (key: string, max: number, required = true) => {
      const value = typeof args[key] === 'string' ? args[key].trim() : ''
      if (required && !value) throw new Error(`${key} is required.`)
      return value.slice(0, max)
    }
    if (this.store.state.agents.length >= 30) throw new Error('The workspace already has 30 agents.')
    const name = str('name', 60), role = str('role', 80), description = str('description', 300), systemPrompt = str('system_prompt', 6000), reason = str('reason', 300)
    if (this.store.state.agents.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`An agent named "${name}" already exists.`)
    const skillIds = (Array.isArray(args.skill_ids) ? args.skill_ids : ['roblox-collaboration-mode'].filter(id => this.store.state.skills.some(s => s.id === id))).filter((id: unknown): id is string => typeof id === 'string')
    const unknown = skillIds.find(id => !this.store.state.skills.some(s => s.id === id))
    if (unknown) throw new Error(`Skill "${unknown}" is not installed.`)
    const base = this.store.state.agents.find(a => a.id === args.based_on) || this.store.state.agents.find(a => !a.orchestrator && a.enabled && a.model.trim() && a.providerId)
    if (!base) throw new Error('No configured worker to copy a provider and model from. Configure a worker first.')
    const permission: Agent['permission'] = args.permission === 'read-only' ? 'read-only' : 'ask'
    const provider = this.store.state.providers.find(x => x.id === base.providerId)
    // Always a human decision: Unrestricted access never auto-approves new agents.
    const approved = await this.approve({ id: randomUUID(), sessionId: session.id, agentId: p.agent.id, serverId: 'master', tool: 'create_agent', kind: 'create-agent', args: { name, role, description, system_prompt: systemPrompt, skills: skillIds, access: permission, model: `${provider?.name || 'provider'} · ${base.model}`, studio_tools: base.mcpIds.length > 0, reason } }, signal)
    if (!approved) throw new Error('The user declined to create this agent. Do not ask again; use an existing worker.')
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent'
    const created: Agent = { id: `${slug}-${randomUUID().slice(0, 4)}`, name, role, description, color: PALETTE[this.store.state.agents.length % PALETTE.length], providerId: base.providerId, model: base.model, systemPrompt, skillIds, mcpIds: [...base.mcpIds], enabled: true, permission, effort: base.effort }
    this.store.state.agents.push(created)
    this.store.log('success', `Agent created: ${name}`, `Proposed by ${p.agent.name}. ${reason}`, created.id)
    this.refreshStatus(session); this.store.save()
    return JSON.stringify({ created: created.id, name, note: 'The agent is in the roster now. Delegate to it by id.' })
  }

  // ---- Approvals ----------------------------------------------------------------------------------------------

  private refreshStatus(session: Session) {
    session.status = this.store.approvals.some(a => a.sessionId === session.id) ? 'waiting' : 'running'
  }

  private approve(approval: Approval, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    this.store.approvals.push(approval)
    const session = this.store.state.sessions.find(s => s.id === approval.sessionId)
    if (session) session.status = 'waiting'
    this.store.save()
    return new Promise(resolve => {
      const abort = () => this.decide(approval.id, false)
      this.decisions.set(approval.id, allow => { signal.removeEventListener('abort', abort); if (session && !signal.aborted) this.refreshStatus(session); resolve(allow) })
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
  stop(id: string) {
    this.runs.get(id)?.controller.abort()
    for (const controller of this.sideRuns.get(id) || []) controller.abort()
  }
  setAccess(agentId: string, permission: Agent['permission']) {
    for (const run of this.runs.values()) for (const agent of [run.primary, ...[...run.threads.values()].map(t => t.agent)]) if (agent.id === agentId) agent.permission = permission
    // Switching to Unrestricted releases pending tool approvals. Creating an agent is never released this way.
    if (permission !== 'ask') for (const approval of [...this.store.approvals]) if (approval.agentId === agentId && approval.kind !== 'create-agent') this.decide(approval.id, permission === 'unrestricted')
  }
  isRunning(id: string) { return this.runs.has(id) }
  close() { for (const run of this.runs.values()) run.controller.abort(); for (const set of this.sideRuns.values()) for (const c of set) c.abort() }

  // ---- Slash commands -----------------------------------------------------------------------------------------

  private note(session: Session, content: string) {
    session.messages.push({ id: randomUUID(), role: 'system', content, createdAt: new Date().toISOString(), kind: 'command' })
    this.store.save()
  }

  /** Changes the model for this conversation, or for the agent when `save` is set. */
  setModel(sessionId: string, argument: string, save = false) {
    const session = this.session(sessionId)
    const agent = this.store.state.agents.find(a => a.id === session.agentId)
    if (!agent) throw new Error('This agent no longer exists.')
    const current = session.overrides?.providerId || agent.providerId
    const resolved = resolveModel(argument, this.store.state.providers, current)
    if ('error' in resolved) throw new Error(resolved.error)
    if (save) { agent.providerId = resolved.providerId; agent.model = resolved.model; delete session.overrides?.model; delete session.overrides?.providerId }
    else session.overrides = { ...session.overrides, providerId: resolved.providerId, model: resolved.model }
    this.store.save()
    const provider = this.store.state.providers.find(p => p.id === resolved.providerId)
    return `Model: ${resolved.model} (${provider?.name})${save ? ' · saved to the agent' : ' · this conversation'}.${this.isRunning(sessionId) ? ' Applies from the next step.' : ''}${resolved.note ? ` ${resolved.note}` : ''}`
  }
  setEffort(sessionId: string, value: Effort | 'default') {
    const session = this.session(sessionId)
    const overrides = { ...session.overrides }
    if (value === 'default') delete overrides.effort; else overrides.effort = value
    session.overrides = overrides; this.store.save()
    return value === 'default' ? 'Effort: back to the agent default.' : `Effort: ${value}. Used by Claude 4.5+ and 5.x models and OpenAI reasoning models; other models ignore it.${this.isRunning(sessionId) ? ' Applies from the next step.' : ''}`
  }

  private async command(session: Session, name: string, args: string) {
    const running = this.runs.has(session.id)
    const agent = this.store.state.agents.find(a => a.id === session.agentId)
    try {
      switch (name) {
        case 'help': return this.note(session, `Commands\n${SLASH_COMMANDS.map(c => `${c.usage}\n  ${c.description}`).join('\n')}\n\nMessages sent while the agent works are delivered before its next step.`)
        case 'stop': if (!running) return this.note(session, 'Nothing is running.'); this.stop(session.id); return
        case 'btw': if (!args) return this.note(session, 'Usage: /btw <question>'); void this.btw(session, args); return
        case 'model': {
          if (args) { const save = /(^|\s)--save\b/.test(args); return this.note(session, this.setModel(session.id, args.replace(/(^|\s)--save\b/, '').trim(), save)) }
          const cfg = agent && this.safeConfig(session, agent)
          const provider = cfg?.provider
          return this.note(session, `Model: ${cfg?.model || 'none'}${provider ? ` (${provider.name})` : ''}${session.overrides?.model ? ' · set for this conversation' : ' · agent default'}\n${provider?.models.length ? `Available: ${provider.models.slice(0, 25).join(', ')}${provider.models.length > 25 ? `, … ${provider.models.length - 25} more` : ''}` : 'Refresh models in Providers to list them, or type any model id.'}\nUse /model <name>, /model <provider>:<name>, add --save to update the agent.`)
        }
        case 'effort': {
          if (!args) return this.note(session, `Effort: ${session.overrides?.effort || agent?.effort || 'provider default'}\nUse /effort low | medium | high | xhigh | max | default.`)
          const value = parseEffort(args)
          if (!value) return this.note(session, 'Choose low, medium, high, xhigh, max, or default.')
          return this.note(session, this.setEffort(session.id, value))
        }
        case 'status': return this.note(session, this.status(session, agent))
        case 'plan': return this.note(session, session.plan?.length ? session.plan.map(s => `${s.status === 'done' ? '✓' : s.status === 'running' ? '…' : s.status === 'blocked' ? '!' : '○'} ${s.title}${s.agentId ? ` — ${this.store.state.agents.find(a => a.id === s.agentId)?.name || s.agentId}` : ''}`).join('\n') : 'No plan yet. The Master Agent writes one for multi-step work.')
        case 'compact':
        case 'clear': {
          if (running) return this.note(session, `Stop the running task before using /${name}.`)
          const before = memoryOf(session).digest.length
          foldAll(session)
          if (name === 'clear') { const memory = memoryOf(session); memory.digest = []; memory.pins = []; delete memory.brief; delete memory.review; session.plan = undefined }
          return this.note(session, name === 'clear' ? 'Context cleared. The transcript stays visible, but the agent starts fresh.' : `History folded into memory (${memoryOf(session).digest.length - before} new lines). The next message sends the short memory instead of the transcript.`)
        }
      }
    } catch (e) { this.note(session, this.store.redact(error(e))) }
  }

  private safeConfig(session: Session, agent: Agent) { try { return this.config(session, structuredClone(agent), true) } catch { return undefined } }

  private status(session: Session, agent?: Agent) {
    const cfg = agent && this.safeConfig(session, agent)
    const memory = memoryOf(session)
    const run = session.lastRun
    const done = session.plan?.filter(s => s.status === 'done').length
    return [
      `Agent: ${agent?.name || 'none'}${agent?.orchestrator ? ' (orchestrator)' : ''} · ${cfg ? `${cfg.model} (${cfg.provider.name})` : 'no model configured'}`,
      `Effort: ${session.overrides?.effort || agent?.effort || 'provider default'}`,
      `Tokens: ${session.tokens.toLocaleString('en-US')} in this conversation${run ? ` · last run ${run.tokens.toLocaleString('en-US')}, ${run.requests} requests, ${run.cachedInputTokens.toLocaleString('en-US')} cached` : ''}`,
      `Memory: ${memory.digest.length} folded exchanges · ${memory.pins.length} skill pages kept (${memory.pins.reduce((n, p) => n + p.text.length, 0).toLocaleString('en-US')} chars)`,
      session.plan?.length ? `Plan: ${done}/${session.plan.length} done` : 'Plan: none',
      this.runs.has(session.id) ? `Running · ${this.runs.get(session.id)!.queue.length} message(s) queued` : 'Idle'
    ].join('\n')
  }

  /** /btw: one tool-free request that reads the conversation but never enters its context or interrupts the run. */
  private async btw(session: Session, question: string) {
    const agent = this.store.state.agents.find(a => a.id === session.agentId)
    let cfg
    try { if (!agent) throw new Error('This agent no longer exists.'); cfg = this.config(session, structuredClone(agent), true) }
    catch (e) { return this.note(session, this.store.redact(error(e))) }
    const controller = new AbortController()
    const set = this.sideRuns.get(session.id) || new Set<AbortController>()
    set.add(controller); this.sideRuns.set(session.id, set)
    const now = () => new Date().toISOString()
    session.messages.push({ id: randomUUID(), role: 'user', content: question, createdAt: now(), kind: 'btw' })
    const answer: Message = { id: randomUUID(), role: 'assistant', content: '', createdAt: now(), kind: 'btw' }
    session.messages.push(answer); this.store.save()
    try {
      const transcript = session.messages.filter(m => m.kind !== 'btw' && m.kind !== 'command').slice(-10).map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Agent' : m.role === 'tool' ? 'Tool' : 'Note'}: ${clip(m.role === 'tool' ? m.content.split('\n')[0] : m.content, 500)}`).join('\n')
      const turns: Turn[] = [{ role: 'system', content: `${BTW_PROMPT}\n\n${memoryBlock(session, { noPins: true })}\n\n# Recent conversation\n${boundedText(transcript, 5000)}` }, { role: 'user', content: question }]
      let lastEmit = 0
      const response = await abortable(this.providers.turn(cfg.provider, cfg.model, turns, [], controller.signal, chunk => {
        if (controller.signal.aborted) return
        answer.content += this.store.redact(chunk)
        if (Date.now() - lastEmit > 50) { this.store.emit(); lastEmit = Date.now() }
      }, { maxOutputTokens: 1024, execute: async () => { throw new Error('Side questions have no tools.') } }), controller.signal)
      answer.content = this.store.redact(response.text) || '(no answer)'
      session.tokens += response.tokens || Math.ceil((JSON.stringify(turns).length + response.text.length) / 3)
    } catch (e) {
      answer.content = controller.signal.aborted ? '(stopped)' : `Could not answer: ${this.store.redact(error(e))}`
    } finally {
      set.delete(controller)
      session.updatedAt = now(); this.store.save()
    }
  }
}
