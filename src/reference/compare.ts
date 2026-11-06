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
  /** Retail streams a sphere's patch, so it has no constant place in an index buffer. */
  { streamed = false }: { streamed?: boolean } = {},
): void => {
  const close = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} against ${b}`)

  const offsets = new Map<Draw['mesh'], number>()

  frame.draws.forEach((ours, n) => {
    const retail = draws[n]!
    const what = `draw ${n}, ${ours.materialName}`

    // A ring piece is drawn from memory, `DrawPrimitiveUP`, with no indices and no buffer.
    const immediate = retail.call === 'DrawPrimitiveUP'
    assert.equal(ours.count, immediate ? retail.vertices : retail.indices, what)
    // Retail's Two, nomad and atmosphere copy their vertices elsewhere, so only the others compare.
    // Retail holds a model's meshes in one index buffer, so each mesh has one constant offset.
    if (!ours.negateNormals && !ours.nomad && !ours.atmosphere && !streamed && !immediate) {
      const start = ours.reference.indexStart + ours.byteOffset / 2
      const offset = offsets.get(ours.mesh) ?? retail.startIndex! - start
      offsets.set(ours.mesh, offset)
      assert.equal(start + offset, retail.startIndex, what)
    }

    // D3DCULL_NONE 1, CW 2, CCW 3.
    assert.equal(retail.states['CULLMODE'], { none: 1, back: 2, front: 3 }[ours.cull], what)
    assert.equal(retail.states['LIGHTING'], ours.nomad || ours.unlit ? 0 : 1, what)
    assert.equal(retail.states['ALPHABLENDENABLE'], ours.blend ? 1 : 0, what)
    assert.equal(retail.states['ALPHAREF'], ours.alphaReference, what)
    assert.equal(retail.states['ALPHATESTENABLE'], ours.alphaFunction === 'always' ? 0 : 1, what)
    // D3DCMP_LESS 2, GREATER 5.
    if (ours.alphaFunction !== 'always')
      assert.equal(retail.states['ALPHAFUNC'], ours.alphaFunction === 'less' ? 2 : 5, what)
    assert.equal(retail.states['NORMALIZENORMALS'], ours.normalizeNormals ? 1 : 0, what)
    assert.equal(retail.states['ZWRITEENABLE'], ours.depthWrite ? 1 : 0, what)

    // A nomad surface sets no material, so the device's is left over from the last draw. Nor does an
    // unlit immediate draw, which lighting off leaves unread.
    if (!ours.nomad && !(immediate && ours.unlit)) {
      ours.diffuse.forEach((value, c) =>
        close(value, retail.material!.diffuse[c]!, `${what} diffuse`),
      )
      const ambient = [ours.ambient.x, ours.ambient.y, ours.ambient.z]
      ambient.forEach((value, c) => close(value, retail.material!.ambient[c]!, `${what} ambient`))
      const emissive = [ours.emissive.x, ours.emissive.y, ours.emissive.z]
      emissive.forEach((value, c) =>
        close(value, retail.material!.emissive[c]!, `${what} emissive`),
      )
    }

    const stageNames = (stage: number) =>
      namesOf(index, retail.stages[stage]!.texture!).map(({ name }) => name.toLowerCase())
    if (ours.texture) assert.ok(stageNames(0).includes(ours.texture.name.toLowerCase()), what)
    // With stage 0 empty and off, `BindEnvMap` takes it. Engine glow is the one with no stage 0 table.
    else if (retail.stages[0]!.states['COLOROP'] !== 5)
      assert.equal(retail.stages[0]!.texture, undefined, what)

    // D3DBLEND: ZERO 1, ONE 2, SRCALPHA 5, INVSRCALPHA 6, DESTCOLOR 9.
    if (ours.blend) {
      const [source, destination] = {
        alpha: [5, 6],
        add: [2, 2],
        alphaAdd: [5, 2],
        multiply: [9, 1],
      }[ours.blendMode]
      assert.deepEqual(
        [retail.states['SRCBLEND'], retail.states['DESTBLEND']],
        [source, destination],
        what,
      )
    }

    // D3DCMP_LESS 2, LESSEQUAL 4. With `ZENABLE` 0 the device ignores `ZFUNC`: a sky sets 8, and
    // the far list leaves whatever was there (`DrainBucket`).
    assert.equal(retail.states['ZENABLE'], ours.depthFunc === 'always' ? 0 : 1, what)
    if (ours.depthFunc !== 'always')
      assert.equal(retail.states['ZFUNC'], { less: 2, lequal: 4 }[ours.depthFunc], what)
    // The menu's is white. In space each object carries the system's, or its nebula's.
    if (ours.sceneAmbient) {
      const { x, y, z } = ours.sceneAmbient
      const byte = (c: number) => Math.round(c * 255)
      const packed = ((0xff << 24) | (byte(x) << 16) | (byte(y) << 8) | byte(z)) >>> 0
      assert.equal(retail.states['AMBIENT'], packed, what)
    }

    // Stage 0's transform is on when ours is.
    assert.equal(retail.stages[0]!.transform !== undefined, ours.uvTransform !== undefined, what)

    // Stage 1's operation is ours. Draw 12 of `li_elite` leaves a stale cube bound, off.
    const onStageZero = !ours.texture && retail.stages[0]!.states['COLOROP'] === 5
    const operation = retail.stages[onStageZero ? 0 : 1]!.states['COLOROP']
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
    // A planet mask's tile matrix, and retail's flags saying the stage applies it.
    if (ours.second?.tile !== undefined) {
      assert.equal(retail.stages[1]!.states['TEXTURETRANSFORMFLAGS'], 2, what)
      close(retail.stages[1]!.transform![0]!, ours.second.tile, `${what} tile`)
      close(retail.stages[1]!.transform![5]!, ours.second.tile, `${what} tile`)
    }
    if (ours.environment) {
      const stage = onStageZero ? 0 : 1
      assert.ok(stageNames(stage).includes(ours.environment), what)
      assert.equal(retail.stages[stage]!.states['TEXCOORDINDEX'], 0x30000, what)
    }

    if (ours.texture)
      assert.equal(retail.stages[0]!.states['ADDRESSU'], ADDRESS[ours.texture.sampler.wrapU], what)
  })
}
