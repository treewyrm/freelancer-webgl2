import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Document } from '@treewyrm/freelancer/ini'
import { RETAIL_SPACE_LIMITS } from '#/scene/space.js'
import { saveText, systemIni, systemNickname, systems, universeSection } from './systems.js'

const order = systems.get('space_order')!
const { farClip, rangeMargin, farListPlane, solarQueryRange } = RETAIL_SPACE_LIMITS
const range = farClip - rangeMargin
const distance = ([x, y, z]: readonly number[]) => Math.hypot(x!, y!, z!)
const near = (nickname: string) =>
  distance(order.objects.find((object) => object.nickname === nickname)!.position)

const sections = (text: string) =>
  [...Document.read(new TextEncoder().encode(text))].map(({ name }) => name)

test('puts one planet on the far list, and the rest inside the draw range', () => {
  assert.ok(near('Lab_far_planet') > range && near('Lab_far_planet') < farListPlane)
  assert.ok(near('Lab_near_planet') < range)
  // A small solar is looked for only this near the camera.
  for (const nickname of ['Lab_plant', 'Lab_station', 'Lab_platform'])
    assert.ok(near(nickname) < solarQueryRange, nickname)
})

test('places everything ahead of a ship facing -Z', () => {
  assert.deepEqual(order.player.rotate, [0, 0, 0])
  for (const { nickname, position } of order.objects) assert.ok(position[2] < 0, nickname)
})

test('writes a system the game reads as text', () => {
  const names = sections(systemIni(order))
  assert.equal(names[0], 'SystemInfo')
  assert.equal(names.filter((name) => name === 'Object').length, order.objects.length)
  assert.equal(names.filter((name) => name === 'LightSource').length, order.lights.length)
  assert.ok(!names.includes('Dust'))
})

test('names the system in the universe and in the save', () => {
  assert.ok(universeSection('space_order').includes(`nickname = ${systemNickname('space_order')}`))
  const save = saveText(order, '[Group]\r\nnickname = li_n_grp\r\n')
  assert.ok(save.includes(`system = ${systemNickname('space_order')}`))
  assert.ok(!/^base\s*=/m.test(save), 'a base would load it docked')
  assert.ok(save.includes('Mission = No_Mission'))
  assert.deepEqual(sections(save), ['Player', 'StoryInfo', 'Group'])
})
