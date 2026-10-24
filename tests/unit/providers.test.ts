import { afterEach, expect, it, vi } from 'vitest'
import { Providers } from '../../src/main/providers'
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
