import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { blockedAddress, checkUrl, decodeEntities, htmlToText, parseBrave, parseDuckDuckGo, webGet, webPage, type WebPolicy } from '../../src/main/web'

describe('address and URL policy', () => {
  it('blocks private, loopback, link-local, metadata, and mapped addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'not-an-ip']) expect(blockedAddress(address), address).toBe(true)
    for (const address of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '151.101.1.69', '2606:4700:4700::1111']) expect(blockedAddress(address), address).toBe(false)
  })
  it('accepts public web addresses and rejects everything else before connecting', () => {
    expect(checkUrl('https://create.roblox.com/docs/reference').hostname).toBe('create.roblox.com')
    expect(checkUrl('http://example.com/a?b=1').port).toBe('')
    for (const bad of ['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'http://localhost/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data', 'http://printer.local/', 'http://intranet/', 'http://db.internal/', 'https://user:pass@example.com/', 'https://example.com:8443/', 'http://example.com:22/', 'not a url', '']) expect(() => checkUrl(bad), bad).toThrow()
  })
})

describe('text extraction', () => {
  const html = `<!doctype html><html><head><title>Heartbeat &amp; Stepped &mdash; Docs</title><script>var secret = 1</script><style>.a{}</style></head>
  <body><nav><a href="/home">Home</a><a href="/docs">Docs</a></nav><header>Site header</header>
  <main><h1>RunService</h1><p>Use <code>Heartbeat</code> for per-frame work.<br>Second&nbsp;line &#8211; with entities &#x41;.</p>
  <ul><li>First <a href="/docs/Heartbeat#x">link</a> and <a href="/docs/en-us/#members">self</a></li><li>Second <a href="javascript:void(0)">bad link</a></li></ul>
  <pre><code>local RunService = game:GetService(&quot;RunService&quot;)
RunService.Heartbeat:Connect(function(dt)
end)</code></pre>
  <table><tr><td>A</td><td>B</td></tr></table><p>${'More text. '.repeat(60)}</p></main><footer>Footer</footer><!-- hidden --></body></html>`
  const page = htmlToText(html, 'https://create.roblox.com/docs/en-us/')
  it('keeps structure, resolves links, and drops scripts and page chrome', () => {
    expect(page.title).toBe('Heartbeat & Stepped — Docs')
    expect(page.text).toContain('# RunService')
    expect(page.text).toContain('- First [link](https://create.roblox.com/docs/Heartbeat) and self')
    expect(page.text).toContain('Second line – with entities A.')
    expect(page.text).toContain('```\nlocal RunService = game:GetService("RunService")\nRunService.Heartbeat:Connect(function(dt)\nend)\n```')
    expect(page.text).toContain('A | B')
    expect(page.text).not.toMatch(/secret|Site header|Footer|hidden|Home/)
    expect(page.text).not.toContain('javascript:')
    expect(page.text).toContain('bad link')
  })
  it('decodes entities safely', () => {
    expect(decodeEntities('&lt;b&gt; &amp;amp; &#128512; &#x110000; &unknown;')).toBe('<b> &amp; 😀  &unknown;')
  })
  it('pages stay valid JSON within the tool-result limit', () => {
    const text = '"quoted"\n'.repeat(4000)
    const first = JSON.parse(webPage('https://x.test/', 'T', text, 0, 5000))
    expect(first.untrusted_web_content).toBe(true)
    expect(webPage('https://x.test/', 'T', text, 0, 5000).length).toBeLessThanOrEqual(6000)
    expect(first.nextOffset).toBeGreaterThan(0)
    const second = JSON.parse(webPage('https://x.test/', 'T', text, first.nextOffset, 5000))
    expect(second.offset).toBe(first.nextOffset)
    expect(JSON.parse(webPage('https://x.test/', 'T', 'short', 0, 5000)).nextOffset).toBeNull()
  })
})

