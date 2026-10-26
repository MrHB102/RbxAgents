export type ProviderKind = 'openai' | 'anthropic' | 'chatgpt' | 'claude-code'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface Provider {
  id: string; name: string; kind: ProviderKind; baseUrl: string; models: string[]
  status: 'disconnected' | 'connected' | 'error'; error?: string; hasKey: boolean; account?: string
  /** Sign-in page printed by Claude Code while a sign-in is waiting. Never saved. */
  loginUrl?: string
}
export interface Agent {
  id: string; name: string; role: string; description: string; color: string; providerId: string
  model: string; systemPrompt: string; skillIds: string[]; mcpIds: string[]; enabled: boolean
  permission: 'ask' | 'read-only' | 'unrestricted'
  /** Reasoning depth sent to providers that support it. Undefined keeps the provider default. */
  effort?: Effort
  /** A Master Agent plans and delegates to the other agents instead of working directly. */
  orchestrator?: boolean
  /** Can search the web and read public pages. On unless set to false. Orchestrators delegate research instead. */
  web?: boolean
}
export interface Skill { id: string; name: string; description: string; category: string; source: string; path: string; builtin: boolean }
export interface McpServer {
  id: string; name: string; transport: 'bundled' | 'stdio' | 'http' | 'sse'; command: string
  args: string[]; url: string; env: Record<string, string>; status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string; tools: McpTool[]; pluginDirectory: string; installed: boolean
  /** Blender only: a Blender executable or install folder, when it is not in a standard place. */
  blenderPath?: string
}
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }
/** A rendered preview or image an agent shared in the chat. The file lives in the app's media folder, never in the saved workspace. */
export interface MediaItem { id: string; kind: 'video' | 'image'; mime: string; name: string; bytes: number; caption?: string }
/** `queued` = sent while the agent was working, not delivered yet. `btw`/`command` never enter the model context. */
export type MessageKind = 'queued' | 'btw' | 'command'
export interface Message { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt: string; kind?: MessageKind; agentId?: string; media?: MediaItem[] }
export interface ThreadUsage { id: string; agentId: string; agentName: string; model: string; tokens: number; requests: number; status: 'running' | 'done' | 'error' }
export interface RunUsage { tokens: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; requests: number; contextCharacters: number; estimated: boolean; threads?: ThreadUsage[] }
/** A skill page the agent already read. Kept across messages so it is never fetched (or paid for) twice. */
export interface PinnedPage { key: string; skillId: string; file: string; offset: number; total: number; text: string }
export interface SessionMemory {
  /** One line per folded exchange: request, actions, outcome. Built locally, no model call. */
  digest: string[]
  pins: PinnedPage[]
  /** Id of the last message already folded into the digest. */
  foldedThrough?: string
}
export interface PlanStep { id: string; title: string; agentId?: string; status: 'pending' | 'running' | 'done' | 'blocked' }
export interface SessionOverrides { providerId?: string; model?: string; effort?: Effort }
export interface Session {
  id: string; agentId: string; title: string; messages: Message[]; createdAt: string; updatedAt: string; tokens: number; lastRun?: RunUsage
  status: 'idle' | 'running' | 'waiting' | 'error'
  memory?: SessionMemory; plan?: PlanStep[]; overrides?: SessionOverrides
}
export interface Activity { id: string; time: string; kind: 'info' | 'success' | 'error' | 'tool'; title: string; detail: string; agentId?: string }
export interface Approval {
  id: string; sessionId: string; agentId: string; serverId: string; tool: string; args: Record<string, unknown>
  /** `create-agent` approvals always need a human, even in Unrestricted mode. */
  kind?: 'tool' | 'create-agent'
}
export interface AppState {
  version: 1; agents: Agent[]; providers: Provider[]; skills: Skill[]; servers: McpServer[]; sessions: Session[]; activity: Activity[]
  settings: { workspace: string; globalPrompt: string; maxConcurrent: number }; hostId: string
  /** Bumped when bundled defaults change so older workspaces are upgraded once. */
  schema?: number
}
export interface RuntimeState extends AppState { approvals: Approval[]; secureStorage: boolean; platform: string; appVersion: string; /** A Brave Search API key is saved (otherwise web search uses DuckDuckGo). */ webSearchKey: boolean }
export interface Bridge {
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>
  onState(callback: (state: RuntimeState) => void): () => void
}
declare global { interface Window { rbx: Bridge } }
