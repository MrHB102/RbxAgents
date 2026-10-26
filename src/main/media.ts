import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { MediaItem } from '../shared/types'

/** Chat previews are served to the window under this scheme, never from file:// paths. */
export const MEDIA_SCHEME = 'rbx-media'
const MB = 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STORED = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(mp4|webm|gif|png|jpg|webp)$/

interface Kind { mime: string; kind: MediaItem['kind']; limit: number; magic: (head: Buffer) => boolean }
const text = (head: Buffer, from: number, to: number) => head.subarray(from, to).toString('latin1')
const KINDS: Record<string, Kind> = {
  '.mp4': { mime: 'video/mp4', kind: 'video', limit: 400 * MB, magic: h => text(h, 4, 8) === 'ftyp' },
  '.webm': { mime: 'video/webm', kind: 'video', limit: 400 * MB, magic: h => h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3 },
  '.gif': { mime: 'image/gif', kind: 'image', limit: 60 * MB, magic: h => text(h, 0, 4) === 'GIF8' },
  '.png': { mime: 'image/png', kind: 'image', limit: 60 * MB, magic: h => h[0] === 0x89 && text(h, 1, 4) === 'PNG' },
  '.jpg': { mime: 'image/jpeg', kind: 'image', limit: 60 * MB, magic: h => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', kind: 'image', limit: 60 * MB, magic: h => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.webp': { mime: 'image/webp', kind: 'image', limit: 60 * MB, magic: h => text(h, 0, 4) === 'RIFF' && text(h, 8, 12) === 'WEBP' }
}
const STORE_EXTENSION: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/gif': '.gif', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
export const SHAREABLE = Object.keys(KINDS).join(', ')

function readHead(path: string) {
  const fd = openSync(path, 'r')
  try { const buffer = Buffer.alloc(16); const read = readSync(fd, buffer, 0, 16, 0); return buffer.subarray(0, read) } finally { closeSync(fd) }
}

/** Rendered previews shared in chats. Files are copied here, checked by content, and served only by their random id. */
export class MediaStore {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true }) }

  /** A fresh folder for one Blender render. Removed by `discard` once the result is copied in. */
  scratch() { const path = join(this.directory, 'incoming', randomUUID()); mkdirSync(path, { recursive: true }); return path }
  discard(path: string) { if (path.startsWith(join(this.directory, 'incoming'))) rmSync(path, { recursive: true, force: true }) }

  ingest(source: string, options: { caption?: string; name?: string } = {}): MediaItem {
    if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('Give the full path of the file to share.')
    const extension = extname(source).toLowerCase()
    const type = KINDS[extension]
    if (!type) throw new Error(`Only ${SHAREABLE} files can be shared in the chat.`)
    let info
    try { info = statSync(source) } catch { throw new Error('That file does not exist on this computer. Blender must run on the same computer as RBX Agents.') }
    if (!info.isFile()) throw new Error('That path is not a file.')
    if (info.size === 0) throw new Error('The file is empty. The render may not have finished.')
    if (info.size > type.limit) throw new Error(`The file is ${Math.round(info.size / MB)} MB; the limit for this type is ${Math.round(type.limit / MB)} MB. Render a shorter or smaller preview.`)
    if (!type.magic(readHead(source))) throw new Error(`The file content is not a valid ${extension.slice(1)} file.`)
    const id = randomUUID()
    copyFileSync(source, join(this.directory, `${id}${STORE_EXTENSION[type.mime]}`))
    return { id, kind: type.kind, mime: type.mime, name: (options.name || basename(source)).slice(0, 120), bytes: info.size, ...(options.caption?.trim() ? { caption: options.caption.trim().slice(0, 300) } : {}) }
  }

  locate(id: string) {
    if (!ID.test(id)) return undefined
    for (const [mime, extension] of Object.entries(STORE_EXTENSION)) {
      const path = join(this.directory, `${id}${extension}`)
      if (existsSync(path)) return { path, mime }
    }
    return undefined
  }

  /** Deletes stored files no message refers to any more. `incoming` only holds renders that were interrupted. */
  prune(keep: Set<string>, options: { incoming?: boolean } = {}) {
    for (const name of readdirSync(this.directory)) {
      const match = STORED.exec(name)
      if (match && !keep.has(match[1])) rmSync(join(this.directory, name), { force: true })
    }
    if (options.incoming) rmSync(join(this.directory, 'incoming'), { recursive: true, force: true })
  }

  /** Answers a request for rbx-media://<id>, including the Range requests a <video> sends to play and seek. */
  async serve(url: string, range: string | null): Promise<Response> {
    let id = ''
    try { id = new URL(url).hostname } catch { /* falls through to 404 */ }
    const found = this.locate(id)
    if (!found) return new Response('Not found', { status: 404 })
    const size = statSync(found.path).size
    const headers: Record<string, string> = { 'Content-Type': found.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range || '')
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
      return new Response(Readable.toWeb(createReadStream(found.path, { start, end })) as ReadableStream, { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } })
    }
    return new Response(Readable.toWeb(createReadStream(found.path)) as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  }
}