/**
 * `cockpit_li` and `cockpit_rh` against retail: the cockpit's mesh from the cockpit view, its pass
 * state for state. `rh_elite`'s `grill02`, a `DcDtOcOt`, draws in place after the opaque parts, in
 * the mesh's depth range and under its planes, before the HUD: the effects left bin 1 off.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Matrix3, Matrix4, Quat } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import type { Camera } from '#/scene/camera.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { assertFrameMatches } from './compare.js'
import { loadCockpit, loadSystem } from './space-load.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

// Which of each pass's draws blend: `rh_elite_cockpit`'s glass, its last part.
const RUNS = [
  { name: 'cockpit_li', blended: [false, false, false, false] },
  { name: 'cockpit_rh', blended: [false, false, false, false, true] },
] as const

const skipOf = (name: string) =>
  !existsSync(data)
    ? 'no retail DATA'
    : !existsSync(join(references, name, 'd3d8log.jsonl'))
      ? `no ${name} capture in references`
      : false

const read = async (path: string) => {
  const file = readFileSync(join(data, path))
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

/** D3D's row-vector matrix in its mirrored space, as ours: its third column negated. */
const unmirror = (m: readonly number[]): Matrix4 => {
  const row = (at: number, w: number) => ({ x: m[at]!, y: m[at + 1]!, z: -m[at + 2]!, w })
  return { x: row(0, 0), y: row(4, 0), z: row(8, 0), w: row(12, 1) }
}

const load = async (name: string) => {
  const system = systems.get(name)!
  const draws = readCapture(
    readFileSync(join(references, name, 'd3d8log.jsonl'), 'utf8'),
  ).frames.at(-1)!.draws
  // The pass is what draws at the depth range's back. The HUD follows it.
  const first = draws.findIndex(({ viewport }) => viewport?.[4] === 0.75)
  const end = draws.findIndex((draw, at) => at > first && draw.viewport?.[4] !== 0.75)
  const pass = draws.slice(first, end)
  // From the save's place and turn. Retail's view is identity in the pass, its world the camera's.
  const projection = pass[0]!.projection!
  const camera: Camera = {
    position: { x: 0, y: 0, z: 0 },
    orientation: Matrix3.fromQuaternion(
      Quat.axisAngle({ axis: { x: 0, y: 1, z: 0 }, angle: Math.PI }),
    ),
    fovh: (Math.atan(1 / projection[0]!) * 180) / Math.PI,
    near: 1,
    far: 100000,
  }
  const scene = await loadSystem(system, read, {
    camera,
    ship: camera.position,
    detail: 1,
    starSphere: 1,
  })
  const { place, sphere } = await loadCockpit(read, system.player.ship, camera)
  const world = Matrix4.multiply(
    Matrix4.fromRotationTranslation(camera.orientation, camera.position),
    unmirror(pass[0]!.world!),
  )
  const frame = collectSpaceFrame({
    ...scene,
    firstPerson: true,
    hud: true,
    cockpit: {
      model: place(world),
      sphere: { center: Matrix4.transformPoint(sphere.center, world), radius: sphere.radius },
    },
  })
  return { frame, pass, after: draws[end]!, camera }
}

const nearFar = (projection: readonly number[]) => {
  const near = -projection[14]! / projection[10]!
  return [near, (projection[10]! * near) / (projection[10]! - 1)]
}

for (const { name, blended } of RUNS) {
  test(`${name}: the mesh's pass is retail's, draw for draw`, { skip: skipOf(name) }, async () => {
    const { frame, pass, after } = await load(name)
    const ours = frame.afterEffects ?? []
    assert.deepEqual(
      ours.map(({ blend }) => blend),
      blended,
    )
    assertFrameMatches({ ...frame, draws: ours }, pass, indexTextures(data))
    assert.equal(frame.atEnd, undefined, 'nothing waits for the scene to end')
    assert.notEqual(after.viewport?.[4], 0.75, 'the HUD follows in the range the pass left')
  })

  test(
    `${name}: at the depth range's back, under 0.05 and 500`,
    { skip: skipOf(name) },
    async () => {
      const { frame, pass } = await load(name)
      for (const [at, draw] of (frame.afterEffects ?? []).entries()) {
        const retail = pass[at]!
        assert.deepEqual(draw.depthRange, retail.viewport!.slice(4, 6))
        const [near, far] = nearFar(retail.projection!)
        assert.ok(Math.abs(near! - 0.05) < 1e-6 && Math.abs(far! - 500) < 0.1, `${near} ${far}`)
        const theirs = retail.projection!
        assert.ok(Math.abs(draw.projection!.x.x - theirs[0]!) < 1e-5)
        assert.ok(Math.abs(draw.projection!.y.y - theirs[5]!) < 1e-5)
      }
    },
  )

  test(`${name}: lit as an object, by the system's light`, { skip: skipOf(name) }, async () => {
    const { frame, pass, camera } = await load(name)
    const view = Matrix4.invert(
      Matrix4.fromRotationTranslation(camera.orientation, camera.position),
    )
    for (const [at, draw] of (frame.afterEffects ?? []).entries()) {
      const [light] = pass[at]!.lights!
      assert.equal(draw.lights!.length, 1)
      const ours = draw.lights![0]!
      // Lights go in view space: retail's mirrored, ours not.
      const { x, y, z } = Matrix4.transformDirection(ours.direction, view)
      ;[x, y, -z].forEach((value, axis) =>
        assert.ok(Math.abs(value - light!.direction[axis]!) < 1e-4, `${[x, y, -z]}`),
      )
      // The ship drifts as it loads; its distance to the light, 36000 off, hardly moves the curve.
      assert.ok(Math.abs(ours.color.x - light!.diffuse[0]!) < 1e-4, `${ours.color.x}`)
    }
  })
}
