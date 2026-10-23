export type ProviderKind = 'openai' | 'anthropic' | 'chatgpt'
export interface Provider {
  id: string; name: string; kind: ProviderKind; baseUrl: string; models: string[]
  status: 'disconnected' | 'connected' | 'error'; error?: string; hasKey: boolean; account?: string
}
export interface Agent {
  id: string; name: string; role: string; description: string; color: string; providerId: string
  model: string; systemPrompt: string; skillIds: string[]; mcpIds: string[]; enabled: boolean
  permission: 'ask' | 'read-only'; maxSteps: number
}
export interface Skill { id: string; name: string; description: string; category: string; source: string; path: string; builtin: boolean }
export interface McpServer {
  id: string; name: string; transport: 'bundled' | 'stdio' | 'http' | 'sse'; command: string
  args: string[]; url: string; env: Record<string, string>; status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string; tools: McpTool[]; pluginDirectory: string; installed: boolean
}
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt: string }
export interface Session { id: string; agentId: string; title: string; messages: Message[]; createdAt: string; updatedAt: string; tokens: number; status: 'idle' | 'running' | 'waiting' | 'error' }
export interface Activity { id: string; time: string; kind: 'info' | 'success' | 'error' | 'tool'; title: string; detail: string; agentId?: string }
export interface Approval { id: string; sessionId: string; agentId: string; serverId: string; tool: string; args: Record<string, unknown> }
export interface AppState {
  version: 1; agents: Agent[]; providers: Provider[]; skills: Skill[]; servers: McpServer[]; sessions: Session[]; activity: Activity[]
  settings: { workspace: string; globalPrompt: string; maxConcurrent: number }; hostId: string
}
export interface RuntimeState extends AppState { approvals: Approval[]; secureStorage: boolean; platform: string; appVersion: string }
export interface Bridge {
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>
  onState(callback: (state: RuntimeState) => void): () => void
}
declare global { interface Window { rbx: Bridge } }
