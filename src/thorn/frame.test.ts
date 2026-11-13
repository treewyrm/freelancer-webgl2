import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, Vector3 } from '@treewyrm/freelancer/math'
import { axisTurn, lookAt, nlerp, quaternionOf, rotate, rotationOf } from './frame.js'

const near = (a: Vector3, b: Vector3, e = 1e-6) =>
  assert.ok(Vector3.equal(a, b, e), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)

const X = { x: 1, y: 0, z: 0 }
const Y = { x: 0, y: 1, z: 0 }
const Z = { x: 0, y: 0, z: 1 }
const NEG_Z = { x: 0, y: 0, z: -1 }

test("x86math's quaternion is the column-vector rotation, scaled by 2/|q|²", () => {
  // 90° about Y, at twice unit length.
  const q = { x: 0, y: Math.SQRT1_2 * 2, z: 0, w: Math.SQRT1_2 * 2 }
  const R = rotationOf(q)

  near(rotate(R, X), { x: 0, y: 0, z: -1 })
  near(rotate(R, Z), X)

  const back = quaternionOf(R)

  near(rotate(rotationOf(back), X), { x: 0, y: 0, z: -1 })
})

test('every slerp in thorn is an nlerp folded onto the first hemisphere', () => {
  const a = { x: 0, y: 0, z: 0, w: 1 }
  const minusA = { x: 0, y: 0, z: 0, w: -1 }

  assert.deepEqual(nlerp(a, minusA, 0.5), { x: 0, y: 0, z: 0, w: 1 })

  // Halfway to 90° about Y is 45° exactly: the two are a unit apart in the plane.
  const b = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }

  near(rotate(rotationOf(nlerp(a, b, 0.5)), X), {
    x: Math.SQRT1_2,
    y: 0,
    z: -Math.SQRT1_2,
  })
})

test('LOOK_AT turns the front axis onto the direction and leans up toward Y', () => {
  // front NEG_Z_AXIS (5), up Y_AXIS (1).
  const R = lookAt({ x: 3, y: 0, z: 0 }, 5, 1)

  near(rotate(R, NEG_Z), X)
  near(rotate(R, Y), Y)
  // Right-handed.
  near(Vector3.cross(rotate(R, X), rotate(R, Y)), rotate(R, Z))
})

test("within 0.99 of the scene's up, LOOK_AT leans on the scene's X instead", () => {
  const R = lookAt({ x: 0, y: 2, z: 0 }, 5, 1)

  near(rotate(R, NEG_Z), Y)
  near(rotate(R, Y), Z)
  near(rotate(R, X), X)
})

test('LOOK_AT writes the front and up columns and crosses them for the third', () => {
  // front Z_AXIS (2), up X_AXIS (0): Y is Z × X.
  const R = lookAt({ x: 0, y: 0, z: -1 }, 2, 0)

  near(rotate(R, Z), NEG_Z)
  near(rotate(R, Y), Vector3.cross(rotate(R, Z), rotate(R, X)))
})

test('axisrot turns about the scene axis for X, Y, Z and its own for the negative names, same sign', () => {
  // A base turned 90° about Z, so its own Y is the scene's −X.
  const base = Matrix4.fromTRS(Vector3.zero, { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, 1)
  const scene = axisTurn(base, 1, 90)
  const own = axisTurn(base, 4, 90)

  // About the scene's Y: the base's X axis (scene Y) stays put.
  near(rotate(scene, X), Y)
  // About its own Y, by +90° all the same: base · Rot(Y, 90°).
  near(rotate(own, X), rotate(base, { x: 0, y: 0, z: -1 }))
  near(rotate(axisTurn(Matrix4.identity, 1, 90), X), { x: 0, y: 0, z: -1 })
})

/**
 * The extension's model of `0x6f2e440`, fitted by running it under emulation over 9,600 directions
 * and every front and up pair (`freelancer-vscode/src/webview/thn/frame.ts`): an independent reading.
 */
const fitted = (d: Vector3, front: number, up: number): Matrix4 => {
  const axis = (k: number): Vector3 => {
    const v = [0, 0, 0]

    v[k % 3] = k > 2 ? -1 : 1
    return { x: v[0]!, y: v[1]!, z: v[2]! }
  }

  const sign = (k: number) => (k > 2 ? -1 : 1)
  const fd = Vector3.normalize(d)
  const along = Vector3.dot(Y, fd)
  const u =
    Math.abs(along) <= 0.99
      ? Vector3.normalize(Vector3.subtract(Y, Vector3.multiplyScalar(fd, along)))
      : Vector3.cross(
          Vector3.multiplyScalar(
            Vector3.normalize(Vector3.subtract(X, Vector3.multiplyScalar(fd, fd.x))),
            -sign(front) * sign(up),
          ),
          fd,
        )
  const cols = (a: Vector3, b: Vector3, c: Vector3): Matrix4 => ({
    x: { ...a, w: 0 },
    y: { ...b, w: 0 },
    z: { ...c, w: 0 },
    w: { x: 0, y: 0, z: 0, w: 1 },
  })
  const a = axis(front)
  const b = axis(up)

  return Matrix4.multiply(
    cols(fd, u, Vector3.cross(fd, u)),
    Matrix4.transpose(cols(a, b, Vector3.cross(a, b))),
  )
}

test('LOOK_AT agrees with the emulated reading for every front and up pair', () => {
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const directions = [Y, { x: 0, y: -3, z: 0 }, { x: 0.05, y: 1, z: 0.05 }]
  for (let n = 0; n < 200; n++) directions.push({ x: random(), y: random(), z: random() })

  for (let front = 0; front < 6; front++)
    for (let up = 0; up < 6; up++) {
      if (front % 3 === up % 3) continue

      for (const d of directions) {
        const ours = lookAt(d, front, up)
        const theirs = fitted(d, front, up)
        for (const v of [X, Y, Z]) near(rotate(ours, v), rotate(theirs, v), 1e-6)
      }
    }
})
