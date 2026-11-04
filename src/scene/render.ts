/** Executes a frame. All the GL of a game frame lives here. */
import { Matrix4 } from '@treewyrm/freelancer/math'
import type { TextureEntry } from '@treewyrm/freelancer/texture'
import type { VMeshData, VMeshRef } from '@treewyrm/freelancer/vmesh'
import {
  createDcDtProgram,
  DIFFUSE_UNIT,
  ENVIRONMENT_UNIT,
  setDrawUniforms,
  setFrameUniforms,
} from '#/material/dcdt.js'
import { createReferenceArray, createVertexBuffer } from '#/mesh/mesh.js'
import { drawMode, planReference } from '#/mesh/plan.js'
import {
  createSampler,
  createTexture,
  DEFAULT_SAMPLER,
  type SamplerState,
} from '#/texture/texture.js'
import { planUpload } from '#/texture/upload.js'
import type { Frame } from './frame.js'

export interface RendererHost {
  texture: (name: string) => TextureEntry | undefined
}

export interface Renderer {
  render: (frame: Frame) => void
}

export const createRenderer = (gl: WebGL2RenderingContext, host: RendererHost): Renderer => {
  const program = createDcDtProgram(gl)
  const vertexBuffers = new Map<VMeshData, WebGLBuffer>()
  const arrays = new Map<VMeshRef, WebGLVertexArrayObject>()
  const textures = new Map<string, WebGLTexture>()
  const samplers = new Map<string, WebGLSampler>()

  const arrayOf = (mesh: VMeshData, reference: VMeshRef): WebGLVertexArrayObject => {
    let array = arrays.get(reference)
    if (array) return array
    let vertices = vertexBuffers.get(mesh)
    if (!vertices) {
      vertices = createVertexBuffer(gl, mesh)
      vertexBuffers.set(mesh, vertices)
    }
    array = createReferenceArray(gl, mesh, vertices, planReference(mesh, reference))
    arrays.set(reference, array)
    return array
  }

  const textureOf = (name: string): WebGLTexture | undefined => {
    const known = textures.get(name)
    if (known) return known
    const entry = host.texture(name)
    if (!entry || entry.type === 'animated') return undefined
    const texture = createTexture(gl, planUpload(entry))
    textures.set(name, texture)
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

  const render = (frame: Frame): void => {
    gl.useProgram(program.handle)
    // D3D8 samples pixels at integer coordinates, GL at half. Measured: without this shift, mean
    // difference from retail's `li_elite_turned` is 8.55 of 255, against 1.55 with it.
    const shift = Matrix4.translation({
      x: 1 / gl.drawingBufferWidth,
      y: -1 / gl.drawingBufferHeight,
      z: 0,
    })
    setFrameUniforms(gl, program, {
      ...frame,
      projection: Matrix4.multiply(shift, frame.projection),
    })

    // Retail's device: DITHERENABLE 0, D3DCMP_LESS, and a target with no alpha to keep (`li_elite`).
    gl.disable(gl.DITHER)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.depthMask(true)
    gl.enable(gl.CULL_FACE)
    gl.frontFace(gl.CCW)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)

    gl.clearColor(0, 0, 0, 1)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    for (const draw of frame.draws) {
      setDrawUniforms(gl, program, draw)
      gl.cullFace(draw.cull === 'back' ? gl.BACK : gl.FRONT)
      if (draw.blend) gl.enable(gl.BLEND)
      else gl.disable(gl.BLEND)

      gl.activeTexture(gl.TEXTURE0 + DIFFUSE_UNIT)
      gl.bindTexture(gl.TEXTURE_2D, draw.texture ? (textureOf(draw.texture.name) ?? null) : null)
      gl.bindSampler(DIFFUSE_UNIT, samplerOf(draw.texture?.sampler ?? DEFAULT_SAMPLER))

      gl.activeTexture(gl.TEXTURE0 + ENVIRONMENT_UNIT)
      gl.bindTexture(
        gl.TEXTURE_CUBE_MAP,
        draw.environment ? (textureOf(draw.environment) ?? null) : null,
      )
      gl.bindSampler(ENVIRONMENT_UNIT, samplerOf(DEFAULT_SAMPLER))

      gl.bindVertexArray(arrayOf(draw.mesh, draw.reference))
      gl.drawElements(drawMode(draw.mesh.primitive), draw.count, gl.UNSIGNED_SHORT, draw.byteOffset)
    }

    gl.bindVertexArray(null)
  }

  return { render }
}
