import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { collectEffect, type EffectDraw, type SpriteDraw } from './draw.js'
import {
  AGE,
  AXIS,
  createPools,
  EffectInstance,
  RECORD,
  RETAIL_POOLS,
  VELOCITY,
  type AppearanceNode,
} from './effect.js'
import { basic, emitter, flat, node, sceneOf } from './fixtures.js'
import { describeNode } from './nodes.js'

const STEP = 1 / 60

const run = (instance: EffectInstance, seconds: number, dt = STEP) => {
  for (let n = 0; n < Math.round(seconds / dt); n++) instance.advance(dt)
}

const drawsOf = (instance: EffectInstance): EffectDraw[] => {
  const draws: EffectDraw[] = []
  collectEffect(instance, Matrix4.identity, () => undefined, draws, new Set())
  return draws
}

const appearance = (instance: EffectInstance, at = 0) => {
  const list: AppearanceNode[] = []
  const visit = (one: (typeof instance.top)[number]) => {
    if (one.descriptor?.category === 'appearance') list.push(one as AppearanceNode)
    one.children.forEach(visit)
  }
  instance.top.forEach(visit)
  return list[at]!
}

test('a frame emits the truncated count and drops the fraction, so the rate follows the frame rate', () => {
  const at = (dt: number) => {
    const { scene } = sceneOf([
      { node: basic('a') },
      { node: emitter('e', { Emitter_Frequency: flat(100) }), targets: ['a'] },
    ])
    const instance = new EffectInstance(scene)
    run(instance, 1, dt)
    return appearance(instance).lane!.count
  }
  // `0x6245cc0`: 100 a second at 60 Hz is one a frame.
  assert.equal(at(1 / 60), 60)
  assert.equal(at(1 / 30), 90)
})

test('an emitter past its life stops, and what it made lives out its own span', () => {
  const { scene } = sceneOf([
    { node: basic('a') },
    { node: emitter('e', { Node_LifeSpan: 0.5, Emitter_InitLifeSpan: flat(2) }), targets: ['a'] },
  ])
  const instance = new EffectInstance(scene)
  run(instance, 1)
  const lane = appearance(instance).lane!
  assert.ok(lane.count >= 29 && lane.count <= 31, `${lane.count}`)
  assert.equal(instance.top.length, 1)
  run(instance, 2)
  assert.equal(lane.count, 0)
})

test('an appearance never checks its own Node_LifeSpan: only having nothing does it in', () => {
  const { scene } = sceneOf([
    { node: basic('a', { Node_LifeSpan: 0.1 }) },
    { node: emitter('e'), targets: ['a'] },
  ])
  const instance = new EffectInstance(scene)
  run(instance, 1)
  assert.equal(appearance(instance).dead, false)
  assert.ok(appearance(instance).lane!.count > 50)
})

test('a folder past the longest life below it takes all of it along, particles included', () => {
  const { scene } = sceneOf([
    {
      root: true,
      children: [
        { node: basic('a', { Node_LifeSpan: 1 }) },
        {
          node: emitter('e', { Node_LifeSpan: 1, Emitter_InitLifeSpan: flat(100) }),
          targets: ['a'],
        },
      ],
    },
  ])
  const instance = new EffectInstance(scene)
  run(instance, 0.9)
  assert.equal(instance.finished, false)
  assert.ok(appearance(instance).lane!.count > 40)
  run(instance, 0.2)
  assert.equal(instance.finished, true)
  assert.deepEqual(drawsOf(instance), [])
})

test('an emitter naming two appearances draws through the later one', () => {
  const { scene } = sceneOf([
    { node: basic('first') },
    { node: basic('second') },
    { node: emitter('e'), targets: ['first', 'second'] },
  ])
  const instance = new EffectInstance(scene)
  run(instance, 0.5)
  assert.equal(appearance(instance, 0).lane!.count, 0)
  assert.ok(appearance(instance, 1).lane!.count > 20)
})

test('an appearance updates before a sibling field, so it reads the field a frame late', () => {
  const { scene } = sceneOf([
    { node: basic('a'), targets: ['g'] },
    {
      node: node('g', 'FxGravityField', {
        Node_LifeSpan: Infinity,
        GravityField_Gravity: flat(60),
      }),
    },
    {
      node: emitter('e', { Emitter_Frequency: flat(0), Emitter_InitialParticles: 1 }),
      targets: ['a'],
    },
  ])
  const instance = new EffectInstance(scene)
  const speed = () => appearance(instance).lane!.records[VELOCITY + 1]!
  instance.advance(STEP)
  assert.equal(speed(), 0)
  instance.advance(STEP)
  // `-Gravity × dt` from the field's last update: 60 × 1/60.
  assert.ok(Math.abs(speed() + 1) < 1e-5, `${speed()}`)
})

