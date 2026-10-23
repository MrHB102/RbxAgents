import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// Electron 45 exposes a separate installer instead of an npm postinstall hook.
// Skip this step for production-only dependency installs.
const installer = fileURLToPath(new URL('../node_modules/electron/install.js', import.meta.url))
if (existsSync(installer)) {
  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
