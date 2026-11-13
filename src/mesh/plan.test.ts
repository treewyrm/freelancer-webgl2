import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Directory, isUTF } from '@treewyrm/freelancer/utf'
import {
  getMesh,
  Primitive,
  readVMeshLibrary,
  readVMeshRef,
  type VertexFormat,
  type VMeshData,
  type VMeshRef,
} from '@treewyrm/freelancer/vmesh'
import { drawMode, planReference, vertexLayout } from './plan.js'

const mesh = (fields: Partial<VMeshData>): VMeshData => ({
  name: 'test',
  version: 1,
  primitive: Primitive.TriangleList,
  format: 0x112 as VertexFormat,
  groups: [],
  indices: new Uint16Array(),
  vertices: new Uint8Array(),
  ...fields,
})

const reference = (fields: Partial<VMeshRef>): VMeshRef => ({
  meshId: 0,
  vertexStart: 0,
  vertexCount: 0,
  indexStart: 0,
  indexCount: 0,
  groupStart: 0,
  groupCount: 0,
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 0 },
  ...fields,
})

test('layouts walk the FVF, for the eight formats retail uses', () => {
  const offsets = (format: number) =>
    vertexLayout(format as VertexFormat).attributes.map(({ name, offset }) => [name, offset])

  assert.deepEqual(offsets(0x112), [
    ['position', 0],
    ['normal', 12],
    ['uv0', 24],
  ])
  assert.deepEqual(offsets(0x252), [
    ['position', 0],
    ['normal', 12],
    ['diffuse', 24],
    ['uv0', 28],
    ['uv1', 36],
  ])

  const strides = [0x112, 0x212, 0x102, 0x142, 0x012, 0x152, 0x252, 0x002]

  assert.deepEqual(
    strides.map((format) => vertexLayout(format as VertexFormat).stride),
    [32, 40, 20, 24, 24, 36, 44, 12],
  )
})

test('a stride skips what no material reads', () => {
  // Position, normal, point size, specular, one UV set.
  const { stride, attributes } = vertexLayout(0x1b2 as VertexFormat)

  assert.equal(stride, 40)
  assert.equal(attributes.at(-1)!.offset, 32)
})

test('both offsets go into the indices, for this reference alone', () => {
  const data = mesh({
    groups: [
      { materialId: 1, vertexStart: 0, vertexEnd: 2, elementCount: 3, padding: 0 },
      { materialId: 2, vertexStart: 3, vertexEnd: 5, elementCount: 3, padding: 0 },
      { materialId: 3, vertexStart: 0, vertexEnd: 2, elementCount: 3, padding: 0 },
    ],
    indices: new Uint16Array([0, 1, 2, 0, 2, 1, 2, 1, 0]),
  })

  const first = planReference(data, reference({ groupCount: 2 }))

  assert.deepEqual([...first.indices], [0, 1, 2, 3, 5, 4])
  assert.deepEqual(first.groups, [
    { materialId: 1, byteOffset: 0, count: 3 },
    { materialId: 2, byteOffset: 6, count: 3 },
  ])

  const second = planReference(
    data,
    reference({ groupStart: 2, groupCount: 1, indexStart: 6, vertexStart: 6 }),
  )

  assert.deepEqual([...second.indices], [8, 7, 6])
  assert.deepEqual(second.groups, [{ materialId: 3, byteOffset: 0, count: 3 }])
})

test('modes follow the primitive, and a mesh without one is refused', () => {
  assert.equal(drawMode(Primitive.TriangleList), 4)
  assert.equal(drawMode(Primitive.LineStrip), 3)
  assert.throws(() => drawMode(Primitive.None), RangeError)
})

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? filesUnder(path) : [path]
  })

const referencesIn = (directory: Directory): VMeshRef[] => [
  ...(directory.getFile('VMeshRef') ? [readVMeshRef(directory)] : []),
  ...directory.directories.flatMap(referencesIn),
]

test(
  'every retail reference plans indices its mesh can draw',
  { skip: existsSync(data) ? false : 'no retail DATA' },
  () => {
    const files = filesUnder(data).flatMap((path) => {
      const file = readFileSync(path)
      const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
      if (bytes.byteLength < 4 || !isUTF(bytes)) return []

      const root = Directory.read(bytes)

      return [{ root, meshes: [...readVMeshLibrary(root)] }]
    })

    const everywhere = files.flatMap(({ meshes }) => meshes)

    let planned = 0

    for (const { root, meshes } of files)
      for (const ref of referencesIn(root)) {
        // Mesh names repeat between files, with different contents: a file's own come first.
        const found = getMesh(meshes, ref.meshId) ?? getMesh(everywhere, ref.meshId)

        assert.ok(found, `no mesh ${ref.meshId}`)

        const vertices = found.vertices.length / vertexLayout(found.format).stride
        const top = planReference(found, ref).indices.reduce(
          (max, index) => Math.max(max, index),
          0,
        )

        assert.ok(top < vertices, `${found.name}: index ${top} past ${vertices} vertices`)
        planned++
      }

    assert.equal(planned, 9322)
  },
)
