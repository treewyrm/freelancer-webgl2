/**
 * Retail's `FX/gate_tunnel.ini`, read and drawn. No capture yet: a tunnel is only seen through a jump
 * gate, and its curves are `rand()`'s.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GateTunnel } from '#/scene/tunnel.js'
import { loadGateTunnels } from './space-load.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const skip = existsSync(data) ? false : 'no retail DATA'

const read = async (path: string) => {
  const file = readFileSync(join(data, path))
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

test(
  'reads four tunnels, each two textured layers fading from 1 to 0 whatever the file says',
  { skip },
  async () => {
    const tunnels = await loadGateTunnels(read)
    assert.deepEqual(
      [...tunnels.keys()],
      [
        'default_jump_gate',
        'gate_tunnel_asteroid_belt',
        'gate_tunnel_bretonia',
        'gate_tunnel_liberty',
      ],
    )
    const bretonia = tunnels.get('gate_tunnel_bretonia')!
    assert.equal(bretonia.writeDepth, false)
    assert.equal(bretonia.controlPoints, 9)
    assert.equal(bretonia.farRadiusFactor, 0)
    assert.deepEqual(bretonia.maxRgb, { x: 0, y: 0, z: Math.fround(100 * Math.fround(1 / 255)) })
    for (const [nickname, { layers }] of tunnels) {
      assert.deepEqual(
        layers.map(({ texture }) => texture?.name.toLowerCase()),
        ['jumptube', 'jumptube5'],
        nickname,
      )
      // `near_alpha_factor` and `far_alpha_factor` are what the files write, and nothing reads.
      for (const { nearAlpha, farAlpha } of layers) assert.deepEqual([nearAlpha, farAlpha], [1, 0])
    }
  },
)

test(
  'every retail tunnel draws, ten seconds in, its places and UVs all finite',
  { skip },
  async () => {
    for (const [nickname, settings] of await loadGateTunnels(read)) {
      const tunnel = new GateTunnel(settings)
      tunnel.setState(1)
      tunnel.setState(2)
      for (let at = 0; at < 600; at++) tunnel.update(1 / 60)
      const draws = tunnel.draws()
      assert.ok(draws.length > 10, nickname)
      for (const { mesh } of draws) {
        // Each vertex is six words, the fourth its colour's bytes.
        const floats = new Float32Array(mesh.vertices.buffer)
        assert.ok(
          floats.every((value, at) => at % 6 === 3 || Number.isFinite(value)),
          nickname,
        )
      }
    }
  },
)
