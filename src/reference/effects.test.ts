/** The generated effects, as the game gets them, and each against retail's capture when there is one. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, readAlchemy, writeAlchemy, type Node } from '@treewyrm/freelancer/alchemy'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { Directory } from '@treewyrm/freelancer/utf'
import { collectEffect, type EffectDraw, type SpriteDraw } from '#/alchemy/draw.js'
import { EffectInstance } from '#/alchemy/effect.js'
import { buildEffect, lookupOver } from '#/alchemy/tree.js'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { GENERATED_EFFECTS, type GeneratedEffect } from './effects.js'
import { sceneScript } from './scene.js'
import { scenes } from './scenes.js'

const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const logOf = (name: string) => join(references, name, 'd3d8log.jsonl')
const skipFor = (name: string) => (existsSync(logOf(name)) ? false : `no ${name} capture`)

/** As the game reads them: through the file. */
const run = (kind: GeneratedEffect, seconds: number) => {
  const bytes = new Directory('\\', writeAlchemy(GENERATED_EFFECTS[kind]())).write()
  const alchemy = readAlchemy(Directory.read(bytes))!
  const nodes = new Map<number, Node>()

  for (const node of alchemy.nodes.nodes)
    nodes.set(getResourceId(getNodeName(node) ?? '', true), node)

  const scene = buildEffect(alchemy.effects.effects[0]!, (crc) => nodes.get(crc))

  assert.deepEqual(
    scene.nodes.flatMap((node) => node.missing ?? []),
    [],
  )

  const resolve = (crc: number) => nodes.get(crc)
  const instance = new EffectInstance(scene, {
    lookup: lookupOver(alchemy.effects.effects, resolve),
  })
  const view = Matrix4.translation({ x: 0, y: 0, z: -60 })
  for (let step = 0; step < seconds * 60; step++) instance.advance(1 / 60, { view })

  const draws: EffectDraw[] = []

  collectEffect(
    instance,
    Matrix4.translation({ x: 0, y: 0, z: -60 }),
    () => undefined,
    draws,
    new Set(),
  )
  return { instance, draws }
}

// Position, diffuse and one UV, with no Z writes: the mouse cursor shares the format, and writes.
const lit = ({ fvf, states }: CaptureDraw) => fvf === 0x142 && states['ZWRITEENABLE'] === 0

const effectDraws = (name: string) => {
  const capture = readCapture(readFileSync(logOf(name), 'utf8'))

  return capture.frames.at(-1)!.events.filter((e): e is CaptureDraw => e.kind === 'draw' && lit(e))
}

test('a scene plays its effect through a PSYS naming the lab VisEffect', () => {
  const script = sceneScript(scenes.get('effect_folder')!)

  assert.match(script, /template_name\s*=\s*"lab_folder"/)
  assert.match(script, /START_PSYS/)
})

test('sprites: one draw per appearance, the one of two an emitter feeds, in tree order', () => {
  const { draws } = run('sprites', 0.1)

  assert.equal(draws.length, 10)

  const last = draws.at(-1) as SpriteDraw

  // The second of the pair, whose colour is green.
  assert.equal(last.lists.color?.keyframes[0]?.keyframes[0]?.value.y, 1)
  assert.equal(last.lists.color?.keyframes[0]?.keyframes[0]?.value.x, 0)
})

test('folder: both before its clock, and only the control beside the root after', () => {
  assert.equal(run('folder', 4).draws.length, 2)

  const { draws, instance } = run('folder', 6)

  assert.equal(draws.length, 1)
  assert.equal(instance.finished, false)
})

test('motion: a streak, a stretched rect and a beam', () => {
  const { draws } = run('motion', 2)

  assert.deepEqual(
    draws.map(({ type }) => type),
    ['sprite', 'sprite', 'triangles', 'sprite'],
  )
})

