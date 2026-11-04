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
  readdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { readCapture } from '#/capture/capture.js'
import { BAND_ANIMATIONS, BAND_LIBRARIES, BANDS } from './bands.js'
import { generateBands } from './generate.js'
import { sceneScript } from './scene.js'
import { Document } from '@treewyrm/freelancer/ini'
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
const EFFECT_SHAPES = join(game, 'FX/effect_shapes.ini')
const SOLAR_ARCH = join(game, 'SOLAR/solararch.ini')

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

  // Written as text, which the game reads as readily as BINI. A scene without any puts retail's back.
  const backup = `${EFFECT_SHAPES}.retail`
  if (existsSync(backup)) renameSync(backup, EFFECT_SHAPES)
  if (scene.preload?.length) {
    copyFileSync(EFFECT_SHAPES, backup)
    const text = Buffer.from(Document.read(readFileSync(backup)).write('text')).toString('latin1')
    const added = scene.preload.map(
      ({ file, texture }) => `\r\n[Texture]\r\nfile = ${file}\r\ntex_shape = ${texture}\r\n`,
    )
    writeFileSync(EFFECT_SHAPES, text + added.join(''), 'latin1')
  }

  const solars = `${SOLAR_ARCH}.retail`
  if (existsSync(solars)) renameSync(solars, SOLAR_ARCH)
  if (scene.generated) {
    const { model, library } = generateBands(BANDS, BAND_ANIMATIONS)
    writeFileSync(join(SCRIPTS, 'bands.3db'), model)
    writeFileSync(join(SCRIPTS, 'bands.mat'), library)
    copyFileSync(SOLAR_ARCH, solars)
    const text = Buffer.from(Document.read(readFileSync(solars)).write('text')).toString('latin1')
    const libraries = BAND_LIBRARIES.map((path) => path.replaceAll('/', '\\'))
    const lines = [
      '[Solar]',
      `nickname = ${scene.model.archetype}`,
      'ids_name = 1',
      'ids_info = 1',
      'type = SATELLITE',
      'DA_archetype = scripts\\reference\\bands.3db',
      ...libraries.map((path) => `material_library = ${path}`),
      'material_library = scripts\\reference\\bands.mat',
      'envmap_material = envmapbasic',
      'LODranges = 0, 2000',
      'mass = 1000',
      'solar_radius = 10',
    ]
    writeFileSync(SOLAR_ARCH, `${text}\r\n${lines.join('\r\n')}\r\n`, 'latin1')
  }
  const extras = [scene.preload?.length && 'preloads', scene.generated && 'a generated model']
  const also = extras.filter(Boolean).join(' and ')
  console.log(`menu now plays ${name}${also ? `, with ${also}` : ''}`)
}

const restore = (): void => {
  assertNotCorpus()
  for (const file of [...ROOMS, EFFECT_SHAPES, SOLAR_ARCH])
    if (existsSync(`${file}.retail`)) renameSync(`${file}.retail`, file)
  rmSync(SCRIPTS, { recursive: true, force: true })
  console.log('menu restored')
}

/** Copies the last run's log, the shots it names, and the options that shaped it. */
const collect = (name: string): void => {
  const executable = join(dirname(game), 'EXE')
  const output = join(references, name)
  mkdirSync(output, { recursive: true })
  // A rerun's screenshot has a new frame number, and an old one would be read in its place.
  for (const entry of readdirSync(output)) if (entry.endsWith('.bmp')) rmSync(join(output, entry))

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
