import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLENDER_HIDDEN_TOOLS, BLENDER_READ_TOOLS, blenderEndpoint, blenderLabel, findBlenders, installBlender, parsePreview, previewOptions, previewScript, probe, type ProcessResult } from '../../src/main/blender'
import { blenderServer } from '../../src/shared/defaults'

const directories: string[] = []
const temp = () => { const directory = mkdtempSync(join(tmpdir(), 'rbx-blender-unit-')); directories.push(directory); return directory }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const executable = process.platform === 'win32' ? 'blender.exe' : 'blender'

describe('where the add-on listens', () => {
  it('uses the add-on defaults, then the connection arguments, then its environment', () => {
    expect(blenderEndpoint({ args: ['mcp-for-blender@2.2.4'], env: {} })).toEqual({ host: 'localhost', port: 9876 })
    expect(blenderEndpoint({ args: ['pkg', '--port', '9877'], env: {} })).toEqual({ host: 'localhost', port: 9877 })
    expect(blenderEndpoint({ args: ['pkg', '--port=9878', '--host=127.0.0.1'], env: {} })).toEqual({ host: '127.0.0.1', port: 9878 })
    expect(blenderEndpoint({ args: [], env: { BLENDER_PORT: '9879', BLENDER_HOST: '::1' } })).toEqual({ host: '::1', port: 9879 })
    expect(blenderEndpoint({ args: ['--port', '9880'], env: { BLENDER_PORT: '1' } }).port).toBe(9880)
  })
  it('falls back to the default port for values that are not ports', () => {
    for (const port of ['abc', '0', '70000', '-5', '98.5', '']) expect(blenderEndpoint({ args: [], env: { BLENDER_PORT: port } }).port).toBe(9876)
  })
  it('tells whether something is listening, by opening and closing a connection', async () => {
    const server = createServer(socket => socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    expect(await probe('127.0.0.1', port)).toBe(true)
    await new Promise(resolve => server.close(resolve))
    expect(await probe('127.0.0.1', port)).toBe(false)
  })
})

describe('finding Blender', () => {
  const install = (root: string, version: string) => { const folder = join(root, `Blender ${version}`); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, executable), ''); return join(folder, executable) }
  it('uses the program or folder chosen in the settings, and nothing else', () => {
    const root = temp()
    const a = install(root, '4.5')
    const b = install(root, '5.2')
    expect(findBlenders(a)).toEqual([a])
    expect(findBlenders(join(root, 'Blender 5.2'))).toEqual([b])
    expect(findBlenders(root).sort()).toEqual([a, b].sort())
    expect(findBlenders(join(root, 'nothing-here'))).toEqual([])
  })
  it('accepts a macOS app bundle', () => {
    const root = temp()
    const inside = join(root, 'Blender.app', 'Contents', 'MacOS', 'Blender')
    mkdirSync(join(root, 'Blender.app', 'Contents', 'MacOS'), { recursive: true }); writeFileSync(inside, '')
    expect(findBlenders(join(root, 'Blender.app'))).toEqual([inside])
  })
  it('names an install by its version', () => {
    expect(blenderLabel('D:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe')).toBe('Blender 5.2')
    expect(blenderLabel('/opt/blender-4.5/blender')).toBe('Blender 4.5')
    expect(blenderLabel('/usr/bin/blender')).toBe('Blender')
  })
})

describe('which tools agents get', () => {
  it('keeps the data-collection tools away from agents and treats only looking as read-only', () => {
    expect([...BLENDER_HIDDEN_TOOLS].sort()).toEqual(['disable_telemetry', 'record_trajectory_feedback'])
    expect([...BLENDER_READ_TOOLS].sort()).toEqual(['get_addon_status', 'get_scene_info', 'look', 'search_assets'])
    for (const tool of ['execute_blender_code', 'generate_3d', 'import_asset']) expect(BLENDER_READ_TOOLS.has(tool)).toBe(false)
  })
  it('is pinned to one release and keeps usage telemetry off', () => {
    const server = blenderServer()
    expect(server.args).toEqual([expect.stringMatching(/^mcp-for-blender@\d+\.\d+\.\d+$/)])
    expect(server.env.DISABLE_TELEMETRY).toBe('true')
    expect(server.transport).toBe('stdio')
  })
})

