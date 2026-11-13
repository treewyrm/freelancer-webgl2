import type { CubeTexture, Texture } from '@treewyrm/freelancer/texture'
import { createProgram } from '#/gl/program.js'
import type { Fixture } from '#/harness.js'
import {
  createSampler,
  createTexture,
  DEFAULT_SAMPLER,
  type SamplerState,
  type TextureWrap,
} from './texture.js'
import { planUpload } from './upload.js'

export type TextureReport = Record<string, number[]>

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  gl_Position = vec4(corner * 4.0 - 1.0, 0.0, 1.0);
}`

const fragment = (sampler: string, lookup: string) => `#version 300 es
precision highp float;
uniform ${sampler} image;
uniform vec3 at;
uniform float lod;
uniform bool alpha;
out vec4 color;
void main() {
  vec4 texel = textureLod(image, ${lookup}, lod);
  color = vec4(alpha ? texel.aaa : texel.rgb, 1.0);
}`

const flat = (fields: Partial<Texture>): Texture => ({
  name: 'test',
  type: 'image',
  storage: 'targa',
  format: 'rgba32_8888',
  width: 2,
  height: 2,
  flip: false,
  levels: [],
  ...fields,
})

const NEAREST: SamplerState = { ...DEFAULT_SAMPLER, magnify: 'nearest', minify: 'nearest' }

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const BLUE = [0, 0, 255, 255]
const WHITE = [255, 255, 255, 255]

// Texel (0,0) red, (1,0) green; the second row blue and white. Row 0 is the first uploaded.
const CORNERS = new Uint8Array([...RED, ...GREEN, ...BLUE, ...WHITE])

const block = (color0: number, color1: number, rows: number[]) => [
  color0 & 0xff,
  color0 >> 8,
  color1 & 0xff,
  color1 >> 8,
  ...rows,
]

export default ((gl) => {
  const flatProgram = createProgram(gl, VERTEX, fragment('sampler2D', 'at.xy'), [
    'at',
    'lod',
    'alpha',
  ])
  const cubeProgram = createProgram(gl, VERTEX, fragment('samplerCube', 'at'), [
    'at',
    'lod',
    'alpha',
  ])

  gl.bindVertexArray(gl.createVertexArray())

  const read = (
    texture: WebGLTexture,
    sampler: WebGLSampler,
    at: number[],
    { lod = 0, alpha = false, cube = false } = {},
  ): number[] => {
    const { handle, uniforms } = cube ? cubeProgram : flatProgram

    gl.useProgram(handle)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, texture)
    gl.bindSampler(0, sampler)
    gl.uniform3f(uniforms.at, at[0]!, at[1]!, at[2] ?? 0)
    gl.uniform1f(uniforms.lod, lod)
    gl.uniform1i(uniforms.alpha, alpha ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    const pixel = new Uint8Array(4)

    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return [...pixel]
  }

  const nearest = createSampler(gl, NEAREST)
  const report: TextureReport = {}

  // V = 0 samples the first row uploaded; a top-left Targa's rows go in reversed.
  const stored = createTexture(gl, planUpload(flat({ levels: [CORNERS] })))

  report['v0'] = read(stored, nearest, [0.25, 0.25])
  report['v1'] = read(stored, nearest, [0.25, 0.75])
  report['u1'] = read(stored, nearest, [0.75, 0.25])

  const reversed = createTexture(gl, planUpload(flat({ flip: true, levels: [CORNERS] })))

  report['flippedV0'] = read(reversed, nearest, [0.25, 0.25])

  // Six bytes a row, so this fails at the default unpack alignment.
  const wide = createTexture(
    gl,
    planUpload(
      flat({
        format: 'rgb24_888',
        width: 3,
        height: 2,
        levels: [
          new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0]),
        ],
      }),
    ),
  )

  report['rgb565'] = read(wide, nearest, [0.17, 0.25])
  report['rgb565Green'] = read(wide, nearest, [0.5, 0.25])
  report['rgb565Second'] = read(wide, nearest, [0.17, 0.75])

  // A1R5G5B5 surface: opaque red, then transparent blue.
  const punch = createTexture(
    gl,
    planUpload(
      flat({
        storage: 'dds',
        format: 'rgba16_5551',
        height: 1,
        levels: [new Uint8Array([0x00, 0xfc, 0x1f, 0x00])],
      }),
    ),
  )

  report['rgb5a1'] = read(punch, nearest, [0.25, 0.5])
  report['rgb5a1Alpha'] = read(punch, nearest, [0.25, 0.5], { alpha: true })
  report['rgb5a1Second'] = read(punch, nearest, [0.75, 0.5])
  report['rgb5a1SecondAlpha'] = read(punch, nearest, [0.75, 0.5], { alpha: true })

  // DXT1 in its three-colour mode: first row red, the rest index 3, transparent black.
  const dxt1 = createTexture(
    gl,
    planUpload(
      flat({
        storage: 'dds',
        format: 'dxt1',
        width: 4,
        height: 4,
        levels: [new Uint8Array(block(0x0000, 0xf800, [0x55, 0xff, 0xff, 0xff]))],
      }),
    ),
  )

  report['dxt1'] = read(dxt1, nearest, [0.125, 0.125])
  report['dxt1Alpha'] = read(dxt1, nearest, [0.125, 0.125], { alpha: true })
  report['dxt1Punched'] = read(dxt1, nearest, [0.125, 0.625])
  report['dxt1PunchedAlpha'] = read(dxt1, nearest, [0.125, 0.625], { alpha: true })

  // DXT5: alpha 0x80 throughout, over solid green.
  const dxt5 = createTexture(
    gl,
    planUpload(
      flat({
        storage: 'dds',
        format: 'dxt5',
        width: 4,
        height: 4,
        levels: [
          new Uint8Array([0x80, 0x80, 0, 0, 0, 0, 0, 0, ...block(0x07e0, 0x07e0, [0, 0, 0, 0])]),
        ],
      }),
    ),
  )

  report['dxt5'] = read(dxt5, nearest, [0.5, 0.5])
  report['dxt5Alpha'] = read(dxt5, nearest, [0.5, 0.5], { alpha: true })

  // A chain stopping at 4x4 is complete: 8x8 red, 4x4 blue.
  const chain = createTexture(
    gl,
    planUpload(
      flat({
        storage: 'dds',
        format: 'dxt1',
        width: 8,
        height: 8,
        levels: [
          new Uint8Array(
            Array.from({ length: 4 }, () => block(0xf800, 0xf800, [0, 0, 0, 0])).flat(),
          ),
          new Uint8Array(block(0x001f, 0x001f, [0, 0, 0, 0])),
        ],
      }),
    ),
  )
  const hull = createSampler(gl, DEFAULT_SAMPLER)

  report['chainLevel0'] = read(chain, hull, [0.5, 0.5])
  report['chainLevel1'] = read(chain, hull, [0.5, 0.5], { lod: 1 })
  // No blending between levels on the default sampler; a fractional level picks the nearer one.
  report['chainNoBlend'] = read(chain, hull, [0.5, 0.5], { lod: 0.25 })

  // Bilinear within a level: halfway across two texels of an RGBA row.
  const line = createTexture(
    gl,
    planUpload(flat({ height: 1, levels: [new Uint8Array([...RED, ...BLUE])] })),
  )
  const edge: SamplerState = { ...DEFAULT_SAMPLER, wrapU: 'clamp', wrapV: 'clamp' }

  report['bilinear'] = read(line, createSampler(gl, edge), [0.5, 0.5])

  // Past the edge, by each wrap.
  const wrapped = (wrapU: TextureWrap) =>
    read(line, createSampler(gl, { ...NEAREST, wrapU }), [1.25, 0.5])

  report['wrapRepeat'] = wrapped('repeat')
  report['wrapMirror'] = wrapped('mirror')
  report['wrapClamp'] = wrapped('clamp')

  // Each face where the cube's axis points, and the generated level at the top of the chain.
  const solid = (r: number, g: number, b: number) => {
    const level = new Uint8Array(4 * 4 * 4)
    // Stored BGRA, as the library hands a cube over.
    for (let at = 0; at < level.length; at += 4) level.set([b, g, r, 255], at)
    return [level]
  }

  const cube: CubeTexture = {
    name: 'cube',
    type: 'cube',
    format: 'rgba32_8888',
    width: 4,
    height: 4,
    flip: true,
    faces: [
      solid(255, 0, 0),
      solid(0, 255, 0),
      solid(0, 0, 255),
      solid(255, 255, 0),
      solid(255, 0, 255),
      solid(0, 255, 255),
    ],
  }
  const cubeTexture = createTexture(gl, planUpload(cube))

  report['cubePosX'] = read(cubeTexture, hull, [1, 0, 0], { cube: true })
  report['cubeNegX'] = read(cubeTexture, hull, [-1, 0, 0], { cube: true })
  report['cubePosY'] = read(cubeTexture, hull, [0, 1, 0], { cube: true })
  report['cubeNegY'] = read(cubeTexture, hull, [0, -1, 0], { cube: true })
  report['cubePosZ'] = read(cubeTexture, hull, [0, 0, 1], { cube: true })
  report['cubeNegZ'] = read(cubeTexture, hull, [0, 0, -1], { cube: true })
  report['cubeLastLevel'] = read(cubeTexture, hull, [0, 0, -1], { cube: true, lod: 2 })

  report['error'] = [gl.getError()]
  return report
}) satisfies Fixture<TextureReport>
