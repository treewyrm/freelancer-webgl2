/** THN playback's reference scenes: they read back whole, and once captured, retail agrees. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { read } from '@treewyrm/freelancer/thn/text'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { getResourceId } from '@treewyrm/freelancer'
import { getNodeName, type Node } from '@treewyrm/freelancer/alchemy'
import { collectEffect, type EffectDraw } from '#/alchemy/draw.js'
import { EffectInstance, POSITION, RECORD } from '#/alchemy/effect.js'
import { buildEffect, lookupOver } from '#/alchemy/tree.js'
import { GENERATED_EFFECTS } from './effects.js'
import { readDeformableModel } from '@treewyrm/freelancer/deformable'
import { Directory } from '@treewyrm/freelancer/utf'
import { collectFrame } from '#/scene/frame.js'
import { loadScene } from './load.js'
import { sceneScript, toRows } from './scene.js'
import { scenes } from './scenes.js'
import { playedOf, playedScenes, settled, thornScenes } from './thorn.js'
import { cameraOf } from './scene.js'
import { viewMatrix } from '#/scene/camera.js'
import { pickRoomLights } from '#/scene/room.js'
import { replay } from '#/thorn/playback.js'
import { milliseconds } from '#/thorn/events.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

const position = ([x, y, z]: readonly number[]) => ({ x: x!, y: y!, z: z! })

test('every THN scene is on the menu, and its script reads back with nothing left unknown', () => {
  for (const scene of [...thornScenes, ...playedScenes]) {
    assert.equal(scenes.get(scene.name), scene)

    const script = thnScene.read(read(sceneScript(scene)))

    for (const each of [...script.entities, ...script.events])
      assert.equal(each.unknown, undefined, `${scene.name}: ${JSON.stringify(each.unknown)}`)

    assert.ok(script.events.length >= 1)
  }
})

test('thorn_attach settles with the camera looking at the ship, two above its origin', () => {
  const scene = settled(scenes.get('thorn_attach')!)
  const ship = position(scene.model!.position)
  const eye = position(scene.camera.position)

  assert.deepEqual(eye, { x: 12, y: 6, z: 0 })

  // The camera's −Z, the third triple negated, points at the ship plus its own up two.
  const forward = Vector3.multiplyScalar(position(scene.camera.orientation[2]), -1)
  const aim = Vector3.normalize(
    Vector3.subtract(
      Vector3.add(
        ship,
        Matrix4.transformDirection(
          { x: 0, y: 2, z: 0 },
          Matrix4.fromRotationTranslation(toRows(scene.model!.orientation)),
        ),
      ),
      eye,
    ),
  )

  assert.ok(
    Vector3.equal(forward, aim, 1e-5),
    `${JSON.stringify(forward)} ≠ ${JSON.stringify(aim)}`,
  )
  assert.ok(Vector3.equal(ship, { x: -8, y: 3, z: -55 }, 1e-4))
})

test('thorn_path stops part way, and thorn_camera_path ends wider and moved', () => {
  const path = settled(scenes.get('thorn_path')!)
  const start = position(scenes.get('thorn_path')!.model!.position)

  assert.ok(Vector3.distance(position(path.model!.position), start) > 5)

  const camera = settled(scenes.get('thorn_camera_path')!)

  assert.equal(camera.camera.fovh, 38)
  assert.ok(Vector3.distance(position(camera.camera.position), { x: 0, y: 0, z: 10 }) > 5)
})

for (const { name } of [...thornScenes, ...playedScenes]) {
  const run = join(references, name, 'd3d8log.jsonl')
  const skip = !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(run)
      ? `no ${name} capture in references`
      : false

  test(
    `${name}: every part's modelview reaches retail's, as playback places ship and camera`,
    { skip },
    async () => {
      const readAsset = async (path: string) => {
        const file = readFileSync(join(data, path))

        return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
      }

      const definition = scenes.get(name)!
      const { scene } = await loadScene(
        settled(definition),
        readAsset,
        await playedOf(definition, readAsset),
      )
      const frame = collectFrame(scene)
      const retail = readCapture(readFileSync(run, 'utf8')).frames.at(-1)!.draws

      // The menu's interface draws after the scene: retail's first draws are the scene's, in order.
      assert.ok(retail.length >= frame.draws.length)
      frame.draws.forEach(({ world, materialName }, n) => {
        const modelView = Matrix4.multiply(frame.view, world)
        // Retail's world is the modelview with Z flipped, written as rows for row vectors.
        ;[modelView.x, modelView.y, modelView.z, modelView.w].forEach((column, c) =>
          [column.x, column.y, -column.z].forEach((cell, r) => {
            const theirs = retail[n]!.world![c * 4 + r]!

            assert.ok(
              Math.abs(cell - theirs) < 1e-3,
              `${n} ${materialName}: ${cell} against ${theirs}`,
            )
          }),
        )
      })

      const projection = retail[0]!.projection!

      assert.ok(Math.abs(frame.projection.x.x - projection[0]!) < 1e-5)
    },
  )
}

const lightsPlayback = () => {
  const scene = scenes.get('thorn_lights')!

  return replay(thnScene.read(read(sceneScript(scene))), milliseconds(scene.thorn!.settle))
}

test('thorn_lights settles with the point light orange, its ambient its own, and linear fog on', () => {
  const playback = lightsPlayback()
  const [point, spot] = playback.roomLights()

  assert.deepEqual(point!.color, { x: 1, y: 0.5, z: Math.fround(0.1) })
  assert.ok(point!.ambient && !point!.spot)
  assert.ok(spot!.spot)
  assert.equal(playback.roomFog?.mode, 'linear')
  assert.equal(playback.roomFog?.end, 120)
})

const lightsRun = join(references, 'thorn_lights', 'd3d8log.jsonl')

test(
  "thorn_lights: retail's lights and fog are playback's, in its camera space",
  {
    skip: !existsSync(lightsRun) ? 'no thorn_lights capture in references' : false,
  },
  () => {
    const scene = settled(scenes.get('thorn_lights')!)
    const playback = lightsPlayback()
    const view = viewMatrix(cameraOf(scene))
    const ship = position(scene.model!.position)
    const ours = pickRoomLights(playback.roomLights(), ship, 1)
    const draw = readCapture(readFileSync(lightsRun, 'utf8')).frames.at(-1)!.draws[0]!

    assert.equal(draw.lights.length, ours.length)

    const flip = ({ x, y, z }: Vector3) => [x, y, -z]
    const close = (a: readonly number[], b: readonly number[], what: string) =>
      b.forEach((value, i) =>
        assert.ok(Math.abs(a[i]! - value) < 1e-3, `${what}: ${a} against ${b}`),
      )

    ours.forEach((light, n) => {
      const theirs = draw.lights[n]!

      assert.equal(theirs.type, light.spot ? 2 : light.position ? 1 : 3)
      close(theirs.diffuse, [light.color.x, light.color.y, light.color.z], `${n} diffuse`)

      const ambient = light.ambient ?? { x: 0, y: 0, z: 0 }

      close(theirs.ambient, [ambient.x, ambient.y, ambient.z], `${n} ambient`)

      if (light.position)
        close(theirs.position, flip(Matrix4.transformPoint(light.position, view)), `${n} position`)

      if (light.spot) {
        close(
          theirs.direction,
          flip(Vector3.normalize(Matrix4.transformDirection(light.direction, view))),
          `${n} direction`,
        )
        close([theirs.theta, theirs.phi], [light.spot.theta, light.spot.phi], `${n} cone`)
      }

      close([theirs.range], [light.range!], `${n} range`)
      close(
        theirs.attenuation,
        [light.attenuation!.x, light.attenuation!.y, light.attenuation!.z],
        `${n} attenuation`,
      )
    })

    const fog = playback.roomFog!
    // The log writes a float state as its value.
    const float = (value: number | undefined) => value ?? Number.NaN

    assert.equal(draw.states['FOGENABLE'], 1)
    close(
      [float(draw.states['FOGSTART']), float(draw.states['FOGEND'])],
      [fog.start, fog.end],
      'fog range',
    )

    const color = draw.states['FOGCOLOR']! & 0xffffff

    assert.equal(
      color,
      (Math.round(fog.color.x * 255) << 16) |
        (Math.round(fog.color.y * 255) << 8) |
        Math.round(fog.color.z * 255),
    )
  },
)

const readData = async (path: string) => {
  const file = readFileSync(join(data, path))

  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

test(
  'thorn_character settles in the second gesture, the floor 0.3 under its root height',
  { skip: existsSync(data) ? false : 'no retail DATA' },
  async () => {
    const scene = scenes.get('thorn_character')!
    const { pose } = await playedOf(scene, readData)
    const models = await Promise.all(
      scene.character!.parts.map(async (path) =>
        readDeformableModel(Directory.read(await readData(path))),
      ),
    )
    const { root, jointState } = pose!(models)

    // `Sc_MLBODY_CHRB_GESTR_STOP_000LV_XA_03`'s Root height is 0.5458; the floor adds 0.3.
    assert.ok(Math.abs(root.w.y - (0.5458 + 0.3)) < 0.05, `${root.w.y}`)
    // The body's first joint is posed by the mixer.
    assert.ok(jointState('MAXRoot')?.orientation)
  },
)

test('thorn_psys hangs the effect on the marker where it stopped, sparam at 1', async () => {
  const scene = scenes.get('thorn_psys')!
  const { effect } = await playedOf(scene, readData)
  const placed: number[] = []
  const instance = {
    context: { sparam: 0 },
    advance: (_dt: number, { placement }: { placement?: Matrix4 } = {}) =>
      placed.push(placement?.w.x ?? NaN),
  }

  effect!(instance as never)
  assert.equal(placed.at(-1), 10)
  assert.equal(instance.context.sparam, 1)
})

const spritesRun = join(references, 'effect_sprites', 'd3d8log.jsonl')
const psysRun = join(references, 'thorn_psys', 'd3d8log.jsonl')

/**
 * Each effect draw's vertex centroid in the capture, in camera space: a basic appearance writes
 * camera-space vertices under an identity modelview, a rect or perp its node's and sets camera × node
 * world (`FxRectAppearance::FillGeometry`), so the draw's world goes on top.
 */
