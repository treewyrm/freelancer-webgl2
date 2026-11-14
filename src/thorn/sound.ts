/**
 * A script's sound, handed to the host as records: the library plays nothing. Thorn's `audioprops`
 * (`0x6f5e198`, `TickAudioPropAnim`) and the game's sound host (`gf_thorn_sound.cpp`).
 */
import type { AudioProps } from '@treewyrm/freelancer/thn/scene'

const f = Math.fround

/** The eight `audioprops`, in key order. Only `attenuation` and `pan` reach a sound (`0x457630`). */
export interface AudioState {
  /** Decibels. */
  attenuation: number
  pan: number
  dmin: number
  dmax: number
  /** Whole degrees. */
  ain: number
  aout: number
  atout: number
  rmix: number
}

/** An entity's defaults (`0x6f5e198`). */
export const DEFAULT_AUDIO: AudioState = {
  attenuation: 0,
  pan: 0,
  dmin: 1,
  dmax: 1e9,
  ain: 360,
  aout: 360,
  atout: 0,
  rmix: 0,
}

/** An animation's targets before its keys (`ApplyAudioPropAnimDesc`): `dmin` 50 and `dmax` 1000. */
export const DEFAULT_AUDIO_TARGET: AudioState = { ...DEFAULT_AUDIO, dmin: 50, dmax: 1000 }

const KEYS = ['attenuation', 'pan', 'dmin', 'dmax', 'ain', 'aout', 'atout', 'rmix'] as const

/** A block over `base`, each key given a bit in key order. */
export const readAudio = (
  props: AudioProps,
  base: AudioState,
): { audio: AudioState; mask: number } => {
  const audio = { ...base }
  let mask = 0

  KEYS.forEach((key, bit) => {
    const value = props[key]
    if (value === undefined) return
    audio[key] = key === 'ain' || key === 'aout' ? Math.trunc(value) : f(value)
    mask |= 1 << bit
  })
  return { audio, mask }
}

/** `TickAudioPropAnim`: masked keys from `from` toward `to` by `u`, the angles truncated. */
export const blendAudio = (
  current: AudioState,
  from: AudioState,
  to: AudioState,
  mask: number,
  u: number,
): AudioState => {
  const out = { ...current }

  KEYS.forEach((key, bit) => {
    if (!(mask & (1 << bit))) return

    const value = from[key] + (to[key] - from[key]) * u

    out[key] = key === 'ain' || key === 'aout' ? Math.trunc(value) : f(value)
  })
  return out
}

/** One sound a script is playing, for the host to play and to keep up to date. */
export interface SoundRecord {
  entity: string
  /** `[Sound]`, or `VoiceProfile_*`, `BackgroundAmbient`, `BackgroundMusic`, `PlayerShipSound`. */
  template: string
  /**
   * Milliseconds into the sound to play from: `start_time` plus how late in its tick it started
   * (`0x4574d0`). The game plays it from there.
   */
  offset: number
  loop: boolean
  /** A 3D source at the entity, `C` not applied; otherwise 2D, panned. */
  spatial: boolean
  /** The playback's clock when it started, milliseconds. */
  started: number
}

/**
 * What the game sets on a playing sound (`0x457630`): its volume in decibels, the `[Sound]`'s
 * attenuation plus the entity's and the room's ambience level `L`, each clamped to [−96, 0], and a 2D
 * sound's pan in DirectSound's hundredths, clamped to ±10,000. `L` reaches only the sounds of a room's
 * own `scene` lines (the sequence's room-ambience flag, read at `0x457650`); every other sequence passes 0.
 */
export const soundLevel = (
  archetype: number,
  { attenuation, pan }: AudioState,
  room = 0,
): { volume: number; pan: number } => {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

  return {
    volume: clamp(archetype + clamp(room + attenuation, -96, 0), -96, 0),
    pan: clamp(100 * pan, -10000, 10000),
  }
}
