import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaStore } from '../../src/main/media'

const FILES = {
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32, 1)]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 2)]),
  png: Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(32, 3)]),
  gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 4)]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 5)]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(32, 6)])
}
const directories: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rbx-media-'))
  directories.push(root)
  const source = (name: string, content: Buffer | string) => { const path = join(root, name); writeFileSync(path, content); return path }
  return { root, store: new MediaStore(join(root, 'media')), source }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('sharing files in the chat', () => {
  it.each(Object.entries(FILES))('accepts a real .%s file, copies it, and describes it', (extension, content) => {
    const { store, source } = fixture()
    const item = store.ingest(source(`render.${extension}`, content), { caption: '  a turntable  ' })
    expect(item.kind).toBe(extension === 'mp4' || extension === 'webm' ? 'video' : 'image')
    expect(item.bytes).toBe(content.length)
    expect(item.caption).toBe('a turntable')
    expect(item.name).toBe(`render.${extension}`)
    expect(store.locate(item.id)?.mime).toBe(item.mime)
    expect(readdirSync(store.directory).filter(n => n.startsWith(item.id))).toHaveLength(1)
  })
  it('limits captions and names', () => {
    const { store, source } = fixture()
    const item = store.ingest(source('a.png', FILES.png), { caption: 'x'.repeat(900), name: 'n'.repeat(500) })
    expect(item.caption).toHaveLength(300)
    expect(item.name).toHaveLength(120)
  })
  it('refuses anything that is not a media file the app can show', () => {
    const { store, source, root } = fixture()
    expect(() => store.ingest('render.mp4')).toThrow(/full path/)
    expect(() => store.ingest(source('tool.exe', FILES.png))).toThrow(/Only .* files can be shared/)
    expect(() => store.ingest(source('clip.mov', FILES.mp4))).toThrow(/Only .* files can be shared/)
    expect(() => store.ingest(source('image.svg', '<svg onload="alert(1)"/>'))).toThrow(/Only .* files can be shared/)
    expect(() => store.ingest(source('fake.png', 'this is text, not a picture'))).toThrow(/not a valid png/)
    expect(() => store.ingest(source('swapped.mp4', FILES.png))).toThrow(/not a valid mp4/)
    expect(() => store.ingest(source('empty.webm', Buffer.alloc(0)))).toThrow(/empty/)
    expect(() => store.ingest(join(root, 'missing.png'))).toThrow(/does not exist/)
    mkdirSync(join(root, 'folder.png'))
    expect(() => store.ingest(join(root, 'folder.png'))).toThrow(/not a file/)
    expect(readdirSync(store.directory)).toEqual([])
  })
  it('only finds files by their random id', () => {
    const { store, source } = fixture()
    const item = store.ingest(source('a.png', FILES.png))
    expect(store.locate(item.id)).toBeTruthy()
    for (const id of ['', '..', '../media', `${item.id}.png`, item.id.toUpperCase(), 'not-an-id']) expect(store.locate(id)).toBeUndefined()
  })
  it('removes files that no message uses, and renders left over from a crash', () => {
    const { store, source } = fixture()
    const keep = store.ingest(source('a.png', FILES.png))
    const drop = store.ingest(source('b.mp4', FILES.mp4))
    const scratch = store.scratch()
    writeFileSync(join(scratch, 'preview.mp4'), FILES.mp4)
    store.prune(new Set([keep.id]))
    expect(store.locate(keep.id)).toBeTruthy()
    expect(store.locate(drop.id)).toBeUndefined()
    expect(existsSync(scratch)).toBe(true)
    store.prune(new Set([keep.id]), { incoming: true })
    expect(existsSync(scratch)).toBe(false)
    expect(store.locate(keep.id)).toBeTruthy()
  })
  it('only discards folders it created for a render', () => {
    const { store, root } = fixture()
    const elsewhere = join(root, 'important')
    mkdirSync(elsewhere)
    store.discard(elsewhere)
    expect(existsSync(elsewhere)).toBe(true)
    const scratch = store.scratch()
    store.discard(scratch)
    expect(existsSync(scratch)).toBe(false)
  })
})

describe('serving previews to the window', () => {
  const bytes = async (response: Response) => Buffer.from(await response.arrayBuffer())
  it('serves the whole file, and the pieces a video asks for while it plays and seeks', async () => {
    const { store, source } = fixture()
    const item = store.ingest(source('clip.mp4', FILES.mp4))
    const url = `rbx-media://${item.id}/`
    const whole = await store.serve(url, null)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(await bytes(whole)).toEqual(FILES.mp4)
    const middle = await store.serve(url, 'bytes=4-11')
    expect(middle.status).toBe(206)
    expect(middle.headers.get('content-range')).toBe(`bytes 4-11/${FILES.mp4.length}`)
    expect(await bytes(middle)).toEqual(FILES.mp4.subarray(4, 12))
    const open = await store.serve(url, 'bytes=30-')
    expect(await bytes(open)).toEqual(FILES.mp4.subarray(30))
    const tail = await store.serve(url, 'bytes=-6')
    expect(await bytes(tail)).toEqual(FILES.mp4.subarray(FILES.mp4.length - 6))
    const clamped = await store.serve(url, `bytes=40-${FILES.mp4.length + 500}`)
    expect(clamped.headers.get('content-range')).toBe(`bytes 40-${FILES.mp4.length - 1}/${FILES.mp4.length}`)
  })
  it('answers impossible ranges and unknown ids without leaking anything', async () => {
    const { store, source } = fixture()
    const item = store.ingest(source('a.png', FILES.png))
    expect((await store.serve(`rbx-media://${item.id}/`, 'bytes=999-1000')).status).toBe(416)
    expect((await store.serve(`rbx-media://${item.id}/`, 'bytes=9-3')).status).toBe(416)
    for (const url of ['rbx-media://00000000-0000-4000-8000-000000000000/', 'rbx-media://..%2F..%2Fsecret/', 'rbx-media:///etc/passwd', 'rbx-media://not-a-url']) expect((await store.serve(url, null)).status).toBe(404)
  })
})