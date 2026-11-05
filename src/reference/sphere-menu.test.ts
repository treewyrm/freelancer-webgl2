/** The stock menu's two planets against what retail drew: level, indices, vertices, faces, order. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getResourceId } from '@treewyrm/freelancer'
import { getMaterial, readMaterialLibrary } from '@treewyrm/freelancer/material'
import { Matrix3, Matrix4 } from '@treewyrm/freelancer/math'
import { readSphere, type Sphere } from '@treewyrm/freelancer/rigid'
import { readTextureLibrary } from '@treewyrm/freelancer/texture'
import { Directory } from '@treewyrm/freelancer/utf'
import { readCapture, type CaptureDraw } from '#/capture/capture.js'
import { indexTextures } from '#/capture/texture-names.js'
import { spherePatch } from '#/mesh/sphere.js'
import type { Camera } from '#/scene/camera.js'
import { collectFrame, type SceneModel } from '#/scene/frame.js'
import { placeSphere } from '#/scene/sphere.js'
import { assertFrameMatches } from './compare.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const run = join(references, 'run1-stock-menu/d3d8log.jsonl')
const skip = existsSync(run) ? false : 'no run1-stock-menu capture in references'

// Retail's world is the modelview with Z flipped, written as rows for row vectors.
const modelViewOf = ({ world }: CaptureDraw): Matrix4 => {
  const w = world!
  const column = (at: number, last: number) => ({
    x: w[at]!,
    y: w[at + 1]!,
    z: -w[at + 2]!,
    w: last,
  })
  return { x: column(0, 0), y: column(4, 0), z: column(8, 0), w: column(12, 1) }
}

// The capture's view is the identity: the camera's at the origin, looking down -Z. 20° from its
// projection, 2.74748 = 1 / tan 20°, and the width from its device.
const CAMERA: Camera = {
  position: { x: 0, y: 0, z: 0 },
  orientation: Matrix3.identity,
  fovh: 20,
  near: 70,
  far: 15000,
}

// `planet_rckdes_1000.sph` and `planet_mercury_200.sph`, whose level and bound textures these are.
const SIDES = ['side1', 'side2', 'side1', 'side2', 'cap', 'cap']
const PLANETS = [
  { radius: 1000, primitives: 512, level: 8 },
  { radius: 200, primitives: 64, level: 5 },
]

// Scale 1 tells the surface from the larger atmosphere, drawn with the same patch.
const surfaceOf = (draws: CaptureDraw[], primitives: number) =>
  draws.filter(
    (draw) =>
      draw.fvf === 0x112 &&
      draw.primitives === primitives &&
      Math.abs(Math.hypot(...draw.world!.slice(0, 3)) - 1) < 0.001,
  )

// Two-pass classes draw a face twice, one after the other.
const facesOf = (draws: CaptureDraw[]) =>
  draws.filter((draw, n) => n === 0 || draw.world!.join() !== draws[n - 1]!.world!.join())

/** The sphere's own matrix, undoing the face that's last and, being -Y, always in view here. */
const baseOf = (face: Matrix4): Matrix4 =>
  Matrix4.multiply(face, {
    x: { x: 1, y: 0, z: 0, w: 0 },
    y: { x: 0, y: 0, z: -1, w: 0 },
    z: { x: 0, y: 1, z: 0, w: 0 },
    w: { x: 0, y: 0, z: 0, w: 1 },
  })

const frames = () => readCapture(readFileSync(run, 'utf8')).frames

test(
  'at each planet retail draws the level the formula gives, and the faces it culls',
  { skip },
  () => {
    for (const { draws } of frames())
      for (const { radius, primitives, level } of PLANETS) {
        const retail = facesOf(surfaceOf(draws, primitives))
        const sphere: Sphere = { type: 'sphere', hardpoints: [], sides: SIDES, radius }
        const parts = placeSphere(sphere, baseOf(modelViewOf(retail.at(-1)!)), {
          camera: CAMERA,
          width: draws[0]!.viewport[2]!,
        })
        assert.equal(parts.length, retail.length)
        assert.equal(parts[0]!.mesh, spherePatch(radius, level).mesh)

        parts.forEach(({ world }, face) => {
          const theirs = modelViewOf(retail[face]!)
          for (const axis of ['x', 'y', 'z', 'w'] as const)
            for (const cell of ['x', 'y', 'z'] as const)
              assert.ok(
                Math.abs(world[axis][cell] - theirs[axis][cell]) < 0.01,
                `face ${face}, ${axis}.${cell}: ${world[axis][cell]} against ${theirs[axis][cell]}`,
              )
        })
      }
  },
)

test('the faces carry M0..M5, by which textures retail bound', { skip }, () => {
  const draws = frames().at(-1)!.draws
  const planet = (primitives: number, radius: number, sides: string[]) => {
    const retail = facesOf(surfaceOf(draws, primitives))
    const parts = placeSphere(
      { type: 'sphere', hardpoints: [], sides, radius },
      baseOf(modelViewOf(retail.at(-1)!)),
      { camera: CAMERA, width: draws[0]!.viewport[2]! },
    )
    return parts.map(({ materialId }, face) => ({
      material: sides.findIndex((side) => getResourceId(side) === materialId),
      texture: retail[face]!.stages[0]!.texture!.pointer,
    }))
  }
  for (const faces of [planet(512, 1000, SIDES), planet(64, 200, SIDES)]) {
    const textureOf = new Map<number, number>()
    for (const { material, texture } of faces) {
      if (textureOf.has(material)) assert.equal(texture, textureOf.get(material))
      textureOf.set(material, texture)
    }
    // `side1`, `side2` and `cap` are three textures, so nothing's right by every face being alike.
    assert.equal(new Set(textureOf.values()).size, new Set(textureOf.keys()).size)
  }
})

