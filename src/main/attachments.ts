import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { MediaKind } from '../shared/types'

/**
 * Files a user attaches to a chat message. Each type is classified by extension and confirmed by content, so a
 * renamed file is never served or sent as something it is not. Readable text is extracted locally, with no model call.
 */
export interface AttachmentType {
  kind: MediaKind; mime: string; label: string
  /** The file is UTF-8 text the model can read as is. */
  text?: boolean
  /** Content check. A file that fails it is still kept, as a plain file. */
  magic?: (head: Buffer) => boolean
}

const latin = (head: Buffer, from: number, to: number) => head.subarray(from, to).toString('latin1')
const ftyp = (head: Buffer) => latin(head, 4, 8) === 'ftyp'
const zip = (head: Buffer) => head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)
const riff = (format: string) => (head: Buffer) => latin(head, 0, 4) === 'RIFF' && latin(head, 8, 12) === format
const png = (head: Buffer) => head[0] === 0x89 && latin(head, 1, 4) === 'PNG'
const jpeg = (head: Buffer) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
const gif = (head: Buffer) => latin(head, 0, 4) === 'GIF8'
const webp = riff('WEBP')
const ebml = (head: Buffer) => head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
const ogg = (head: Buffer) => latin(head, 0, 4) === 'OggS'
const mp3 = (head: Buffer) => latin(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)

