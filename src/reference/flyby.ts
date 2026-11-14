/** A flyby, as `npm run frames -- system … --path` takes it, written as a THN camera script. */
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { read as readText } from '@treewyrm/freelancer/thn/text'
import type { Camera } from '#/scene/camera.js'
import { columnsOf, quaternionOf } from '#/thorn/frame.js'
import { Playback } from '#/thorn/playback.js'
import { ScriptRun } from '#/thorn/script.js'
import { cameraOf } from '#/thorn/view.js'
import { lookAt, type Triple } from './look.js'

export interface Flyby {
  duration: number
  fovh?: number
  near?: number
  far?: number
  keys: {
    position: Triple
    target?: Triple
    roll?: number
    orientation?: readonly [number, number, number, number]
  }[]
  /**
   * The share of the path against the share of time, as `FreeFormPCurve` rows `[t, u, in, out]`
   * (Hermite, slopes kept); absent, the camera keeps one speed.
   */
  curve?: readonly (readonly [number, number, number, number])[]
}

/**
 * A flyby as a THN script: a camera riding one `MOTION_PATH` from start to end, the monitor on it.
 * Keys are world positions and the camera's turn as `{w,x,y,z}`, the path at the origin, unturned.
 */
export const flybyText = ({
  duration,
  fovh = 35,
  near = 1,
  far = 100000,
  keys,
  curve,
}: Flyby): string => {
  if (keys.length < 2) throw new Error('A path needs two keys at least (`SplinePath.cpp`)')

  let last: { x: number; y: number; z: number; w: number } | undefined
  const pairs = keys.map(({ position, target, roll = 0, orientation }) => {
    if (!orientation && !target) throw new Error('A key needs a target or an orientation')

    let turn = orientation
      ? { w: orientation[0], x: orientation[1], y: orientation[2], z: orientation[3] }
      : (() => {
          const { x: right, y: up, z: back } = Matrix3.transpose(lookAt(position, target!))
          const [c, s] = [Math.cos((roll * Math.PI) / 180), Math.sin((roll * Math.PI) / 180)]
          const mix = (a: typeof up, b: typeof up, k: number) => ({
            x: a.x * c + b.x * k,
            y: a.y * c + b.y * k,
            z: a.z * c + b.z * k,
          })

          return quaternionOf(columnsOf(mix(right, up, s), mix(up, right, -s), back))
        })()

    // The spline's squad doesn't fold hemispheres, so each key is put on its predecessor's side.
    if (last && last.w * turn.w + last.x * turn.x + last.y * turn.y + last.z * turn.z < 0)
      turn = { w: -turn.w, x: -turn.x, y: -turn.y, z: -turn.z }
    last = turn

    return `{${position.join(',')}}, {${[turn.w, turn.x, turn.y, turn.z].join(',')}}, `
  })
  const [x, y, z] = keys[0]!.position
  const entity = (name: string, type: string, rest: string) =>
    `  {\n    entity_name = "${name}",\n    type = ${type},\n    template_name = "",\n    lt_grp = 0,\n    srt_grp = 0,\n    usr_flg = 0${rest}\n  }`
  const unturned = 'orient = { { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 } }'

  return `duration = ${duration}

entities = {
${[
  entity('Flyby_Monitor', 'MONITOR', ''),
  entity(
    'Flyby_Camera',
    'CAMERA',
    `,\n    spatialprops = { pos = { ${x}, ${y}, ${z} }, ${unturned} },\n    cameraprops = { fovh = ${fovh}, hvaspect = 1.333333, nearplane = ${near}, farplane = ${far} }`,
  ),
  entity(
    'Flyby_Path',
    'MOTION_PATH',
    `,\n    spatialprops = { pos = { 0, 0, 0 }, ${unturned} },\n    pathprops = { path_type = "CV_CROrientationSplinePath", path_data = "OPEN, ${pairs.join('')}" }`,
  ),
].join(',\n')}
}

events = {
  { 0, SET_CAMERA, { "Flyby_Monitor", "Flyby_Camera" } },
  {
    0,
    START_PATH_ANIMATION,
    { "Flyby_Camera", "Flyby_Path" },
    {
      duration = ${duration},
      start_percent = 0,
      stop_percent = 1,${
        curve
          ? `
      param_curve = { CLSID = "FreeFormPCurve", points = { ${curve.map((row) => `{ ${row.join(', ')} }`).join(', ')} } },`
          : ''
      }
      offset = { 0, 0, 0 },
      up = Y_AXIS,
      front = NEG_Z_AXIS,
      flags = POSITION + ORIENTATION
    }
  }
}
`
}

/** The camera a flyby gives at each 16 ms tick, as `Act_CallThorn` runs its script (frames.fixture.ts). */
export const flybyCameras = (flyby: Flyby): Camera[] => {
  const parsed = thnScene.read(readText(flybyText(flyby)))
  const run = new ScriptRun(new Playback(parsed, { frame: Matrix4.identity }))
  const tick = Math.trunc(Math.fround(1 / 60) * 1000)
  const cameras: Camera[] = []

  for (let n = 0; n <= Math.ceil((flyby.duration * 1000) / tick); n++) {
    if (n > 0) run.update(tick)
    const seen = run.playback.view('Flyby_Monitor')
    if (!seen) throw new Error('No camera Flyby_Monitor')
    cameras.push(cameraOf(seen))
  }
  return cameras
}
