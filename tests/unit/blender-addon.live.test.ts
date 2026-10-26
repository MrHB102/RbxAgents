import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/store'
import { McpManager, childEnvironment } from '../../src/main/mcp'
import { MediaStore } from '../../src/main/media'
import { AgentRuntime } from '../../src/main/runtime'
import { BLENDER_PYTHON_ENVIRONMENT, enableAddon, findBlenders, findUvx, installBlender, probe, runProcess } from '../../src/main/blender'
import { BLENDER_PACKAGE, blenderServer } from '../../src/shared/defaults'
import type { Providers } from '../../src/main/providers'

// Opt-in, and it opens a real Blender window for a few seconds in a throwaway profile:
//   RBX_LIVE_BLENDER="C:\...\blender.exe" npx vitest run tests/unit/blender-addon.live
// Needs uv and the network (it downloads mcp-for-blender from PyPI). Your own Blender profile is never touched.
const blender = process.env.RBX_LIVE_BLENDER
const PORT = 9877

// The same one-click path the app takes, with a pretend Windows profile (APPDATA) so nothing of yours is read or changed.
describe.skipIf(!blender || process.platform !== 'win32')('the one-click installer', () => {
  it('installs for the newest Blender in the profile, turns it on, and leaves older ones alone', async () => {
    const appdata = mkdtempSync(join(tmpdir(), 'rbx-live-appdata-'))
    try {
      const versions = findBlenders(join(blender!, '..', '..')).map(path => /(\d+\.\d+)/.exec(path)?.[1]).filter(Boolean) as string[]
      expect(versions.length).toBeGreaterThan(0)
      for (const version of versions) mkdirSync(join(appdata, 'Blender Foundation', 'Blender', version, 'config'), { recursive: true })
      const newest = [...versions].sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]))[0]
      // The installer finds profiles through APPDATA; Blender itself ignores it on Windows, so its profile is pointed there explicitly.
      const profile = join(appdata, 'Blender Foundation', 'Blender', newest)
      const env = childEnvironment({ ...BLENDER_PYTHON_ENVIRONMENT, APPDATA: appdata, BLENDER_USER_SCRIPTS: join(profile, 'scripts'), BLENDER_USER_CONFIG: join(profile, 'config'), ...(process.env.UV_CACHE_DIR ? { UV_CACHE_DIR: process.env.UV_CACHE_DIR } : {}), DISABLE_TELEMETRY: 'true' })
      const server = blenderServer()
      server.blenderPath = join(blender!, '..', '..')
      const logs: string[] = []
      const message = await installBlender(server, { env, log: (title, detail) => logs.push(`${title}: ${detail}`) })
      expect(message).toContain(`Enabled in Blender ${newest}.`)
      expect(readdirSync(join(appdata, 'Blender Foundation', 'Blender', newest, 'scripts', 'addons'))).toContain('blender_mcp.py')
      for (const version of versions.filter(v => v !== newest)) expect(message).toContain(`Blender ${version} was left as it is`)
      expect(readdirSync(join(appdata, 'Blender Foundation', 'Blender', newest, 'config'))).toContain('userpref.blend')
    } finally { rmSync(appdata, { recursive: true, force: true }) }
  }, 600_000)
})

