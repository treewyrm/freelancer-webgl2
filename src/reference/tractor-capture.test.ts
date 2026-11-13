/**
 * Tractors in Li01, against retail: `tractor_loot`, three frames of a crate held in its shell, and
 * `tractor_reach`, sixty, a crate 1200 off reached for from the start and held.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCapture, type CaptureDraw, type CaptureFrame } from '#/capture/capture.js'
import {
  colorBytes,
  RETAIL_TRACTOR_LIMITS,
  rotate,
  segmentCorners,
  type V,
} from '#/scene/tractor.js'
import { loadTractors } from './space-load.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const runs = ['tractor_loot', 'tractor_reach'].map((name) =>
  join(references, name, 'd3d8log.jsonl'),
)
const shots = join(references, 'beam_shots', 'd3d8log.jsonl')
const skip = !existsSync(data)
  ? 'no retail DATA'
  : !runs.every(existsSync)
    ? 'no tractor_loot or tractor_reach capture in references'
    : !existsSync(shots)
      ? 'no beam_shots capture in references'
      : false

// `beam_shots`' shot, whose state the tractor's bucket inherits.
const SHOT = 63
const { width, jitter, lineQuad, arcQuad, sparks, sparkWidth } = RETAIL_TRACTOR_LIMITS
// Its vertices are in the world, under a world matrix that is the view. Float32 at forty thousand
// holds a point to about 0.004.
const NEAR = 0.02

const frames = (): CaptureFrame[] =>
  runs.flatMap((run) => readCapture(readFileSync(run, 'utf8')).frames)

/** A frame's tractor: its additive single quads, beam then arcs, the bucket's only draws. */
const tractorOf = ({ draws }: CaptureFrame): CaptureDraw[] =>
  draws.filter(
    ({ states, primitives, fvf }) =>
      states['SRCBLEND'] === 2 && states['DESTBLEND'] === 2 && primitives === 2 && fvf === 0x142,
  )

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const distance = (a: V, b: V) => Math.hypot(...sub(a, b))
const lerp = (a: V, b: V, t: number): V => [0, 1, 2].map((c) => a[c]! + (b[c]! - a[c]!) * t) as V

/** The point the draw's world, the view, takes to the origin. Its turn mirrors, D3D's view being left-handed. */
const eyeOf = ({ world }: CaptureDraw): V =>
  [0, 1, 2].map(
    (i) =>
      -(
        world![12]! * world![i * 4]! +
        world![13]! * world![i * 4 + 1]! +
        world![14]! * world![i * 4 + 2]!
      ),
  ) as V

interface Quad {
  corners: V[]
  cur: V
  next: V
}

/** A quad's segment, from its corners along: its middle, and its ends `quadScale` inside them. */
const quadOf = ({ vertexData }: CaptureDraw, quadScale: number): Quad => {
  const corners = vertexData!.map(({ p }) => p as V)
  const mid = lerp(corners[0]!, corners[2]!, 0.5)

  return {
    corners,
    cur: lerp(mid, corners[0]!, 1 / quadScale),
    next: lerp(mid, corners[2]!, 1 / quadScale),
  }
}

/** The beam's quads, half as wide as long, then the arcs', square. */
const split = (draws: CaptureDraw[]) => {
  const square = draws.map(({ vertexData: v }) => {
    const [a, b, c, d] = v!.map(({ p }) => p as V)

    return distance(b!, d!) / distance(a!, c!) > 0.75
  })

  const first = square.includes(true) ? square.indexOf(true) : draws.length

  assert.ok(square.slice(first).every(Boolean), 'an arc before a beam quad')
  return {
    beam: draws.slice(0, first).map((draw) => quadOf(draw, lineQuad)),
    arcs: draws.slice(first).map((draw) => quadOf(draw, arcQuad)),
  }
}

test("the tractor's quads take the shots' state, `line` and its colour", { skip }, async () => {
  const read = async (path: string) => {
    const file = readFileSync(join(data, path))

    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
  }

  const { tractors } = await loadTractors(read)
  const [b, g, r, a] = colorBytes(tractors.get('ge_s_tractor_01')!.color)
  const color = ((a! << 24) | (r! << 16) | (g! << 8) | b!) >>> 0
  const shot = readCapture(readFileSync(shots, 'utf8')).frames.at(-1)!.draws[SHOT]!
  // Unlit, so the ambient is whatever was last set.
  const states = (d: CaptureDraw) => ({ ...d.states, AMBIENT: 0 })
  let seen = 0

  for (const frame of frames()) {
    const tractor = tractorOf(frame)
    if (!tractor.length) continue
    seen++

    for (const draw of tractor) {
      const what = `frame ${frame.index}, draw ${draw.n}`

      assert.deepEqual(states(draw), states(shot), what)
      assert.deepEqual(
        draw.stages.map(({ states }) => states),
        shot.stages.map(({ states }) => states),
        what,
      )
      assert.deepEqual(draw.indexData, [0, 1, 2, 0, 2, 3], what)
      assert.deepEqual(
        draw.vertexData!.map(({ d, t0 }) => [Number(d), t0]),
        [
          [color, [0, 0]],
          [color, [1, 0]],
          [color, [1, 1]],
          [color, [0, 1]],
        ],
        what,
      )
    }

    // One run, the last of the scene: the HUD's depth clear follows it.
    const last = tractor.at(-1)!.n

    assert.equal(last - tractor[0]!.n, tractor.length - 1, `${frame.index}`)
    assert.ok(
      frame.events.some((event) => event.kind === 'clear' && event.n === last + 1),
      `${frame.index}`,
    )
  }

  assert.equal(seen, 24)
})

