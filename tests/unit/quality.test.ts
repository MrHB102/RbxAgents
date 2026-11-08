import { describe, expect, it } from 'vitest'
import { ensureBrief, qualityReview, updateBrief, visualRequest } from '../../src/main/quality'
import { foldAll, memoryBlock } from '../../src/main/context'
import type { Session } from '../../src/shared/types'

const session = (): Session => ({ id: 's', agentId: 'builder', title: 'Work', messages: [{ id: 'u', role: 'user', content: 'Crie um cenário com uma ponte azul; preserve o castelo.', createdAt: '' }], createdAt: '', updatedAt: '', tokens: 0, status: 'idle' })
const review = { verdict: 'pass', criteria: [{ criterion: 'Blue bridge', status: 'pass', evidence: 'Fresh viewport image after the edit.' }], issues: [] }
describe('acceptance contracts', () => {
  it('preserves the original request, references and criteria through compaction and worker handoff', () => {
    const s = session()
    ensureBrief(s)
    updateBrief(s, { goal: 'Bridge', constraints: ['Keep the castle'], references: ['Reference A'], acceptance: ['Blue bridge'], visual: true })
    foldAll(s)
    const workerMemory = memoryBlock(s, { pinsOnly: true })
    expect(workerMemory).toContain('preserve o castelo')
    expect(workerMemory).toContain('Reference A')
    expect(workerMemory).toContain('Blue bridge')
    expect(workerMemory).not.toContain('Earlier in this conversation')
  })
  it('does not accept stale, absent, incomplete or failed evidence as a quality pass', () => {
    expect(() => qualityReview(review, { changed: true, observed: false, visual: true, imageObserved: false }, ['Blue bridge'])).toThrow('latest change')
    expect(() => qualityReview(review, { changed: true, observed: true, visual: true, imageObserved: false }, ['Blue bridge'])).toThrow('actual image')
    expect(() => qualityReview(review, { changed: true, observed: true, visual: true, imageObserved: true }, ['Blue bridge', 'Keep castle'])).toThrow('every acceptance')
    expect(() => qualityReview({ ...review, issues: ['Clipping'] }, { changed: false, observed: true, visual: true, imageObserved: true }, [])).toThrow('unresolved')
    expect(qualityReview({ ...review, verdict: 'blocked', issues: ['No screenshot tool'] }, { changed: true, observed: false, visual: true, imageObserved: false }, ['Blue bridge']).verdict).toBe('blocked')
  })
  it('routes clear visual work in Portuguese and English without making factual answers require a review', () => {
    expect(visualRequest('Crie um cenário de floresta')).toBe(true)
    expect(visualRequest('Make a shop UI')).toBe(true)
    expect(visualRequest('What does this script do?')).toBe(false)
  })
})
