/**
 * Retail's `FX/gate_tunnel.ini`, read and drawn, and `jump_hole` against retail: the player's ship in
 * the tunnel of `gate_tunnel_bretonia`, out of a `jumphole`. The tunnel's curves are `rand()`'s, so
 * its places are checked against the ranges the curves are drawn from, and all else exactly: the
 * clock, read from the layers' scroll, and from it the strips, their alphas, UVs and order.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Document } from '@treewyrm/freelancer/ini'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import type { Camera } from '#/scene/camera.js'
import type { Draw } from '#/scene/frame.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { GateTunnel } from '#/scene/tunnel.js'
import { assertFrameMatches } from './compare.js'
import { jumpOutFrame, loadGateTunnels, loadJumpEffects, loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const skip = existsSync(data) ? false : 'no retail DATA'
const run = join(references, 'jump_hole')
const skipRun = skip || (existsSync(join(run, 'd3d8log.jsonl')) ? false : 'no jump_hole capture')

// Twelve strips a layer, then the hull's 22 draws, then the effects.
const STRIPS = 24
const SCENE = 46

const read = async (path: string) => {
  const file = readFileSync(join(data, path))
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

test(
  'reads four tunnels, each two textured layers fading from 1 to 0 whatever the file says',
  { skip },
  async () => {
    const tunnels = await loadGateTunnels(read)
    assert.deepEqual(
      [...tunnels.keys()],
      [
        'default_jump_gate',
        'gate_tunnel_asteroid_belt',
        'gate_tunnel_bretonia',
        'gate_tunnel_liberty',
      ],
    )
    const bretonia = tunnels.get('gate_tunnel_bretonia')!
    assert.equal(bretonia.writeDepth, false)
    assert.equal(bretonia.controlPoints, 9)
    assert.equal(bretonia.farRadiusFactor, 0)
    assert.deepEqual(bretonia.maxRgb, { x: 0, y: 0, z: Math.fround(100 * Math.fround(1 / 255)) })
    for (const [nickname, { layers }] of tunnels) {
      assert.deepEqual(
        layers.map(({ texture }) => texture?.name.toLowerCase()),
        ['jumptube', 'jumptube5'],
        nickname,
      )
      // `near_alpha_factor` and `far_alpha_factor` are what the files write, and nothing reads.
      for (const { nearAlpha, farAlpha } of layers) assert.deepEqual([nearAlpha, farAlpha], [1, 0])
    }
  },
)

test(
  'every retail tunnel draws, ten seconds in, its places and UVs all finite',
  { skip },
  async () => {
    for (const [nickname, settings] of await loadGateTunnels(read)) {
      const tunnel = new GateTunnel(settings)
      tunnel.setState(1)
      tunnel.setState(2)
      for (let at = 0; at < 600; at++) tunnel.update(1 / 60)
      const draws = tunnel.draws()
      assert.ok(draws.length > 10, nickname)
      for (const { mesh } of draws) {
        // Each vertex is six words, the fourth its colour's bytes.
        const floats = new Float32Array(mesh.vertices.buffer)
        assert.ok(
          floats.every((value, at) => at % 6 === 3 || Number.isFinite(value)),
          nickname,
        )
      }
    }
  },
)

test("reads the hole's jump effect: its tunnel, ambient and white clear", { skip }, async () => {
  const hole = (await loadJumpEffects(read)).get('jump_effect_hole')!
  assert.deepEqual(hole, {
    tunnel: 'gate_tunnel_bretonia',
    ambient: { x: 25, y: 25, z: 50 },
    background: { x: 255, y: 255, z: 255 },
  })
})

interface Vertex {
  p: number[]
  u: number
  v: number
  /** A, R, G, B. */
  argb: number[]
}

const argbOf = (packed: string | undefined): number[] => {
  const c = Number(BigInt.asUintN(32, BigInt(packed!)))
  return [c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]
}

const theirVertices = ({ vertexData }: CaptureDraw): Vertex[] =>
  vertexData!.map(({ p, d, t0 }) => ({ p, u: t0![0]!, v: t0![1]!, argb: argbOf(d) }))

const ourVertices = ({ mesh, count }: Draw): Vertex[] => {
  const floats = new Float32Array(mesh.vertices.buffer)
  return Array.from({ length: count }, (_, at) => {
    const [b, g, r, a] = mesh.vertices.subarray(at * 24 + 12, at * 24 + 16)
    return {
      p: [...floats.subarray(at * 6, at * 6 + 3)],
      u: floats[at * 6 + 4]!,
      v: floats[at * 6 + 5]!,
      argb: [a!, r!, g!, b!],
    }
  })
}

