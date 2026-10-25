import type { Effort, Provider } from '../shared/types'
import type { Store } from './store'
import type { ChatGPTAuth } from './auth'
import { checkedFetch, sseEvents, validateEndpoint } from './http'

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: string }
export interface Turn { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string; /** Anthropic thinking blocks that must be replayed unchanged next to their tool calls. */ thinking?: unknown[] }
export interface TokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number }
export interface TurnResult { text: string; calls: ToolCall[]; tokens: number; usage?: TokenUsage; thinking?: unknown[] }
export interface TurnOptions { maxOutputTokens: number; effort?: Effort }

const ANTHROPIC_EFFORT_MODEL = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[5-8]|sonnet-4-6)/
/** Request fields that set reasoning depth. Empty when the provider/model does not take the parameter, so a stray /effort never breaks a run. */
export function effortFields(provider: Pick<Provider, 'kind' | 'baseUrl'>, model: string, effort?: Effort): Record<string, unknown> {
  if (!effort) return {}
  const id = model.toLowerCase()
  if (provider.kind === 'anthropic') {
    if (!ANTHROPIC_EFFORT_MODEL.test(id)) return {}
    // Opus 4.5 takes low/medium/high only and no adaptive thinking; the 4.6 generation has no xhigh.
    if (id.startsWith('claude-opus-4-5')) return { output_config: { effort: effort === 'low' || effort === 'medium' ? effort : 'high' } }
    const legacy46 = id.startsWith('claude-opus-4-6') || id.startsWith('claude-sonnet-4-6')
    return { thinking: { type: 'adaptive' }, output_config: { effort: legacy46 && effort === 'xhigh' ? 'high' : effort } }
  }
  const level = effort === 'low' || effort === 'medium' ? effort : 'high'
  let host = ''
  try { host = new URL(provider.baseUrl).hostname } catch { /* validated elsewhere */ }
  if (provider.kind === 'chatgpt') return /^(o\d|gpt-5)/.test(id) || id.includes('codex') ? { reasoning: { effort: level } } : {}
  if (host === 'api.openai.com') return /^(o\d|gpt-5)/.test(id) ? { reasoning_effort: level } : {}
  if (host === 'openrouter.ai') return { reasoning: { effort: level } }
  return {}
}

