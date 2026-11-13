/** Reads a `tools/d3d8log` capture. Test-only: not part of the published library. */

export interface CaptureTexture {
  pointer: number
  type: '2d' | 'cube' | 'volume'
  levels: number
  width: number | undefined
  height: number | undefined
  /** D3DFORMAT value. */
  format: number | undefined
  /** D3DPOOL value. */
  pool: number | undefined
  /** One per mip level; `undefined` where the level could not be locked. */
  hash: (string | undefined)[]
}

export interface CaptureStage {
  texture: CaptureTexture | undefined
  /** Texture stage states, by `D3DTSS_` name. */
  states: Record<string, number>
  /** Present only while `TEXTURETRANSFORMFLAGS` is on. */
  transform: number[] | undefined
}

export interface CaptureLight {
  index: number
  type: number
  diffuse: number[]
  specular: number[]
  ambient: number[]
  position: number[]
  direction: number[]
  range: number
  falloff: number
  attenuation: number[]
  theta: number
  phi: number
}

export interface CaptureMaterial {
  diffuse: number[]
  ambient: number[]
  specular: number[]
  emissive: number[]
  power: number
}

export interface CaptureVertex {
  p: number[]
  n?: number[]
  d?: string
  t0?: number[]
  t1?: number[]
}

export interface CaptureDraw {
  kind: 'draw'
  /** Draws before this one in the frame. */
  n: number
  call: string
  primitive: string
  primitives: number
  vertices: number
  indices: number
  minIndex: number | undefined
  startIndex: number | undefined
  baseVertex: number | undefined
  fvf: number
  pixelShader: number
  stride: number
  /** Render states, by `D3DRS_` name. */
  states: Record<string, number>
  /** Row-major, for row vectors: `p * M`. Present unless `matrices = 0`. */
  world: number[] | undefined
  view: number[] | undefined
  projection: number[] | undefined
  /** X, Y, width, height, min Z, max Z. */
  viewport: number[]
  material: CaptureMaterial
  lights: CaptureLight[]
  stages: CaptureStage[]
  clipPlanes: number[][] | undefined
  /** Stops at 1024 entries; `indices` is the true count. */
  indexData: number[] | undefined
  /** Present only for draws within `verts_max`. */
  space: 'model' | 'screen' | undefined
  vertexData: CaptureVertex[] | undefined
}

export interface CaptureClear {
  kind: 'clear'
  n: number
  /** D3DCLEAR bits. */
  flags: number
  colour: number
  z: number
  stencil: number
  rects: number
  viewport: number[]
}

/** A draw, or something else that writes to or changes the frame, in the order the game did it. */
export type CaptureEvent =
  | CaptureDraw
  | CaptureClear
  | { kind: 'scene'; n: number; at: 'begin' | 'end' }
  | { kind: 'target'; n: number; target: number; depth: number }
  | { kind: 'copy'; n: number; rects: number }

export interface CaptureShot {
  /** BMP beside the log; `undefined` when the front buffer could not be read. */
  file: string | undefined
  /** HRESULT of the failure, when there is no file. */
  result: number | undefined
  red: number[]
  green: number[]
  blue: number[]
}

/** Freelancer.exe 1.1's frame clock at `Present`, read from its globals (`FUN_0042d770`). */
export interface CaptureClock {
  /** The dt this frame stepped by: `FUN_0042d680`, the capped dt or 0 while paused. */
  step: number
  /** Capped to a second; the same as `raw` below that. */
  capped: number
  raw: number
  paused: number
  /** The sum of capped dt since the game started. */
  elapsed: number
  /** Frames ticked, so a gap between captured frames shows. */
  ticks: number
}

export interface CaptureFrame {
  index: number
  /** Seconds since the previous `Present`, by the proxy's own counter. */
  wall: number | undefined
  /** Absent on another build of the executable, or a log from before it was recorded. */
  clock: CaptureClock | undefined
  events: CaptureEvent[]
  draws: CaptureDraw[]
  shot: CaptureShot | undefined
}

export interface CaptureDevice {
  width: number
  height: number
  windowed: boolean
  /** D3DCREATE bits. */
  behaviour: number
  adapter: string
  caps: Record<string, number | string>
}

export interface Capture {
  device: CaptureDevice | undefined
  frames: CaptureFrame[]
}