describe.skipIf(!blender)('the real add-on and the real MCP server', () => {
  const root = mkdtempSync(join(tmpdir(), 'rbx-live-blender-'))
  let child: ChildProcess | undefined
  afterAll(() => { child?.kill(); rmSync(root, { recursive: true, force: true }) })

  it('installs, enables, connects, reports the scene, and posts a rendered video', async () => {
    const uvx = findUvx()
    expect(uvx, 'uvx must be installed').toBeTruthy()
    const profile = { BLENDER_USER_CONFIG: join(root, 'config'), BLENDER_USER_SCRIPTS: join(root, 'scripts') }
    mkdirSync(profile.BLENDER_USER_CONFIG, { recursive: true }); mkdirSync(join(profile.BLENDER_USER_SCRIPTS, 'addons'), { recursive: true })
    const env = childEnvironment({ ...BLENDER_PYTHON_ENVIRONMENT, ...profile, ...(process.env.UV_CACHE_DIR ? { UV_CACHE_DIR: process.env.UV_CACHE_DIR } : {}), DISABLE_TELEMETRY: 'true' })

    const added = await runProcess(uvx!, [BLENDER_PACKAGE, 'install-addon', '--addons-dir', join(profile.BLENDER_USER_SCRIPTS, 'addons')], { env, timeout: 300_000 })
    expect(added.code, added.output).toBe(0)
    expect(readdirSync(join(profile.BLENDER_USER_SCRIPTS, 'addons'))).toContain('blender_mcp.py')
    expect(await enableAddon(blender!, env)).toBe(true)

    // Blender opens with the add-on on; it starts its socket server by itself. The port is changed so a Blender of yours is not disturbed.
    const startup = join(root, 'startup.py')
    writeFileSync(startup, `import bpy\nbpy.context.scene.blendermcp_port = ${PORT}\nbpy.ops.mesh.primitive_monkey_add(location=(0, 0, 1))\nbpy.ops.mesh.primitive_torus_add(location=(0, 0, 1), major_radius=2, minor_radius=0.2)\n`)
    expect(await probe('127.0.0.1', PORT), `something already listens on ${PORT}`).toBe(false)
    child = spawn(blender!, ['--python', startup], { env, stdio: 'ignore', windowsHide: false })
    await vi.waitFor(async () => expect(await probe('127.0.0.1', PORT)).toBe(true), { timeout: 60_000, interval: 1000 })

    const store = new Store(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
    const server = store.state.servers.find(s => s.id === 'blender')!
    server.args = [BLENDER_PACKAGE, '--host', '127.0.0.1', '--port', String(PORT)]
    const mcp = new McpManager(store)
    try {
      const status = await mcp.blenderStatus()
      expect(status).toMatchObject({ reachable: true, port: PORT })
      expect(status.report.length).toBeGreaterThan(10)
      expect(server.tools.map(t => t.name)).toEqual(expect.arrayContaining(['execute_blender_code', 'get_scene_info', 'look']))
      expect(server.tools.map(t => t.name)).not.toContain('record_trajectory_feedback')
      const scene = await mcp.call('blender', 'get_scene_info', {})
      expect(JSON.stringify(scene)).toMatch(/Suzanne|Torus/)

      // An agent asks for a turntable; the real add-on renders it inside the open Blender.
      const agent = store.state.agents.find(a => a.id === 'artist')!
      agent.providerId = 'local'; agent.model = 'test'; agent.permission = 'unrestricted'
      store.state.providers.push({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://localhost:1/v1', models: ['test'], hasKey: false, status: 'connected' })
      store.state.sessions.push({ id: 's', agentId: 'artist', title: 'Live', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', tokens: 0 })
      let step = 0
      const turn = vi.fn(async () => step++ === 0 ? { text: '', tokens: 1, calls: [{ id: 'c', name: 'render_preview', arguments: JSON.stringify({ mode: 'turntable', frames: 12, height: 240, caption: 'Live turntable' }) }] } : { text: 'Done.', tokens: 1, calls: [] })
      const media = new MediaStore(join(root, 'media'))
      const runtime = new AgentRuntime(store, { turn } as unknown as Providers, mcp, undefined, media)
      await runtime.send('s', 'Show me the model.')
      await vi.waitFor(() => expect(runtime.isRunning('s')).toBe(false), { timeout: 240_000, interval: 1000 })
      const message = store.state.sessions[0].messages.find(m => m.role === 'tool')!
      expect(message.content, message.content).not.toContain('"error"')
      expect(message.media?.[0]).toMatchObject({ kind: 'video', mime: 'video/mp4', caption: 'Live turntable' })
      expect(message.media![0].bytes).toBeGreaterThan(2000)
      runtime.close()
    } finally { await mcp.close() }
  }, 600_000)
})