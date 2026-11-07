/** An appearance's eased lists as texels, and GLSL reading them, rule for rule as the library's evaluator. */
import {
  sparamLevel,
  type AnimatedColor,
  type AnimatedFloat,
  type EaseAnimation,
  type FloatKeyframe,
  type VectorKeyframe,
} from '@treewyrm/freelancer/alchemy'
import type { Vector3 } from '@treewyrm/freelancer/math'

export interface UVRect {
  u1: number
  v1: number
  u2: number
  v2: number
}

export const TABLE_WIDTH = 1024

/** The two lists around `sparam`, how far between them, and their easing. */
export type Slot = readonly [lower: number, upper: number, span: number, easing: number]

const constantSlot = (offset: number): Slot => [offset, offset, 0, 1]

/** `_ftol(c × 255)` per channel, spilling as the packed word does. */
const byte = (c: number): number => (c * 255) | 0

/** Whole lists rather than baked ones: baking lost 10% of alpha at the 99th percentile. */
export class CurveTable {
  texels = new Float32Array(TABLE_WIDTH * 4)
  length = 0
  version = 0
  #floats = new WeakMap<EaseAnimation<FloatKeyframe>, number>()
  #colors = new WeakMap<EaseAnimation<VectorKeyframe>, number>()
  #frames = new Map<string, number>()
  #constants = new Map<number, number>()
  #colorConstants = new Map<string, number>()

  #reserve(texels: number): number {
    const offset = this.length
    const needed = (offset + texels) * 4
    if (needed > this.texels.length) {
      let size = this.texels.length
      while (size < needed) size *= 2
      const grown = new Float32Array(size)
      grown.set(this.texels)
      this.texels = grown
    }
    this.length += texels
    this.version++
    return offset
  }

  float(list: EaseAnimation<FloatKeyframe>): number {
    const known = this.#floats.get(list)
    if (known !== undefined) return known
    const { keyframes, easing } = list
    const offset = this.#reserve(1 + Math.ceil(keyframes.length / 2))
    const t = this.texels
    t.set([keyframes.length, easing, 0, 0], offset * 4)
    for (const [n, { key, value }] of keyframes.entries()) {
      const at = (offset + 1) * 4 + n * 2
      t[at] = key
      t[at + 1] = value
    }
    this.#floats.set(list, offset)
    return offset
  }

  color(list: EaseAnimation<VectorKeyframe>): number {
    const known = this.#colors.get(list)
    if (known !== undefined) return known
    const { keyframes, easing } = list
    const offset = this.#reserve(1 + keyframes.length)
    const t = this.texels
    t.set([keyframes.length, easing, 1, 0], offset * 4)
    for (const [n, { key, value }] of keyframes.entries()) {
      const word = (((byte(value.y) | (byte(value.x) << 8)) << 8) | byte(value.z)) >>> 0
      t.set([key, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff], (offset + 1 + n) * 4)
    }
    this.#colors.set(list, offset)
    return offset
  }

  constant(value: number): number {
    const known = this.#constants.get(value)
    if (known !== undefined) return known
    const offset = this.float({ easing: 1, keyframes: [{ key: 0, value }] })
    this.#constants.set(value, offset)
    return offset
  }

  /** The rects, after a header of their count and the frame a `-1` picks. */
  frames(rects: readonly UVRect[], current = 0): number {
    const name = `${current}:${rects.map(({ u1, v1, u2, v2 }) => `${u1},${v1},${u2},${v2}`).join(';')}`
    const known = this.#frames.get(name)
    if (known !== undefined) return known
    const offset = this.#reserve(1 + rects.length)
    this.texels.set([rects.length, current, 0, 0], offset * 4)
    for (const [n, { u1, v1, u2, v2 }] of rects.entries())
      this.texels.set([u1, v1, u2, v2], (offset + 1 + n) * 4)
    this.#frames.set(name, offset)
    return offset
  }

  floatSlot(property: AnimatedFloat | undefined, sparam: number, fallback: number): Slot {
    if (!property) return constantSlot(this.constant(fallback))
    const level = sparamLevel(property, sparam)
    if (!level) return constantSlot(this.constant(0))
    return [this.float(level.lower), this.float(level.upper), level.span, level.easing]
  }

  colorSlot(property: AnimatedColor | undefined, sparam: number, fallback: Vector3): Slot {
    const level = property && sparamLevel(property, sparam)
    if (level) return [this.color(level.lower), this.color(level.upper), level.span, level.easing]
    const value = property ? { x: 0, y: 0, z: 0 } : fallback
    const name = `${value.x},${value.y},${value.z}`
    let offset = this.#colorConstants.get(name)
    if (offset === undefined) {
      offset = this.color({ easing: 1, keyframes: [{ key: 0, value }] })
      this.#colorConstants.set(name, offset)
    }
    return constantSlot(offset)
  }
}

