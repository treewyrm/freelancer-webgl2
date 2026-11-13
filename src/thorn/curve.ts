/**
 * Parameter curves: the `IParamCurve` classes in `src/Thorn/ParamCurve.cpp`, and the progress every
 * property animation shares (`FThornEvent::EvaluateProgress`).
 */
import { catmullRom } from '@treewyrm/freelancer/math'
import type { ParamCurve } from '@treewyrm/freelancer/thn/scene'

const f = Math.fround

/** A curve over `[0, 1]`: what `IParamCurve::Evaluate` returns. */
export interface Curve {
  readonly type: string
  evaluate(t: number): number
}

interface Key {
  t: number
  v: number
  in: number
  out: number
}

/** The tangent rule a Hermite curve's keys get on every rebuild (`ApplyHermiteTangents`). */
type Mode = 'step' | 'linear' | 'rampUp' | 'rampDown' | 'smooth' | 'bumpOut' | 'bumpIn' | 'free'

/** `SpecFor`'s table. `LinearPCurve` registers twice; which DACOM returns isn't read, so the list one. */
const TYPES: Record<
  string,
  { kind: 'catmullRom' | 'linear' | 'hermite'; mode?: Mode; floor?: true }
> = {
  CatmullRomPCurve: { kind: 'catmullRom' },
  ThornParamCurve: { kind: 'catmullRom', floor: true },
  LinearPCurve: { kind: 'linear' },
  ThornLPCurve: { kind: 'linear', floor: true },
  SmoothPCurve: { kind: 'hermite', mode: 'smooth' },
  StepPCurve: { kind: 'hermite', mode: 'step' },
  RampUpPCurve: { kind: 'hermite', mode: 'rampUp' },
  RampDownPCurve: { kind: 'hermite', mode: 'rampDown' },
  BumpOutPCurve: { kind: 'hermite', mode: 'bumpOut' },
  BumpInPCurve: { kind: 'hermite', mode: 'bumpIn' },
  FreeFormPCurve: { kind: 'hermite', mode: 'free' },
}

/** `ThornNameEqual`: DACOM finds its classes ignoring case. */
const typeOf = (name: string) =>
  Object.entries(TYPES).find(([key]) => key.toLowerCase() === name.toLowerCase())

/**
 * The keys a curve holds after `points`, in id order: `(0, 0)` and `(1, 1)` first, each row at
 * exactly 0 or 1 replacing one, any other in `[0, 1]` added, and any outside dropped (`AddKey`).
 */
const keysOf = (points: readonly (readonly number[])[]): Key[] => {
  const keys: Key[] = [
    { t: 0, v: 0, in: 0, out: 0 },
    { t: 1, v: 1, in: 0, out: 0 },
  ]

  for (const [t = 0, v = 0, inSlope = 0, outSlope = 0] of points) {
    const key = { t: f(t), v: f(v), in: f(inSlope), out: f(outSlope) }
    if (key.t < 0 || key.t > 1) continue

    if (key.t === 0) keys[0] = key
    else if (key.t === 1) keys[1] = key
    else keys.push(key)
  }

  return keys
}

/** The evaluation list: by time, ties in id order (`SortEvaluationList`'s merge sort is stable). */
const byTime = (keys: readonly Key[]): Key[] => keys.slice().sort((a, b) => a.t - b.t)

/** `ClampNonNegative`: the non-negative classes hold every value at the running maximum. */
const floored = (keys: Key[]): Key[] => {
  let floor = 0

  return keys.map((key) => {
    const v = key.v < floor ? floor : key.v

    floor = v
    return { ...key, v }
  })
}

/** A step key's outgoing slope: the all-ones word `Hermite1D` tests for. */
const STEP = Number.NaN

/** `ApplyHermiteTangents`, over every pair, `dt` held at 1e-4 or more. */
const withTangents = (knots: Key[], mode: Mode): void => {
  for (let index = 0; index + 1 < knots.length; index++) {
    const a = knots[index]!
    const b = knots[index + 1]!
    const dt = f(b.t - a.t) < f(1e-4) ? f(1e-4) : f(b.t - a.t)
    const dv = f(b.v - a.v)
    const slope = f(dv / dt)
    const double = f(dv / f(dt * 0.5))

    if (mode === 'step') a.out = STEP
    else if (mode === 'linear') ((a.out = slope), (b.in = slope))
    else if (mode === 'smooth') ((a.out = 0), (b.in = 0))
    else if (mode === 'rampUp') ((a.out = 0), (b.in = double))
    else if (mode === 'rampDown') ((a.out = double), (b.in = 0))
    else if (mode === 'bumpOut')
      if (a.v <= b.v) ((a.out = double), (b.in = 0))
      else ((a.out = 0), (b.in = double))
    else if (mode === 'bumpIn')
      if (a.v < b.v) ((a.out = 0), (b.in = double))
      else ((a.out = double), (b.in = 0))
  }
}

