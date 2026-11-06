/**
 * Puts a reference scene on the game's main menu, takes it off, and collects what a run produced.
 *
 *   npm run reference -- mount li_elite
 *   npm run reference -- collect li_elite
 *   npm run reference -- mount space_order
 *   npm run reference -- restore
 *
 * The menu is three bases, each one room naming a `.thn`, and which one plays is not ours to choose,
 * so all three point at the scene. See `freelancer-vscode/docs/renderer/ALCHEMY-LAB.md`. A system
 * leaves the menu alone, and adds itself to the universe with a save that places the ship in it.
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
import { BAND_LIBRARIES } from './bands.js'
import { EFFECT_TEXTURES, GENERATED_EFFECTS } from './effects.js'
import { generateBands } from './generate.js'
import { sceneScript } from './scene.js'
import { getResourceId } from '@treewyrm/freelancer'
import { writeAlchemy } from '@treewyrm/freelancer/alchemy'
import { Document } from '@treewyrm/freelancer/ini'
import { Directory } from '@treewyrm/freelancer/utf'
import { scenes } from './scenes.js'
import { saveFile, saveText, systemIni, systems, universeSection } from './systems.js'

const GUEST = '/Volumes/[C] Windows 11'

const game = process.env['FREELANCER_GAME'] ?? join(GUEST, 'Games/Freelancer/DATA')
const corpus = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const references = process.env['FREELANCER_REFERENCES'] ?? 'references'
const profile = join(GUEST, 'Users/treewyrm/Documents/My Games/Freelancer')
const options = join(profile, 'PerfOptions.ini')
const SAVES = join(profile, 'Accts/SinglePlayer')

const ROOMS = ['intro1_cityscape', 'intro2_volcano', 'intro3_planetchunks'].map((name) =>
  join(game, 'UNIVERSE/SYSTEMS/INTRO/BASES/ROOMS', `${name}.ini`),
)
const SCRIPTS = join(game, 'SCRIPTS/REFERENCE')
const EFFECT_SHAPES = join(game, 'FX/effect_shapes.ini')
const SOLAR_ARCH = join(game, 'SOLAR/solararch.ini')
const MISC_ALE = join(game, 'FX/MISC/misc_ale.ini')
const DACOM = join(dirname(game), 'EXE/dacom.ini')
const UNIVERSE = join(game, 'UNIVERSE/universe.ini')
const LAB_SYSTEMS = join(game, 'UNIVERSE/SYSTEMS/LAB')
const INITIAL_WORLD = join(game, 'initialworld.ini')

/** The corpus is measured by other suites. A stray file there reads as their readers drifting. */
const assertNotCorpus = (): void => {
  if (!existsSync(game)) throw new Error(`no game at ${game}: set FREELANCER_GAME`)
  if (!existsSync(corpus)) return
  const inside = relative(realpathSync(corpus), realpathSync(game))
  if (inside === '' || !inside.startsWith('..'))
    throw new Error(`${game} is inside the corpus at ${corpus}`)
}

const asText = (file: string): string =>
  Buffer.from(Document.read(readFileSync(file)).write('text')).toString('latin1')

const mountSystem = (name: string): void => {
  const system = systems.get(name)!
  mkdirSync(LAB_SYSTEMS, { recursive: true })
  writeFileSync(join(LAB_SYSTEMS, `${name}.ini`), systemIni(system))

  // Every mounted system is listed, so that one save doesn't lose another's.
  const universe = `${UNIVERSE}.retail`
  if (!existsSync(universe)) copyFileSync(UNIVERSE, universe)
  const mounted = readdirSync(LAB_SYSTEMS)
    // The Mac leaves `._` files beside what it writes on the guest's volume.
    .filter((file) => file.endsWith('.ini') && !file.startsWith('.'))
    .map((file) => universeSection(file.slice(0, -'.ini'.length)))
  writeFileSync(UNIVERSE, `${asText(universe)}\r\n${mounted.join('\r\n')}\r\n`, 'latin1')

  writeFileSync(join(SAVES, saveFile(name)), saveText(system, asText(INITIAL_WORLD)), 'latin1')
  // The game tries every `*.fl` as a save, the Mac's `._` copies included.
  for (const directory of [SAVES, LAB_SYSTEMS])
    for (const file of readdirSync(directory))
      if (file.startsWith('._')) rmSync(join(directory, file))
  console.log(`load ${saveFile(name)} to fly in ${name}; the menu is untouched`)
}