const t = (kind: MediaKind, mime: string, label: string, extra: Partial<AttachmentType> = {}): AttachmentType => ({ kind, mime, label, ...extra })
const code = (label: string) => t('text', 'text/plain', label, { text: true })
const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text', md: 'Markdown', markdown: 'Markdown', rst: 'reStructuredText', log: 'log', csv: 'CSV table', tsv: 'TSV table', json: 'JSON', jsonc: 'JSON', json5: 'JSON',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'config', conf: 'config', xml: 'XML', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', svg: 'SVG source',
  lua: 'Lua', luau: 'Luau', py: 'Python', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript', gd: 'GDScript',
  cs: 'C#', c: 'C', h: 'C header', cpp: 'C++', hpp: 'C++ header', cc: 'C++', java: 'Java', kt: 'Kotlin', rs: 'Rust', go: 'Go', rb: 'Ruby', php: 'PHP', swift: 'Swift',
  sh: 'shell script', bash: 'shell script', ps1: 'PowerShell', psm1: 'PowerShell', bat: 'batch script', cmd: 'batch script', sql: 'SQL', graphql: 'GraphQL', glsl: 'GLSL',
  hlsl: 'HLSL', shader: 'shader', vert: 'shader', frag: 'shader', srt: 'subtitles', vtt: 'subtitles', tex: 'LaTeX', diff: 'diff', patch: 'diff', properties: 'properties'
}
const TYPES: Record<string, AttachmentType> = {
  png: t('image', 'image/png', 'PNG image', { magic: png }), jpg: t('image', 'image/jpeg', 'JPEG image', { magic: jpeg }), jpeg: t('image', 'image/jpeg', 'JPEG image', { magic: jpeg }),
  webp: t('image', 'image/webp', 'WebP image', { magic: webp }), gif: t('image', 'image/gif', 'GIF image', { magic: gif }),
  bmp: t('image', 'image/bmp', 'BMP image', { magic: h => latin(h, 0, 2) === 'BM' }), avif: t('image', 'image/avif', 'AVIF image', { magic: ftyp }),
  ico: t('image', 'image/x-icon', 'icon', { magic: h => h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0 }),
  tif: t('file', 'image/tiff', 'TIFF image'), tiff: t('file', 'image/tiff', 'TIFF image'), heic: t('file', 'image/heic', 'HEIC image'), psd: t('file', 'image/vnd.adobe.photoshop', 'Photoshop document'),
  tga: t('file', 'image/x-tga', 'TGA texture'), dds: t('file', 'image/vnd-ms.dds', 'DDS texture'), exr: t('file', 'image/x-exr', 'EXR image'), hdr: t('file', 'image/vnd.radiance', 'HDR image'),
  mp4: t('video', 'video/mp4', 'MP4 video', { magic: ftyp }), m4v: t('video', 'video/mp4', 'MP4 video', { magic: ftyp }), mov: t('video', 'video/mp4', 'QuickTime video', { magic: ftyp }),
  webm: t('video', 'video/webm', 'WebM video', { magic: ebml }), mkv: t('video', 'video/webm', 'Matroska video', { magic: ebml }), ogv: t('video', 'video/ogg', 'Ogg video', { magic: ogg }),
  avi: t('file', 'video/x-msvideo', 'AVI video'), wmv: t('file', 'video/x-ms-wmv', 'WMV video'),
  mp3: t('audio', 'audio/mpeg', 'MP3 audio', { magic: mp3 }), wav: t('audio', 'audio/wav', 'WAV audio', { magic: riff('WAVE') }), ogg: t('audio', 'audio/ogg', 'Ogg audio', { magic: ogg }),
  oga: t('audio', 'audio/ogg', 'Ogg audio', { magic: ogg }), opus: t('audio', 'audio/ogg', 'Opus audio', { magic: ogg }), flac: t('audio', 'audio/flac', 'FLAC audio', { magic: h => latin(h, 0, 4) === 'fLaC' }),
  m4a: t('audio', 'audio/mp4', 'M4A audio', { magic: ftyp }), aac: t('audio', 'audio/aac', 'AAC audio', { magic: h => h[0] === 0xff && (h[1] & 0xf0) === 0xf0 }), weba: t('audio', 'audio/webm', 'WebM audio', { magic: ebml }),
  pdf: t('pdf', 'application/pdf', 'PDF document', { magic: h => latin(h, 0, 5) === '%PDF-' }),
  docx: t('document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document', { magic: zip }),
  xlsx: t('document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel spreadsheet', { magic: zip }),
  pptx: t('document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint presentation', { magic: zip }),
  odt: t('document', 'application/vnd.oasis.opendocument.text', 'OpenDocument text', { magic: zip }), ods: t('document', 'application/vnd.oasis.opendocument.spreadsheet', 'OpenDocument spreadsheet', { magic: zip }),
  odp: t('document', 'application/vnd.oasis.opendocument.presentation', 'OpenDocument presentation', { magic: zip }), rtf: t('document', 'application/rtf', 'RTF document', { text: true }),
  doc: t('file', 'application/msword', 'legacy Word document'), xls: t('file', 'application/vnd.ms-excel', 'legacy Excel spreadsheet'), ppt: t('file', 'application/vnd.ms-powerpoint', 'legacy PowerPoint'),
  zip: t('archive', 'application/zip', 'ZIP archive', { magic: zip }), rar: t('archive', 'application/vnd.rar', 'RAR archive'), '7z': t('archive', 'application/x-7z-compressed', '7-Zip archive'),
  tar: t('archive', 'application/x-tar', 'TAR archive'), gz: t('archive', 'application/gzip', 'gzip archive'), tgz: t('archive', 'application/gzip', 'gzip archive'),
  rbxm: t('model', 'application/octet-stream', 'Roblox model (binary)'), rbxl: t('model', 'application/octet-stream', 'Roblox place (binary)'),
  rbxmx: t('model', 'application/xml', 'Roblox model (XML)', { text: true }), rbxlx: t('model', 'application/xml', 'Roblox place (XML)', { text: true }),
  fbx: t('model', 'application/octet-stream', 'FBX 3D model'), obj: t('model', 'text/plain', 'OBJ 3D model', { text: true }), mtl: t('model', 'text/plain', 'OBJ material', { text: true }),
  glb: t('model', 'model/gltf-binary', 'glTF binary model'), gltf: t('model', 'model/gltf+json', 'glTF model', { text: true }), stl: t('model', 'model/stl', 'STL 3D model'),
  dae: t('model', 'model/vnd.collada+xml', 'Collada model', { text: true }), blend: t('model', 'application/x-blender', 'Blender file'), ply: t('model', 'application/octet-stream', 'PLY model'),
  usd: t('model', 'application/octet-stream', 'USD scene'), usdz: t('model', 'model/vnd.usdz+zip', 'USDZ scene'), '3ds': t('model', 'application/octet-stream', '3DS model')
}
for (const [extension, label] of Object.entries(TEXT_EXTENSIONS)) TYPES[extension] ??= code(label)