/** `p * W * V`, in the game's view space, whichever space the routine built it in. */
const viewSpace = (draw: CaptureDraw) => {
  const apply = (m: number[], [x, y, z]: number[]) => [
    x! * m[0]! + y! * m[4]! + z! * m[8]! + m[12]!,
    x! * m[1]! + y! * m[5]! + z! * m[9]! + m[13]!,
    x! * m[2]! + y! * m[6]! + z! * m[10]! + m[14]!,
  ]

  // D3D's left-handed view is the game's with Z negated, carried in its world matrix.
  return draw.vertexData!.map(({ p, t0 }) => {
    const [x, y, z] = apply(draw.view!, apply(draw.world!, p))

    return { at: [x!, y!, -z!], uv: t0! }
  })
}

const assertCorners = (
  draw: CaptureDraw,
  expected: { at: number[]; uv: number[] }[],
  what: string,
) => {
  const got = viewSpace(draw)

  assert.equal(got.length, expected.length, what)

  for (const corner of expected) {
    const found = got.find(({ at }) => at.every((c, i) => Math.abs(c - corner.at[i]!) < 1e-2))

    assert.ok(found, `${what}: no corner at ${corner.at}, among ${JSON.stringify(got)}`)
    assert.deepEqual(
      found.uv.map((c) => Number(c.toFixed(3))),
      corner.uv,
      `${what} at ${corner.at}`,
    )
  }
}

/** ± x and ± y about a view-space centre, with (-1, 1) at (u1, v1) and (1, -1) at (u2, v2). */
const quad = (c: number[], x: number[], y: number[]) =>
  [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ].map(([i, j]) => ({
    at: c.map((value, axis) => value + i! * x[axis]! + j! * y[axis]!),
    uv: [i! < 0 ? 0 : 1, j! > 0 ? 0 : 1],
  }))

const cell = (at: number) => [-6 + (at % 5) * 8, 14 - Math.floor(at / 5) * 8, -60]

test(
  "effect_sprites matches retail: draws, states, and each routine's corners",
  { skip: skipFor('effect_sprites') },
  () => {
    const draws = effectDraws('effect_sprites')

    assert.equal(draws.length, 10)

    for (const { stages } of draws) {
      // Clamped, and modulated: the texture by the vertex colour.
      assert.equal(stages[0]!.states['ADDRESSU'], 3)
      assert.equal(stages[0]!.states['ADDRESSV'], 3)
      assert.equal(stages[0]!.states['COLOROP'], 4)
      assert.equal(stages[0]!.states['ALPHAOP'], 4)
    }

    for (const { states } of draws) {
      assert.equal(states['ZWRITEENABLE'], 0)
      assert.equal(states['CULLMODE'], 1)
      assert.equal(states['LIGHTING'], 0)
      assert.equal(states['SRCBLEND'], 5)
      assert.equal(states['DESTBLEND'], 2)
      assert.equal(states['ALPHATESTENABLE'], 1)
      assert.equal(states['ALPHAFUNC'], 5)
      assert.equal(states['ALPHAREF'], 0)
    }

    assertCorners(draws[0]!, quad(cell(0), [3, 0, 0], [0, 3, 0]), 'quad')

    // A roll of 0.5, and an aspect of a half on the horizontal.
    const [c, s] = [Math.cos(0.5), Math.sin(0.5)]

    assertCorners(draws[1]!, quad(cell(1), [c * 1.5, -s * 1.5, 0], [s * 3, c * 3, 0]), 'rolled')
    assertCorners(
      draws[4]!,
      quad(cell(4), [3, 0, 0], [0, 3, 0]).map(({ at, uv }) => ({
        at,
        uv: [1 - uv[0]!, 1 - uv[1]!],
      })),
      'flip',
    )

    // Equilateral, apex at 2S and base √3·S either side: retail's, not the decomp's. Centred UVs, then mapped.
    const triangle = (at: number, uvs: number[][]) =>
      [
        [Math.sqrt(3) * 3, -3],
        [-Math.sqrt(3) * 3, -3],
        [0, 6],
      ].map(([x, y], corner) => ({
        at: [cell(at)[0]! + x!, cell(at)[1]! + y!, -60],
        uv: uvs[corner]!,
      }))

    assertCorners(
      draws[2]!,
      triangle(2, [
        [1, 1],
        [0, 1],
        [0.5, 0],
      ]),
      'triangle',
    )
    assertCorners(
      draws[3]!,
      triangle(3, [
        [1, 1],
        [0, 0],
        [0, 1],
      ]),
      'tri texture',
    )

    // Along +Y from a trailing edge, or centred, turned about it to the eye, whose offset is the cell's.
    const rect = (at: number, from: number, to: number) => {
      const [x, y] = cell(at)
      const side = Math.hypot(x!, 60)
      const across = [(1 * 60) / side, 0, (1 * x!) / side]

      return [
        [1, to, 1, 0],
        [-1, to, 0, 0],
        [1, from, 1, 1],
        [-1, from, 0, 1],
      ].map(([sign, along, u, v]) => ({
        at: [x! + sign! * across[0]!, y! + along!, -60 + sign! * across[2]!],
        uv: [u!, v!],
      }))
    }

    // The particle has drifted a few thousandths, and the fast length runs the heading long.
    assertCorners(draws[6]!, rect(6, 0, 6), 'rect')
    assertCorners(draws[7]!, rect(7, -3, 3), 'rect centred')
    // `_ftol(1.5 × 255)`, low byte, over the packed colour.
    assert.equal(Number(draws[5]!.vertexData![0]!.d) >>> 24, 126)

    // Perp, turned at the camera: +X across, -n is +Y.
    const facing = cell(8)

    assertCorners(draws[8]!, quad(facing, [3, 0, 0], [0, 3, 0]), 'perp')

    // The second of two: green only.
    const packed = Number(draws[9]!.vertexData![0]!.d)

    assert.equal((packed >>> 16) & 0xff, 0)
    assert.equal((packed >>> 8) & 0xff, 255)
  },
)

