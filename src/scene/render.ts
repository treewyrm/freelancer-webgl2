/** Executes a frame. All the GL of a game frame lives here, and it owns what it creates. */
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { CubeTexture, Texture } from '@treewyrm/freelancer/texture'
import type { VMeshData, VMeshRef } from '@treewyrm/freelancer/vmesh'
import { collectEffect, type EffectDraw } from '#/alchemy/draw.js'
import {
  createEffectRenderer,
  type EffectRenderer,
  type SpriteFrameStyle,
} from '#/alchemy/program.js'
import { INFLUENCE_FLOATS } from '#/deformable/skin.js'
import {
  BONES_BINDING,
  createDcDtProgram,
  DIFFUSE_UNIT,
  ENVIRONMENT_UNIT,
  SECOND_UNIT,
  setDrawUniforms,
  setFrameUniforms,
  setLights,
  type DcDtProgram,
} from '#/material/dcdt.js'
import { createScreenQuadRenderer, type ScreenQuadRenderer } from '#/material/screen.js'
import { createReferenceArray, createVertexBuffer, type ReferenceArray } from '#/mesh/mesh.js'
import { ATTRIBUTE_LOCATIONS, drawMode, planReference } from '#/mesh/plan.js'
import {
  createSampler,
  createTexture,
  DEFAULT_SAMPLER,
  type SamplerState,
} from '#/texture/texture.js'
import { planUpload } from '#/texture/upload.js'
import type { Draw, Frame, HookName, SceneEffect } from './frame.js'

const WHOLE_DEPTH: readonly [number, number] = [0, 1]
const EFFECT_SAMPLER: SamplerState = { ...DEFAULT_SAMPLER, wrapU: 'clamp', wrapV: 'clamp' }

export interface HookContext {
  gl: WebGL2RenderingContext
  frame: Frame
  /** With D3D's pixel shift, so a host's lines land on the pixels the ship did. */
  viewProjection: Matrix4
  /**
   * Frames each sprite of these effects as this frame's camera has them, whether or not the frame
   * draws them: an outline, two axes and a normal, under the depth state the hook has set.
   */
  outlineEffects: (effects: readonly SceneEffect[], style: SpriteFrameStyle) => void
}

/**
 * The host's own drawing. It finds the depth buffer the game path left, with no vertex array or
 * sampler object bound, and may change any GL state: the renderer sets its own again after each hook,
 * so nothing leaks into the game path.
 */
export type FrameHooks = Partial<Record<HookName, (context: HookContext) => void>>

/** A rectangle of the target in pixels, from its bottom left as GL counts. */
export interface ViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RenderOptions {
  /**
   * Where the picture goes, as D3D's viewport: drawn and cleared there alone, the rest of the target
   * left as it was. The letterbox's picture, `(0, bar, w, h − 2·bar)`, with the scene's `aspect` its
   * own (THN-HOST.md, the letterbox). The whole target when absent.
   */
  viewport?: ViewportRect
}

export interface Renderer {
  /** Draws, and answers false if there is no context to draw with for now. */
  render: (frame: Frame, hooks?: FrameHooks, options?: RenderOptions) => boolean
  /** Frees what depends on an edited mesh or texture. The next frame uses it afresh. */
  invalidate: (asset: VMeshData | Texture | CubeTexture) => void
  /** Frees everything, and the renderer with it. */
  dispose: () => void
}

interface MeshResources {
  vertices: WebGLBuffer
  influences?: WebGLBuffer
  references: Map<VMeshRef, ReferenceArray>
}

/**
 * Takes a context, and keeps only GPU handles keyed on what the host's frames hold. So a lost context
 * needs nothing from the host but the next frame, whose data rebuilds them.
 */
