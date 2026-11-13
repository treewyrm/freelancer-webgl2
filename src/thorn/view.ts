/**
 * What the screen shows of the scripts' cameras: the game's view table (`FGfCameraPool`,
 * `src/freelancer/Client/gf_script.cpp`), and the cinematic letterbox (`space_letterbox.cpp`).
 */
import type { Matrix3 } from '@treewyrm/freelancer/math'
import type { Camera, Viewport } from '#/scene/camera.js'
import type { Frame } from './frame.js'
import type { CameraView } from './playback.js'

const f = Math.fround

/** A frame's rotation as the rows a THN `orient` reads into, which a renderer `Camera` takes. */
export const rowsOf = ({ x, y, z }: Frame): Matrix3 => ({
  x: { x: x.x, y: y.x, z: z.x },
  y: { x: x.y, y: y.y, z: z.y },
  z: { x: x.z, y: y.z, z: z.z },
})

/** A script camera's view as the renderer's `Camera`. */
export const cameraOf = ({ world, fovh, near, far }: CameraView): Camera => ({
  position: { x: world.w.x, y: world.w.y, z: world.w.z },
  orientation: rowsOf(world),
  fovh,
  near,
  far,
})

/**
 * `FGfCameraPool`: 256 slots. A `MONITOR` registers selectable with its script's priority (1 for
 * landing, launch and transitions, else 0); a `CAMERA` registers but never shows. A new slot takes
 * the view only over a strictly lower priority (`Allocate`, `0x450580`); freeing the shown one
 * re-elects the highest, ties to the lowest slot (`Free`, `0x450680`). None shown: the room's camera.
 */
export class ViewTable {
  readonly #slots: ({ priority: number; selectable: boolean } | undefined)[] = []
  #active = -1

  /** The slot shown, or nothing. */
  get active(): number | undefined {
    return this.#active === -1 ? undefined : this.#active
  }

  /** A slot for a camera or monitor, or nothing when all 256 are taken. */
  register(priority: number, selectable: boolean): number | undefined {
    let slot = 0

    while (slot < 256 && this.#slots[slot]) slot++
    if (slot === 256) return undefined
    this.#slots[slot] = { priority, selectable }

    const shown = this.#active === -1 ? -0x100 : this.#slots[this.#active]!.priority
    if (selectable && priority > shown) this.#active = slot
    return slot
  }

  release(slot: number): void {
    this.#slots[slot] = undefined
    if (slot !== this.#active) return

    let best = -1
    let priority = -0x100

    this.#slots.forEach((each, index) => {
      if (each?.selectable && each.priority > priority) {
        priority = each.priority
        best = index
      }
    })
    this.#active = best
  }
}

/**
 * The letterbox: an amount from 0, no bars, to 1, a 1.85:1 picture, moving toward its target at
 * `speed` a second. A script that takes the camera aims it at 1 and lets go at 0, both at 3.
 */
export class Letterbox {
  amount = 0
  target = 0
  speed = 3
  animating = false

  /** `SetLetterboxTarget` (`FUN_0041a0f0`): under an opaque fade it jumps there. */
  aim(target: number, speed = 3, faded = false): void {
    if (faded) this.amount = target
    this.target = target
    this.speed = speed
    this.animating = true
  }

  /** The head of `UpdateRoomLetterbox` (`FUN_0041a140`): true while it was moving. */
  step(seconds: number): boolean {
    if (!this.animating) return false

    if (this.amount < this.target) {
      const sum = this.speed * seconds + this.amount

      this.amount = f(sum)
      if (!(sum >= this.target)) return true
      this.amount = this.target
    } else if (this.amount > this.target) {
      const difference = this.amount - this.speed * seconds

      this.amount = f(difference)
      if (!(difference <= this.target)) return true
      this.amount = this.target
    }

    this.animating = false
    return true
  }

  /** `GetLetterboxBarHeight`: each bar, in pixels, rounded half up. */
  bar({ width, height }: Viewport): number {
    const surface = width / height
    // The aspect eases from the surface's to 1.85 with `amount`; each bar is half the height it leaves.
    const aspect = (f(1.85) - surface) * this.amount + surface

    return Math.floor((height - width / aspect) * 0.5 + 0.5)
  }

  /**
   * The picture between the bars, and its aspect, which the room camera's projection takes in
   * place of the surface's, the horizontal angle held.
   */
  view(surface: Viewport): { top: number; viewport: Viewport; aspect: number } {
    const bar = this.bar(surface)
    const viewport = { width: surface.width, height: surface.height - 2 * bar }

    return { top: bar, viewport, aspect: viewport.width / viewport.height }
  }
}
