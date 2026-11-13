import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readAnimationLibrary } from '@treewyrm/freelancer/animation'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import { getBoneModel, readDeformableModel } from '@treewyrm/freelancer/deformable'
import { Quat, Vector3 } from '@treewyrm/freelancer/math'
import { Directory } from '@treewyrm/freelancer/utf'
import { Mixer, MotionFlag, type MixerJoint } from './mixer.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const body = join(data, 'CHARACTERS/BODIES/li_male_guard_body.dfm')
const library = join(data, 'CHARACTERS/ANIMATIONS/bodygenericmale.anm')

const read = (path: string) => Directory.read(new Uint8Array(readFileSync(path)))

const jointsOf = <T>(node: CompoundNode<T>): MixerJoint[] =>
  node.children.flatMap((child) => [
    ...(child.joint ? [{ name: child.name, parent: node.name, joint: child.joint }] : []),
    ...jointsOf(child),
  ])

test(
  'every generic male script plays on a male body with every value finite',
  { skip: existsSync(body) && existsSync(library) ? false : 'no retail DATA' },
  () => {
    const root = getBoneModel(readDeformableModel(read(body)))
    if (!root) return assert.fail('no root bone')

    const joints = jointsOf(root)
    const scripts = readAnimationLibrary(read(library))
    let bound = 0
    const broken: string[] = []

    for (const script of scripts) {
      const mixer = new Mixer({ root: root.name, joints })
      const handle = mixer.start(script, { transTime: 0.2, eventFlags: MotionFlag.Loop })
      if (handle !== undefined && mixer.playing(handle)) bound++
      for (let frame = 0; frame < 45; frame++) mixer.advance(1 / 30)

      const numbers = joints.flatMap(({ name }) => {
        const {
          value = 0,
          position = Vector3.zero,
          orientation = Quat.identity,
        } = mixer.jointState(name) ?? {}

        return [value, position.x, position.y, position.z, orientation.w]
      })

      const { x, y, z } = mixer.root.position
      if (![...numbers, x, y, z].every(Number.isFinite)) broken.push(script.name)
    }

    assert.deepEqual(broken, [])
    assert.deepEqual([scripts.length, bound], [455, 455])
  },
)