const mount = (name: string): void => {
  if (systems.has(name)) {
    assertNotCorpus()
    return mountSystem(name)
  }
  const scene = scenes.get(name)
  const names = [...scenes.keys(), ...systems.keys()]
  if (!scene) throw new Error(`no scene named ${name}: ${names.join(', ')}`)
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
  const labSkies = (scene.sky ?? []).filter(({ category }) => category === 'Solar')
  if (labSkies.length) {
    copyFileSync(SOLAR_ARCH, solars)
    const text = Buffer.from(Document.read(readFileSync(solars)).write('text')).toString('latin1')
    const sections = labSkies.flatMap(({ archetype, file }) => [
      '[Solar]',
      `nickname = ${archetype}`,
      'ids_name = 1',
      'ids_info = 1',
      'type = SATELLITE',
      `DA_archetype = solar\\starsphere\\${file}`,
      'mass = 1000',
      'solar_radius = 10',
    ])
    writeFileSync(SOLAR_ARCH, `${text}\r\n${sections.join('\r\n')}\r\n`, 'latin1')
  }
  if (scene.generated) {
    const { model, library } = generateBands(scene.generated)
    writeFileSync(join(SCRIPTS, 'bands.3db'), model)
    writeFileSync(join(SCRIPTS, 'bands.mat'), library)
    copyFileSync(SOLAR_ARCH, solars)
    const text = Buffer.from(Document.read(readFileSync(solars)).write('text')).toString('latin1')
    const libraries = BAND_LIBRARIES.map((path) => path.replaceAll('/', '\\'))
    const lines = [
      '[Solar]',
      `nickname = ${scene.model!.archetype}`,
      'ids_name = 1',
      'ids_info = 1',
      'type = SATELLITE',
      'DA_archetype = scripts\\reference\\bands.3db',
      ...libraries.map((path) => `material_library = ${path}`),
      'material_library = scripts\\reference\\bands.mat',
      ...(scene.generated.noEnvironment ? [] : ['envmap_material = envmapbasic']),
      'LODranges = 0, 2000',
      'mass = 1000',
      'solar_radius = 10',
    ]
    writeFileSync(SOLAR_ARCH, `${text}\r\n${lines.join('\r\n')}\r\n`, 'latin1')
  }
  // Any `*_ale.ini` will do: the `[VisEffect]` table is global.
  const visEffects = `${MISC_ALE}.retail`
  if (existsSync(visEffects)) renameSync(visEffects, MISC_ALE)
  if (scene.effect) {
    const nickname = `lab_${scene.effect.kind}`
    const alchemy = GENERATED_EFFECTS[scene.effect.kind]()
    writeFileSync(
      join(SCRIPTS, `${nickname}.ale`),
      new Directory('\\', writeAlchemy(alchemy)).write(),
    )
    copyFileSync(MISC_ALE, visEffects)
    const text = Buffer.from(Document.read(readFileSync(visEffects)).write('text')).toString(
      'latin1',
    )
    const section = [
      '[VisEffect]',
      `nickname = ${nickname}`,
      `alchemy = scripts\\reference\\${nickname}.ale`,
      `effect_crc = ${getResourceId(nickname, true) | 0}`,
      `textures = ${EFFECT_TEXTURES}`,
    ]
    writeFileSync(MISC_ALE, `${text}\r\n${section.join('\r\n')}\r\n`, 'latin1')
  }
  const dacom = `${DACOM}.retail`
  if (existsSync(dacom)) renameSync(dacom, DACOM)
  if (scene.effect?.pools) {
    copyFileSync(DACOM, dacom)
    let text = readFileSync(dacom, 'latin1')
    for (const [type, size] of Object.entries(scene.effect.pools)) {
      const line = new RegExp(`^(${type}\\.poolSize\\s*=\\s*)\\d+`, 'm')
      if (!line.test(text)) throw new Error(`no ${type}.poolSize in ${DACOM}`)
      text = text.replace(line, `$1${size}`)
    }
    writeFileSync(DACOM, text, 'latin1')
  }
  const extras = [
    scene.preload?.length && 'preloads',
    scene.generated && 'a generated model',
    scene.effect && 'a generated effect',
  ]
  const also = extras.filter(Boolean).join(' and ')
  console.log(`menu now plays ${name}${also ? `, with ${also}` : ''}`)
}

/** Restores everything a mount changed: menu, tables, lab systems and their saves. */
const restore = (): void => {
  assertNotCorpus()
  for (const file of [...ROOMS, EFFECT_SHAPES, SOLAR_ARCH, MISC_ALE, DACOM, UNIVERSE])
    if (existsSync(`${file}.retail`)) renameSync(`${file}.retail`, file)
  rmSync(SCRIPTS, { recursive: true, force: true })
  rmSync(LAB_SYSTEMS, { recursive: true, force: true })
  for (const name of systems.keys()) rmSync(join(SAVES, saveFile(name)), { force: true })
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
