/** A sphere of bands, each its own material: what the game does with a type retail barely uses. */
import { getResourceId } from '@treewyrm/freelancer'
import { writeMaterialLibrary, type Material } from '@treewyrm/freelancer/material'
import {
  writeMaterialAnimLibrary,
  writeRigidModel,
  type MaterialAnim,
  type RigidModel,
} from '@treewyrm/freelancer/rigid'
import { Directory } from '@treewyrm/freelancer/utf'
import {
  Primitive,
  writeVMeshLibrary,
  type VMeshData,
  type VMeshRef,
  type VertexFormat,
} from '@treewyrm/freelancer/vmesh'

const SECTORS = 24
const RADIUS = 10
const MESH = 'bands.vms'

/** What a generated sphere is made of. */
export interface Generated {
  materials: readonly Material[]
  animations?: readonly MaterialAnim[]
  /** Leaves `envmap_material` off the archetype, which a sphere of override types was tested with. */
  noEnvironment?: true
  /** How many UV sets its mesh has. Two when absent. */
  uvSets?: 1 | 2
}

// Position and normal, then the UV sets.
const formatOf = (uvSets: number) => (uvSets === 1 ? 0x112 : 0x212) as VertexFormat
const strideOf = (uvSets: number) => 24 + uvSets * 8

/** One latitude band per material, top to bottom, each with its own vertices. */
const bandsMesh = ({
  materials,
  uvSets = 2,
}: Generated): { mesh: VMeshData; reference: VMeshRef } => {
  const STRIDE = strideOf(uvSets)
  const perBand = (SECTORS + 1) * 2
  const count = perBand * materials.length
  const bytes = new DataView(new ArrayBuffer(count * STRIDE))
  const indices = new Uint16Array(SECTORS * 6 * materials.length)
  let index = 0

  materials.forEach((_, band) => {
    const base = band * perBand
    const latitude = (at: number) => (Math.PI * at) / materials.length
    ;[band, band + 1].forEach((row, side) => {
      for (let s = 0; s <= SECTORS; s++) {
        const [theta, phi] = [latitude(row), (2 * Math.PI * s) / SECTORS]
        const normal = [
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        ]
        const at = (base + side * (SECTORS + 1) + s) * STRIDE
        const u = s / 6
        const v = row / 2
        ;[
          ...normal.map((c) => c * RADIUS),
          ...normal,
          u,
          v,
          ...(uvSets === 2 ? [u * 3, v * 3] : []),
        ].forEach((value, c) => bytes.setFloat32(at + c * 4, value, true))
      }
    })
    for (let s = 0; s < SECTORS; s++) {
      const [a, b, c, d] = [s, s + 1, s + SECTORS + 1, s + SECTORS + 2]
      // Counter-clockwise from outside, in the file's own winding.
      indices.set([a, c, b, b, c, d], index)
      index += 6
    }
  })

  const mesh: VMeshData = {
    name: MESH,
    version: 1,
    primitive: Primitive.TriangleList,
    format: formatOf(uvSets),
    groups: materials.map((material, band) => ({
      materialId: getResourceId(material.name),
      vertexStart: band * perBand,
      vertexEnd: band * perBand + perBand - 1,
      elementCount: SECTORS * 6,
      padding: 0,
    })),
    indices,
    vertices: new Uint8Array(bytes.buffer),
  }
  const reference: VMeshRef = {
    meshId: getResourceId(MESH),
    vertexStart: 0,
    vertexCount: count,
    indexStart: 0,
    indexCount: indices.length,
    groupStart: 0,
    groupCount: materials.length,
    boundingBox: {
      min: { x: -RADIUS, y: -RADIUS, z: -RADIUS },
      max: { x: RADIUS, y: RADIUS, z: RADIUS },
    },
    boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: RADIUS },
  }
  return { mesh, reference }
}

export interface GeneratedFiles {
  /** A `.3db`, holding its mesh. */
  model: Uint8Array
  /** A `.mat`, listed after the libraries whose textures it names: a material resolves on load. */
  library: Uint8Array
}

export const bandsModel = (generated: Generated): RigidModel => ({
  type: 'rigid',
  hardpoints: [],
  part: { type: 'vmeshpart', reference: bandsMesh(generated).reference },
})

export const bandsMeshData = (generated: Generated): VMeshData => bandsMesh(generated).mesh

export const generateBands = (generated: Generated): GeneratedFiles => {
  const { materials, animations = [] } = generated
  const model = writeRigidModel(bandsModel(generated))
  model.children.push(writeVMeshLibrary([bandsMeshData(generated)]))
  const library = new Directory('\\\\', [
    writeMaterialLibrary(materials),
    ...(animations.length ? [writeMaterialAnimLibrary(animations)] : []),
  ])
  return { model: model.write(), library: library.write() }
}
