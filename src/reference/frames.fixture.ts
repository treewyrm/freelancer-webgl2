/**
 * Stills and clips, in the page: a room's scripts or a retail system stepped at 60 a second, drawn
 * only on the ticks wanted. Video frames go to the CLI's server as raw RGBA, stills as PNG.
 */
import { Matrix4 } from '@treewyrm/freelancer/math'
import * as thn from '@treewyrm/freelancer/thn'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { read as readText } from '@treewyrm/freelancer/thn/text'
import type { Fixture } from '#/harness.js'
import type { Camera } from '#/scene/camera.js'
import { createRenderer } from '#/scene/render.js'
import { collectRoomFrame } from '#/scene/room.js'
import { collectSpaceFrame } from '#/scene/space.js'
import { Playback } from '#/thorn/playback.js'
import { frameMilliseconds, ScriptRun } from '#/thorn/script.js'
import type { SequenceFlags } from '#/thorn/sequence.js'
import { cameraOf, Letterbox } from '#/thorn/view.js'
import { lookAt, type Triple } from './look.js'
import { loadCast } from './retail-cast.js'
import {
  loadRoomEffects,
  loadRoomHardpoints,
  playRetailRoom,
  readRtcSlider,
  retailRoomScene,
} from './retail-room.js'
import { readRetailSystem } from './retail-system.js'
import { loadSystem } from './space-load.js'

export interface RoomShot {
  kind: 'room'
  room: string
  scripts: { path: string; flags: SequenceFlags }[]
}

/** Where a system is seen from: a fixed eye, or a THN script's monitor (compiled or text, base64). */
export type SpaceView =
  { eye: Triple; target: Triple; fovh: number } | { thn: string; monitor?: string; anchor: Triple }

export interface SystemShot {
  kind: 'system'
  path: string
  view: SpaceView
  /** `SunEffect`: its suns' coronas and flares. */
  sunEffect: number
}

export interface FramesArgs {
  shot: RoomShot | SystemShot
  /** Stills by tick, at 60 a second. */
  stills: { tick: number; name: string }[]
  /** Video from `from` to `to` (the scripts' end when absent), every `every`th tick. */
  video?: { from: number; to?: number; every: number }
}

export interface FramesReport {
  ticks: number
  frames: number
  /** Posts sent again after a network error. */
  retries: number
  stills: number
  skipped: string[]
  /** Milliseconds loading, then stepping and drawing. */
  load: number
  run: number
  error: number
}

/** Requests at most this many frames ahead of the server, which answers once each is written. */
const AHEAD = 4
/** Bytes posted between collections: see `poster`. */
const COLLECT = 128 * 1024 * 1024

/** `gc`, which the CLI's browser exposes: see `poster`. */
const collect = () => (globalThis as { gc?: () => void }).gc?.()

/**
 * Posts in order, one at a time, waiting only once `AHEAD` are queued. Each body is a `Blob`, made
 * when sent: Chromium posts a typed array's 3 MB in ~85 ms, the same bytes as a blob in ~5.
 *
 * A `Blob`'s bytes stay in the browser's blob store until the `Blob` is collected, which V8, seeing a
 * small object, isn't pressed to do; once the store is full, a post fails with a bare network error.
 * So the page collects every `COLLECT` bytes posted, and after a failure collects and sends a new
 * `Blob` of the same bytes, a few times.
 */
