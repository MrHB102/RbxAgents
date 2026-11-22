import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { classify, extractText, pdfText, zipEntries } from '../../src/main/attachments'
import { MediaStore } from '../../src/main/media'
import { compactContext, historyTurns } from '../../src/main/context'
import { Providers, supportsPdf, type Turn } from '../../src/main/providers'
import type { Provider, Session } from '../../src/shared/types'
import type { Store } from '../../src/main/store'
import type { ChatGPTAuth } from '../../src/main/auth'

const directories: string[] = []
const temp = () => { const directory = mkdtempSync(join(tmpdir(), 'rbx-attach-')); directories.push(directory); return directory }
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllGlobals() })

/** A small ZIP writer for fixtures: deflated entries, no ZIP64. */
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), packed = deflateRawSync(data), filename = Buffer.from(name)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, filename, packed); centrals.push(central, filename)
    offset += 30 + filename.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
function pdf(content: string) {
  const stream = deflateSync(Buffer.from(content, 'latin1'))
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'), stream, Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')])
}

describe('classifying attachments', () => {
  it('confirms types by content and downgrades a renamed file', () => {
    expect(classify('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toMatchObject({ kind: 'image', mime: 'image/png' })
    expect(classify('fake.png', Buffer.from('hello'))).toMatchObject({ kind: 'file', mime: 'application/octet-stream' })
    expect(classify('Main.server.luau', Buffer.from('local x = 1'))).toMatchObject({ kind: 'text', text: true })
    expect(classify('notes.weird', Buffer.from('plain words here'))).toMatchObject({ kind: 'text' })
    expect(classify('blob.weird', Buffer.from([0, 1, 2, 3, 0, 9]))).toMatchObject({ kind: 'file' })
    expect(classify('sword.fbx', Buffer.from('Kaydara FBX Binary  \0'))).toMatchObject({ kind: 'model' })
    expect(classify('report.pdf', Buffer.from('%PDF-1.7'))).toMatchObject({ kind: 'pdf' })
    expect(classify('clip.mov', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ')]))).toMatchObject({ kind: 'video', mime: 'video/mp4' })
  })
})

describe('extracting text locally', () => {
  it('reads Word, PowerPoint, Excel and ZIP listings', () => {
    const dir = temp()
    const docx = join(dir, 'brief.docx'); writeFileSync(docx, zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Castle &amp; moat</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:body></w:document>' }))
    expect(extractText(docx, { kind: 'document', extension: 'docx' })?.text).toBe('Castle & moat\nSecond line\n')
    const pptx = join(dir, 'deck.pptx'); writeFileSync(pptx, zip({ 'ppt/slides/slide2.xml': '<p:sld><a:p><a:t>Two</a:t></a:p></p:sld>', 'ppt/slides/slide1.xml': '<p:sld><a:p><a:t>One</a:t></a:p></p:sld>' }))
    const slides = extractText(pptx, { kind: 'document', extension: 'pptx' })!
    expect(slides.pages).toBe(2)
    expect(slides.text.indexOf('One')).toBeLessThan(slides.text.indexOf('Two'))
    const xlsx = join(dir, 'prices.xlsx'); writeFileSync(xlsx, zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Shop" sheetId="1"/></sheets></workbook>', 'xl/sharedStrings.xml': '<sst><si><t>Sword</t></si><si><t>Price</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>250</v></c></row></sheetData></worksheet>' }))
    expect(extractText(xlsx, { kind: 'document', extension: 'xlsx' })?.text).toBe('## Sheet: Shop\nPrice\nSword\t250')
    const archive = join(dir, 'assets.zip'); writeFileSync(archive, zip({ 'a/b.lua': 'print(1)', 'c.png': 'x' }))
    expect(zipEntries(Buffer.from(zip({ x: '1' })))).toHaveLength(1)
    expect(extractText(archive, { kind: 'archive', extension: 'zip' })?.text).toContain('a/b.lua')
  })

  it('pulls text out of a compressed PDF content stream', () => {
    const result = pdfText(pdf('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj 0 -14 Td [(Wor) -20 (ld) -300 (again)] TJ ET'))
    expect(result.pages).toBe(1)
    expect(result.text).toContain('Hello PDF')
    expect(result.text).toContain('World again')
  })

  it('reports when a PDF has no extractable text', () => {
    expect(pdfText(pdf('q 1 0 0 1 0 0 cm Q')).text).toBe('')
  })
})

describe('storing attachments', () => {
  it('copies a file, keeps its stills, serves only previewable types, and removes unsent files', async () => {
    const dir = temp()
    const store = new MediaStore(join(dir, 'media'))
    const source = join(dir, 'Script.lua'); writeFileSync(source, 'print("hi")')
    const item = store.attach({ path: source, name: 'Script.lua' })
    expect(item).toMatchObject({ kind: 'text', source: 'user', name: 'Script.lua', bytes: 11 })
    expect(store.text(item)?.text).toBe('print("hi")')
    expect((await store.serve(`rbx-media://${item.id}`, null)).status).toBe(404)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)])
    const picture = store.attach({ data: new Uint8Array(jpeg), name: 'pasted.jpg', frames: [new Uint8Array(jpeg), new Uint8Array(Buffer.from('not a jpeg'))], meta: { width: 1920, height: 1080 } })
    expect(picture).toMatchObject({ kind: 'image', width: 1920, height: 1080 })
    expect(picture.frames).toHaveLength(1)
    expect((await store.serve(`rbx-media://${picture.id}`, null)).headers.get('content-type')).toBe('image/jpeg')
    store.remove(picture)
    expect(store.locate(picture.id)).toBeUndefined()
    expect(store.locate(picture.frames![0])).toBeUndefined()
    expect(() => store.attach({ path: join(dir, 'missing.txt'), name: 'missing.txt' })).toThrow('could not be read')
    expect(() => store.attach({ data: new Uint8Array(), name: 'empty.txt' })).toThrow('empty')
  })
})

describe('attachments in the model context', () => {
  const session = (): Session => ({ id: 's', agentId: 'a', title: 't', createdAt: '', updatedAt: '', tokens: 0, status: 'idle', messages: [
    { id: '1', role: 'user', content: 'Look at this', createdAt: '', media: [{ id: 'm1', kind: 'image', mime: 'image/png', name: 'ref.png', bytes: 10, source: 'user' }] },
    { id: '2', role: 'assistant', content: 'Seen.', createdAt: '' },
    { id: '3', role: 'user', content: 'Now this', createdAt: '', media: [{ id: 'm2', kind: 'text', mime: 'text/plain', name: 'a.lua', bytes: 10, source: 'user' }] }
  ] })
  it('decorates only messages with files and tells which is the newest', () => {
    const seen: [string, boolean][] = []
    const turns = historyTurns(session(), (message, latest) => { seen.push([message.id, latest]); return { content: `${message.content} +files` } })
    expect(seen).toEqual([['1', false], ['3', true]])
    expect(turns.map(t => t.content)).toEqual(['Look at this +files', 'Seen.', 'Now this +files'])
  })

  it('keeps pictures and documents only on the newest message that carries them', () => {
    const image = { mimeType: 'image/png' as const, data: 'AAAA' }
    const turns: Turn[] = [{ role: 'system', content: '' }, { role: 'user', content: 'old', images: [image], documents: [{ name: 'a.pdf', mimeType: 'application/pdf', data: 'AAAA' }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'new', images: [image, image, image, image, image, image] }]
    const result = compactContext(turns)
    expect(result.changed).toBe(true)
    expect(result.turns[1].images).toBeUndefined()
    expect(result.turns[1].documents).toBeUndefined()
    expect(result.turns[3].images).toHaveLength(6)
  })
})

describe('context compaction economy', () => {
  const round = (i: number, size: number): Turn[] => [{ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'call_tool', arguments: `{"n":${i}}` } }] }, { role: 'tool', tool_call_id: `c${i}`, content: `result ${i} `.repeat(size) }]
  it('clears old tool results before dropping rounds, and leaves headroom', () => {
    const turns: Turn[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'task' }, ...Array.from({ length: 12 }, (_, i) => round(i, 1000)).flat()]
    const { turns: result, changed } = compactContext(turns, 96_000)
    expect(changed).toBe(true)
    // Every call is still there, so the model keeps the trail of what it did.
    expect(result.filter(t => t.tool_calls).length).toBe(12)
    expect(result.filter(t => t.role === 'tool' && t.content.startsWith('[Older tool result cleared')).length).toBeGreaterThan(0)
    // The two newest rounds stay intact.
    expect(result.at(-1)!.content).toBe(turns.at(-1)!.content)
    expect(result.at(-3)!.content).toBe(turns.at(-3)!.content)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(96_000 * 0.75)
    // The next step adds a little and does not trigger compaction again.
    const next = compactContext([...result, ...round(99, 50)], 96_000)
    expect(next.changed).toBe(false)
  })
  it('reports no change while the context fits', () => {
    expect(compactContext([{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }]).changed).toBe(false)
  })
})

