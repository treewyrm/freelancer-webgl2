/**
 * Thorn's characters on the library's motion mixer: what the game's `Thorn_Deformable`
 * (`gf_thorn_deformable.cpp`) does with `START_MOTION`, `START_IK` and the floor, as a
 * {@link CharacterHost}. The host makes each character's `Mixer` and finds animations by name.
 */
import type { AnimationScript } from '@treewyrm/freelancer/animation'
import { Matrix4, Quat } from '@treewyrm/freelancer/math'
import type { Mixer } from '#/deformable/mixer.js'
import type { AimRecord, MotionRecord } from './events.js'
import { quaternionOf, type Frame } from './frame.js'
import type { CharacterHost } from './playback.js'

export interface MixerCharacters {
  /** A character's mixer, by entity name, or nothing for one the host doesn't run. */
  mixer(entity: string): Mixer | undefined
  /**
   * An animation by name, from the one global table every `bodyparts.ini [Animations]` file fills,
   * ignoring case (`0x435100`). A missing one logs and still succeeds: the event does nothing.
   */
  animation(name: string): AnimationScript | undefined
}

/**
 * A {@link CharacterHost} on mixers. A motion locks its `locked_bone` from its start to its Finish;
 * an aim is the single-joint `point_at` solve, its scene-space rotation handed on as it is, since the
 * solve undoes the parent's world, the character's own turn included (`IkSolveSingleJoint`); keep-beneath
 * from event flag 0x80 (`StartIk`, `0x452460`). Longer chains are left out.
 */
export const mixerCharacters = ({
  mixer,
  animation,
}: MixerCharacters): CharacterHost & {
  /** `ICompoundControl +0x18`: the playback's advance, in milliseconds. */
  advance(entity: string, milliseconds: number): void
  /** Where a character's root stands now, in the character's frame: thorn reads the walk back. */
  root(entity: string): Frame | undefined
} => {
  const motions = new Map<MotionRecord, number>()
  const aims = new Map<AimRecord['event'], number>()
  /** The motions that locked their bone, which their finish unlocks. */
  const locked = new Set<MotionRecord>()

  return {
    startMotion(entity, motion) {
      const character = mixer(entity)
      const script = animation(motion.animation)
      if (!character || !script) return true

      const handle = character.start(script, {
        startTime: motion.startTime,
        timeScale: motion.timeScale,
        weight: motion.weight,
        transTime: motion.transTime,
        eventFlags: motion.eventFlags,
        heading: motion.heading,
      })
      if (handle !== undefined) motions.set(motion, handle)
      // Locked after the play whatever it returned, once the animation and part exist (`0x45230a`).
      if (motion.lockedBone) {
        character.lock(motion.lockedBone)
        locked.add(motion)
      }
      return true
    },
    stopMotion(entity, motion) {
      const character = mixer(entity)
      const handle = motions.get(motion)

      motions.delete(motion)
      if (!character) return
      if (handle !== undefined) character.stop(handle)
      if (motion.lockedBone && locked.delete(motion)) character.unlock(motion.lockedBone)
    },
    startAim(entity, aim) {
      const character = mixer(entity)
      // An empty chain at 0 or less does nothing; more than one joint isn't built (`0x452460`).
      if (!character || !aim.pointAt || aim.countToRoot !== 1) return true

      const handle = character.aim(aim.endEffector, {
        target: quaternionOf(aim.rotation),
        transitionDuration: aim.transitionDuration,
        eventFlags: aim.eventFlags,
      })
      if (handle !== undefined) aims.set(aim.event, handle)
      return true
    },
    updateAim(entity, aim) {
      const handle = aims.get(aim.event)
      if (handle !== undefined) mixer(entity)?.setAimTarget(handle, quaternionOf(aim.rotation))
    },
    stopAim(entity, aim) {
      const handle = aims.get(aim.event)

      aims.delete(aim.event)
      if (handle !== undefined) mixer(entity)?.stopAim(handle)
    },
    setFloor(entity, height) {
      mixer(entity)?.setFloor(height)
    },
    setPosition(entity, position) {
      mixer(entity)?.setRootPosition(position)
    },
    setOrientation(entity, orientation) {
      mixer(entity)?.setRootOrientation(quaternionOf(orientation) as Quat)
    },
    advance(entity, milliseconds) {
      mixer(entity)?.advance(Math.fround(milliseconds * 0.001))
    },
    root(entity) {
      const character = mixer(entity)
      if (!character) return undefined

      const { position, orientation } = character.root

      return Matrix4.fromTRS(position, orientation, 1)
    },
  }
}