/** Types the window may display from the media folder. Anything else is only offered for saving. */
export const PREVIEW_MIME: Record<string, string> = Object.fromEntries(Object.entries(TYPES).filter(([, type]) => ['image', 'video', 'audio'].includes(type.kind)).map(([extension, type]) => [extension, type.mime]))

export function extensionOf(name: string) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim())
  return match ? match[1].toLowerCase() : ''
}

function looksLikeText(sample: Buffer) {
  if (!sample.length) return false
  if (sample[0] === 0xff && sample[1] === 0xfe) return true
  if (sample.includes(0)) return false
  const decoded = sample.toString('utf8')
  const bad = (decoded.match(/�/g) || []).length
  return bad <= Math.max(1, decoded.length / 200)
}

/** Classifies by extension, then confirms with the content. A failed check downgrades the file to a plain attachment. */
export function classify(name: string, sample: Buffer): AttachmentType & { extension: string } {
  const extension = extensionOf(name)
  const known = TYPES[extension]
  if (known) {
    if (known.magic && !known.magic(sample)) return { kind: 'file', mime: 'application/octet-stream', label: `${known.label} (content did not match its extension)`, extension }
    if (known.text && !looksLikeText(sample)) return { ...known, text: false, extension }
    return { ...known, extension }
  }
  // Unknown extension: decide by content.
  for (const type of [TYPES.png, TYPES.jpg, TYPES.gif, TYPES.webp, TYPES.pdf, TYPES.mp4, TYPES.webm, TYPES.mp3]) if (type.magic!(sample)) return { ...type, extension }
  if (looksLikeText(sample)) return { ...code('text'), extension }
  return { kind: 'file', mime: 'application/octet-stream', label: extension ? `.${extension} file` : 'file', extension }
}

export function readSample(path: string, bytes = 8192) {
  const fd = openSync(path, 'r')
  try { const buffer = Buffer.alloc(bytes); const read = readSync(fd, buffer, 0, bytes, 0); return buffer.subarray(0, read) } finally { closeSync(fd) }
}

// ---- Text extraction ---------------------------------------------------------------------------------------------

export const MAX_EXTRACTED = 400_000
const MAX_PARSE_BYTES = 80 * 1024 * 1024

export interface Extracted { text: string; pages?: number; note?: string }

/** Readable text of an attachment, or undefined when it has none (images, audio, binary models). */
export function extractText(path: string, type: Pick<AttachmentType, 'kind' | 'text'> & { extension: string }): Extracted | undefined {
  const size = statSync(path).size
  if (type.text) {
    const buffer = readSlice(path, Math.min(size, 4 * MAX_EXTRACTED))
    const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString('utf16le') : buffer.toString('utf8').replace(/^﻿/, '')
    return bound(type.extension === 'rtf' ? rtfText(text) : text)
  }
  if (size > MAX_PARSE_BYTES) return undefined
  try {
    if (type.kind === 'pdf') return pdfText(readFileSync(path))
    if (type.kind === 'document') return officeText(readFileSync(path), type.extension)
    if (type.kind === 'archive' && type.extension === 'zip') { const entries = zipEntries(readFileSync(path)); return bound(`${entries.length} entries:\n${entries.map(e => `${e.name}  (${e.size} bytes)`).join('\n')}`) }
    if (type.kind === 'model' && type.extension === 'usdz') { const entries = zipEntries(readFileSync(path)); return bound(`USDZ package with ${entries.length} entries:\n${entries.map(e => e.name).join('\n')}`) }
  } catch { return undefined }
  return undefined
}

