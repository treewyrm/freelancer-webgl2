/**
 * `npm run frames -- room <name> | system <ini> …`: stills to `artifacts/<name>_<t>s.png` and clips
 * to `artifacts/<name>.mp4`, from a room's scripts or a retail system. For looking, not comparing.
 *
 *   room s002xe --at 20,20.8                   stills
 *   room s002xe --video [--from 5] [--to 30]   a clip, the scripts' length when `--to` is absent
 *   room x --room <ini> --script <thn>[:rtc|ambient] …
 *   system <ini> --eye x,y,z --target x,y,z --at 2
 *   system <ini> --thn <file> [--monitor name] [--anchor x,y,z] --video   as `Act_CallThorn`
 *   system <ini> --path <keys.json> --video    a flyby: { duration, fovh?, keys: [{ position, target | orientation }] }
 *     a key with a `target` may `roll`: degrees the camera turns anticlockwise about its view
 *
 * Also `--fps 60`, `--size 1024x768`, `--name`, `--preset slow`, `--crf 12`.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { Matrix3 } from '@treewyrm/freelancer/math'
import { launch, runFixture } from '#/harness.js'
import { columnsOf, quaternionOf } from '#/thorn/frame.js'
import type { SequenceFlags } from '#/thorn/sequence.js'
import type { FramesArgs, FramesReport, RoomShot, SpaceView } from './frames.fixture.js'
import { lookAt, type Triple } from './look.js'

const data = process.env['FREELANCER_DATA'] ?? join(homedir(), 'Downloads/Freelancer/DATA')
const ARTIFACTS = 'artifacts'

// A mission cutscene: cinematic, priority 0; a room's scene: looping, exporting (THN-HOST.md).
const FLAGS: Record<string, SequenceFlags> = {
  rtc: { cinematic: true, priority: 0 },
  ambient: { loop: true, exported: true, priority: 0 },
}

const CUTSCENES: Record<string, Omit<RoomShot, 'kind'>> = {
  s002xe: {
    room: 'UNIVERSE/SYSTEMS/LI01/BASES/ROOMS/li01_01_cityscape.ini',
    scripts: [
      { path: 'SCRIPTS/BASES/li_01_cityscape_gamestart_01.thn', flags: FLAGS['ambient']! },
      { path: 'SCRIPTS/STORY/s002xe_nrml_sinclair_li_01_cityscape_01.thn', flags: FLAGS['rtc']! },
    ],
  },
  s004x: {
    room: 'UNIVERSE/SYSTEMS/LI01/BASES/ROOMS/li01_01_bar.ini',
    scripts: [{ path: 'SCRIPTS/STORY/s004x_nrml_juni_li_01_bar_01.thn', flags: FLAGS['rtc']! }],
  },
}

interface Flyby {
  duration: number
  fovh?: number
  near?: number
  far?: number
  keys: {
    position: Triple
    target?: Triple
    roll?: number
    orientation?: readonly [number, number, number, number]
  }[]
}

const triple = (text: string | undefined, what: string): Triple => {
  const values = (text ?? '').split(',').map(Number)
  if (values.length !== 3 || values.some(Number.isNaN))
    throw new Error(`${what}: not x,y,z: ${text}`)
  return values as unknown as Triple
}

const dataPath = (path: string) => join(data, path.replace(/\\/g, '/'))

/**
 * A flyby as a THN script: a camera riding one `MOTION_PATH` from start to end, the monitor on it.
 * Keys are world positions and the camera's turn as `{w,x,y,z}`, the path at the origin, unturned.
 */
