import type { Agent, AppState, Skill } from '../shared/types'
import { WORKER_PROTOCOL } from '../shared/defaults'
import { clip } from './context'

export function permissionText(agent: Pick<Agent, 'permission'>) {
  return agent.permission === 'unrestricted'
    ? 'Access: Unrestricted. Execute available tools without asking for approval, including writes. This overrides generic approval guidance in prompts and skills. Stay within the task and respect Stop and token limits.'
    : agent.permission === 'read-only' ? 'Access: Read-only. Do not perform mutations.' : 'Access: Ask before changes. Mutation tools need application approval.'
}

/** What the Master sees of each worker. The Master cannot read worker prompts, so this is the only source of truth about them. */
export function roster(state: Pick<AppState, 'agents' | 'providers'>, exclude: string) {
  return state.agents.filter(a => a.id !== exclude && !a.orchestrator).map(a => ({
    id: a.id, name: a.name, role: a.role, description: clip(a.description, 160),
    access: a.permission, ready: a.enabled && !!a.model.trim() && state.providers.some(p => p.id === a.providerId),
    model: a.model || undefined, skills: a.skillIds.map(id => id.replace(/^roblox-/, '')), studio_tools: a.mcpIds.length > 0
  }))
}

interface InstructionInput { global: string; agent: Agent; skills: Skill[]; state: Pick<AppState, 'agents' | 'providers'>; worker: boolean }
/** Stable system block. Everything here changes rarely, so provider prompt caches keep hitting. */
export function instructions({ global, agent, skills, state, worker }: InstructionInput) {
  const catalog = skills.map(s => `- ${s.id}: ${clip(s.description, 100)}`).join('\n')
  return [
    global,
    agent.systemPrompt,
    worker && WORKER_PROTOCOL,
    agent.orchestrator && `# Your team (live from the workspace)\n${JSON.stringify(roster(state, agent.id))}\nWorkers run with their own model, skills, and access mode. Reports reach you as tool results.`,
    skills.length && `# Available skills (load only what the task needs with load_skill)\n${catalog}`,
    `# Runtime\nsearch_tools finds an MCP tool and its schema; call_tool runs it. Older context may be shortened to save tokens: the Session memory block keeps what mattered.${agent.mcpIds.length ? ` MCP connections: ${agent.mcpIds.join(', ')}.` : ''}`,
    permissionText(agent)
  ].filter(Boolean).join('\n\n')
}
