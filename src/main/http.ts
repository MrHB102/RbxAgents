export function validateEndpoint(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error('Use an endpoint without credentials, query parameters, or fragments.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost for a local provider.')
  return url.toString().replace(/\/$/, '')
}
export async function checkedFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(30_000) })
  if (!response.ok) {
    let detail = ''
    try { const body = await response.json() as { error?: { message?: string } }; detail = body.error?.message || '' } catch { /* Do not expose raw HTML or response headers. */ }
    throw new Error(`Request failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }
  return response
}

export async function* sseEvents(response: Response): AsyncGenerator<Record<string, any>> {
  if (!response.body) throw new Error('The provider returned an empty stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parseFrame = (frame: string) => frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      if (buffer.length > 8_000_000) throw new Error('Provider event exceeded the size limit.')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const data = parseFrame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2)
        if (data === '[DONE]') return
        if (data) yield JSON.parse(data)
      }
      if (done) {
        const data = parseFrame(buffer)
        if (data && data !== '[DONE]') yield JSON.parse(data)
        break
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
