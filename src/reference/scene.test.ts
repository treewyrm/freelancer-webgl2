import assert from 'node:assert/strict'
import { test } from 'node:test'
import { read } from '@treewyrm/freelancer/thn/text'
import { rotation, sceneScript } from './scene.js'
import { scenes } from './scenes.js'

const script = sceneScript(scenes.get('li_elite')!)

test('reads back as a script of the three assignments a retail one has', () => {
  assert.deepEqual(
    read(script).map(({ name }) => name),
    ['duration', 'entities', 'events'],
  )
})

test('holds a camera on a monitor, and a lit spaceship', () => {
  for (const expected of [
    'type = SCENE',
    'type = CAMERA',
    'type = MONITOR',
    'type = LIGHT',
    'template_name = "li_elite"',
    'category = "Spaceship"',
    'flags = LIT_DYNAMIC + LIT_AMBIENT',
    'SET_CAMERA',
    '{ "Monitor_Reference", "Camera_Reference" }',
  ])
    assert.ok(script.includes(expected), expected)
})

test('the model and its light share a light group', () => {
  const groups = [
    ...script.matchAll(/type = (COMPOUND|LIGHT),\s+template_name = "[^"]*",\s+lt_grp = (\d+)/g),
  ]

  assert.equal(groups.length, 2)
  assert.equal(groups[0]![2], groups[1]![2])
})

test('rotation gives an orthonormal, right-handed matrix', () => {
  const [x, y, z] = rotation(150, 20)
  const dot = (a: readonly number[], b: readonly number[]) =>
    a.reduce((sum, cell, at) => sum + cell * b[at]!, 0)
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-5)

  for (const row of [x, y, z]) near(dot(row, row), 1)
  near(dot(x, y), 0)
  near(dot(x, z), 0)
  near(dot(y, z), 0)
  near(
    x[0] * (y[1] * z[2] - y[2] * z[1]) -
      x[1] * (y[0] * z[2] - y[2] * z[0]) +
      x[2] * (y[0] * z[1] - y[1] * z[0]),
    1,
  )
})
