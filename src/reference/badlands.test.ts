/**
 * `asteroid_badlands`: the lab field with the Badlands' `[DynamicAsteroids]`, whose rocks each trail
 * `gf_blsmallasteroid`, from inside it, against retail. Places and particles are the game's
 * `rand()`, so they're compared in kind; what follows from a rock's place, its fade, whether its
 * effect is seen, and where that draws, rock by rock.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { SpriteDraw } from '#/alchemy/draw.js'
import { indexTextures, namesOf } from '#/capture/texture-names.js'
import { viewMatrix } from '#/scene/camera.js'
import { effectTypeIndex, viewEffect } from '#/scene/effect-view.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const name = 'asteroid_badlands'

// The field's 37 cubes from 87, its ten rocks, then four rocks' effects of three draws each, then
// the engine's four.
const ROCKS = 124
const COUNT = 10
const EFFECTS = ROCKS + COUNT
const TRIPLES = 4
const APPEARANCES = ['smokecard', 'planetflare', 'lightningaxm_0_0']

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
  // Ten seconds on, long enough for the rocks to have been placed afresh and their trails filled.
  let frame = collectSpaceFrame(scene)
  for (let at = 0; at < 600; at++) frame = collectSpaceFrame({ ...scene, step: 1 / 60 })

  const rocks = scene.asteroids!.find(({ dynamic }) => dynamic)!.dynamic![0]!.rocks

  return { scene, frame, rocks, camera: options.camera, captured: draws }
}

/** A captured draw's place in the world: its world is the view's, which looks down -Z. */
const placeOf = (world: readonly number[], eye: Vector3): Vector3 => ({
  x: eye.x + world[12]!,
  y: eye.y + world[13]!,
  z: eye.z - world[14]!,
})

test(`${name} is retail draw for draw up to the rocks, then ten rocks`, { skip }, async () => {
  const { frame, captured } = await load()

  assert.deepEqual(frame.unsupported, ['texture envmapglass'])
  assert.equal(frame.draws.length, ROCKS + COUNT)
  assertFrameMatches(
    { ...frame, draws: frame.draws.slice(0, ROCKS) },
    captured.slice(0, ROCKS),
    indexTextures(data),
    { streamed: true },
  )
  assert.ok(frame.draws.slice(ROCKS).every(({ materialName }) => /badlands/i.test(materialName)))
})

test(`${name}: each rock fades as ours would at retail's place`, { skip }, async () => {
  const { rocks, camera, captured } = await load()
  let blended = 0

  for (const [at, { world, material, states }] of captured.slice(ROCKS, EFFECTS).entries()) {
    const alpha = rocks.alphaAt(camera, placeOf(world!, camera.position))!

    assert.ok(Math.abs(alpha - material!.diffuse[3]!) < 1e-4, `rock ${at}: ${alpha}`)

    const blend = alpha < 1
    if (blend) blended++
    assert.equal(states['ALPHABLENDENABLE'], blend ? 1 : 0)
    assert.equal(states['ALPHAREF'], blend ? 5 : 127)
  }

  assert.equal(blended, 8)
})

