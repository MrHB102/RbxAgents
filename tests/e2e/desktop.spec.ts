import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let desktop: ElectronApplication
let api: Server
let data: string
let apiUrl: string
let requests: Record<string, any>[] = []

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'rbx-desktop-'))
  api = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'test-roblox-model' }] })); return }
    if (req.url === '/v1/chat/completions') {
      let body = ''; for await (const chunk of req) body += chunk
      const payload = JSON.parse(body); requests.push(payload)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const event = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`)
      if (!payload.messages.some((message: any) => message.role === 'tool')) {
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_skill', function: { name: 'load_skill', arguments: '{"skill_id":"roblox-architecture"}' } }] } }] })
        event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 25 } })
      } else {
        event({ choices: [{ delta: { content: 'The architecture skill is loaded. Your Roblox project is ready to plan.' } }] })
        event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 45 } })
      }
      res.end('data: [DONE]\n\n'); return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const address = api.address() as { port: number }
  apiUrl = `http://127.0.0.1:${address.port}/v1`
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), RBX_AGENTS_TEST_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  desktop = await electron.launch({ args: ['.'], cwd: process.cwd(), env })
})
test.afterAll(async () => { await desktop?.close(); await new Promise<void>(resolve => api?.close(() => resolve())) })

test('desktop onboarding, complete bundled library, real provider loop, persistence, and plugin installation', async () => {
  const page = await desktop.firstWindow()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.getByRole('heading', { name: 'Your team, in sync.' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.agent-card')).toHaveCount(5)
  await expect(page.locator('.agent-card').filter({ has: page.getByRole('heading', { name: 'Master', exact: true }) })).toContainText('Orchestrator')
  await expect(page.getByText('29 skills installed')).toBeVisible()
  await page.screenshot({ path: 'test-results/agents-desktop.png' })
  // Every upstream skill and reference can be read through the hardened preload bridge.
  await page.getByRole('button', { name: 'Skill library', exact: true }).click()
  await expect(page.locator('.skill-card')).toHaveCount(29)
  await page.getByRole('button', { name: 'Core', exact: true }).click()
  await expect(page.locator('.skill-card')).toHaveCount(10)
  await page.locator('.skill-card').filter({ has: page.getByRole('heading', { name: 'architecture', exact: true }) }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Full reference', exact: true }).click()
  await expect(page.locator('.skill-document')).toContainText('Architecture')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  // Save and discover an OpenAI-compatible provider through the visible form.
  await page.getByRole('button', { name: 'Providers', exact: true }).click()
  await page.locator('.provider-option').filter({ hasText: 'Claude Code' }).click()
  await expect(page.getByRole('dialog')).toContainText('never reads or stores them')
  await expect(page.getByRole('dialog')).toContainText('limit how third-party apps may use')
  await page.screenshot({ path: 'test-results/claude-code-provider.png' })
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  await page.getByLabel('Connection name').fill('Local integration test')
  await page.getByLabel('API endpoint').fill(apiUrl)
  await page.getByLabel('API key', { exact: true }).fill('rbx-e2e-private-key')
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect(page.locator('.provider-card .badge')).toHaveText('connected')
  // Configure a real agent, keep this test independent of a running Roblox Studio.
  await page.getByRole('navigation').getByRole('button', { name: /^Agents/ }).click()
  await page.getByRole('button', { name: 'Edit Architect', exact: true }).click()
  await page.getByLabel('Provider', { exact: true }).selectOption({ label: 'Local integration test' })
  await page.getByLabel('Model', { exact: true }).fill('test-roblox-model')
  await page.getByLabel('Permissions', { exact: true }).selectOption('unrestricted')
  await expect(page.getByLabel('Token budget per message')).toHaveValue('30000')
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await page.getByRole('checkbox').uncheck()
  await page.getByRole('button', { name: 'Save agent', exact: true }).click()
  await page.locator('.agent-card').filter({ has: page.getByRole('heading', { name: 'Architect', exact: true }) }).getByRole('button', { name: 'Start chat' }).click()
  await page.getByRole('textbox', { name: 'Message your agent' }).fill('Load your architecture skill and help me plan.')
  expect(requests).toHaveLength(0)
  await expect(page.locator('.composer-hint')).toContainText('Unrestricted access')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.chat-message.assistant')).toContainText('The architecture skill is loaded.', { timeout: 20_000 })
  await expect(page.locator('.tool-message')).toContainText('load_skill')
  expect(requests).toHaveLength(2)
  expect(requests[0].max_tokens).toBeLessThanOrEqual(4096)
  expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['load_skill', 'web_search', 'web_fetch'])
  expect(requests[0].messages[0].content).toContain('server')
  expect(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('Architecture'))).toBe(true)
  // Slash commands: suggestions appear, and commands never reach the model.
  const composer = page.getByRole('textbox', { name: 'Message your agent' })
  await composer.fill('/ef')
  await expect(page.getByRole('listbox', { name: 'Commands' })).toContainText('/effort')
  await composer.fill('/effort high')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.system-message.command')).toContainText('Effort: high')
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('high')
  expect(requests).toHaveLength(2)
  await page.screenshot({ path: 'test-results/conversation-desktop.png' })
  // Prompt editing and activity reflect actual run state.
  await page.getByRole('button', { name: 'System prompts', exact: true }).click()
  await page.getByRole('textbox', { name: 'Workspace system prompt' }).fill('Use typed Luau. Verify changes before reporting success.')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Workspace prompt saved.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Settings/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Web access' })).toBeVisible()
  await expect(page.getByLabel('Brave Search API key')).toBeVisible()
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await expect(page.locator('.activity-list')).toContainText('Architect finished')
  // Install the actual bundled plugin into a temporary folder, never the user's Studio folder.
  const plugins = join(data, 'test-studio-plugins')
  await page.getByRole('button', { name: 'Roblox MCP', exact: true }).click()
  await page.getByRole('button', { name: 'Configure Roblox Studio', exact: true }).click()
  await page.getByLabel('Studio Plugins folder').fill(plugins)
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await page.getByRole('button', { name: 'Install Studio plugin', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reinstall Studio plugin', exact: true })).toBeVisible({ timeout: 30_000 })
  const files = readdirSync(plugins).filter(name => name.endsWith('.rbxmx'))
  expect(files).toHaveLength(1)
  expect(statSync(join(plugins, files[0])).size).toBeGreaterThan(1_000_000)
  // No secret reaches the saved workspace or preload snapshot.
  expect(readFileSync(join(data, 'workspace.json'), 'utf8')).not.toContain('rbx-e2e-private-key')
  const snapshot = await page.evaluate(() => window.rbx.invoke('state'))
  expect(JSON.stringify(snapshot)).not.toContain('rbx-e2e-private-key')
  await page.getByRole('navigation').getByRole('button', { name: /^Agents/ }).click()
  await page.setViewportSize({ width: 1060, height: 790 })
  await page.screenshot({ path: 'test-results/agents-compact.png' })
  expect(errors).toEqual([])
  // Read persisted state after a restart with the same test profile.
  await desktop.close()
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), RBX_AGENTS_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
  desktop = await electron.launch({ args: ['.'], cwd: process.cwd(), env })
  const restored = await desktop.firstWindow()
  await expect(restored.locator('.agent-card').filter({ has: restored.getByRole('heading', { name: 'Architect', exact: true }) })).toContainText('test-roblox-model')
  await restored.getByRole('button', { name: 'Conversations', exact: true }).click()
  await expect(restored.locator('.conversation-list')).toContainText('Load your architecture skill')
})
