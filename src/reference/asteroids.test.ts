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
  name:
    | 'asteroid_inside'
    | 'asteroid_nebula'
    | 'asteroid_outside'
    | 'asteroid_exband'
    | 'asteroid_exband_edge'
    | 'asteroid_hole'
    | 'asteroid_hole_edge'
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
  { name: 'asteroid_nebula', scene: 109, unbuilt: [], band: [10], cubes: [55, 50] },
  // 13000 from the field's centre: all five pieces, far to near, faces turned both ways, and no cube.
  // The plant, 12700 off, is a small solar the camera's query doesn't reach.
  {
    name: 'asteroid_outside',
    scene: 60,
    unbuilt: [],
    band: [10, 11, 12, 13, 14],
    cubes: [60, 0],
  },
  // In the field, 1500 from the station: the field's band and the one about the station, sorted
  // together, all at full alpha, as the camera is within the field.
  {
    name: 'asteroid_exband',
    scene: 132,
    unbuilt: [],
    band: [10, 11, 12, 13, 14, 15, 16],
    cubes: [91, 37],
  },
  // 500 past the field's surface: the station's band at half, after the plant, among the objects.
  {
    name: 'asteroid_exband_edge',
    scene: 107,
    unbuilt: [],
    band: [10, 11, 12, 17, 18, 19, 20, 21, 22],
    cubes: [93, 10],
  },
  // In the nebula's core and its hole: the clear is the fog's, no sky, no band, no overlay past the
  // first frame, and the plant, which holds no nebula, left out. The ship, then the hole's shell at
  // its full 0.8, then the cubes.
  { name: 'asteroid_hole', scene: 64, unbuilt: [], band: [], cubes: [27, 33] },
  // In the hole's edge: the shell at about half, and cubes fading at the walk's reach.
  { name: 'asteroid_hole_edge', scene: 74, unbuilt: [], band: [], cubes: [27, 43] },
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
  const scene = await loadSystem(system, read, options)
  // A frame before, as the game had drawn many: in a core, the overlay's latch is already set.
  collectSpaceFrame(scene)
  return { frame: collectSpaceFrame(scene), captured: draws }
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
        // Whole, a cube cuts at 127; fading at the walk's reach, it blends at 5, still writing depth:
        // only a field's `max_alpha` under 1 stops that.
        const fading = theirs.states['ALPHABLENDENABLE'] === 1
        assert.equal(theirs.states['ZWRITEENABLE'], 1)
        assert.deepEqual(
          [theirs.states['ALPHAREF'], ours.alphaReference],
          fading ? [5, 5] : [127, 127],
        )
      }
    },
  )
}

for (const { name, band } of RUNS_COMPARED)
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

test(
  "asteroid_nebula: the fog overlay is retail's quad, the fog's colour at the camera's depth",
  { skip: skipOf('asteroid_nebula') },
  async () => {
    const { frame, captured } = await load('asteroid_nebula')
    const ours = frame.draws[30]!
    const theirs = captured[30]!
    assert.equal(ours.materialName, 'fog overlay')
    assert.equal(theirs.call, 'DrawIndexedPrimitiveUP')
    // `Win3DSetOrtho2DForCamera`: pixels to clip space over 1024 by 768, Y down.
    assert.deepEqual(
      theirs.projection!.map((v) => Math.fround(v)),
      [2 / 1024, 0, 0, 0, 0, -2 / 768, 0, 0, 0, 0, 1, 0, -1, 1, 0.5, 1].map(Math.fround),
    )
    const floats = new Float32Array(ours.mesh.vertices.buffer)
    const bytes = ours.mesh.vertices
    theirs.vertexData!.forEach(({ p, d }, at) => {
      const [x, y] = [floats[at * 6]!, floats[at * 6 + 1]!]
      // Back to pixels: the last column and row, 1023 and 767, are where it ends.
      assert.ok(Math.abs(((x + 1) * 1024) / 2 - p[0]!) < 1e-3, `vertex ${at} x`)
      assert.ok(Math.abs(((1 - y) * 768) / 2 - p[1]!) < 1e-3, `vertex ${at} y`)
      const [b, g, r, a] = bytes.slice(at * 24 + 12, at * 24 + 16)
      const colour = ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0
      assert.equal(colour.toString(16), Number(d).toString(16), `vertex ${at}`)
    })
    // Under an identity view in retail; ours undoes the frame's view.
    const identity = Matrix4.multiply(frame.view, ours.world)
    for (const axis of ['x', 'y', 'z', 'w'] as const)
      for (const cell of ['x', 'y', 'z', 'w'] as const)
        assert.ok(Math.abs(identity[axis][cell] - (axis[0] === cell[0] ? 1 : 0)) < 1e-6)
  },
)

for (const name of ['asteroid_hole', 'asteroid_hole_edge'] as const)
  test(
    `${name}: the hole's shell stands about it, scaled to its radius, as retail drew it`,
    { skip: skipOf(name) },
    async () => {
      const { frame, captured } = await load(name)
      for (const n of [24, 25, 26]) {
        const ours = frame.draws[n]!
        const theirs = captured[n]!
        assert.deepEqual(
          ['ZENABLE', 'ZWRITEENABLE', 'ZFUNC', 'CULLMODE', 'LIGHTING', 'FOGENABLE', 'AMBIENT'].map(
            (key) => theirs.states[key],
          ),
          [1, 0, 4, 2, 1, 0, 0xffffffff],
        )
        assert.equal(theirs.lights.length, 0)
        const ourView = Matrix4.multiply(frame.view, ours.world)
        const theirView = modelViewOf(theirs.world!)
        for (const axis of ['x', 'y', 'z', 'w'] as const)
          for (const cell of ['x', 'y', 'z'] as const)
            assert.ok(
              Math.abs(ourView[axis][cell] - theirView[axis][cell]) < 1e-3,
              `draw ${n} ${axis}.${cell}: ${ourView[axis][cell]} against ${theirView[axis][cell]}`,
            )
      }
    },
  )
