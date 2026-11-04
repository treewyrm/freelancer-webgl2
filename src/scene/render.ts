/** Executes a frame. All the GL of a game frame lives here, and it owns what it creates. */
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { CubeTexture, Texture } from '@treewyrm/freelancer/texture'
import type { VMeshData, VMeshRef } from '@treewyrm/freelancer/vmesh'
import {
  createDcDtProgram,
  DIFFUSE_UNIT,
  ENVIRONMENT_UNIT,
  SECOND_UNIT,
  setDrawUniforms,
  setFrameUniforms,
  type DcDtProgram,
} from '#/material/dcdt.js'
import { createReferenceArray, createVertexBuffer, type ReferenceArray } from '#/mesh/mesh.js'
import { ATTRIBUTE_LOCATIONS, drawMode, planReference } from '#/mesh/plan.js'
import {
  createSampler,
  createTexture,
  DEFAULT_SAMPLER,
  type SamplerState,
} from '#/texture/texture.js'
import { planUpload } from '#/texture/upload.js'
import type { Frame, HookName } from './frame.js'

export interface HookContext {
  gl: WebGL2RenderingContext
  frame: Frame
  /** With D3D's pixel shift, so a host's lines land on the pixels the ship did. */
  viewProjection: Matrix4
}

/**
 * The host's own drawing. It finds the depth buffer the game path left, with no vertex array or
 * sampler object bound, and may change any GL state: the renderer sets its own again after each hook,
 * so nothing leaks into the game path.
 */
export type FrameHooks = Partial<Record<HookName, (context: HookContext) => void>>

export interface Renderer {
  /** Draws, and answers false if there is no context to draw with for now. */
  render: (frame: Frame, hooks?: FrameHooks) => boolean
  /** Frees what depends on an edited mesh or texture. The next frame uses it afresh. */
  invalidate: (asset: VMeshData | Texture | CubeTexture) => void
  /** Frees everything, and the renderer with it. */
  dispose: () => void
}

interface MeshResources {
  vertices: WebGLBuffer
  references: Map<VMeshRef, ReferenceArray>
}

/**
 * Takes a context, and keeps only GPU handles keyed on what the host's frames hold. So a lost context
 * needs nothing from the host but the next frame, whose data rebuilds them.
 */
export const createRenderer = (gl: WebGL2RenderingContext): Renderer => {
  let program: DcDtProgram | undefined
  let meshes = new Map<VMeshData, MeshResources>()
  let textures = new Map<Texture | CubeTexture, WebGLTexture>()
  let samplers = new Map<string, WebGLSampler>()
  let disposed = false

  const forget = () => {
    program = undefined
    meshes = new Map()
    textures = new Map()
    samplers = new Map()
  }

  // Without this default a lost context never comes back.
  const onLost = (event: Event) => event.preventDefault()
  const onRestored = () => forget()
  gl.canvas.addEventListener('webglcontextlost', onLost)
  gl.canvas.addEventListener('webglcontextrestored', onRestored)

  const freeMesh = ({ vertices, references }: MeshResources) => {
    gl.deleteBuffer(vertices)
    for (const { array, elements } of references.values()) {
      gl.deleteVertexArray(array)
      gl.deleteBuffer(elements)
    }
  }

  const arrayOf = (mesh: VMeshData, reference: VMeshRef): WebGLVertexArrayObject => {
    let resources = meshes.get(mesh)
    if (!resources) {
      resources = { vertices: createVertexBuffer(gl, mesh), references: new Map() }
      meshes.set(mesh, resources)
    }
    let array = resources.references.get(reference)
    if (!array) {
      array = createReferenceArray(gl, mesh, resources.vertices, planReference(mesh, reference))
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

  const render = (frame: Frame, hooks: FrameHooks = {}): boolean => {
    if (disposed) throw new Error('This renderer has been disposed')
    if (gl.isContextLost()) return false
    program ??= createDcDtProgram(gl)
    const active = program

    const target: WebGLFramebuffer | null = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const width = target ? gl.getParameter(gl.VIEWPORT)[2] : gl.drawingBufferWidth
    const height = target ? gl.getParameter(gl.VIEWPORT)[3] : gl.drawingBufferHeight

    // D3D8 samples pixels at integer coordinates, GL at half. Measured: without this shift, mean
    // difference from retail's `li_elite_turned` is 8.55 of 255, against 1.55 with it.
    const shift = Matrix4.translation({ x: 1 / width, y: -1 / height, z: 0 })
    const projection = Matrix4.multiply(shift, frame.projection)
    const viewProjection = Matrix4.multiply(projection, frame.view)

    const applyState = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target)
      gl.viewport(0, 0, width, height)
      gl.useProgram(active.handle)
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

    const runHooks = (before: number) => {
      for (const hook of frame.hooks) {
        const run = hook.before === before ? hooks[hook.name] : undefined
        if (!run) continue
        release()
        run({ gl, frame, viewProjection })
        applyState()
      }
    }

    applyState()
    const { x, y, z } = frame.background
    gl.clearColor(x, y, z, 1)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    let previousAmbient = false
    frame.draws.forEach((draw, at) => {
      runHooks(at)
      setDrawUniforms(gl, active, draw)
      if (draw.cull === 'none') gl.disable(gl.CULL_FACE)
      else {
        gl.enable(gl.CULL_FACE)
        gl.cullFace(draw.cull === 'back' ? gl.BACK : gl.FRONT)
      }
      gl.depthMask(draw.depthWrite)
      gl.depthFunc(draw.depthFunc === 'lequal' ? gl.LEQUAL : gl.LESS)
      // A draw's own ambient lasts only for that draw.
      if (previousAmbient && !draw.sceneAmbient) {
        const { x, y, z } = frame.ambient
        gl.uniform3f(active.uniforms.sceneAmbient, x, y, z)
      }
      previousAmbient = draw.sceneAmbient !== undefined
      if (draw.blend) {
        gl.enable(gl.BLEND)
        const [source, destination] = {
          alpha: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
          add: [gl.ONE, gl.ONE],
          alphaAdd: [gl.SRC_ALPHA, gl.ONE],
          multiply: [gl.DST_COLOR, gl.ZERO],
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

      gl.bindVertexArray(arrayOf(draw.mesh, draw.reference))
      gl.drawElements(drawMode(draw.mesh.primitive), draw.count, gl.UNSIGNED_SHORT, draw.byteOffset)
    })

    runHooks(frame.draws.length)
    release()
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
      if (program) gl.deleteProgram(program.handle)
    }
    forget()
  }

  return { render, invalidate, dispose }
}
