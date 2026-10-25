import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const executablePath = resolve(process.argv[2] || 'release/win-unpacked/rbx-agents.exe')
const profile = mkdtempSync(join(tmpdir(), 'rbx-package-'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE'))
const desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: environment })
try {
  const actualProfile = await desktop.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(resolve(actualProfile), resolve(profile), 'Packaged smoke test must use an isolated profile.')
  const page = await desktop.firstWindow()
  await page.getByRole('heading', { name: 'Your team, in sync.' }).waitFor({ timeout: 20_000 })
  const snapshot = await page.evaluate(() => window.rbx.invoke('state'))
  assert.equal(snapshot.appVersion, JSON.parse(readFileSync('package.json', 'utf8')).version)
  assert.equal(snapshot.skills.filter(skill => skill.builtin).length, 29)
  assert.equal(snapshot.agents.length, 5)
  const agent = await page.evaluate(config => window.rbx.invoke('agent:save', config), { ...snapshot.agents[0], permission: 'unrestricted' })
  assert.equal(agent.permission, 'unrestricted')
  assert.equal('tokenBudget' in agent, false)
  const bundled = snapshot.servers.find(server => server.id === 'roblox')
  const pluginDirectory = join(profile, 'temporary-studio-plugins')
  await page.evaluate(config => window.rbx.invoke('mcp:save', config), {
    id: bundled.id, name: bundled.name, transport: bundled.transport,
    command: bundled.command, args: bundled.args, url: bundled.url, env: bundled.env, pluginDirectory
  })
  await page.evaluate(() => window.rbx.invoke('mcp:install', 'roblox'))
  const plugins = readdirSync(pluginDirectory).filter(name => name.endsWith('.rbxmx'))
  assert.equal(plugins.length, 1)
  assert.ok(statSync(join(pluginDirectory, plugins[0])).size > 1_000_000)
  console.log('Packaged application verified: isolated profile, renderer, 29 skills, Unrestricted access, no per-message limits, and bundled plugin installer.')
} finally { await desktop.close() }
