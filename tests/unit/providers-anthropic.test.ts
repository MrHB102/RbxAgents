import { afterEach, expect, it, vi } from 'vitest'
import { Providers, effortFields } from '../../src/main/providers'
import type { Provider } from '../../src/shared/types'
import type { Store } from '../../src/main/store'
import type { ChatGPTAuth } from '../../src/main/auth'

afterEach(() => vi.unstubAllGlobals())
function setup(kind: Provider['kind'], events: unknown[]) {
  const response = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(response, { headers: { 'Content-Type': 'text/event-stream' } }))
  vi.stubGlobal('fetch', fetcher)
  const api = new Providers({ secret: () => 'fixture-key' } as unknown as Store, { token: async () => 'fixture-token' } as unknown as ChatGPTAuth)
  const provider: Provider = { id: 'test', name: 'Test', kind, baseUrl: kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'http://localhost:1234/v1', models: [], status: 'connected', hasKey: true }
  return { api, provider, fetcher }
}
const body = (fetcher: ReturnType<typeof setup>['fetcher']) => JSON.parse(fetcher.mock.calls[0][1]!.body as string)
const finished = [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'message_delta', usage: { output_tokens: 5 } }, { type: 'message_stop' }]
const signal = () => new AbortController().signal

it('caches the Anthropic prefix: every system block, the last tool, and the newest message', async () => {
  const { api, provider, fetcher } = setup('anthropic', finished)
  await api.turn(provider, 'claude-sonnet-5-5', [{ role: 'system', content: 'Stable rules' }, { role: 'system', content: 'Session memory' }, { role: 'user', content: 'Hello' }], [{ name: 'a', description: 'A', parameters: {} }, { name: 'b', description: 'B', parameters: {} }], signal(), () => {})
  const sent = body(fetcher)
  expect(sent.system).toEqual([{ type: 'text', text: 'Stable rules', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Session memory', cache_control: { type: 'ephemeral' } }])
  expect(sent.tools[0].cache_control).toBeUndefined()
  expect(sent.tools[1].cache_control).toEqual({ type: 'ephemeral' })
  expect(sent.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
})

it('sends reasoning effort only where the model accepts it', async () => {
  const claude = setup('anthropic', finished)
  await claude.api.turn(claude.provider, 'claude-opus-5-5', [{ role: 'user', content: 'Hi' }], [], signal(), () => {}, { maxOutputTokens: 9000, effort: 'xhigh' })
  expect(body(claude.fetcher)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, max_tokens: 9000 })
  const older = setup('anthropic', finished)
  await older.api.turn(older.provider, 'claude-opus-4-6', [{ role: 'user', content: 'Hi' }], [], signal(), () => {}, { maxOutputTokens: 9000, effort: 'xhigh' })
  expect(body(older.fetcher).output_config.effort).toBe('high')
  const unsupported = setup('anthropic', finished)
  await unsupported.api.turn(unsupported.provider, 'claude-3-haiku', [{ role: 'user', content: 'Hi' }], [], signal(), () => {}, { maxOutputTokens: 900, effort: 'high' })
  expect(body(unsupported.fetcher)).not.toHaveProperty('output_config')
  expect(body(unsupported.fetcher)).not.toHaveProperty('thinking')
  expect(effortFields({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-5.1', 'max')).toEqual({ reasoning_effort: 'high' })
  expect(effortFields({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-4o', 'high')).toEqual({})
  expect(effortFields({ kind: 'openai', baseUrl: 'http://localhost:1234/v1' }, 'gpt-5', 'high')).toEqual({})
  expect(effortFields({ kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, 'x/y', 'low')).toEqual({ reasoning: { effort: 'low' } })
  expect(effortFields({ kind: 'chatgpt', baseUrl: '' }, 'gpt-5-codex', 'medium')).toEqual({ reasoning: { effort: 'medium' } })
  expect(effortFields({ kind: 'anthropic', baseUrl: '' }, 'claude-opus-5-5', undefined)).toEqual({})
})

it('returns Anthropic thinking blocks and replays them, with user updates after tool results, in one message', async () => {
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'a' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]
  const first = setup('anthropic', events)
  const result = await first.api.turn(first.provider, 'claude-opus-5-5', [{ role: 'user', content: 'Go' }], [{ name: 'a', description: 'A', parameters: {} }], signal(), () => {})
  expect(result.thinking).toEqual([{ type: 'thinking', thinking: 'Considering', signature: 'sig-1' }])
  const second = setup('anthropic', finished)
  await second.api.turn(second.provider, 'claude-opus-5-5', [{ role: 'user', content: 'Go' }, { role: 'assistant', content: '', thinking: result.thinking, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'a', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'done' }, { role: 'user', content: '[User update] also this' }], [], signal(), () => {})
  const messages = body(second.fetcher).messages
  expect(messages[1].content.map((c: { type: string }) => c.type)).toEqual(['thinking', 'tool_use'])
  expect(messages).toHaveLength(3)
  expect(messages[2].content.map((c: { type: string }) => c.type)).toEqual(['tool_result', 'text'])
})

it('does not leak thinking blocks into OpenAI-compatible requests', async () => {
  const { api, provider, fetcher } = setup('openai', [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
  await api.turn(provider, 'm', [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'x', thinking: [{ type: 'thinking' }] }], [], signal(), () => {})
  expect(JSON.stringify(body(fetcher).messages)).not.toContain('thinking')
})
