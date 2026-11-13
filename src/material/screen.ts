/**
 * Screen quads: pre-transformed D3D vertices (`XYZRHW | DIFFUSE | TEX1`, FVF `0x1c4`), as
 * `ScreenQuadFlush` (`src/freelancer/Client/screen_quad_state.cpp`) draws a batch. Texture times the
 * vertex's colour, added and unlit, and fogged as the frame left it: the flush never touches
 * `FOGENABLE`, and `SpaceEffectsDrawFrame` runs it under the effects' table fog in a nebula
 * (`SpaceObjDrawPass`, `0x51c741`), which goes by W, `1 / rhw`. Fogged quads are uncaptured.
 */
import { createProgram, type Program } from '#/gl/program.js'
import { FOG_GLSL, FOG_UNIFORMS, setFog } from './fog.js'
import type { Fog } from '#/scene/nebula.js'
import type { ScreenQuad } from '#/scene/flare.js'
import type { ScreenQuadBatch } from '#/scene/frame.js'
import { DIFFUSE_UNIT } from './dcdt.js'

const UNIFORMS = ['u_viewport', 'u_texture', ...FOG_UNIFORMS] as const

const vertex = /* glsl */ `#version 300 es
precision highp float;

// X and Y in D3D pixels, Z, and 1 / w.
layout(location = 0) in vec4 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec2 a_uv;

uniform vec2 u_viewport;

out vec2 v_uv;
out vec4 v_color;

void main() {
  v_uv = a_uv;
  v_color = a_color;
  // D3D8 centres a pixel on its integer coordinate, GL half a pixel on, and Y runs down.
  vec2 window = vec2(a_position.x + 0.5, u_viewport.y - a_position.y - 0.5);
  vec3 ndc = vec3(window / u_viewport * 2.0 - 1.0, a_position.z * 2.0 - 1.0);
  // Dividing by rhw gives clip = (ndc * w, w): GL's divide returns ndc, and gl_FragCoord.w is rhw.
  gl_Position = vec4(ndc, 1.0) / a_position.w;
}
`

const fragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;

uniform sampler2D u_texture;
${FOG_GLSL}

out vec4 fragColor;

void main() {
  fragColor = v_color * texture(u_texture, v_uv);
  // The effects before leave D3DRS_ALPHAREF 0, GREATER on (\`space_order\`'s draw 130).
  if (!(floor(fragColor.a * 255.0 + 0.5) > 0.0)) discard;
  fragColor.rgb = fogged(fragColor.rgb);
}
`

// Floats a vertex: X, Y, Z, 1 / w, then U and V; its colour follows as four bytes.
const FLOATS = 6
const STRIDE = FLOATS * 4 + 4

/** `FlushOneBatch`'s corners for a record: (x0, y0), (x0, y1), (x1, y1), (x1, y0). */
const writeQuads = (quads: readonly ScreenQuad[]): ArrayBuffer => {
  const buffer = new ArrayBuffer(quads.length * 4 * STRIDE)
  const floats = new Float32Array(buffer)
  const bytes = new Uint8Array(buffer)

  quads.forEach(({ x0, y0, x1, y1, z, rhw, u0, v0, u1, v1, color }, n) => {
    const corners = [
      [x0, y0, u0, v0],
      [x0, y1, u0, v1],
      [x1, y1, u1, v1],
      [x1, y0, u1, v0],
    ] as const

    corners.forEach(([x, y, u, v], corner) => {
      // `at` is the vertex's byte offset: its floats start at `at / 4`, its colour bytes at `at + 24`.
      const at = (n * 4 + corner) * STRIDE

      floats.set([x, y, z, rhw, u, v], at / 4)
      // `0xAARRGGBB` as R, G, B, A.
      bytes.set([(color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff, color >>> 24], at + 24)
    })
  })
  return buffer
}

/** Two triangles a quad: `{b, b+1, b+2, b, b+2, b+3}`. */
const indicesFor = (count: number): Uint16Array => {
  const indices = new Uint16Array(count * 6)

  for (let quad = 0; quad < count; quad++)
    indices.set(
      [0, 1, 2, 0, 2, 3].map((offset) => quad * 4 + offset),
      quad * 6,
    )

  return indices
}

export interface ScreenQuadRenderer {
  /** Draws each batch with its texture bound by `bindTexture` to `DIFFUSE_UNIT`, under `fog`. */
  draw: (
    batches: readonly ScreenQuadBatch[],
    viewport: { width: number; height: number },
    bindTexture: (batch: ScreenQuadBatch) => void,
    fog?: Fog,
  ) => void
  dispose: () => void
}

export const createScreenQuadRenderer = (gl: WebGL2RenderingContext): ScreenQuadRenderer => {
  const program: Program<(typeof UNIFORMS)[number]> = createProgram(gl, vertex, fragment, UNIFORMS)
  const vertices = gl.createBuffer()
  const indices = gl.createBuffer()
  const array = gl.createVertexArray()

  gl.bindVertexArray(array)
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 24)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 16)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices)
  gl.bindVertexArray(null)

  const draw: ScreenQuadRenderer['draw'] = (batches, { width, height }, bindTexture, fog) => {
    gl.useProgram(program.handle)
    gl.uniform2f(program.uniforms.u_viewport, width, height)
    gl.uniform1i(program.uniforms.u_texture, DIFFUSE_UNIT)
    setFog(gl, program.uniforms, fog)
    // `SpaceEffectsDrawFrame` around the flush: LEQUAL, no depth writes; `ScreenQuadFlush` turns
    // culling off, and a batch blends ONE, ONE.
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE)
    gl.bindVertexArray(array)

    for (const batch of batches) {
      if (!batch.quads.length) continue
      bindTexture(batch)
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices)
      gl.bufferData(gl.ARRAY_BUFFER, writeQuads(batch.quads), gl.STREAM_DRAW)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indicesFor(batch.quads.length), gl.STREAM_DRAW)
      gl.drawElements(gl.TRIANGLES, batch.quads.length * 6, gl.UNSIGNED_SHORT, 0)
    }

    gl.bindVertexArray(null)
  }

  const dispose = () => {
    gl.deleteProgram(program.handle)
    gl.deleteBuffer(vertices)
    gl.deleteBuffer(indices)
    gl.deleteVertexArray(array)
  }

  return { draw, dispose }
}
