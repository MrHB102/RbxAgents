import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { McpServer } from '../shared/types'

/** Tools that only look. Everything else the Blender server offers can change the scene or spend credits, so it needs approval. */
export const BLENDER_READ_TOOLS = new Set(['get_addon_status', 'get_scene_info', 'look', 'search_assets'])
/** Tools that exist only to send usage data to the server's author. Agents never see them. */
export const BLENDER_HIDDEN_TOOLS = new Set(['disable_telemetry', 'record_trajectory_feedback'])
/** Environment the Blender and uv processes may inherit beyond the basics: proxies, certificates, and where uv and Blender keep their files. */
export const BLENDER_PASSTHROUGH = ['UV_CACHE_DIR', 'UV_TOOL_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_INDEX_URL', 'UV_OFFLINE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'BLENDER_USER_CONFIG', 'BLENDER_USER_SCRIPTS', 'BLENDER_USER_RESOURCES', 'BLENDER_USER_DATAFILES', 'BLENDERMCP_ADDONS_DIR']

/** The server's installer prints arrows and accents. Into a pipe, Python on Windows would use the legacy code page and crash after doing its work. */
export const BLENDER_PYTHON_ENVIRONMENT = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }

export interface ProcessResult { code: number | null; output: string }
export function runProcess(command: string, args: string[], options: { env: Record<string, string>; timeout: number; signal?: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(options.signal.reason)
    const child = spawn(command, args, { windowsHide: true, shell: false, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    const stop = () => child.kill()
    const timer = setTimeout(() => { stop(); reject(new Error(`${command} did not finish in ${Math.round(options.timeout / 1000)} seconds.`)) }, options.timeout)
    options.signal?.addEventListener('abort', stop, { once: true })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); resolve({ code, output }) })
  })
}

// ---- uv ----------------------------------------------------------------------------------------------------------

/** uvx runs the Blender MCP server. The uv installer puts it in ~/.local/bin, which a desktop app often does not have on PATH yet. */
export function findUvx(): string | undefined {
  const name = process.platform === 'win32' ? 'uvx.exe' : 'uvx'
  const directories = [...(process.env.PATH || '').split(delimiter), join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin'), ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs', 'uv')] : [])]
  for (const directory of directories) if (directory && existsSync(join(directory, name))) return join(directory, name)
  return undefined
}

export const UV_NOTICE = process.platform === 'win32'
  ? 'The Blender connection runs on uv, a small Python tool runner from Astral that is not installed yet.\n\nInstall it now? This runs Astral\u2019s official installer (https://astral.sh/uv/install.ps1). It adds uv to your user PATH and needs no administrator rights.'
  : 'The Blender connection runs on uv, a small Python tool runner from Astral that is not installed yet.\n\nInstall it now? This runs Astral\u2019s official installer (https://astral.sh/uv/install.sh). It adds uv to your user PATH and needs no administrator rights.'

export async function installUv(env: Record<string, string>, run: typeof runProcess = runProcess) {
  const result = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'], { env, timeout: 300_000 })
    : await run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { env, timeout: 300_000 })
  if (result.code !== 0) throw new Error(`The uv installer failed. ${result.output.trim().slice(-400)}`)
}

// ---- Blender -----------------------------------------------------------------------------------------------------

/** Where the add-on's socket server listens. The server and the status check both read this from the connection's own settings. */
export function blenderEndpoint(server: Pick<McpServer, 'args' | 'env'>) {
  const flag = (name: string) => {
    const index = server.args.indexOf(name)
    if (index >= 0) return server.args[index + 1]
    return server.args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  }
  const port = Number(flag('--port') ?? server.env.BLENDER_PORT ?? 9876)
  return { host: flag('--host') ?? server.env.BLENDER_HOST ?? 'localhost', port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 9876 }
}

/** True when something accepts connections at the add-on's address. Opens and closes a socket; sends nothing. */
export function probe(host: string, port: number, timeout = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable) }
    socket.setTimeout(timeout, () => finish(false))
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false))
  })
}

