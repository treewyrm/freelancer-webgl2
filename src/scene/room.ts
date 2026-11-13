/**
 * A base room's frame as the game orders it: `RoomControlDraw` (`FUN_0044b570`), in
 * `src/freelancer/Client/room_control.cpp`. Pure, no GL. Objects draw by sort layer, each lit by its
 * light group's nearest four; the batcher holds their glass until every object has drawn.
 *
 * The glare light has no
 * place: retail sets `SetDirectionalLight`'s globals (`0x66fe1f0`) and nothing in any binary reads them.
 */
import type { Vector3 } from '@treewyrm/freelancer/math'
import type { Texture } from '@treewyrm/freelancer/texture'
import { collectEffect, type EffectDraw } from '#/alchemy/draw.js'
import { projectionMatrix, viewMatrix, type Camera, type Viewport } from './camera.js'
import {
  BLACK_BACKGROUND,
  collectModel,
  flushQueued,
  hooksOf,
  RETAIL_FRAME_LIMITS,
  type Draw,
  type Frame,
  type FrameLimits,
  type Queued,
  type SceneEffect,
  type SceneLight,
  type SceneModel,
} from './frame.js'
import type { Fog } from './nebula.js'
import {
  FLASHLIGHTS_PER_SET,
  flashlightDraws,
  type FlashLight,
  type FlashlightTextures,
} from './flashlight.js'
import {
  RETAIL_SHADOW_LIMITS,
  shadowDraw,
  shadowQuad,
  type RoomShadow,
  type ShadowLimits,
} from './shadow.js'

/** A THN `LIGHT` that's on, in world space. Its type is its shape: `SceneLight`'s. */
export interface RoomLight extends SceneLight {
  /** `LtGrp`: it lights only objects of its group. */
  group: number
}

export interface RoomObject {
  /**
   * Its `render_type` (`ThornGetRenderType`) is the model's `sky`: 1 a starsphere, 2 a backdrop
   * (`FUN_0044af60`). A character's is always a model.
   */
  model: SceneModel
  /** The engine instance's position, which its lights are picked from. */
  position: Vector3
  /** `SrtGrp`, a signed byte: lower layers draw first. 0 when absent. */
  layer?: number
  /** `LtGrp`. 0 when absent, the `FRoomObject` default. */
  lightGroup?: number
  /** Slot 2. Drawn all the same when false, under black ambient (`FUN_0044ae80`). True when absent. */
  visible?: boolean
  /** Picks lights. Unlit, it has none, and the ambient alone. True when absent. */
  lit?: boolean
  /** The room's fog reaches it. True when absent. */
  fog?: boolean
  /**
   * The `SCENE` entity's `ambient` it takes in place of the room's, as written: 0 to 255. A
   * compound gets one only through its scene (`FThornCompound::SetScene`).
   */
  ambient?: Vector3
  /** Its own effects, a ship's flames, after every model, in its layer's turn. */
  effects?: readonly SceneEffect[]
  /** The shadow it casts, drawn just before it: a character's, a ship's with one, a type-5 prop's. */
  shadow?: RoomShadow
  /**
   * Its `always_on` `[Light]`s, in its translucent pass (slot 8), the first 32: a prop's with its
   * fourth THN flag set (`FObjectProp::DrawTranslucent`), a ship's (`FObjectShip::DrawTranslucent`).
   * The host steps and places them.
   */
  flashlights?: readonly FlashLight[]
}

export interface RoomShadows {
  /** `efxshadow`, from `fx/efx.txm`. */
  texture: Texture
  /** What the last fading shadow left (`DAT_06704078`): the last frame's `shadowScale`. 1 at first. */
  scale?: number
  /** Over `RETAIL_SHADOW_LIMITS`, for a mod that patches them. */
  limits?: Partial<ShadowLimits>
}

/** A room's frame, and what its shadows leave for the next. */
export interface RoomFrame extends Frame {
  shadowScale: number
}