test(
  'effect_folder matches retail: both drawn early, control first, and past five seconds only it',
  { skip: skipFor('effect_folder') },
  () => {
    const capture = readCapture(readFileSync(logOf('effect_folder'), 'utf8'))
    const early = capture.frames[0]!.events.filter(
      (e): e is CaptureDraw => e.kind === 'draw' && lit(e),
    )

    assert.equal(early.length, 2)
    assert.ok(viewSpace(early[0]!)[0]!.at[0]! > 2, 'beside the root draws before what is under it')
    assert.ok(viewSpace(early[1]!)[0]!.at[0]! < 2)

    const draws = effectDraws('effect_folder')

    assert.equal(draws.length, 1)

    const [x] = viewSpace(draws[0]!)[0]!.at

    assert.ok(x! > 2, `the one left is at x = ${x}`)
  },
)

test(
  "effect_motion matches retail: the streak's and the rect's length, by shape",
  { skip: skipFor('effect_motion') },
  () => {
    const draws = effectDraws('effect_motion')

    // The newest of each, whose end is furthest on: head and tail by its first four corners.
    const ends = (draw: CaptureDraw) => {
      const corners = viewSpace(draw).slice(0, 4)
      const ys = corners.map(({ at }) => at[1]!)

      return {
        top: Math.max(...ys),
        bottom: Math.min(...ys),
        x: corners.reduce((sum, { at }) => sum + at[0]!, 0) / 4,
      }
    }

    // `0x62168a4`: Size past each end, a thirtieth of its motion between, along it as seen off-axis.
    const blur = ends(draws[0]!)
    const c = [blur.x, blur.top - 3, -60]
    const v = [0, 30, 0]
    const cross = (a: number[], b: number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ]
    const w = cross(cross(c, v), c)
    const length = Math.hypot(...w)
    const unit = w.map((value) => value / length)
    const along = (unit[1]! * (v[1]! * unit[1]!)) / 30

    assert.ok(
      Math.abs(blur.top - blur.bottom - (6 * unit[1]! + along)) < 0.05,
      `${JSON.stringify(blur)}`,
    )

    // Length 2, and `|v| / 30` of it: 2 + 1.
    const rect = ends(draws[1]!)

    assert.ok(Math.abs(rect.top - rect.bottom - 3) < 0.05, `${JSON.stringify(rect)}`)

    // Five verts a point, and four triangles a sheet a segment.
    const beam = draws[2]!

    assert.equal((beam.vertices / 5 - 1 + 1) * 5, beam.vertices)
    assert.equal(beam.primitives, ((beam.vertices - 4) / 5) * 8)
    // A segment's centre takes (0.5, 0.5).
    assert.deepEqual(beam.vertexData![8]!.t0, [0.5, 0.5])

    // A perp leaving along +X: its roll starts from +Z, so u runs along Z, and v1 is towards -Y.
    const corners = viewSpace(draws.at(-1)!)
    const centre = [0, 1, 2].map((axis) => corners.reduce((sum, { at }) => sum + at[axis]!, 0) / 4)

    assertCorners(draws.at(-1)!, quad(centre, [0, 0, 3], [0, -3, 0]), 'perp along +X')
  },
)

