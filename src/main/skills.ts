import { readdirSync, readFileSync, realpathSync, statSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import type { Skill } from '../shared/types'

export function isWithin(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !/^[A-Za-z]:/.test(rel) && !rel.startsWith(sep))
}
export function scanSkills(root: string, builtin: boolean, source: string): Skill[] {
  if (!existsSync(root)) return []
  const found: Skill[] = []
  const walk = (directory: string, depth: number) => {
    if (depth > 12) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name === 'SKILL.md') {
        const text = readFileSync(path, 'utf8')
        const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        let metadata: Record<string, unknown> = {}
        try { metadata = header ? parse(header[1]) || {} : {} } catch { /* A custom skill may omit YAML. */ }
        const name = String(metadata.name || relative(root, directory).split(sep).at(-1))
        found.push({ id: builtin ? name : `${name}-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`, name, description: String(metadata.description || 'Custom agent skill'), category: builtin ? relative(root, path).split(sep)[0] : 'custom', source, path, builtin })
      }
    }
  }
  walk(root, 0)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
export function readSkill(skill: Skill, file = 'SKILL.md') {
  const root = resolve(skill.path, '..')
  const target = resolve(root, file)
  if (!isWithin(root, target) || !existsSync(target) || !isWithin(realpathSync(root), realpathSync(target))) throw new Error('The skill file must be inside the selected skill folder.')
  if (!statSync(target).isFile() || statSync(target).size > 512_000) throw new Error('Skill file is too large or is not a regular file.')
  return readFileSync(target, 'utf8')
}
export function importSkillFolder(source: string, destination: string) {
  if (!scanSkills(source, false, 'Local import').length) throw new Error('No SKILL.md files were found in this folder.')
  if (isWithin(source, destination)) throw new Error('Choose a folder outside the application data folder.')
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true, filter: (path) => {
    const rel = relative(source, path)
    if (rel.split(sep).some(part => part.startsWith('.') || part === 'node_modules')) return false
    // Do not follow symlinks outside the imported folder.
    return isWithin(realpathSync(source), realpathSync(path))
  }, dereference: true })
  return scanSkills(destination, false, 'Local import')
}