export interface RoomScene {
  camera: Camera
  aspect: number
  /**
   * In pixels: a part covering under one isn't drawn (`FRoomCamera::ClassifySphere`'s rank 2). Every
   * part is sized as if the viewport were infinite when absent.
   */
  viewport?: Viewport
  /** The `SCENE` entity's `ambient`, as written: 0 to 255 (`RoomData`, `+0xd8`). White when absent. */
  ambient?: Vector3
  /**
   * Every THN light that's on, in the order the script registered them (`DAT_0066d130`). A room's own
   * list (`+0xe4`) is never filled in retail, nor is its single-light mode ever set (`+0x4fc`).
   */
  lights: readonly RoomLight[]
  /** In the order they were made, which is the order within a layer (`DAT_00679a10`). */
  objects: readonly RoomObject[]
  /**
   * The `SCENE`'s fog, when it's on and the effects and nebula options are (`GfFogIsActive`). Its
   * `fogtable` N asks D3D for vertex fog, which here is per pixel all the same: uncaptured.
   */
  fog?: Fog
  /**
   * With the shadows option, `shadow_glare` and the room's `ShadowLight` all on (`FUN_0044b370`). No
   * shadows when absent.
   */
  shadows?: RoomShadows
  /**
   * The room's own, from its `[FlashlightSet]`s and `[FlashlightLine]`s, after every object's, all
   * of them, with the effects and flashlights options on. The host steps them (`FRoomRuntime::Update`).
   */
  flashlights?: readonly FlashLight[]
  /** `shine` and `bulb`, which any flashlight needs to draw. */
  flashlightTextures?: FlashlightTextures
  /** The scripts' `PSYS`es, sequence by sequence, after every object's (`FUN_00456740`). */
  effects?: readonly SceneEffect[]
  background?: Vector3
  time?: number
  limits?: Partial<FrameLimits>
}

/** `FUN_00557170`'s cap, through `GfLightsApplyNearest` (`FUN_005572b0`). */
export const ROOM_LIGHTS_PER_OBJECT = 4

const f = Math.fround
const WHITE: Vector3 = { x: 255, y: 255, z: 255 }
const BLACK: Vector3 = { x: 0, y: 0, z: 0 }

/**
 * `GfLightScore` (`FUN_005586f0`): 3 for a directional light, else 2 less its distance squared over
 * its range squared, a spot outside its half cone taking the angle's cosine for the 2. Undefined for
 * no range at all, which isn't picked.
 */
export const lightScore = (light: SceneLight, position: Vector3): number | undefined => {
  if (!light.position) return 3

  const range = light.range ?? 0
  const rangeSq = range * range
  if (rangeSq === 0) return undefined

  // dx and dy stored as floats, dz kept wide and squared against its float.
  const dx = f(position.x - light.position.x)
  const dy = f(position.y - light.position.y)
  const dzWide = position.z - light.position.z
  const dz = f(dzWide)
  const distSq = dzWide * dz + dx * dx + dy * dy
  let base = 2

  if (light.spot && !(distSq < 1e-5)) {
    const { x, y, z } = light.direction
    const cos = (z * dz + y * dy + dx * x) / Math.sqrt(distSq)
    if (!(cos > Math.cos(f(light.spot.phi) * 0.5))) base = f(cos)
  }

  return f(base - distSq / rangeSq)
}

/**
 * `GfLightsSelectNearest` (`FUN_00557170`) and `EngineLightApplyList`: the group's lights, highest
 * score first, a later one before an equal one, cut to four, and then any under a byte's worth left off.
 */
export const pickRoomLights = (
  lights: readonly RoomLight[],
  position: Vector3,
  group: number,
): SceneLight[] => {
  const picked: { light: RoomLight; score: number }[] = []

  for (const light of lights) {
    if (light.group !== group) continue

    const score = lightScore(light, position)
    if (score === undefined) continue

    let slot = 0

    while (slot < picked.length && score < picked[slot]!.score) slot++
    picked.splice(slot, 0, { light, score })
  }

  // No light is skipped for a black diffuse. `EngineLightApplyNearby`'s 1/255 test on the colour runs
  // only for a light without a D3D light, and `EngineLightSetLight` gives every room light one (flag
  // 0x20). So an ambient-only light still adds its ambient, as `li01_01_bar`'s
  // `ambi_LtG09_SET_Amb_Drct` does to the set (captured in `s004x_bar`).
  return picked.slice(0, ROOM_LIGHTS_PER_OBJECT).map(({ light: { group: _, ...light } }) => light)
}

// `AmbientChannel`, then `GfSetSceneAmbient` (`FUN_00556f20`): the int over 255 as a float, then
// rounded back to a byte, of which only the low one's kept. `EngineLightApplyList` reads it back
// unchanged, as every byte survives the trip.
const ambientByte = (value: number): number =>
  (Math.floor(f(value * (1 / 255)) * 255 + 0.5) & 0xff) / 255

const ambientOf = ({ x, y, z }: Vector3): Vector3 => ({
  x: ambientByte(x),
  y: ambientByte(y),
  z: ambientByte(z),
})

