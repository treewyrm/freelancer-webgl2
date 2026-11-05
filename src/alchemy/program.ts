/** The GL of an effect: a sprite program whose vertex stage carries each record to now, and beams. */
import { BlendingMode, type Blending } from '@treewyrm/freelancer/alchemy'
import { Matrix4, type Vector3 } from '@treewyrm/freelancer/math'
import { createProgram, type Program } from '#/gl/program.js'
import { DIFFUSE_UNIT } from '#/material/dcdt.js'
import { CurveTable, curvesSource, TABLE_WIDTH } from './curves.js'
import type { EffectDraw, SpriteDraw } from './draw.js'
import {
  FACING_CAMERA,
  FACING_DUST,
  FACING_PERPENDICULAR,
  FACING_TRAVEL,
  KIND_BASIC,
  KIND_DUST,
  KIND_PERP,
  KIND_RECT,
  SHAPE_QUAD,
  SHAPE_TRI_TEXTURE,
} from './draw.js'
import { RECORD, type Lane } from './effect.js'

const GREY: Vector3 = { x: 0.8, y: 0.8, z: 0.8 }

const SPRITE_UNIFORMS = [
  'u_projection',
  'u_modelView',
  'u_time',
  'u_kind',
  'u_facing',
  'u_shape',
  'u_blur',
  'u_centered',
  'u_fade',
  'u_extent',
  'u_eye',
  'u_previous',
  'u_step',
  'u_dustFade',
  'u_color',
  'u_alpha',
  'u_slotA',
  'u_slotB',
  'u_slotC',
  'u_roll',
  'u_frame',
  'u_frames',
  'u_curves',
  'u_texture',
  'u_hasTexture',
] as const

const LOCATION = { corner: 0, position: 1, velocity: 2, time: 3, axis: 4 } as const

const spriteVertex = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = ${LOCATION.corner}) in vec2 a_corner;
layout(location = ${LOCATION.position}) in vec3 a_position;
layout(location = ${LOCATION.velocity}) in vec3 a_velocity;
// BORN, AGE, LIFE.
layout(location = ${LOCATION.time}) in vec3 a_time;
layout(location = ${LOCATION.axis}) in vec3 a_axis;

uniform mat4 u_projection;
uniform mat4 u_modelView;
uniform float u_time;
uniform int u_kind;
uniform int u_facing;
uniform int u_shape;
uniform bool u_blur;
uniform bool u_centered;
uniform bool u_fade;
uniform float u_extent;
uniform vec3 u_eye;
uniform mat4 u_previous;
uniform float u_step;
uniform float u_dustFade;
uniform vec4 u_color;
uniform vec4 u_alpha;
uniform vec4 u_slotA;
uniform vec4 u_slotB;
uniform vec4 u_slotC;
uniform vec4 u_roll;
uniform vec4 u_frame;
uniform int u_frames;

out vec2 v_uv;
out vec4 v_color;
${curvesSource}

const float SQRT3 = 1.7320508;
const float TINY = 1e-6;

// The DLL's normalize: the fast inverse square root with one Newton step, up to 0.2% short.
float inverseLength(float squared) {
  float guess = uintBitsToFloat(0x5f3759dfu - (floatBitsToUint(squared) >> 1));
  return (1.5 - 0.5 * squared * guess * guess) * guess;
}

vec3 unit(vec3 v) {
  return v * inverseLength(dot(v, v));
}

// A direction, or the one it falls back on under 1e-6 of length.
vec3 unitOr(vec3 v, vec3 fallback) {
  float squared = dot(v, v);
  float inverse = inverseLength(squared);
  float len = squared * inverse;
  return len <= TINY ? fallback : v / len;
}

// 0x6238ecb: under 30° of end-on it falls, and under 10° it's gone.
float fadeOf(float c) {
  if (c > 0.984808) return -1.0;
  if (c <= 0.866025) return 1.0;
  float f = (0.984808 - c) * 8.41876;
  return f * f;
}

