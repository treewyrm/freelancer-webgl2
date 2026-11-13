/** A retail system seen from anywhere, for looking at: no comparison, only the picture. */
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import type { Fixture } from '#/harness.js'
import { fieldCubes } from '#/scene/asteroids.js'
import { createRenderer } from '#/scene/render.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { readRetailSystem } from './retail-system.js'
import { loadSystem } from './space-load.js'

type Triple = readonly [number, number, number]

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
}

export interface ViewReport {
  skipped: string[]
  draws: number
  effects: number
  unsupported: string[]
  /** Cubes of asteroids drawn, by field. */
  cubes: number[]
  error: number
}

/** The turn whose -Z runs from `eye` to `target`, +Y kept up, as rows: `Matrix3` holds a file's. */
const lookAt = (eye: Triple, target: Triple): Matrix3 => {
  const forward = target.map((value, axis) => value - eye[axis]!)
  const length = Math.hypot(...forward)
  const [fx, fy, fz] = forward.map((value) => value / length) as [number, number, number]
  // Right is forward × up, up is right × forward.
  const side = Math.hypot(fz, fx)
  const right = { x: -fz / side, y: 0, z: fx / side }
  const up = {
    x: right.y * fz - right.z * fy,
    y: right.z * fx - right.x * fz,
    z: right.x * fy - right.y * fx,
  }

  return Matrix3.transpose({ x: right, y: up, z: { x: -fx, y: -fy, z: -fz } })
}

export default (async (gl, { args, read }) => {
  const { path, eye, target, fovh, seconds, sunEffect } = args as ViewArgs
  const player = { ship: 'li_elite', equipment: [], position: eye, rotate: [0, 0, 0] as Triple }
  const { system, skipped } = await readRetailSystem(read, path, player)
  const position: Vector3 = { x: eye[0], y: eye[1], z: eye[2] }
  const camera = { position, orientation: lookAt(eye, target), fovh, near: 1, far: 100000 }
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
