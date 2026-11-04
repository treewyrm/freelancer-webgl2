/** A collected frame against a capture, draw for draw. Test-only: it reads a capture's states. */
import assert from 'node:assert/strict'
import type { CaptureDraw } from '#/capture/capture.js'
import { namesOf, type TextureIndex } from '#/capture/texture-names.js'
import type { Draw, Frame } from '#/scene/frame.js'

// D3DTADDRESS_*.
const ADDRESS = { repeat: 1, mirror: 2, clamp: 3 } as const

export const assertFrameMatches = (
  frame: Frame,
  draws: readonly CaptureDraw[],
  index: TextureIndex,
): void => {
  const close = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} against ${b}`)

  const offsets = new Map<Draw['mesh'], number>()

  frame.draws.forEach((ours, n) => {
    const retail = draws[n]!
    const what = `draw ${n}, ${ours.materialName}`

    assert.equal(ours.count, retail.indices, what)
    // Retail's Two and nomad copy their vertices elsewhere, so only the others compare.
    // Retail holds a model's meshes in one index buffer, so each mesh has one constant offset.
    if (!ours.negateNormals && !ours.nomad) {
      const start = ours.reference.indexStart + ours.byteOffset / 2
      const offset = offsets.get(ours.mesh) ?? retail.startIndex! - start
      offsets.set(ours.mesh, offset)
      assert.equal(start + offset, retail.startIndex, what)
    }

    // D3DCULL_NONE 1, CW 2, CCW 3.
    assert.equal(retail.states['CULLMODE'], { none: 1, back: 2, front: 3 }[ours.cull], what)
    assert.equal(retail.states['LIGHTING'], ours.nomad ? 0 : 1, what)
    assert.equal(retail.states['ALPHABLENDENABLE'], ours.blend ? 1 : 0, what)
    assert.equal(retail.states['ALPHAREF'], ours.alphaReference, what)
    assert.equal(retail.states['NORMALIZENORMALS'], ours.normalizeNormals ? 1 : 0, what)
    assert.equal(retail.states['ZWRITEENABLE'], ours.depthWrite ? 1 : 0, what)

    // A nomad surface sets no material, so the device's is left over from the last draw.
    if (!ours.nomad) {
      ours.diffuse.forEach((value, c) =>
        close(value, retail.material!.diffuse[c]!, `${what} diffuse`),
      )
      const ambient = [ours.ambient.x, ours.ambient.y, ours.ambient.z]
      ambient.forEach((value, c) => close(value, retail.material!.ambient[c]!, `${what} ambient`))
      assert.deepEqual(retail.material!.emissive.slice(0, 3), [
        ours.emissive.x,
        ours.emissive.y,
        ours.emissive.z,
      ])
    }

    const stageNames = (stage: number) =>
      namesOf(index, retail.stages[stage]!.texture!).map(({ name }) => name.toLowerCase())
    if (ours.texture) assert.ok(stageNames(0).includes(ours.texture.name.toLowerCase()), what)
    else assert.equal(retail.stages[0]!.texture, undefined, what)

    // Stage 1's operation is ours. Draw 12 of `li_elite` leaves a stale cube bound, off.
    const operation = retail.stages[1]!.states['COLOROP']
    // D3DTOP_DISABLE 1, MODULATE2X 5, ADD 7.
    // A nomad surface keeps its stage on whether or not the ramp resolved.
    const stage =
      ours.environment || ours.second?.operation === 'modulate2x'
        ? 5
        : ours.second || ours.nomad
          ? 7
          : 1
    assert.equal(operation, stage, what)
    if (ours.second?.texture) {
      assert.ok(stageNames(1).includes(ours.second.texture.name.toLowerCase()), what)
      assert.equal(retail.stages[1]!.states['TEXCOORDINDEX'], ours.second.texture.uvSet, what)
    }
    if (ours.environment) {
      assert.ok(stageNames(1).includes(ours.environment), what)
      assert.equal(retail.stages[1]!.states['TEXCOORDINDEX'], 0x30000, what)
    }

    if (ours.texture)
      assert.equal(retail.stages[0]!.states['ADDRESSU'], ADDRESS[ours.texture.sampler.wrapU], what)
  })
}
