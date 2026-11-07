/** A reference system's frame against retail's screenshot, outside its HUD and what isn't built. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
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

/** The engine's flame, and `space_order`'s platform smoke: random particles, not held pixel for pixel. */
const FLAME: Box = [470, 615, 560, 768]

interface Run {
  name: keyof typeof RUNS
  draws: number
  effects: number
  /**
   * Where particles are, whose positions are random: drawn, and nearest at 96 steps a second (in
   * `space_order`, the flame's mean 7.9 and the smoke's 6.3), but not to be held pixel for pixel.
   */
  particles: Box[]
}

const RUNS_COMPARED: Run[] = [
  { name: 'space_order', draws: 123, effects: 7, particles: [FLAME, [195, 228, 235, 275]] },
  { name: 'ring_outside', draws: 70, effects: 4, particles: [FLAME] },
  { name: 'nebula_sheets', draws: 71, effects: 4, particles: [FLAME] },
  { name: 'nebula_sheets_edge', draws: 37, effects: 4, particles: [FLAME] },
  { name: 'nebula_sheets_axis', draws: 71, effects: 4, particles: [FLAME] },
]

const screenshot = (folder: string): Buffer | undefined => {
  if (!existsSync(folder)) return undefined
  const file = readdirSync(folder).find((entry) => entry.endsWith('.bmp'))
  return file ? readFileSync(join(folder, file)) : undefined
}

const skipOf = (folder: string) =>
  !existsSync(data) ? 'no retail DATA' : !screenshot(folder) ? `no screenshot in ${folder}` : false

let browser: Browser | undefined

after(() => browser?.close())

const read = async (path: string) => {
  const file = readFileSync(join(data, path))
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

const inside = (x: number, y: number, [left, top, right, bottom]: Box) =>
  x >= left && x < right && y >= top && y < bottom

for (const { name, draws, effects, particles } of RUNS_COMPARED) {
  const folder = join(references, name)
  test(
    `${name} matches retail's screenshot, outside its HUD and its random particles`,
    { skip: skipOf(folder) },
    async () => {
      browser ??= await launch()
      const system = systems.get(name)!
      const { options } = readSpaceRun(folder, system, RUNS[name])
      const { value, png } = await runFixture<SpaceReport>(
        browser,
        new URL('./space.fixture.ts', import.meta.url),
        {
          width: WIDTH,
          height: HEIGHT,
          context: { antialias: false, alpha: false },
          args: { system: name, options },
          read,
        },
      )
      await saveArtifact(`space-${name}`, png)

      assert.equal(value.error, 0)
      assert.deepEqual(value.unsupported, ['texture envmapglass'])
      assert.equal(value.draws, draws)
      assert.equal(value.effects, effects)

      const shot = screenshot(folder)!
      const stride = (WIDTH * 3 + 3) & ~3
      const ours = Buffer.from(value.pixels, 'base64')
      let compared = 0
      let close = 0
      let difference = 0
      let oursOnly = 0
      let theirsOnly = 0
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 0; x < WIDTH; x++) {
          if ([...HUD, ...particles].some((box) => inside(x, y, box))) continue
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
      console.log(`${name}: ${message}`)
      // As the menu scenes: `space_order` measured 99.96% within 2 and a mean of 0.32.
      assert.ok(close / compared >= 0.995, message)
      assert.ok(mean <= 0.5, message)
      assert.ok(Math.max(oursOnly, theirsOnly) / compared <= 0.002, message)
    },
  )
}
