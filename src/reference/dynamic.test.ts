/**
 * `asteroid_dynamic`: the lab field with Cornwall's `[DynamicAsteroids]`, from inside it, against
 * retail. Each rock's place, motion and turn are the game's `rand()`, so the rocks are compared in
 * kind; what follows from a rock's place, its fade and the state that picks, rock by rock.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Vector3 } from '@treewyrm/freelancer/math'
import { indexTextures } from '#/capture/texture-names.js'
import type { Draw } from '#/scene/frame.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const name = 'asteroid_dynamic'

// Retail's draws before the depth clear, the engine's four effect draws left out: the field's 37
// cubes from 87, then its twelve rocks.
const SCENE = 140 - 4
const ROCKS = 124
const COUNT = 12

const skip = !existsSync(data)
  ? 'no retail DATA'
  : !existsSync(join(references, name, 'd3d8log.jsonl'))
    ? `no ${name} capture in references`
    : false

const load = async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))

    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }

  const system = systems.get(name)!
  const { draws, options } = readSpaceRun(join(references, name), system, RUNS[name])
  const scene = await loadSystem(system, read, options)
  // Placed on the first frame, faded from the second: two seconds on.
  let frame = collectSpaceFrame(scene)
  for (let at = 0; at < 120; at++) frame = collectSpaceFrame({ ...scene, step: 1 / 60 })

  const rocks = scene.asteroids!.find(({ dynamic }) => dynamic)!.dynamic![0]!.rocks

  return { scene, frame, rocks, camera: options.camera, captured: draws }
}

/** A captured rock's place in the world: the device's world is the view's, and the view looks down -Z. */
const placeOf = (world: readonly number[], eye: Vector3): Vector3 => ({
  x: eye.x + world[12]!,
  y: eye.y + world[13]!,
  z: eye.z - world[14]!,
})

test(`${name} is retail draw for draw up to the rocks`, { skip }, async () => {
  const { frame, captured } = await load()

  assert.equal(captured.length >= SCENE, true)
  assert.deepEqual(frame.unsupported, ['texture envmapglass'])
  assert.equal(frame.draws.length, ROCKS + COUNT)
  assertFrameMatches(
    { ...frame, draws: frame.draws.slice(0, ROCKS) },
    captured.slice(0, ROCKS),
    indexTextures(data),
    {
      streamed: true,
    },
  )
})

test(
  `${name}: each rock is drawn as ours would be at retail's place, opaque or faded by it`,
  { skip },
  async () => {
    const { frame, rocks, camera, captured } = await load()
    const retail = captured.slice(ROCKS, ROCKS + COUNT)
    const ours = frame.draws.slice(ROCKS)

    assert.ok(ours.every(({ materialName }) => materialName === ours[0]!.materialName))

    const limit = Math.sqrt(1.05) * rocks.radius
    let faded = 0

    const expected: Draw[] = retail.map(({ world }, at) => {
      const place = placeOf(world!, camera.position)
      const centre = rocks.centre(camera)
      const away = Math.hypot(place.x - centre.x, place.y - centre.y, place.z - centre.z)

      assert.ok(away <= limit + 1e-3, `rock ${at} ${away} from the spawn point`)

      const alpha = rocks.alphaAt(camera, place)!

      // Retail's alpha is from this frame's place, before the physics moves it on.
      assert.ok(Math.abs(alpha - retail[at]!.material!.diffuse[3]!) < 1e-4, `rock ${at} alpha`)

      const blend = alpha < 1
      if (blend) faded++
      return {
        ...ours[0]!,
        diffuse: [
          rocks.diffuse.x,
          rocks.diffuse.y,
          rocks.diffuse.z,
          retail[at]!.material!.diffuse[3]!,
        ],
        blend,
        alphaReference: blend ? 5 : 127,
      }
    })

    // `DrawIndexedPrimitiveVb` streams the indices again for each rock: 120 on each time.
    assertFrameMatches({ ...frame, draws: expected }, retail, indexTextures(data), {
      streamed: true,
    })
    retail.forEach(({ startIndex }, at) =>
      assert.equal(startIndex, retail[0]!.startIndex! + at * 120),
    )
    // Retail's split: four whole, eight fading in or out.
    assert.equal(faded, 8)

    // Each turned, not scaled: the view's mirror makes it left-handed.
    for (const { world } of retail) {
      const [a, b, c] = [0, 4, 8].map((k) => world!.slice(k, k + 3)) as [
        number[],
        number[],
        number[],
      ]
      for (const axis of [a, b, c]) assert.ok(Math.abs(Math.hypot(...axis) - 1) < 1e-5)

      const det =
        a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
        a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) +
        a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)

      assert.ok(Math.abs(det + 1) < 1e-5, `${det}`)
    }
  },
)

test(`${name}: the rocks are lit as retail lit them, by the field's pass`, { skip }, async () => {
  const { frame, captured } = await load()
  const ambient = (value: number) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]

  for (let at = 0; at < COUNT; at++) {
    const { lights = [], sceneAmbient } = frame.draws[ROCKS + at]!
    const theirs = captured[ROCKS + at]!
    const what = `rock ${at}`

    assert.deepEqual(
      [sceneAmbient!.x, sceneAmbient!.y, sceneAmbient!.z].map((c) => Math.round(c * 255)),
      ambient(theirs.states['AMBIENT']!),
      what,
    )
    assert.equal(lights.length, theirs.lights.length, what)
    lights.forEach((light, k) => {
      const captured = theirs.lights[k]!
      ;[light.color.x, light.color.y, light.color.z].forEach((c, i) =>
        assert.ok(Math.abs(c - captured.diffuse[i]!) < 1e-5, `${what} light ${k} colour`),
      )

      const { x, y, z } = light.direction
      ;[x, y, -z].forEach((c, i) =>
        assert.ok(Math.abs(c - captured.direction[i]!) < 1e-5, `${what} light ${k} direction`),
      )
    })
  }
})
