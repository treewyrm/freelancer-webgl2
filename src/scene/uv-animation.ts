/** A material's UV transform at a moment: `shading.dll`'s animation instance, as data. */
import type { MaterialAnim } from '@treewyrm/freelancer/rigid'

/** `uv * scale + offset`, on stage 0 alone (`0x6ec7330`, `rp8.dll` \`0x6d0fdd2\`). */
export interface UvTransform {
  offset: [number, number]
  scale: [number, number]
}

/**
 * `FImaInstance::Tick` and `FillUvMatrix`: a segment's duration is its own length, and the walk moves
 * on only strictly past it, wrapping always, as nothing reads `MAFlags`. A segment starts at the last
 * one's key, or four zeros, and its velocities are rates. Stored scales are displacements from 1.
 */
export const sampleUvAnimation = ({ segments }: MaterialAnim, time: number): UvTransform => {
  const total = segments.reduce((sum, { duration }) => sum + duration, 0)
  if (!segments.length || !(total > 0)) return { offset: [0, 0], scale: [1, 1] }
  let elapsed = Math.max(0, time) % total
  // A clock landing exactly on the wrap has run one whole loop, and reads the last segment's end.
  if (elapsed === 0 && time > 0) elapsed = total
  let at = 0
  while (at < segments.length - 1 && elapsed > segments[at]!.duration) {
    elapsed -= segments[at]!.duration
    at++
  }
  const { start, velocity } = segments[at]!
  return {
    offset: [
      start.uOffset + velocity.uOffset * elapsed,
      start.vOffset + velocity.vOffset * elapsed,
    ],
    scale: [
      1 + start.uScale + velocity.uScale * elapsed,
      1 + start.vScale + velocity.vScale * elapsed,
    ],
  }
}
