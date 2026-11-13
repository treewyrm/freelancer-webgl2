/**
 * `asteroid_billboards`: the lab field with Cornwall's `[AsteroidBillboards]`, from inside it, against
 * retail. Each rock's place, size and flips are the game's `rand()`, so the rocks are compared in
 * kind; what follows from a rock's place, its alpha and colours, is compared rock by rock.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Vector3 } from '@treewyrm/freelancer/math'
import type { CaptureVertex } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { directionalLightsAt, lightSet } from '#/scene/light.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import { loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const name = 'asteroid_billboards'

// Retail's draws before the depth clear, the engine's four effect draws left out; the opaque rocks,
// then the faded, just before the field's 37 cubes.
const SCENE = 130 - 4
const ROCKS = [87, 88] as const
const CUBES = 89

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

  // Entering the system is a cut, which scatters the rocks; then a frame on.
  collectSpaceFrame({ ...scene, cut: true })

  const frame = collectSpaceFrame({ ...scene, step: 1 / 60 })
  const billboards = scene.asteroids!.find(({ billboards }) => billboards)!.billboards!

  return { scene, frame, billboards, camera: options.camera, captured: draws }
}

/** A captured rock: its three corners, the middle of its base, its colours and its UVs. */
const rocksOf = (vertices: readonly CaptureVertex[]) =>
  Array.from({ length: vertices.length / 3 }, (_, k) => {
    const [a, b, c] = [0, 1, 2].map((at) => vertices[k * 3 + at]!)
    const middle: Vector3 = {
      x: (a!.p[0]! + b!.p[0]!) / 2,
      y: (a!.p[1]! + b!.p[1]!) / 2,
      z: (a!.p[2]! + b!.p[2]!) / 2,
    }

    return {
      corners: [a!.p, b!.p, c!.p] as number[][],
      middle,
      colours: [a!.d, b!.d, c!.d].map(Number),
      uvs: [...a!.t0!, ...b!.t0!],
    }
  })

const byteOf = (c: number) => Math.trunc(c * 255) & 0xff
const rgbOf = ({ x, y, z }: Vector3) => ((byteOf(x) << 16) | (byteOf(y) << 8) | byteOf(z)) >>> 0

test(`${name} is retail draw for draw`, { skip }, async () => {
  const { frame, captured } = await load()
  const retail = captured.slice(0, SCENE)

  assert.deepEqual(frame.unsupported, ['texture envmapglass'])
  assert.equal(frame.draws.length, retail.length)
  assertFrameMatches(frame, retail, indexTextures(data), { streamed: true, scattered: [...ROCKS] })
  assert.equal(frame.draws[CUBES]!.materialName, 'detailmap_ast_minedout')
})

test(`${name}: the rocks' states, and their place under the camera's view`, { skip }, async () => {
  const { frame, captured } = await load()

  for (const n of ROCKS) {
    const { states, stages, world, call } = captured[n]!
    const ours = frame.draws[n]!

    assert.equal(ours.materialName, 'asteroid billboards')
    assert.equal(call, 'DrawPrimitive')
    assert.deepEqual(
      ['ZENABLE', 'ZFUNC', 'CULLMODE', 'LIGHTING', 'FOGENABLE', 'SRCBLEND', 'DESTBLEND'].map(
        (key) => states[key],
      ),
      [1, 4, 1, 0, 0, 5, 6],
    )
    assert.deepEqual(
      ['COLOROP', 'COLORARG1', 'COLORARG2', 'ALPHAOP', 'ALPHAARG1', 'ALPHAARG2'].map(
        (key) => stages[0]!.states[key],
      ),
      [4, 2, 0, 4, 2, 0],
    )
    assert.equal(stages[1]!.states['COLOROP'], 1)

    // In world space, the view as the device's world and an identity view.
    const turned = [world![0], world![5], world![10]]

    assert.deepEqual(turned, [1, 1, -1])

    const { x, y, z } = frame.view.w
    ;[x, y, -z].forEach((cell, at) => assert.ok(Math.abs(cell - world![12 + at]!) < 1e-3))
  }
})

test(
  `${name}: the rocks are retail's in kind, and each is as opaque as its place makes it`,
  { skip },
  async () => {
    const { frame, captured, billboards, camera } = await load()
    const settled = billboards.settings.size!
    let drawn = 0

    for (const [k, n] of ROCKS.entries()) {
      const rocks = rocksOf(captured[n]!.vertexData!)

      drawn += rocks.length

      for (const [at, { corners, middle, colours }] of rocks.entries()) {
        const what = `draw ${n} rock ${at}`
        const [a, b, c] = corners as [number[], number[], number[]]
        // Base and point each `size` from its middle, square to each other, facing the camera.
        const base = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!) / 2
        const point = Math.hypot(c[0]! - middle.x, c[1]! - middle.y, c[2]! - middle.z)

        assert.ok(base > settled[0] - 0.01 && base < settled[1] + 0.01, `${what} size ${base}`)
        assert.ok(Math.abs(point - base) < 1e-3, what)
        assert.equal(a[2], b[2])
        assert.ok(Math.abs(c[2]! - a[2]!) < 1e-3, what)

        // Opaque in the first draw, faded in the second, as our fade says at retail's place.
        const alpha = billboards.alphaAt(camera, middle)

        assert.equal(byteOf(alpha), colours[0]! >>> 24, `${what} alpha ${alpha}`)
        assert.ok(k === 0 ? alpha >= 1 : alpha < 1 && alpha > Math.fround(0.02), what)
        colours.forEach((colour) => assert.equal(colour >>> 24, colours[0]! >>> 24))
      }
    }

    // Ours scatter by our own run of `rand()`: 368 to retail's 376, and 374 over 200 seeds. Which
    // fade is a coin of the place, so the split between the draws strays further.
    const ours = (frame.draws[ROCKS[0]]!.count + frame.draws[ROCKS[1]]!.count) / 3

    assert.ok(Math.abs(ours - drawn) < 0.05 * drawn, `${ours} rocks against ${drawn}`)
  },
)

test(
  `${name}: each rock's corners lit as retail lit them, picked by the first rock's U flip`,
  { skip },
  async () => {
    const { scene, frame, billboards, camera, captured } = await load()
    const lights = directionalLightsAt(lightSet(scene.lights), camera.position, 0).lights
    const { corners, centre } = billboards.coloursAt(camera, {
      ambient: frame.draws[CUBES]!.sceneAmbient!,
      lights,
    })
    // `UVs by corner`: 0 none flipped, 1 U, 2 V, 3 both.
    const cornerOf = (uvs: number[]) =>
      ['0,0,1,0', '1,0,1,1', '1,1,0,1', '0,1,0,0'].indexOf(uvs.join(','))
    const firstU = new Set<number>()

    for (const n of ROCKS)
      for (const { colours, uvs } of rocksOf(captured[n]!.vertexData!)) {
        const corner = cornerOf(uvs)

        assert.ok(corner >= 0, `UVs ${uvs}`)
        assert.equal(colours[2]! & 0xffffff, rgbOf(centre))
        assert.equal(colours[0], colours[1])

        // Retail's V flip is this rock's, its U flip the first rock's: one of two for all.
        const flipV = corner >> 1
        const pick = [0, 1].find((u) => rgbOf(corners[u + flipV * 2]!) === (colours[0]! & 0xffffff))

        assert.notEqual(pick, undefined, `colour ${(colours[0]! & 0xffffff).toString(16)}`)
        firstU.add(pick!)
      }

    assert.equal(firstU.size, 1)
  },
)
