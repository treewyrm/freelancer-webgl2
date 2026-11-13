/**
 * `npm run bench`: what a retail system's effects cost a frame, on the hardware GPU. Not a test, as
 * timings can't be pinned; it decides whether transform feedback comes back (ARCHITECTURE.md, Skinning and effects).
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launch, runFixture } from '#/harness.js'
import type { BenchArgs, BenchReport } from './bench.fixture.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')

const read = async (path: string) => {
  const file = readFileSync(join(data, path.replace(/\\/g, '/')))

  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}

const LI01 = {
  path: 'UNIVERSE/SYSTEMS/LI01/li01.ini',
  anchor: { object: 'Dock_Ring_Li01_01', distance: 2500 },
}
// In `attractdust` capped at 200, the dust the corpus weighs most, and near retail's highest cap
// (250): a zone's `spacedust_maxparticles` holds what the corpus run, uncapped, put at a thousand.
const KU02 = {
  path: 'UNIVERSE/SYSTEMS/KU02/ku02.ini',
  anchor: { zone: 'ZONE_Ku02_Shiun_exclusion_2' },
}

/** Effects heavier than an engine's: battleship explosions, Nomad engines, a wormhole, a lane. */
const COMPLEX = [
  'gf_explosion_li_battleship_mainexpbig',
  'gf_explosion_li_battleship_mainexpsmall',
  'gf_explosion_li_battleship_damagefire',
  'gf_explosion_ku_battleship_flashbang',
  'gf_no_largeengine02',
  'gf_nomadwormhole',
  'gf_neutronstar',
  'basic_tl_player_travel',
]

const SCENES: (Omit<BenchArgs, 'frames' | 'warmup' | 'speed'> & { name: string })[] = [
  { name: 'li01', ...LI01, ships: 12, extras: [] },
  { name: 'li01 + complex', ...LI01, ships: 12, extras: COMPLEX },
  { name: 'ku02 dust', ...KU02, ships: 12, extras: [] },
  { name: 'ku02 dust + complex', ...KU02, ships: 12, extras: COMPLEX },
]

const frames = Number(process.env['BENCH_FRAMES'] ?? 600)
// Chrome's CPU throttling, for a machine slower than the one at hand. 1 when absent.
const cpuThrottling = Number(process.env['BENCH_THROTTLE'] ?? 1)
const browser = await launch()
const reports: (BenchReport & { name: string; renderer: string })[] = []

try {
  for (const { name, ...scene } of SCENES) {
    const { value, renderer } = await runFixture<BenchReport>(
      browser,
      new URL('./bench.fixture.ts', import.meta.url),
      // 80 a second, a fighter at full throttle short of cruise.
      {
        width: 1024,
        height: 768,
        args: { ...scene, frames, warmup: 60, speed: 80 },
        read,
        cpuThrottling,
      },
    )

    reports.push({ name, renderer, ...value })
    for (const line of value.skipped) console.log(`${name}: left out ${line}`)
  }
} finally {
  await browser.close()
}

const ms = (value: number) => value.toFixed(2)

console.log(
  `\n${reports[0]?.renderer}, CPU ${cpuThrottling}x slower, ${frames} frames at 60 Hz;` +
    ' milliseconds, mean (p95)\n',
)
console.table(
  reports.map(
    ({ name, tick, collect, render, finish, particles, steppedBytes, effects, draws }) => ({
      scene: name,
      effects,
      draws,
      stepped: Math.round(particles.stepped),
      ballistic: Math.round(particles.ballistic),
      spawned: Math.round(particles.spawned),
      'stepped KB': ms(steppedBytes / 1024),
      tick: `${ms(tick.mean)} (${ms(tick.p95)})`,
      collect: `${ms(collect.mean)} (${ms(collect.p95)})`,
      render: `${ms(render.mean)} (${ms(render.p95)})`,
      finish: `${ms(finish.mean)} (${ms(finish.p95)})`,
    }),
  ),
)
await mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true })
await writeFile(
  new URL('../../artifacts/bench.json', import.meta.url),
  JSON.stringify(reports, null, 2),
)
