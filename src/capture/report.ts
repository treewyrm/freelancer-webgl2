/**
 * Prints a capture for reading: every draw in a frame, or one draw in full.
 *
 *   npm run capture -- references/li_elite
 *   npm run capture -- references/li_elite --draw 12
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCapture, type CaptureDraw, type CaptureStage } from './capture.js'
import { indexTextures, namesOf, type TextureIndex } from './texture-names.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')

// D3DTOP_DISABLE, which ends the fixed-function cascade.
const DISABLE = 1

const textureName = (index: TextureIndex | undefined, stage: CaptureStage): string => {
  const { texture } = stage
  if (!texture) return '-'
  const names = index ? namesOf(index, texture) : []
  const size = `${texture.width}x${texture.height}/${texture.format}`
  if (!names.length) return `? ${size}`
  const first = names[0]!
  return `${first.name} (${first.source}${names.length > 1 ? ` +${names.length - 1}` : ''})`
}

const summary = (draw: CaptureDraw, index: TextureIndex | undefined): string => {
  const { ALPHABLENDENABLE, SRCBLEND, DESTBLEND, LIGHTING, ZWRITEENABLE } = draw.states
  const textures = draw.stages
    .filter(({ states }) => states['COLOROP'] !== DISABLE)
    .map((stage) => textureName(index, stage))
    .join(', ')
  return [
    `${draw.n}`.padStart(4),
    `${draw.primitives}`.padStart(5),
    draw.fvf.toString(16).padStart(4),
    ALPHABLENDENABLE ? `blend ${SRCBLEND}/${DESTBLEND}` : 'opaque  ',
    `${LIGHTING ? 'lit' : '   '} ${draw.lights.length}`,
    ZWRITEENABLE ? 'z' : ' ',
    textures,
  ].join('  ')
}

const [directory, flag, argument] = process.argv.slice(2)
if (!directory) throw new Error('usage: capture <directory> [--draw n]')

const index = existsSync(data) ? indexTextures(data) : undefined
const { device, frames } = readCapture(readFileSync(join(directory, 'd3d8log.jsonl'), 'utf8'))
const frame = frames.at(-1)
if (!frame) throw new Error('no frames')

console.log(device)
console.log(`frames ${frames.map((entry) => entry.index).join(', ')}; showing ${frame.index}`)

if (flag === '--draw') {
  const draw = frame.draws[Number(argument)]
  if (!draw) throw new Error(`no draw ${argument}`)
  const stages = draw.stages.map((stage) => ({
    ...stage,
    texture: textureName(index, stage),
  }))
  console.dir({ ...draw, stages }, { depth: 6, maxArrayLength: 32 })
} else {
  console.log('   n  prims   fvf  blend     lights  z  textures')
  for (const event of frame.events)
    console.log(event.kind === 'draw' ? summary(event, index) : JSON.stringify(event))
}