function readSlice(path: string, bytes: number) {
  const fd = openSync(path, 'r')
  try { const buffer = Buffer.alloc(bytes); const read = readSync(fd, buffer, 0, bytes, 0); return buffer.subarray(0, read) } finally { closeSync(fd) }
}
function bound(text: string, extra: Omit<Extracted, 'text'> = {}): Extracted {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n')
  return clean.length > MAX_EXTRACTED ? { ...extra, text: clean.slice(0, MAX_EXTRACTED), note: `Only the first ${MAX_EXTRACTED.toLocaleString('en-US')} characters were extracted.` } : { ...extra, text: clean }
}

// Minimal ZIP reader (stored and deflated entries, no ZIP64), enough for Office files and archive listings.
interface ZipEntry { name: string; size: number; method: number; compressed: number; offset: number }
export function zipEntries(buffer: Buffer): ZipEntry[] {
  const floor = Math.max(0, buffer.length - 65_557)
  let end = -1
  for (let i = buffer.length - 22; i >= floor; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('Not a ZIP file.')
  const count = buffer.readUInt16LE(end + 10)
  let position = buffer.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count && position + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) break
    const nameLength = buffer.readUInt16LE(position + 28), extraLength = buffer.readUInt16LE(position + 30), commentLength = buffer.readUInt16LE(position + 32)
    entries.push({ name: buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8'), method: buffer.readUInt16LE(position + 10), compressed: buffer.readUInt32LE(position + 20), size: buffer.readUInt32LE(position + 24), offset: buffer.readUInt32LE(position + 42) })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
function zipRead(buffer: Buffer, entry: ZipEntry) {
  const local = entry.offset
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Damaged ZIP entry.')
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
  const data = buffer.subarray(start, start + entry.compressed)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 })
  throw new Error('Unsupported ZIP compression.')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ENTITIES[code.toLowerCase()] ?? whole)
}
const stripTags = (xml: string) => decodeXml(xml.replace(/<[^>]+>/g, ''))
const naturally = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

