import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { Draw } from './frame.js'
import {
  GateTunnel,
  RETAIL_TUNNEL_LAYER,
  solveSpline,
  type TunnelLayer,
  type TunnelSettings,
} from './tunnel.js'

const f = Math.fround

// `rand()` at its most, so every drawn value is its range's maximum.
const most = () => 0x7fff

// A run of `rand()` values that repeats, for curves that wander.
const sequence = () => {
  let at = 0
  return () => (at++ * 7919) % 0x8000
}

const layer = (fields: Partial<TunnelLayer> = {}): TunnelLayer => ({
  ...RETAIL_TUNNEL_LAYER,
  ...fields,
})

// `gate_tunnel_bretonia`'s keys, as `FX/gate_tunnel.ini` writes them.
const BRETONIA: Partial<TunnelSettings> = {
  writeDepth: false,
  controlPoints: 9,
  range: { x: 500, y: 500, z: 20000 },
  minRadius: 50,
  maxRadius: 100,
  farRadiusFactor: 0,
  minSpeed: f(0.003),
  maxSpeed: f(0.08),
  timeToMaxSpeed: 5,
  minRotation: 3,
  maxRotation: -3,
  minRgb: { x: 0, y: 0, z: f(30 / 255) },
  maxRgb: { x: 0, y: 0, z: f(100 / 255) },
  layers: [
    layer({ color: { x: 0, y: 0, z: f(200 / 255) }, radiusFactor: 1.5, du: 0.1 }),
    layer({ color: { x: f(100 / 255), y: f(200 / 255), z: 1 }, du: -0.2, dv: 0.1, vScale: 15 }),
  ],
}

// A strip's vertices: position, BGRA bytes and UV, `STRIDE` 24.
const verticesOf = ({ mesh }: Draw) => {
  const floats = new Float32Array(mesh.vertices.buffer)
  return Array.from({ length: mesh.vertices.length / 24 }, (_, at) => ({
    position: [floats[at * 6]!, floats[at * 6 + 1]!, floats[at * 6 + 2]!],
    bgra: [...mesh.vertices.subarray(at * 24 + 12, at * 24 + 16)],
    uv: [floats[at * 6 + 4]!, floats[at * 6 + 5]!],
  }))
}

const inTunnel = (settings: Partial<TunnelSettings>, random = most) => {
  const tunnel = new GateTunnel(settings, { random })
  tunnel.setState(1)
  tunnel.setState(2)
  return tunnel
}

test('the spline passes through each value, smooth, with no curvature at its ends', () => {
  const y = [0, 3, -2, 5, 1]
  const segments = solveSpline(y, 4)
  segments.forEach(({ c0, c1, c2, c3 }, at) => {
    assert.equal(c0, y[at])
    assert.ok(Math.abs(c0 + c1 + c2 + c3 - y[at + 1]!) < 1e-5)
    // The slope where one segment ends is the next one's start.
    const next = segments[at + 1]
    if (next) assert.ok(Math.abs(c1 + 2 * c2 + 3 * c3 - next.c1) < 1e-5)
  })
  assert.ok(Math.abs(segments[0]!.c2) < 1e-5)
  const { c2, c3 } = segments[3]!
  assert.ok(Math.abs(2 * c2 + 6 * c3) < 1e-5)
})

test('loading draws eight curves of rand() in order, and each jump out draws them again', () => {
  let calls = 0
  const tunnel = new GateTunnel(BRETONIA, { random: () => (calls++, 0) })
  // Path x and y, radius, rotation, three colour offsets and brightness: z isn't random.
  assert.equal(calls, 8 * 9)
  tunnel.setState(1)
  // Then the light's two.
  assert.equal(calls, 2 * 8 * 9 + 2)
  // Under 2 control points, nothing is built.
  calls = 0
  new GateTunnel({ ...BRETONIA, controlPoints: 1 }, { random: () => (calls++, 0) })
  assert.equal(calls, 0)
})

test('the ship rides the path down -Z from 5 out, its speed ramping to the most, the frame turning it', () => {
  // With no wander the path is the frame's -Z, as each control value falls 20000 / 9.
  const tunnel = inTunnel({ ...BRETONIA, range: { x: 0, y: 0, z: 20000 } })
  tunnel.update(1)
  // A fifth of the way to the most speed, held a second.
  const phase = f((0.2 * (f(0.08) - f(0.003)) + f(0.003)) * 1)
  assert.equal(tunnel.phase, phase)
  const ship = tunnel.ship!
  assert.ok(Math.abs(ship.w.z - (-5 - (phase * 8 * 20000) / 9)) < 0.01)
  assert.deepEqual([ship.x.x, ship.y.y, ship.z.z], [1, 1, 1])

  const turned = inTunnel({ ...BRETONIA, range: { x: 0, y: 0, z: 20000 } })
  turned.frame = Matrix4.fromTRS({ x: 100, y: 0, z: 0 })
  turned.update(1)
  assert.ok(Math.abs(turned.ship!.w.x - 100) < 1e-3)
})

