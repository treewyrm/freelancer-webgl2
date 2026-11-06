import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, type Vector3 } from '@treewyrm/freelancer/math'
import { viewMatrix, type Camera } from './camera.js'
import {
  EFFECT_TYPE_NAMES,
  effectLodRow,
  effectLodType,
  effectTypeIndex,
  RETAIL_EFFECT_TYPES,
  viewEffect,
  type EffectViewOptions,
  type PlacedEffect,
} from './effect-view.js'
import { nebulaState, pickField, zoneOf, type SpaceNebula } from './nebula.js'

const camera: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 30,
  near: 1,
  far: 21000,
}
const ahead = (z: number, x = 0): Vector3 => ({ x, y: 0, z: -z })
const frame = (nebulae: SpaceNebula[] = []) => {
  const states = nebulae.map((nebula) => nebulaState(nebula, camera.position))
  const field = pickField(states, camera.position, 20000)
  return { camera, aspect: 1, view: viewMatrix(camera), nebulae: states, ...(field && { field }) }
}
const view = (effect: PlacedEffect, options?: EffectViewOptions, nebulae?: SpaceNebula[]) =>
  viewEffect(effect, frame(nebulae), options)

// `EFT_NONE`: radius 10, a bubble of 100 to 500, gone unseen. `EFT_EXPLOSION_MEDIUM` runs on unseen.
const NONE = 0
const MEDIUM = 2
// `EFT_EXPLOSION_SMALL`: as `EFT_NONE`, with a priority of 1.
const SMALL = 1

test('the retail table has every type, in order', () => {
  assert.equal(RETAIL_EFFECT_TYPES.length, 47)
  assert.deepEqual(RETAIL_EFFECT_TYPES[26], {
    priority: 1,
    genericPriority: 0.5,
    lodType: 1,
    radius: 100,
    existOffscreen: true,
    pbubble: { near: 500, far: 2000 },
  })
})

test('in view it draws; out of it, it ends, unless it exists off screen', () => {
  assert.deepEqual(view({ type: NONE, position: ahead(100) }), { fate: 'draw', lod: 1 })
  assert.equal(view({ type: NONE, position: ahead(-100) }).fate, 'die')
  assert.equal(view({ type: MEDIUM, position: ahead(-100) }).fate, 'run')
  // Off to the side, past its radius from the view's edge.
  assert.equal(view({ type: NONE, position: ahead(100, 100) }).fate, 'die')
  assert.equal(view({ type: NONE, position: ahead(100, 60) }).fate, 'draw')
})

test('its bubble narrows from far to near as generic_effect_perf falls', () => {
  // Its near side against 500, or 300 at half. A priority of 1 keeps it past the perf.
  assert.equal(view({ type: SMALL, position: ahead(505) }).fate, 'draw')
  assert.equal(view({ type: SMALL, position: ahead(515) }).fate, 'die')
  assert.equal(view({ type: SMALL, position: ahead(305) }, { effectDetail: 0.5 }).fate, 'draw')
  assert.equal(view({ type: SMALL, position: ahead(315) }, { effectDetail: 0.5 }).fate, 'die')
})

test('a priority under the perf hides it, the generic one for a generic appearance', () => {
  const small = { type: 1, position: ahead(100) }
  assert.equal(view(small, { effectDetail: 0.4 }).fate, 'draw')
  assert.equal(view({ ...small, generic: true }, { effectDetail: 0.4 }).fate, 'die')
  assert.equal(view({ type: 4, position: ahead(100) }, { effectDetail: 0.9 }).fate, 'die')
  // A mod's row over the table.
  const raised = { effectDetail: 0.9, effectTypes: { 4: { priority: 1 } } as never }
  assert.equal(view({ type: 4, position: ahead(100) }, raised).fate, 'draw')
})

test("a cloaked ship's effect hides, and so does one in another field than the camera's", () => {
  const watched = (position: Vector3, cloak = 0) => ({
    type: NONE,
    position: ahead(100),
    watched: { position, cloak },
  })
  assert.equal(view(watched(ahead(100), 1)).fate, 'die')
  assert.equal(view(watched(ahead(100), 0.5)).fate, 'draw')

  // The camera deep in one, whose fog ends 300 away.
  const core: SpaceNebula = {
    zone: zoneOf({ type: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1000 }),
    fog: { distance: 300, color: { x: 0, y: 0, z: 0 } },
  }
  assert.equal(viewEffect(watched(ahead(100)), frame([core])).fate, 'draw')
  assert.equal(viewEffect(watched(ahead(2000)), frame([core])).fate, 'die')
  const far = { ...watched(ahead(100)), position: ahead(400) }
  assert.equal(viewEffect(far, frame([core])).fate, 'die')
})

test('an [EffectLOD] row fades it in by its size on screen, and hides it under the least', () => {
  // `lod_type_small_distant`, radius 10. At 100 ahead on a 320-wide view: 10 / 100 · 160 / tan 30°.
  const size = (10 / 100) * Math.fround(160 / Math.tan(Math.PI / 6))
  const row = { maxLodScreenSize: size * 2, minLodScreenSize: 0, minScreenSize: 1 }
  const options = { viewportWidth: 320, effectLods: [, , , , , , row] }
  const { fate, lod } = view(
    { type: NONE, position: ahead(100) },
    {
      ...options,
      effectTypes: { [NONE]: { lodType: 6 } } as never,
    },
  )
  assert.equal(fate, 'draw')
  assert.ok(Math.abs(lod - 0.5) < 1e-6, `${lod}`)
  const tiny = { ...options, effectLods: [, , , , , , { ...row, minScreenSize: size + 1 }] }
  const hidden = view(
    { type: NONE, position: ahead(100) },
    {
      ...tiny,
      effectTypes: { [NONE]: { lodType: 6 } } as never,
    },
  )
  assert.deepEqual(hidden, { fate: 'die', lod: 0 })
})

test("an effect_type names its row, in the order of the game's table", () => {
  assert.equal(EFFECT_TYPE_NAMES.length, RETAIL_EFFECT_TYPES.length)
  assert.equal(effectTypeIndex('EFT_NONE'), 0)
  assert.equal(effectTypeIndex('EFT_ENGINE_FIRE'), 27)
  // `strcmp`, so case counts.
  assert.equal(effectTypeIndex('eft_engine_fire'), undefined)
  assert.equal(effectTypeIndex('EFT_EQUIP_ATTACHED'), 32)
  assert.equal(effectTypeIndex('EFT_FLASHLIGHT'), 46)
  assert.equal(effectTypeIndex('EFT_NOTHING'), undefined)
})

test('a lod_type and an [EffectLOD] type name rows 1 to 6, in any case', () => {
  assert.equal(effectLodType('EFT_LOD_TRAIL'), 1)
  assert.equal(effectLodType('eft_lod_small_distant'), 6)
  assert.equal(effectLodType('EFT_LOD_NONE'), undefined)
  assert.equal(effectLodRow('lod_type_large'), 5)
  assert.equal(effectLodRow('LOD_TYPE_WEAPON'), 2)
  assert.equal(effectLodRow('none'), undefined)
})