test(
  `${name}: the rocks whose effects are seen are retail's, each drawn at its rock`,
  { skip },
  async () => {
    const { scene, rocks, camera, captured } = await load()
    const index = indexTextures(data)
    const debris = effectTypeIndex('EFT_DEBRIS_TRAIL')!
    const view = viewMatrix(camera)
    const rockDraws = captured.slice(ROCKS, EFFECTS)
    const translation = (world: readonly number[]) => world.slice(12, 15)
    const rockAt = (world: readonly number[]) =>
      rockDraws.findIndex((rock) =>
        translation(rock.world!).every((cell, k) => Math.abs(cell - world[12 + k]!) < 1e-3),
      )
    const carried: number[] = []

    for (let k = 0; k < TRIPLES; k++) {
      const triple = captured.slice(EFFECTS + k * 3, EFFECTS + k * 3 + 3)

      triple.forEach(({ stages, states }, at) => {
        const what = `effect ${k} draw ${at}`
        const names = namesOf(index, stages[0]!.texture!).map(({ name }) => name.toLowerCase())

        assert.ok(names.includes(APPEARANCES[at]!.toLowerCase()), `${what}: ${names}`)
        // Additive over their alpha, `ZFUNC` 4, no depth writes (`SpaceEffectsDrawFrame`).
        assert.deepEqual([states['SRCBLEND'], states['DESTBLEND']], [5, 2], what)
        assert.equal(states['ZFUNC'], 4, what)
        assert.equal(states['ZWRITEENABLE'], 0, what)
      })

      // The flare and the lightning in their rock's frame, turned as it is.
      const [smoke, flare, lightning] = triple as [
        (typeof triple)[number],
        (typeof triple)[number],
        (typeof triple)[number],
      ]
      const rock = rockAt(flare.world!)

      assert.ok(rock >= 0, `effect ${k} on no rock`)
      carried.push(rock)

      const turned = rockDraws[rock]!.world!

      for (const cells of [flare.world!, lightning.world!])
        for (const cell of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14])
          assert.ok(Math.abs(cells[cell]! - turned[cell]!) < 1e-3, `effect ${k} cell ${cell}`)

      // The smoke left behind in the world, its newest puff at the rock.
      assert.deepEqual(
        [0, 5, 10, 12, 13, 14].map((cell) => smoke.world![cell]),
        [1, 1, -1, 0, 0, 0],
      )

      // Under the mirror its vertices are the view's with z negated.
      const [x, y, z] = translation(turned) as [number, number, number]
      const nearest = Math.min(
        ...smoke.vertexData!.map(({ p }) => Math.hypot(p[0]! - x, p[1]! - y, p[2]! + z)),
      )

      assert.ok(nearest < 10, `effect ${k}: smoke ${nearest} from its rock`)
    }

    // Our view test at retail's places sees just those, each running unseen otherwise.
    const fates = rockDraws.map(({ world }) => {
      const position = placeOf(world!, camera.position)

      return viewEffect(
        { type: debris, position, watched: { position } },
        { camera, aspect: scene.aspect, view, nebulae: [] },
        scene.effectView,
      ).fate
    })

    assert.deepEqual(
      fates.flatMap((fate, at) => (fate === 'draw' ? [at] : [])),
      [...carried].sort((a, b) => a - b),
    )
    assert.ok(fates.every((fate) => fate !== 'die'))
    // Walked newest first: retail's order is no rock's slot order.
    assert.deepEqual(carried, [9, 1, 6, 3])
    assert.ok(rocks.effects().length > 0)
  },
)

test(
  `${name}: ours draw in kind, each seen rock's three at it, before the engine's`,
  { skip },
  async () => {
    const { frame, rocks, captured } = await load()
    const placed = rocks.draws().map(({ world }) => Matrix4.multiply(frame.view, world).w)
    const engine = frame.effects.findIndex(({ texture }) => texture?.name === 'kioncanring') - 1
    const ours = frame.effects.slice(0, engine)

    assert.ok(ours.length > 0 && ours.length % 3 === 0, `${ours.length} rock effect draws`)

    const particles = (n: number) => captured[n]!.primitives! / 2
    const retail = Array.from({ length: TRIPLES * 3 }, (_, at) => particles(EFFECTS + at))

    for (let k = 0; k < ours.length; k += 3) {
      const triple = ours.slice(k, k + 3) as SpriteDraw[]

      assert.deepEqual(
        triple.map(({ texture }) => texture?.name),
        APPEARANCES,
      )
      for (const { blend } of triple) assert.deepEqual([blend?.source, blend?.target], [5, 2])

      const at = Matrix4.multiply(frame.view, triple[1]!.world).w

      assert.ok(
        placed.some((p) => Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) < 1e-3),
        `triple ${k / 3} at no rock`,
      )
      // As many particles as retail's run, give or take a half.
      triple.forEach(({ lane }, a) => {
        const theirs = retail.filter((_, n) => n % 3 === a)
        const [low, high] = [Math.min(...theirs), Math.max(...theirs)]

        assert.ok(
          lane.count >= low / 2 && lane.count <= high * 1.5,
          `${APPEARANCES[a]} ${lane.count}`,
        )
      })
    }
  },
)
