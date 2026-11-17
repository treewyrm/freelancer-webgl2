/** A retail system seen from anywhere, for looking at: no comparison, only the picture. */
import type { Vector3 } from '@treewyrm/freelancer/math'
import type { Fixture } from '#/harness.js'
import { fieldCubes } from '#/scene/asteroids.js'
import { createRenderer } from '#/scene/render.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { lookAt, type Triple } from './look.js'
import { readRetailSystem } from './retail-system.js'
import { loadSystem } from './space-load.js'

export interface ViewArgs {
  path: string
  eye: Triple
  target: Triple
  /** Half the horizontal field of view, degrees. */
  fovh: number
  /** How long its effects, dust and clouds have run, at 60 a second. */
  seconds: number
  /** `SunEffect`: its suns' coronas and flares. */
  sunEffect: number
  /** A parallel view's half-width, looking straight down from `eye`, +X right and −Z up. */
  ortho?: number
}

// Rows: local +X is world +X, local +Y world −Z, local −Z world −Y.
const DOWN = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 0, z: 1 }, z: { x: 0, y: -1, z: 0 } }

export interface ViewReport {
  skipped: string[]
  draws: number
  effects: number
  unsupported: string[]
  /** Cubes of asteroids drawn, by field. */
  cubes: number[]
  error: number
}

export default (async (gl, { args, read }) => {
  const { path, eye, target, fovh, seconds, sunEffect, ortho } = args as ViewArgs
  const player = { ship: 'li_elite', equipment: [], position: eye, rotate: [0, 0, 0] as Triple }
  const { system, skipped } = await readRetailSystem(read, path, player)
  const position: Vector3 = { x: eye[0], y: eye[1], z: eye[2] }
  const camera = ortho
    ? { position, orientation: DOWN, fovh, near: 1, far: 2 * eye[1], ortho: { halfWidth: ortho } }
    : { position, orientation: lookAt(eye, target), fovh, near: 1, far: 100000 }
  const scene = await loadSystem(system, read, {
    camera,
    // 500 behind the camera, so its hull is out of the picture: the third column is its back.
    ship: {
      x: eye[0] + camera.orientation.x.z * 500,
      y: eye[1] + camera.orientation.y.z * 500,
      z: eye[2] + camera.orientation.z.z * 500,
    },
    detail: 1,
    starSphere: 1,
    effectDetail: 1,
  })
  const { width, height } = gl.canvas
  const suns = { sunEffect, viewport: { width, height }, step: 1 / 60 }
  let frame = collectSpaceFrame({
    ...scene,
    ...suns,
    aspect: width / height,
    viewport: { width, height },
  })

  for (let at = 0; at < seconds * 60; at++) {
    scene.tick(1 / 60)
    frame = collectSpaceFrame({
      ...scene,
      ...suns,
      aspect: width / height,
      viewport: { width, height },
      time: (at + 1) / 60,
    })
  }

  gl.viewport(0, 0, width, height)
  createRenderer(gl).render(frame)
  return {
    skipped,
    draws: frame.draws.length,
    effects: frame.effects.length,
    unsupported: frame.unsupported,
    cubes: (scene.asteroids ?? []).map((field) => fieldCubes(field, camera, width / height).length),
    error: gl.getError(),
  }
}) satisfies Fixture<ViewReport>
