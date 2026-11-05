import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import type { Material } from '@treewyrm/freelancer/material'
import type { CompoundNode } from '@treewyrm/freelancer/compound'
import type { RigidPart } from '@treewyrm/freelancer/rigid'
import {
  Primitive,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { createProgram } from '#/gl/program.js'
import type { Fixture } from '#/harness.js'
import { DIFFUSE_UNIT, ENVIRONMENT_UNIT } from '#/material/dcdt.js'
import { collectFrame, placeParts, type Frame, type Scene, type SceneModel } from './frame.js'
import { createRenderer, type FrameHooks } from './render.js'

export interface RenderReport {
  error: number
  emptyHooksMatch: boolean
  trashingHooksMatch: boolean
  hookOrder: string[]
  samplersInHook: boolean[]
  samplersAfter: boolean[]
  opaqueHookSeesDepth: number[]
  endHookDraws: number[]
  sharedBuffers: { vertexBuffers: number; arrays: number }
  afterInvalidate: { before: number[]; after: number[]; untouched: boolean }
  whileLost: boolean
  afterRestore: { drew: boolean; matches: boolean }
  /** Buffers still alive that it made, and how many textures it freed. */
  liveAfterDispose: { buffers: number; textures: number }
  disposedThrows: boolean
  otherRendererStillDraws: boolean
}

// FVF 0x112. A square at z, facing +Z, whose normal is lit by `shade`.
const square = (z: number): Float32Array => {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]
  return new Float32Array(corners.flatMap(([x, y]) => [x!, y!, z, 0, 0, 1, 0, 0]))
}

const meshOf = (z: number, materialId: number): VMeshData => ({
  name: `mesh${z}`,
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x112 as VertexFormat,
  groups: [{ materialId, vertexStart: 0, vertexEnd: 3, elementCount: 6, padding: 0 }],
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  vertices: new Uint8Array(square(z).buffer),
})

const referenceOf = (): VMeshRef => ({
  meshId: 1,
  vertexStart: 0,
  vertexCount: 4,
  indexStart: 0,
  indexCount: 6,
  groupStart: 0,
  groupCount: 1,
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 0 },
})

const part = (reference: VMeshRef): CompoundNode<RigidPart> => ({
  type: 'compound',
  name: 'Root',
  index: 0,
  filename: 'root.3db',
  part: { type: 'rigid', hardpoints: [], part: { type: 'vmeshpart', reference } },
  children: [],
})

const OPAQUE: Material = { name: 'o', type: 'DcDt', diffuse: { x: 1, y: 0, z: 0 } }
const BLENDED: Material = { name: 'b', type: 'DcDt', diffuse: { x: 0, y: 1, z: 0 }, opacity: 0.5 }

const modelOf = (mesh: VMeshData, material: Material): SceneModel => ({
  parts: placeParts(part(referenceOf()), Matrix4.translation({ x: 0, y: 0, z: 0 })),
  mesh: () => mesh,
  material: () => material,
  texture: () => undefined,
})

const sceneOf = (models: SceneModel[]): Scene => ({
  camera: {
    position: { x: 0, y: 0, z: 5 },
    orientation: Matrix3.identity,
    fovh: 45,
    near: 1,
    far: 100,
  },
  aspect: 1,
  ambient: { x: 0, y: 0, z: 0 },
  lights: [{ color: { x: 1, y: 1, z: 1 }, direction: { x: 0, y: 0, z: -1 } }],
  models,
})

const pixels = (gl: WebGL2RenderingContext): Uint8Array => {
  const out = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, out)
  return out
}

const same = (a: Uint8Array, b: Uint8Array) => a.every((value, at) => value === b[at])

const centre = (gl: WebGL2RenderingContext): number[] => {
  const pixel = new Uint8Array(4)
  gl.readPixels(
    gl.drawingBufferWidth >> 1,
    gl.drawingBufferHeight >> 1,
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  )
  return [...pixel]
}