const centreOf = (draw: CaptureDraw, from = 0, count = draw.vertexData!.length) => {
  const corners = viewSpace(draw).slice(from, from + count)

  return [0, 1, 2].map((axis) => corners.reduce((sum, { at }) => sum + at[axis]!, 0) / count)
}

const near = (got: number[], want: number[], tolerance = 0.02) =>
  got.every((value, axis) => Math.abs(value - want[axis]!) < tolerance)

test('beams, by the library, without a capture: an odd and an even chain, and the anchors', () => {
  const { draws } = run('beams', 0.1)

  assert.deepEqual(
    draws.map(({ type }) => type),
    ['triangles', 'triangles', 'triangles', 'triangles', 'triangles'],
  )
})

test(
  "effect_beams matches retail: every vertex of every chain is the library's",
  { skip: skipFor('effect_beams') },
  () => {
    const captured = effectDraws('effect_beams')
    const { draws } = run('beams', 0.1)

    assert.equal(captured.length, draws.length)
    captured.forEach((draw, at) => {
      const ours = draws[at]!

      assert.equal(ours.type, 'triangles')
      if (ours.type !== 'triangles') return

      const seen = new Set<string>()
      const mine: { p: number[]; uv: number[] }[] = []

      for (let i = 0; i < ours.count; i++) {
        const v = [...ours.vertices.subarray(i * 9, i * 9 + 9)]
        const key = v.map((c) => c.toFixed(3)).join()
        if (seen.has(key)) continue
        seen.add(key)
        mine.push({ p: v.slice(0, 3), uv: v.slice(7, 9) })
      }

      const what = `chain ${at}`
      // Two segments of a chain doubling back can share a centre, which retail writes twice.
      const theirs = new Set(
        draw.vertexData!.map(({ p, t0 }) => [...p, ...t0!].map((c) => c.toFixed(3)).join()),
      )

      assert.equal(theirs.size, mine.length, what)
      assert.equal(draw.primitives, ours.count / 3, what)

      for (const { p, t0 } of draw.vertexData!)
        assert.ok(
          mine.some((one) => near(one.p, p, 0.01) && near(one.uv, t0!, 0.001)),
          `${what}: ${p} ${t0} among ${JSON.stringify(mine)}`,
        )
    })
  },
)

test('child, by the library: a parent places, turns and outlives its sub-effects', () => {
  const { draws } = run('child', 5)

  assert.equal(draws.length, 4)
  assert.deepEqual(
    draws.map((draw) => (draw as SpriteDraw).lane.count),
    [1, 1, 1, 1],
  )
})

test(
  'effect_child matches retail: placed, turned onto the velocity, and started at a death',
  { skip: skipFor('effect_child') },
  () => {
    const draws = effectDraws('effect_child')

    assert.equal(draws.length, 4)

    const want = [
      [-4, 13, -60],
      [13, 10, -60],
      [24, 5, -60],
      [24, 2, -60],
    ]

    draws.forEach((draw, at) =>
      assert.ok(near(centreOf(draw), want[at]!, 0.05), `${at}: ${centreOf(draw)}`),
    )
    // The death effect, in green.
    assert.equal((Number(draws[3]!.vertexData![0]!.d) >>> 8) & 0xff, 255)
    assert.equal((Number(draws[3]!.vertexData![0]!.d) >>> 16) & 0xff, 0)
  },
)

