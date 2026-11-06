/** What a space capture says of its frame that the system file can't: camera, ship and options. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document } from '@treewyrm/freelancer/ini'
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import type { Camera } from '#/scene/camera.js'
import type { SystemOptions } from './space-load.js'
import type { ReferenceSystem } from './systems.js'

export interface SpaceRun {
  /** The last frame's draws, HUD included. */
  draws: CaptureDraw[]
  options: SystemOptions
}

/**
 * Where the chase camera was, from a far solar the system file places: its first draw's translation,
 * the sky's rotation, and the projection's planes.
 */
const cameraOf = (draws: readonly CaptureDraw[], far: readonly number[], at: number): Camera => {
  const sky = draws[0]!.world!
  assert.deepEqual(
    [sky[0], sky[1], sky[2], sky[4], sky[5], sky[6], sky[8], sky[9], sky[10]],
    [1, 0, 0, 0, 1, 0, 0, 0, -1],
    'the camera looked straight down -Z',
  )
  const [x, y, z] = draws[at]!.world!.slice(12, 15) as [number, number, number]
  // A near list's draw: D3D's `_11` is 1 / tan(half fov x), `_33` is far / (far - near), `_43` is
  // -near times that.
  const projection = draws.find(({ states }) => states['ZENABLE'] === 1)!.projection!
  const near = -projection[14]! / projection[10]!
  return {
    position: { x: far[0]! - x, y: far[1]! - y, z: far[2]! + z },
    orientation: Matrix3.identity,
    fovh: (Math.atan(1 / projection[0]!) * 180) / Math.PI,
    near,
    far: (projection[10]! * near) / (projection[10]! - 1),
  }
}

/** Each run's far solar and draws: `space_order`'s first far face, and its hull after the pilot. */
export const RUNS = {
  space_order: { far: 'Lab_far_planet', farDraw: 10, hullDraw: 101 },
} as const

/**
 * A collected run of `system`: `far` names the solar on the far list and `farDraw` its first draw,
 * `hullDraw` the ship's root part, which stands where the ship does.
 */
export const readSpaceRun = (
  folder: string,
  system: ReferenceSystem,
  { far, farDraw, hullDraw }: { far: string; farDraw: number; hullDraw: number },
): SpaceRun => {
  const draws = readCapture(readFileSync(join(folder, 'd3d8log.jsonl'), 'utf8')).frames.at(
    -1,
  )!.draws
  const position = system.objects.find(({ nickname }) => nickname === far)!.position
  const camera = cameraOf(draws, position, farDraw)
  // The game moves the ship a little as it loads, so the save's position isn't where it drew.
  const [x, y, z] = draws[hullDraw]!.world!.slice(12, 15) as [number, number, number]
  const ship: Vector3 = {
    x: camera.position.x + x,
    y: camera.position.y + y,
    z: camera.position.z - z,
  }
  const section = Document.read(readFileSync(join(folder, 'PerfOptions.ini'))).getSection(
    'PerfOptions',
  )!
  const option = (name: string) => Number(section.getValue(name)!.value)
  return {
    draws,
    options: {
      camera,
      ship,
      detail: option('level_of_detail'),
      starSphere: option('star_sphere'),
    },
  }
}