/** Leaves every piece of state it can reach wrong, and draws nothing. */
const trash = ({ gl }: { gl: WebGL2RenderingContext }) => {
  gl.useProgram(null)
  gl.disable(gl.DEPTH_TEST)
  gl.depthFunc(gl.NEVER)
  gl.depthMask(false)
  gl.depthRange(0.5, 0.6)
  gl.colorMask(false, false, false, false)
  gl.enable(gl.SCISSOR_TEST)
  gl.scissor(0, 0, 1, 1)
  gl.viewport(0, 0, 1, 1)
  gl.enable(gl.STENCIL_TEST)
  gl.stencilFunc(gl.NEVER, 0, 0)
  gl.disable(gl.CULL_FACE)
  gl.frontFace(gl.CW)
  gl.cullFace(gl.FRONT_AND_BACK)
  gl.enable(gl.BLEND)
  gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT)
  gl.blendFunc(gl.ZERO, gl.ZERO)
  gl.enable(gl.POLYGON_OFFSET_FILL)
  gl.polygonOffset(100, 100)
  gl.enable(gl.RASTERIZER_DISCARD)
  gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE)
  gl.enable(gl.DITHER)
  gl.activeTexture(gl.TEXTURE5)
  gl.bindVertexArray(gl.createVertexArray())
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer())
}