test('near the end of the path every curve scrolls on one value, and the ship back one segment', () => {
  const tunnel = inTunnel(BRETONIA, sequence())
  // Past segment 4 of 8 is past the limit: 9 - 1 - 3 - 1.
  let previous = 0
  for (let at = 0; at < 200 && tunnel.phase >= previous; at++) {
    previous = tunnel.phase
    tunnel.update(0.1)
  }
  assert.ok(tunnel.phase < previous)
  // It was at 0.5 or more, and lost 4/8 less 3/8.
  assert.ok(tunnel.phase >= 0.5 - 1 / 8 && tunnel.phase < 0.5)
})

test('each layer is strips from 0.1 ahead of the ship to 0.01 behind, each a closed ring of 13', () => {
  const tunnel = inTunnel(BRETONIA)
  tunnel.update(1)
  const draws = tunnel.draws()
  const first = draws.filter(({ blendMode }) => blendMode === 'alpha')
  const second = draws.filter(({ blendMode }) => blendMode === 'premultiplied')
  assert.equal(first.length + second.length, draws.length)
  assert.ok(first.length > 1)
  assert.deepEqual(
    draws.map(({ blendMode }) => blendMode),
    [...first, ...second].map(({ blendMode }) => blendMode),
  )
  for (const draw of draws) {
    assert.equal(draw.mesh.primitive, 5)
    assert.equal(draw.count, 26)
    assert.equal(draw.cull, 'none')
    assert.equal(draw.depthWrite, false)
    assert.equal(draw.depthFunc, 'lequal')
    assert.equal(draw.unlit, true)
    const vertices = verticesOf(draw)
    // The ring closes: its last pair is its first, turned once.
    for (const [a, b] of [
      [0, 24],
      [1, 25],
    ] as const)
      for (const axis of [0, 1, 2])
        assert.ok(Math.abs(vertices[a]!.position[axis]! - vertices[b]!.position[axis]!) < 1e-3)
  }
  // The first strip starts ahead, faded; the last ends near the ship, whole.
  const start = verticesOf(first[0]!)[0]!
  const end = verticesOf(first.at(-1)!)[1]!
  assert.equal(start.uv[1], f(f(tunnel.phase + f(0.1)) * 10 + tunnel.layers[0]!.vOffset))
  assert.equal(start.bgra[3], 0)
  assert.equal(end.bgra[3], 255)
  // Ahead it's narrowed to the far radius factor's 0.
  const radius = (vertex: { position: number[] }) =>
    Math.hypot(vertex.position[0]!, vertex.position[1]!)
  assert.ok(radius(start) < radius(end))
})

test("blue takes the red offset, not its own, and brightness scales the layer's colour", () => {
  const tunnel = inTunnel({
    ...BRETONIA,
    minRgb: { x: f(0.25), y: 0, z: 1 },
    maxRgb: { x: f(0.25), y: 0, z: 1 },
    layers: [layer({ color: { x: f(0.5), y: f(0.25), z: f(0.25) } })],
  })
  tunnel.update(1)
  const [vertex] = verticesOf(tunnel.draws()[0]!)
  // Brightness is its most, 1: red 0.75, green 0.25, and blue 0.25 + red's 0.25.
  assert.deepEqual(vertex!.bgra.slice(0, 3), [127, 63, 191])
})

test('each update scrolls every layer by du and dv, in the tunnel or out of it', () => {
  const tunnel = inTunnel(BRETONIA)
  tunnel.update(0.5)
  assert.deepEqual(
    tunnel.layers.map(({ uOffset, vOffset }) => [uOffset, vOffset]),
    [
      [f(0.05), f(0.035)],
      [f(-0.1), f(0.05)],
    ],
  )
  tunnel.setState(0)
  tunnel.update(0.5)
  assert.equal(tunnel.layers[0]!.uOffset, f(0.05))
  // The settings given aren't the tunnel's.
  assert.equal(BRETONIA.layers![0]!.uOffset, 0)
})

test('a jump out makes a white light, mostly down, which flickers once a draw switches it on', () => {
  const tunnel = new GateTunnel(BRETONIA, { random: sequence() })
  assert.equal(tunnel.light, undefined)
  tunnel.setState(1)
  const made = tunnel.light!
  assert.deepEqual(made.color, { x: 1, y: 1, z: 1 })
  assert.ok(made.direction.y < -0.9)
  assert.ok(Math.abs(Math.hypot(made.direction.x, made.direction.y, made.direction.z) - 1) < 1e-6)

  tunnel.setState(2)
  tunnel.update(0.1)
  assert.deepEqual(tunnel.light!.color, { x: 1, y: 1, z: 1 })
  tunnel.draws()
  tunnel.update(0.1)
  const { color } = tunnel.light!
  assert.ok(color.x === color.y && color.x <= 204 / 255 && color.z <= 1 && color.z > color.x)

  // Jumping in releases it; going idle doesn't, and draws nothing.
  tunnel.setState(3)
  assert.equal(tunnel.light, undefined)
  tunnel.setState(0)
  assert.deepEqual(tunnel.draws(), [])
})
