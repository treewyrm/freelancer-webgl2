/** `space_order`, a lab system flown into from a save, against what the game drew: M7's first frame. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { floatAt } from '@treewyrm/freelancer/alchemy'
import { Matrix4 } from '@treewyrm/freelancer/math'
import { AGE, BORN, LIFE, RECORD } from '#/alchemy/effect.js'
import { KIND_BASIC } from '#/alchemy/draw.js'
import { readCapture } from '#/capture/capture.js'
import { indexTextures, namesOf } from '#/capture/texture-names.js'
import { flareQuads } from '#/scene/flare.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
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
// `mplatform`'s loadout puts a `Small_station_turret` on each `HpTurret`: only `HpTurret_S1_03`'s
// `Root` is near enough for its `[LOD]` range, and every `barrel` is past its own.
const TURRET = 98
// `mplatform_animate1`, in the same loadout, turns this part.
const ANIMATED = 97
// The engine's flame at each nozzle, then the platform's smoke: effects, after every object. Then
// the screen quads, the platform's six running lights.
const FIRST_EFFECT = 123
const EFFECT_DRAWS = 7
const SCREEN_QUADS = 130

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

const load = async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { draws: captured, options } = readSpaceRun(folder, system, RUNS.space_order)
  const scene = await loadSystem(system, read, options)
  const retail = captured.slice(0, SCENE_DRAWS)
  return { camera: options.camera, scene, frame: collectSpaceFrame(scene), retail, captured }
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
  assert.equal(frame.draws.length, FIRST_EFFECT)
  assert.equal(captured[SCENE_DRAWS - 1]!.stages[0]!.states['COLOROP'] !== undefined, true)
  assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
})

test('each draw stands where retail drew it, the far list on its own plane', { skip }, async () => {
  const { frame, retail } = await load()
  frame.draws.forEach(({ world, materialName, projection }, n) => {
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
  "the platform's loadout: seven turrets hung, one part near enough, and its quarters turned",
  { skip },
  async () => {
    const { scene, frame, retail } = await load()
    const platform = scene.objects.find(({ attached }) => attached)!
    assert.deepEqual(
      platform.attached!.map(({ parts }) => parts.length),
      [0, 0, 1, 0, 0, 0, 0],
    )
    // The turret reflects with the platform's `envmap_material`, which its own archetype hasn't got.
    assert.equal(frame.draws[TURRET]!.environment?.toLowerCase(), 'envmapbasic')
    assert.ok(frame.draws[TURRET]!.environmentTexture)
    // At the fitted time, the script's angle stands the part where retail drew it.
    const ours = Matrix4.multiply(frame.view, frame.draws[ANIMATED]!.world)
    const theirs = modelViewOf(retail[ANIMATED]!.world!)
    for (const axis of ['x', 'y', 'z', 'w'] as const)
      for (const cell of ['x', 'y', 'z'] as const)
        assert.ok(Math.abs(ours[axis][cell] - theirs[axis][cell]) < 0.002, `${axis}.${cell}`)
  },
)

test("its effects hold retail's particles, stepped by the game's own clock", { skip }, async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }
  const { frames } = readCapture(readFileSync(run, 'utf8'))
  const { options } = readSpaceRun(folder, system, RUNS.space_order)
  // Before the log, `RUNS`' fit: the smoke's 22 of a 2.96 Hz, ten-second particle says how long, the
  // flame's 17 at what rate. The log's own first frame stepped at 83 a second.
  const scene = await loadSystem(system, read, options)
  let frame = collectSpaceFrame(scene)
  for (const { clock, draws, index } of frames) {
    scene.tick(clock!.step, undefined, frame.effectViews)
    frame = collectSpaceFrame(scene)
    // What the vertex stage draws: the live, and of a basic one only those not under an alpha of
    // 0.01, which both of retail's fills skip (`0x6216735`, `0x62171d5`).
    const ours = frame.effects.map((draw) => {
      if (draw.type !== 'sprite') return undefined
      const { lane, lists, sparam } = draw
      let count = 0
      for (let at = lane.tail; at < lane.head; at++) {
        const o = at * RECORD
        const age = lane.records[o + AGE]! + (lane.clock - lane.records[o + BORN]!)
        const life = lane.records[o + LIFE]!
        if (!(age <= life)) continue
        const alpha = lists.alpha ? floatAt(lists.alpha, sparam, Math.min(age / life, 1)) : 1
        if (lists.kind !== KIND_BASIC || alpha >= 0.01) count++
      }
      return count
    })
    const theirs = draws
      .slice(FIRST_EFFECT, FIRST_EFFECT + EFFECT_DRAWS)
      .map(({ primitives }) => primitives / 2)
    assert.deepEqual(ours, theirs, `frame ${index}, after ${clock!.step}`)
  }
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

test(
  'its effects draw as retail drew them: each nozzle newest first, then the smoke',
  { skip },
  async () => {
    const { frame, captured } = await load()
    const index = indexTextures(data)
    const retail = captured.slice(FIRST_EFFECT, FIRST_EFFECT + EFFECT_DRAWS)
    assert.equal(frame.effects.length, EFFECT_DRAWS)
    assert.deepEqual(
      frame.effectViews.map((view) => view?.fate),
      Array(EFFECT_DRAWS).fill('draw'),
    )
    // `SpaceEffectsDrawFrame`'s `ZFUNC` 4, and no fog outside a nebula.
    assert.equal(frame.effectDepthFunc, 'lequal')
    assert.equal(frame.effectFog, undefined)
    frame.effects.forEach((ours, n) => {
      const theirs = retail[n]!
      const what = `effect draw ${n}, ${ours.texture?.name}`
      const names = namesOf(index, theirs.stages[0]!.texture!).map(({ name }) => name.toLowerCase())
      assert.ok(names.includes(ours.texture!.name.toLowerCase()), what)
      assert.deepEqual(
        [ours.blend?.source, ours.blend?.target],
        [theirs.states['SRCBLEND'], theirs.states['DESTBLEND']],
        what,
      )
      assert.equal(theirs.states['ZFUNC'], 4, what)
      assert.equal(theirs.states['ZWRITEENABLE'], 0, what)
    })
    // A perp ring is drawn in its nozzle's frame, which retail's world matrix carries; the sprites'
    // vertices are in view space, under an identity.
    for (const n of [1, 3]) {
      const ours = Matrix4.multiply(frame.view, frame.effects[n]!.world)
      const theirs = modelViewOf(retail[n]!.world!)
      for (const axis of ['x', 'y', 'z', 'w'] as const)
        for (const cell of ['x', 'y', 'z'] as const)
          assert.ok(
            Math.abs(ours[axis][cell] - theirs[axis][cell]) < 0.01,
            `ring ${n}: ${axis}.${cell} ${ours[axis][cell]} against ${theirs[axis][cell]}`,
          )
    }
  },
)

test(
  "its running lights flare as retail's screen quads did: placed, sized and ordered",
  { skip },
  async () => {
    const { scene, frame, captured, camera } = await load()
    const theirs = captured[SCREEN_QUADS]!
    assert.equal(theirs.states['SRCBLEND'], 2)
    assert.equal(theirs.states['DESTBLEND'], 2)
    assert.equal(theirs.states['ZFUNC'], 4)
    assert.equal(theirs.states['ZWRITEENABLE'], 0)
    assert.equal(theirs.states['CULLMODE'], 1)
    assert.equal(theirs.stages[0]!.states['COLOROP'], 4)
    assert.equal(theirs.stages[0]!.states['ADDRESSU'], 3)

    const [batch, ...rest] = frame.screenQuads ?? []
    assert.equal(rest.length, 0)
    assert.equal(batch!.texture.name, 'shine')
    const vertices = theirs.vertexData!
    assert.equal(batch!.quads.length * 4, vertices.length)
    // Each light's bulb, at 0.2, is under a pixel: only its glow draws. The bucket's newest first,
    // so the loadout's last light leads.
    const flares = [...scene.objects.flatMap(({ flares = [] }) => flares)].reverse()
    batch!.quads.forEach((ours, n) => {
      const corners = vertices.slice(n * 4, n * 4 + 4)
      const [x0, y0, z, rhw] = corners[0]!.p
      const [x1, y1] = corners[2]!.p
      const what = `quad ${n}`
      for (const [a, b] of [
        [ours.x0, x0],
        [ours.y0, y0],
        [ours.x1, x1],
        [ours.y1, y1],
      ] as const)
        assert.ok(Math.abs(a - b!) < 1e-3, `${what}: ${a} against ${b}`)
      assert.ok(Math.abs(ours.z - z!) < 1e-8, `${what} z: ${ours.z} against ${z}`)
      assert.ok(Math.abs(ours.rhw / rhw! - 1) < 2e-6, `${what} rhw: ${ours.rhw} against ${rhw}`)
      assert.deepEqual(
        corners.map(({ t0 }) => t0),
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
      )
      // Their blink's phase is the game's `rand()`, and the log has no clock: what it can say is that
      // each is grey, and no brighter than its fade allows at the top of a blink.
      const colour = Number(corners[0]!.d)
      const [r, g, b] = [16, 8, 0].map((shift) => (colour >>> shift) & 0xff)
      assert.ok(r === g && g === b, what)
      const { light, world } = flares[n]!
      const [brightest] = flareQuads(light, world, 1, {
        camera,
        view: frame.view,
        aspect: 1024 / 768,
        width: 1024,
        height: 768,
      }).slice(-1)
      assert.ok(r! <= (brightest!.color & 0xff), `${what}: ${r} past ${brightest!.color & 0xff}`)
    })
  },
)