/** What one object is lit by: `FUN_0044ae80`, with the lighting option on. */
export const lightRoomObject = (
  { lights, ambient = WHITE, fog }: Pick<RoomScene, 'lights' | 'ambient' | 'fog'>,
  object: RoomObject,
): { lights: SceneLight[]; ambient: Vector3; fog?: Fog } => ({
  lights:
    object.lit === false ? [] : pickRoomLights(lights, object.position, object.lightGroup ?? 0),
  ambient: ambientOf(object.visible === false ? BLACK : (object.ambient ?? ambient)),
  ...(fog && object.fog !== false && { fog }),
})

// The layer byte, signed: `FUN_0044c520` orders the set with `SETL`.
const signedLayer = ({ layer = 0 }: RoomObject): number => (layer << 24) >> 24

const layersOf = (objects: readonly RoomObject[]): number[] =>
  [...new Set(objects.map(signedLayer))].sort((a, b) => a - b)

export const collectRoomFrame = (scene: RoomScene): RoomFrame => {
  const { camera, aspect, objects, background, time = 0, effects = [], limits, shadows } = scene
  const shadowLimits = { ...RETAIL_SHADOW_LIMITS, ...shadows?.limits }
  let shadowScale = shadows?.scale ?? 1
  // `GfFogApply`, then each object's `FUN_0044ae80`: a shadow draws under what the last one left.
  let deviceFog = scene.fog
  const resolved = { ...RETAIL_FRAME_LIMITS, ...limits }
  const draws: Draw[] = []
  const unsupported = new Set<string>()
  const unregistered = new Set<string>()
  const view = viewMatrix(camera)
  const queued: Queued[] = []
  const layers = layersOf(objects)

  // Slot 7, layer by layer. A queued record relights its object as the batcher flushes it
  // (`FRoomBatcherSink::BeginRecord`), so its draws keep the object's lighting.
  for (const layer of layers)
    for (const object of objects) {
      if (signedLayer(object) !== layer) continue

      if (shadows && object.shadow) {
        const { quad, scale } = shadowQuad(object.shadow, shadowScale, shadowLimits)

        shadowScale = scale
        if (quad) draws.push(shadowDraw(quad, shadows.texture, deviceFog))
      }

      const own: Draw[] = []
      const held: Queued[] = []

      collectModel(
        object.model,
        camera,
        aspect,
        view,
        time,
        own,
        held,
        unsupported,
        unregistered,
        resolved,
        false,
        scene.viewport,
      )

      const lit = lightRoomObject(scene, object)

      deviceFog = lit.fog

      const relit = (draw: Draw): Draw => ({
        ...draw,
        lights: lit.lights,
        // A sky's white and an exclusion zone's are their own.
        sceneAmbient: draw.sceneAmbient ?? lit.ambient,
        ...(lit.fog && { fog: lit.fog }),
      })

      draws.push(...own.map(relit))
      for (const queue of held) queued.push({ ...queue, draws: queue.draws.map(relit) })
    }

  // `RoomBatcherEnd`: one flush, after every object (`ku_dragon_pair`).
  flushQueued(queued, draws)

  // Slot 8 by layer, then the room's own (`DrawFlashlightFlares`).
  const textures = scene.flashlightTextures

  if (textures) {
    for (const layer of layers)
      for (const object of objects)
        if (signedLayer(object) === layer && object.flashlights)
          draws.push(
            ...flashlightDraws(object.flashlights.slice(0, FLASHLIGHTS_PER_SET), camera, textures),
          )

    if (scene.flashlights) draws.push(...flashlightDraws(scene.flashlights, camera, textures))
  }

  // Slot 9 by layer, then the scripts' cue list, under white ambient and no lights. The fog is
  // whatever the last object left, which no effect is known to read: uncaptured.
  const effectDraws: EffectDraw[] = []
  const collect = ({ instance, texture, visible }: SceneEffect) =>
    collectEffect(instance, view, texture, effectDraws, unsupported, visible)

  for (const layer of layers)
    for (const object of objects)
      if (signedLayer(object) === layer) object.effects?.forEach(collect)

  effects.forEach(collect)

  return {
    background: background ?? BLACK_BACKGROUND,
    hooks: hooksOf(draws),
    view,
    projection: projectionMatrix(camera, aspect),
    ambient: { x: 1, y: 1, z: 1 },
    lights: [],
    draws,
    effects: effectDraws,
    unsupported: [...unsupported],
    unregistered: [...unregistered],
    shadowScale,
  }
}