/** A strip's two rings, near end first as drawn: each ring's centre and radius. */
const ringsOf = (vertices: readonly Vertex[]) =>
  [0, 1].map((end) => {
    // Thirteen pairs, the last the first again.
    const ring = vertices.filter((_, at) => at % 2 === end).slice(0, 12)
    const centre = [0, 1, 2].map((axis) => ring.reduce((sum, { p }) => sum + p[axis]!, 0) / 12)
    const radius =
      ring.reduce((sum, { p }) => sum + Math.hypot(...p.map((c, axis) => c - centre[axis]!)), 0) /
      12
    return { centre, radius }
  })

/** Row vectors, as the log writes them, into the library's matrix. */
const matrixOf = (m: readonly number[]): Matrix4 => ({
  x: { x: m[0]!, y: m[1]!, z: m[2]!, w: m[3]! },
  y: { x: m[4]!, y: m[5]!, z: m[6]!, w: m[7]! },
  z: { x: m[8]!, y: m[9]!, z: m[10]!, w: m[11]! },
  w: { x: m[12]!, y: m[13]!, z: m[14]!, w: m[15]! },
})

/**
 * What a frame's strips say of the tunnel's clock. The layers' offsets scroll by `du` and `dv` a
 * second from the file's, so the first vertex's `u` is the time since the jump began; the first
 * ring is 0.1 of the path ahead of the ship, its `v` that times `v_scale` on the offset.
 */
const clockOf = (draws: readonly CaptureDraw[]) => {
  const [first] = theirVertices(draws[0]!)
  const seconds = first!.u / Math.fround(0.1)
  const phase = Math.fround((first!.v - seconds * Math.fround(0.07)) / 10 - Math.fround(0.1))
  return { seconds, phase }
}

const captured = () => readCapture(readFileSync(join(run, 'd3d8log.jsonl'), 'utf8'))

/** Ours at retail's clock, where the capture puts the ship and the camera. */
const load = async () => {
  const capture = captured()
  const frame = capture.frames.at(-1)!
  const retail = frame.draws
  const settings = (await loadGateTunnels(read)).get('gate_tunnel_bretonia')!
  const descriptor = (await loadJumpEffects(read)).get('jump_effect_hole')!
  // Each curve at the middle of its range: a straight path of radius 75 and brightness 0.75.
  const tunnel = new GateTunnel(settings, { random: () => 16384 })
  const hole = systems.get('jump_hole')!.objects[0]!
  const [x, y, z] = hole.position
  tunnel.frame = await jumpOutFrame(read, hole.archetype, { x, y, z })
  tunnel.setState(1)
  tunnel.setState(2)
  const { seconds, phase } = clockOf(retail)
  tunnel.phase = phase
  for (const layer of tunnel.layers) {
    layer.uOffset = Math.fround(layer.uOffset + seconds * layer.du)
    layer.vOffset = Math.fround(layer.vOffset + seconds * layer.dv)
  }
  // A step of nothing places the ship at the phase.
  tunnel.update(0)

  // The strips are in the world, so the tunnel's world matrix is the view: the camera stands at its
  // inverse's origin, looking down +Z after the hole's turn.
  const camera: Camera = {
    position: Matrix4.invert(matrixOf(retail[0]!.world!)).w,
    orientation: { x: { x: -1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: -1 } },
    fovh: (Math.atan(1 / retail[0]!.projection![0]!) * 180) / Math.PI,
    near: 3,
    far: 21000,
  }
  const options = Document.read(readFileSync(join(run, 'PerfOptions.ini'))).getSection(
    'PerfOptions',
  )!
  const option = (name: string) => Number(options.getValue(name)!.value)
  const scene = await loadSystem(systems.get('jump_hole')!, read, {
    camera,
    ship: tunnel.ship!.w,
    detail: option('level_of_detail'),
    starSphere: option('star_sphere'),
    effectDetail: option('generic_effect_perf'),
    highDetailTextures: option('high_detail_textures'),
  })
  const ship = scene.objects.at(-1)!
  const ours = collectSpaceFrame({
    ...scene,
    // The letterbox's viewport, 1024 by 554.
    aspect: 1024 / 554,
    jump: {
      ship,
      tunnel,
      ambient: descriptor.ambient,
      background: descriptor.background,
    },
  })
  return { capture, frame, retail, ours, tunnel, settings, phase }
}