/**
 * The Hermite knots, rebuilt in id order: each inserted before the first knot at or after its
 * time (`InsertDerivedRecord`), tangents applied after each insertion.
 */
const knotsOf = (keys: readonly Key[], mode: Mode): Key[] => {
  const knots: Key[] = []

  for (const key of keys) {
    const at = knots.findIndex((knot) => knot.t >= key.t)

    knots.splice(at < 0 ? knots.length : at, 0, { ...key })
    withTangents(knots, mode)
  }

  return knots
}

/** `Hermite1D` (`FUN_06f30480`): the file's `(t, v, in, out)` rows are value and slopes. */
const hermite = (a: Key, b: Key, t: number): number => {
  if (a.t === t) return a.v
  if (b.t === t) return b.v

  const dt = b.t - a.t
  const s = f((t - a.t) / dt)

  if (Number.isNaN(a.out)) return a.v

  const s2 = s * s
  const s3 = s2 * s

  // Cubic Hermite basis in `s`: tangent terms scaled by `dt` (out, in), then value terms (a, b).
  return (
    (s3 - 2 * s2 + s) * a.out * dt +
    (s3 - s2) * b.in * dt +
    (2 * s3 - 3 * s2 + 1) * a.v +
    (3 * s2 - 2 * s3) * b.v
  )
}

/**
 * `HermiteEvaluate` (`FUN_06f30520`): held at either end, otherwise the pair around `t` found from a
 * proportional guess, walking forward past keys at or before `t` or back past those after it.
 */
const evaluateHermite = (knots: readonly Key[], t: number): number => {
  const first = knots[0]!
  const last = knots[knots.length - 1]!

  if (knots.length === 1 || t < first.t) return first.v
  if (t > last.t) return last.v

  let at = Math.trunc(f((t - first.t) / (last.t - first.t)) * (knots.length - 1))

  if (knots[at]!.t <= t) {
    while (at < knots.length && knots[at]!.t <= t) at++
    // Past the end only when `t` is the last key's, which the kernel answers from the left.
    return knots[at] ? hermite(knots[at - 1]!, knots[at]!, t) : knots[at - 1]!.v
  }

  while (at > 0 && !(knots[at]!.t < t)) at--
  return hermite(knots[at]!, knots[at + 1]!, t)
}

/** The list Catmull-Rom (`0x6f2f220`): a key's value at its time, and 0 outside the keys. */
const evaluateCatmullRom = (keys: readonly Key[], t: number): number => {
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!

    if (key.t > t) {
      if (index === 0) return 0

      const a = keys[index - 1]!
      const u = f((t - a.t) / (key.t - a.t))
      const p0 = keys[index - 2]?.v ?? a.v
      const p3 = keys[index + 1]?.v ?? key.v

      // `CatmullRom1D` (`0x6f2f2f0`), a missing outer value its neighbour's.
      return catmullRom(p0, a.v, key.v, p3, u)
    }

    if (key.t === t) return key.v
  }

  return 0
}

/** The list lerp (`0x6f2f920`): between the first key after `t` and the one before, else 0, so 0 at 1. */
const evaluateLinear = (keys: readonly Key[], t: number): number => {
  for (let index = 0; index < keys.length; index++) {
    const b = keys[index]!

    if (b.t > t) {
      const a = keys[index - 1]
      if (!a) return 0
      return a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v)
    }
  }

  return 0
}

/** A `param_curve` as thorn makes it, or nothing for a class DACOM doesn't have. */
export const createCurve = (curve: ParamCurve): Curve | undefined => {
  const found = curve.CLSID === undefined ? undefined : typeOf(curve.CLSID)
  if (!found) return undefined

  const [type, { kind, mode, floor }] = found
  const keys = keysOf(curve.points ?? [])
  const list = floor ? floored(byTime(keys)) : byTime(keys)
  if (kind === 'catmullRom') return { type, evaluate: (t) => evaluateCatmullRom(list, f(t)) }
  if (kind === 'linear') return { type, evaluate: (t) => evaluateLinear(list, f(t)) }

  const knots = knotsOf(keys, mode ?? 'free')

  return { type, evaluate: (t) => evaluateHermite(knots, f(t)) }
}

/** The timing a property animation's progress reads. */
export interface Timing {
  /** Milliseconds. */
  start: number
  duration: number
  curve?: Curve
  /** `pcurve_period`, milliseconds; positive loops the curve. */
  period: number
}

/**
 * `EvaluateProgress`: 1 for an instant event, else the elapsed fraction, through the curve when
 * there is one, which a positive period loops as a sawtooth. **Not clamped.**
 */
export const progress = ({ start, duration, curve, period }: Timing, now: number): number => {
  if (duration === 0) return 1

  const elapsed = now - start
  if (curve && period > 0) return curve.evaluate(f((elapsed % period) / period))

  const ratio = f(elapsed / duration)

  return curve ? curve.evaluate(ratio) : ratio
}
