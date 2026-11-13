/**
 * How the game drives a script's engine: `FGfScript` (`src/freelancer/Client/gf_script_object.cpp`)
 * and the frame's milliseconds (`TickGameflow`, `0x558ac7`).
 */
import type { Playback } from './playback.js'

const f = Math.fround

/** What a frame hands every sequence: whole milliseconds, and the rest carried to the next. */
export interface FrameMilliseconds {
  milliseconds: number
  carry: number
}

/**
 * `0x558ac7`–`0x558afa`: the carry plus the frame's seconds, floored to milliseconds, the remainder
 * kept as a float. At the x87's 24-bit precision, which D3D8 leaves it at.
 */
export const frameMilliseconds = (carry: number, seconds: number): FrameMilliseconds => {
  const sum = f(carry + seconds)
  const milliseconds = Math.floor(f(sum * 1000))

  return { milliseconds, carry: f(sum - f(milliseconds * 0.001)) }
}

/**
 * One script as a sequence plays it (`FGfScript::Start`, `Update`): started and ticked by 0 before
 * the first frame, then by each frame's milliseconds. The frame that reaches the end, or skips to
 * it, ticks 100 more, so a script that doesn't loop finishes its events then.
 */
export class ScriptRun {
  readonly playback: Playback
  #finished = false
  #skipping = false

  constructor(playback: Playback) {
    this.playback = playback
    // `Slot22Start(0)` ticks by 0 itself, and `Slot26Tick(0)` again.
    playback.start(0)
    playback.tick(0)
  }

  get finished(): boolean {
    return this.#finished
  }

  /** `FGfScript::Pause`, as the skip key sets it: the next update jumps to the end, exactly. */
  skip(): void {
    this.#skipping = true
  }

  /**
   * `FGfScript::Update`, true once finished. `catchup` is `0x44f500`'s: how far a finished rebuff
   * voice line lets the scene jump, 0 everywhere else.
   */
  update(milliseconds: number, catchup = 0): boolean {
    const { playback } = this

    if (!this.#finished)
      if (!this.#skipping) {
        playback.tick(catchup + milliseconds)
        if (!playback.loop && playback.clock >>> 0 >= playback.duration >>> 0) this.#finished = true
      } else {
        playback.tick(playback.duration - playback.clock)
        this.#finished = true
        this.#skipping = false
      }

    if (this.#finished) playback.tick(100)
    return this.#finished
  }
}