test('its beam is jittered segments of the width, each quad built about the eye', { skip }, () => {
  for (const frame of frames()) {
    const draws = tractorOf(frame)
    if (!draws.length) continue

    const what = (n: number) => `frame ${frame.index}, quad ${n}`
    const eye = eyeOf(draws[0]!)
    const { beam, arcs } = split(draws)

    // `Win3DDrawFuzzyLine`: `floor(length / width) + 1` segments, each starting where the last ended.
    const start = beam[0]!.cur
    const end = beam.at(-1)!.next

    assert.equal(Math.floor(distance(start, end) / width) + 1, beam.length, `frame ${frame.index}`)

    for (let n = 1; n < beam.length; n++)
      assert.ok(distance(beam[n - 1]!.next, beam[n]!.cur) < NEAR, what(n))

    // Each inner point strays from its place on the line by `RandomVector`: exactly `jitter × width`.
    for (let n = 0; n < beam.length - 1; n++) {
      const stray = distance(beam[n]!.next, lerp(start, end, (n + 1) / beam.length))

      assert.ok(Math.abs(stray - jitter * width) < NEAR, `${what(n)}: strays ${stray}`)
    }

    // From its ends alone, each quad's width and turn: across `(next - cur) × (eye - cur)`, half its
    // length for the beam and square for an arc. A segment near the line of sight turns on rounding.
    const quads = [
      ...beam.map((quad) => ({ quad, scale: lineQuad, narrow: true })),
      ...arcs.map((quad) => ({ quad, scale: arcQuad, narrow: false })),
    ]

    quads.forEach(({ quad: { cur, next, corners }, scale, narrow }, n) => {
      const toEye = sub(eye, cur)
      const along = sub(next, cur)
      const sine =
        Math.hypot(...cross(along, toEye)) / (Math.hypot(...along) * Math.hypot(...toEye))
      if (sine < 0.2) return
      segmentCorners(cur, next, eye, scale, narrow).forEach((corner, at) =>
        assert.ok(distance(corner, corners[at]!) < NEAR, `${what(n)}, corner ${at}`),
      )
    })
  }
})

test('past the shell, five arcs leave its end, turning toward theirs', { skip }, () => {
  let turned = 0

  for (const frame of frames()) {
    const draws = tractorOf(frame)
    if (!draws.length) continue

    const what = `frame ${frame.index}`
    const { beam, arcs } = split(draws)
    if (!arcs.length) continue

    const end = beam.at(-1)!.next
    // `Win3DDrawFuzzyArc`: each from the beam's end, its chords chained.
    const chains: Quad[][] = []

    for (const arc of arcs)
      if (distance(arc.cur, end) < NEAR) chains.push([arc])
      else {
        assert.ok(distance(chains.at(-1)!.at(-1)!.next, arc.cur) < NEAR, what)
        chains.at(-1)!.push(arc)
      }

    assert.equal(chains.length, sparks, what)

    // The end and every arc's last point are on one sphere about the centre, which the log hasn't:
    // `2 p · c = |p|²` about the end, least squares.
    const points = chains.map((chain) => sub(chain.at(-1)!.next, end))
    const centre = sphereCentre(points)
    const radius = Math.hypot(...centre)
    for (const point of points) assert.ok(Math.abs(distance(point, centre) - radius) < NEAR, what)

    for (const chain of chains) {
      // `floor(angle / acos(1 - width² / 2r²)) + 1` chords of the sphere.
      const from = sub([0, 0, 0], centre)
      const to = sub(sub(chain.at(-1)!.next, end), centre)
      const angle = Math.acos(dot(from, to) / (radius * Math.hypot(...to)))
      // Held to -1 first: a sphere under half the width is a single chord.
      const chord = Math.acos(Math.max(1 - (sparkWidth * sparkWidth) / (2 * radius * radius), -1))

      assert.equal(Math.floor(angle / chord) + 1, chain.length, what)

      // Each inner point is `rotate`'s turn of the start toward the end, strayed `jitter × width`.
      const axis = cross(from, to)
      const unit = axis.map((c) => c / Math.hypot(...axis)) as V
      const step = angle / chain.length

      for (let at = 1; at < chain.length; at++) {
        const point = sub(chain[at - 1]!.next, end)
        const stray = distance(point, add(centre, rotate(from, unit, at * step)))

        assert.ok(Math.abs(stray - jitter * sparkWidth) < 0.03, `${what}: strays ${stray}`)
        turned++
      }
    }
  }

  // `tractor_reach`'s frame 28902: five arcs of two chords.
  assert.equal(turned, 5)
})

/** The centre of a sphere through the origin and `points`, least squares. */
const sphereCentre = (points: V[]): V => {
  const rows = points.map((p) => p.map((c) => 2 * c) as V)
  const sides = points.map((p) => dot(p, p))
  const normal = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i]! * r[j]!, 0)),
  )
  const right = [0, 1, 2].map((i) => rows.reduce((s, r, k) => s + r[i]! * sides[k]!, 0))
  const det = (m: number[][]) =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  const whole = det(normal)

  return [0, 1, 2].map(
    (c) => det(normal.map((row, i) => row.map((v, j) => (j === c ? right[i]! : v)))) / whole,
  ) as V
}
