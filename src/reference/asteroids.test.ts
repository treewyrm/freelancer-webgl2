/**
 * `asteroid_inside` and `asteroid_nebula`: a field of cubes, an exclusion zone around a station, and a
 * nebula over part of the field with a hole in it, against retail.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { indexTextures } from '#/capture/texture-names.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

interface AsteroidRun {
  name: 'asteroid_inside' | 'asteroid_nebula'
  /** Retail's draws before the depth clear, the engine's effects included. */
  scene: number
  /** What isn't built: the field's band, and in a nebula its fog overlay. */
  unbuilt: number[]
  /** Retail's first cube, and how many. */
  cubes: [number, number]
}

const RUNS_COMPARED: AsteroidRun[] = [
  // In the field: the band, the station in its hole, the ship, then 37 cubes.
  { name: 'asteroid_inside', scene: 128, unbuilt: [10, 11, 12], cubes: [87, 37] },
  // In the field and the nebula: the band, the plant in the nebula's hole, the fog overlay, the
  // ship, then 50 cubes, none in the hole.
  { name: 'asteroid_nebula', scene: 109, unbuilt: [10, 30], cubes: [55, 50] },
]

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

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

const load = async (name: AsteroidRun['name']) => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const folder = join(references, name)
  const system = systems.get(name)!
  const { draws, options } = readSpaceRun(folder, system, RUNS[name])
  return { frame: collectSpaceFrame(await loadSystem(system, read, options)), captured: draws }
}

for (const { name, scene, unbuilt, cubes } of RUNS_COMPARED) {
  // Retail's draws, less what isn't built, and less the engine's four effect draws at the end.
  const builtOf = (captured: readonly unknown[]) =>
    captured.slice(0, scene - 4).filter((_, n) => !unbuilt.includes(n))

  test(
    `${name} is retail draw for draw, but its band and overlay`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)
      const retail = builtOf(captured) as typeof captured
      assert.deepEqual(frame.unsupported, ['texture envmapglass'])
      assert.equal(frame.draws.length, retail.length)
      assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
      // What a nebula holds is fogged, linearly on depth, and nothing else is: the ship in
      // `asteroid_nebula`, not the plant listed before the nebula, nor the cubes.
      frame.draws.forEach((ours, n) => {
        const { states } = retail[n]!
        const what = `draw ${n}, ${ours.materialName}`
        assert.equal(states['FOGENABLE'], ours.fog ? 1 : 0, what)
        if (!ours.fog) return
        assert.equal(states['FOGTABLEMODE'], 3, what)
        assert.ok(Math.abs(ours.fog.start - states['FOGSTART']!) < 1e-3, `${what} start`)
        assert.ok(Math.abs(ours.fog.end - states['FOGEND']!) < 1e-2, `${what} end ${ours.fog.end}`)
        const colour = states['FOGCOLOR']!
        assert.deepEqual(
          [ours.fog.color.x, ours.fog.color.y, ours.fog.color.z].map((c) => Math.round(c * 255)),
          [(colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff],
          what,
        )
      })
    },
  )

  test(
    `${name}: each cube stands and turns where retail drew it, in retail's order`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)
      const [first, count] = cubes
      const offset = unbuilt.filter((n) => n < first).length
      for (let k = 0; k < count; k++) {
        const ours = Matrix4.multiply(frame.view, frame.draws[first - offset + k]!.world)
        const theirs = modelViewOf(captured[first + k]!.world!)
        for (const axis of ['x', 'y', 'z', 'w'] as const)
          for (const cell of ['x', 'y', 'z'] as const)
            assert.ok(
              Math.abs(ours[axis][cell] - theirs[axis][cell]) < 1e-3,
              `cube ${k}: ${axis}.${cell} ${ours[axis][cell]} against ${theirs[axis][cell]}`,
            )
      }
    },
  )

  test(
    `${name}: the cubes are lit as retail lit them, raised by ambient_increase, unfogged`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)
      const [first, count] = cubes
      const offset = unbuilt.filter((n) => n < first).length
      for (let k = 0; k < count; k++) {
        const ours = frame.draws[first - offset + k]!
        const theirs = captured[first + k]!
        const ambient = theirs.states['AMBIENT']!
        assert.deepEqual(
          [ours.sceneAmbient!.x, ours.sceneAmbient!.y, ours.sceneAmbient!.z].map((c) =>
            Math.round(c * 255),
          ),
          [(ambient >> 16) & 0xff, (ambient >> 8) & 0xff, ambient & 0xff],
        )
        assert.equal(ours.lights!.length, theirs.lights.length)
        ours.lights!.forEach((light, at) =>
          [light.color.x, light.color.y, light.color.z].forEach((c, i) =>
            assert.ok(Math.abs(c - theirs.lights[at]!.diffuse[i]!) < 1e-5),
          ),
        )
        assert.equal(theirs.states['FOGENABLE'], 0)
        assert.equal(ours.fog, undefined)
        assert.equal(theirs.states['ZWRITEENABLE'], 1)
        assert.deepEqual([theirs.states['ALPHAREF'], ours.alphaReference], [127, 127])
      }
    },
  )
}
