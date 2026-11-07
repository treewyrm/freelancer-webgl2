/**
 * `sun_ahead`, `sun_occluded` and `sun_nebula`: `med_yellow_sun` in view, behind a station's edge, and
 * from a nebula's edge, against retail. Its glow, spines, corona and flare vertex for vertex, after
 * five seconds of frames so every fade has settled.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CaptureDraw } from '#/capture/capture.js'
import { indexTextures, namesOf } from '#/capture/texture-names.js'
import type { Draw } from '#/scene/frame.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

type SunRun = 'sun_ahead' | 'sun_occluded' | 'sun_nebula'

interface Compared {
  name: SunRun
  /** Scene draws before the engine's effects, which `draws` compares state for state. */
  scene: number
  /** The glows: ours and retail's draw. */
  glows: number[]
  /** Retail's draws after the effects: spines, the corona's band and fan, then the flare. */
  after?: [number, number, number, number]
}

const COMPARED: Compared[] = [
  { name: 'sun_ahead', scene: 36, glows: [10, 11], after: [40, 41, 42, 43] },
  { name: 'sun_occluded', scene: 82, glows: [10, 11], after: [86, 87, 88, 89] },
  // Its far glows, the fog overlay, then both again burning through it. No corona or flare.
  { name: 'sun_nebula', scene: 39, glows: [10, 11, 13, 14] },
]

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

const load = async (name: SunRun) => {
  const system = systems.get(name)!
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { draws, options } = readSpaceRun(join(references, name), system, RUNS[name])
  const section = readFileSync(join(references, name, 'PerfOptions.ini'), 'latin1')
  const sunEffect = Number(/SunEffect\s*=\s*([\d.]+)/.exec(section)![1])
  const scene = await loadSystem(system, read, options)
  const viewport = { width: 1024, height: 768 }
  // Five seconds at 60 a second: the samples, the intensity and the zone have all settled.
  let frame = collectSpaceFrame({ ...scene, sunEffect, viewport, step: 1 / 60 })
  for (let at = 0; at < 300; at++)
    frame = collectSpaceFrame({ ...scene, sunEffect, viewport, step: 1 / 60 })
  return { frame, retail: draws }
}

interface Vertex {
  p: number[]
  argb: number
  uv: number[]
}

const oursOf = (draw: Draw): Vertex[] => {
  const floats = new Float32Array(draw.mesh.vertices.buffer)
  const bytes = draw.mesh.vertices
  return Array.from({ length: draw.reference.vertexCount }, (_, at) => {
    const [b, g, r, a] = bytes.slice(at * 24 + 12, at * 24 + 16)
    return {
      p: [...floats.slice(at * 6, at * 6 + 3)],
      argb: ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0,
      uv: [...floats.slice(at * 6 + 4, at * 6 + 6)],
    }
  })
}

const theirsOf = ({ vertexData }: CaptureDraw): Vertex[] =>
  vertexData!.map(({ p, d, t0 }) => ({ p, argb: Number(d), uv: t0! }))

/** Each vertex's colour to the byte, UVs to rounding, and place to a few float steps. */
const assertVertices = (ours: Vertex[], theirs: Vertex[], what: string, reach: number) => {
  assert.equal(ours.length, theirs.length, what)
  theirs.forEach(({ p, argb, uv }, at) => {
    const mine = ours[at]!
    const where = `${what}, vertex ${at}`
    assert.equal(mine.argb, argb, where)
    p.forEach((c, axis) => assert.ok(Math.abs(c - mine.p[axis]!) < reach, `${where}: ${p}`))
    uv.forEach((c, axis) => assert.ok(Math.abs(c - mine.uv[axis]!) < 1e-6, where))
  })
}

/** A flare's beads as a set: retail sorts them by heap address, and they add, so order is free. */
const beadsOf = (vertices: Vertex[]) =>
  Array.from({ length: vertices.length / 4 }, (_, quad) => {
    const [a, , c] = [vertices[quad * 4]!, vertices[quad * 4 + 1]!, vertices[quad * 4 + 2]!]
    const round = (value: number) => Math.round(value * 100) / 100
    return [
      round((a.p[0]! + c.p[0]!) / 2),
      round((a.p[1]! + c.p[1]!) / 2),
      round(c.p[0]! - a.p[0]!),
      a.argb,
    ]
  }).sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!)

for (const { name, scene, glows, after } of COMPARED) {
  test(
    `${name}: the scene is retail's draw for draw, glows and all`,
    { skip: skipOf(name) },
    async () => {
      const { frame, retail } = await load(name)
      assert.deepEqual(
        frame.draws.flatMap(({ materialName }, at) => (materialName === 'star glow' ? [at] : [])),
        glows,
      )
      assertFrameMatches(
        { ...frame, draws: frame.draws.slice(0, scene) },
        retail.slice(0, scene),
        indexTextures(data),
        { streamed: true },
      )
    },
  )

  test(`${name}: each glow is retail's, vertex for vertex`, { skip: skipOf(name) }, async () => {
    const { frame, retail } = await load(name)
    for (const n of glows)
      // In world space 40000 out: a few float steps there.
      assertVertices(oursOf(frame.draws[n]!), theirsOf(retail[n]!), `draw ${n}`, 0.005)
  })

  test(
    `${name}: after the effects, its spines, corona and flare are retail's`,
    { skip: skipOf(name) },
    async () => {
      const { frame, retail } = await load(name)
      const textures = indexTextures(data)
      const ours = frame.afterEffects ?? []
      if (!after) {
        // Behind the nebula's zone: all of it faded out.
        assert.equal(ours.length, 0)
        return
      }
      assert.deepEqual(
        ours.map(({ materialName }) => materialName),
        ['spines', 'corona', 'corona', 'lens flare'],
      )
      after.forEach((n, at) => {
        const theirs = retail[n]!
        const mine = ours[at]!
        const what = `draw ${n}, ${mine.materialName}`
        const { states, stages, world } = theirs
        // Win3D's screen pixels: added by alpha, no depth, the alpha test the frame left.
        assert.deepEqual(
          [
            'ZENABLE',
            'ZWRITEENABLE',
            'CULLMODE',
            'LIGHTING',
            'FOGENABLE',
            'SRCBLEND',
            'DESTBLEND',
          ].map((key) => states[key]),
          [0, 1, 1, 0, 0, 5, 2],
          what,
        )
        assert.deepEqual(
          [states['ALPHATESTENABLE'], states['ALPHAFUNC'], states['ALPHAREF']],
          [1, 5, mine.alphaReference],
          what,
        )
        assert.deepEqual(
          [mine.depthFunc, mine.depthWrite, mine.blendMode],
          ['always', true, 'alphaAdd'],
        )
        const names = namesOf(textures, stages[0]!.texture!).map(({ name }) => name)
        assert.ok(names.includes(mine.texture!.name), `${what}: ${names}`)
        assert.deepEqual(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1], what)
        const vertices = theirsOf(theirs)
        if (mine.materialName === 'lens flare')
          assert.deepEqual(beadsOf(oursOf(mine)), beadsOf(vertices), what)
        // Screen pixels: well inside a thousandth.
        else assertVertices(oursOf(mine), vertices, what, 1e-3)
      })
    },
  )
}
