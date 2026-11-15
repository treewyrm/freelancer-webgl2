/**
 * The 3D interface, as Win3D draws it over a frame: models placed in interface space, seen through
 * Win3D's own camera, each tinted by its control. See docs/retail/INTERFACE.md.
 */
import { Matrix3, Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import type { Camera } from './camera.js'
import { projectionMatrix, viewMatrix } from './camera.js'
import {
  BLACK_BACKGROUND,
  collectModel,
  hooksOf,
  RETAIL_FRAME_LIMITS,
  type Draw,
  type Frame,
  type FrameLimits,
  type SceneModel,
} from './frame.js'

const f = Math.fround

/**
 * Win3D's camera (`Win3DStartupManager`, `0x59d5a0`): identity at the origin, looking down -Z, half
 * its horizontal field the bits `0x41d9ba5e`, near 0.1, far 1000. The vertical field follows the
 * aspect, so a wider screen sees less of the interface's height.
 */
export const INTERFACE_CAMERA: Readonly<Camera> = {
  position: Vector3.zero,
  orientation: Matrix3.identity,
  fovh: f(27.216),
  near: f(0.1),
  far: 1000,
}

export interface InterfaceScene {
  /** Width over height of the surface: the interface spans it whole, whatever a room letterboxes. */
  aspect: number
  /**
   * In draw order, which is all the order there is: nothing tests depth. Each model is placed in
   * interface space, its tint in `instance` (`SetHolderTint`): over `Ac` and `Oc` of a `ui_*`
   * material, which `HUDIconMaterial` draws; ignored by any other.
   */
  models: SceneModel[]
  /** Seconds, for material UV animation. 0 when absent. */
  time?: number
  limits?: Partial<FrameLimits>
}

const WHITE = { x: 1, y: 1, z: 1 }

/**
 * The interface's frame (`Win3DDrawAll`, `0x59e300`, after `Win3DBeginDraw`): white ambient and no
 * lights; no culling, no depth test and no fog; the batcher's bin 1 off, so each part draws where it
 * stands. Render it with `over`, after the frame it lies on.
 */
export const collectInterfaceFrame = ({
  aspect,
  models,
  time = 0,
  limits,
}: InterfaceScene): Frame => {
  const resolved = { ...RETAIL_FRAME_LIMITS, ...limits }
  const collected: Draw[] = []
  const unsupported = new Set<string>()
  const unregistered = new Set<string>()
  const view = viewMatrix(INTERFACE_CAMERA)

  for (const model of models)
    collectModel(
      model,
      INTERFACE_CAMERA,
      aspect,
      view,
      time,
      collected,
      undefined,
      unsupported,
      unregistered,
      resolved,
    )

  // `ZENABLE 0` and `CULLMODE NONE` hold for every draw (`Win3DBeginDraw`, `0x59e500`).
  const draws = collected.map((draw): Draw => ({
    ...draw,
    cull: 'none',
    depthFunc: 'always',
    depthWrite: false,
  }))

  return {
    background: BLACK_BACKGROUND,
    hooks: hooksOf(draws),
    view,
    projection: projectionMatrix(INTERFACE_CAMERA, aspect),
    ambient: WHITE,
    lights: [],
    draws,
    effects: [],
    unsupported: [...unsupported],
    unregistered: [...unregistered],
  }
}

/** An `ARGB` colour as the interface keeps it: red, green, blue and alpha bytes. */
export type InterfaceColour = readonly [number, number, number, number]

/** The interface palette (`0x561be0`–`0x561c7c`): cyan idle, amber, and the pulse's middle grey. */
export const INTERFACE_CYAN: InterfaceColour = [0x87, 0xc3, 0xe0, 0xff]
export const INTERFACE_AMBER: InterfaceColour = [0xf5, 0xea, 0x52, 0xff]
export const INTERFACE_GREY: InterfaceColour = [0xb9, 0xb9, 0xb9, 0xff]

/** A button's colours (`NnButtonControl::Draw`, `0x55b167`): selected, and inactive. */
export const BUTTON_SELECTED: InterfaceColour = [0xff, 0xff, 0x00, 0xff]
export const BUTTON_INACTIVE: InterfaceColour = [0x80, 0x80, 0x80, 0xff]

/** A tint as `SetHolderTint` writes it into the instance: each byte over 255. */
export const tintOf = ([red, green, blue, alpha]: InterfaceColour): NonNullable<
  SceneModel['instance']
> => ({
  ambient: { x: f(red / 255), y: f(green / 255), z: f(blue / 255) },
  alpha: f(alpha / 255),
})

/** `0.3f`: the pulse's half cycle. */
const HALF = f(0.3)

/**
 * The hover pulse (`nn_ui_pulse.cpp`): one clock for the whole interface, a phase that wraps every
 * 0.3 s and flips its direction, from cyan through grey to amber and back.
 */
export class InterfacePulse {
  phase = 0
  direction: 0 | 1 = 0

  /** `NnUiPulseReset` (`0x59d580`), on entering a button: grey, heading for amber. */
  reset(): void {
    this.direction = 0
    this.phase = f(HALF * 0.5)
  }

  /** `0x59e080`: the sum is compared before it is rounded, and each wrap flips the direction. */
  advance(seconds: number): void {
    let phase = this.phase + seconds

    this.phase = f(phase)
    if (!(phase > HALF)) return

    do {
      phase -= HALF
      this.direction = this.direction === 0 ? 1 : 0
    } while (phase > HALF)

    this.phase = f(phase)
  }

  /** `NnUiPulseBlendArgb` (`0x561da0`): each byte `to + trunc((from - to) t)`. */
  get colour(): InterfaceColour {
    const norm = f(this.phase / HALF)
    const [from, to, t] =
      this.direction === 0
        ? norm < 0.5
          ? [INTERFACE_GREY, INTERFACE_CYAN, f(norm + norm)]
          : [INTERFACE_AMBER, INTERFACE_GREY, f(f(norm - 0.5) + f(norm - 0.5))]
        : norm < 0.5
          ? [INTERFACE_GREY, INTERFACE_AMBER, f(norm + norm)]
          : [INTERFACE_CYAN, INTERFACE_GREY, f(f(norm - 0.5) + f(norm - 0.5))]
    const byte = (at: number) => to[at]! + Math.trunc((from[at]! - to[at]!) * t)

    return [byte(0), byte(1), byte(2), byte(3)]
  }
}

/** Degrees a second a spinning button turns (`NnButtonControl`'s constructor, `0x43340000`). */
export const SPIN_SPEED = 180

/**
 * A spinning button's angle after `seconds` (`NnButtonControl::Draw`, `0x55b02e`): forward while
 * hovered; otherwise home the short way at twice the speed, snapping to 0 past 359 or under 1.
 */
export const spinAngle = (angle: number, hovered: boolean, seconds: number): number => {
  const step = seconds * SPIN_SPEED
  let next: number

  if (hovered) next = f(step + angle)
  else if (angle > 180) {
    next = step + step + angle
    if (next > 359) next = 0
    next = f(next)
  } else {
    next = angle - (step + step)
    if (next < 1) next = 0
    next = f(next)
  }

  return next >= 360 ? f(next - 360) : next <= -360 ? f(next + 360) : next
}

/**
 * Where a control's model stands: at `position` in interface space, turned `angle` degrees about +Y
 * (`RotateMatrix`), which is not applied within 0.01 degrees of none.
 */
export const interfaceWorld = (position: Vector3, angle = 0): Matrix4 =>
  Math.abs(angle) <= 0.01
    ? Matrix4.translation(position)
    : Matrix4.fromRotationTranslation(
        Matrix3.axisAngle({ x: 0, y: 1, z: 0 }, (angle * Math.PI) / 180),
        position,
      )