// JSON.parse's result, read field by field below and checked by the capture tests.
type Line = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const readTexture = (line: Line): CaptureTexture => ({
  pointer: Number(line['p']),
  type: line['type'],
  levels: line['levels'],
  width: line['w'],
  height: line['h'],
  format: line['fmt'],
  pool: line['pool'],
  hash: (line['hash'] as (string | null)[]).map((hash) => hash ?? undefined),
})

const readStage = (line: Line, textures: Map<number, CaptureTexture>): CaptureStage => {
  const { texture, transform, ...states } = line
  const pointer = texture === null ? undefined : Number(texture)
  const found = pointer === undefined ? undefined : textures.get(pointer)

  if (pointer !== undefined && !found)
    throw new Error(`stage binds texture 0x${pointer.toString(16)}, which has no texture line`)

  return { texture: found, states, transform }
}

const readDraw = (line: Line, textures: Map<number, CaptureTexture>): CaptureDraw => ({
  kind: 'draw',
  n: line['n'],
  call: line['call'],
  primitive: line['prim'],
  primitives: line['prims'],
  vertices: line['verts'],
  indices: line['indices'],
  minIndex: line['minIndex'],
  startIndex: line['startIndex'],
  baseVertex: line['baseVertex'],
  fvf: Number(line['fvf']),
  pixelShader: Number(line['ps']),
  stride: line['stride'],
  states: line['rs'],
  world: line['world'],
  view: line['view'],
  projection: line['proj'],
  viewport: line['viewport'],
  material: line['material'],
  lights: line['lights'],
  stages: (line['stages'] as Line[]).map((stage) => readStage(stage, textures)),
  clipPlanes: line['clip'],
  indexData: line['idx'],
  space: line['pos'],
  vertexData: line['v'],
})

/** Parses a whole capture, and throws rather than hand back a frame it can't account for. */
export const readCapture = (text: string): Capture => {
  const capture: Capture = { device: undefined, frames: [] }
  const textures = new Map<number, CaptureTexture>()
  let events: CaptureEvent[] = []

  text.split('\n').forEach((source, at) => {
    if (!source) return

    let line: Line

    try {
      line = JSON.parse(source)
    } catch {
      throw new Error(`line ${at + 1} is not JSON`)
    }

    switch (line['ev']) {
      case 'truncated':
        throw new Error(`line ${at + 1} overflowed the proxy's line buffer`)
      case 'device':
        capture.device = {
          width: line['w'],
          height: line['h'],
          windowed: line['windowed'] !== 0,
          behaviour: Number(line['behaviour']),
          adapter: line['adapter'],
          caps: line['caps'],
        }
        break
      case 'texture': {
        const texture = readTexture(line)

        textures.set(texture.pointer, texture)
        break
      }
      case 'scene':
        events.push({ kind: 'scene', n: line['n'], at: line['at'] })
        break
      case 'clear':
        events.push({
          kind: 'clear',
          n: line['n'],
          flags: line['flags'],
          colour: Number(line['colour']),
          z: line['z'],
          stencil: line['stencil'],
          rects: line['rects'],
          viewport: line['viewport'],
        })
        break
      case 'target':
        events.push({
          kind: 'target',
          n: line['n'],
          target: Number(line['target']),
          depth: Number(line['depth']),
        })
        break
      case 'copy':
        events.push({ kind: 'copy', n: line['n'], rects: line['rects'] })
        break
      case 'draw':
        events.push(readDraw(line, textures))
        break
      case 'frame': {
        const draws = events.filter((event) => event.kind === 'draw')

        if (draws.length !== line['draws'])
          throw new Error(`frame ${line['i']} has ${draws.length} draws, says ${line['draws']}`)

        const clock: CaptureClock | undefined =
          line['dt'] === undefined
            ? undefined
            : {
                step: line['paused'] ? 0 : line['dt'],
                capped: line['dt'],
                raw: line['raw'],
                paused: line['paused'],
                elapsed: line['t'],
                ticks: line['tick'],
              }

        capture.frames.push({
          index: line['i'],
          wall: line['wall'],
          clock,
          events,
          draws,
          shot: undefined,
        })
        events = []
        break
      }
      case 'shot': {
        const frame = capture.frames.find(({ index }) => index === line['i'])
        if (!frame) throw new Error(`shot of frame ${line['i']}, which was not captured`)
        frame.shot = {
          file: line['file'],
          result: line['hr'] === undefined ? undefined : Number(line['hr']),
          red: line['red'],
          green: line['green'],
          blue: line['blue'],
        }
        break
      }
    }
  })

  if (events.length) throw new Error('capture ends inside a frame')
  return capture
}
