/** `space_order`, a lab system flown into from a save, against what the game drew: M7's first frame. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Document } from '@treewyrm/freelancer/ini'
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import type { Camera } from '#/scene/camera.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const folder = join(references, 'space_order')
const run = join(folder, 'd3d8log.jsonl')
const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(run)
    ? 'no space_order capture in references'
    : false

const system = systems.get('space_order')!

// After the scene the game clears depth and draws its HUD.
const SCENE_DRAWS = 123
// `mplatform`'s loadout puts a `Small_station_turret` on its `HpTurret`s, and one drew. Equipment on a
// solar isn't built.
const TURRET = 98
// `mplatform_animate1`, in the same loadout, turns this part.
const ANIMATED = 97
// The engine's flame, and the platform's lights and smoke: effects, after every object.
const FIRST_EFFECT = 123

/** A captured row-vector modelview, with its Z flip, as a column-major GL one. */
const modelViewOf = (world: readonly number[]): Matrix4 => {
  const column = (c: number) => ({
    x: world[c * 4]!,
    y: world[c * 4 + 1]!,
    z: -world[c * 4 + 2]!,
    w: world[c * 4 + 3]!,
  })
  return { x: column(0), y: column(1), z: column(2), w: column(3) }
}

/** Where the game's chase camera was, from a far planet the system file places. */
const cameraOf = (draws: readonly CaptureDraw[]): Camera => {
  // `Lab_far_planet`'s first face. The sky's rotation is the camera's alone.
  const far = system.objects.find(({ nickname }) => nickname === 'Lab_far_planet')!.position
  const sky = draws[0]!.world!
  assert.deepEqual(
    [sky[0], sky[1], sky[2], sky[4], sky[5], sky[6], sky[8], sky[9], sky[10]],
    [1, 0, 0, 0, 1, 0, 0, 0, -1],
    'the camera looked straight down -Z',
  )
  const [x, y, z] = draws[10]!.world!.slice(12, 15) as [number, number, number]
  const projection = draws[20]!.projection!
  // D3D's `_11` is 1 / tan(half fov x), `_33` is far / (far - near), `_43` is -near times that.
  const near = -projection[14]! / projection[10]!
  return {
    position: { x: far[0] - x, y: far[1] - y, z: far[2] + z },
    orientation: Matrix3.identity,
    fovh: (Math.atan(1 / projection[0]!) * 180) / Math.PI,
    near,
    far: (projection[10]! * near) / (projection[10]! - 1),
  }
}

const options = (): { detail: number; starSphere: number } => {
  const section = Document.read(readFileSync(join(folder, 'PerfOptions.ini'))).getSection(
    'PerfOptions',
  )!
  const option = (name: string) => Number(section.getValue(name)!.value)
  return { detail: option('level_of_detail'), starSphere: option('star_sphere') }
}

const load = async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const captured = readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws
  const camera = cameraOf(captured)
  // The hull's root part stands where the ship does: the first draw after the pilot's.
  const [x, y, z] = captured[101]!.world!.slice(12, 15) as [number, number, number]
  const ship: Vector3 = {
    x: camera.position.x + x,
    y: camera.position.y + y,
    z: camera.position.z - z,
  }
  const scene = await loadSystem(system, read, { camera, ship, ...options() })
  const retail = captured.slice(0, SCENE_DRAWS).filter((_, n) => n !== TURRET)
  return { camera, frame: collectSpaceFrame(scene), retail, captured }
}

test(
  'the chase camera is retail space: a half fov of 35, near 3, far the default 21000',
  { skip },
  async () => {
    const { camera } = await load()
    assert.ok(Math.abs(camera.fovh - 35) < 1e-3, `${camera.fovh}`)
    assert.ok(Math.abs(camera.near - 3) < 1e-3, `${camera.near}`)
    // Single-precision `_33` leaves the far plane good to about 10.
    assert.ok(Math.abs(camera.far - 21000) < 20, `${camera.far}`)
  },
)

test('space_order is retail draw for draw, in retail order', { skip }, async () => {
  const { frame, retail, captured } = await load()
  // Retail's glass binds `envmapglass` from the archetype's `.txm`, which isn't a model library here.
  assert.deepEqual(frame.unsupported, ['texture envmapglass'])
  assert.equal(frame.draws.length, FIRST_EFFECT - 1)
  assert.equal(captured[SCENE_DRAWS - 1]!.stages[0]!.states['COLOROP'] !== undefined, true)
  assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
})

test('each draw stands where retail drew it, the far list on its own plane', { skip }, async () => {
  const { frame, retail } = await load()
  frame.draws.forEach(({ world, materialName, projection }, n) => {
    if (n === ANIMATED) return
    const ours = Matrix4.multiply(frame.view, world)
    const theirs = modelViewOf(retail[n]!.world!)
    for (const axis of ['x', 'y', 'z', 'w'] as const)
      for (const cell of ['x', 'y', 'z'] as const)
        assert.ok(
          Math.abs(ours[axis][cell] - theirs[axis][cell]) < 0.01,
          `draw ${n}, ${materialName}: ${axis}.${cell} ${ours[axis][cell]} against ${theirs[axis][cell]}`,
        )
    // D3D's `_33` is GL's -(f + n) / (f - n) mapped onto [0, 1]: the far plane decides it.
    const far = projection ?? frame.projection
    const q = retail[n]!.projection![10]!
    const ourQ = (1 - far.z.z) / 2
    assert.ok(Math.abs(ourQ - q) < 1e-5, `draw ${n}, ${materialName}: _33 ${ourQ} against ${q}`)
  })
})

test(
  'each object is lit as retail lit it: the same lights, colours and directions',
  { skip },
  async () => {
    const { frame, retail, camera } = await load()
    const ambient = (value: number) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
    frame.draws.forEach(({ lights = [], sceneAmbient, materialName }, n) => {
      const what = `draw ${n}, ${materialName}`
      const theirs = retail[n]!.lights
      assert.equal(lights.length, theirs.length, what)
      if (sceneAmbient)
        assert.deepEqual(
          [sceneAmbient.x, sceneAmbient.y, sceneAmbient.z].map((c) => Math.round(c * 255)),
          ambient(retail[n]!.states['AMBIENT']!),
          what,
        )
      lights.forEach((light, at) => {
        const captured = theirs[at]!
        ;[light.color.x, light.color.y, light.color.z].forEach((c, i) =>
          assert.ok(Math.abs(c - captured.diffuse[i]!) < 1e-5, `${what}, light ${at} colour`),
        )
        if (light.position) {
          const { x, y, z } = light.position
          const view = [x - camera.position.x, y - camera.position.y, -(z - camera.position.z)]
          view.forEach((c, i) =>
            assert.ok(Math.abs(c - captured.position[i]!) < 0.01, `${what}, light ${at} position`),
          )
          assert.deepEqual(
            light.attenuation &&
              [light.attenuation.x, light.attenuation.y, light.attenuation.z].map(Math.fround),
            captured.attenuation.map(Math.fround),
            what,
          )
        } else {
          const { x, y, z } = light.direction
          ;[x, y, -z].forEach((c, i) =>
            assert.ok(
              Math.abs(c - captured.direction[i]!) < 1e-5,
              `${what}, light ${at} direction`,
            ),
          )
        }
      })
    })
  },
)
