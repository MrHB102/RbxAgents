import type { Effort } from './types'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]

export interface SlashCommand { name: string; usage: string; description: string }
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'btw', usage: '/btw <question>', description: 'Side question. Answered now from the conversation context, without interrupting the running task.' },
  { name: 'model', usage: '/model [name] [--save]', description: 'Show or switch the model for this conversation. --save also updates the agent.' },
  { name: 'effort', usage: '/effort [low|medium|high|xhigh|max|default]', description: 'Set how deeply the model reasons. Applies from the next step.' },
  { name: 'status', usage: '/status', description: 'Model, effort, token use, plan, and memory of this conversation.' },
  { name: 'plan', usage: '/plan', description: 'Show the current plan.' },
  { name: 'compact', usage: '/compact', description: 'Fold the visible history into a short memory to reduce tokens.' },
  { name: 'clear', usage: '/clear', description: 'Forget earlier context (memory, plan, loaded skill pages). The transcript stays visible.' },
  { name: 'stop', usage: '/stop', description: 'Stop the running task.' },
  { name: 'help', usage: '/help', description: 'List commands.' }
]

/** Recognizes only known commands so ordinary text such as "/Workspace/Map is broken" is sent normally. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  return SLASH_COMMANDS.some(c => c.name === name) ? { name, args: (match[2] || '').trim() } : null
}

export function parseEffort(value: string): Effort | 'default' | null {
  const text = value.trim().toLowerCase()
  if (['default', 'auto', 'off', 'reset'].includes(text)) return 'default'
  return (EFFORTS as readonly string[]).includes(text) ? text as Effort : null
}