test('a dust field of no radius kills everything, and one with room writes the age by depth', () => {
  const particles = (radius: number) => {
    const { scene } = sceneOf([
      { node: basic('a'), targets: ['d'] },
      {
        node: node('d', 'FLDustField', {
          Node_LifeSpan: Infinity,
          SphereEmitter_MaxRadius: flat(radius),
        }),
      },
      {
        node: emitter('e', {
          Emitter_Frequency: flat(0),
          Emitter_InitialParticles: 1,
          ConeEmitter_MinRadius: flat(1),
          ConeEmitter_MaxRadius: flat(1),
        }),
        targets: ['a'],
      },
    ])
    const instance = new EffectInstance(scene)
    run(instance, 3 * STEP)
    return appearance(instance).lane!
  }
  assert.equal(particles(0).count, 0)
  const lane = particles(4)
  assert.equal(lane.count, 1)
  // Depth (R + z) / 2R of the sphere at z = 0, times 10, and one step's ageing.
  assert.ok(Math.abs(lane.records[AGE]! - (5 + STEP)) < 1e-5, `${lane.records[AGE]}`)
})

test('a full pool evicts its oldest, whichever effect holds it', () => {
  const pools = createPools(0, { ...RETAIL_POOLS, 'basic-appearance': 10 })
  const make = () =>
    new EffectInstance(
      sceneOf([{ node: basic('a') }, { node: emitter('e'), targets: ['a'] }]).scene,
      { pools },
    )
  const older = make()
  run(older, 8 * STEP)
  const newer = make()
  run(newer, 6 * STEP)
  const count = (instance: EffectInstance) => appearance(instance).lane!.count
  assert.equal(count(newer), 6)
  assert.equal(count(older), 4)
})

test('a perp takes its roll from +X, or +Z when it leaves along +X', () => {
  const seeded = (rotation: Record<string, unknown>) => {
    const { scene } = sceneOf([
      { node: node('a', 'FxPerpAppearance', { Node_LifeSpan: Infinity }) },
      {
        node: emitter('e', {
          Emitter_Frequency: flat(0),
          Emitter_InitialParticles: 1,
          Emitter_Pressure: flat(1),
          ...rotation,
        }),
        targets: ['a'],
      },
    ])
    const instance = new EffectInstance(scene)
    instance.advance(STEP)
    const { records } = appearance(instance).lane!
    return [...records.subarray(AXIS, AXIS + 3)]
  }
  assert.deepEqual(seeded({}), [1, 0, 0])
})

test('a stopped effect stops emitting and finishes when what it made has gone', () => {
  const { scene } = sceneOf([
    { node: basic('a') },
    { node: emitter('e', { Emitter_InitLifeSpan: flat(0.5) }), targets: ['a'] },
  ])
  const instance = new EffectInstance(scene)
  run(instance, 0.5)
  instance.stop()
  assert.equal(instance.finished, false)
  run(instance, 0.6)
  assert.equal(instance.finished, true)
})

test('draws walk the tree: an appearance beside the root before everything under it', () => {
  const { scene } = sceneOf([
    {
      root: true,
      children: [
        { node: emitter('e1'), targets: ['under'] },
        { node: basic('under', { BasicApp_Size: undefined }) },
      ],
    },
    { node: emitter('e2'), targets: ['beside'] },
    { node: basic('beside') },
  ])
  const instance = new EffectInstance(scene)
  run(instance, 0.1)
  const draws = drawsOf(instance) as SpriteDraw[]
  assert.equal(draws.length, 2)
  assert.equal(draws[0]!.lane, appearance(instance, 0).lane)
  assert.equal(appearance(instance, 0).descriptor.name, 'beside')
})

test('a sub-effect hangs off its spawner, moves with its particle, and stops at its death', () => {
  const child = sceneOf([
    {
      root: true,
      children: [
        { node: basic('ca') },
        { node: emitter('ce', { Emitter_InitLifeSpan: flat(0.1) }), targets: ['ca'] },
      ],
    },
  ]).scene
  const { scene } = sceneOf([
    {
      node: node('p', 'FxParticleAppearance', {
        Node_LifeSpan: Infinity,
        ParticleApp_LifeName: 'child',
      }),
    },
    {
      node: emitter('e', {
        Emitter_Frequency: flat(0),
        Emitter_InitialParticles: 1,
        Emitter_InitLifeSpan: flat(0.5),
        Emitter_Pressure: flat(60),
      }),
      targets: ['p'],
    },
  ])
  const instance = new EffectInstance(scene, { lookup: () => child })
  run(instance, 0.25)
  const spawner = appearance(instance)
  assert.equal(spawner.records!.length, 1)
  assert.ok(appearance(instance, 1).lane!.count > 0)
  const root = spawner.children.find((one) => one.key === 400)!
  assert.ok(root.world.w.y > 10, `${root.world.w.y}`)
  run(instance, 1)
  assert.equal(spawner.records!.length, 0)
})

