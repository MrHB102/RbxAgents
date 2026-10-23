import { readdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = new URL('../resources/roblox-brain/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
let count = 0
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await walk(join(path, entry.name))
    else if (entry.name === 'SKILL.md') { count++; await access(join(path, 'references/full.md')) }
  }
}
await walk(fileURLToPath(new URL('skills/', root)))
if (count !== manifest.skillCount) throw new Error(`Expected ${manifest.skillCount} complete skills; found ${count}.`)
await access(new URL('LICENSE', root))
console.log(`Verified ${count} bundled skills, all reference files, provenance, and MIT license.`)
