import type { Turn } from './providers'
import type { Effort, McpServer, McpTool, Message, PinnedPage, PlanStep, Session, SessionMemory } from '../shared/types'

export const CONTEXT_CHARACTERS = 48_000
export const TOOL_RESULT_CHARACTERS = 6_000
export const DEFAULT_TOKEN_BUDGET = 30_000
export const MAX_OUTPUT_TOKENS = 4096
/** Skill pages kept across messages, newest last. Older pages are evicted first. */
export const PIN_CHARACTERS = 9_000
export const DIGEST_LINES = 14
export const DIGEST_CHARACTERS = 3_500
export const KEEP_EXCHANGES = 3
const HISTORY_ANSWER_CHARACTERS = 3_000

export function clip(text: string, limit: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`
}
export function boundedText(text: string, limit = TOOL_RESULT_CHARACTERS) {
  if (text.length <= limit) return text
  const suffix = '\n[Truncated to save tokens. Request a smaller range if you need more.]'
  return text.slice(0, Math.max(0, limit - suffix.length)) + suffix
}

/** Reasoning consumes output tokens, so deeper effort needs a larger response cap. The token budget still applies. */
export function outputCap(effort?: Effort) {
  return effort === 'max' || effort === 'xhigh' ? 24_000 : effort === 'high' ? 12_000 : effort === 'medium' ? 8192 : MAX_OUTPUT_TOKENS
}

export function skillPageParts(text: string, skillId: string, file: string, offset: number, requestedLength: number) {
  let length = requestedLength
  while (true) {
    const content = text.slice(offset, offset + length)
    const nextOffset = offset + length < text.length ? offset + length : null
    const json = JSON.stringify({ skill_id: skillId, file, offset, totalCharacters: text.length, nextOffset, content })
    if (json.length <= TOOL_RESULT_CHARACTERS || length <= 100) return { json, content, nextOffset, total: text.length }
    length = Math.max(100, Math.floor(length * 0.7))
  }
}
export function skillPage(text: string, skillId: string, file: string, offset: number, requestedLength: number) {
  return skillPageParts(text, skillId, file, offset, requestedLength).json
}

export function toolResultText(result: unknown) {
  return JSON.stringify(result, (_key, value) => {
    if (value && typeof value === 'object' && ['image', 'audio'].includes(value.type) && typeof value.data === 'string') return { type: 'text', text: `${value.type} output omitted from text context to save tokens.` }
    return value
  })
}

/** Drop complete old exchanges/tool rounds; never leave orphan tool results. No AI summary request. */
export function compactTurns(source: Turn[], maximum = CONTEXT_CHARACTERS): Turn[] {
  const turns = structuredClone(source)
  const systems = turns.findIndex(t => t.role !== 'system')
  const leading = systems < 0 ? turns.length : systems
  let taskAnchor: Turn | undefined
  const size = () => JSON.stringify(turns).length + (taskAnchor ? JSON.stringify(taskAnchor).length + 1 : 0)
  while (size() > maximum) {
    const firstUser = turns.findIndex(t => t.role === 'user')
    const nextUser = turns.findIndex((t, i) => i > firstUser && t.role === 'user')
    if (firstUser >= 0 && nextUser >= 0) {
      taskAnchor ??= { role: 'user', content: `Earlier task excerpt (older context was shortened):\n${boundedText(turns[firstUser].content, 1800)}` }
      turns.splice(firstUser, nextUser - firstUser); continue
    }
    // Keep the current user request and newest tool round. Remove older complete rounds.
    const groups: { start: number; length: number }[] = []
    for (let i = firstUser + 1; i < turns.length; i++) {
      if (turns[i].role !== 'assistant') continue
      let end = i + 1
      while (end < turns.length && turns[end].role === 'tool') end++
      groups.push({ start: i, length: end - i }); i = end - 1
    }
    if (groups.length > 1) { turns.splice(groups[0].start, groups[0].length); continue }
    // A single large recent result can be shortened without changing its call ID or arguments.
    const tool = turns.find(t => t.role === 'tool' && t.content.length > 600)
    if (tool) { tool.content = boundedText(tool.content, 600); continue }
    throw new Error('The current message or system prompts exceed the economy context limit. Shorten them or split the task into smaller messages.')
  }
  if (taskAnchor) turns.splice(leading, 0, taskAnchor)
  return turns
}

export function findTools(servers: McpServer[], query: string, readOnly: boolean, limit = 3) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const ranked: { server_id: string; name: string; description: string; inputSchema: McpTool['inputSchema']; score: number }[] = []
  for (const server of servers) for (const tool of server.tools) {
    if (readOnly && !tool.readOnly) continue
    const name = tool.name.toLowerCase()
    const text = `${name} ${tool.description}`.toLowerCase()
    const score = (name === query.toLowerCase() ? 100 : 0) + terms.reduce((sum, term) => sum + (name.includes(term) ? 8 : text.includes(term) ? 1 : 0), 0)
    if (terms.length && !score) continue
    ranked.push({ server_id: server.id, name: tool.name, description: boundedText(tool.description, 260), inputSchema: tool.inputSchema, score })
  }
  return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.min(5, Math.max(1, limit))).map(({ score: _score, ...tool }) => tool)
}

// ---- Session memory: what survives between messages without another model call ----

export function memoryOf(session: Session): SessionMemory {
  return session.memory ??= { digest: [], pins: [] }
}
/** Messages that belong to the model's context. Side questions, commands, and worker traffic stay out. */
const inContext = (m: Message) => m.kind !== 'btw' && m.kind !== 'command'

function unfolded(session: Session) {
  const folded = memoryOf(session).foldedThrough
  const index = folded ? session.messages.findIndex(m => m.id === folded) : -1
  return session.messages.slice(index + 1).filter(inContext)
}
function exchanges(messages: Message[]) {
  const groups: Message[][] = []
  for (const message of messages) {
    if (message.role === 'user') groups.push([message])
    else if (groups.length) groups.at(-1)!.push(message)
  }
  return groups
}

export function digestExchange(group: Message[]) {
  const [user, ...rest] = group
  const tools = new Map<string, number>()
  for (const m of rest) if (m.role === 'tool' && !m.agentId) { const name = m.content.split('\n')[0].split(' ')[0]; tools.set(name, (tools.get(name) || 0) + 1) }
  const answer = [...rest].reverse().find(m => m.role === 'assistant' && m.content && !m.agentId)
  const actions = [...tools].slice(0, 6).map(([name, n]) => n > 1 ? `${name}×${n}` : name).join(', ')
  return [`User: ${clip(user.content, 160)}`, actions && `Actions: ${actions}`, answer && `Result: ${clip(answer.content, 280)}`].filter(Boolean).join(' | ')
}

function addDigest(memory: SessionMemory, lines: string[]) {
  memory.digest.push(...lines)
  // Older lines shrink first; the oldest are dropped when the digest is still too long.
  while (memory.digest.length > DIGEST_LINES) memory.digest.shift()
  for (let i = 0; memory.digest.join('\n').length > DIGEST_CHARACTERS && i < memory.digest.length - 1; i++) memory.digest[i] = clip(memory.digest[i], 110)
  while (memory.digest.join('\n').length > DIGEST_CHARACTERS && memory.digest.length > 1) memory.digest.shift()
}

/** Folds exchanges older than `keep` into one-line digests. The recent ones stay verbatim. */
export function foldHistory(session: Session, keep = KEEP_EXCHANGES) {
  const memory = memoryOf(session)
  const groups = exchanges(unfolded(session))
  if (groups.length <= keep) return
  const old = groups.slice(0, groups.length - keep)
  addDigest(memory, old.map(digestExchange))
  memory.foldedThrough = old.at(-1)!.at(-1)!.id
}
/** Folds everything currently visible. Used by /compact and /clear. */
export function foldAll(session: Session) {
  const memory = memoryOf(session)
  const groups = exchanges(unfolded(session))
  if (groups.length) addDigest(memory, groups.map(digestExchange))
  const last = session.messages.at(-1)
  if (last) memory.foldedThrough = last.id
}

/** User/assistant turns that follow the fold point. Old answers are bounded; tool rounds are summarized elsewhere. */
export function historyTurns(session: Session): Turn[] {
  const messages = unfolded(session).filter(m => (m.role === 'user' || m.role === 'assistant') && m.kind !== 'queued' && !m.agentId)
  const lastAssistant = messages.map(m => m.role).lastIndexOf('assistant')
  return messages.map((m, i) => ({ role: m.role as 'user' | 'assistant', content: m.role === 'assistant' && i !== lastAssistant ? boundedText(m.content, HISTORY_ANSWER_CHARACTERS) : m.content }))
}

export function pinPage(session: Session, page: PinnedPage) {
  const memory = memoryOf(session)
  memory.pins = memory.pins.filter(p => p.key !== page.key)
  memory.pins.push(page)
  while (memory.pins.length > 1 && memory.pins.reduce((sum, p) => sum + p.text.length, 0) > PIN_CHARACTERS) memory.pins.shift()
}

export interface MemoryOptions { /** Only pages of these skills (a worker sees just its own). */ skillIds?: string[]; /** Workers get skill pages but not the Master's conversation. */ pinsOnly?: boolean; noPins?: boolean }
const NL = '\n'
const mark = (status: PlanStep['status']) => status === 'done' ? 'x' : status === 'running' ? '~' : status === 'blocked' ? '!' : ' '
/** Dynamic system block: stable between messages unless something new was learned, so provider caches keep working. */
export function memoryBlock(session: Session, { skillIds, pinsOnly, noPins }: MemoryOptions = {}) {
  const memory = memoryOf(session)
  const parts: string[] = []
  if (!pinsOnly) {
    if (memory.digest.length) parts.push(['## Earlier in this conversation (folded, oldest first)', ...memory.digest.map(l => `- ${l}`)].join(NL))
    const recent = unfolded(session).filter(m => m.role === 'tool' && !m.agentId).slice(-8).map(m => `- ${clip(m.content.split(NL)[0], 140)}`)
    if (recent.length) parts.push(['## Recent actions (newest last)', ...recent].join(NL))
    if (session.plan?.length) parts.push(['## Plan', ...session.plan.map(s => `- [${mark(s.status)}] ${s.id}: ${s.title}${s.agentId ? ` (${s.agentId})` : ''}`)].join(NL))
  }
  const pins = noPins ? [] : memory.pins.filter(p => !skillIds || skillIds.includes(p.skillId))
  if (pins.length) parts.push(['## Loaded skill pages (already in your context; do not load them again)', ...pins.map(p => `### ${p.skillId} · ${p.file} · chars ${p.offset}-${p.offset + p.text.length} of ${p.total}${NL}${p.text}`)].join(NL + NL))
  return parts.length ? `# Session memory${NL}${parts.join(NL + NL)}` : ''
}