function officeText(buffer: Buffer, extension: string): Extracted {
  const entries = zipEntries(buffer)
  const file = (name: string) => { const entry = entries.find(e => e.name === name); return entry ? zipRead(buffer, entry).toString('utf8') : '' }
  if (extension === 'docx') {
    const xml = file('word/document.xml')
    return bound(stripTags(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')))
  }
  if (extension === 'pptx') {
    const slides = entries.map(e => e.name).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(naturally)
    return bound(slides.map((name, i) => `## Slide ${i + 1}\n${stripTags(file(name).replace(/<\/a:p>/g, '\n')).trim()}`).join('\n\n'), { pages: slides.length })
  }
  if (extension === 'xlsx') {
    const shared = [...file('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => stripTags(m[1]))
    const names = [...file('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(m => decodeXml(m[1]))
    const sheets = entries.map(e => e.name).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(naturally)
    const parts = sheets.map((name, index) => {
      const rows = [...file(name).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 5000).map(row => [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(cell => {
        const kind = /\bt="([^"]+)"/.exec(cell[1])?.[1]
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2] || '')?.[1]
        if (kind === 's' && value !== undefined) return shared[Number(value)] ?? ''
        if (kind === 'inlineStr') return stripTags(cell[2] || '')
        return value !== undefined ? decodeXml(value) : ''
      }).join('\t'))
      return `## Sheet: ${names[index] || `Sheet ${index + 1}`}\n${rows.join('\n')}`
    })
    return bound(parts.join('\n\n'), { pages: sheets.length })
  }
  // OpenDocument
  return bound(stripTags(file('content.xml').replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n')))
}

function rtfText(rtf: string) {
  return rtf.replace(/\\par[d]?/g, '\n').replace(/\\'([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
}

// ---- PDF ---------------------------------------------------------------------------------------------------------

/** Best-effort text from a PDF's content streams: enough for most generated documents, not for scans. */
export function pdfText(buffer: Buffer): Extracted {
  const source = buffer.toString('latin1')
  const pages = (source.match(/\/Type\s*\/Page(?![a-z])/g) || []).length || undefined
  const pieces: string[] = []
  const streams = /stream\r?\n/g
  let match: RegExpExecArray | null
  let total = 0
  while ((match = streams.exec(source)) && total < MAX_EXTRACTED) {
    const start = match.index + match[0].length
    const end = source.indexOf('endstream', start)
    if (end < 0) break
    const dictionary = source.slice(Math.max(0, match.index - 400), match.index)
    const header = dictionary.slice(dictionary.lastIndexOf('<<'))
    streams.lastIndex = end
    if (/\/(Subtype\s*\/Image|Type\s*\/XObject\s*\/Subtype\s*\/Image|Length1|FontFile)/.test(header)) continue
    let data = buffer.subarray(start, end)
    if (/\/FlateDecode/.test(header)) {
      try { data = inflateSync(data, { maxOutputLength: 32 * 1024 * 1024 }) } catch { try { data = inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 }) } catch { continue } }
    } else if (/\/Filter/.test(header)) continue
    const text = contentText(data.toString('latin1'))
    if (text.trim()) { pieces.push(text); total += text.length }
  }
  const text = pieces.join('\n').replace(/[ \t]{2,}/g, ' ')
  const printable = text.replace(/[^\x20-\x7e -ɏ\n\t]/g, '').length
  if (!text.trim() || printable / text.length < 0.85) return { text: '', pages, note: 'No text could be extracted. The PDF may be scanned or use embedded font encodings.' }
  return bound(text, { pages })
}

function pdfString(raw: string) {
  return raw.replace(/\\(\d{1,3}|.)/gs, (_m, code: string) => /^\d/.test(code) ? String.fromCharCode(parseInt(code, 8)) : ({ n: '\n', r: '', t: '\t', b: '', f: '' } as Record<string, string>)[code] ?? code)
}
function hexString(raw: string) {
  const hex = raw.replace(/\s+/g, '')
  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')
  // Two-byte strings are usually UTF-16BE when every high byte is zero.
  if (bytes.length >= 2 && bytes.length % 2 === 0 && bytes.every((b, i) => i % 2 || b === 0)) return bytes.swap16().toString('utf16le')
  return bytes.toString('latin1')
}
function contentText(content: string) {
  if (!/\bBT\b/.test(content)) return ''
  let out = ''
  const token = /\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|\[(?:\\.|[^\]\\])*\]|-?\d*\.?\d+|\/[^\s/\[\]()<>]+|[A-Za-z'"*]+/gs
  const operands: string[] = []
  let m: RegExpExecArray | null
  while ((m = token.exec(content))) {
    const value = m[0]
    if (value[0] === '(' || value[0] === '[' || (value[0] === '<' && value[1] !== '<') || /^-?\d*\.?\d+$/.test(value) || value[0] === '/') { operands.push(value); if (operands.length > 12) operands.shift(); continue }
    const op = value
    if (op === 'Tj' || op === "'" || op === '"') { const s = operands.at(-1); if (s) out += (op === 'Tj' ? '' : '\n') + literal(s) }
    else if (op === 'TJ') {
      const array = operands.at(-1) || ''
      for (const part of array.slice(1, -1).matchAll(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|-?\d*\.?\d+/gs)) {
        if (part[0][0] === '(' || part[0][0] === '<') out += literal(part[0])
        else if (Number(part[0]) < -180) out += ' '
      }
    } else if (op === 'T*' || op === 'ET') out += '\n'
    else if (op === 'Td' || op === 'TD') { const y = Number(operands.at(-1)); out += y ? '\n' : ' ' }
    else if (op === 'Tm') out += '\n'
    operands.length = 0
  }
  return out
}
function literal(token: string) { return token[0] === '(' ? pdfString(token.slice(1, -1)) : hexString(token.slice(1, -1)) }
