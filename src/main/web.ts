import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'
import { TOOL_RESULT_CHARACTERS, clip } from './context'

/**
 * Internet access for agents: search the web and read pages.
 *
 * A model chooses the URLs, and page text can try to steer it, so this module only reaches the public internet:
 * no loopback, private, link-local, or cloud-metadata addresses (checked again on every redirect and at connection time,
 * which also defeats DNS rebinding), only ports 80 and 443, no credentials in URLs, no cookies, GET only,
 * size and time limits, and text-like content only.
 */
export interface WebPolicy {
  ports: number[]
  /** Lets tests reach a local server. Never set from model input. */
  allow?: (url: URL) => boolean
}
export const PUBLIC_WEB: WebPolicy = { ports: [80, 443] }
const MAX_BYTES = 2_000_000
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 15_000
const USER_AGENT = 'Mozilla/5.0 (compatible; RBXAgents/0.2; +https://github.com/MrHB102/RbxAgents)'
const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|x-yaml|yaml|javascript|markdown)|[a-z]+\/[a-z0-9.+-]+\+(json|xml))/i

export function blockedAddress(address: string): boolean {
  const kind = net.isIP(address)
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
  }
  if (kind === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
    const mapped = /^(?:0{0,4}:){0,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return blockedAddress(mapped[1])
    const groups = lower.split(':')
    const first = parseInt(groups[0] || '0', 16)
    return lower === '::' || lower === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
      || lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8') || lower.startsWith('::ffff:')
  }
  return true
}

/** Validates a URL before any connection. Hostnames are checked again when they are resolved. */
export function checkUrl(value: string, policy: WebPolicy = PUBLIC_WEB): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('That is not a valid URL. Use a full address such as https://create.roblox.com/docs.') }
  if (policy.allow?.(url)) return url
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses can be read.')
  if (url.username || url.password) throw new Error('URLs with a username or password are not allowed.')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!policy.ports.includes(port)) throw new Error('Only the standard web ports (80 and 443) are allowed.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !net.isIP(host) && !host.includes(':')) throw new Error('Only public internet addresses can be read, not local or internal hosts.')
  if (net.isIP(host) && blockedAddress(host)) throw new Error('Private, loopback, and link-local addresses are blocked.')
  return url
}

function guardedLookup(policy: WebPolicy, url: URL) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: (...args: any[]) => void) => {
    const opts = typeof options === 'object' ? options : { family: options }
    dnsLookup(hostname, { all: true, family: opts.family }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error)
      // Every address must be public; a single private one makes the host unusable (rebinding protection).
      if (!policy.allow?.(url) && (!addresses.length || addresses.some(a => blockedAddress(a.address)))) return callback(new Error('That host resolves to a private or internal address, which is blocked.'))
      if (opts.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

export interface WebResponse { url: string; status: number; contentType: string; text: string; truncated: boolean }
export interface WebRequestOptions { signal?: AbortSignal; policy?: WebPolicy; headers?: Record<string, string>; accept?: string; maxBytes?: number }

function decoded(response: http.IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip())
  if (encoding === 'deflate') return response.pipe(createInflate())
  if (encoding === 'br') return response.pipe(createBrotliDecompress())
  return response
}

function once(url: URL, policy: WebPolicy, options: WebRequestOptions): Promise<{ response: http.IncomingMessage; request: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(url, {
      method: 'GET', lookup: guardedLookup(policy, url) as never, timeout: TIMEOUT_MS, signal: options.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9', ...options.headers }
    }, response => resolve({ response, request }))
    request.once('timeout', () => request.destroy(new Error('The site took too long to respond.')))
    request.once('error', error => reject(error.name === 'AbortError' ? error : new Error(`Could not reach the site: ${error.message}`)))
    request.end()
  })
}

/** Reads one public web resource as text, following a few validated redirects. */
export async function webGet(address: string, options: WebRequestOptions = {}): Promise<WebResponse> {
  const policy = options.policy || PUBLIC_WEB
  let url = checkUrl(address, policy)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { response, request } = await once(url, policy, options)
    const status = response.statusCode || 0
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume()
      if (hop === MAX_REDIRECTS) throw new Error('The site redirected too many times.')
      url = checkUrl(new URL(response.headers.location, url).toString(), policy)
      continue
    }
    if (status < 200 || status >= 300) { response.resume(); throw new Error(`The site answered ${status}${status === 404 ? ' (not found)' : status === 403 || status === 401 ? ' (access refused)' : status === 429 ? ' (rate limited; try again later)' : ''}.`) }
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType && !TEXT_TYPES.test(contentType)) { response.resume(); throw new Error(`This is ${contentType}, not text. Only pages, documents, and data files can be read.`) }
    const charset = /charset=([\w-]+)/i.exec(String(response.headers['content-type'] || ''))?.[1] || 'utf-8'
    const limit = options.maxBytes ?? MAX_BYTES
    const chunks: Buffer[] = []
    let size = 0, truncated = false
    await new Promise<void>((resolve, reject) => {
      const stream = decoded(response)
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) { truncated = true; chunks.push(chunk.subarray(0, chunk.length - (size - limit))); request.destroy(); stream.destroy(); resolve(); return }
        chunks.push(chunk)
      })
      stream.once('end', resolve)
      stream.once('error', error => truncated ? resolve() : reject(new Error(`Could not read the response: ${error.message}`)))
      response.once('error', error => truncated ? resolve() : reject(error))
    })
    let text: string
    try { text = new TextDecoder(charset, { fatal: false }).decode(Buffer.concat(chunks)) } catch { text = Buffer.concat(chunks).toString('utf8') }
    return { url: url.toString(), status, contentType, text, truncated }
  }
  throw new Error('The site redirected too many times.')
}

