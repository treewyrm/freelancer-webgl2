import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Vector3 } from '@treewyrm/freelancer/math'
import { rotate, rotationOf } from './frame.js'
import { createPath } from './path.js'

const near = (a: Vector3 | undefined, b: Vector3, e = 1e-5) =>
  assert.ok(a && Vector3.equal(a, b, e), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)

const I = { x: 0, y: 0, z: 0, w: 1 }
const TURNED = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }

test('a two-key path is a straight line travelled at constant speed', () => {
  const path = createPath({
    path_type: 'CV_CROrientationSplinePath',
    flag: 'OPEN',
    points: [
      { position: { x: 0, y: 0, z: 0 }, orientation: I },
      { position: { x: 10, y: 0, z: 0 }, orientation: TURNED },
    ],
  })!

  near(path.position(0.25), { x: 2.5, y: 0, z: 0 })
  near(path.position(-1), { x: 0, y: 0, z: 0 })
  near(path.position(2), { x: 10, y: 0, z: 0 })
  near(path.tangent(0.5), { x: 1, y: 0, z: 0 })
  // Held at the ends, and between them on the arc from one key's turn to the next.
  near(rotate(rotationOf(path.orientation(0)!), { x: 1, y: 0, z: 0 }), { x: 1, y: 0, z: 0 })
  near(rotate(rotationOf(path.orientation(1)!), { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 })

  const mid = rotate(rotationOf(path.orientation(0.5)!), { x: 1, y: 0, z: 0 })

  assert.ok(mid.y === 0 && mid.x > 0 && mid.z < 0)
})

test('the parameter is chord length: equal steps of u travel equal distance along the curve', () => {
  const path = createPath({
    path_type: 'CV_CRSplinePath',
    flag: 'OPEN',
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 9, y: 0, z: 3 },
      { x: 9, y: 5, z: 3 },
    ],
  })!

  const travelled = (to: number, steps = 4000) => {
    let sum = 0
    let previous = path.position(0)!

    for (let n = 1; n <= steps; n++) {
      const next = path.position((n / steps) * to)!

      sum += Vector3.distance(previous, next)
      previous = next
    }

    return sum
  }

  const whole = travelled(1)
  for (const u of [0.1, 0.37, 0.5, 0.9]) assert.ok(Math.abs(travelled(u) / whole - u) < 1e-3)
})

test("a path's tangent is not held at the ends, and before the start there is none", () => {
  const path = createPath({
    path_type: 'CV_CRSplinePath',
    flag: 'OPEN',
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 5 },
    ],
  })!

  near(path.tangent(1), { x: 0, y: 0, z: 1 })
  near(path.tangent(1.5), { x: 0, y: 0, z: 1 })
  assert.equal(path.tangent(-0.1), undefined)
})

test('a closed path wraps round: its last segment returns to the first key', () => {
  const path = createPath({
    path_type: 'CV_CRSplinePath',
    flag: 'CLOSED',
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 4 },
      { x: 0, y: 0, z: 4 },
    ],
  })!

  near(path.position(1), { x: 0, y: 0, z: 0 })
  // Symmetric square: a quarter of the way round is the second key.
  near(path.position(0.25), { x: 4, y: 0, z: 0 }, 1e-4)
})

test('a NULL path, or one with fewer than two keys, fails to load', () => {
  assert.equal(createPath({ path_type: 'NULL' }), undefined)
  assert.equal(
    createPath({ path_type: 'CV_CRSplinePath', flag: 'OPEN', points: [{ x: 0, y: 0, z: 0 }] }),
    undefined,
  )
})