void main() {
  float elapsed = u_time - a_time.x;
  float age = a_time.y + elapsed;
  float life = a_time.z;
  bool skip = age > life;
  vec3 p = a_position + a_velocity * elapsed;
  vec3 v = a_velocity;

  float key = clamp(life > 0.0 ? age / life : 0.0, 0.0, 1.0);
  vec3 tint = slotColor(u_color, key);
  float alpha = slotFloat(u_alpha, key);
  float slotA = slotFloat(u_slotA, key);
  float slotB = slotFloat(u_slotB, key);
  float slotC = slotFloat(u_slotC, key);
  float frame = slotFloat(u_frame, key);
  float roll = 0.0;
  float halfX;
  float halfY;

  // Each routine's own skips, after the LOD and on the sign.
  if (u_kind == ${KIND_BASIC}) {
    skip = skip || !(alpha >= 0.01);
    halfX = slotA * u_extent * slotB;
    halfY = slotA * u_extent;
    roll = slotFloat(u_roll, key);
  } else if (u_kind == ${KIND_PERP}) {
    halfX = halfY = slotA * u_extent * 0.5;
    skip = skip || !(halfX > TINY) || !(alpha > TINY);
  } else if (u_kind == ${KIND_RECT}) {
    float k = slotC * u_extent;
    halfX = slotA * k / 2.0;
    halfY = slotB * k / 2.0;
    skip = skip || !(slotB * k > TINY) || !(halfX > TINY) || !(alpha > 1e-4);
  } else if (u_kind == ${KIND_DUST}) {
    halfX = halfY = slotA * 0.5;
    frame = 0.0;
  } else {
    float k = slotC * u_extent;
    skip = skip || k < 1e-11 || alpha == 0.0;
    halfX = slotA * k;
    halfY = slotB * k;
  }

  vec4 rect = u_frames < 0 ? vec4(0.0, 0.0, 1.0, 1.0) : frameRect(u_frames, frame);
  float cx = a_corner.x;
  float cy = a_corner.y;
  // (-1, 1) is (u1, v1) and (1, -1) is (u2, v2).
  vec2 through = vec2(cx < 0.0 ? 0.0 : 1.0, cy > 0.0 ? 0.0 : 1.0);
  vec4 clip;

  if (u_facing == ${FACING_CAMERA} || u_facing == ${FACING_DUST}) {
    // Built in the view plane: an appearance's scale moves these and never resizes them.
    vec3 c = (u_modelView * vec4(p, 1.0)).xyz;
    vec2 corner;
    float depth = c.z;

    if (u_facing == ${FACING_CAMERA}) {
      float cosine = cos(roll);
      float sine = sin(roll);
      vec2 x = vec2(cosine, -sine);
      vec2 y = vec2(sine, cosine);

      if (u_shape != ${SHAPE_QUAD}) {
        bool mapped = u_shape == ${SHAPE_TRI_TEXTURE};
        if (cx < 0.0 && cy > 0.0) {
          corner = c.xy + y * (2.0 * halfY);
          through = mapped ? vec2(0.0, 1.0) : vec2(0.5, 0.0);
        } else if (cy > 0.0) {
          corner = c.xy + x * (SQRT3 * halfY) - y * halfY;
          through = vec2(1.0, 1.0);
        } else {
          corner = c.xy - x * (SQRT3 * halfY) - y * halfY;
          through = mapped ? vec2(0.0, 0.0) : vec2(0.0, 1.0);
        }
      } else if (u_blur) {
        // 0x62168a4: from a thirtieth of a second back to here, along the motion across the view.
        vec3 velocity = mat3(u_modelView) * v;
        vec3 w = unit(cross(cross(c, velocity), c));
        vec2 tail = c.xy - w.xy * (dot(velocity, w) / 30.0);
        vec2 along = w.xy * halfY;
        vec2 across = vec2(-w.y, w.x) * halfX;
        corner = (cy > 0.0 ? tail - along : c.xy + along) - across * cx;
      } else {
        corner = c.xy + x * (halfX * cx) + y * (halfY * cy);
      }
    } else {
      // 0x620fcb0: a kite along how far it moved across the view since the last frame.
      vec3 q = (u_previous * vec4(p - v * u_step, 1.0)).xyz;
      vec3 d = c - q;
      vec3 w = unit(cross(cross(c, d), c));
      float s = 0.0175 * dot(d, w) / u_step;
      if (s < 0.025) w = vec3(0.0, 1.0, 0.0);
      vec3 along = w * (min(s, 100.0) + halfY);
      vec2 side = vec2(-w.y, w.x) * halfY;
      alpha *= u_dustFade;
      skip = skip || c.z > -1.0 || q.z > -1.0 || !(alpha > 0.01);
      vec3 view;
      if (cx < 0.0 && cy > 0.0) {
        view = vec3(c.xy - side, c.z);
        through = vec2(0.0, 0.0);
      } else if (cx > 0.0 && cy < 0.0) {
        view = vec3(c.xy + side, c.z);
        through = vec2(1.0, 1.0);
      } else if (cy > 0.0) {
        view = c + along * 0.65;
        through = vec2(0.0, 1.0);
      } else {
        view = c - along / 0.65;
        through = vec2(1.0, 0.0);
      }
      corner = view.xy;
      depth = view.z;
    }
    clip = u_projection * vec4(corner, depth, 1.0);
  } else {
    // Built in the appearance's frame, so its scale reaches the quad.
    vec3 local;
    float c;
    float least = 0.0;

    if (u_facing == ${FACING_TRAVEL}) {
      // 0x6238a70: along the velocity in space, turned about it to face the eye.
      vec3 d = unitOr(v, vec3(0.0, 1.0, 0.0));
      float speed = length(v);
      vec3 e = p - u_eye;
      vec3 side = cross(d, e);
      float l = length(side);
      skip = skip || !(l > TINY);
      side = l > 0.0 ? side / l : vec3(1.0, 0.0, 0.0);
      float len = 2.0 * halfY + (u_blur ? speed * 0.0333333 : 0.0);
      vec3 front = u_centered ? p + d * (0.5 * len) : p + d * len;
      vec3 back = u_centered ? p - d * (0.5 * len) : p;
      local = (cy > 0.0 ? front : back) - side * (halfX * cx);
      c = abs(dot(d, unitOr(e, vec3(0.0, 1.0, 0.0))));
      least = 1e-4;
    } else {
      vec3 x;
      vec3 y;
      vec3 n;
      if (u_facing == ${FACING_PERPENDICULAR}) {
        // 0x6233330: the velocity normal to it, and the roll the seed's projection across it.
        float squared = dot(v, v);
        bool still = squared * inverseLength(squared) <= TINY;
        bool onY = all(lessThanEqual(abs(a_axis - vec3(0.0, 1.0, 0.0)), vec3(1e-4)));
        // Divided by its fast length, then crossed, so the extents run up to 0.2% short (\`effect_sprites\`).
        n = still ? (onY ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)) : v / (squared * inverseLength(squared));
        vec3 across = unit(cross(a_axis, n));
        x = cross(n, across);
        y = -across;
        least = TINY;
      } else {
        x = vec3(1.0, 0.0, 0.0);
        y = vec3(0.0, 1.0, 0.0);
        n = vec3(0.0, 0.0, 1.0);
      }
      local = p + x * (halfX * cx) + y * (halfY * cy);
      c = 1.0 - abs(dot(unitOr(u_eye - p, vec3(0.0, 1.0, 0.0)), n));
    }
    if (u_fade) {
      float f = fadeOf(c);
      if (f < 0.0) skip = true;
      else alpha *= f;
      if (!(alpha > least)) skip = true;
    }
    clip = u_projection * (u_modelView * vec4(local, 1.0));
  }

  v_uv = vec2(mix(rect.x, rect.z, through.x), mix(rect.y, rect.w, through.y));
  // The vertex colour: into the top byte with no clamp, so it wraps.
  v_color = vec4(tint, mod(trunc(alpha * 255.0), 256.0) / 255.0);
  gl_Position = skip ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
}
`

const beamVertex = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_projection;
uniform mat4 u_modelView;

out vec2 v_uv;
out vec4 v_color;

void main() {
  v_uv = a_uv;
  v_color = a_color;
  gl_Position = u_projection * (u_modelView * vec4(a_position, 1.0));
}
`

