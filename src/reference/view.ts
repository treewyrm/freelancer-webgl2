/**
 * `npm run view -- <system ini> <eye x,y,z> <target x,y,z>`: a retail system's frame from `eye`
 * towards `target`, written to `artifacts/view.png`. For looking, not comparing. With `VIEW_ORTHO` set to
 * a half-width, straight down from `eye` through a parallel projection: `collectPlanFrame`'s; with
 * `VIEW_NAVMAP` as well, the navmap's layer on it (`withNavmap`).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launch, runFixture, saveArtifact } from '#/harness.js'
import type { ViewArgs, ViewReport } from './view.fixture.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')

const read = async (path: string) => {
  const file = readFileSync(join(data, path.replace(/\\/g, '/')))

  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

const triple = (text: string | undefined) => {
  const values = (text ?? '').split(',').map(Number)
  if (values.length !== 3 || values.some(Number.isNaN)) throw new Error(`Not x,y,z: ${text}`)
  return values as [number, number, number]
}

const [path, eye, target, name = 'view'] = process.argv.slice(2)
if (!path) throw new Error('Usage: npm run view -- <system ini> <eye x,y,z> <target x,y,z> [name]')

const args: ViewArgs = {
  path,
  eye: triple(eye),
  target: triple(target),
  // Retail's at 4:3, as the reference scenes' captures have it.
  fovh: 35,
  seconds: 2,
  sunEffect: 1,
  // `VIEW_ORTHO=<half-width>`: straight down from `eye`, a plan frame's parallel view; `target` unread.
  ...(process.env['VIEW_ORTHO'] && { ortho: Number(process.env['VIEW_ORTHO']) }),
  // `VIEW_NAVMAP=1`, with `VIEW_ORTHO`: the navmap's layer on it, at the zoom the half-width shows.
  ...(process.env['VIEW_NAVMAP'] && { navmap: true }),
}
const browser = await launch()

try {
  const { value, png } = await runFixture<ViewReport>(
    browser,
    new URL('./view.fixture.ts', import.meta.url),
    { width: 1024, height: 768, context: { antialias: false, alpha: false }, args, read },
  )

  await saveArtifact(name, png)
  console.log(JSON.stringify(value, null, 2), `\nartifacts/${name}.png`)
} finally {
  await browser.close()
}
