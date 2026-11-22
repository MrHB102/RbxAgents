import { closeSync, copyFileSync, createReadStream, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { MediaItem } from '../shared/types'
import { classify, extensionOf, extractText, PREVIEW_MIME, readSample, type Extracted } from './attachments'
import { MAX_IMAGE_BYTES, visionImages, type VisionImage } from './vision'

/** Chat previews are served to the window under this scheme, never from file:// paths. */
export const MEDIA_SCHEME = 'rbx-media'
const MB = 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STORED = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{1,10})$/
/** A file the user attaches. Paths come from a drop or the file picker; pasted data arrives as bytes. */
export interface AttachInput { path?: string; data?: Uint8Array; name: string; frames?: Uint8Array[]; meta?: { width?: number; height?: number; duration?: number } }
export const ATTACH_LIMIT = 1024 * MB
export const PASTE_LIMIT = 64 * MB
const MAX_FRAMES = 6

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
    const name = readdirSync(this.directory).find(file => file.startsWith(`${id}.`) && STORED.test(file))
    if (!name) return undefined
    const extension = extensionOf(name)
    return { path: join(this.directory, name), mime: PREVIEW_MIME[extension] || 'application/octet-stream', preview: !!PREVIEW_MIME[extension] }
  }

  /** Copies a user's file into the app. Readable text is extracted later, on demand; downscaled stills come from the window. */
  attach(input: AttachInput): MediaItem {
    const name = (basename(String(input.name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim() || 'attachment').slice(0, 160)
    let bytes: number
    let sample: Buffer
    if (input.path) {
      if (!isAbsolute(input.path)) throw new Error('Attach a file from this computer.')
      let info
      try { info = statSync(input.path) } catch { throw new Error(`${name} could not be read. It may have been moved or deleted.`) }
      if (!info.isFile()) throw new Error(`${name} is a folder. Attach the files inside it, or a .zip of it.`)
      bytes = info.size
      if (bytes > ATTACH_LIMIT) throw new Error(`${name} is ${Math.round(bytes / MB)} MB; attachments can be up to ${ATTACH_LIMIT / MB} MB.`)
      sample = readSample(input.path)
    } else if (input.data) {
      bytes = input.data.byteLength
      if (bytes > PASTE_LIMIT) throw new Error(`Pasted data is limited to ${PASTE_LIMIT / MB} MB. Attach the file instead.`)
      sample = Buffer.from(input.data.buffer, input.data.byteOffset, Math.min(8192, bytes))
    } else throw new Error('Nothing to attach.')
    if (!bytes) throw new Error(`${name} is empty.`)
    const type = classify(name, sample)
    const id = randomUUID()
    const extension = type.extension || 'bin'
    const target = join(this.directory, `${id}.${extension}`)
    if (input.path) copyFileSync(input.path, target)
    else writeFileSync(target, input.data!)
    const frames: string[] = []
    for (const frame of (input.frames || []).slice(0, MAX_FRAMES)) {
      const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
      if (buffer.length > MAX_IMAGE_BYTES || !(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) continue
      const frameId = randomUUID()
      writeFileSync(join(this.directory, `${frameId}.jpg`), buffer)
      frames.push(frameId)
    }
    const number = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < max ? Math.round(value * 100) / 100 : undefined
    const width = number(input.meta?.width, 100_000), height = number(input.meta?.height, 100_000), duration = number(input.meta?.duration, 1e7)
    return { id, kind: type.kind, mime: type.mime, name, bytes, source: 'user', label: type.label, ...(frames.length ? { frames } : {}), ...(width && height ? { width: Math.round(width), height: Math.round(height) } : {}), ...(duration ? { duration } : {}) }
  }

  /** Deletes an attachment that was never sent, with its stills. */
  remove(item: Pick<MediaItem, 'id' | 'frames'>) {
    for (const id of [item.id, ...(item.frames || [])]) { const found = this.locate(id); if (found) rmSync(found.path, { force: true }) }
    this.texts.delete(item.id)
  }

  private texts = new Map<string, Extracted | null>()
  /** Text a model can read from the file, extracted once and kept in memory for this session of the app. */
  text(item: MediaItem): Extracted | undefined {
    if (this.texts.has(item.id)) return this.texts.get(item.id) || undefined
    const found = this.locate(item.id)
    let extracted: Extracted | undefined
    if (found) { try { extracted = extractText(found.path, { ...classify(item.name, readSample(found.path)), extension: extensionOf(found.path) }) } catch { extracted = undefined } }
    this.texts.set(item.id, extracted || null)
    if (this.texts.size > 64) this.texts.delete(this.texts.keys().next().value!)
    return extracted
  }

  /** What a model sees of an image or video: its downscaled stills, or the image itself when it is small enough. */
  vision(item: MediaItem): VisionImage[] {
    const images: VisionImage[] = []
    for (const id of item.frames || []) {
      const found = this.locate(id)
      if (found) images.push(...visionImages({ content: [{ type: 'image', mimeType: 'image/jpeg', data: readFileSync(found.path).toString('base64') }] }))
    }
    if (images.length || item.kind !== 'image' || item.bytes > MAX_IMAGE_BYTES) return images
    const found = this.locate(item.id)
    return found ? visionImages({ content: [{ type: 'image', mimeType: found.mime, data: readFileSync(found.path).toString('base64') }] }) : []
  }

  /** A PDF as base64 for providers that read documents natively. */
  pdf(item: MediaItem, limit: number): string | undefined {
    if (item.kind !== 'pdf' || item.bytes > limit) return undefined
    const found = this.locate(item.id)
    return found ? readFileSync(found.path).toString('base64') : undefined
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
    // Only pictures, video and sound are ever shown in the window. Other files are offered for saving.
    if (!found?.preview) return new Response('Not found', { status: 404 })
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