// Modulated by the texture when there's one. 21 retail appearances name none, and draw flat.
const fragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;

uniform sampler2D u_texture;
uniform bool u_hasTexture;

out vec4 fragColor;

void main() {
  fragColor = u_hasTexture ? v_color * texture(u_texture, v_uv) : v_color;
  // D3DRS_ALPHAREF 0, GREATER (\`effect_sprites\`), compared at 8 bits.
  if (!(floor(fragColor.a * 255.0 + 0.5) > 0.0)) discard;
}
`

// A triangle to a line: no culling, so the winding means nothing.
// prettier-ignore
const CORNERS = new Float32Array([
  -1, 1, 1, 1, 1, -1,
  -1, 1, 1, -1, -1, -1,
])

const TEXTURE_UNIT = DIFFUSE_UNIT
const CURVES_UNIT = 3

const factor = (gl: WebGL2RenderingContext, mode: BlendingMode): number | undefined => {
  switch (mode) {
    case BlendingMode.Zero:
      return gl.ZERO
    case BlendingMode.One:
      return gl.ONE
    case BlendingMode.SourceColor:
      return gl.SRC_COLOR
    case BlendingMode.InverseSourceColor:
      return gl.ONE_MINUS_SRC_COLOR
    case BlendingMode.SourceAlpha:
      return gl.SRC_ALPHA
    case BlendingMode.InverseSourceAlpha:
      return gl.ONE_MINUS_SRC_ALPHA
    case BlendingMode.DestinationAlpha:
      return gl.DST_ALPHA
    case BlendingMode.InverseDestinationAlpha:
      return gl.ONE_MINUS_DST_ALPHA
    case BlendingMode.DestinationColor:
      return gl.DST_COLOR
    case BlendingMode.InverseDestinationColor:
      return gl.ONE_MINUS_DST_COLOR
    case BlendingMode.SourceAlphaSAT:
      return gl.SRC_ALPHA_SATURATE
    default:
      return undefined
  }
}

/**
 * The two render states, straight from the node (`0x6217760`). Absent is `{5, 2}`. **Uncaptured:** a
 * present `None`, 0, is no D3D value, so what the driver does is unknown (22 retail nodes); and a
 * both-mode as a destination, which D3D rejects (one node), is read as the plain factor.
 */
export const blendFactors = (gl: WebGL2RenderingContext, blend?: Blending): [number, number] => {
  const fallback: [number, number] = [gl.SRC_ALPHA, gl.ONE]
  if (!blend || blend.source === BlendingMode.None) return fallback
  if (blend.source === BlendingMode.BothSourceAlpha) return [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA]
  if (blend.source === BlendingMode.BothInverseSourceAlpha)
    return [gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA]
  const source = factor(gl, blend.source) ?? fallback[0]
  if (blend.target === BlendingMode.BothInverseSourceAlpha) return [source, gl.ONE_MINUS_SRC_ALPHA]
  if (blend.target === BlendingMode.BothSourceAlpha) return [source, gl.SRC_ALPHA]
  return [source, factor(gl, blend.target) ?? fallback[1]]
}

interface LaneBuffers {
  buffer: WebGLBuffer
  array: WebGLVertexArrayObject
  capacity: number
  version: number
  uploaded: number
  bound: number
}

export interface EffectContext {
  gl: WebGL2RenderingContext
  view: Matrix4
  projection: Matrix4
  bindTexture: (draw: EffectDraw) => boolean
}

export interface EffectRenderer {
  draw: (draws: readonly EffectDraw[], context: EffectContext) => void
  dispose: () => void
}

export const createEffectRenderer = (gl: WebGL2RenderingContext): EffectRenderer => {
  let sprite: Program<(typeof SPRITE_UNIFORMS)[number]> | undefined
  let beam: Program<'u_projection' | 'u_modelView' | 'u_texture' | 'u_hasTexture'> | undefined
  let template: WebGLBuffer | undefined
  let beamBuffer: WebGLBuffer | undefined
  let beamArray: WebGLVertexArrayObject | undefined
  let curveTexture: WebGLTexture | undefined
  let curveVersion = -1
  const table = new CurveTable()
  let lanes = new Map<Lane, LaneBuffers>()

  const point = (entry: LaneBuffers, lane: Lane) => {
    if (entry.bound === lane.tail) return
    entry.bound = lane.tail
    const stride = RECORD * 4
    const base = lane.tail * stride
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer)
    gl.vertexAttribPointer(LOCATION.position, 3, gl.FLOAT, false, stride, base)
    gl.vertexAttribPointer(LOCATION.velocity, 3, gl.FLOAT, false, stride, base + 12)
    gl.vertexAttribPointer(LOCATION.time, 3, gl.FLOAT, false, stride, base + 24)
    gl.vertexAttribPointer(LOCATION.axis, 3, gl.FLOAT, false, stride, base + 36)
  }

  const laneOf = (lane: Lane): LaneBuffers => {
    let entry = lanes.get(lane)
    if (!entry) {
      entry = {
        buffer: gl.createBuffer(),
        array: gl.createVertexArray(),
        capacity: 0,
        version: -1,
        uploaded: 0,
        bound: -1,
      }
      lanes.set(lane, entry)
      gl.bindVertexArray(entry.array)
      gl.bindBuffer(gl.ARRAY_BUFFER, template!)
      gl.enableVertexAttribArray(LOCATION.corner)
      gl.vertexAttribPointer(LOCATION.corner, 2, gl.FLOAT, false, 0, 0)
      for (const location of [LOCATION.position, LOCATION.velocity, LOCATION.time, LOCATION.axis]) {
        gl.enableVertexAttribArray(location)
        gl.vertexAttribDivisor(location, 1)
      }
    }
    gl.bindVertexArray(entry.array)
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer)
    // Only births go up, unless a record it already has changed.
    if (entry.capacity !== lane.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, lane.records, gl.DYNAMIC_DRAW)
      entry.capacity = lane.capacity
      entry.bound = -1
    } else if (entry.version !== lane.version) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, lane.records, 0, lane.head * RECORD)
    } else if (entry.uploaded < lane.head) {
      const from = entry.uploaded * RECORD
      gl.bufferSubData(gl.ARRAY_BUFFER, from * 4, lane.records, from, lane.head * RECORD - from)
    }
    entry.version = lane.version
    entry.uploaded = lane.head
    point(entry, lane)
    return entry
  }

  const bindCurves = () => {
    gl.activeTexture(gl.TEXTURE0 + CURVES_UNIT)
    curveTexture ??= gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, curveTexture)
    if (curveVersion !== table.version) {
      const rows = Math.max(1, Math.ceil(table.length / TABLE_WIDTH))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        TABLE_WIDTH,
        rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        table.texels.subarray(0, rows * TABLE_WIDTH * 4),
      )
      curveVersion = table.version
    }
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT)
  }

  const spriteUniforms = (draw: SpriteDraw, view: Matrix4, projection: Matrix4) => {
    const { uniforms } = sprite!
    const { lists, sparam } = draw
    const slot = (location: WebGLUniformLocation | null, s: readonly number[]) =>
      gl.uniform4f(location, s[0]!, s[1]!, s[2]!, s[3]!)
    const float = (list: typeof lists.alpha, fallback: number) =>
      table.floatSlot(list, sparam, fallback)
    slot(uniforms.u_color, table.colorSlot(lists.color, sparam, GREY))
    slot(uniforms.u_alpha, float(lists.alpha, 1))
    slot(uniforms.u_slotA, float(lists.a, 1))
    slot(uniforms.u_slotB, float(lists.b, 1))
    slot(uniforms.u_slotC, float(lists.c, 1))
    slot(uniforms.u_roll, float(lists.roll, 0))
    slot(uniforms.u_frame, float(lists.frame, 0))
    gl.uniform1i(
      uniforms.u_frames,
      draw.frames.length > 1 || draw.texture ? table.frames(draw.frames) : -1,
    )
    gl.uniform1i(uniforms.u_kind, lists.kind)
    gl.uniform1i(uniforms.u_facing, draw.facing)
    gl.uniform1i(uniforms.u_shape, draw.shape)
    gl.uniform1i(uniforms.u_blur, draw.blur ? 1 : 0)
    gl.uniform1i(uniforms.u_centered, draw.centered ? 1 : 0)
    gl.uniform1i(uniforms.u_fade, draw.fade ? 1 : 0)
    gl.uniform1f(uniforms.u_extent, draw.extent)
    gl.uniform1f(uniforms.u_time, draw.time)
    gl.uniform3f(uniforms.u_eye, draw.eye.x, draw.eye.y, draw.eye.z)
    gl.uniformMatrix4fv(uniforms.u_projection, false, Matrix4.toArray(projection))
    gl.uniformMatrix4fv(
      uniforms.u_modelView,
      false,
      Matrix4.toArray(Matrix4.multiply(view, draw.world)),
    )
    if (draw.dust) {
      gl.uniformMatrix4fv(uniforms.u_previous, false, Matrix4.toArray(draw.dust.previous))
      gl.uniform1f(uniforms.u_step, draw.dust.step)
      gl.uniform1f(uniforms.u_dustFade, draw.dust.fade)
    }
  }

  const draw = (
    draws: readonly EffectDraw[],
    { view, projection, bindTexture }: EffectContext,
  ): void => {
    if (!draws.length) return
    sprite ??= createProgram(gl, spriteVertex, fragment, SPRITE_UNIFORMS)
    beam ??= createProgram(gl, beamVertex, fragment, [
      'u_projection',
      'u_modelView',
      'u_texture',
      'u_hasTexture',
    ] as const)
    if (!template) {
      template = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, template)
      gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW)
    }

    // `0x62019e0`: lighting off, no Z writes, no culling, blending on. Fog is M7's.
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.depthMask(false)
    gl.depthFunc(gl.LESS)

    // Encoded first: the texture must hold every list before any sprite reads one.
    for (const each of draws)
      if (each.type === 'sprite') {
        const { lists, sparam } = each
        table.colorSlot(lists.color, sparam, GREY)
        for (const [list, fallback] of [
          [lists.alpha, 1],
          [lists.a, 1],
          [lists.b, 1],
          [lists.c, 1],
          [lists.roll, 0],
          [lists.frame, 0],
        ] as const)
          table.floatSlot(list, sparam, fallback)
        if (each.frames.length > 1 || each.texture) table.frames(each.frames)
      }
    bindCurves()

    for (const each of draws) {
      const [source, destination] = blendFactors(gl, each.blend)
      // Retail's target has no alpha to keep (`li_elite`).
      gl.blendFuncSeparate(source, destination, gl.ZERO, gl.ONE)
      const hasTexture = bindTexture(each)
      if (each.type === 'sprite') {
        gl.useProgram(sprite.handle)
        gl.uniform1i(sprite.uniforms.u_texture, TEXTURE_UNIT)
        gl.uniform1i(sprite.uniforms.u_curves, CURVES_UNIT)
        gl.uniform1i(sprite.uniforms.u_hasTexture, hasTexture ? 1 : 0)
        spriteUniforms(each, view, projection)
        const { lane } = each
        laneOf(lane)
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, lane.head - lane.tail)
        continue
      }
      gl.useProgram(beam.handle)
      gl.uniform1i(beam.uniforms.u_texture, TEXTURE_UNIT)
      gl.uniform1i(beam.uniforms.u_hasTexture, hasTexture ? 1 : 0)
      gl.uniformMatrix4fv(beam.uniforms.u_projection, false, Matrix4.toArray(projection))
      gl.uniformMatrix4fv(
        beam.uniforms.u_modelView,
        false,
        Matrix4.toArray(Matrix4.multiply(view, each.world)),
      )
      beamBuffer ??= gl.createBuffer()
      if (!beamArray) {
        beamArray = gl.createVertexArray()
        gl.bindVertexArray(beamArray)
        gl.bindBuffer(gl.ARRAY_BUFFER, beamBuffer)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 12)
        gl.enableVertexAttribArray(2)
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 28)
      }
      gl.bindVertexArray(beamArray)
      gl.bindBuffer(gl.ARRAY_BUFFER, beamBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, each.vertices, gl.STREAM_DRAW)
      gl.drawArrays(gl.TRIANGLES, 0, each.count)
    }
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.activeTexture(gl.TEXTURE0 + CURVES_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.activeTexture(gl.TEXTURE0)
    gl.depthMask(true)

    // A lane no draw named this frame is gone, or empty, and its effect may be too.
    const named = new Set(draws.flatMap((each) => (each.type === 'sprite' ? [each.lane] : [])))
    for (const [lane, entry] of lanes)
      if (!named.has(lane)) {
        gl.deleteBuffer(entry.buffer)
        gl.deleteVertexArray(entry.array)
        lanes.delete(lane)
      }
  }

  const dispose = () => {
    for (const entry of lanes.values()) {
      gl.deleteBuffer(entry.buffer)
      gl.deleteVertexArray(entry.array)
    }
    lanes = new Map()
    if (sprite) gl.deleteProgram(sprite.handle)
    if (beam) gl.deleteProgram(beam.handle)
    if (template) gl.deleteBuffer(template)
    if (beamBuffer) gl.deleteBuffer(beamBuffer)
    if (beamArray) gl.deleteVertexArray(beamArray)
    if (curveTexture) gl.deleteTexture(curveTexture)
    sprite = beam = undefined
    template = beamBuffer = beamArray = curveTexture = undefined
  }

  return { draw, dispose }
}
