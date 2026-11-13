import { Matrix4 } from '@treewyrm/freelancer/math'
import type { Fixture } from '#/harness.js'
import type { ScreenQuad } from '#/scene/flare.js'
import type { Frame } from '#/scene/frame.js'
import { createRenderer } from '#/scene/render.js'

export interface ScreenReport {
  error: number
  /** Each row's pixels along y = 6, RGB. */
  row: number[][]
  /** Along y = 20, where a quad at z 1 lies over one at z 0.5. */
  depthRow: number[][]
}

// A 1×1 texture the quads modulate: their colour times (255, 128, 255).
const texture = {
  name: 'shine',
  type: 'image' as const,
  storage: 'targa' as const,
  format: 'rgba32_8888' as const,
  width: 1,
  height: 1,
  flip: false,
  levels: [new Uint8Array([255, 128, 255, 255])],
}

const quad = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  color: number,
): ScreenQuad => ({
  x0,
  y0,
  x1,
  y1,
  z,
  rhw: 1,
  u0: 0,
  v0: 0,
  u1: 1,
  v1: 1,
  color,
})

export default ((gl) => {
  const frame: Frame = {
    background: { x: 0, y: 0, z: 0 },
    hooks: [],
    view: Matrix4.identity,
    projection: Matrix4.identity,
    ambient: { x: 0, y: 0, z: 0 },
    lights: [],
    draws: [],
    effects: [],
    unsupported: [],
    unregistered: [],
    screenQuads: [
      {
        texture,
        quads: [
          // D3D's pixels 4 to 11 along x, twice over, so they add.
          quad(4, 2, 12, 10, 0.5, 0xff404040),
          quad(8, 2, 16, 10, 0.5, 0xff404040),
          // Nearer, then farther at exactly the clear's depth: LEQUAL passes it, and the nearer
          // one left no depth to stop it.
          quad(4, 16, 12, 24, 0.5, 0xff202020),
          quad(4, 16, 12, 24, 1, 0xff202020),
        ],
      },
    ],
  }
  const renderer = createRenderer(gl)

  renderer.render(frame)

  const pixels = new Uint8Array(32 * 32 * 4)

  gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  // GL's rows run up from the bottom; D3D's y down from the top.
  const rowOf = (y: number) =>
    Array.from({ length: 32 }, (_, x) => {
      const at = ((31 - y) * 32 + x) * 4

      return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!]
    })

  const report: ScreenReport = { error: gl.getError(), row: rowOf(6), depthRow: rowOf(20) }

  renderer.dispose()
  return report
}) satisfies Fixture<ScreenReport>
