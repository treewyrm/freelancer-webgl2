/**
 * Times a retail system's frames, by part, with its effects' particles counted by how they move: a
 * stepped lane is what the CPU moves and uploads each frame, which transform feedback would take.
 */
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import type { AppearanceNode, EffectInstance, RunNode } from '#/alchemy/effect.js'
import { RECORD } from '#/alchemy/effect.js'
import type { Fixture } from '#/harness.js'
import { createRenderer } from '#/scene/render.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { readRetailSystem } from './retail-system.js'
import { loadSystem } from './space-load.js'

type Triple = readonly [number, number, number]

export interface BenchArgs {
  /** The system's INI under `DATA`. */
  path: string
  /** What the camera looks at down -Z: an object's nickname, or a zone's, whose centre it stands in. */
  anchor: { object: string; distance: number } | { zone: string }
  leaveOut?: Record<string, string>
  /**
   * Ships ahead of the camera under full throttle, each its engine's flame and trail, far enough
   * that the camera hasn't passed them by the last frame.
   */
  ships: number
  /** `[Effect]`s ahead of the camera, each started again when it ends. */
  extras: string[]
  frames: number
  warmup: number
  /** How fast the camera flies down -Z: dust fades to nothing under a still one. */
  speed: number
}

export interface Phase {
  mean: number
  median: number
  p95: number
}

export interface BenchReport {
  skipped: string[]
  objects: number
  effects: number
  draws: number
  /** Milliseconds a frame. */
  tick: Phase
  collect: Phase
  render: Phase
  /** `readPixels` of one pixel after `render`: the GPU catching up. */
  finish: Phase
  /** Live particles, averaged over the frames. */
  particles: { stepped: number; ballistic: number; spawned: number }
  /** What the stepped lanes upload a frame, averaged: each uploads its whole range. */
  steppedBytes: number
}

const phase = (samples: number[]): Phase => {
  const sorted = [...samples].sort((a, b) => a - b)

  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
  }
}

const PLAYER = {
  ship: 'li_elite',
  equipment: ['ge_le_engine_01'],
  position: [0, 0, 0] as Triple,
  rotate: [0, 0, 0] as Triple,
}
const SHIPS = [
  ['li_elite', 'ge_le_engine_01'],
  ['li_fighter', 'ge_lf_engine_01'],
  ['ku_fighter', 'ge_kf_engine_01'],
  ['bw_fighter', 'ge_bwf_engine_01'],
] as const

export default (async (gl, { args, read }) => {
  const { path, anchor, leaveOut, ships, extras, frames, warmup, speed } = args as BenchArgs
  const { system, skipped } = await readRetailSystem(read, path, PLAYER, leaveOut)
  const at =
    'object' in anchor
      ? system.objects.find(
          ({ nickname }) => nickname.toLowerCase() === anchor.object.toLowerCase(),
        )!.position
      : system.zones!.find(({ nickname }) => nickname.toLowerCase() === anchor.zone.toLowerCase())!
          .position
  const back = 'object' in anchor ? anchor.distance : 0
  const eye: Vector3 = { x: at[0], y: at[1] + 20, z: at[2] + back }
  const camera = { position: eye, orientation: Matrix3.identity, fovh: 35, near: 1, far: 100000 }
  const ahead = (x: number, y: number, z: number): Triple => [eye.x + x, eye.y + y, eye.z - z]

  const scene = await loadSystem(system, read, {
    camera,
    ship: { x: eye.x, y: eye.y - 8, z: eye.z - 30 },
    detail: 1,
    starSphere: 1,
    effectDetail: 1,
    effectSeconds: 1,
    ships: Array.from({ length: ships }, (_, n) => {
      const [ship, engine] = SHIPS[n % SHIPS.length]!

      return {
        ship,
        engine,
        position: ahead(((n % 4) - 1.5) * 120, (Math.floor(n / 4) - 1) * 60, 1000 + n * 60),
        sparam: 1,
      }
    }),
    extraEffects: extras.map((nickname, n) => ({
      nickname,
      position: ahead((n - (extras.length - 1) / 2) * 300, 0, 2500),
    })),
  })

  const renderer = createRenderer(gl)
  const { width, height } = gl.canvas

  gl.viewport(0, 0, width, height)

  const pixel = new Uint8Array(4)
  const dt = 1 / 60
  let time = 0

  const instances = (): EffectInstance[] => [
    ...(scene.effects ?? []).map(({ instance }) => instance),
    ...(scene.dust?.effects() ?? []).map(({ effect }) => effect.instance),
    ...(scene.asteroids ?? []).flatMap(({ dynamic = [] }) =>
      dynamic.flatMap(({ rocks }) => rocks.effects().map(({ effect }) => effect.instance)),
    ),
  ]

  const count = () => {
    const found = { stepped: 0, ballistic: 0, spawned: 0, bytes: 0 }

    const visit = (node: RunNode) => {
      if (node.dead) return

      const { lane, records } = node as AppearanceNode

      if (lane) {
        found[lane.stepped ? 'stepped' : 'ballistic'] += lane.count
        if (lane.stepped) found.bytes += lane.head * RECORD * 4
      }

      if (records) found.spawned += records.length
      node.children.forEach(visit)
    }
    for (const instance of instances()) instance.top.forEach(visit)
    return found
  }

  const samples = { tick: [] as number[], collect: [] as number[], render: [] as number[] }
  const finish: number[] = []
  const totals = { stepped: 0, ballistic: 0, spawned: 0, bytes: 0 }
  let draws = 0
  let effects = 0

  for (let n = 0; n < warmup + frames; n++) {
    time += dt

    const moved = { ...scene.camera, position: { ...eye, z: eye.z - speed * time } }
    const a = performance.now()

    scene.tick(dt, moved)

    const b = performance.now()
    const frame = collectSpaceFrame({ ...scene, camera: moved, time, step: dt })
    const c = performance.now()

    renderer.render(frame)

    const d = performance.now()

    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

    const e = performance.now()

    if (n < warmup) continue
    samples.tick.push(b - a)
    samples.collect.push(c - b)
    samples.render.push(d - c)
    finish.push(e - d)

    const found = count()

    for (const key of ['stepped', 'ballistic', 'spawned', 'bytes'] as const)
      totals[key] += found[key]

    draws = frame.draws.length
    effects = frame.effects.length
  }

  return {
    skipped,
    objects: scene.objects.length,
    effects,
    draws,
    tick: phase(samples.tick),
    collect: phase(samples.collect),
    render: phase(samples.render),
    finish: phase(finish),
    particles: {
      stepped: totals.stepped / frames,
      ballistic: totals.ballistic / frames,
      spawned: totals.spawned / frames,
    },
    steppedBytes: totals.bytes / frames,
  }
}) satisfies Fixture<BenchReport>
