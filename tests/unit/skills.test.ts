import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { scanSkills, readSkill, isWithin } from '../../src/main/skills'
import { BUNDLED_SKILL_NAMES, initialState } from '../../src/shared/defaults'

const root = join(process.cwd(), 'resources', 'skills')
describe('bundled skill library', () => {
  it('ships every RBX Agents skill with matching front matter and a category', () => {
    const skills = scanSkills(root, true, 'RBX Agents')
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    expect(skills).toHaveLength(manifest.skillCount)
    expect(new Set(skills.map(s => s.id)).size).toBe(29)
    expect(skills.map(s => s.id).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort())
    for (const skill of skills) { expect(readSkill(skill)).toContain('---'); expect(skill.description.length).toBeGreaterThan(40); expect(skill.id).not.toMatch(/^roblox-/) }
    expect(skills.filter(s => s.category === 'core')).toHaveLength(10)
    expect(skills.filter(s => s.category === 'gameplay')).toHaveLength(10)
    expect(skills.filter(s => s.category === 'design')).toHaveLength(5)
    expect(skills.filter(s => s.category === 'tools')).toHaveLength(4)
    expect(skills.some(s => s.references)).toBe(false)
  })
  it('every skill the default agents use is bundled', () => {
    for (const agent of initialState('host').agents) for (const id of agent.skillIds) expect(BUNDLED_SKILL_NAMES).toContain(id)
  })
  it('rejects paths outside a skill, including sibling prefix attacks', () => {
    const skill = scanSkills(root, true, '')[0]
    expect(() => readSkill(skill, '../../../package.json')).toThrow('inside')
    expect(isWithin('D:/skills/one', 'D:/skills/one-other/secret')).toBe(false)
    expect(isWithin('D:/skills/one', 'D:/skills/one/references/full.md')).toBe(true)
  })
  it('groups a nested collection by its folder and treats an unknown flat skill as general', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rbx-skills-'))
    try {
      mkdirSync(join(directory, 'extras', 'tidy'), { recursive: true }); mkdirSync(join(directory, 'loose'))
      writeFileSync(join(directory, 'extras', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Nested\n---\nx')
      writeFileSync(join(directory, 'loose', 'SKILL.md'), '---\nname: loose\ndescription: Flat\n---\nx')
      const found = scanSkills(directory, true, 'test')
      expect(found.find(s => s.name === 'tidy')?.category).toBe('extras')
      expect(found.find(s => s.name === 'loose')?.category).toBe('general')
    } finally { rmSync(directory, { recursive: true, force: true }) }
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
