/** Which frame an animated texture shows: `TextureLibrary`'s playback, as a function of its clock. Pure. */
import type { AnimatedTexture, Texture, TextureEntry } from '@treewyrm/freelancer/texture'

/** `SetWrapMode`'s 0 and 1. Ping-pong, 2, has no retail caller. */
export type PlaybackWrap = 'clamp' | 'loop'

/**
 * The frame a playback shows `elapsed` seconds after it began: `FUN_06ebe660`, then `FUN_06ebe8c0`'s
 * `floor(fmod(rate * seconds, count))`. Retail sums each tick into the clock, and this takes the sum.
 * A negative rate gives a frame below 0, which retail reads out of bounds.
 */
export const playbackFrame = (
  { frames, rate }: AnimatedTexture,
  elapsed: number,
  wrap: PlaybackWrap,
): number => {
  const count = frames.length
  // A single frame is never advanced, and a rate within the epsilon leaves the duration 0, which
  // reads frame 0 either way: a clamp to 0, or a NaN that `ftol` turns to 0.
  if (count <= 1) return 0
  const fps = Math.fround(rate)
  if (!(Math.abs(fps) > 1e-5)) return 0
  // `PlaybackDuration`: just short of the last frame's end, so a clamp holds on it.
  const duration = count / fps - 1e-6
  const seconds = Math.fround(
    wrap === 'loop' ? elapsed % duration : Math.max(0, Math.min(elapsed, duration)),
  )
  // `+ 0`, as a negative rate's clamp gives -0.
  return Math.floor((fps * seconds) % count) + 0
}

/** A frame's atlas: the sibling entry `<name>_<index>` its frame names, as `LoadTextureRecord` loads them. */
export const frameAtlas = (
  animation: AnimatedTexture,
  frame: number,
  texture: (name: string) => TextureEntry | undefined,
): { name: string; entry: Texture } | undefined => {
  const at = animation.frames[frame]
  if (!at) return undefined
  const name = `${animation.name}_${at.index}`
  const entry = texture(name)
  return entry && entry.type !== 'cube' && entry.type !== 'animated' ? { name, entry } : undefined
}