const poster = () => {
  const queue: Promise<void>[] = []
  let tail = Promise.resolve()
  let retries = 0
  let posted = 0

  return {
    async post(url: string, bytes: BlobPart) {
      tail = tail.then(async () => {
        for (let attempt = 0; ; attempt++) {
          const body = new Blob([bytes])
          const response = await fetch(url, { method: 'POST', body }).catch((error: unknown) => {
            if (attempt >= 3) throw new Error(`${url}: ${error}`)
          })
          if (!response) {
            retries++
            collect()
            await new Promise((resolve) => setTimeout(resolve, 50))
            continue
          }
          if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`)
          if ((posted += body.size) >= COLLECT) {
            posted = 0
            collect()
          }
          return
        }
      })
      queue.push(tail)
      if (queue.length > AHEAD) await queue.shift()
    },
    flush: () => tail,
    retries: () => retries,
  }
}

/**
 * The default framebuffer read into two pixel buffers in turn, each fetched a frame later, when the
 * GPU has long finished it: the copy never waits on the draw. Polling a fence instead was slower, as
 * Chromium updates a sync's status only now and then (~100 ms a poll here).
 */
const readback = (
  gl: WebGL2RenderingContext,
  send: (n: number, pixels: Uint8Array<ArrayBuffer>) => Promise<void>,
) => {
  const { width, height } = gl.canvas
  const size = width * height * 4
  const slots = [0, 1].map(() => {
    const buffer = gl.createBuffer()!

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ)
    return { buffer, n: -1 }
  })
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)

  const drain = async (slot: (typeof slots)[number]) => {
    if (slot.n < 0) return

    const pixels = new Uint8Array(size)

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    await send(slot.n, pixels)
    slot.n = -1
  }
  let count = 0

  return {
    async capture() {
      const slot = slots[count % 2]!

      await drain(slot)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      slot.n = count++
    },
    async finish() {
      // The older first, so frames leave in order.
      await drain(slots[count % 2]!)
      await drain(slots[(count + 1) % 2]!)
      return count
    },
  }
}

/** A script's bytes, compiled or text, as a scene script. */
const scriptOf = (bytes: Uint8Array) =>
  thnScene.read(bytes[0] === 0x1b ? thn.read(bytes) : readText(new TextDecoder().decode(bytes)))

export default (async (gl, { args }) => {
  const { shot, stills, video } = args as FramesArgs
  const started = performance.now()
  const canvas = gl.canvas as HTMLCanvasElement
  const { width, height } = canvas
  // One reader, its bytes kept: the room's and the system's caches are keyed on it.
  const bytes = new Map<string, Promise<Uint8Array>>()
  const read = (path: string) => {
    const key = path.toLowerCase()
    let found = bytes.get(key)

    if (!found)
      bytes.set(
        key,
        (found = fetch(`/asset/${encodeURIComponent(path)}`).then(async (response) => {
          if (!response.ok) throw new Error(`${path}: ${response.status}`)
          return new Uint8Array(await response.arrayBuffer())
        })),
      )
    return found
  }
  const { post, flush, retries } = poster()
  const frames = readback(gl, (n, pixels) => post(`/frame?n=${n}`, pixels))
  const renderer = createRenderer(gl)
  const skipped = new Set<string>()
  const stillAt = new Map<number, string[]>()

  for (const { tick, name } of stills) stillAt.set(tick, [...(stillAt.get(tick) ?? []), name])

  /** Whether `tick` is drawn, and what is sent of it. */
  const wanted = (tick: number, end: number) => {
    const still = stillAt.get(tick)
    const frame =
      video !== undefined &&
      tick >= video.from &&
      tick <= Math.min(video.to ?? end, end) &&
      (tick - video.from) % video.every === 0

    return { still, frame }
  }
  const send = async ({ still, frame }: ReturnType<typeof wanted>) => {
    if (frame) await frames.capture()
    for (const name of still ?? []) {
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob'))), 'image/png'),
      )
      await post(`/still?name=${encodeURIComponent(name)}`, png)
    }
  }
  const lastStill = Math.max(-1, ...stillAt.keys())
  let ticks = 0
  let load = 0

  if (shot.kind === 'room') {
    const scripts = await Promise.all(
      shot.scripts.map(async ({ path, flags }) => ({ script: scriptOf(await read(path)), flags })),
    )
    const all = scripts.map(({ script }) => script)
    const cast = await loadCast(read, all)
    const effects = await loadRoomEffects(read, all)
    const hardpoint = await loadRoomHardpoints(read, all)
    const room = await playRetailRoom(read, shot.room, 0, {
      scripts,
      effects,
      hardpoint: (entity, name) => cast.hardpoint(entity, name) ?? hardpoint(entity, name),
      bone: cast.bone,
      characters: cast.characters,
    })
    const spawn = { rtc: await readRtcSlider(read), slider: 1 }
    const letterbox = new Letterbox()
    const scriptEnd = Math.round(Math.max(...all.map(({ duration }) => duration ?? 0)) * 60)
    const end = Math.max(lastStill, video ? (video.to ?? scriptEnd) : 0)
    let carry = 0

    // A cinematic sequence aims the letterbox at 1 as it starts (THN-HOST.md, the view).
    if (scripts.some(({ flags }) => flags.cinematic)) letterbox.aim(1)
    load = performance.now() - started

    for (let tick = 0; tick <= end; tick++) {
      if (tick > 0) {
        const next = frameMilliseconds(carry, 1 / 60)

        carry = next.carry
        room.manager.update(next.milliseconds)
        letterbox.step(1 / 60)
      }

      // Nothing between draws keeps state: the scene is built afresh from playback each time.
      const want = wanted(tick, end)
      if (!want.frame && !want.still) continue

      const bar = letterbox.bar({ width, height })
      const picture = { width, height: height - 2 * bar }

      room.skipped.length = 0
      const drawn = collectRoomFrame(
        await retailRoomScene(read, room, picture.width / picture.height, { cast, spawn }),
      )

      // The bars, black; the renderer draws and clears the picture between them alone.
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      renderer.render(drawn, {}, { viewport: { x: 0, y: bar, ...picture } })
      for (const each of room.skipped) skipped.add(each)
      await send(want)
    }

    for (const each of cast.skipped) skipped.add(each)
    ticks = end + 1
  } else {
    const { view } = shot
    const script =
      'thn' in view
        ? (() => {
            const parsed = scriptOf(Uint8Array.from(atob(view.thn), (c) => c.charCodeAt(0)))
            const monitor =
              view.monitor ?? parsed.entities.find(({ type }) => type === 'MONITOR')?.entity_name
            if (!monitor) throw new Error('The script has no MONITOR')

            const [x, y, z] = view.anchor
            // `Act_CallThorn`: the camera is the setup frame times the monitor (THN-HOST.md, In space).
            const run = new ScriptRun(
              new Playback(parsed, { frame: Matrix4.translation({ x, y, z }) }),
            )

            return { run, monitor, duration: parsed.duration ?? 0 }
          })()
        : undefined
    const cameraNow = (): Camera => {
      if (!script) {
        const fixed = view as Extract<SpaceView, { eye: Triple }>
        const [x, y, z] = fixed.eye

        return {
          position: { x, y, z },
          orientation: lookAt(fixed.eye, fixed.target),
          fovh: fixed.fovh,
          near: 1,
          far: 100000,
        }
      }

      const seen = script.run.playback.view(script.monitor)
      if (!seen) throw new Error(`No camera ${script.monitor}`)
      return cameraOf(seen)
    }
    let camera = cameraNow()
    const { position: at, orientation } = camera
    const eye: Triple = [at.x, at.y, at.z]
    const player = { ship: 'li_elite', equipment: [], position: eye, rotate: [0, 0, 0] as Triple }
    const { system, skipped: left } = await readRetailSystem(read, shot.path, player)
    const scene = await loadSystem(system, read, {
      camera,
      // A fixed eye has the hull 500 behind it, its third column being its back, as `view` does. A
      // script's camera wanders, so the hull is put far below, where no flyby goes.
      ship: script
        ? { x: at.x, y: at.y - 1e6, z: at.z }
        : {
            x: at.x + orientation.x.z * 500,
            y: at.y + orientation.y.z * 500,
            z: at.z + orientation.z.z * 500,
          },
      detail: 1,
      starSphere: 1,
      effectDetail: 1,
    })
    const suns = { sunEffect: shot.sunEffect, viewport: { width, height }, step: 1 / 60 }
    // `ftol(dt · 1000)` with no carry (`0x51e758`–`0x51e7f3`): 16 ms a tick at 60, so a script of
    // `duration` seconds runs over `duration / 0.016` ticks.
    const tickMs = Math.trunc(Math.fround(1 / 60) * 1000)
    const scriptEnd = script ? Math.ceil((script.duration * 1000) / tickMs) : 0
    const end = Math.max(lastStill, video ? (video.to ?? scriptEnd) : 0)

    for (const each of left) skipped.add(each)
    load = performance.now() - started

    for (let tick = 0; tick <= end; tick++) {
      if (tick > 0) {
        if (script) {
          script.run.update(tickMs)
          camera = cameraNow()
          scene.reframe(camera)
        }
        scene.tick(1 / 60)
      }

      // Every tick: the frame steps the suns' fades, the dust, the clouds and the nebulae.
      const frame = collectSpaceFrame({
        ...scene,
        ...suns,
        aspect: width / height,
        viewport: { width, height },
        ...(tick > 0 && { time: tick / 60 }),
      })
      const want = wanted(tick, end)
      if (!want.frame && !want.still) continue

      gl.viewport(0, 0, width, height)
      renderer.render(frame)
      for (const each of frame.unsupported) skipped.add(each)
      await send(want)
    }

    ticks = end + 1
  }

  const count = await frames.finish()
  await flush()

  return {
    ticks,
    frames: count,
    retries: retries(),
    stills: stills.length,
    skipped: [...skipped],
    load,
    run: performance.now() - started - load,
    error: gl.getError(),
  }
}) satisfies Fixture<FramesReport>