function blenderIn(directory: string) {
  const path = join(directory, process.platform === 'win32' ? 'blender.exe' : 'blender')
  return existsSync(path) ? path : undefined
}
/** Blender executables to enable the add-on in. A path chosen in the connection settings replaces the search. */
export function findBlenders(custom = ''): string[] {
  const found: string[] = []
  const add = (path?: string) => { if (path && !found.includes(path)) found.push(path) }
  const children = (root: string, pattern: RegExp) => { try { return readdirSync(root).filter(name => pattern.test(name)).map(name => join(root, name)) } catch { return [] } }
  const chosen = custom.trim()
  if (chosen) {
    try {
      if (chosen.toLowerCase().endsWith('.app')) { const inside = join(chosen, 'Contents', 'MacOS', 'Blender'); if (existsSync(inside)) add(inside) }
      else if (statSync(chosen).isFile()) add(chosen)
      else { add(blenderIn(chosen)); for (const child of children(chosen, /^Blender/i)) add(blenderIn(child)) }
    } catch { /* not found: reported by the caller */ }
    return found
  }
  if (process.platform === 'win32') {
    const roots = new Set([process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)'], ...['C', 'D', 'E', 'F', 'G', 'H'].map(d => `${d}:\\Program Files`)].filter(Boolean) as string[])
    for (const root of roots) for (const child of children(join(root, 'Blender Foundation'), /^Blender/i)) add(blenderIn(child))
  } else if (process.platform === 'darwin') {
    for (const app of [...children('/Applications', /^Blender.*\.app$/i), ...children(join(homedir(), 'Applications'), /^Blender.*\.app$/i)]) { const path = join(app, 'Contents', 'MacOS', 'Blender'); if (existsSync(path)) add(path) }
  } else {
    for (const directory of (process.env.PATH || '').split(delimiter)) add(directory ? blenderIn(directory) : undefined)
    for (const child of [...children('/opt', /^blender/i), ...children(homedir(), /^blender/i)]) add(blenderIn(child))
  }
  return found
}
export const blenderLabel = (executable: string) => /Blender[ -]?(\d+\.\d+)/i.exec(executable)?.[0].replace(/^blender[ -]?/i, 'Blender ') || 'Blender'

const ENABLE_SCRIPT = `import bpy
ok = False
try:
    bpy.ops.preferences.addon_enable(module='blender_mcp')
    ok = 'blender_mcp' in bpy.context.preferences.addons.keys()
    if ok:
        bpy.ops.wm.save_userpref()
except Exception as error:
    print('RBX_ENABLE_ERROR', error)
print('RBX_ENABLE', 'ok' if ok else 'missing')
`
/** Turns the add-on on in that Blender's saved preferences, so it starts its server whenever Blender opens. Nothing else is changed. */
export async function enableAddon(blender: string, env: Record<string, string>, run: typeof runProcess = runProcess) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-blender-'))
  try {
    const script = join(directory, 'enable.py')
    writeFileSync(script, ENABLE_SCRIPT)
    const result = await run(blender, ['-b', '--python', script], { env, timeout: 120_000 })
    return /RBX_ENABLE ok/.test(result.output)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

export interface BlenderInstallHooks {
  env: Record<string, string>
  /** Asks the user before anything is installed on their computer. Without it, a missing uv is an error. */
  confirm?: (message: string) => Promise<boolean>
  log: (title: string, detail: string) => void
  /** Replaceable in tests so no real installer or Blender runs. */
  run?: typeof runProcess
  find?: () => string | undefined
}
export async function installBlender(server: McpServer, hooks: BlenderInstallHooks): Promise<string> {
  const run = hooks.run ?? runProcess
  const find = hooks.find ?? findUvx
  let uvx = find()
  if (!uvx) {
    if (!hooks.confirm) throw new Error('uv is not installed. Install it from https://docs.astral.sh/uv/ and try again.')
    if (!await hooks.confirm(UV_NOTICE)) throw new Error('Installation cancelled. The Blender connection needs uv to run.')
    hooks.log('Installing uv', 'Running Astral\u2019s official installer.')
    await installUv(hooks.env, run)
    uvx = find()
    if (!uvx) throw new Error('uv was installed but could not be found. Restart RBX Agents and try again.')
  }
  hooks.log('Installing the Blender add-on', 'The first run downloads the MCP server and can take a minute.')
  const added = await run(uvx, [...server.args, 'install-addon'], { env: hooks.env, timeout: 300_000 })
  if (added.code !== 0) throw new Error(`The Blender add-on could not be installed. ${added.output.trim().slice(-400)}`)
  // The installer writes to one Blender only (the newest). Its folder names the version, so other installs are left alone instead of failing.
  const target = /\bto (.+?blender_mcp\.py)/.exec(added.output)?.[1]
  const version = target && /[\\/](\d+\.\d+)[\\/]scripts[\\/]addons[\\/]/.exec(target)?.[1]
  const blenders = findBlenders(server.blenderPath)
  const enabled: string[] = []
  const manual: string[] = []
  const other: string[] = []
  for (const blender of blenders) {
    const label = blenderLabel(blender)
    const own = /\d+\.\d+/.exec(label)?.[0]
    if (version && own && own !== version) other.push(label)
    else (await enableAddon(blender, hooks.env, run) ? enabled : manual).push(label)
  }
  const notes = [added.output.trim().split('\n')[0]]
  if (enabled.length) notes.push(`Enabled in ${enabled.join(', ')}.`)
  if (other.length) notes.push(`${other.join(', ')} ${other.length > 1 ? 'were' : 'was'} left as ${other.length > 1 ? 'they are' : 'it is'}: the add-on was installed for Blender ${version}.`)
  if (manual.length) notes.push(`Could not enable it in ${manual.join(', ')}: open Edit \u2192 Preferences \u2192 Add-ons and turn on \u201cMCP for Blender\u201d.`)
  if (!blenders.length) notes.push('No Blender install was found to enable it in. Open Edit \u2192 Preferences \u2192 Add-ons and turn on \u201cMCP for Blender\u201d, or choose your Blender folder in the connection settings.')
  notes.push('Restart Blender if it is open. The add-on starts its connection by itself.')
  return notes.join(' ')
}

// ---- Rendered previews -------------------------------------------------------------------------------------------

export interface PreviewOptions { mode: 'turntable' | 'still' | 'animation'; frames: number; height: number; engine: 'eevee' | 'workbench' | 'scene'; format: 'mp4' | 'webm'; focus: 'selected' | 'all'; outDir: string }
export function previewOptions(args: Record<string, unknown>, outDir: string): PreviewOptions {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback
  const whole = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
  return {
    mode: pick(args.mode, ['turntable', 'still', 'animation'], 'turntable'), frames: whole(args.frames, 8, 240, 72), height: whole(args.height, 240, 1080, 540),
    engine: pick(args.engine, ['eevee', 'workbench', 'scene'], 'eevee'), format: pick(args.format, ['mp4', 'webm'], 'mp4'), focus: pick(args.focus, ['all', 'selected'], 'all'), outDir
  }
}

/**
 * Python run inside Blender by execute_blender_code. It renders into options.outDir with temporary settings, a temporary camera and light
 * when needed, and puts every setting and every object back afterwards. All names live inside one function so the code also runs when
 * the add-on executes it with separate global and local scopes.
 */
export function previewScript(options: PreviewOptions) {
  return `import json
def rbx_preview(O):
    import bpy, math, os, glob, mathutils
    scene = bpy.context.scene
    r = scene.render
    prefs = bpy.context.preferences
    saved = []
    made_objects = []
    made_data = []
    def put(owner, attr, value):
        try:
            saved.append((owner, attr, getattr(owner, attr)))
            setattr(owner, attr, value)
        except Exception:
            pass
    def must(owner, attr, value):
        saved.append((owner, attr, getattr(owner, attr)))
        setattr(owner, attr, value)
    def new_object(name, data):
        ob = bpy.data.objects.new(name, data)
        scene.collection.objects.link(ob)
        made_objects.append(ob)
        return ob
    GEOMETRY = {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'CURVES', 'POINTCLOUD', 'VOLUME', 'GPENCIL', 'GREASEPENCIL'}
    def targets():
        chosen = []
        if O['focus'] == 'selected':
            try:
                chosen = [ob for ob in bpy.context.selected_objects if ob.type in GEOMETRY]
            except Exception:
                chosen = [ob for ob in scene.objects if ob.type in GEOMETRY and ob.select_get()]
        if not chosen:
            chosen = [ob for ob in scene.objects if ob.type in GEOMETRY and not ob.hide_render and ob.visible_get()]
        return chosen
    def bounds(objs):
        low = mathutils.Vector((1e9, 1e9, 1e9))
        high = mathutils.Vector((-1e9, -1e9, -1e9))
        seen = False
        for ob in objs:
            for corner in ob.bound_box:
                p = ob.matrix_world @ mathutils.Vector(corner)
                seen = True
                for i in range(3):
                    low[i] = min(low[i], p[i])
                    high[i] = max(high[i], p[i])
        if not seen:
            return mathutils.Vector((0.0, 0.0, 0.0)), 1.0
        return (low + high) / 2, max((high - low).length / 2, 0.05)
    def make_camera(center, radius, azimuth):
        data = bpy.data.cameras.new('RBX Preview Camera')
        made_data.append((bpy.data.cameras, data))
        cam = new_object('RBX Preview Camera', data)
        data.lens = 50
        data.sensor_width = 36
        aspect = r.resolution_x / r.resolution_y
        wide = 2 * math.atan(data.sensor_width / 2 / data.lens)
        narrow = 2 * math.atan(data.sensor_width / max(aspect, 1.0) / 2 / data.lens) if aspect >= 1 else 2 * math.atan(data.sensor_width * aspect / 2 / data.lens)
        distance = radius / math.sin(min(wide, narrow) / 2) * 1.1
        pivot = new_object('RBX Preview Pivot', None)
        pivot.location = center
        pivot.rotation_euler = (0.0, 0.0, azimuth)
        cam.parent = pivot
        elevation = math.radians(16)
        position = mathutils.Vector((0.0, -distance * math.cos(elevation), distance * math.sin(elevation)))
        cam.location = position
        cam.rotation_euler = (-position).to_track_quat('-Z', 'Y').to_euler()
        data.clip_start = max(0.001, distance * 0.02)
        data.clip_end = max(100.0, distance * 4 + radius * 4)
        return cam, pivot
    try:
        out_dir = O['outDir']
        os.makedirs(out_dir, exist_ok=True)
        engines = [item.identifier for item in r.bl_rna.properties['engine'].enum_items]
        if O['engine'] == 'eevee':
            for wanted in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
                if wanted in engines:
                    put(r, 'engine', wanted)
                    break
        elif O['engine'] == 'workbench' and 'BLENDER_WORKBENCH' in engines:
            put(r, 'engine', 'BLENDER_WORKBENCH')
        if r.engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
            put(scene.eevee, 'taa_render_samples', 16)
        elif r.engine == 'CYCLES':
            put(scene.cycles, 'samples', 32)
        aspect = min(2.5, max(0.4, r.resolution_x / max(r.resolution_y, 1)))
        height = max(2, int(O['height']) // 2 * 2)
        put(r, 'resolution_x', max(2, int(round(height * aspect / 2)) * 2))
        put(r, 'resolution_y', height)
        put(r, 'resolution_percentage', 100)
        bpy.context.view_layer.update()
        center, radius = bounds(targets())
        if not any(ob.type == 'LIGHT' for ob in scene.objects):
            light = bpy.data.lights.new('RBX Preview Sun', 'SUN')
            light.energy = 3.0
            made_data.append((bpy.data.lights, light))
            sun = new_object('RBX Preview Sun', light)
            sun.rotation_euler = (math.radians(50), 0.0, math.radians(35))
        if scene.world is None:
            world = bpy.data.worlds.new('RBX Preview World')
            world.color = (0.1, 0.1, 0.12)
            made_data.append((bpy.data.worlds, world))
            put(scene, 'world', world)
        first, last = scene.frame_start, scene.frame_end
        if O['mode'] == 'turntable':
            first, last = 1, O['frames']
            cam, pivot = make_camera(center, radius, math.radians(-30))
            put(prefs.edit, 'keyframe_new_interpolation_type', 'LINEAR')
            pivot.rotation_euler = (0.0, 0.0, math.radians(-30))
            pivot.keyframe_insert('rotation_euler', index=2, frame=first)
            pivot.rotation_euler = (0.0, 0.0, math.radians(-30) + math.tau * (O['frames'] - 1) / O['frames'])
            pivot.keyframe_insert('rotation_euler', index=2, frame=last)
            put(scene, 'camera', cam)
            put(r, 'fps', 24)
        elif scene.camera is None:
            cam, pivot = make_camera(center, radius, math.radians(-35))
            put(scene, 'camera', cam)
        if O['mode'] == 'animation':
            last = min(scene.frame_end, scene.frame_start + O['frames'] - 1)
        image = r.image_settings
        if O['mode'] == 'still':
            if hasattr(image, 'media_type'):
                put(image, 'media_type', 'IMAGE')
            must(image, 'file_format', 'PNG')
            put(image, 'color_mode', 'RGB')
            put(r, 'filepath', os.path.join(out_dir, 'preview'))
            put(r, 'use_file_extension', True)
            bpy.ops.render.render(write_still=True)
        else:
            put(scene, 'frame_start', first)
            put(scene, 'frame_end', last)
            if hasattr(image, 'media_type'):
                put(image, 'media_type', 'VIDEO')
            must(image, 'file_format', 'FFMPEG')
            put(image, 'color_mode', 'RGB')
            movie = r.ffmpeg
            if O['format'] == 'webm':
                must(movie, 'format', 'WEBM')
                must(movie, 'codec', 'WEBM')
            else:
                must(movie, 'format', 'MPEG4')
                must(movie, 'codec', 'H264')
                put(movie, 'constant_rate_factor', 'MEDIUM')
                put(movie, 'ffmpeg_preset', 'GOOD')
            put(movie, 'audio_codec', 'NONE')
            put(r, 'filepath', os.path.join(out_dir, 'preview_'))
            put(r, 'use_file_extension', True)
            bpy.ops.render.render(animation=True)
        files = [f for f in sorted(glob.glob(os.path.join(out_dir, 'preview*'))) if f.lower().endswith(('.mp4', '.webm', '.png'))]
        print('RBX_PREVIEW ' + json.dumps({'file': files[-1] if files else '', 'width': r.resolution_x, 'height': r.resolution_y, 'frames': last - first + 1, 'engine': r.engine}))
    finally:
        for owner, attr, value in reversed(saved):
            try:
                setattr(owner, attr, value)
            except Exception:
                pass
        for ob in made_objects:
            try:
                bpy.data.objects.remove(ob, do_unlink=True)
            except Exception:
                pass
        for collection, block in made_data:
            try:
                collection.remove(block)
            except Exception:
                pass
rbx_preview(json.loads(${JSON.stringify(JSON.stringify(options))}))
`
}

export interface PreviewResult { file: string; width: number; height: number; frames: number; engine: string }
export function parsePreview(output: string): PreviewResult | undefined {
  const line = output.split('\n').find(l => l.includes('RBX_PREVIEW '))
  if (!line) return undefined
  try { return JSON.parse(line.slice(line.indexOf('RBX_PREVIEW ') + 12)) } catch { return undefined }
}