describe('provider input for attachments', () => {
  function setup(kind: Provider['kind'], baseUrl: string, events: unknown[]) {
    const response = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(response, { headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    const api = new Providers({ secret: () => 'key' } as unknown as Store, { token: async () => 'token' } as unknown as ChatGPTAuth)
    return { api, fetcher, provider: { id: 'p', name: 'P', kind, baseUrl, models: [], status: 'connected', hasKey: true } as Provider }
  }
  const pdfTurn: Turn[] = [{ role: 'user', content: 'Summarize', documents: [{ name: 'spec.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' }] }]
  const sent = (fetcher: ReturnType<typeof setup>['fetcher']) => JSON.parse(fetcher.mock.calls[0][1]!.body as string)

  it('sends PDFs as Anthropic document blocks before the question', async () => {
    const { api, fetcher, provider } = setup('anthropic', 'https://api.anthropic.com/v1', [{ type: 'message_start', message: { usage: {} } }, { type: 'message_stop' }])
    await api.turn(provider, 'claude-sonnet-5-5', pdfTurn, [], new AbortController().signal, () => {})
    const content = sent(fetcher).messages[0].content
    expect(content[0]).toMatchObject({ type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } })
    expect(content[1]).toMatchObject({ type: 'text', text: 'Summarize' })
  })

  it('sends PDFs as file parts to OpenAI with a prompt cache key', async () => {
    const { api, fetcher, provider } = setup('openai', 'https://api.openai.com/v1', [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    await api.turn(provider, 'gpt-4.1', pdfTurn, [], new AbortController().signal, () => {}, { maxOutputTokens: 100, cacheKey: 'abc' })
    const body = sent(fetcher)
    expect(body.prompt_cache_key).toBe('abc')
    expect(body.messages[0].content[1]).toEqual({ type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } })
    expect(body.messages[0]).not.toHaveProperty('documents')
  })

  it('knows which providers read PDFs', () => {
    expect(supportsPdf({ kind: 'anthropic', baseUrl: '' }, 'x')).toBe(true)
    expect(supportsPdf({ kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, 'x')).toBe(true)
    expect(supportsPdf({ kind: 'openai', baseUrl: 'http://localhost:11434/v1' }, 'x')).toBe(false)
  })
})
