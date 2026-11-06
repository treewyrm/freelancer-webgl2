/**
 * `asteroid_inside`, `asteroid_nebula` and `asteroid_outside`: a field of cubes and its band, an
 * exclusion zone around a station, and a nebula over part of the field with a hole in it, against
 * retail.
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
  name: 'asteroid_inside' | 'asteroid_nebula' | 'asteroid_outside'
  /** Retail's draws before the depth clear, the engine's effects included. */
  scene: number
  /** What isn't built: in a nebula, its fog overlay. */
  unbuilt: number[]
  /** The band's pieces, on the main list after the sky. */
  band: number[]
  /** Retail's first cube, and how many. */
  cubes: [number, number]
}

const RUNS_COMPARED: AsteroidRun[] = [
  // In the field: three pieces of the band, the station in its hole, the ship, then 37 cubes.
  { name: 'asteroid_inside', scene: 128, unbuilt: [], band: [10, 11, 12], cubes: [87, 37] },
  // In the field and the nebula: a piece of the band, the plant in the nebula's hole, the fog
  // overlay, the ship, then 50 cubes, none in the hole.
  { name: 'asteroid_nebula', scene: 109, unbuilt: [30], band: [10], cubes: [55, 50] },
  // 13000 from the field's centre: all five pieces, far to near, faces turned both ways, and no cube.
]

// 13000 from the field's centre: all five pieces, far to near, faces turned both ways. The frame
// around them isn't compared: retail draws its station at a coarser level than this picks, and
// leaves out the plant, which `level.ts`'s far clamp keeps.
const BAND_RUNS: Pick<AsteroidRun, 'name' | 'band'>[] = [
  ...RUNS_COMPARED,
  { name: 'asteroid_outside', band: [10, 11, 12, 13, 14] },
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
    `${name} is retail draw for draw, but a nebula's overlay`,
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

for (const { name, band } of BAND_RUNS)
  test(
    `${name}: each band piece is retail's, in state, place, colour, fade and UVs`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)
      const pieces = frame.draws.filter(({ materialName }) => materialName === 'band')
      assert.equal(pieces.length, band.length)
      for (const [k, n] of band.entries()) {
        const what = `draw ${n}`
        const ours = pieces[k]!
        const { states, stages, world, vertexData } = captured[n]!
        assert.equal(ours.materialName, 'band', what)
        assert.deepEqual(
          ['ZENABLE', 'ZWRITEENABLE', 'CULLMODE', 'LIGHTING', 'SRCBLEND', 'DESTBLEND'].map(
            (key) => states[key],
          ),
          [0, 0, 1, 0, 5, 6],
          what,
        )
        assert.deepEqual(
          [states['ALPHATESTENABLE'], states['ALPHAFUNC'], states['ALPHAREF'], states['FOGENABLE']],
          [1, 5, ours.alphaReference, 0],
          what,
        )
        assert.deepEqual([ours.depthFunc, ours.depthWrite, ours.fog], ['always', false, undefined])
        assert.deepEqual(
          ['COLOROP', 'ALPHAOP', 'ADDRESSU', 'ADDRESSV', 'MAGFILTER', 'MIPFILTER'].map(
            (key) => stages[0]!.states[key],
          ),
          [4, 4, 1, 1, 2, 1],
          what,
        )
        assert.equal(stages[1]!.states['COLOROP'], 1, what)
        // In world space on the far list's plane: the modelview is the view alone.
        const theirs = modelViewOf(world!)
        for (const axis of ['x', 'y', 'z', 'w'] as const)
          for (const cell of ['x', 'y', 'z'] as const)
            assert.ok(Math.abs(frame.view[axis][cell] - theirs[axis][cell]) < 1e-3, what)

        const floats = new Float32Array(ours.mesh.vertices.buffer)
        const bytes = ours.mesh.vertices
        assert.equal(ours.count, vertexData!.length, what)
        vertexData!.forEach(({ p, d, t0 }, at) => {
          const where = `${what}, vertex ${at}`
          p.forEach((c, axis) =>
            assert.ok(Math.abs(c - floats[at * 6 + axis]!) <= Math.abs(c) * 2.4e-7 + 1e-4, where),
          )
          const [b, g, r, a] = bytes.slice(at * 24 + 12, at * 24 + 16)
          const colour = ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0
          assert.equal(colour.toString(16), Number(d).toString(16), where)
          assert.deepEqual(
            [...t0!].map(Math.fround),
            [...floats.slice(at * 6 + 4, at * 6 + 6)],
            where,
          )
        })
      }
    },
  )
