/** Images stay in the active run, never in workspace JSON or textual tool logs. */
export interface VisionImage { mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_CONTEXT_IMAGES = 4

export function visionImages(result: unknown): VisionImage[] {
  if (!result || typeof result !== 'object' || (result as any).isError) return []
  const content = (result as any).content
  if (!Array.isArray(content)) return []
  const images: VisionImage[] = []
  for (const part of content) {
    if (images.length === 2) break
    if (part?.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType) || typeof part.data !== 'string') continue
    if (!part.data.length || part.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || part.data.length % 4) continue
    const bytes = Buffer.from(part.data, 'base64')
    if (bytes.length > MAX_IMAGE_BYTES || !validImage(bytes, part.mimeType)) continue
    images.push({ mimeType: part.mimeType, data: part.data })
  }
  return images
}

function validImage(bytes: Buffer, mime: string) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
  return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
}

export function imageUrl(image: VisionImage) { return `data:${image.mimeType};base64,${image.data}` }
export function anthropicImage(image: VisionImage) { return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } } }
