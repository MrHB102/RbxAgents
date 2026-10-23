import type { Provider } from '../shared/types'
import type { Store } from './store'
import type { ChatGPTAuth } from './auth'
import { checkedFetch, sseEvents, validateEndpoint } from './http'

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: string }
export interface Turn { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string }
export interface TurnResult { text: string; calls: ToolCall[]; tokens: number }

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
  async turn(provider: Provider, model: string, turns: Turn[], tools: ToolSpec[], signal: AbortSignal, delta: (text: string) => void): Promise<TurnResult> {
    if (provider.kind === 'anthropic') return this.anthropic(provider, model, turns, tools, signal, delta)
    if (provider.kind === 'chatgpt') return this.responses(provider, model, turns, tools, signal, delta)
    const response = await checkedFetch(`${validateEndpoint(provider.baseUrl)}/chat/completions`, {
      method: 'POST', headers: await this.headers(provider), signal,
      body: JSON.stringify({ model, messages: turns, stream: true, ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}) })
    })
    let text = '', tokens = 0, finished = false
    const calls = new Map<number, ToolCall>()
    for await (const event of sseEvents(response)) {
      if (event.error) throw new Error(event.error.message || 'The provider returned an error.')
      tokens = event.usage?.total_tokens || tokens
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
    return { text, calls: [...calls.values()], tokens }
  }
  private async responses(provider: Provider, model: string, turns: Turn[], tools: ToolSpec[], signal: AbortSignal, delta: (text: string) => void): Promise<TurnResult> {
    const input = turns.filter(t => t.role !== 'system').flatMap(t => {
      if (t.role === 'tool') return [{ type: 'function_call_output', call_id: t.tool_call_id, output: t.content }]
      const messages: Record<string, unknown>[] = t.content ? [{ role: t.role, content: t.content }] : []
      for (const call of t.tool_calls || []) messages.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      return messages
    })
    const response = await checkedFetch('https://api.openai.com/v1/responses', { method: 'POST', headers: await this.headers(provider), signal,
      body: JSON.stringify({ model, instructions: turns.filter(t => t.role === 'system').map(t => t.content).join('\n\n'), input, stream: true, store: false, ...(tools.length ? { tools: tools.map(t => ({ type: 'function', ...t, strict: false })) } : {}) }) })
    let text = '', tokens = 0, completed = false
    const calls: ToolCall[] = []
    for await (const event of sseEvents(response)) {
      if (event.type === 'response.output_text.delta') { text += event.delta; delta(event.delta) }
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') calls.push({ id: event.item.call_id, name: event.item.name, arguments: event.item.arguments })
      if (event.type === 'response.completed') { completed = true; tokens = event.response?.usage?.total_tokens || 0 }
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error(event.response?.error?.message || event.error?.message || event.message || 'ChatGPT could not complete the response. Check your plan usage and account connection.')
    }
    if (!completed) throw new Error('ChatGPT stream ended without response.completed.')
    return { text, tokens, calls }
  }
  private async anthropic(provider: Provider, model: string, turns: Turn[], tools: ToolSpec[], signal: AbortSignal, delta: (text: string) => void): Promise<TurnResult> {
    const messages: { role: string; content: Record<string, unknown>[] }[] = []
    for (const turn of turns.filter(t => t.role !== 'system')) {
      if (turn.role === 'tool') {
        const content = { type: 'tool_result', tool_use_id: turn.tool_call_id, content: turn.content }
        if (messages.at(-1)?.role === 'user') messages.at(-1)!.content.push(content)
        else messages.push({ role: 'user', content: [content] })
      } else {
        const content: Record<string, unknown>[] = turn.content ? [{ type: 'text', text: turn.content }] : []
        for (const call of turn.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })
        messages.push({ role: turn.role, content })
      }
    }
    const response = await checkedFetch(`${validateEndpoint(provider.baseUrl)}/messages`, { method: 'POST', headers: await this.headers(provider), signal,
      body: JSON.stringify({ model, system: turns.filter(t => t.role === 'system').map(t => t.content).join('\n\n'), messages, max_tokens: 8192, stream: true, ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) }) })
    let text = '', tokens = 0, completed = false
    const calls = new Map<number, ToolCall>()
    for await (const event of sseEvents(response)) {
      if (event.type === 'error') throw new Error(event.error?.message || 'Claude returned an error.')
      if (event.type === 'message_start') tokens += event.message?.usage?.input_tokens || 0
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' })
      if (event.type === 'content_block_delta') {
        if (event.delta?.text) { text += event.delta.text; delta(event.delta.text) }
        if (event.delta?.partial_json) { const call = calls.get(event.index); if (call) call.arguments += event.delta.partial_json }
      }
      if (event.type === 'message_delta') {
        if (['max_tokens', 'refusal'].includes(event.delta?.stop_reason)) throw new Error(`Claude stopped: ${event.delta.stop_reason}`)
        tokens += event.usage?.output_tokens || 0
      }
      if (event.type === 'message_stop') completed = true
    }
    if (!completed) throw new Error('Claude stream ended before message_stop.')
    return { text, tokens, calls: [...calls.values()].map(c => ({ ...c, arguments: c.arguments || '{}' })) }
  }
}
