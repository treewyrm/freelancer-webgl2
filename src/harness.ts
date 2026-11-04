import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, type Browser } from 'playwright'

/** Runs in the page with a fresh context; its return value must survive structured cloning. */
export type Fixture<T> = (gl: WebGL2RenderingContext) => T | Promise<T>

export interface FixtureOptions {
  width?: number
  height?: number
}

export interface FixtureResult<T> {
  value: T
  renderer: string
  png: Buffer
}

const ARTIFACTS = new URL('../artifacts/', import.meta.url)
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i
const ANGLE_BACKEND: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'metal',
  win32: 'd3d11',
  linux: 'vulkan',
}

/** Full (not shell) headless Chromium, which is the build that can reach the hardware GPU. */
export const launch = (): Promise<Browser> =>
  chromium.launch({
    channel: 'chromium',
    headless: true,
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      `--use-angle=${ANGLE_BACKEND[process.platform] ?? 'default'}`,
    ],
  })

/** Bundles a fixture module for the page, with the context setup around its default export. */
const bundle = async (fixture: URL): Promise<string> => {
  const contents = `
    import { createContext } from ${JSON.stringify(fileURLToPath(new URL('./gl/context.ts', import.meta.url)))}
    import fixture from ${JSON.stringify(fileURLToPath(fixture))}

    globalThis.runFixture = async (width, height) => {
      const canvas = Object.assign(document.createElement('canvas'), { width, height })
      const gl = createContext(canvas, { preserveDrawingBuffer: true })
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      const renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
      const value = await fixture(gl)
      return { value, renderer, png: canvas.toDataURL('image/png') }
    }
  `

  const { outputFiles } = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    sourcemap: 'inline',
  })

  return outputFiles[0]!.text
}

/** Runs a fixture in a new page. Throws, rather than skips, when no hardware GPU is in use. */
export const runFixture = async <T>(
  browser: Browser,
  fixture: URL,
  { width = 256, height = 256 }: FixtureOptions = {},
): Promise<FixtureResult<T>> => {
  const page = await browser.newPage()

  try {
    await page.addScriptTag({ content: await bundle(fixture) })

    const { value, renderer, png } = await page.evaluate(
      ([width, height]) =>
        (globalThis as unknown as { runFixture: Function }).runFixture(width, height) as Promise<{
          value: unknown
          renderer: string
          png: string
        }>,
      [width, height],
    )

    if (SOFTWARE_RENDERER.test(renderer)) throw new Error(`Software renderer in use: ${renderer}`)

    return {
      value: value as T,
      renderer,
      png: Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'),
    }
  } finally {
    await page.close()
  }
}

/** Writes a capture to the untracked artifacts directory, which may hold game assets. */
export const saveArtifact = async (name: string, png: Buffer): Promise<void> => {
  await mkdir(ARTIFACTS, { recursive: true })
  await writeFile(new URL(`${name}.png`, ARTIFACTS), png)
}
