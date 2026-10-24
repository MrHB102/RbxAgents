import type { Turn } from './providers'
import type { McpServer, McpTool } from '../shared/types'

export const CONTEXT_CHARACTERS = 36_000
export const TOOL_RESULT_CHARACTERS = 6_000
export const DEFAULT_TOKEN_BUDGET = 30_000
export const MAX_OUTPUT_TOKENS = 4096

export function boundedText(text: string, limit = TOOL_RESULT_CHARACTERS) {
  if (text.length <= limit) return text
  const suffix = '\n[Truncated to save tokens. Request a smaller range if you need more.]'
  return text.slice(0, Math.max(0, limit - suffix.length)) + suffix
}

export function skillPage(text: string, skillId: string, file: string, offset: number, requestedLength: number) {
  let length = requestedLength
  while (true) {
    const page = JSON.stringify({ skill_id: skillId, file, offset, totalCharacters: text.length, nextOffset: offset + length < text.length ? offset + length : null, content: text.slice(offset, offset + length) })
    if (page.length <= TOOL_RESULT_CHARACTERS || length <= 100) return page
    length = Math.max(100, Math.floor(length * 0.7))
  }
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
  if (taskAnchor) turns.splice(1, 0, taskAnchor)
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