export class Providers {
  constructor(private store: Store, private auth: ChatGPTAuth) {}
  private async key(provider: Provider) { return provider.kind === 'chatgpt' ? this.auth.token(provider.id) : this.store.secret(`provider:${provider.id}`) }
  private async headers(provider: Provider): Promise<Record<string, string>> {
    const key = await this.key(provider)
    return provider.kind === 'anthropic'
      ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
  }
  async models(provider: Provider): Promise<string[]> {
    const baseUrl = provider.kind === 'chatgpt' ? 'https://api.openai.com/v1' : validateEndpoint(provider.baseUrl)
    const response = await checkedFetch(`${baseUrl}/models`, { headers: await this.headers(provider) })
    const data = await response.json() as { data?: { id: string }[]; models?: { slug: string; visibility?: string }[] }
    const models = provider.kind === 'chatgpt' ? (data.models || []).filter(m => m.visibility === 'list').map(m => m.slug) : (data.data || []).map(m => m.id)
    if (!models.length) throw new Error('The provider returned no available models. Check the endpoint and account permissions.')
    return models
  }
  async turn(provider: Provider, model: string, turns: Turn[], tools: ToolSpec[], signal: AbortSignal, delta: (text: string) => void, options: TurnOptions = { maxOutputTokens: 4096 }): Promise<TurnResult> {
    if (provider.kind === 'anthropic') return this.anthropic(provider, model, turns, tools, signal, delta, options)
    if (provider.kind === 'chatgpt') return this.responses(provider, model, turns, tools, signal, delta, options)
    const response = await checkedFetch(`${validateEndpoint(provider.baseUrl)}/chat/completions`, {
      method: 'POST', headers: await this.headers(provider), signal,
      body: JSON.stringify({ model, messages: turns.map(({ thinking: _thinking, ...turn }) => turn), stream: true, stream_options: { include_usage: true }, ...(new URL(provider.baseUrl).hostname === 'api.openai.com' ? { max_completion_tokens: options.maxOutputTokens } : { max_tokens: options.maxOutputTokens }), ...effortFields(provider, model, options.effort), ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}) })
    })
    let text = '', tokens = 0, finished = false
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    const calls = new Map<number, ToolCall>()
    for await (const event of sseEvents(response)) {
      if (event.error) throw new Error(event.error.message || 'The provider returned an error.')
      tokens = event.usage?.total_tokens || tokens
      if (event.usage) { usage.inputTokens = event.usage.prompt_tokens || 0; usage.outputTokens = event.usage.completion_tokens || 0; usage.cachedInputTokens = event.usage.prompt_tokens_details?.cached_tokens || 0 }
      const choice = event.choices?.[0]
      if (choice?.finish_reason) { if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') throw new Error(`Response stopped: ${choice.finish_reason}`); finished = true }
      if (choice?.delta?.content) { text += choice.delta.content; delta(choice.delta.content) }
      for (const item of choice?.delta?.tool_calls || []) {
        const call = calls.get(item.index) || { id: '', name: '', arguments: '' }
        if (item.id) call.id = item.id
        if (item.function?.name) call.name += item.function.name
        if (item.function?.arguments) call.arguments += item.function.arguments
        calls.set(item.index, call)
      }
    }
    if (!finished) throw new Error('The provider stream ended before a completion was confirmed.')
    return { text, calls: [...calls.values()], tokens, usage }
  }
  private async responses(provider: Provider, model: string, turns: Turn[], tools: ToolSpec[], signal: AbortSignal, delta: (text: string) => void, options: TurnOptions): Promise<TurnResult> {
    const input = turns.filter(t => t.role !== 'system').flatMap(t => {
      if (t.role === 'tool') return [{ type: 'function_call_output', call_id: t.tool_call_id, output: t.content }]
      const messages: Record<string, unknown>[] = t.content ? [{ role: t.role, content: t.content }] : []
      for (const call of t.tool_calls || []) messages.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      return messages
    })
    const response = await checkedFetch('https://api.openai.com/v1/responses', { method: 'POST', headers: await this.headers(provider), signal,
      body: JSON.stringify({ model, instructions: turns.filter(t => t.role === 'system').map(t => t.content).join('\n\n'), input, stream: true, store: false, max_output_tokens: options.maxOutputTokens, ...effortFields(provider, model, options.effort), ...(tools.length ? { tools: tools.map(t => ({ type: 'function', ...t, strict: false })) } : {}) }) })
    let text = '', tokens = 0, completed = false
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    const calls: ToolCall[] = []
    for await (const event of sseEvents(response)) {
      if (event.type === 'response.output_text.delta') { text += event.delta; delta(event.delta) }
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') calls.push({ id: event.item.call_id, name: event.item.name, arguments: event.item.arguments })
      if (event.type === 'response.completed') { completed = true; tokens = event.response?.usage?.total_tokens || 0; usage.inputTokens = event.response?.usage?.input_tokens || 0; usage.outputTokens = event.response?.usage?.output_tokens || 0; usage.cachedInputTokens = event.response?.usage?.input_tokens_details?.cached_tokens || 0 }
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error(event.response?.error?.message || event.error?.message || event.message || 'ChatGPT could not complete the response. Check your plan usage and account connection.')
    }
    if (!completed) throw new Error('ChatGPT stream ended without response.completed.')
    return { text, tokens, calls, usage }
  }
  private async anthropic(provider: Provider, model: string, turns: Turn[], tools: ToolSpec[], signal: AbortSignal, delta: (text: string) => void, options: TurnOptions): Promise<TurnResult> {
    const messages: { role: string; content: Record<string, unknown>[] }[] = []
    for (const turn of turns.filter(t => t.role !== 'system')) {
      if (turn.role === 'tool') {
        const content = { type: 'tool_result', tool_use_id: turn.tool_call_id, content: turn.content }
        if (messages.at(-1)?.role === 'user') messages.at(-1)!.content.push(content)
        else messages.push({ role: 'user', content: [content] })
      } else if (turn.role === 'user' && messages.at(-1)?.role === 'user') {
        // A user update that follows tool results must share their message; tool_result blocks stay first.
        messages.at(-1)!.content.push({ type: 'text', text: turn.content })
      } else {
        const content: Record<string, unknown>[] = [...(turn.thinking as Record<string, unknown>[] | undefined || [])]
        if (turn.content) content.push({ type: 'text', text: turn.content })
        for (const call of turn.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })
        messages.push({ role: turn.role, content })
      }
    }
    // Prompt caching: tools, then system, then the conversation so far. Every request re-reads the prefix at a fraction of the price.
    const cache = { type: 'ephemeral' }
    const last = messages.at(-1)?.content.at(-1)
    if (last) last.cache_control = cache
    const system = turns.filter(t => t.role === 'system' && t.content).map(t => ({ type: 'text', text: t.content, cache_control: cache }))
    const toolDefinitions = tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...(i === tools.length - 1 ? { cache_control: cache } : {}) }))
    const response = await checkedFetch(`${validateEndpoint(provider.baseUrl)}/messages`, { method: 'POST', headers: await this.headers(provider), signal,
      body: JSON.stringify({ model, ...(system.length ? { system } : {}), messages, max_tokens: options.maxOutputTokens, stream: true, ...effortFields(provider, model, options.effort), ...(toolDefinitions.length ? { tools: toolDefinitions } : {}) }) })
    let text = '', tokens = 0, completed = false
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    const calls = new Map<number, ToolCall>()
    const thinking = new Map<number, Record<string, unknown>>()
    for await (const event of sseEvents(response)) {
      if (event.type === 'error') throw new Error(event.error?.message || 'Claude returned an error.')
      if (event.type === 'message_start') {
        usage.cachedInputTokens = event.message?.usage?.cache_read_input_tokens || 0
        usage.inputTokens = (event.message?.usage?.input_tokens || 0) + usage.cachedInputTokens + (event.message?.usage?.cache_creation_input_tokens || 0)
        usage.outputTokens = event.message?.usage?.output_tokens || 0
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' })
      if (event.type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(event.content_block?.type)) thinking.set(event.index, { ...event.content_block })
      if (event.type === 'content_block_delta') {
        if (event.delta?.text) { text += event.delta.text; delta(event.delta.text) }
        if (event.delta?.partial_json) { const call = calls.get(event.index); if (call) call.arguments += event.delta.partial_json }
        const block = thinking.get(event.index)
        if (block && typeof event.delta?.thinking === 'string') block.thinking = `${block.thinking || ''}${event.delta.thinking}`
        if (block && typeof event.delta?.signature === 'string') block.signature = event.delta.signature
      }
      if (event.type === 'message_delta') {
        if (['max_tokens', 'refusal'].includes(event.delta?.stop_reason)) throw new Error(`Claude stopped: ${event.delta.stop_reason}`)
        usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens
      }
      if (event.type === 'message_stop') completed = true
    }
    if (!completed) throw new Error('Claude stream ended before message_stop.')
    tokens = usage.inputTokens + usage.outputTokens
    return { text, tokens, usage, thinking: thinking.size ? [...thinking.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]) : undefined, calls: [...calls.values()].map(c => ({ ...c, arguments: c.arguments || '{}' })) }
  }
}
