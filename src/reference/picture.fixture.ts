import type { Fixture } from '#/harness.js'
import { collectFrame } from '#/scene/frame.js'
import { createRenderer } from '#/scene/render.js'
import { loadScene } from './load.js'
import { scenes } from './scenes.js'

export interface PictureArgs {
  scene: string
}

export interface PictureReport {
  /** RGBA rows, top row first, as base64. */
  pixels: string
  unsupported: string[]
  draws: number
  error: number
}

export default (async (gl, { args, read }) => {
  const { scene: name } = args as PictureArgs
  const { scene, texture } = await loadScene(scenes.get(name)!, read)
  const frame = collectFrame(scene)

  const { width, height } = gl.canvas
  gl.viewport(0, 0, width, height)
  createRenderer(gl, { texture }).render(frame)

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
    error: gl.getError(),
  }
}) satisfies Fixture<PictureReport>
