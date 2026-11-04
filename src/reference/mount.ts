/**
 * Puts a reference scene on the game's main menu, takes it off, and collects what a run produced.
 *
 *   npm run reference -- mount li_elite
 *   npm run reference -- collect li_elite
 *   npm run reference -- restore
 *
 * The menu is three bases, each one room naming a `.thn`, and which one plays is not ours to choose,
 * so all three point at the scene. See `freelancer-vscode/docs/renderer/ALCHEMY-LAB.md`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { readCapture } from '#/capture/capture.js'
import { sceneScript } from './scene.js'
import { scenes } from './scenes.js'

const GUEST = '/Volumes/[C] Windows 11'

const game = process.env['FREELANCER_GAME'] ?? join(GUEST, 'Games/Freelancer/DATA')
const corpus = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const options = join(GUEST, 'Users/treewyrm/Documents/My Games/Freelancer/PerfOptions.ini')

const ROOMS = ['intro1_cityscape', 'intro2_volcano', 'intro3_planetchunks'].map((name) =>
  join(game, 'UNIVERSE/SYSTEMS/INTRO/BASES/ROOMS', `${name}.ini`),
)
const SCRIPTS = join(game, 'SCRIPTS/REFERENCE')

/** The corpus is measured by other suites. A stray file there reads as their readers drifting. */
const assertNotCorpus = (): void => {
  if (!existsSync(game)) throw new Error(`no game at ${game}: set FREELANCER_GAME`)
  if (!existsSync(corpus)) return
  const inside = relative(realpathSync(corpus), realpathSync(game))
  if (inside === '' || !inside.startsWith('..'))
    throw new Error(`${game} is inside the corpus at ${corpus}`)
}

const mount = (name: string): void => {
  const scene = scenes.get(name)
  if (!scene) throw new Error(`no scene named ${name}: ${[...scenes.keys()].join(', ')}`)
  assertNotCorpus()

  mkdirSync(SCRIPTS, { recursive: true })
  writeFileSync(join(SCRIPTS, `${name}.thn`), sceneScript(scene))

  for (const room of ROOMS) {
    const backup = `${room}.retail`
    if (!existsSync(backup)) copyFileSync(room, backup)
    writeFileSync(room, `[Room_Info]\nscene = ambient, Scripts\\Reference\\${name}.thn\n`)
  }
  console.log(`menu now plays ${name}`)
}

const restore = (): void => {
  assertNotCorpus()
  for (const room of ROOMS) if (existsSync(`${room}.retail`)) renameSync(`${room}.retail`, room)
  rmSync(SCRIPTS, { recursive: true, force: true })
  console.log('menu restored')
}

/** Copies the last run's log, the shots it names, and the options that shaped it. */
const collect = (name: string): void => {
  const executable = join(dirname(game), 'EXE')
  const output = join(references, name)
  mkdirSync(output, { recursive: true })

  const log = join(executable, 'd3d8log.jsonl')
  const capture = readCapture(readFileSync(log, 'utf8'))
  copyFileSync(log, join(output, 'd3d8log.jsonl'))
  copyFileSync(options, join(output, 'PerfOptions.ini'))

  for (const { shot } of capture.frames)
    if (shot?.file) copyFileSync(join(executable, shot.file), join(output, shot.file))

  console.log(`${output}: ${capture.frames.length} frames`)
}

const [command, name] = process.argv.slice(2)

if (command === 'mount' && name) mount(name)
else if (command === 'collect' && name) collect(name)
else if (command === 'restore') restore()
else {
  console.error('usage: reference mount <scene> | collect <name> | restore')
  process.exitCode = 1
}
