import type { Vector3 } from '@treewyrm/freelancer/math'
import type { Fixture } from '#/harness.js'
import { createRenderer } from '#/scene/render.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { loadSystem, type SystemOptions } from './space-load.js'
import { systems } from './systems.js'

export interface SpaceArgs {
  system: string
  options: SystemOptions
  /**
   * Retail's spin for each nebula bit it drew: the quad's centre and its up. A bit's spin is the
   * game's `rand()`, so the picture is compared with retail's own.
   */
  spins?: { centre: Vector3; up: Vector3 }[]
  /** The run's `SunEffect`: with it, its suns' coronas and flares, settled over five seconds. */
  sunEffect?: number
}

export interface SpaceReport {
  /** RGBA rows, top row first, as base64. */
  pixels: string
  unsupported: string[]
  draws: number
  effects: number
  error: number
}

export default (async (gl, { args, read }) => {
  const { system, options, spins = [], sunEffect } = args as SpaceArgs
  const scene = await loadSystem(systems.get(system)!, read, options)
  // Each bit standing where retail drew one takes its up. Square to the camera already, the bits'
  // turn leaves it.
  for (const { exterior, zone } of scene.nebulae ?? [])
    for (const bit of exterior?.bits ?? []) {
      const at = {
        x: zone.position.x + bit.position.x,
        y: zone.position.y + bit.position.y,
        z: zone.position.z + bit.position.z,
      }
      const spin = spins.find(
        ({ centre }) => Math.hypot(centre.x - at.x, centre.y - at.y, centre.z - at.z) < 1,
      )
      if (spin) (bit as { axis: Vector3 }).axis = spin.up
    }
  const { width, height } = gl.canvas
  const suns =
    sunEffect === undefined ? {} : { sunEffect, viewport: { width, height }, step: 1 / 60 }
  let frame = collectSpaceFrame({ ...scene, ...suns })
  if (sunEffect !== undefined)
    for (let at = 0; at < 300; at++) frame = collectSpaceFrame({ ...scene, ...suns })

  gl.viewport(0, 0, width, height)
  createRenderer(gl).render(frame)

  const raw = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw)
  const flipped = new Uint8Array(raw.length)
  for (let y = 0; y < height; y++)
    flipped.set(raw.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4)

  let text = ''
  for (let at = 0; at < flipped.length; at += 0x8000)
    text += String.fromCharCode(...flipped.subarray(at, at + 0x8000))

  return {
    pixels: btoa(text),
    unsupported: frame.unsupported,
    draws: frame.draws.length,
    effects: frame.effects.length,
    error: gl.getError(),
  }
}) satisfies Fixture<SpaceReport>
