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
      distance(onRing(zone, zone.size[0]!, (at / 64) * 2 * Math.PI)),
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
  assert.ok(radial > zone.size[1]! && radial < zone.size[0]!, `${radial}`)
  assert.ok(Math.abs(local[1]!) < zone.size[2]! / 2, `${local[1]}`)
})

test('asteroids: each save stands where it says, in or out of the field, the nebula and the hole', () => {
  const zoneOf = (name: string, nickname: string) =>
    systems.get(name)!.zones!.find((zone) => zone.nickname === nickname)!
  const inside = (name: string, nickname: string) => {
    const { position, size } = zoneOf(name, nickname)
    const { position: ship } = systems.get(name)!.player
    return distance(ship.map((c, at) => c - position[at]!)) < size[0]!
  }
  const where = (name: string) =>
    ['Lab_field', 'Lab_nebula', 'Lab_nebula_hole', 'Lab_station_exclusion'].map((zone) =>
      inside(name, zone),
    )
  assert.deepEqual(where('asteroid_inside'), [true, false, false, false])
  assert.deepEqual(where('asteroid_nebula'), [true, true, false, false])
  assert.deepEqual(where('asteroid_outside'), [false, false, false, false])
  // In the hole, which is in the nebula and the field: deep in it, and in its edge's last 20%.
  assert.deepEqual(where('asteroid_hole'), [true, true, true, false])
  assert.deepEqual(where('asteroid_hole_edge'), [true, true, true, false])
  const hole = zoneOf('asteroid_hole', 'Lab_nebula_hole')
  const fromHole = (name: string) =>
    distance(systems.get(name)!.player.position.map((c, at) => c - hole.position[at]!))
  assert.ok(fromHole('asteroid_hole') < 600 * 0.8)
  assert.ok(fromHole('asteroid_hole_edge') > 600 * 0.8 && fromHole('asteroid_hole_edge') < 600)
  // Outside, farther than the field's radius and its fill distance of 1650: no cube near enough.
  const { position } = zoneOf('asteroid_outside', 'Lab_field')
  const ship = systems.get('asteroid_outside')!.player.position
  assert.ok(distance(ship.map((c, at) => c - position[at]!)) > 5000 + 1650)
  // The station and the plant each stand in their exclusion zone.
  const system = systems.get('asteroid_inside')!
  for (const [object, zone] of [
    ['Lab_field_station', 'Lab_station_exclusion'],
    ['Lab_hole_plant', 'Lab_nebula_hole'],
  ] as const) {
    const at = system.objects.find(({ nickname }) => nickname === object)!.position
    const { position: centre, size } = zoneOf('asteroid_inside', zone)
    assert.ok(distance(at.map((c, i) => c - centre[i]!)) < size[0]!, object)
  }
})

test('asteroids: the system names its field and nebula, and writes files the game reads', () => {
  const system = systems.get('asteroid_inside')!
  const names = sections(systemIni(system))
  assert.equal(names.filter((name) => name === 'Asteroids').length, 1)
  assert.equal(names.filter((name) => name === 'Nebula').length, 1)
  for (const { path, text } of system.files!) {
    const read = sections(text)
    assert.ok(read.length > 3, path)
    // Nothing `rand()` drives.
    for (const random of ['DynamicAsteroids', 'AsteroidBillboards', 'Clouds'])
      assert.ok(!read.includes(random), `${path}: ${random}`)
    // A nebula's exterior builds no bits without slices.
    if (read.includes('Exterior')) assert.match(text, /^plane_slices = 0$/m, path)
  }
  // Every exclusion a file names is a zone of the system.
  for (const { text } of system.files!)
    for (const [, zone] of text.matchAll(/^exclusion = (\S+)/gm))
      assert.ok(
        system.zones!.some(({ nickname }) => nickname === zone),
        `${zone}`,
      )
})

test("dust: the system's [Dust] and a zone's spacedust, the edge's point about half in", () => {
  const deep = systems.get('dust_zone')!
  const text = systemIni(deep)
  assert.ok(sections(text).includes('Dust'))
  assert.ok(text.includes('spacedust = Dust'))
  assert.ok(text.includes('spacedust = attractdust'))
  assert.ok(text.includes('spacedust_maxparticles = 250'))
  const edge = systems.get('dust_zone_edge')!.zones![0]!
  // The dust stands 60 ahead of a camera near the ship: about 1500 from the centre, of 2000.
  const out = distance([edge.position[0]!, edge.position[1]!, edge.position[2]! + 60]) / 2000
  const immersion = (1 - out) / edge.edgeFraction!
  assert.ok(Math.abs(immersion - 0.5) < 0.01)
})
