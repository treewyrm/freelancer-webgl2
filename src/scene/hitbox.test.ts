import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix3, Matrix4, Quat } from '@treewyrm/freelancer/math'
import { createBox, createPart, type HullGeometry } from '@treewyrm/freelancer/surface'
import { castRay, type HitboxObject } from './hitbox.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

/** A cube of side 2·half about `centre`, as one hull labelled `id`. */
const cube = (id: number, centre = at(0, 0, 0), half = 10): HullGeometry => ({
  id,
  ...createBox({
    min: at(centre.x - half, centre.y - half, centre.z - half),
    max: at(centre.x + half, centre.y + half, centre.z + half),
  }),
})

const objectOf = (
  name: string,
  hulls: HullGeometry[],
  world: Matrix4 = Matrix4.identity,
  shield?: (id: number) => boolean,
): HitboxObject => ({
  object: name,
  position: at(world.w.x, world.w.y, world.w.z),
  radius: 10,
  hitbox: { surfaces: [{ surface: createPart(1, hulls), world }], ...(shield && { shield }) },
})

const names = (hits: ReturnType<typeof castRay>) => hits.map(({ object }) => object)

test('a ray hits a hull it enters within its length, and nothing it passes or stops short of', () => {
  const box = objectOf('box', [cube(1)], Matrix4.translation(at(0, 0, -100)))
  assert.deepEqual(names(castRay([box], at(0, 0, 0), at(0, 0, -200), 6)), ['box'])
  assert.deepEqual(names(castRay([box], at(15, 0, 0), at(15, 0, -200), 6)), [])
  assert.deepEqual(names(castRay([box], at(0, 0, 0), at(0, 0, -80), 6)), [])
  // From inside, taken as no hit.
  assert.deepEqual(names(castRay([box], at(0, 0, -100), at(0, 0, -200), 6)), [])
})

test('hits come nearest first, each hull entered its own, to the limit', () => {
  const far = objectOf('far', [cube(1)], Matrix4.translation(at(0, 0, -300)))
  const near = objectOf(
    'near',
    [cube(1), cube(2, at(0, 0, -50))],
    Matrix4.translation(at(0, 0, -100)),
  )
  const from = at(0, 0, 0)
  const to = at(0, 0, -1000)
  assert.deepEqual(names(castRay([far, near], from, to, 6)), ['near', 'near', 'far'])
  assert.deepEqual(names(castRay([far, near], from, to, 2)), ['near', 'near'])
})

test("a hull is where its surface's world puts it", () => {
  const turned = Matrix4.fromRotationTranslation(
    Matrix3.fromQuaternion(Quat.axisAngle({ axis: at(0, 1, 0), angle: Math.PI / 4 })),
    at(0, 0, -100),
  )
  // Turned 45°, the cube reaches 14.1 to the side.
  const box = objectOf('box', [cube(1)], turned)
  assert.deepEqual(names(castRay([box], at(13, 0, 0), at(13, 0, -200), 6)), ['box'])
  assert.deepEqual(names(castRay([box], at(15, 0, 0), at(15, 0, -200), 6)), [])
})

test("a hit on a shield's hull says so", () => {
  const shielded = objectOf(
    'ship',
    [cube(7)],
    Matrix4.translation(at(0, 0, -100)),
    (id) => id === 7,
  )
  const [hit] = castRay([shielded], at(0, 0, 0), at(0, 0, -200), 6)
  assert.equal(hit?.shield, true)
  assert.equal(hit?.radius, 10)
  assert.deepEqual(hit?.position, at(0, 0, -100))
})

test('a ball is entered from outside, about its object', () => {
  const planet: HitboxObject = {
    object: 'planet',
    position: at(0, 0, -1000),
    radius: 100,
    hitbox: { ball: 100 },
  }
  assert.deepEqual(names(castRay([planet], at(0, 0, 0), at(0, 0, -2000), 6)), ['planet'])
  assert.deepEqual(names(castRay([planet], at(150, 0, 0), at(150, 0, -2000), 6)), [])
  assert.deepEqual(names(castRay([planet], at(0, 0, 0), at(0, 0, -800), 6)), [])
  assert.equal(castRay([planet], at(0, 0, 0), at(0, 0, -2000), 6)[0]?.shield, undefined)
})