const capturedCentres = (path: string) =>
  readCapture(readFileSync(path, 'utf8'))
    .frames.at(-1)!
    .events.filter(
      (e): e is CaptureDraw =>
        e.kind === 'draw' && e.fvf === 0x142 && e.states['ZWRITEENABLE'] === 0,
    )
    .map((draw) => {
      const m = draw.world ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      // Row-major for row vectors: p · M.
      const points = (draw.vertexData ?? []).map(({ p }) =>
        [0, 1, 2].map((c) => p[0]! * m[c]! + p[1]! * m[4 + c]! + p[2]! * m[8 + c]! + m[12 + c]!),
      )

      return [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k]!, 0) / points.length)
    })

/** Each sprite draw's particle centre in the world, as we place it: the lane's mean through its world. */
const ourCentres = (instance: EffectInstance) => {
  const draws: EffectDraw[] = []

  collectEffect(instance, Matrix4.identity, () => undefined, draws, new Set())
  return draws.map((draw) => {
    if (draw.type !== 'sprite') return [Number.NaN, Number.NaN, Number.NaN]

    const { lane } = draw
    const sum = [0, 0, 0]
    let count = 0

    for (let i = lane.tail; i < lane.head; i++, count++)
      for (let k = 0; k < 3; k++) sum[k]! += lane.records[i * RECORD + POSITION + k]!

    const centre = { x: sum[0]! / count, y: sum[1]! / count, z: sum[2]! / count }
    const { x, y, z } = Matrix4.transformPoint(centre, draw.world)

    return [x, y, z]
  })
}

