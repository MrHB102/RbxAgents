import { describe, expect, it } from 'vitest'
import { compactTurns, contextSize } from '../../src/main/context'
import { MAX_IMAGE_BYTES, visionImages } from '../../src/main/vision'
import type { Turn } from '../../src/main/providers'

const image = { type: 'image', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }
describe('bounded visual context', () => {
  it('accepts inline tool images, rejecting malformed, mislabeled, oversized and failed outputs', () => {
    expect(visionImages({ content: [image] })).toEqual([{ mimeType: image.mimeType, data: image.data }])
    for (const content of [{ ...image, mimeType: 'image/jpeg' }, { ...image, data: 'not base64' }, { ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]) expect(visionImages({ content: [content] })).toEqual([])
    expect(visionImages({ isError: true, content: [image] })).toEqual([])
    expect(visionImages({ content: Array(10).fill(image) })).toHaveLength(2)
  })
  it('keeps recent comparison images without treating base64 as text or breaking call/result pairs', () => {
    const turns: Turn[] = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Task' }]
    for (let i = 0; i < 6; i++) turns.push({ role: 'assistant', content: '', tool_calls: [{ id: `${i}`, type: 'function', function: { name: 'look', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `${i}`, content: `Frame ${i}`, images: [{ mimeType: 'image/png', data: 'A'.repeat(500_000) }] })
    const compact = compactTurns(turns)
    expect(compact.flatMap(t => t.images || [])).toHaveLength(4)
    expect(compact.filter(t => t.role === 'tool')).toHaveLength(6)
    expect(contextSize(compact)).toBeLessThan(5000)
    expect(compact.at(-1)?.images?.[0].data).toHaveLength(500_000)
    expect(turns.filter(t => t.images?.length)).toHaveLength(6)
  })
})