describe('the preview script', () => {
  it('limits every option to what the script can render', () => {
    expect(previewOptions({}, 'out')).toEqual({ mode: 'turntable', frames: 72, height: 540, engine: 'eevee', format: 'mp4', focus: 'all', outDir: 'out' })
    expect(previewOptions({ frames: 3, height: 100 }, 'o')).toMatchObject({ frames: 8, height: 240 })
    expect(previewOptions({ frames: 99999, height: 99999 }, 'o')).toMatchObject({ frames: 240, height: 1080 })
    expect(previewOptions({ frames: 30.6, height: 400.4 }, 'o')).toMatchObject({ frames: 31, height: 400 })
    expect(previewOptions({ frames: '30', height: null, mode: 'explode', engine: 'cycles', format: 'mov', focus: 'everything' }, 'o')).toEqual(previewOptions({}, 'o'))
    expect(previewOptions({ mode: 'still', engine: 'workbench', format: 'webm', focus: 'selected' }, 'o')).toMatchObject({ mode: 'still', engine: 'workbench', format: 'webm', focus: 'selected' })
  })
  it('carries the options through unharmed, including awkward paths', () => {
    const options = previewOptions({ mode: 'animation', frames: 48 }, 'C:\\Users\\me\\"quoted" folder\\out\u00e7\u00e3o')
    const script = previewScript(options)
    const literal = /json\.loads\((".*")\)\)\s*$/s.exec(script)
    expect(literal).toBeTruthy()
    expect(JSON.parse(JSON.parse(literal![1]))).toEqual(options)
    expect(script).not.toMatch(/\$\{|`/)
  })
  it('is valid Python', () => {
    const python = spawnSync('python', ['-X', 'utf8', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: previewScript(previewOptions({ mode: 'turntable' }, 'out')), encoding: 'utf8' })
    if (python.error) return // no Python on this machine; the live Blender test covers it
    expect(python.stderr).toBe('')
    expect(python.status).toBe(0)
  })
  it('reads the result line it prints, among Blender\u2019s own output', () => {
    const line = `RBX_PREVIEW ${JSON.stringify({ file: 'C:\\x\\preview_0001-0012.mp4', width: 960, height: 540, frames: 12, engine: 'BLENDER_EEVEE_NEXT' })}`
    expect(parsePreview(`Fra:1 Mem:30M\nsome noise\n${line}\nBlender quit`)).toMatchObject({ file: 'C:\\x\\preview_0001-0012.mp4', frames: 12 })
    expect(parsePreview('RBX_PREVIEW {broken')).toBeUndefined()
    expect(parsePreview('nothing useful')).toBeUndefined()
  })
})

describe('the one-click installer', () => {
  const ok = (output = ''): ProcessResult => ({ code: 0, output })
  function setup(options: { uvx?: string | undefined; blenders?: string[]; confirm?: (message: string) => Promise<boolean>; results?: Record<string, ProcessResult> } = {}) {
    const root = temp()
    const server = blenderServer()
    const installs = (options.blenders ?? ['4.5', '5.2']).map(version => { const folder = join(root, `Blender ${version}`); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, executable), ''); return join(folder, executable) })
    if (installs.length) server.blenderPath = root
    const calls: { command: string; args: string[]; script?: string }[] = []
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args, script: args[1] === '--python' ? readFileSync(args[2], 'utf8') : undefined })
      if (options.results?.[command]) return options.results[command]
      return ok(command.endsWith('install') ? '' : 'RBX_ENABLE ok')
    })
    const log = vi.fn()
    let found = 'uvx' in options ? options.uvx : join(root, 'uvx')
    return { server, calls, run, log, installs, set: (value: string | undefined) => { found = value }, hooks: (extra: object = {}) => ({ env: {}, log, run: run as never, find: () => found, confirm: options.confirm, ...extra }) }
  }
  it('installs the pinned add-on, then turns it on in every Blender it finds', async () => {
    const t = setup({ results: {} })
    t.run.mockImplementation(async (command: string, args: string[]) => { t.calls.push({ command, args, script: args[1] === '--python' ? readFileSync(args[2], 'utf8') : undefined }); return args.includes('install-addon') ? ok('Installed MCP for Blender addon to C:\\Blender\\scripts\\addons\\blender_mcp.py. In Blender: restart.') : ok('RBX_ENABLE ok') })
    const message = await installBlender(t.server, t.hooks())
    expect(t.calls[0].args).toEqual([...t.server.args, 'install-addon'])
    expect(t.calls).toHaveLength(3)
    for (const call of t.calls.slice(1)) {
      expect(call.args.slice(0, 2)).toEqual(['-b', '--python'])
      expect(call.args).not.toContain('--factory-startup')
      expect(call.script).toContain("addon_enable(module='blender_mcp')")
      expect(call.script).toContain('save_userpref')
    }
    expect(message).toContain('Installed MCP for Blender addon')
    expect(message).toMatch(/Enabled in Blender 4\.5, Blender 5\.2/)
    expect(message).toContain('Restart Blender')
  })
  it('turns the add-on on only in the Blender it was installed for, and says what it left alone', async () => {
    const t = setup()
    t.run.mockImplementation(async (command: string, args: string[]) => { t.calls.push({ command, args }); return args.includes('install-addon') ? ok('Installed MCP for Blender addon to C:\\Users\\me\\AppData\\Roaming\\Blender Foundation\\Blender\\5.2\\scripts\\addons\\blender_mcp.py. In Blender: restart.') : ok('RBX_ENABLE ok') })
    const message = await installBlender(t.server, t.hooks())
    expect(t.calls.filter(c => c.args[0] === '-b')).toHaveLength(1)
    expect(t.calls.find(c => c.args[0] === '-b')!.command).toContain('5.2')
    expect(message).toContain('Enabled in Blender 5.2.')
    expect(message).toContain('Blender 4.5 was left as it is: the add-on was installed for Blender 5.2.')
    expect(message).not.toContain('Could not enable')
  })
  it('says exactly which Blender it could not turn the add-on on in', async () => {
    const t = setup()
    t.run.mockImplementation(async (_command: string, args: string[]) => args.includes('install-addon') ? ok('Installed.') : ok(t.calls.push({ command: '', args }) % 2 ? 'RBX_ENABLE ok' : 'RBX_ENABLE missing'))
    const message = await installBlender(t.server, t.hooks())
    expect(message).toMatch(/Enabled in Blender \d\.\d\./)
    expect(message).toMatch(/Could not enable it in Blender \d\.\d: open Edit/)
  })
  it('explains the manual step when no Blender is found', async () => {
    const t = setup({ blenders: [] })
    t.server.blenderPath = join(temp(), 'nothing')
    const message = await installBlender(t.server, t.hooks())
    expect(t.run).toHaveBeenCalledTimes(1)
    expect(message).toMatch(/No Blender install was found.*Add-ons/)
  })
  it('reports a failed add-on install with the tool\u2019s own words and does not touch Blender', async () => {
    const t = setup()
    t.run.mockResolvedValue({ code: 1, output: 'error: No Blender addons directory found' })
    await expect(installBlender(t.server, t.hooks())).rejects.toThrow(/could not be installed.*No Blender addons directory/)
    expect(t.run).toHaveBeenCalledTimes(1)
  })
  it('never installs uv without asking, and stops if there is no way to ask', async () => {
    const t = setup({ uvx: undefined })
    await expect(installBlender(t.server, t.hooks())).rejects.toThrow(/uv is not installed/)
    expect(t.run).not.toHaveBeenCalled()
  })
  it('stops when the user declines to install uv', async () => {
    const confirm = vi.fn(async (_message: string) => false)
    const t = setup({ uvx: undefined, confirm })
    await expect(installBlender(t.server, t.hooks())).rejects.toThrow(/cancelled/)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toContain('astral.sh')
    expect(t.run).not.toHaveBeenCalled()
  })
  it('installs uv with Astral\u2019s own installer when the user agrees, then continues', async () => {
    const confirm = vi.fn(async (_message: string) => true)
    const t = setup({ uvx: undefined, confirm })
    t.run.mockImplementation(async (command: string, args: string[]) => { t.calls.push({ command, args }); if (/powershell|^sh$/.test(command)) t.set(join(temp(), 'uvx')); return ok('RBX_ENABLE ok') })
    await installBlender(t.server, t.hooks())
    expect(t.calls[0].command).toMatch(process.platform === 'win32' ? /powershell/ : /^sh$/)
    expect(t.calls[0].args.join(' ')).toContain('astral.sh/uv/install')
    expect(t.calls[1].args).toContain('install-addon')
  })
  it('fails clearly if uv was installed but cannot be found afterwards', async () => {
    const t = setup({ uvx: undefined, confirm: async () => true })
    await expect(installBlender(t.server, t.hooks())).rejects.toThrow(/could not be found/)
  })
})