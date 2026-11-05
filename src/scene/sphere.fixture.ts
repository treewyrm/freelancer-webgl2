import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { getResourceId } from '@treewyrm/freelancer'
import type { Fixture } from '#/harness.js'
import { collectFrame } from './frame.js'
import { createRenderer } from './render.js'
import { placeSphere } from './sphere.js'

export interface SphereReport {
  error: number
  /** Pixels by name, as bytes. */
  pixels: Record<string, number[]>
  /** Background showing well inside the silhouette, per level: a crack or a missing cell. */
  holes: Record<string, number>
}

const COLOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [0, 1, 1],
  [1, 0, 1],
]
const sides = COLOURS.map((_, face) => `m${face}`)
const materials = new Map<number, Material>(
  COLOURS.map(([x, y, z], face) => [
    getResourceId(sides[face]!),
    { name: sides[face]!, type: 'DcDt', diffuse: { x, y, z } } as unknown as Material,
  ]),
)

const lookAtOrigin = (position: Vector3) => {
  const length = Math.hypot(position.x, position.y, position.z)
  const back = { x: position.x / length, y: position.y / length, z: position.z / length }
  const up0 = Math.abs(back.y) > 0.99 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 }
  const right = {
    x: up0.y * back.z - up0.z * back.y,
    y: up0.z * back.x - up0.x * back.z,
    z: up0.x * back.y - up0.y * back.x,
  }
  const scale = Math.hypot(right.x, right.y, right.z)
  const r = { x: right.x / scale, y: right.y / scale, z: right.z / scale }
  const up = {
    x: back.y * r.z - back.z * r.y,
    y: back.z * r.x - back.x * r.z,
    z: back.x * r.y - back.y * r.x,
  }
  // A camera holds its axes as columns of these rows.
  return Matrix3.transpose({ x: r, y: up, z: back })
}

const fixture: Fixture<SphereReport> = (gl) => {
  const renderer = createRenderer(gl)
  const { drawingBufferWidth: width, drawingBufferHeight: height } = gl
  const draw = (position: Vector3, level?: number) => {
    const camera = {
      position,
      orientation: lookAtOrigin(position),
      fovh: 20,
      near: 1,
      far: 1000,
    }
    renderer.render(
      collectFrame({
        camera,
        aspect: width / height,
        ambient: { x: 1, y: 1, z: 1 },
        lights: [],
        models: [
          {
            parts: placeSphere(
              { type: 'sphere', hardpoints: [], sides, radius: 1 },
              Matrix4.identity,
              { camera, width, ...(level === undefined ? {} : { level }) },
            ),
            mesh: () => undefined,
            material: (id) => materials.get(id),
            texture: () => undefined,
          },
        ],
      }),
    )
  }
  const read = (x: number, y: number) => {
    const pixel = new Uint8Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel.slice(0, 3)]
  }
  const pixels: Record<string, number[]> = {}
  const third = Math.floor(width / 3)
  const mid = Math.floor(width / 2)

  draw({ x: 0, y: 0, z: 4 })
  pixels['front'] = read(mid, mid)
  draw({ x: 0, y: 0, z: -4 })
  pixels['back'] = read(mid, mid)
  draw({ x: 4, y: 0, z: 0 })
  pixels['right'] = read(mid, mid)
  draw({ x: -4, y: 0, z: 0 })
  pixels['left'] = read(mid, mid)
  draw({ x: 0, y: 4, z: 0 })
  pixels['top'] = read(mid, mid)
  draw({ x: 0, y: -4, z: 0 })
  pixels['bottom'] = read(mid, mid)
  // On the edge between +Z and +X: +Z is to the left on screen, and +X to the right.
  draw({ x: 3, y: 0, z: 3 })
  pixels['edgeLeft'] = read(third, mid)
  pixels['edgeRight'] = read(width - third, mid)
  // Between +Z and +Y: +Y is above, in a bottom-up read.
  draw({ x: 0, y: 3, z: 3 })
  pixels['edgeBelow'] = read(mid, third)
  pixels['edgeAbove'] = read(mid, width - third)

  const holes: Record<string, number> = {}
  const whole = new Uint8Array(width * height * 4)
  for (const level of [3, 4, 5, 6, 9]) {
    draw({ x: 2.5, y: 1.5, z: 3 }, level)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, whole)
    // Radius 1 from about 4.2 is 20 pixels here, and level 3's facets sag by 8% at most.
    let count = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) > 17) continue
        const at = (y * width + x) * 4
        if (whole[at]! + whole[at + 1]! + whole[at + 2]! === 0) count++
      }
    holes[`${level}`] = count
  }
  renderer.dispose()
  return { error: gl.getError(), pixels, holes }
}

export default fixture
