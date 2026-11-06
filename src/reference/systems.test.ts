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

/** A point on a zone's ring at `radius` and `angle` about its axis, turned by its pitch. */
const onRing = (
  { position, pitch }: { position: readonly number[]; pitch: number },
  radius: number,
  angle: number,
) => {
  const [x, y, z] = [Math.sin(angle) * radius, 0, Math.cos(angle) * radius]
  const p = (pitch * Math.PI) / 180
  return [
    position[0]! + x,
    position[1]! + Math.cos(p) * y - Math.sin(p) * z,
    position[2]! + Math.sin(p) * y + Math.cos(p) * z,
  ]
}

test("rings: the near one's band within the main list's reach, the far one's across it", () => {
  const outside = systems.get('ring_outside')!
  const reach = range - RETAIL_SPACE_LIMITS.ringFarMargin
  const extent = (nickname: string) => {
    const zone = outside.zones!.find((entry) => entry.nickname === nickname)!
    const distances = Array.from({ length: 64 }, (_, at) =>
      distance(onRing(zone, zone.size[0], (at / 64) * 2 * Math.PI)),
    )
    return [Math.min(...distances), Math.max(...distances)]
  }
  assert.ok(extent('Lab_ring')[1]! < reach, `${extent('Lab_ring')}`)
  const [nearest, farthest] = extent('Lab_far_ring')
  assert.ok(nearest! < reach && farthest! > reach, `${nearest}, ${farthest}`)
  // Every ring's zone is its planet's, and each object names one that exists.
  for (const { ring } of outside.objects)
    if (ring) assert.ok(outside.zones!.some(({ nickname }) => nickname === ring.zone))
  const names = sections(systemIni(outside))
  assert.equal(names.filter((name) => name === 'zone').length, 2)
})

test('ring_inside puts the ship in the near band, between its radii and within its height', () => {
  const inside = systems.get('ring_inside')!
  const zone = inside.zones!.find(({ nickname }) => nickname === 'Lab_ring')!
  const offset = inside.player.position.map((c, at) => c - zone.position[at]!)
  // Back into the zone's frame: undo the pitch about X.
  const p = (-zone.pitch * Math.PI) / 180
  const local = [
    offset[0]!,
    Math.cos(p) * offset[1]! - Math.sin(p) * offset[2]!,
    Math.sin(p) * offset[1]! + Math.cos(p) * offset[2]!,
  ]
  const radial = Math.hypot(local[0]!, local[2]!)
  assert.ok(radial > zone.size[1] && radial < zone.size[0], `${radial}`)
  assert.ok(Math.abs(local[1]!) < zone.size[2] / 2, `${local[1]}`)
})
