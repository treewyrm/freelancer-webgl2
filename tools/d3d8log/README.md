# d3d8log — a proxy `d3d8.dll` that writes what Freelancer draws

Copied from `freelancer-testing/tools/d3d8log`, where it was written for the Alchemy lab.

Freelancer is Direct3D 8, fixed-function, and builds its particle quads on the CPU. So the four
corners of every sprite, in metres, are in a vertex buffer that passes through this DLL — which
turns `BasicApp_Size` into a subtraction and `BasicApp_MotionBlur`'s roll into an `atan2`.

Why a shim rather than a frame debugger: see
`freelancer-vscode/docs/renderer/ALCHEMY-LAB.md`, "Instrumented capture".
Short version — the game is a 32-bit x86 binary under emulation on Windows-on-ARM, rendering through
a paravirtual GPU. This sits above all of it, inside the game's own process, and does not care what
is underneath.

## Build

Cross-compiled on macOS; nothing is needed inside the guest.

```sh
brew install mingw-w64
make                                    # → build/d3d8.dll, 32-bit
FL=/path/to/Freelancer/EXE make install  # + the default d3d8log.ini, if absent
```

`FL` is the directory holding `Freelancer.exe`, reached over a Parallels shared folder. The game
loads `d3d8.dll` from there before the system one; this forwards every export to
`C:\Windows\System32\d3d8.dll` and wraps what comes back. **Deleting the DLL is the uninstall** —
nothing else is touched.

## Capture

Press **F9** in game. Three frames land in `d3d8log.jsonl` beside the executable, with the last one's
front buffer in `d3d8log.f<frame>.bmp`, then it goes quiet until the next press. Everything is configurable in `d3d8log.ini`, which is read once at startup.

`all_draws = 1` logs every draw in the frame. The reader arrives in M0 of
[docs/PLAN.md](../../docs/PLAN.md), as `src/capture/`.

## What it wraps, and what it deliberately does not

| Interface                | Why                                                                        |
| ------------------------ | -------------------------------------------------------------------------- |
| `IDirect3D8`             | To hand back a wrapped device                                              |
| `IDirect3DDevice8`       | State, draws, and the frame boundary at `Present`                          |
| `IDirect3DVertexBuffer8` | **The reason this exists** — see below                                     |
| `IDirect3DIndexBuffer8`  | The same, for the triangles                                                |
| textures                 | **Not wrapped.** Described and hashed by asking the texture itself         |

**Vertex data is taken at the buffer, not at the draw.** A dynamic vertex buffer is created
`WRITEONLY`, and locking one for _reading_ is undefined — the driver may hand back anything, and on
a virtual GPU translating to Metal, quite possibly does. So each buffer keeps a shadow copy, filled
from the game's own mapped pointer between its `Lock` and `Unlock`. That memory is this process's
own and holds exactly what the game just wrote.

**Everything else is read back with `Get*` at each captured draw**, rather than shadowed from the
`Set*` calls. So state set before the key press, or never set, is still the true value, and nothing
can drift. It needs a non-pure device, which RP8 asks for by default; `behaviour` on the `device`
line records it (`0x40` is plain hardware vertex processing).

**Textures are identified by content.** RP8 creates its textures in `D3DPOOL_MANAGED` (`RP8.cpp:4024`),
so a read-only lock is legal and changes nothing. Each is hashed once per capture, one hash per mip
level, over tightly packed rows, so a dropped top level can still match. A level that can't be locked
hashes to `null`. The hash is CRC-32 followed by FNV-1a, both 32-bit, to stay cheap in JavaScript.

The device wrapper is a class deriving from `IDirect3DDevice8`, so **the compiler checks it**: a
method missed or a signature mistyped is a build error, not a call landing on the wrong vtable slot
at runtime. Ninety-odd one-line forwards is the price, paid once.

## Output

JSONL, one object per line. `i` is the frame, and `n` the number of draws so far in that frame, which
places a `clear`, `scene`, `target` or `copy` among the draws.

```jsonc
{"ev":"open","exe":"...","time":"2026-08-03T14:00:00","key":120,"frames":3,"verts_max":64}
{"ev":"device","w":1024,"h":768,"windowed":0,"behaviour":"0x00000040","backBuffer":22,"depth":75,
 "samples":0,"adapter":"...","caps":{"maxBlendStages":8,"maxTextures":8,"maxLights":8,...}}
{"ev":"scene","i":1042,"n":0,"at":"begin"}
{"ev":"clear","i":1042,"n":0,"flags":3,"colour":"0x00000000","z":1,"stencil":0,"rects":0,
 "viewport":[0,0,1024,768,0,1]}
{"ev":"texture","p":"0x0a1b2c3d","levels":9,"type":"2d","w":256,"h":256,"fmt":827611204,"usage":0,
 "pool":1,"hash":["1234abcd5678ef01",...]}
{"ev":"draw","i":1042,"n":7,"call":"DrawIndexedPrimitive","prim":"trilist","prims":2,"verts":4,
 "indices":6,"minIndex":0,"startIndex":0,"baseVertex":0,"fvf":"0x00000142","ps":"0x00000000",
 "stride":24,"rs":{"ZENABLE":1,...},"world":[...16],"view":[...16],"proj":[...16],
 "viewport":[0,0,1024,768,0,1],"material":{"diffuse":[1,1,1,1],...,"power":0},
 "lights":[{"index":0,"type":3,...}],"stages":[{"texture":"0x0a1b2c3d","COLOROP":4,...},...],
 "idx":[0,1,2,0,2,3],"pos":"model","v":[{"p":[-2.5,-2.5,0],"d":"0xffffffff","t0":[0,1]},...]}
{"ev":"frame","i":1042,"draws":317}
{"ev":"shot","i":1044,"red":[...256],"green":[...256],"blue":[...256],"file":"d3d8log.f1044.bmp",
 "w":1024,"h":768}
```

- **`rs`** holds every D3D8 render state under its `D3DRS_` name, and each entry of **`stages`** every
  texture stage state under its `D3DTSS_` name, always for all eight stages. Float states print as
  floats, everything else as an integer. A stage's `transform` appears only when
  `TEXTURETRANSFORMFLAGS` is on.
- **`lights`** lists only enabled lights. `clip` appears only when clip planes are on.
- **`shot`** comes after the last frame of a capture. The gamma ramps are recorded because the picture
  may or may not include them, and a comparison has to know. On failure it has `hr` instead of `file`.
- **`idx`** stops at 1024 entries; `indices` is the true count.
- **`pos`** is `model` or `screen`: a `D3DFVF_XYZRHW` vertex is already in screen space.
- **Matrices are row-major and apply to row vectors**: `p * M`, translation in the last row.
- **Numbers carry nine significant digits**, which round-trips a float32.
- A line too long for the buffer is written as `{"ev":"truncated"}`, never as broken JSON.

## Known limits

- **Single-threaded, unsynchronised.** Freelancer renders on one thread and this assumes it. A
  multi-threaded caller would interleave lines.
- **`SetStreamSource` static-casts to the proxy type**, on the basis that every vertex buffer in the
  process came from `CreateVertexBuffer` here. True for a plain D3D8 game; not defended against.
- **Textures are hashed once per capture**, and held until it ends so an address can't be reused. A
  texture changed during those frames keeps its first hash.
- **Volume textures aren't hashed.** RP8 doesn't appear to use them.
- The DLL is ~2 MB because libgcc and libstdc++ are linked statically, so it drops into a game
  directory alone.
