import { describe, it, expect } from 'vitest'
import { validateEndpoint, sseEvents } from '../../src/main/http'
describe('provider endpoint validation', () => {
  it('allows HTTPS and loopback local servers', () => {
    expect(validateEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(validateEndpoint('http://127.0.0.1:11434/v1')).toContain('11434')
    expect(validateEndpoint('http://[::1]:1234/v1')).toContain('[::1]')
  })
  it('rejects plaintext remote endpoints and embedded credentials', () => {
    for (const value of ['http://example.com/v1', 'https://user:password@example.com/v1', 'file:///etc/passwd', 'https://example.com/?key=secret']) expect(() => validateEndpoint(value)).toThrow()
  })
})
describe('stream parsing', () => {
  it('reassembles split UTF-8 characters and split SSE frames', async () => {
    const data = new TextEncoder().encode('data: {"text":"🎮 hello"}\r\n\r\ndata: {"done":true}\n\ndata: [DONE]\n\n')
    const body = new ReadableStream({ start(controller) { for (let index = 0; index < data.length; index += 3) controller.enqueue(data.slice(index, index + 3)); controller.close() } })
    const result = []
    for await (const event of sseEvents(new Response(body))) result.push(event)
    expect(result).toEqual([{ text: '🎮 hello' }, { done: true }])
  })
  it('rejects invalid JSON events rather than treating the run as successful', async () => {
    await expect(async () => { for await (const _event of sseEvents(new Response('data: not-json\n\n'))) { /* Consume. */ } }).rejects.toThrow()
  })
})