test('the patches are the ones retail drew, index for index', { skip }, () => {
  const draws = frames().at(-1)!.draws
  for (const { radius, primitives, level } of PLANETS) {
    const [draw] = surfaceOf(draws, primitives)
    const { mesh, reference } = spherePatch(radius, level)
    assert.equal(draw!.vertices, reference.vertexCount)
    assert.equal(draw!.indices, mesh.indices.length)
    // The log stops at 1024.
    assert.deepEqual(draw!.indexData, [...mesh.indices.slice(0, 1024)])
  }
})

test('level 5 is the patch retail drew, vertex for vertex', { skip }, () => {
  const [draw] = surfaceOf(frames().at(-1)!.draws, 64)
  const { vertices } = spherePatch(200, 5).mesh
  const ours = new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4)
  assert.equal(draw!.vertexData!.length, 41)
  draw!.vertexData!.forEach(({ p, t0 }, at) => {
    for (const [c, value] of p.entries())
      assert.ok(Math.abs(ours[at * 8 + c]! - value) < 2e-4, `vertex ${at}: ${p}`)
    assert.ok(Math.abs(ours[at * 8 + 6]! - t0![0]!) < 1e-6)
    assert.ok(Math.abs(ours[at * 8 + 7]! - t0![1]!) < 1e-6)
  })
})

const readDirectory = (path: string) => Directory.read(readFileSync(join(data, path)))

// As retail's menu loads them: the planet's own file and materials, and what those name.
const REAL_PLANETS = [
  {
    file: 'SOLAR/PLANETS/PLANET_RCKDES/planet_rckdes_1000.sph',
    primitives: 512,
    libraries: [
      'SOLAR/PLANETS/PLANET_RCKDES/planet_rckdes.mat',
      'SOLAR/PLANETS/planet_rckdes.txm',
      'SOLAR/PLANETS/atmosphere.txm',
    ],
  },
  {
    file: 'SOLAR/PLANETS/PLANET_MERCURY/planet_mercury_200.sph',
    primitives: 64,
    libraries: [
      'SOLAR/PLANETS/PLANET_MERCURY/planet_mercury.mat',
      'SOLAR/PLANETS/mercury.txm',
      'SOLAR/PLANETS/atmosphere.txm',
    ],
  },
]

const menuFrame = () => {
  const { draws } = frames().at(-1)!
  const models = REAL_PLANETS.map(({ file, primitives, libraries }): SceneModel => {
    const directories = libraries.map(readDirectory)
    const materials = directories.flatMap((library) => [...readMaterialLibrary(library)])
    const textures = directories.flatMap((library) => [...readTextureLibrary(library)])
    const material = (id: number) => getMaterial(materials, id)
    const retail = facesOf(surfaceOf(draws, primitives))
    return {
      parts: placeSphere(readSphere(readDirectory(file)), baseOf(modelViewOf(retail.at(-1)!)), {
        camera: CAMERA,
        width: draws[0]!.viewport[2]!,
        material,
      }),
      mesh: () => undefined,
      material,
      // A stand-in where a mask lives in a library only the menu has loaded: the state's the point.
      texture: (name) =>
        textures.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? {
          ...textures[0]!,
          name,
        },
    }
  })
  return {
    frame: collectFrame({
      camera: CAMERA,
      aspect: 4 / 3,
      ambient: { x: 0, y: 0, z: 0 },
      lights: [],
      models,
    }),
    retail: draws.filter(({ fvf }) => fvf === 0x112),
  }
}

const skipData = skip || (existsSync(data) ? false : 'no retail DATA')

test("the menu's planets are retail draw for draw, shell included", { skip: skipData }, () => {
  const { frame, retail } = menuFrame()
  assert.deepEqual(frame.unsupported, [])
  assert.equal(frame.draws.length, retail.length)
  assertFrameMatches(frame, retail, indexTextures(data), { streamed: true })
  frame.draws.forEach(({ world, materialName }, n) => {
    const modelView = Matrix4.multiply(frame.view, world)
    const theirs = modelViewOf(retail[n]!)
    for (const axis of ['x', 'y', 'z', 'w'] as const)
      for (const cell of ['x', 'y', 'z'] as const)
        assert.ok(
          Math.abs(modelView[axis][cell] - theirs[axis][cell]) < 0.01,
          `draw ${n}, ${materialName}, ${axis}.${cell}`,
        )
  })
})

test('the shell has the UVs retail wrote, vertex for vertex', { skip: skipData }, () => {
  const { frame, retail } = menuFrame()
  const { vertices } = spherePatch(200, 5).mesh
  const patch = new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4)
  let checked = 0
  frame.draws.forEach(({ atmosphere }, n) => {
    const written = retail[n]!.vertexData
    if (!atmosphere || !written) return
    written.forEach(({ t0 }, at) => {
      const [nx, ny, nz] = patch.slice(at * 8 + 3, at * 8 + 6) as unknown as number[]
      const { x, y, z } = atmosphere.direction
      const facing = x * nx! + y * ny! + z * nz!
      const { threshold: t, gain, v } = atmosphere
      const u = facing < t ? 0 : ((facing - t) / (1 - t)) * gain
      assert.ok(Math.abs(u - t0![0]!) < 2e-5, `draw ${n}, vertex ${at}: ${u} against ${t0![0]}`)
      assert.ok(Math.abs(v - t0![1]!) < 1e-5, `draw ${n}, vertex ${at}: ${v} against ${t0![1]}`)
      checked++
    })
  })
  assert.equal(checked, 5 * 41)
})