const spritesInstance = () => {
  const alchemy = GENERATED_EFFECTS.sprites()
  const nodes = new Map<number, Node>()

  for (const node of alchemy.nodes.nodes)
    nodes.set(getResourceId(getNodeName(node) ?? '', true), node)

  const resolve = (crc: number) => nodes.get(crc)

  return new EffectInstance(buildEffect(alchemy.effects.effects[0]!, resolve), {
    lookup: lookupOver(alchemy.effects.effects, resolve),
  })
}

/** How far each draw moved from `effect_sprites`, at the origin, to `thorn_psys`: ours and retail's. */
const shifts = async () => {
  const still = spritesInstance()

  for (let step = 0; step < 300; step++) {
    still.advance(1 / 60)
    still.advance(0)
  }

  const moved = spritesInstance()
  const { effect } = await playedOf(scenes.get('thorn_psys')!, async () => new Uint8Array())

  effect!(moved)

  const [a, b] = [ourCentres(still), ourCentres(moved)]
  const [ra, rb] = [capturedCentres(spritesRun), capturedCentres(psysRun)]

  return a.map((_, n) => ({
    ours: [0, 1, 2].map((k) => b[n]![k]! - a[n]![k]!),
    retail: [0, 1, 2].map((k) => rb[n]![k]! - ra[n]![k]!),
  }))
}

const capturedBoth = existsSync(spritesRun) && existsSync(psysRun)
const close3 = (a: number[], b: number[]) => a.every((v, k) => Math.abs(v - b[k]!) < 1e-2)

test(
  "thorn_psys: thorn's placement moves every appearance as retail's does, by the marker's 10",
  { skip: capturedBoth ? false : 'no thorn_psys or effect_sprites capture in references' },
  async () => {
    const all = await shifts()

    assert.equal(all.length, 10)
    all.forEach(({ ours, retail }, n) => {
      assert.ok(close3(ours, retail), `${n}: ${ours} against ${retail}`)
      assert.ok(close3(retail, [10, 0, 0]), `${n}: ${retail}`)
    })
  },
)