export default (async (gl) => {
  let vertexBuffers = 0
  let arrays = 0
  const createBuffer = gl.createBuffer.bind(gl)
  const created: WebGLBuffer[] = []
  gl.createBuffer = () => {
    vertexBuffers++
    const buffer = createBuffer()
    created.push(buffer)
    return buffer
  }
  const createTexture = gl.createTexture.bind(gl)
  const textures: WebGLTexture[] = []
  gl.createTexture = () => {
    const texture = createTexture()
    textures.push(texture)
    return texture
  }
  const createArray = gl.createVertexArray.bind(gl)
  gl.createVertexArray = () => {
    arrays++
    return createArray()
  }

  const opaqueMesh = meshOf(0, 1)
  const blendedMesh = meshOf(1, 2)
  const frame: Frame = collectFrame(
    sceneOf([modelOf(opaqueMesh, OPAQUE), modelOf(blendedMesh, BLENDED)]),
  )
  const renderer = createRenderer(gl)

  renderer.render(frame)
  const plain = pixels(gl)

  renderer.render(frame, { begin: () => {}, opaque: () => {}, end: () => {} })
  const emptyHooksMatch = same(plain, pixels(gl))

  renderer.render(frame, { begin: trash, opaque: trash })
  const trashingHooksMatch = same(plain, pixels(gl))

  const hookOrder: string[] = []
  renderer.render(frame, {
    begin: () => hookOrder.push('begin'),
    opaque: () => hookOrder.push('opaque'),
    end: () => hookOrder.push('end'),
  })

  const samplers = () =>
    [DIFFUSE_UNIT, ENVIRONMENT_UNIT].map((unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      return gl.getParameter(gl.SAMPLER_BINDING) !== null
    })
  let samplersInHook: boolean[] = []
  renderer.render(frame, {
    end: () => {
      samplersInHook = samplers()
    },
  })
  const samplersAfter = samplers()

  // The host's own full-screen triangle, at clip depth `z`.
  const host = createProgram(
    gl,
    `#version 300 es
uniform float z;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  gl_Position = vec4(corner * 4.0 - 1.0, z, 1.0);
}`,
    `#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(0.0, 0.0, 1.0, 1.0); }`,
    ['z'],
  )
  const fullScreen =
    (z: number): FrameHooks['end'] =>
    ({ gl }) => {
      gl.useProgram(host.handle)
      gl.uniform1f(host.uniforms.z, z)
      gl.disable(gl.CULL_FACE)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

  // At the far plane, behind the opaque square: the depth test leaves it out. Then the blended
  // square goes over the opaque one as ever, so the centre is unchanged.
  renderer.render(frame, { opaque: fullScreen(0.99999) })
  const opaqueHookSeesDepth = centre(gl)

  renderer.render(frame, { end: fullScreen(-0.99999) })
  const endHookDraws = centre(gl)

  // Two models on one mesh: one vertex buffer, and a vertex array for each reference.
  vertexBuffers = 0
  arrays = 0
  const sharing = createRenderer(gl)
  const shared = collectFrame(sceneOf([modelOf(opaqueMesh, OPAQUE), modelOf(opaqueMesh, OPAQUE)]))
  sharing.render(shared)
  // Each reference also has an index buffer, and the program its bone table: one, two, and one.
  const sharedBuffers = { vertexBuffers, arrays }
  sharing.dispose()

  // An edited mesh: moved far aside, so the opaque square leaves the centre.
  const editable = meshOf(0, 1)
  const editing = createRenderer(gl)
  const editFrame = collectFrame(sceneOf([modelOf(editable, OPAQUE)]))
  editing.render(editFrame)
  const before = centre(gl)
  editable.vertices.fill(0)
  editing.invalidate(editable)
  editing.render(editFrame)
  const after = centre(gl)
  editing.render(collectFrame(sceneOf([modelOf(opaqueMesh, OPAQUE)])))
  const untouched = centre(gl)[0] === 255
  editing.dispose()

  // Context loss, and coming back from nothing but the next frame.
  const loser = gl.getExtension('WEBGL_lose_context')!
  const nextEvent = (name: string) =>
    new Promise((done, fail) => {
      gl.canvas.addEventListener(name, done, { once: true })
      setTimeout(() => fail(new Error(`no ${name}`)), 10000)
    })
  const lost = nextEvent('webglcontextlost')
  loser.loseContext()
  await lost
  // Restoring is refused until the lost event's task has finished.
  await new Promise((done) => setTimeout(done))
  const whileLost = renderer.render(frame)
  const restored = nextEvent('webglcontextrestored')
  loser.restoreContext()
  await restored
  const drew = renderer.render(frame)
  const afterRestore = { drew, matches: same(plain, pixels(gl)) }

  // One renderer's disposal leaves another's alone.
  const other = createRenderer(gl)
  const otherFrame = collectFrame(sceneOf([modelOf(meshOf(0, 1), OPAQUE)]))
  other.render(otherFrame)
  const baseline = centre(gl)

  const countLive = () => created.filter((buffer) => gl.isBuffer(buffer)).length
  const buffersBefore = countLive()
  const texture = {
    name: 't',
    type: 'image' as const,
    storage: 'targa' as const,
    format: 'rgba32_8888' as const,
    width: 1,
    height: 1,
    flip: false,
    levels: [new Uint8Array([255, 255, 255, 255])],
  }
  const doomed = createRenderer(gl)
  const doomedFrame = collectFrame(
    sceneOf([
      {
        ...modelOf(meshOf(0, 1), { ...OPAQUE, diffuseTexture: { name: 't', flags: 0x40 } }),
        texture: () => texture,
      },
    ]),
  )
  doomed.render(doomedFrame)
  const liveTextures = () => textures.filter((texture) => gl.isTexture(texture)).length
  const texturesWhileAlive = liveTextures()
  doomed.dispose()
  const liveAfterDispose = {
    buffers: countLive() - buffersBefore,
    textures: texturesWhileAlive - liveTextures(),
  }

  let disposedThrows = false
  try {
    doomed.render(doomedFrame)
  } catch {
    disposedThrows = true
  }

  other.render(otherFrame)
  const otherRendererStillDraws = centre(gl).every((value, at) => value === baseline[at])

  return {
    error: gl.getError(),
    emptyHooksMatch,
    trashingHooksMatch,
    hookOrder,
    samplersInHook,
    samplersAfter,
    opaqueHookSeesDepth,
    endHookDraws,
    sharedBuffers,
    afterInvalidate: { before, after, untouched },
    whileLost,
    afterRestore,
    liveAfterDispose,
    disposedThrows,
    otherRendererStillDraws,
  }
}) satisfies Fixture<RenderReport>
