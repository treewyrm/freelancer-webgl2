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
  // The sky's, or in a core, which has none, the first draw's: the pilot's, to rounding.
  const turn = [sky[0], sky[1], sky[2], sky[4], sky[5], sky[6], sky[8], sky[9], sky[10]]
  ;[1, 0, 0, 0, 1, 0, 0, 0, -1].forEach((cell, at) =>
    assert.ok(Math.abs(turn[at]! - cell) < 1e-6, 'the camera looked straight down -Z'),
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

/**
 * Each run's far solar and draws: `space_order`'s first far face, and its hull after the pilot. And
 * how its effects ran: an emitter releases `floor(dt × frequency)` a step, so a flame's count is the
 * frame rate's. Retail's three frames hold 18, 20 and 22 of a 110 Hz flame living 0.2294 s, which is
 * 78 to 96 a second; at 96 its picture is nearest. The log has no frame times to say. Nor how long
 * the platform's `Sc_rotate living quarters` had looped: one angle, 1.79292, puts its part where
 * retail drew it to 0.002 in every cell, and the script reaches it at 7.6306 s, a period on.
 */
export const RUNS = {
  space_order: {
    far: 'Lab_far_planet',
    farDraw: 10,
    hullDraw: 101,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 7.6306,
  },
  // No solar past the draw range: the camera is found from the near ringed planet, on the main list.
  // Inside the near ring's band: its pieces about the camera draw after the ship, then its clouds.
  ring_inside: {
    far: 'Lab_ringed_planet',
    farDraw: 30,
    hullDraw: 42,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // No solar stands where its draw's translation says: the first asteroid cube does, a grid point.
  asteroid_inside: {
    far: [-1000, -600, -1000],
    farDraw: 87,
    hullDraw: 65,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // As asteroid_inside, the billboards' two draws before the cubes.
  asteroid_billboards: {
    far: [-1000, -600, -1000],
    farDraw: 89,
    hullDraw: 65,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  asteroid_nebula: {
    far: [-4600, -600, -3400],
    farDraw: 55,
    hullDraw: 33,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // Outside the field: no cube, so the band's first piece, drawn in world space, places the origin.
  asteroid_outside: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 34,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // An exclusion band about the station: the field's own band leads, drawn in world space.
  asteroid_exband: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 69,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  asteroid_exband_edge: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 71,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // In the nebula's core and its hole: no sky, so the camera is found from the first cube.
  asteroid_hole: {
    far: [-4600, -200, -4200],
    farDraw: 27,
    hullDraw: 2,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  asteroid_hole_edge: {
    far: [-4600, -600, -3800],
    farDraw: 27,
    hullDraw: 2,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // The sheets are drawn in world space under the camera's view: the far sphere's, first, places the
  // origin.
  nebula_sheets: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 49,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  nebula_sheets_edge: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 15,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  nebula_sheets_axis: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 49,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  nebula_exterior: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 51,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  nebula_exterior_edge: {
    far: [0, 0, 0],
    farDraw: 10,
    hullDraw: 17,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  // In a core with no sky or world-space draw: the camera is found from the hull, as if the ship
  // stood where its save puts it. Everything drawn is about the camera, so that offset is shared.
  nebula_clouds: {
    far: [0, 0, 0],
    farDraw: 2,
    hullDraw: 2,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  nebula_clouds_hole: {
    far: [3000, 0, -150],
    farDraw: 2,
    hullDraw: 2,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
  ring_outside: {
    far: 'Lab_ringed_planet',
    farDraw: 32,
    hullDraw: 48,
    effectSeconds: 20,
    effectRate: 96,
    animationSeconds: 0,
  },
} as const

/**
 * A collected run of `system`: `far` names the solar on the far list and `farDraw` its first draw,
 * `hullDraw` the ship's root part, which stands where the ship does.
 */
export const readSpaceRun = (
  folder: string,
  system: ReferenceSystem,
  {
    far,
    farDraw,
    hullDraw,
    effectSeconds,
    effectRate,
    animationSeconds,
  }: {
    far: string | readonly [number, number, number]
    farDraw: number
    hullDraw: number
    effectSeconds: number
    effectRate: number
    animationSeconds: number
  },
): SpaceRun => {
  const draws = readCapture(readFileSync(join(folder, 'd3d8log.jsonl'), 'utf8')).frames.at(
    -1,
  )!.draws
  // A solar the system places, or a cube of a field: a cube's centre is a grid point.
  const position =
    typeof far === 'string'
      ? system.objects.find(({ nickname }) => nickname === far)!.position
      : far
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
      effectDetail: option('generic_effect_perf'),
      highDetailTextures: option('high_detail_textures'),
      effectSeconds,
      effectRate,
      animationSeconds,
    },
  }
}