test(
  'jump_hole: the tunnel, then the hull and no pilot, state for state',
  { skip: skipRun },
  async () => {
    const { frame, retail, ours, tunnel } = await load()
    assert.equal(ours.draws.length, SCENE)
    assertFrameMatches(ours, retail.slice(0, SCENE), indexTextures(data))
    // Twelve strips a layer, thirteen pairs to a ring, from the far end in.
    for (const draw of retail.slice(0, STRIPS)) {
      assert.equal(draw.primitive, 'tristrip')
      assert.equal(draw.vertices, 26)
    }
    // Depth tested `LEQUAL`, not written, no fog: what the frame leaves, now captured.
    for (const draw of retail.slice(0, STRIPS)) {
      assert.equal(draw.states['ZFUNC'], 4)
      assert.equal(draw.states['FOGENABLE'], 0)
      assert.deepEqual(
        ['ADDRESSU', 'ADDRESSV'].map((name) => draw.stages[0]!.states[name]),
        [1, 1],
      )
    }
    // The hull lit by the tunnel's light alone, a directional one.
    const light = tunnel.light!
    for (const draw of retail.slice(STRIPS, SCENE)) {
      assert.equal(draw.lights.length, 1)
      assert.equal(draw.lights[0]!.type, 3)
    }
    for (const draw of ours.draws.slice(STRIPS)) assert.deepEqual(draw.lights, [light])
    // White, `jump_background_color`, in the letterbox's viewport, after the screen's black.
    const clears = frame.events.filter((event) => event.kind === 'clear' && event.n === 0)
    assert.deepEqual(
      clears.map((clear) => clear.kind === 'clear' && [clear.flags, clear.colour >>> 0]),
      [
        [3, 0xff000000],
        [1, 0xffffffff],
      ],
    )
    assert.deepEqual(ours.background, { x: 1, y: 1, z: 1 })
  },
)

test(
  "jump_hole: the tunnel's light is white less blue, dimmed whole, as it flickers",
  { skip: skipRun },
  async () => {
    for (const { draws } of captured().frames) {
      const [light] = draws[STRIPS]!.lights
      const [r, g, b] = light!.diffuse.map((c) => Math.round(c * 255))
      assert.equal(r, g)
      // `0.8 × dim` and `dim`, each times 255 and truncated.
      const dim = b! / 255
      assert.ok(Math.abs(r! - 0.8 * dim * 255) <= 1, `${r} against ${b}`)
      assert.ok(Math.abs(Math.hypot(...light!.direction) - 1) < 1e-5)
    }
  },
)

test(
  "jump_hole: the clock is one for both layers' scroll and the ship's speed",
  { skip: skipRun },
  async () => {
    const { frames } = captured()
    const settings = (await loadGateTunnels(read)).get('gate_tunnel_bretonia')!
    const [near, far] = settings.layers
    const clocks = frames.map(({ draws }) => {
      const clock = clockOf(draws)
      // The second layer's first vertex: its offsets at the same time.
      const [first] = theirVertices(draws[STRIPS / 2]!)
      const start = clock.phase + 0.1
      assert.ok(Math.abs(first!.u - (far!.uOffset + clock.seconds * far!.du)) < 1e-4)
      assert.ok(
        Math.abs(first!.v - (start * far!.vScale + far!.vOffset + clock.seconds * far!.dv)) < 1e-4,
      )
      assert.ok(Math.abs(near!.uOffset) < 1e-9)
      return clock
    })
    // `Update` steps the phase at the speed the clock reaches at the step's end.
    const { minSpeed, maxSpeed, timeToMaxSpeed } = settings
    for (let at = 1; at < clocks.length; at++) {
      const { seconds, phase } = clocks[at]!
      const step = seconds - clocks[at - 1]!.seconds
      const speed = (phase - clocks[at - 1]!.phase) / step
      const expected = Math.min(seconds / timeToMaxSpeed, 1) * (maxSpeed - minSpeed) + minSpeed
      assert.ok(Math.abs(speed / expected - 1) < 0.005, `${speed} against ${expected}`)
    }
    // From 0 at the jump: the speed's integral, to the step's error.
    const { seconds, phase } = clocks.at(-1)!
    const ramp = (maxSpeed - minSpeed) / timeToMaxSpeed
    const integral = minSpeed * seconds + (ramp * seconds * seconds) / 2
    assert.ok(Math.abs(phase / integral - 1) < 0.01, `${phase} against ${integral}`)
  },
)