export const createRenderer = (gl: WebGL2RenderingContext): Renderer => {
  let program: DcDtProgram | undefined
  let effects: EffectRenderer | undefined
  let quads: ScreenQuadRenderer | undefined
  let meshes = new Map<VMeshData, MeshResources>()
  let textures = new Map<Texture | CubeTexture, WebGLTexture>()
  let samplers = new Map<string, WebGLSampler>()
  let disposed = false

  const forget = () => {
    program = undefined
    effects = undefined
    quads = undefined
    meshes = new Map()
    textures = new Map()
    samplers = new Map()
  }

  // Without this default a lost context never comes back.
  const onLost = (event: Event) => event.preventDefault()
  const onRestored = () => forget()

  gl.canvas.addEventListener('webglcontextlost', onLost)
  gl.canvas.addEventListener('webglcontextrestored', onRestored)

  const freeMesh = ({ vertices, influences, references }: MeshResources) => {
    gl.deleteBuffer(vertices)
    if (influences) gl.deleteBuffer(influences)

    for (const { array, elements } of references.values()) {
      gl.deleteVertexArray(array)
      gl.deleteBuffer(elements)
    }
  }

  const arrayOf = (
    mesh: VMeshData,
    reference: VMeshRef,
    influences?: Float32Array,
  ): WebGLVertexArrayObject => {
    let resources = meshes.get(mesh)

    if (!resources) {
      resources = { vertices: createVertexBuffer(gl, mesh), references: new Map() }
      meshes.set(mesh, resources)
    }

    let array = resources.references.get(reference)

    if (!array) {
      array = createReferenceArray(gl, mesh, resources.vertices, planReference(mesh, reference))

      if (influences) {
        resources.influences ??= gl.createBuffer()
        gl.bindVertexArray(array.array)
        gl.bindBuffer(gl.ARRAY_BUFFER, resources.influences)
        gl.bufferData(gl.ARRAY_BUFFER, influences, gl.STATIC_DRAW)

        // Per vertex, 8 floats: four bone indices at byte 0, then their four weights at 16.
        const stride = INFLUENCE_FLOATS * 4

        gl.enableVertexAttribArray(ATTRIBUTE_LOCATIONS.boneIndex)
        gl.vertexAttribPointer(ATTRIBUTE_LOCATIONS.boneIndex, 4, gl.FLOAT, false, stride, 0)
        gl.enableVertexAttribArray(ATTRIBUTE_LOCATIONS.boneWeight)
        gl.vertexAttribPointer(ATTRIBUTE_LOCATIONS.boneWeight, 4, gl.FLOAT, false, stride, 16)
        gl.bindVertexArray(null)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)
      }

      resources.references.set(reference, array)
    }

    return array.array
  }

  const textureOf = (entry: Texture | CubeTexture): WebGLTexture => {
    let texture = textures.get(entry)

    if (!texture) {
      texture = createTexture(gl, planUpload(entry))
      textures.set(entry, texture)
    }

    return texture
  }

  const samplerOf = (state: SamplerState): WebGLSampler => {
    const key = JSON.stringify(state)
    let sampler = samplers.get(key)

    if (!sampler) {
      sampler = createSampler(gl, state)
      samplers.set(key, sampler)
    }

    return sampler
  }

  const render = (
    frame: Frame,
    hooks: FrameHooks = {},
    { viewport }: RenderOptions = {},
  ): boolean => {
    if (disposed) throw new Error('This renderer has been disposed')
    if (gl.isContextLost()) return false
    program ??= createDcDtProgram(gl)

    const active = program

    const target: WebGLFramebuffer | null = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const [left, bottom, width, height]: [number, number, number, number] = viewport
      ? [viewport.x, viewport.y, viewport.width, viewport.height]
      : target
        ? [0, 0, gl.getParameter(gl.VIEWPORT)[2], gl.getParameter(gl.VIEWPORT)[3]]
        : [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight]

    // D3D8's `Clear` with no rectangles clears the viewport alone.
    const clear = (mask: number) => {
      if (viewport) {
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(left, bottom, width, height)
      }
      gl.clear(mask)
      gl.disable(gl.SCISSOR_TEST)
    }

    // D3D8 samples pixels at integer coordinates, GL at half. Measured: without this shift, mean
    // difference from retail's `li_elite_turned` is 8.55 of 255, against 1.55 with it.
    const shift = Matrix4.translation({ x: 1 / width, y: -1 / height, z: 0 })
    const projection = Matrix4.multiply(shift, frame.projection)
    const viewProjection = Matrix4.multiply(projection, frame.view)

    const applyState = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target)
      gl.viewport(left, bottom, width, height)
      gl.useProgram(active.handle)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, BONES_BINDING, active.boneBuffer)
      setFrameUniforms(gl, active, { ...frame, projection })

      // Retail's device: DITHERENABLE 0, D3DCMP_LESS, and a target with no alpha to keep (`li_elite`).
      gl.disable(gl.DITHER)
      gl.disable(gl.SCISSOR_TEST)
      gl.disable(gl.STENCIL_TEST)
      gl.disable(gl.SAMPLE_COVERAGE)
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE)
      gl.disable(gl.POLYGON_OFFSET_FILL)
      gl.disable(gl.RASTERIZER_DISCARD)
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LESS)
      gl.depthMask(true)
      gl.depthRange(0, 1)
      gl.colorMask(true, true, true, true)
      // What a UV set the mesh hasn't got reads (`bands_one_uv`), whatever a hook left here.
      gl.vertexAttrib2f(ATTRIBUTE_LOCATIONS.uv0, 0, 0)
      gl.vertexAttrib2f(ATTRIBUTE_LOCATIONS.uv1, 0, 0)
      gl.vertexAttrib3f(ATTRIBUTE_LOCATIONS.normal, 0, 0, 0)
      gl.enable(gl.CULL_FACE)
      gl.frontFace(gl.CCW)
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)
    }

    // A sampler object outranks a texture's own parameters, so one left bound would change a host's.
    const release = () => {
      gl.bindVertexArray(null)
      gl.bindSampler(DIFFUSE_UNIT, null)
      gl.bindSampler(ENVIRONMENT_UNIT, null)
      gl.bindSampler(SECOND_UNIT, null)
    }

    const outlineEffects = (shown: readonly SceneEffect[], style: SpriteFrameStyle) => {
      const draws: EffectDraw[] = []

      for (const { instance, texture, visible } of shown)
        collectEffect(instance, frame.view, texture, draws, new Set(), visible)

      effects ??= createEffectRenderer(gl)
      effects.outline(draws, { gl, view: frame.view, projection, style })
    }

    const runHooks = (before: number, only?: (name: HookName) => boolean) => {
      for (const hook of frame.hooks) {
        const run =
          hook.before === before && (only?.(hook.name) ?? true) ? hooks[hook.name] : undefined
        if (!run) continue
        release()
        run({ gl, frame, viewProjection, outlineEffects })
        applyState()
      }
    }

    applyState()

    const { x, y, z } = frame.background

    gl.clearColor(x, y, z, 1)
    gl.clearDepth(1)
    clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    let previousAmbient = false
    let ownLights = false
    let uploaded: Float32Array | undefined
    const spent = new Set<VMeshData>()

    const drawOne = (draw: Draw) => {
      if (draw.transient) spent.add(draw.mesh)
      setDrawUniforms(gl, active, draw)

      const [nearDepth, farDepth] = draw.depthRange ?? WHOLE_DEPTH

      gl.depthRange(nearDepth!, farDepth!)

      if (draw.cull === 'none') gl.disable(gl.CULL_FACE)
      else {
        gl.enable(gl.CULL_FACE)
        gl.cullFace(draw.cull === 'back' ? gl.BACK : gl.FRONT)
      }

      gl.depthMask(draw.depthWrite)
      gl.depthFunc({ less: gl.LESS, lequal: gl.LEQUAL, always: gl.ALWAYS }[draw.depthFunc])

      if (draw.depthBias) {
        gl.enable(gl.POLYGON_OFFSET_FILL)
        gl.polygonOffset(0, -draw.depthBias)
      } else gl.disable(gl.POLYGON_OFFSET_FILL)

      // A draw's own ambient lasts only for that draw.
      if (previousAmbient && !draw.sceneAmbient) {
        const { x, y, z } = frame.ambient

        gl.uniform3f(active.uniforms.sceneAmbient, x, y, z)
      }

      previousAmbient = draw.sceneAmbient !== undefined

      // A draw's own lights last only for that draw, as its ambient does.
      if (draw.lightless) gl.uniform1i(active.uniforms.lightCount, 0)
      else if (draw.lights) setLights(gl, active.uniforms, draw.lights)
      else if (ownLights) setLights(gl, active.uniforms, frame.lights)
      else gl.uniform1i(active.uniforms.lightCount, frame.lights.length)

      if (draw.lights) ownLights = true
      else if (!draw.lightless) ownLights = false

      gl.uniformMatrix4fv(
        active.uniforms.projection,
        false,
        Matrix4.toArray(draw.projection ? Matrix4.multiply(shift, draw.projection) : projection),
      )

      if (draw.blend) {
        gl.enable(gl.BLEND)

        const [source, destination] = {
          alpha: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
          add: [gl.ONE, gl.ONE],
          alphaAdd: [gl.SRC_ALPHA, gl.ONE],
          multiply: [gl.DST_COLOR, gl.ZERO],
          screen: [gl.ONE, gl.ONE_MINUS_SRC_COLOR],
          premultiplied: [gl.ONE, gl.ONE_MINUS_SRC_ALPHA],
        }[draw.blendMode]

        gl.blendFuncSeparate(source!, destination!, gl.ZERO, gl.ONE)
      } else gl.disable(gl.BLEND)

      gl.activeTexture(gl.TEXTURE0 + DIFFUSE_UNIT)
      gl.bindTexture(gl.TEXTURE_2D, draw.texture ? textureOf(draw.texture.entry) : null)
      gl.bindSampler(DIFFUSE_UNIT, samplerOf(draw.texture?.sampler ?? DEFAULT_SAMPLER))

      gl.activeTexture(gl.TEXTURE0 + ENVIRONMENT_UNIT)
      gl.bindTexture(
        gl.TEXTURE_CUBE_MAP,
        draw.environmentTexture ? textureOf(draw.environmentTexture) : null,
      )
      gl.bindSampler(ENVIRONMENT_UNIT, samplerOf(DEFAULT_SAMPLER))

      const second = draw.second?.texture

      gl.activeTexture(gl.TEXTURE0 + SECOND_UNIT)
      gl.bindTexture(gl.TEXTURE_2D, second ? textureOf(second.entry) : null)
      gl.bindSampler(SECOND_UNIT, samplerOf(second?.sampler ?? DEFAULT_SAMPLER))

      if (draw.skin && draw.skin.bones !== uploaded) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, active.boneBuffer)
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, draw.skin.bones)
        gl.bindBuffer(gl.UNIFORM_BUFFER, null)
        uploaded = draw.skin.bones
      }

      gl.bindVertexArray(arrayOf(draw.mesh, draw.reference, draw.skin?.influences))
      gl.drawElements(drawMode(draw.mesh.primitive), draw.count, gl.UNSIGNED_SHORT, draw.byteOffset)
    }

    frame.draws.forEach((draw, at) => {
      runHooks(at)
      drawOne(draw)
    })
    // Nothing after the draws takes a bias.
    gl.disable(gl.POLYGON_OFFSET_FILL)

    runHooks(frame.draws.length, (name) => name !== 'end')

    if (frame.effects.length) {
      effects ??= createEffectRenderer(gl)
      effects.draw(frame.effects, {
        gl,
        view: frame.view,
        projection,
        fog: frame.effectFog,
        depthFunc: frame.effectDepthFunc,
        bindTexture: ({ texture }) => {
          gl.activeTexture(gl.TEXTURE0 + DIFFUSE_UNIT)
          gl.bindTexture(gl.TEXTURE_2D, texture ? textureOf(texture.entry) : null)
          // Alchemy's begin-draw clamps (`src/alchemy/alchemy_alchemy.cpp`), and `effect_sprites` shows it.
          gl.bindSampler(DIFFUSE_UNIT, samplerOf(EFFECT_SAMPLER))
          return texture !== undefined
        },
      })
      applyState()
    }

    if (frame.tractors?.length || frame.beams) {
      // The effects' renderer has had the program, so only `applyState` knows what's bound.
      applyState()
      previousAmbient = false
      ownLights = false
      frame.tractors?.forEach(drawOne)
      if (frame.beams) drawOne(frame.beams)
      applyState()
    }

    if (frame.screenQuads?.length) {
      quads ??= createScreenQuadRenderer(gl)
      quads.draw(
        frame.screenQuads,
        { width, height },
        ({ texture }) => {
          gl.activeTexture(gl.TEXTURE0 + DIFFUSE_UNIT)
          gl.bindTexture(gl.TEXTURE_2D, textureOf(texture))
          // `ScreenQuadFlush` clamps stage 0 (`space_order`'s draw 130, `ADDRESSU` 3).
          gl.bindSampler(DIFFUSE_UNIT, samplerOf(EFFECT_SAMPLER))
        },
        frame.effectFog,
      )
      applyState()
    }

    // `applyState` has put the frame's ambient and lights back.
    previousAmbient = false
    ownLights = false

    if (frame.clearDepth) {
      // A hook or the host's own may have left a mask, as `gl.clear` obeys it.
      gl.depthMask(true)
      clear(gl.DEPTH_BUFFER_BIT)
    }

    frame.afterEffects?.forEach(drawOne)
    gl.depthRange(0, 1)
    runHooks(frame.draws.length, (name) => name === 'end')
    effects?.prune()

    if (frame.atEnd?.length) {
      applyState()
      previousAmbient = false
      ownLights = false
      frame.atEnd.forEach(drawOne)
      gl.depthRange(0, 1)
    }

    release()

    for (const mesh of spent) {
      const resources = meshes.get(mesh)
      if (resources) freeMesh(resources)
      meshes.delete(mesh)
    }

    return true
  }

  const invalidate = (asset: VMeshData | Texture | CubeTexture) => {
    if ('vertices' in asset) {
      const resources = meshes.get(asset)
      if (resources) freeMesh(resources)
      meshes.delete(asset)
      return
    }

    const texture = textures.get(asset)
    if (texture) gl.deleteTexture(texture)
    textures.delete(asset)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    gl.canvas.removeEventListener('webglcontextlost', onLost)
    gl.canvas.removeEventListener('webglcontextrestored', onRestored)

    if (!gl.isContextLost()) {
      for (const resources of meshes.values()) freeMesh(resources)
      for (const texture of textures.values()) gl.deleteTexture(texture)
      for (const sampler of samplers.values()) gl.deleteSampler(sampler)
      effects?.dispose()
      quads?.dispose()

      if (program) {
        gl.deleteProgram(program.handle)
        gl.deleteBuffer(program.boneBuffer)
      }
    }

    forget()
  }

  return { render, invalidate, dispose }
}
