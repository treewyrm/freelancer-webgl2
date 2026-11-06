/** A reference system's frame against retail's screenshot, outside its HUD and what isn't built. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Browser } from 'playwright'
import { launch, runFixture, saveArtifact } from '#/harness.js'
import { readSpaceRun, RUNS } from './space-capture.js'
import type { SpaceReport } from './space.fixture.js'
import { systems } from './systems.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'

const WIDTH = 1024
const HEIGHT = 768

type Box = readonly [left: number, top: number, right: number, bottom: number]

/** The HUD, after the scene's depth clear: its gauges, its panels and the chat log's icon F9 left. */
const HUD: Box[] = [
  [328, 0, 698, 122],
  [803, 0, 1024, 48],
  [0, 0, 20, 20],
  [644, 198, 694, 246],
  [0, 528, 274, 768],
  [748, 528, 1024, 768],
  [346, 724, 689, 768],
]

/**
 * The engine's flame and the platform's smoke, whose particles are random: drawn, and nearest at 96
 * steps a second (the flame's mean 7.9 and the smoke's 6.3 here), but not to be held pixel for pixel.
 */
const PARTICLES: Box[] = [
  [470, 615, 560, 768],
  [195, 228, 235, 275],
]

const folder = join(references, 'space_order')
const screenshot = (): Buffer | undefined => {
  if (!existsSync(folder)) return undefined
  const file = readdirSync(folder).find((entry) => entry.endsWith('.bmp'))
  return file ? readFileSync(join(folder, file)) : undefined
}

const skip = !existsSync(data)
  ? 'no retail DATA'
  : !screenshot()
    ? 'no space_order screenshot'
    : false

let browser: Browser

before(async () => {
  if (!skip) browser = await launch()
})

after(() => browser?.close())

const read = async (path: string) => {
  const file = readFileSync(join(data, path))
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

const inside = (x: number, y: number, [left, top, right, bottom]: Box) =>
  x >= left && x < right && y >= top && y < bottom

test(
  "space_order matches retail's screenshot, outside its HUD and its random particles",
  { skip },
  async () => {
    const system = systems.get('space_order')!
    const { options } = readSpaceRun(folder, system, RUNS.space_order)
    const { value, png } = await runFixture<SpaceReport>(
      browser,
      new URL('./space.fixture.ts', import.meta.url),
      {
        width: WIDTH,
        height: HEIGHT,
        context: { antialias: false, alpha: false },
        args: { system: 'space_order', options },
        read,
      },
    )
    await saveArtifact('space-space_order', png)

    assert.equal(value.error, 0)
    assert.deepEqual(value.unsupported, ['texture envmapglass'])
    assert.equal(value.draws, 123)
    assert.equal(value.effects, 7)

    const shot = screenshot()!
    const stride = (WIDTH * 3 + 3) & ~3
    const ours = Buffer.from(value.pixels, 'base64')
    let compared = 0
    let close = 0
    let difference = 0
    let oursOnly = 0
    let theirsOnly = 0
    for (let y = 0; y < HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) {
        if ([...HUD, ...PARTICLES].some((box) => inside(x, y, box))) continue
        const from = 54 + (HEIGHT - 1 - y) * stride + x * 3
        const at = (y * WIDTH + x) * 4
        const theirs = [shot[from + 2]!, shot[from + 1]!, shot[from]!]
        const mine = [ours[at]!, ours[at + 1]!, ours[at + 2]!]
        const [hasMine, hasTheirs] = [mine, theirs].map((c) => c[0]! + c[1]! + c[2]! > 0)
        if (hasMine && !hasTheirs) oursOnly++
        if (hasTheirs && !hasMine) theirsOnly++
        const worst = Math.max(...mine.map((channel, c) => Math.abs(channel - theirs[c]!)))
        compared++
        difference += worst
        if (worst <= 2) close++
      }

    const mean = difference / compared
    const message = `${close} of ${compared} within 2, mean ${mean.toFixed(3)}, silhouette ${oursOnly}/${theirsOnly}`
    console.log(message)
    // As the menu scenes: measured 99.96% within 2 and a mean of 0.32, the sky filling the frame.
    assert.ok(close / compared >= 0.995, message)
    assert.ok(mean <= 0.5, message)
    assert.ok(Math.max(oursOnly, theirsOnly) / compared <= 0.002, message)
  },
)