const flybyText = ({ duration, fovh = 35, near = 1, far = 100000, keys }: Flyby): string => {
  if (keys.length < 2) throw new Error('A path needs two keys at least (`SplinePath.cpp`)')

  let last: { x: number; y: number; z: number; w: number } | undefined
  const pairs = keys.map(({ position, target, roll = 0, orientation }) => {
    if (!orientation && !target) throw new Error('A key needs a target or an orientation')

    let turn = orientation
      ? { w: orientation[0], x: orientation[1], y: orientation[2], z: orientation[3] }
      : (() => {
          const { x: right, y: up, z: back } = Matrix3.transpose(lookAt(position, target!))
          const [c, s] = [Math.cos((roll * Math.PI) / 180), Math.sin((roll * Math.PI) / 180)]
          const mix = (a: typeof up, b: typeof up, k: number) => ({
            x: a.x * c + b.x * k,
            y: a.y * c + b.y * k,
            z: a.z * c + b.z * k,
          })

          return quaternionOf(columnsOf(mix(right, up, s), mix(up, right, -s), back))
        })()

    // The spline's squad doesn't fold hemispheres, so each key is put on its predecessor's side.
    if (last && last.w * turn.w + last.x * turn.x + last.y * turn.y + last.z * turn.z < 0)
      turn = { w: -turn.w, x: -turn.x, y: -turn.y, z: -turn.z }
    last = turn

    return `{${position.join(',')}}, {${[turn.w, turn.x, turn.y, turn.z].join(',')}}, `
  })
  const [x, y, z] = keys[0]!.position
  const entity = (name: string, type: string, rest: string) =>
    `  {\n    entity_name = "${name}",\n    type = ${type},\n    template_name = "",\n    lt_grp = 0,\n    srt_grp = 0,\n    usr_flg = 0${rest}\n  }`
  const unturned = 'orient = { { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 } }'

  return `duration = ${duration}

entities = {
${[
  entity('Flyby_Monitor', 'MONITOR', ''),
  entity(
    'Flyby_Camera',
    'CAMERA',
    `,\n    spatialprops = { pos = { ${x}, ${y}, ${z} }, ${unturned} },\n    cameraprops = { fovh = ${fovh}, hvaspect = 1.333333, nearplane = ${near}, farplane = ${far} }`,
  ),
  entity(
    'Flyby_Path',
    'MOTION_PATH',
    `,\n    spatialprops = { pos = { 0, 0, 0 }, ${unturned} },\n    pathprops = { path_type = "CV_CROrientationSplinePath", path_data = "OPEN, ${pairs.join('')}" }`,
  ),
].join(',\n')}
}

events = {
  { 0, SET_CAMERA, { "Flyby_Monitor", "Flyby_Camera" } },
  {
    0,
    START_PATH_ANIMATION,
    { "Flyby_Camera", "Flyby_Path" },
    {
      duration = ${duration},
      start_percent = 0,
      stop_percent = 1,
      offset = { 0, 0, 0 },
      up = Y_AXIS,
      front = NEG_Z_AXIS,
      flags = POSITION + ORIENTATION
    }
  }
}
`
}

const OPTIONS = {
  at: { type: 'string' },
  video: { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  fps: { type: 'string', default: '60' },
  size: { type: 'string', default: '1024x768' },
  name: { type: 'string' },
  preset: { type: 'string', default: 'slow' },
  crf: { type: 'string', default: '12' },
  room: { type: 'string' },
  script: { type: 'string', multiple: true },
  eye: { type: 'string' },
  target: { type: 'string' },
  fovh: { type: 'string', default: '35' },
  thn: { type: 'string' },
  monitor: { type: 'string' },
  anchor: { type: 'string' },
  path: { type: 'string' },
  'sun-effect': { type: 'string', default: '1' },
} as const

// `--eye -28022,0,51486`: a value after its option, even one that starts with a minus.
const argv = process.argv
  .slice(2)
  .flatMap((arg, at, all) =>
    all[at - 1]?.startsWith('--') &&
    OPTIONS[all[at - 1]!.slice(2) as keyof typeof OPTIONS]?.type === 'string' &&
    !all[at - 1]!.includes('=')
      ? []
      : arg.startsWith('--') &&
          OPTIONS[arg.slice(2) as keyof typeof OPTIONS]?.type === 'string' &&
          all[at + 1] !== undefined
        ? [`${arg}=${all[at + 1]}`]
        : [arg],
  )
const { values: options, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: OPTIONS,
})
const [kind, subject] = positionals

if ((kind !== 'room' && kind !== 'system') || !subject)
  throw new Error(
    'Usage: npm run frames -- room <name> | system <ini> (--at t,… | --video); see frames.ts',
  )
if (!options.at && !options.video) throw new Error('Nothing to draw: give --at, --video or both')

const fps = Number(options.fps)
if (60 % fps !== 0) throw new Error(`--fps must divide 60: ${fps}`)

const [width, height] = options.size.split('x').map(Number) as [number, number]
const name = options.name ?? (kind === 'room' ? subject : basename(subject).replace(/\.ini$/i, ''))
const tick = (seconds: string) => Math.round(Number(seconds) * 60)
const at = options.at?.split(',') ?? []
const args: FramesArgs = {
  shot:
    kind === 'room'
      ? {
          kind,
          ...(options.room
            ? {
                room: options.room,
                scripts: (options.script ?? []).map((each) => {
                  const [path = '', flags = 'rtc'] = each.split(':')
                  if (!FLAGS[flags]) throw new Error(`Script flags: rtc or ambient, not ${flags}`)
                  return { path, flags: FLAGS[flags] }
                }),
              }
            : (CUTSCENES[subject] ??
              (() => {
                throw new Error(
                  `No cutscene ${subject}: ${Object.keys(CUTSCENES).join(', ')}, or --room`,
                )
              })())),
        }
      : {
          kind,
          path: subject,
          sunEffect: Number(options['sun-effect']),
          view: ((): SpaceView => {
            const anchor = options.anchor
              ? triple(options.anchor, '--anchor')
              : ([0, 0, 0] as const)

            if (options.path) {
              const flyby = JSON.parse(readFileSync(options.path, 'utf8')) as Flyby
              return { thn: Buffer.from(flybyText(flyby)).toString('base64'), anchor }
            }
            if (options.thn) {
              const file = existsSync(options.thn) ? options.thn : dataPath(options.thn)
              return {
                thn: readFileSync(file).toString('base64'),
                ...(options.monitor && { monitor: options.monitor }),
                anchor,
              }
            }
            return {
              eye: triple(options.eye, '--eye'),
              target: triple(options.target, '--target'),
              fovh: Number(options.fovh),
            }
          })(),
        },
  stills: at.map((seconds) => ({ tick: tick(seconds), name: `${name}_${seconds}s` })),
  ...(options.video && {
    video: {
      from: tick(options.from ?? '0'),
      ...(options.to !== undefined && { to: tick(options.to) }),
      every: 60 / fps,
    },
  }),
}