test('a life effect no library names means no particle', () => {
  const { scene } = sceneOf([
    {
      node: node('p', 'FxParticleAppearance', {
        Node_LifeSpan: Infinity,
        ParticleApp_LifeName: 'nothing',
      }),
    },
    { node: emitter('e'), targets: ['p'] },
  ])
  const instance = new EffectInstance(scene, { lookup: () => undefined })
  run(instance, 0.5)
  assert.equal(appearance(instance).records!.length, 0)
})

const moving = (seconds: number) => Matrix4.translation({ x: 0, y: 0, z: seconds * 60 })

test('a mount reaches the control root alone: what is beside it stays, and leaves a trail', () => {
  const { scene } = sceneOf([
    { node: basic('a') },
    { root: true, children: [{ node: emitter('e'), targets: ['a'] }] },
  ])
  const instance = new EffectInstance(scene)
  for (let n = 1; n <= 30; n++) instance.advance(STEP, { placement: moving(n * STEP) })
  const app = appearance(instance)
  assert.deepEqual(app.world, Matrix4.identity)
  const { records, head } = app.lane!
  const z = (i: number) => records[i * RECORD + 2]!
  assert.ok(z(head - 1) > 25, `${z(head - 1)}`)
  // Left behind where each was born, oldest nearest where it started.
  assert.ok(z(0) < 3, `${z(0)}`)
})

test("VelocityApproach lends a birth the whole of the emitter's own velocity", () => {
  const speedWith = (approach: number) => {
    const { scene } = sceneOf([
      { node: basic('a') },
      {
        root: true,
        children: [
          { node: emitter('e', { Emitter_VelocityApproach: flat(approach) }), targets: ['a'] },
        ],
      },
    ])
    const instance = new EffectInstance(scene)
    for (let n = 1; n <= 10; n++) instance.advance(STEP, { placement: moving(n * STEP) })
    const { records, head } = appearance(instance).lane!
    return records[(head - 1) * RECORD + VELOCITY + 2]!
  }
  assert.equal(speedWith(0), 0)
  assert.ok(Math.abs(speedWith(1) - 60) < 0.01, `${speedWith(1)}`)
})

test("a particle under an emitter sharing its appearance's parent drops the path, and keeps the bias", () => {
  const { scene } = sceneOf([
    {
      root: true,
      children: [
        { node: basic('a') },
        { node: emitter('e', { Emitter_VelocityApproach: flat(1) }), targets: ['a'] },
      ],
    },
  ])
  const instance = new EffectInstance(scene)
  for (let n = 1; n <= 10; n++) instance.advance(STEP, { placement: moving(n * STEP) })
  const { records, head } = appearance(instance).lane!
  // In the frame they share, so at its origin, moving with the bias.
  assert.ok(Math.abs(records[(head - 1) * RECORD + VELOCITY + 2]! - 60) < 0.01)
  assert.equal(records[(head - 1) * RECORD + 2], 0)
})

test('of a property given twice, the last stands, as the DLL sets each as it comes', () => {
  const { scene } = sceneOf([
    {
      node: node('a', 'FxBasicAppearance', {
        Node_LifeSpan: Infinity,
        BasicApp_QuadTexture: true,
      }),
    },
  ])
  const quad = scene.nodes[0]!.descriptor as { quadTexture: boolean }
  assert.equal(quad.quadTexture, true)
  const twice = node('b', 'FxBasicAppearance', { BasicApp_QuadTexture: true })
  twice.properties.push({ name: 'BasicApp_QuadTexture', type: 'boolean', value: false })
  assert.equal((describeNode(twice) as { quadTexture: boolean }).quadTexture, false)
})

test("a THN host's zero-length pass lets a field act once a frame, with the real step's values", () => {
  const { scene } = sceneOf([
    { node: basic('a'), targets: ['g'] },
    {
      node: node('g', 'FxGravityField', {
        Node_LifeSpan: Infinity,
        GravityField_Gravity: flat(60),
      }),
    },
    {
      node: emitter('e', { Emitter_Frequency: flat(0), Emitter_InitialParticles: 1 }),
      targets: ['a'],
    },
  ])
  const instance = new EffectInstance(scene)
  const speed = () => appearance(instance).lane!.records[VELOCITY + 1]!
  // `0x45404a`, `0x454054`, then the same at 0 ms: what's read is the update before.
  for (let n = 0; n < 3; n++) {
    instance.advance(STEP)
    instance.advance(0)
  }
  assert.ok(Math.abs(speed() + 3) < 1e-4, `${speed()}`)
})
