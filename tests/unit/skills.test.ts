import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { scanSkills, readSkill, isWithin } from '../../src/main/skills'

const root = join(process.cwd(), 'resources', 'roblox-brain')
describe('bundled skill library', () => {
  it('ships every upstream skill and its complete reference file', () => {
    const skills = scanSkills(join(root, 'skills'), true, 'roblox-brain')
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    expect(skills).toHaveLength(manifest.skillCount)
    expect(new Set(skills.map(s => s.id)).size).toBe(29)
    for (const skill of skills) { expect(readSkill(skill)).toContain('---'); expect(readSkill(skill, 'references/full.md').length).toBeGreaterThan(100) }
    expect(skills.filter(s => s.category === 'core')).toHaveLength(10)
    expect(skills.filter(s => s.category === 'gameplay')).toHaveLength(10)
    expect(skills.filter(s => s.category === 'design')).toHaveLength(5)
    expect(skills.filter(s => s.category === 'tools')).toHaveLength(4)
  })
  it('rejects paths outside a skill, including sibling prefix attacks', () => {
    const skill = scanSkills(join(root, 'skills'), true, '')[0]
    expect(() => readSkill(skill, '../../../../LICENSE')).toThrow('inside')
    expect(isWithin('D:/skills/one', 'D:/skills/one-other/secret')).toBe(false)
    expect(isWithin('D:/skills/one', 'D:/skills/one/references/full.md')).toBe(true)
  })
  it('ignores symlinks and hidden metadata when scanning custom skills', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rbx-skills-'))
    try {
      mkdirSync(join(directory, '.git'), { recursive: true })
      writeFileSync(join(directory, '.git', 'SKILL.md'), 'hidden')
      mkdirSync(join(directory, 'my-skill'))
      writeFileSync(join(directory, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: A useful custom skill\n---\nInstructions')
      expect(scanSkills(directory, false, 'Local')).toHaveLength(1)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
