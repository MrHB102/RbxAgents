import { afterEach, expect, it, vi } from 'vitest'
import { Providers, effortFields, type Turn } from '../../src/main/providers'
import type { Provider } from '../../src/shared/types'
import type { Store } from '../../src/main/store'
import type { ChatGPTAuth } from '../../src/main/auth'

afterEach(() => vi.unstubAllGlobals())
function setup(kind: Provider['kind'], events: unknown[]) {
  const response = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(response, { headers: { 'Content-Type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetcher)
  const api = new Providers({ secret: () => 'fixture-key' } as unknown as Store, { token: async () => 'fixture-token' } as unknown as ChatGPTAuth)
  const provider: Provider = { id: 'test', name: 'Test', kind, baseUrl: kind === 'chatgpt' ? 'https://api.openai.com/v1' : 'http://localhost:1234/v1', models: [], status: 'connected', hasKey: true }
  return { api, provider, fetcher }
}
it('requests usage and caps output for OpenAI-compatible requests', async () => {
  const { api, provider, fetcher } = setup('openai', [{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }], usage: { total_tokens: 1100, prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } } }])
  const result = await api.turn(provider, 'test-model', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal, () => {}, { maxOutputTokens: 512 })
  expect(result.tokens).toBe(1100)
  expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 900 })
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ max_tokens: 512, stream_options: { include_usage: true } })
})
it('counts cached Responses input within the total rather than adding it again', async () => {
  const { api, provider, fetcher } = setup('chatgpt', [{ type: 'response.output_text.delta', delta: 'Done' }, { type: 'response.completed', response: { usage: { total_tokens: 150, input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 80 } } } }])
  const result = await api.turn(provider, 'test-model', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal, () => {}, { maxOutputTokens: 512 })
  expect(result.tokens).toBe(150)
  expect(result.usage?.cachedInputTokens).toBe(80)
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ max_output_tokens: 512, store: false, stream: true })
})
it('counts Anthropic cache reads and uses the final cumulative output count once', async () => {
  const { api, provider } = setup('anthropic', [{ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } }, { type: 'message_delta', usage: { output_tokens: 10 } }, { type: 'message_delta', usage: { output_tokens: 15 } }, { type: 'message_stop' }])
  const result = await api.turn(provider, 'test-model', [{ role: 'user', content: 'Hello' }], [], new AbortController().signal, () => {})
  expect(result.tokens).toBe(140)
  expect(result.usage).toEqual({ inputTokens: 125, outputTokens: 15, cachedInputTokens: 100 })
})

const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }
const calls: Turn[] = [
  { role: 'user', content: 'Inspect the view.' },
  { role: 'assistant', content: '', tool_calls: ['a', 'b'].map(id => ({ id, type: 'function' as const, function: { name: 'look', arguments: '{}' } })) },
  { role: 'tool', tool_call_id: 'a', content: 'First view', images: [image] },
  { role: 'tool', tool_call_id: 'b', content: 'Second result' }
]
it('sends GPT-6 effort without collapsing xhigh/max and uses Responses for official GPT-6 tool calls', async () => {
  expect(effortFields({ kind: 'chatgpt', baseUrl: '' }, 'gpt-6.1-sol', 'max')).toEqual({ reasoning: { effort: 'max' } })
  expect(effortFields({ kind: 'chatgpt', baseUrl: '' }, 'gpt-6.1-sol', 'xhigh')).toEqual({ reasoning: { effort: 'xhigh' } })
  const { api, provider, fetcher } = setup('openai', [{ type: 'response.completed', response: {} }])
  provider.baseUrl = 'https://api.openai.com/v1'
  await api.turn(provider, 'gpt-6.1-sol', [{ role: 'user', content: 'Build' }], [{ name: 'look', description: '', parameters: {} }], new AbortController().signal, () => {}, { maxOutputTokens: 8192, effort: 'high' })
  expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ reasoning: { effort: 'high', context: 'all_turns' } })
})
it('places Chat Completions images after all parallel tool results, with no internal image fields on the wire', async () => {
  const { api, provider, fetcher } = setup('openai', [{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
  await api.turn(provider, 'vision-model', calls, [], new AbortController().signal, () => {})
  const messages = JSON.parse(fetcher.mock.calls[0][1]!.body as string).messages
  expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
  expect(messages.at(-1).content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } })
  expect(messages.every((m: any) => !('images' in m))).toBe(true)
})
it('encodes Responses images and replays opaque reasoning and assistant phase exactly once', async () => {
  const items = [{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'opaque-state' }, { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking' }] }, { type: 'function_call', call_id: 'a', name: 'look', arguments: '{}' }]
  const first = setup('chatgpt', [...items.map(item => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: {} }])
  const result = await first.api.turn(first.provider, 'gpt-6.1-sol', [{ role: 'user', content: 'Go' }], [], new AbortController().signal, () => {})
  expect(result.responseItems).toEqual(items)
  const second = setup('chatgpt', [{ type: 'response.completed', response: {} }])
  await second.api.turn(second.provider, 'gpt-6.1-sol', [{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Looking', responseItems: result.responseItems, tool_calls: [{ id: 'a', type: 'function', function: { name: 'look', arguments: '{}' } }] }, { role: 'tool', content: 'View', tool_call_id: 'a', images: [image] }], [], new AbortController().signal, () => {})
  const sent = JSON.parse(second.fetcher.mock.calls[0][1]!.body as string)
  expect(sent.input.filter((i: any) => i.type === 'function_call')).toHaveLength(1)
  expect(sent.input).toContainEqual(items[0])
  expect(sent.input).toContainEqual(items[1])
  expect(sent.input.at(-1).content[1]).toMatchObject({ type: 'input_image', image_url: `data:image/png;base64,${image.data}` })
})
it('embeds Anthropic image blocks inside the corresponding tool_result', async () => {
  const { api, provider, fetcher } = setup('anthropic', [{ type: 'message_stop' }])
  await api.turn(provider, 'claude-sonnet-5-5', calls, [], new AbortController().signal, () => {})
  const content = JSON.parse(fetcher.mock.calls[0][1]!.body as string).messages.at(-1).content
  expect(content.map((c: any) => c.type)).toEqual(['tool_result', 'tool_result'])
  expect(content[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })
})
