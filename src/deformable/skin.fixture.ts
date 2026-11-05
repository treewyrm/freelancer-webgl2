import { getResourceId } from '@treewyrm/freelancer'
import type { Bone, Level } from '@treewyrm/freelancer/deformable'
import type { Material } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Fixture } from '#/harness.js'
import { collectFrame, type DrawSkin } from '#/scene/frame.js'
import { createRenderer } from '#/scene/render.js'
import { boneTable, skinMesh } from './skin.js'

export interface SkinReport {
  error: number
  /** Whether each column of the middle row is lit, left to right. */
  rows: Record<string, number[]>
  /** Red, under a light along the first and across a turned second bone. */
  lit: Record<string, number>
}

// A unit square facing +Z, on one bone or split between two.
const quad = (ids: number[], weights: number[], counts: number[]): Level =>
  ({
    fraction: 1,
    groups: [{ material: 'skin', primitive: 'strip', indices: new Uint16Array([0, 1, 2, 3]) }],
    geometry: {
      indices: new Uint32Array([0, 1, 2, 3]),
      points: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv0: { indices: new Uint32Array([0, 0, 0, 0]), coordinates: new Float32Array([0, 0]) },
      boneFirst: new Uint32Array(4),
      boneCount: new Uint32Array(counts),
      boneIds: new Uint32Array(ids),
      boneWeights: new Float32Array(weights),
    },
  }) as unknown as Level

const bone = { orientation: Matrix3.identity, position: { x: 0, y: 0, z: 0 } } as unknown as Bone
const material = {
  name: 'skin',
  type: 'DcDt',
  diffuse: { x: 1, y: 0, z: 0 },
} as unknown as Material

const fixture: Fixture<SkinReport> = (gl) => {
  const renderer = createRenderer(gl)
  const { drawingBufferWidth: width, drawingBufferHeight: height } = gl
  const row = new Uint8Array(width * 4)

  const draw = (
    level: Level,
    worlds: Matrix4[],
    root: Matrix4,
    ambient: number,
    lights = false,
  ) => {
    const { mesh, reference, influences } = skinMesh(level, worlds.length)
    const skin: DrawSkin = {
      influences,
      bones: boneTable(
        worlds.map(() => bone),
        worlds,
        root,
      ),
    }
    renderer.render(
      collectFrame({
        camera: {
          position: { x: 0, y: 0, z: 10 },
          orientation: Matrix3.identity,
          fovh: 45,
          near: 1,
          far: 100,
        },
        aspect: width / height,
        ambient: { x: ambient, y: ambient, z: ambient },
        lights: lights ? [{ color: { x: 1, y: 1, z: 1 }, direction: { x: 0, y: 0, z: -1 } }] : [],
        models: [
          {
            parts: [{ reference, mesh, world: root, skin }],
            mesh: () => undefined,
            material: (id) => (id === getResourceId('skin') ? material : undefined),
            texture: () => undefined,
          },
        ],
      }),
    )
  }
  const middle = () => {
    gl.readPixels(0, height >> 1, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row)
    return Array.from({ length: width }, (_, x) => row[x * 4]!)
  }
  const span = () => {
    const lit = middle()
      .map((red, x) => (red > 0 ? x : -1))
      .filter((x) => x >= 0)
    return [lit[0] ?? -1, lit.at(-1) ?? -1]
  }

  const one = quad([1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1])
  const half = quad(
    [0, 1, 0, 1, 0, 1, 0, 1],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    [2, 2, 2, 2],
  )
  const rows: Record<string, number[]> = {}
  const lit: Record<string, number> = {}

  draw(one, [Matrix4.identity, Matrix4.identity], Matrix4.identity, 1)
  rows['bind'] = span()
  // The whole quad follows its one bone.
  draw(one, [Matrix4.identity, Matrix4.translation({ x: 3, y: 0, z: 0 })], Matrix4.identity, 1)
  rows['moved'] = span()
  // Half of it follows, half stays.
  draw(half, [Matrix4.identity, Matrix4.translation({ x: 3, y: 0, z: 0 })], Matrix4.identity, 1)
  rows['blended'] = span()
  // Root and bone moving as one are the same picture as the root alone.
  const root = Matrix4.translation({ x: -2, y: 0, z: 0 })
  draw(one, [root, root], root, 1)
  rows['root'] = span()

  // A bone turned 90° about Y takes the normal with it: lit head on, then edge on to the light.
  draw(one, [Matrix4.identity, Matrix4.identity], Matrix4.identity, 0, true)
  lit['faced'] = middle()[width >> 1]!
  const turned = Matrix4.fromRotationTranslation(
    { x: { x: 0.6, y: 0, z: 0.8 }, y: { x: 0, y: 1, z: 0 }, z: { x: -0.8, y: 0, z: 0.6 } },
    { x: 0, y: 0, z: 0 },
  )
  draw(one, [Matrix4.identity, turned], Matrix4.identity, 0, true)
  lit['turned'] = middle()[width >> 1]!

  renderer.dispose()
  return { error: gl.getError(), rows, lit }
}

export default fixture
