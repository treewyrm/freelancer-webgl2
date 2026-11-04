import { Matrix3, Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import type { CubeTexture, Texture } from '@treewyrm/freelancer/texture'
import type { Fixture } from '#/harness.js'
import { ATTRIBUTE_LOCATIONS } from '#/mesh/plan.js'
import type { Draw, Frame } from '#/scene/frame.js'
import { createTexture } from '#/texture/texture.js'
import { planUpload } from '#/texture/upload.js'
import {
  createDcDtProgram,
  DIFFUSE_UNIT,
  ENVIRONMENT_UNIT,
  SECOND_UNIT,
  setDrawUniforms,
  setFrameUniforms,
} from './dcdt.js'

export type DcDtReport = Record<string, number[]>

const IDENTITY = Matrix4.translation({ x: 0, y: 0, z: 0 })

type Parameters = Pick<
  Draw,
  | 'world'
  | 'diffuse'
  | 'ambient'
  | 'emissive'
  | 'colorVertex'
  | 'negateNormals'
  | 'normalizeNormals'
  | 'alphaReference'
  | 'texture'
  | 'environment'
  | 'second'
>

const BLACK = { x: 0, y: 0, z: 0 }
const SAMPLER = { name: 't', uvSet: 0 } as Draw['texture']

const base: Parameters = {
  world: IDENTITY,
  diffuse: [0, 0, 0, 1],
  ambient: BLACK,
  emissive: BLACK,
  colorVertex: false,
  negateNormals: false,
  normalizeNormals: false,
  alphaReference: 0,
}

const frameOf = (fields: Partial<Frame>): Frame => ({
  view: IDENTITY,
  projection: IDENTITY,
  ambient: BLACK,
  lights: [],
  draws: [],
  unsupported: [],
  unregistered: [],
  background: BLACK,
  hooks: [],
  ...fields,
})

const solid = (value: number): Texture => ({
  name: 'solid',
  type: 'image',
  storage: 'targa',
  format: 'rgba32_8888',
  width: 1,
  height: 1,
  flip: false,
  levels: [new Uint8Array([value, value, value, 255])],
})

// A face of a cube holds BGRA, as the library hands it over.
const face = (r: number, g: number, b: number) => [new Uint8Array([b, g, r, 255])]

const cube = (faces: number[][]): CubeTexture => ({
  name: 'cube',
  type: 'cube',
  format: 'rgba32_8888',
  width: 1,
  height: 1,
  flip: true,
  faces: faces.map(([r, g, b]) => face(r!, g!, b!)) as CubeTexture['faces'],
})

const LIGHT_DOWN_Z = { color: { x: 1, y: 1, z: 1 }, direction: { x: 0, y: 0, z: -1 } }

export default ((gl) => {
  const program = createDcDtProgram(gl)
  gl.bindVertexArray(gl.createVertexArray())

  // One big triangle at view depth -0.5, by a clip space equal to view space.
  const position = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, position)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, -0.5, 3, -1, -0.5, -1, 3, -0.5]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(ATTRIBUTE_LOCATIONS.position)
  gl.vertexAttribPointer(ATTRIBUTE_LOCATIONS.position, 3, gl.FLOAT, false, 0, 0)

  const read = (
    parameters: Partial<Parameters>,
    frame: Partial<Frame> = {},
    normal: Vector3 = { x: 0, y: 0, z: 1 },
  ): number[] => {
    gl.vertexAttrib3f(ATTRIBUTE_LOCATIONS.normal, normal.x, normal.y, normal.z)
    setFrameUniforms(gl, program, frameOf(frame))
    setDrawUniforms(gl, program, { ...base, ...parameters })
    gl.clearColor(0, 0, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const pixel = new Uint8Array(4)
    gl.readPixels(
      gl.canvas.width >> 1,
      gl.canvas.height >> 1,
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    )
    return [...pixel]
  }

  gl.activeTexture(gl.TEXTURE0 + DIFFUSE_UNIT)
  gl.bindTexture(gl.TEXTURE_2D, createTexture(gl, planUpload(solid(128))))
  const nearest = gl.createSampler()
  gl.samplerParameteri(nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.samplerParameteri(nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.bindSampler(DIFFUSE_UNIT, nearest)
  gl.bindSampler(ENVIRONMENT_UNIT, nearest)

  const environment = (faces: number[][]) => {
    gl.activeTexture(gl.TEXTURE0 + ENVIRONMENT_UNIT)
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, createTexture(gl, planUpload(cube(faces))))
  }

  const lit = { diffuse: [0.5, 0.25, 1, 1] as Draw['diffuse'] }
  const overbright = {
    diffuse: [1, 1, 1, 1] as Draw['diffuse'],
    ambient: { x: 1, y: 1, z: 1 },
  }
  const sixty = { x: Math.sqrt(3) / 2, y: 0, z: 0.5 }

  const report: DcDtReport = {
    ambient: read({ ambient: { x: 0.5, y: 0.5, z: 1 } }, { ambient: { x: 0.4, y: 0.4, z: 0.4 } }),
    emissive: read({ emissive: { x: 0.25, y: 0, z: 0.5 } }),
    facing: read(lit, { lights: [LIGHT_DOWN_Z] }),
    atSixty: read(lit, { lights: [LIGHT_DOWN_Z] }, sixty),
    behind: read(lit, { lights: [LIGHT_DOWN_Z] }, { x: 0, y: 0, z: -1 }),
    negated: read(
      { ...lit, negateNormals: true },
      { lights: [LIGHT_DOWN_Z] },
      { x: 0, y: 0, z: -1 },
    ),
    twoLights: read({ diffuse: [0.25, 0.25, 0.25, 1] }, { lights: [LIGHT_DOWN_Z, LIGHT_DOWN_Z] }),
    longNormal: read(
      { diffuse: [0.25, 0.25, 0.25, 1] },
      { lights: [LIGHT_DOWN_Z] },
      { x: 0, y: 0, z: 2 },
    ),
    longNormalized: read(
      { diffuse: [0.25, 0.25, 0.25, 1], normalizeNormals: true },
      { lights: [LIGHT_DOWN_Z] },
      { x: 0, y: 0, z: 2 },
    ),
    // Saturated before the texture: 2 × 0.5 would be 1 had the vertex not clamped first.
    clampedBeforeTexture: read(
      { ...overbright, texture: SAMPLER },
      { lights: [LIGHT_DOWN_Z], ambient: { x: 1, y: 1, z: 1 } },
    ),
    noTextureIsWhite: read(lit, { lights: [LIGHT_DOWN_Z] }),
  }

  // Modulate 2X, which clamps. The cube is 0.75 everywhere, then 0.25.
  environment(Array.from({ length: 6 }, () => [191, 191, 191]))
  report['twoXClamps'] = read(
    { diffuse: [0.8, 0.8, 0.8, 1], environment: 'cube', normalizeNormals: true },
    { lights: [LIGHT_DOWN_Z] },
  )
  environment(Array.from({ length: 6 }, () => [64, 64, 64]))
  report['twoX'] = read(
    { diffuse: [0.8, 0.8, 0.8, 1], environment: 'cube', normalizeNormals: true },
    { lights: [LIGHT_DOWN_Z] },
  )

  // Each cube face a colour of its own, so the reflection names the face it lands on.
  environment([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
  ])
  const white = {
    diffuse: [1, 1, 1, 1] as Draw['diffuse'],
    environment: 'cube',
    normalizeNormals: true,
  }
  const bright = { lights: [LIGHT_DOWN_Z], ambient: { x: 1, y: 1, z: 1 } }
  const whiteAmbient = { ...white, ambient: { x: 1, y: 1, z: 1 } }
  // Facing the eye, the reflection is back along +Z in view space, -Z in D3D's flipped space.
  report['reflectBack'] = read(whiteAmbient, bright)
  const tilted = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }
  report['reflectSide'] = read(whiteAmbient, bright, tilted)

  const quarter: Matrix3 = {
    x: { x: 0, y: 0, z: 1 },
    y: { x: 0, y: 1, z: 0 },
    z: { x: -1, y: 0, z: 0 },
  }
  const view = Matrix4.fromRotationTranslation(quarter)
  // The world undoes the view for positions, so the triangle stays put. The light, in world space,
  // is only right if the view turns it: world +X becomes view -Z, shining at the normal.
  report['turnedView'] = read(
    { ...lit, world: Matrix4.invert(view) },
    { view, lights: [{ color: { x: 1, y: 1, z: 1 }, direction: { x: 1, y: 0, z: 0 } }] },
  )

  // D3DCMP_GREATER on 8 bits.
  const faded = { emissive: { x: 1, y: 1, z: 1 }, diffuse: [0, 0, 0, 0.5] as Draw['diffuse'] }
  report['alphaKept'] = read({ ...faded, alphaReference: 127 })
  report['alphaCut'] = read({ ...faded, alphaReference: 128 })
  report['alphaZero'] = read({ emissive: { x: 1, y: 1, z: 1 }, diffuse: [0, 0, 0, 0] })

  // Stage 1 over a lit 128, with a 128 texture: 128 + 128, and 2 x 128 x 128.
  gl.activeTexture(gl.TEXTURE0 + SECOND_UNIT)
  gl.bindTexture(gl.TEXTURE_2D, createTexture(gl, planUpload(solid(128))))
  gl.bindSampler(SECOND_UNIT, nearest)
  const stageTexture = { name: 's', uvSet: 0 } as NonNullable<Draw['texture']>
  const half = { emissive: { x: 0.5, y: 0.5, z: 0.5 } }
  report['add'] = read({ ...half, second: { operation: 'add', texture: stageTexture } })
  report['addSaturates'] = read({
    emissive: { x: 1, y: 1, z: 1 },
    second: { operation: 'add', texture: stageTexture },
  })
  report['modulate2x'] = read({
    ...half,
    second: { operation: 'modulate2x', texture: stageTexture },
  })
  report['modulate2xEmpty'] = read({ ...half, second: { operation: 'modulate2x' } })

  // D3DCOLOR's bytes, B G R A.
  gl.vertexAttrib4f(ATTRIBUTE_LOCATIONS.diffuse, 0.25, 0.5, 1, 0.5)
  const coloured = { colorVertex: true, diffuse: [0, 0, 0, 1] as Draw['diffuse'] }
  report['vertexColor'] = read({ ...coloured, alphaReference: 127 }, { lights: [LIGHT_DOWN_Z] })
  report['vertexColorAlpha'] = read(
    { ...coloured, alphaReference: 128 },
    { lights: [LIGHT_DOWN_Z] },
  )
  report['vertexColorOff'] = read(
    { diffuse: [0, 1, 0, 1], colorVertex: false },
    { lights: [LIGHT_DOWN_Z] },
  )

  report['error'] = [gl.getError()]
  return report
}) satisfies Fixture<DcDtReport>