test('oriented, by the library: the keyed one goes by the CPU, the others by the vertex stage', () => {
  const { draws } = run('oriented', 0.1)

  assert.deepEqual(
    draws.map(({ type }) => type),
    ['sprite', 'sprite', 'triangles'],
  )

  const keyed = draws[2]!
  if (keyed.type !== 'triangles') return

  const r = Math.SQRT1_2

  // Corner (-1, 1): about (19, 12), along the matrix's columns, width 3 and height 2.
  assert.ok(
    near([...keyed.vertices.subarray(0, 2)], [19 - 3 * r - 2 * r, 12 - 3 * r + 2 * r], 1e-3),
  )
})

test(
  'effect_oriented matches retail: the frame, and the transform keyed per particle',
  { skip: skipFor('effect_oriented') },
  () => {
    const draws = effectDraws('effect_oriented')

    assert.equal(draws.length, 3)
    assertCorners(draws[0]!, quad([-6, 10, -60], [3, 0, 0], [0, 2, 0]), 'flat')

    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]

    assertCorners(draws[1]!, quad([6, 10, -60], [3 * c, 3 * s, 0], [-2 * s, 2 * c, 0]), 'framed')

    const r = Math.SQRT1_2

    assertCorners(draws[2]!, quad([19, 12, -60], [3 * r, 3 * r, 0], [-2 * r, 2 * r, 0]), 'keyed')
  },
)

test('fields, by the library: alpha by depth through a dust sphere, and the one outside gone', () => {
  const { draws } = run('fields', 2)
  const aged = draws[0] as SpriteDraw

  assert.equal(aged.lane.count, 4)
})

test(
  "effect_fields matches retail: a dust field's age by depth, and an air field's velocity",
  { skip: skipFor('effect_fields') },
  () => {
    const draws = effectDraws('effect_fields')

    assert.equal(draws.length, 2)

    const [aged, blown] = [draws[0]!, draws[1]!]

    assert.equal(aged.vertexData!.length, 16)

    // Depth through the sphere, then a step's ageing: 10 × depth × fade, over a life of 10.
    const bytes = [0, 4, 8, 12].map((at) => Number(aged.vertexData![at]!.d) >>> 24)
    ;[0.25, 0.5, 0.75, 0.1 * 0.55].forEach((alpha, at) =>
      assert.ok(Math.abs(bytes[at]! - alpha * 255) < 2, `${bytes}`),
    )

    // Along the field's turned +Y, which is +X: 2 long, and `|v| / 30` of 30.
    const corners = viewSpace(blown).slice(0, 4)
    const xs = corners.map(({ at }) => at[0]!)

    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 3) < 0.1, `${xs}`)
  },
)

test("pool, by the library: the second appearance evicts the first's oldest", () => {
  const { draws } = run('pool', 0.1)

  assert.deepEqual(
    draws.map((draw) => (draw as SpriteDraw).lane.count),
    [900, 100],
  )
})

test(
  'effect_pool matches retail: a full pool evicts across appearances',
  { skip: skipFor('effect_pool') },
  () => {
    const draws = effectDraws('effect_pool')

    assert.deepEqual(
      draws.map(({ primitives }) => primitives),
      [1800, 200],
    )
  },
)

test('dust under a THN host: the zero-length pass after each tick leaves it nothing to draw', () => {
  const { instance, draws } = run('dust', 1)

  assert.equal(draws.length, 1)
  instance.advance(0)

  const after: EffectDraw[] = []

  collectEffect(
    instance,
    Matrix4.translation({ x: 0, y: 0, z: -60 }),
    () => undefined,
    after,
    new Set(),
  )
  assert.deepEqual(after, [])
})

test(
  'effect_dust matches retail: no dust at all, its speed being a distance over a step of 0',
  { skip: skipFor('effect_dust') },
  () => assert.deepEqual(effectDraws('effect_dust'), []),
)
