import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
const root = fileURLToPath(new URL('../resources/skills/', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const names = new Set()
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8')
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!header) throw new Error(`${entry.name}/SKILL.md has no front matter.`)
  const metadata = parse(header[1]) || {}
  if (metadata.name !== entry.name) throw new Error(`${entry.name}/SKILL.md declares the name "${metadata.name}"; it must match its folder.`)
  if (!String(metadata.description || '').trim()) throw new Error(`${entry.name}/SKILL.md has no description.`)
  if (text.length < 500) throw new Error(`${entry.name}/SKILL.md looks empty.`)
  names.add(metadata.name)
}
if (names.size !== manifest.skillCount) throw new Error(`Expected ${manifest.skillCount} skills; found ${names.size}.`)
console.log(`Verified ${names.size} bundled skills: front matter, names that match their folders, and descriptions.`)