describe('search parsing', () => {
  it('reads DuckDuckGo results, unwraps redirect links, and skips ads', () => {
    const html = `<div class="result results_links results_links_deep web-result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcreate.roblox.com%2Fdocs%2Freference%2Fengine%2Fclasses%2FRunService&amp;rut=abc">RunService | <b>Documentation</b></a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Service for <b>frame</b> events &amp; more.</a></div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.test&amp;u=1">Buy things</a><a class="result__snippet">Ad</a></div>
      <div class="result"><a class="result__a" href="https://devforum.roblox.com/t/heartbeat/1">Heartbeat on DevForum</a><a class="result__snippet" href="x">Discussion.</a></div>`
    expect(parseDuckDuckGo(html, 5)).toEqual([
      { title: 'RunService | Documentation', url: 'https://create.roblox.com/docs/reference/engine/classes/RunService', snippet: 'Service for frame events & more.' },
      { title: 'Heartbeat on DevForum', url: 'https://devforum.roblox.com/t/heartbeat/1', snippet: 'Discussion.' }
    ])
    expect(parseDuckDuckGo(html, 1)).toHaveLength(1)
  })
  it('reads Brave results and ignores non-web links', () => {
    const json = JSON.stringify({ web: { results: [{ title: 'A <strong>x</strong>', url: 'https://a.test/', description: 'Desc' }, { title: 'B', url: 'javascript:alert(1)' }] } })
    expect(parseBrave(json, 5)).toEqual([{ title: 'A x', url: 'https://a.test/', snippet: 'Desc' }])
  })
})

describe('fetching', () => {
  let server: Server, base = '', policy: WebPolicy
  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(body) }
      if (req.url === '/page') return send(200, 'text/html; charset=utf-8', '<html><head><title>Hello</title></head><body><p>World</p></body></html>')
      if (req.url === '/gzip') return send(200, 'text/plain', gzipSync('compressed text'), { 'Content-Encoding': 'gzip' })
      if (req.url === '/redirect') return send(302, 'text/plain', '', { Location: '/page' })
      if (req.url === '/loop') return send(302, 'text/plain', '', { Location: '/loop' })
      if (req.url === '/to-metadata') return send(302, 'text/plain', '', { Location: 'http://169.254.169.254/latest/meta-data/' })
      if (req.url === '/image') return send(200, 'image/png', Buffer.from([1, 2, 3]))
      if (req.url === '/big') return send(200, 'text/plain', 'x'.repeat(5000))
      if (req.url === '/missing') return send(404, 'text/html', 'nope')
      if (req.url === '/header') return send(200, 'application/json', JSON.stringify({ agent: req.headers['user-agent'], cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null }))
      send(500, 'text/plain', 'unexpected')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    base = `http://127.0.0.1:${port}`
    // Only the test server is reachable; the metadata address is still refused.
    policy = { ports: [port, 80], allow: url => url.hostname === '127.0.0.1' && url.port === String(port) }
  })
  afterAll(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))

  it('reads text, follows safe redirects, and decodes compression', async () => {
    expect((await webGet(`${base}/page`, { policy })).text).toContain('World')
    const redirected = await webGet(`${base}/redirect`, { policy })
    expect(redirected.url).toBe(`${base}/page`)
    expect(redirected.contentType).toBe('text/html')
    expect((await webGet(`${base}/gzip`, { policy })).text).toBe('compressed text')
  })
  it('refuses redirects to internal addresses, loops, binary files, and error pages', async () => {
    await expect(webGet(`${base}/to-metadata`, { policy })).rejects.toThrow('blocked')
    await expect(webGet(`${base}/loop`, { policy })).rejects.toThrow('too many times')
    await expect(webGet(`${base}/image`, { policy })).rejects.toThrow('image/png')
    await expect(webGet(`${base}/missing`, { policy })).rejects.toThrow('404')
  })
  it('stops reading at the size limit and says so', async () => {
    const result = await webGet(`${base}/big`, { policy, maxBytes: 1000 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(1000)
  })
  it('sends no cookies or credentials', async () => {
    const seen = JSON.parse((await webGet(`${base}/header`, { policy })).text)
    expect(seen.cookie).toBeNull()
    expect(seen.auth).toBeNull()
    expect(seen.agent).toContain('RBXAgents')
  })
  it('does not reach the local server under the public policy', async () => {
    await expect(webGet(`${base}/page`)).rejects.toThrow()
  })
  it('stops when cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(webGet(`${base}/page`, { policy, signal: controller.signal })).rejects.toThrow()
  })
})