mkdirSync(ARTIFACTS, { recursive: true })

const out = join(ARTIFACTS, `${name}.mp4`)
const ffmpeg = options.video
  ? spawn(
      'ffmpeg',
      [
        ...['-y', '-loglevel', 'error'],
        ...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`],
        ...['-framerate', String(fps), '-i', '-'],
        // `readPixels` is bottom-up. BT.709, said in the stream as well as done.
        ...['-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'],
        ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
        ...['-c:v', 'libx264', '-preset', options.preset, '-crf', options.crf],
        ...['-movflags', '+faststart', out],
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    )
  : undefined
const ffmpegClosed = ffmpeg ? once(ffmpeg, 'close') : Promise.resolve()

const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

let written = 0
let firstFrame = 0

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')

  try {
    if (request.method === 'GET' && url.pathname === '/')
      return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>')

    if (request.method === 'GET' && url.pathname.startsWith('/asset/')) {
      const file = dataPath(decodeURIComponent(url.pathname.slice('/asset/'.length)))
      if (!existsSync(file)) return response.writeHead(404).end()
      return response.writeHead(200).end(readFileSync(file))
    }

    if (request.method === 'POST' && url.pathname === '/frame' && ffmpeg) {
      const pixels = await body(request)
      // The page posts one at a time, in order; the answer waits for the pipe, which paces it. A
      // frame already written is a post sent again, its answer having been lost.
      const n = Number(url.searchParams.get('n'))
      if (n < written) return response.writeHead(204).end()
      if (n !== written) throw new Error(`Frame ${n} where ${written} was due`)
      if (written++ === 0) firstFrame = performance.now()
      if (!ffmpeg.stdin.write(pixels)) await once(ffmpeg.stdin, 'drain')
      if (written % 300 === 0) {
        const rate = (written - 1) / ((performance.now() - firstFrame) / 1000)
        console.log(`${written} frames, ${(written / fps).toFixed(1)} s, ${rate.toFixed(1)} fps`)
      }
      return response.writeHead(204).end()
    }

    if (request.method === 'POST' && url.pathname === '/still') {
      const file = join(ARTIFACTS, `${url.searchParams.get('name')}.png`)
      writeFileSync(file, await body(request))
      console.log(file)
      return response.writeHead(204).end()
    }

    response.writeHead(404).end()
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

// Node drops a connection idle 5 s, and a POST Chromium sends on it as it goes fails: never drop.
server.keepAliveTimeout = 0
server.listen(0, '127.0.0.1')
await once(server, 'listening')

const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
// `gc` for the page: see `readback` in the fixture.
const browser = await launch(['--js-flags=--expose-gc'])
const started = performance.now()

try {
  const { value, renderer } = await runFixture<FramesReport>(
    browser,
    new URL('./frames.fixture.ts', import.meta.url),
    {
      width,
      height,
      // Stills are taken with `toBlob`, which needs the picture kept; frames are read as drawn.
      context: { antialias: false, alpha: false, preserveDrawingBuffer: !options.video },
      args,
      origin,
    },
  )
  const seconds = (performance.now() - started) / 1000

  console.log(
    `${renderer}\n${value.ticks} ticks, ${value.frames} frames, ${value.stills} stills in ${seconds.toFixed(1)} s:`,
    `load ${(value.load / 1000).toFixed(1)} s, run ${(value.run / 1000).toFixed(1)} s`,
    value.frames ? `(${(value.frames / (value.run / 1000)).toFixed(1)} fps)` : '',
    value.error ? `GL error ${value.error}` : '',
    value.retries ? `${value.retries} posts sent again` : '',
  )
  if (value.skipped.length) console.log('skipped:\n  ' + value.skipped.join('\n  '))
} finally {
  await browser.close()
  server.closeAllConnections()
  server.close()
  ffmpeg?.stdin.end()
  await ffmpegClosed
  if (ffmpeg) console.log(out)
}
