import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaStore } from '../../src/main/media'
import { childEnvironment } from '../../src/main/mcp'
import { parsePreview, previewOptions, previewScript, runProcess } from '../../src/main/blender'

// Opt-in: point RBX_BLENDER at one or more blender executables (separated by ;) to render with the real thing.
const executables = (process.env.RBX_BLENDER || '').split(';').filter(Boolean)

const SCENE = `
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1))
cube = bpy.context.active_object
cube.keyframe_insert('location', frame=1)
cube.location = (3, 0, 1)
cube.keyframe_insert('location', frame=20)
bpy.context.scene.frame_end = 20
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 2, 1))
`
const SNAPSHOT = `
def rbx_state():
    s = bpy.context.scene
    r = s.render
    return {'engine': r.engine, 'x': r.resolution_x, 'y': r.resolution_y, 'pct': r.resolution_percentage, 'fmt': r.image_settings.file_format,
            'path': r.filepath, 'fs': s.frame_start, 'fe': s.frame_end, 'fps': r.fps, 'camera': s.camera.name if s.camera else None,
            'world': s.world.name if s.world else None, 'objects': sorted(o.name for o in bpy.data.objects), 'lights': len(bpy.data.lights),
            'cameras': len(bpy.data.cameras), 'worlds': len(bpy.data.worlds)}
`

async function render(executable: string, args: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'rbx-blender-test-'))
  try {
    const out = join(directory, 'out')
    const script = join(directory, 'run.py')
    const code = previewScript(previewOptions(args, out))
    writeFileSync(script, `${SCENE}\n${SNAPSHOT}\nbefore = rbx_state()\n${code}\nafter = rbx_state()\nprint('RBX_RESTORED', 'yes' if before == after else 'NO ' + repr(before) + ' VS ' + repr(after))\n`)
    const result = await runProcess(executable, ['-b', '--factory-startup', '--python', script], { env: childEnvironment(), timeout: 240_000 })
    return { output: result.output, preview: parsePreview(result.output), directory }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

describe.skipIf(!executables.length).each(executables.length ? executables : ['(RBX_BLENDER not set)'])('Blender preview script with %s', executable => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['a turntable as mp4', { mode: 'turntable', frames: 12, height: 240 }, '.mp4'],
    ['a turntable as webm', { mode: 'turntable', frames: 12, height: 240, format: 'webm' }, '.webm'],
    ['the scene animation as mp4', { mode: 'animation', frames: 10, height: 240, engine: 'workbench' }, '.mp4'],
    ['a still image', { mode: 'still', height: 240 }, '.png']
  ]
  it.each(cases)('renders %s, shares it as valid media, and leaves the scene as it was', async (_name, args, extension) => {
    const { output, preview, directory } = await render(executable, args)
    try {
      expect(output, output.slice(-1500)).toContain('RBX_RESTORED yes')
      expect(preview, output.slice(-1500)).toBeTruthy()
      expect(preview!.file.endsWith(extension)).toBe(true)
      expect(preview!.height).toBe(240)
      const media = new MediaStore(join(directory, 'media'))
      const item = media.ingest(preview!.file, { caption: 'test' })
      expect(item.kind).toBe(extension === '.png' ? 'image' : 'video')
      expect(item.bytes).toBeGreaterThan(1000)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 300_000)
})