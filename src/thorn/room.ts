/**
 * A script's entities as the game spawns them into a room (`FGfScript::Spawn`, `FUN_0044ed90`): which
 * get a host at all, and what a compound's or character's room object carries. The host resolves
 * templates by `category` and loads the models; this maps the rest onto `RoomObject`.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'
import { data, type Entity } from '@treewyrm/freelancer/thn/scene'
import type { RoomObject } from '#/scene/room.js'
import type { Frame } from './frame.js'
import type { Playback } from './playback.js'

/** One `rtcslider.ini` line: `set = name, t` on at `t` and above, `set_less` below `t`. */
export interface RtcSetting {
  name: string
  threshold: number
  less?: boolean
}

/**
 * `RtcSlider::is_enabled` (`common!0x627a5c0`): the first line for a name, ignoring case (`CreateID`), at
 * the player's cutscene-detail `slider`. A name with no line is on.
 */
export const rtcEnabled = (
  settings: readonly RtcSetting[],
  slider: number,
  name: string,
): boolean => {
  const setting = settings.find((each) => each.name.toLowerCase() === name.toLowerCase())
  if (!setting) return true
  return setting.less ? slider < setting.threshold : setting.threshold <= slider
}

/** A `userprops` value, its key matched ignoring case as thorn's map does (`_memicmp`). */
export const userProp = (entity: Entity, key: string): string | undefined => {
  const props = entity.userprops ?? {}
  const found = Object.keys(props).find((each) => each.toLowerCase() === key.toLowerCase())

  return found === undefined ? undefined : props[found]
}

export interface SpawnOptions {
  /** `rtcslider.ini`'s lines. Every name is on when absent. */
  rtc?: readonly RtcSetting[]
  /** The cutscene-detail slider, 0 to 1. */
  slider?: number
}

/**
 * Whether the game makes a host for an entity: not when its `priority` is a setting the slider has
 * off, nor a `PSYS` with no `priority` while `script_particles` is off (`0x44efd3`).
 */
export const spawns = (entity: Entity, { rtc = [], slider = 1 }: SpawnOptions = {}): boolean => {
  const priority = userProp(entity, 'priority')
  if (priority !== undefined && !rtcEnabled(rtc, slider, priority)) return false

  if (entity.type === 'PSYS' && priority === undefined)
    return rtcEnabled(rtc, slider, 'script_particles')

  return true
}

/** `ThornGetRenderType` (`common!0x627bd60`): `usr_flg` bit 0 starsphere, bit 1 backdrop, which wins. */
export const renderTypeOf = (entity: Entity): 'starsphere' | 'backdrop' | undefined => {
  const flags = entity.usr_flg ?? 0

  return flags & 2 ? 'backdrop' : flags & 1 ? 'starsphere' : undefined
}

/** A compound or character the room draws, all but its model. */
export interface RoomEntity {
  entity: Entity
  /** `template_name`, `NULL` as nothing, the entity's own name when absent (`0x6f28a60`). */
  template: string
  /** `userprops.category`, which the host resolves `template` by, case included. */
  category: string | undefined
  /** Where the host puts it: `C · T`. */
  world: Frame
  /** Its starsphere or backdrop render type, which the host gives the model as `sky`. */
  sky: 'starsphere' | 'backdrop' | undefined
  /** `running_lights`: whether its `always_on` lights draw. */
  runningLights: boolean
  /** The `RoomObject` fields this decides. */
  object: Omit<RoomObject, 'model'>
}

const has = (entity: Entity, flag: keyof typeof data.RENDER_FLAGS) =>
  'flags' in entity && (entity.flags?.includes(flag) ?? false)

/**
 * Every `COMPOUND` and `DEFORMABLE` the game spawns, in script order, with what `SetFlags` and the
 * spawn give its room object (`0x44de85`, `FThornCompound::SetFlags`): `LIT_AMBIENT` is `visible`,
 * `LIT_DYNAMIC` is `lit`, fog unless `nofog`, `srt_grp` its signed layer, `lt_grp` its light group,
 * and its scene's ambient. A `REFERENCE` is another script's, so isn't here.
 */
export const roomEntities = (playback: Playback, options: SpawnOptions = {}): RoomEntity[] => {
  const ambient: Vector3 | undefined = playback.ambient

  return playback.script.entities.flatMap((entity) => {
    if (entity.type !== 'COMPOUND' && entity.type !== 'DEFORMABLE') return []
    if (has(entity, 'REFERENCE') || !spawns(entity, options)) return []

    const world = playback.world(entity.entity_name)
    if (!world) return []

    const template =
      entity.template_name === 'NULL' ? '' : (entity.template_name ?? entity.entity_name)
    const category = userProp(entity, 'category')
    // The player's ship (`0x44dda1`): its `IsVisible` is `xor al,al` (`0x44fd00`), so black ambient.
    const playerShip = category === 'Spaceship' && template === 'PlayerShip'

    return [
      {
        entity,
        template,
        category,
        world,
        // A character's render type is always 0.
        sky: entity.type === 'COMPOUND' ? renderTypeOf(entity) : undefined,
        runningLights: userProp(entity, 'running_lights') !== undefined,
        object: {
          position: { x: world.w.x, y: world.w.y, z: world.w.z },
          layer: entity.srt_grp ?? 0,
          lightGroup: entity.lt_grp ?? 0,
          visible: has(entity, 'LIT_AMBIENT') && !playerShip,
          lit: has(entity, 'LIT_DYNAMIC'),
          fog: userProp(entity, 'nofog') === undefined,
          ...(ambient && { ambient }),
        },
      },
    ]
  })
}
