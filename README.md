# @treewyrm/freelancer-webgl2

TypeScript library rendering **Freelancer** (Digital Anvil, 2003) through WebGL2, aiming for the
picture the game draws. Built on [`@treewyrm/freelancer`](https://www.npmjs.com/package/@treewyrm/freelancer),
which reads and writes the game's assets, and written primarily for `freelancer-vscode`.

**Status: scaffold.** The package builds and the GPU test harness works; nothing of the game is
rendered yet. The public surface is `createContext` and `createProgram`.

Not affiliated with or endorsed by Digital Anvil or Microsoft. No game data ships in this package:
the host supplies the bytes of its own install.

## Use

```ts
import { createContext } from '@treewyrm/freelancer-webgl2'

const gl = createContext(canvas, { antialias: false })
```

The library needs WebGL2 and `WEBGL_compressed_texture_s3tc`. It never touches a filesystem or a
network, and imports without a DOM.

## Develop

```sh
npm install
npx playwright install chromium   # once, for the GPU tests
npm test                          # pure tests
npm run test:gpu                  # headless Chromium on the hardware GPU
npm run build
```

See [CLAUDE.md](CLAUDE.md) for the sources, rules and layout, and [docs/PLAN.md](docs/PLAN.md) for the
route from here.