test(
  "jump_hole: each strip spans retail's, at its alpha and UVs, its rings in the curves' ranges",
  { skip: skipRun },
  async () => {
    const { retail, ours, settings } = await load()
    for (let n = 0; n < STRIPS; n++) {
      const what = `strip ${n}`
      const theirs = theirVertices(retail[n]!)
      const mine = ourVertices(ours.draws[n]!)
      assert.equal(mine.length, theirs.length, what)
      theirs.forEach((vertex, at) => {
        const our = mine[at]!
        assert.ok(Math.abs(vertex.u - our.u) < 1e-4, `${what} u ${at}`)
        assert.ok(Math.abs(vertex.v - our.v) < 1e-4, `${what} v ${at}`)
        assert.equal(vertex.argb[0], our.argb[0], `${what} alpha ${at}`)
      })
      const layer = settings.layers[n < STRIPS / 2 ? 0 : 1]!
      const rings = ringsOf(theirs)
      ringsOf(mine).forEach((our, end) => {
        const { centre, radius } = rings[end]!
        // Down the hole's `Hporient`, turned to +Z: z is the path's, which no `rand()` moves.
        assert.ok(Math.abs(centre[2]! - our.centre[2]!) < 0.02, `${what} z ${centre[2]}`)
        // x and y wander within half the ranges, about the hardpoint, 0.15 and -0.44.
        assert.ok(Math.abs(centre[0]!) < settings.range.x / 2, what)
        assert.ok(Math.abs(centre[1]!) < settings.range.y / 2, what)
        // Our radius is 75 all along: retail's, at the same place in the window, is 50 to 100.
        const ratio = radius / our.radius
        assert.ok(ratio > 50 / 75 - 1e-3 && ratio < 100 / 75 + 1e-3, `${what} radius ${ratio}`)
      })
    }
    // The two layers share their rings, the first 1.5 times as wide.
    for (let n = 0; n < STRIPS / 2; n++) {
      const first = ringsOf(theirVertices(retail[n]!))
      const second = ringsOf(theirVertices(retail[n + STRIPS / 2]!))
      first.forEach(({ centre, radius }, end) => {
        assert.ok(Math.hypot(...centre.map((c, axis) => c - second[end]!.centre[axis]!)) < 0.05)
        assert.ok(Math.abs(radius / second[end]!.radius - 1.5) < 1e-3)
      })
    }
  },
)

test(
  'jump_hole: one brightness a ring for both layers, and blue offset by the red curve',
  { skip: skipRun },
  async () => {
    const { retail, settings } = await load()
    const [near, far] = settings.layers
    for (let n = 0; n < STRIPS / 2; n++) {
      const first = theirVertices(retail[n]!)
      const second = theirVertices(retail[n + STRIPS / 2]!)
      first.forEach(({ argb: [, r0, g0, b0] }, at) => {
        const [, r1, g1, b1] = second[at]!.argb
        // This tunnel's red and green offsets are 0 to 0: the first layer is blue alone.
        assert.deepEqual([r0, g0], [0, 0])
        // Its 200 of blue and the second's 200 of green are the same product.
        assert.equal(b0, g1)
        const shade = b0! / 255 / near!.color.z
        assert.ok(shade > 0.5 - 0.01 && shade <= 1, `shade ${shade}`)
        // The second's blue, 255 times it with the red curve's 0: its own, 30 to 100, would add 15.
        assert.ok(Math.abs(b1! - far!.color.z * shade * 255) <= 2, `blue ${b1}`)
        assert.ok(Math.abs(r1! - far!.color.x * shade * 255) <= 2, `red ${r1}`)
      })
    }
  },
)

test(
  'jump_hole: the ship on the path at the phase, facing down it',
  { skip: skipRun },
  async () => {
    const { retail, tunnel } = await load()
    // The hull's root part in the view, back through the view to the world.
    const view = matrixOf(retail[0]!.world!)
    const ship = Matrix4.multiply(Matrix4.invert(view), matrixOf(retail[STRIPS]!.world!))
    const ours = tunnel.ship!
    const close = (a: Vector3, b: Vector3, by: number) =>
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < by
    // 0.13 further on than ours, 1% of a frame's travel, the rings at 0.02: unexplained.
    assert.ok(Math.abs(ship.w.z - ours.w.z) < 0.2, `${ship.w.z} against ${ours.w.z}`)
    assert.ok(Math.abs(ship.w.x) < 250 && Math.abs(ship.w.y) < 250)
    // Right, up and back. The view's mirror is the view's, so through it the ship's frame is ours.
    for (const axis of ['x', 'y', 'z'] as const)
      assert.ok(close(ship[axis], ours[axis], 0.01), axis)
  },
)