// ---- Text extraction -----------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', times: '×', rarr: '→', larr: '←' }
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '' } catch { return '' }
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}
const flat = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** Turns HTML into readable markdown-ish text: headings, lists, code, and links survive; scripts and chrome do not. */
export function htmlToText(source: string, baseUrl: string): { title: string; text: string } {
  const html = source.slice(0, 1_500_000)
  const title = flat(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, '')
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(body)
  if (main && main[2].length > 500) body = main[2]
  body = body.replace(/<(nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1\s*>/gi, '')
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, code: string) => `\n\`\`\`\n${decodeEntities(code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))}\n\`\`\`\n`)
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${flat(inner)}\n\n`)
  const self = baseUrl.split('#')[0].replace(/\/$/, '')
  body = body.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, double: string | undefined, single: string | undefined, inner: string) => {
    const label = flat(inner)
    let href = ''
    try { const target = new URL(decodeEntities((double ?? single ?? '').trim()), baseUrl); if (/^https?:$/.test(target.protocol)) { target.hash = ''; href = target.toString(); /* Links back to this page only cost tokens. */ if (href.replace(/\/$/, '') === self) href = '' } } catch { /* Keep the label only. */ }
    return label && href ? `[${label}](${href})` : label
  })
  body = body.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|dd|dt)\s*>/gi, '\n').replace(/<(br|hr)\s*\/?>/gi, '\n').replace(/<\/t[dh]\s*>/gi, ' | ')
  const text = decodeEntities(body.replace(/<[^>]+>/g, ''))
    .split('\n').map(line => line.replace(/[ \t\f\v ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title, text }
}

/** One page of text, shaped like the skill pages: bounded JSON the model can continue with `offset`. */
export function webPage(url: string, title: string, text: string, offset: number, requestedLength: number, truncated = false) {
  let length = requestedLength
  while (true) {
    const next = offset + length < text.length ? offset + length : null
    const json = JSON.stringify({ url, title: title || undefined, untrusted_web_content: true, totalCharacters: text.length, offset, nextOffset: next, truncatedDownload: truncated || undefined, content: text.slice(offset, offset + length) })
    if (json.length <= TOOL_RESULT_CHARACTERS || length <= 100) return json
    length = Math.max(100, Math.floor(length * 0.7))
  }
}

// ---- Search --------------------------------------------------------------------------------------------------

export interface SearchResult { title: string; url: string; snippet: string }
export type SearchBackend = 'duckduckgo' | 'brave'

export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const anchors = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  for (const [index, match] of anchors.entries()) {
    let target = decodeEntities(match[1])
    try {
      const parsed = new URL(target, 'https://duckduckgo.com')
      target = parsed.searchParams.get('uddg') || parsed.toString()
      if (!/^https?:\/\//i.test(target) || parsed.searchParams.has('ad_domain') || /duckduckgo\.com\/y\.js/.test(parsed.toString())) continue
    } catch { continue }
    const between = html.slice((match.index ?? 0) + match[0].length, anchors[index + 1]?.index ?? undefined)
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(between)?.[1] || ''
    results.push({ title: clip(flat(match[2]), 160), url: target, snippet: clip(flat(snippet), 300) })
    if (results.length >= limit) break
  }
  return results
}

export function parseBrave(json: string, limit: number): SearchResult[] {
  const data = JSON.parse(json) as { web?: { results?: { title?: string; url?: string; description?: string }[] } }
  return (data.web?.results || []).filter(r => r.url && /^https?:\/\//i.test(r.url)).slice(0, limit).map(r => ({ title: clip(flat(r.title || r.url!), 160), url: r.url!, snippet: clip(flat(r.description || ''), 300) }))
}

export async function webSearch(query: string, limit: number, options: WebRequestOptions & { braveKey?: string } = {}): Promise<{ backend: SearchBackend; results: SearchResult[] }> {
  const q = query.trim().slice(0, 300)
  if (!q) throw new Error('Give a search query.')
  const count = Math.min(8, Math.max(1, limit))
  if (options.braveKey) {
    const response = await webGet(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, { ...options, accept: 'application/json', headers: { 'X-Subscription-Token': options.braveKey } })
    return { backend: 'brave', results: parseBrave(response.text, count) }
  }
  const response = await webGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, options)
  if (/anomaly|captcha|unusual traffic/i.test(response.text) && !/result__a/.test(response.text)) throw new Error('DuckDuckGo is limiting automated searches right now. Try again shortly, or add a Brave Search API key in Settings.')
  return { backend: 'duckduckgo', results: parseDuckDuckGo(response.text, count) }
}

/** The pair of operations the runtime needs. Replaceable in tests. */
export interface WebTools {
  search(query: string, limit: number, signal: AbortSignal, braveKey?: string): Promise<{ backend: SearchBackend; results: SearchResult[] }>
  fetch(url: string, signal: AbortSignal): Promise<{ url: string; title: string; text: string; truncated: boolean }>
}
export const realWeb: WebTools = {
  search: (query, limit, signal, braveKey) => webSearch(query, limit, { signal, braveKey }),
  async fetch(url, signal) {
    const response = await webGet(url, { signal })
    if (/html|xml/.test(response.contentType) || /^\s*<(!doctype|html)/i.test(response.text)) {
      const page = htmlToText(response.text, response.url)
      return { url: response.url, title: page.title, text: page.text || '(The page has no readable text. It may need JavaScript.)', truncated: response.truncated }
    }
    return { url: response.url, title: '', text: response.text, truncated: response.truncated }
  }
}