export const curvesSource = /* glsl */ `
uniform highp sampler2D u_curves;

vec4 curveTexel(int i) {
  return texelFetch(u_curves, ivec2(i % ${TABLE_WIDTH}, i / ${TABLE_WIDTH}), 0);
}

float easeWeight(int type, bool rising, float t) {
  if (type == 0) return 0.0;
  if (type == 2) return t * t;
  if (type == 3) return t * (2.0 - t);
  if (type == 4) return t * t * (3.0 - 2.0 * t);
  if (type == 5) return rising ? t * t : t * (2.0 - t);
  if (type == 6) return rising ? t * (2.0 - t) : t * t;
  return t;
}

float easeValue(int type, float a, float b, float t) {
  if (a == b || type == 0) return a;
  float w = easeWeight(type, a < b, t);
  return a * (1.0 - w) + b * w;
}

vec2 floatKey(int header, int n) {
  vec4 texel = curveTexel(header + 1 + n / 2);
  return n % 2 == 0 ? texel.xy : texel.zw;
}

float floatList(int header, float key) {
  vec4 head = curveTexel(header);
  int count = int(head.x);
  if (count == 0) return 0.0;
  vec2 last = floatKey(header, count - 1);
  if (key >= last.x) return last.y;
  int start = -1;
  int end = 0;
  for (int n = 0; n < count; n++) {
    end = n;
    if (key <= floatKey(header, n).x && (start < 0 || floatKey(header, n).x > floatKey(header, start).x)) break;
    start = n;
  }
  vec2 a = floatKey(header, start < 0 ? end : start);
  vec2 b = floatKey(header, end);
  float span = start < 0 ? 0.0 : clamp((key - a.x) / (b.x - a.x), 0.0, 1.0);
  return easeValue(int(head.y), a.y, b.y, span);
}

const float BYTE = 1.0 / 255.0;

vec3 colorList(int header, float key) {
  vec4 head = curveTexel(header);
  int count = int(head.x);
  if (count == 0) return vec3(0.0);
  vec4 last = curveTexel(header + count);
  if (key >= last.x) return last.yzw * BYTE;
  int start = -1;
  int end = 0;
  for (int n = 0; n < count; n++) {
    end = n;
    if (key <= curveTexel(header + 1 + n).x && (start < 0 || curveTexel(header + 1 + n).x > curveTexel(header + 1 + start).x)) break;
    start = n;
  }
  vec4 from = curveTexel(header + 1 + (start < 0 ? end : start));
  vec4 to = curveTexel(header + 1 + end);
  ivec3 a = ivec3(from.yzw);
  int easing = int(head.y);
  if (easing == 0) return vec3(a) * BYTE;
  ivec3 b = ivec3(to.yzw);
  float span = start < 0 ? 0.0 : clamp((key - from.x) / (to.x - from.x), 0.0, 1.0);
  bool rising = a.x * 65536 + a.y * 256 + a.z < b.x * 65536 + b.y * 256 + b.z;
  int w = int(easeWeight(easing, rising, span) * 255.0);
  return vec3((a + (((b - a) * w) >> 8)) & 0xff) * BYTE;
}

float slotFloat(vec4 slot, float key) {
  int lower = int(slot.x);
  int upper = int(slot.y);
  float a = floatList(lower, key);
  if (lower == upper) return a;
  return easeValue(int(slot.w), a, floatList(upper, key), slot.z);
}

vec3 slotColor(vec4 slot, float key) {
  int lower = int(slot.x);
  int upper = int(slot.y);
  vec3 a = colorList(lower, key);
  if (lower == upper) return a;
  int type = int(slot.w);
  if (type == 0) return a;
  vec3 b = colorList(upper, key);
  float f = easeWeight(type, a.x + a.y + a.z < b.x + b.y + b.z, slot.z);
  return a * (1.0 - f) + b * f;
}

// _ftol(position × (count − 1)), then GetFrame's choice (FUN_06ebe7f0): -1 is the playback's
// current frame, and anything else outside is the last.
vec4 frameRect(int header, float position) {
  vec4 head = curveTexel(header);
  int count = int(head.x);
  int index = int(position * float(count - 1));
  if (index == -1) index = int(head.y);
  else if (index < 0 || index >= count) index = count - 1;
  return curveTexel(header + 1 + index);
}
`
