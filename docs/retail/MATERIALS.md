# Materials and shading in retail

What the original computes for a material: which class a material becomes, what that class sets on
the Direct3D 8 device, and the arithmetic the device then does. This library implements every
registered class ([COVERAGE.md](../COVERAGE.md)); this page holds the rules behind that code that
nobody should have to rediscover or "fix". The format itself (what a `Material library` or a slot's
flag word holds as bytes) is [`../freelancer/docs/modules/MATERIAL.md`](../../../freelancer/docs/modules/MATERIAL.md),
with textures in [TEXTURE.md](../../../freelancer/docs/modules/TEXTURE.md) and `MaterialAnim` in
[RIGID.md](../../../freelancer/docs/modules/RIGID.md).

Evidence marks: **checked** `module!0xADDR` was read in the retail binary; **decomp** names the
decomp's file and symbol, binary not read; **observed** names the reference scene whose capture or
screenshot shows it; **unsettled** says what is unknown. Addresses are retail VAs: `shading.dll` at
`0x6eb0000`, `flmaterials.dll` at `0x66f0000`, `rp8.dll` at `0x6d00000`, `deformable2.dll` at
`0x65f0000`, `Freelancer-original.exe` at `0x400000`. State tables are `{state, value}` pairs walked
in a loop, so a table's address is the reading.

There are no shaders in retail. A material is a `D3DMATERIAL8`, up to three texture stages, a
render-state table and a submit routine, and three classes also rewrite vertices on the CPU each
frame. Nothing in a material file records a blend mode, a cull mode, a draw order or any arithmetic:
all of it is the class's.

## Which class a material becomes

**The type a material records is not the type it draws with.** `FMaterialLibrary::CreateAfterMap`
(**checked** `shading!0x6ec9aa0`) copies the material's name and type into 64-byte buffers
(`strncpy` 0x40, so 63 characters), lowercases **the name only** (`_strlwr`, `0x6ec9afa`), and asks
`RemapType` for a new type. With no match it keeps the type as written (`0x6ec9b4d`). The result is
what `[BatchedMaterials]` is then tested against (`0x6ec9b73`) and what the factory is looked up by.

`[MaterialMap]` in `EXE/dacom.ini`:

- **One list, last listed wins.** `AddMapRule` inserts each rule at the front, and `RemapType`
  returns the first match (**decomp** `src/Shading/MaterialLibrary.cpp` `AddMapRule`, `RemapType`;
  the file's own comment says "evaluation of material map happens in reverse order listed"). Name
  rules do not outrank type rules as a class: retail lists its two type rules first, so its name
  rules happen to win. A mod listing a type rule after a name rule reverses that.
- **A line is a name rule only if the text before its first `=` is `name`**, compared without case,
  and it has a second `=`. Every other line is a type rule (**decomp** `LoadFromFileSystem`). So
  `Name= ^c_glass$ = …` is a name rule.
- **Patterns search, they do not anchor**, with Henry Spencer's `regexec`, case-sensitive
  (**decomp** `src/Shading/MaterialRegex.cpp`). A type rule `DcDtEcEt` matches anywhere in the
  type. Since the name is lowercased first, a name pattern with a capital letter never matches.
- **`deformable2.dll` adds one rule of its own**, in no INI: name `^eye*` to `EyeMaterial`
  (**checked** `deformable2!0x65fdfbb`, pattern string at `0x6602a68`). It is added after
  `dacom.ini`'s, so it is tried first, and it reaches rigid models too. As a regular expression it is
  `ey` followed by any number of `e`: it matches every name beginning `ey`.
- `[BatchedMaterials] Type = .*OcOt` is matched against the **mapped** type. See
  [batching](#ocot-batches-and-batching-reorders-draws).

[`src/material/map.ts`](../../src/material/map.ts) holds retail's table as data and takes a mod's
in its place.

**The type name selects a class and nothing more.** The four `DcDt*` names share one factory, as do
the four `*Two` names; nothing downstream reads the spelling. `Ec` and `OcOt` in a name do not decide
emission or blending, which [the values decide](#translucency-and-the-alpha-test). `OcOt` only
batches.

**An unregistered type draws nothing.** `MaterialLibrary` logs `Unable to create material '%s'` and
has no fallback class (**checked**, string `0x6ed50f4` pushed at `shading!0x6ecc49a`).
`DcDtEtTwo` and every `DcDtBt*` spelling are authored in retail and registered nowhere; `DcDtBt*`
reaches a class only through `^detailmap_` or `^nomad`. `EcEtOcOt` and `DcDtEcEt` exist only as map
sources (**decomp** `docs/re/shading.md`).

| Type names | Class | DLL |
| --- | --- | --- |
| `DcDt` `DcDtEc` `DcDtOcOt` `DcDtEcOcOt` | SinglePass | shading |
| `DcDtTwo` `DcDtEcTwo` `DcDtOcOtTwo` `DcDtEcOcOtTwo` | SinglePass, two-sided | shading |
| `DcDtEt` | DcDtEt | shading |
| `EcEt` `EcEtTwo` | EcEt | shading |
| `Nebula` `NebulaTwo` | Nebula | shading |
| `LightMap` | LightMap | shading |
| `BtDetailMapMaterial` `BtDetailMapTwoMaterial` | BtDetailMap | shading |
| `DetailMapMaterial` `DetailMap2Dm1Msk2PassMaterial` `Masked2DetailMapMaterial` `IllumDetailMapMaterial` | the planet surfaces | shading |
| `AtmosphereMaterial` | Atmosphere | shading |
| `NullMaterial` | draws nothing | shading |
| `NomadMaterial` `NomadMaterialNoBendy` | Nomad, one class | flmaterials |
| `GlassMaterial` `HighGlassMaterial` `GFGlassMaterial` | Glass, one class | flmaterials |
| `HUDIconMaterial` `HUDAnimMaterial` `ExclusionZoneMaterial` `PlanetWaterMaterial` | one class each | flmaterials |
| `EnvMapMaterial` `CloakMaterial` `ColorizeMaterial` `StarsphereMaterial` `BackdropMaterial` `ShadowMaterial` `WireMaterial` `WireMaterial2` `EngineGlowMaterial` `VisibleCounterMaterial` | engine overrides; a file can name some | flmaterials |
| `EyeMaterial` | its own | deformable2 |

## The colour record and the lit colour

The colour properties are the `D3DMATERIAL8` verbatim, handed to `SetMaterial` untouched: `Dc`
diffuse at `+0x20` with `Oc` its alpha at `+0x2c`, `Ac` ambient `+0x30`, `Sc` specular `+0x40`, `Ec`
emissive `+0x50`, `Sp` power `+0x60` (**checked** `SetMaterial` on `+0x20`, `shading!0x6ebd8c2`).
D3D8 then lights each vertex:

```
D     = the vertex colour, when the mesh has one; else (Dc, Oc)
lit   = saturate(Ec + Ac·ambient + Σ lights(D)),  alpha D.a          per vertex, D3D8's equation
stage0 = Dt × lit                                                   MODULATE(TEXTURE, DIFFUSE)
```

- **Setting `Dc` overwrites `Ac`.** The parameter setter copies all 16 bytes of diffuse over ambient
  whenever the key is exactly `Dc` (**checked** `shading!0x6eb2439`). `Ac` loads before `Dc` in every
  schema that has both (**decomp** `src/Shading/Material.cpp` `InitializeSinglePassPropertySchema`), so an
  authored `Ac` survives only on a material with no `Dc`. Both default to white.
- **`Ec` is inside the lit colour, so the texture multiplies it.** Stage 0 is
  `MODULATE(TEXTURE, DIFFUSE)` in colour and alpha (**checked** table `shading!0x6ed26dc`). Emission
  is tinted by `Dt`; it is not added after it.
- **Specular never draws.** Every class's render-state table sets `SPECULARENABLE 0` (**checked**
  `0x6ed26ac`, `0x6ed268c` and every table below). `Sc` and `Sp` are loaded and do nothing.
- **Vertex colour replaces `Dc` and `Oc`, it does not multiply them.** The bind turns
  `D3DRS_COLORVERTEX` on only when the draw's vertex source has a diffuse colour (**checked**
  `shading!0x6ebd8e3`) and off at teardown (`0x6ebda6b`). The device's `DIFFUSEMATERIALSOURCE` is
  `COLOR1` (**decomp** `src/RP8/RP8.cpp` state table; **observed** `li_elite`'s captured states).
  The alpha is replaced too, while the [blend decision](#translucency-and-the-alpha-test) still reads
  `Oc`, so a `DcDtOcOt` at `Oc` 0.5 over vertex colours blends at the vertex alpha. Retail's vertex
  colours all carry alpha 255, so only a mod shows it.
- **`AMBIENTMATERIALSOURCE` is `COLOR2`** (**decomp** RP8 table; **observed** `li_elite`), and no
  retail mesh carries a specular colour. What D3D8 reads for ambient then is **unsettled**; this
  library uses the material's `Ac`.
- **`NORMALIZENORMALS` is off** on the device (**decomp** RP8 table). A scaled model's normals reach
  the lighting at their scaled length, except while an [environment map](#environment-maps) is
  applied, which turns it on. `LOCALVIEWER` is off in `dacom.ini`, and only the environment map turns
  it on; with specular off, it matters to nothing else.
- **Unlit classes** (Nebula, LightMap, Nomad, Illum's second pass) set `LIGHTING 0`, so the diffuse
  is the vertex colour or white, and `Dc`, `Ac` and `Ec` are never read.

[`src/material/dcdt.ts`](../../src/material/dcdt.ts) is this equation and the stages below.

## Texture slots

Each slot is a name and a flag word, split at load into three fields (**checked**
`shading!0x6eb1512`, `0x6eb1630`) and applied at bind (**checked** `shading!0x6ebd908`–`0x6ebd943`):

| Bits | Field | Device state |
| --- | --- | --- |
| 0–1 | U address | `ADDRESSU = value + 1`: wrap, mirror, clamp, border |
| 2–3 | V address | `ADDRESSV = value + 1` |
| 4–7 | coordinate field | `TEXCOORDINDEX = field ≥ 4 ? field − 4 : 0` |

- **Bit 6 is the field's base, not a flag.** `0x40` samples UV0 and `0x50` UV1; a field of 0 to 3
  also samples UV0. The format library's `getMapIndex` is this rule.
- **Defaults when a slot has no flags**: field 4 (UV0), wrap both ways, for every ordinary slot
  (**decomp** the property schemas). Two differ: the nomad ramp's `nt_flags` defaults to field 5,
  **UV1**, which is where the nomad draw writes its ramp coordinate; and the atmosphere's `Dt`
  defaults to **clamp** both ways (**decomp** `src/flmaterials/MaterialImpl.cpp` nomad schema,
  `InitializeAtmospherePropertySchema`).
- **Addressing is set per stage at bind**, so two materials can sample one texture differently.
  Retail sets no mirror and no border; WebGL2 has no border.
- **A UV set the mesh has not got**: `TEXCOORDINDEX` stays 1 on a one-set vertex format. On the rig
  that samples a constant (0, 0), so the surface takes the texture's first texel (**observed**
  `bands_one_uv`). A real driver may differ: **unsettled**. 52 retail detail draws ask for it.
- **An empty stage**, a stage whose op reads a texture none is bound to, acts on the rig as if the
  stage were off (**observed** `dyson_door_shield`, `bands`). Whether a real D3D8 driver reads it as
  white instead is **unsettled**; see [VALIDATION.md](../VALIDATION.md#open-questions).
- **Textures are looked up, never loaded**, by name in the texture library, at verify. A material
  whose texture library loads after it binds nothing for that slot (**observed**: a nomad ramp binds
  only if `nomad_fx.txm` loaded first; [VALIDATION.md](../VALIDATION.md#open-questions)).

## Translucency and the alpha test

**Whether a draw blends is decided by values, not by the type name.** The shared post-load pass sets
two bytes (**checked** `shading!0x6eb21fb`–`0x6eb22a5`):

```
blend (+0x64)     = Oc < 1
                    or, at Oc = 1: Dt's device format has alpha other than one bit
alphaCut (+0x65)  = Oc = 1, and Dt's device format has exactly one alpha bit
```

The format table is `shading!0x6ed5230`, 0x4c bytes a row, alpha bits at `+0x38` and has-alpha at
`+0x48` (**checked**):

| Device format | Alpha bits | Result at `Oc` = 1 |
| --- | --- | --- |
| `DXT1`, `A1R5G5B5` | 1 | cut at half, no blend |
| `DXT2`–`DXT5` | (compressed range) | blend |
| `A8R8G8B8`, `A4R4G4B4` | 8, 4 | blend |
| `R8G8B8`, `X8R8G8B8`, `R5G6B5`, `X1R5G5B5`, `P8` | 0 | opaque |

- **`Oc < 1` returns before the format is read**, so a translucent material is never cut at half
  (`0x6eb221d`).
- **The format decides, not the pixels.** A 32-bit Targa uploads as `A8R8G8B8` (**decomp**
  `src/Shading/TextureLibrary.cpp`: Targa levels keep their pixel format) and blends even if every
  alpha is 255. A DXT1 is cut whether or not any block uses punch-through.
- **It is the device format**, after `rp8` picks a supported one. `FDirectX8::PopulateFormatCatalog`
  lists fallbacks per class: DXT1 to `A1R5G5B5` then `A4R4G4B4`, DXT2–5 to `A8R8G8B8` then
  `A4R4G4B4` (**decomp** `src/RP8/RP8.cpp`). On a device without DXT the decision mostly survives,
  except a DXT1 landing on `A4R4G4B4`, which blends.
- **A runtime `Oc` change through the setter re-decides** (`0x6eb24e5`, per the extension's reading;
  **unsettled**, not re-read). Writes straight into the record, as the HUD and exclusion overrides
  make, do not.

**The alpha test runs on every draw.** `[RenderPipeline]` in `dacom.ini` sets
`ALPHATESTENABLE true`, `ALPHAFUNC 5` (`GREATER`), `ALPHAREF 0` for the whole game, so a texel whose
alpha byte is 0 never draws, blended or not, and writes no depth.

- **SinglePass raises it to `0x80` for the cut case only.** Its submit saves the three states, sets
  `ALPHAREF 0x80`, `GREATER`, enabled, draws and restores (**checked** `shading!0x6ebda80`). It is
  the only class whose test depends on the texture. `GREATER 0x80` keeps an alpha byte of 129 and up.
- **A two-sided material's back faces are not cut.** `SinglePassTwo` restores the test before its
  second pass (**checked** `shading!0x6ebe086`–`0x6ebe0b9`, the second pass after).
- **Submit flag `0x400` skips the raise** (`0x6ebda98`); the cloak override passes it.
- The planet surfaces set fixed tests per pass ([below](#the-planet-surfaces)). Every other class
  runs under the device's.

## Per class

Stages are written `op(arg1, arg2)`. Unless a row says otherwise, stage 0 is
`MODULATE(TEXTURE, DIFFUSE)` in colour and alpha, stage 1 is `DISABLE`, cull is the device's
(back faces), depth is the device's.

| Class | Lighting | Blend | Stage 1 | Evidence |
| --- | --- | --- | --- | --- |
| SinglePass | on | `SRCALPHA/INVSRCALPHA` if `+0x64`, else none | off | **checked** `shading!0x6ebd8b0`, tables `0x6ed26ac`, `0x6ed268c`, `0x6ed2714` |
| DcDtEt | on | never | `ADD(Et, CURRENT)` colour, `MODULATE` alpha, only with an `Et` | **checked** `0x6eb61e0`, `0x6ed16cc`, `0x6ed1724`, `0x6eb62d8` |
| BtDetailMap | on | never | `MODULATE2X(Bt, CURRENT)` colour, `MODULATE` alpha, always | **checked** `0x6eb5100`, `0x6ed1484`, `0x6ed14dc`, `0x6eb51ef` |
| EcEt | on | `ONE/ONE` | off; stage 0 samples `Et` | **checked** `0x6eb8a40`, `0x6ed1c54` |
| Nebula | **off** | `SRCALPHA/ONE` | off | **checked** `0x6ebc600`, `0x6ed23cc` |
| LightMap | **off** | `DESTCOLOR/ZERO` | off; stage 0 `SELECTARG1(TEXTURE)`, `COLORVERTEX 0` | **checked** `0x6eba720`, `0x6ed206c`, `0x6ed20ac`, `0x6ed209c` |
| Atmosphere | on | `SRCALPHA/INVSRCALPHA` | off | **checked** `0x6eb2b40`, `0x6ed1100` |
| Glass | on | inside none, outside `SRCALPHA/INVSRCALPHA` | off | **checked** `flmaterials!0x66f7500`, `0x6701d1c` |
| Nomad | **off** | `SRCALPHA/INVSRCALPHA` | `ADD(nt, CURRENT)` colour, `MODULATE` alpha | **checked** `flmaterials!0x6702094`; **decomp** stages |
| HUDIcon | on | if alpha `< 1` or `+0x64` | off | **checked** `flmaterials!0x66f8133`, `0x6701ed4`, `0x6701ef4` |
| ExclusionZone | on, `AMBIENT` white | always | off | **checked** `flmaterials!0x66f6b6c` |
| PlanetWater | on | as SinglePass | off | **checked** `flmaterials!0x66f9ec8` (`ZWRITEENABLE 0`), `ZFUNC` set |

### SinglePass and its two-sided twin

- **`*Two` is two submissions, not culling off.** The second copies the vertices into a scratch
  buffer with **every normal negated** (**checked** three `fchs`, `shading!0x6ebe23a`) and draws
  again with the cull mode reversed through a table, none to none and CW to CCW (**checked**
  `0x6ed4848` = `{_, 1, 3, 2}`, used at `0x6ebe332`). Back faces are lit as front faces of the
  opposite normal. On a blended material they go down after every front face, rather than
  interleaved in index order. That copy is CPU work each frame; here it is a second pass with
  `negateNormals`.
- **`OcOt` names batch**; [below](#ocot-batches-and-batching-reorders-draws).

### DcDtEt and BtDetailMap

- **`Et` is added after the diffuse multiply**: `saturate(Dt × lit + Et)`, alpha `Dt.a × lit.a ×
  Et.a`. Not `(Ec + Et) × Dt` and not `max`. `DcDtEt` declares only `Dc`, `Dt` and `Et`, so an `Ec`
  or `Oc` on such a material is never loaded (**decomp** `InitializeDcDtEtPropertySchema`).
- **Stage 1 is applied only when the `Et` slot names a texture** and the class validated its second
  stage (**checked** `0x6eb62ca`–`0x6eb62dc`). Without `Et` it stays disabled, which leaves it free
  for an environment map.
- **`Bt` is `MODULATE2X`**: mid-grey is neutral. `BtDetailMap` applies it whenever validated,
  with or without a `Bt` (**checked** `0x6eb51ef`). It keeps SinglePass's whole parameter set, `Ec` and
  `Oc` included (**decomp** `InitializeBtDetailPropertySchema`), but never blends and has no alpha test
  of its own.
- **The `DcDtBt*` names only draw through the map.** 13 of 14 nomad entries and 430 of 434 detail
  entries are authored as a `DcDt*Bt*` spelling no DLL registers; without `[MaterialMap]` they vanish.

### Nebula, EcEt, LightMap

- **Nebula declares only `Dt`** (**decomp** `InitializeNebulaPropertySchema`, four records), and
  lighting is off: `Dt × vertex colour` (or white), blended `dst + colour × alpha`. A `Dc` or `Ec` on a
  Nebula material does nothing; retail carries 58 such `Ec`s.
- **EcEt draws `Et` lit and added**, `ONE/ONE`. Nothing in retail reaches it.
- **LightMap multiplies the frame buffer** by its texture, with `ZFUNC` 4 (`LESSEQUAL`) set for its
  draw alone (**decomp** `FMaterial::Submit`, `LAB_06eba860`). Nothing in retail reaches it.

### Glass

One class for three names (**checked** strings in `flmaterials`).

- **`Oc` is floored at 0.8.** The apply compares `Oc` with 0.8 and, below it, writes 0.8 over both
  `Oc` and the ambient alpha in the record itself (**checked** `flmaterials!0x66f7505`–`0x66f7524`,
  constant `0x670402c` = 0.8). Seven retail glass entries carry 0.79999995, just under it, and two
  carry 0.4; all draw at 0.8.
- **Inside opaque, then outside blended.** Pass 1 sets `CULLMODE 3` (CCW) with no blend, pass 2
  `CULLMODE 2` (CW) blended (**checked** `flmaterials!0x66f7650`, `0x66f771a`). With the game's
  default CW cull, pass 1 is the canopy's inside. Retail glass is nearly opaque lit `Dt × lit`.
- Glass samples its `Dt` like SinglePass. With no `Dt` stage 0 is empty; see [Open](#open).
- `RETAIL_FRAME_LIMITS.glassLeastAlpha` in [`src/scene/frame.ts`](../../src/scene/frame.ts) carries
  the 0.8 as a default a mod can override.

### HUD icons, exclusion zones, planet water

- **HUDIcon** asks the per-object service for an override and writes its alpha over `Oc` and its
  colour over `Ac` (**checked** `flmaterials!0x66f80f8`–`0x66f8120`). It then blends when that alpha
  is below 1 **or** the load-time blend byte `+0x64` is set (**checked** `0x66f8133`–`0x66f8148`), so a
  material whose own `Oc` or `Dt` format made it translucent stays blended whatever the override
  says. It changes no cull state: HUD geometry is not made two-sided.
- **ExclusionZone** saves `D3DRS_AMBIENT` and sets it to `0xffffffff` for its draw (**checked**
  `flmaterials!0x66f6b55`–`0x66f6b74`), takes the same override over `Ac` and `Oc` (`0x66f6b8d`),
  and always blends. So `Ac` reaches the lit colour unscaled: `Ec + Ac + D·lights`. The zone's colour
  is the engine's, and the material's own `Ac` (which is `Dc`) and `Oc` stand in where the service has
  none.
- **PlanetWater** is SinglePass plus its own `MaterialAnim`, drawn with `ZWRITEENABLE 0` and
  `ZFUNC` set for the draw (**checked** `flmaterials!0x66f9ec8`–`0x66f9efb`).
- **HUDAnim** is SinglePass with vertex colour and a `MaterialAnim` (**decomp**).

### The planet surfaces

All four draw pass A opaque, `Dt × lit` and then a mask at stage 1 with `MODULATE2X`. Each mask
samples **UV0 through a texture matrix** `diag(TileRate, TileRate)` with `TEXTURETRANSFORMFLAGS 2`
(**decomp** `BindDetailMapTables`, `SetDetailTileTransform`). `flip u` and `flip v` are loaded and
never read again (**decomp**: `DetailFlipU`, `DetailFlipV` are only initialised).

| Class | Pass A | Pass B, blended `SRCALPHA/INVSRCALPHA`, `ZFUNC 4` |
| --- | --- | --- |
| `DetailMapMaterial` | `Dt·lit·2·Dm`, device test | none |
| `DetailMap2Dm1Msk2PassMaterial` | `Dt·lit·2·Dm1`, `ALPHAREF 0xfe LESS` | `Dt·lit`, `ALPHAREF 1 GREATER` |
| `Masked2DetailMapMaterial` | `Dt·lit·2·Dm0`, `ALPHAREF 0xfe LESS` | `Dt·lit·2·Dm1`, `ALPHAREF 1 GREATER` |
| `IllumDetailMapMaterial` | `Dt·lit·2·Dm0`, **test off** | **unlit** `Dt·2·Dm1`, `ALPHAREF 1 GREATER`, `ZWRITEENABLE 0` |

**checked**: the `0xfe`/`LESS`, `1`/`GREATER` and `ZFUNC 4` sequences at `shading!0x6eb7808` and
`0x6ebbe99`; Illum's `ALPHATESTENABLE 0` (`0x6eba067`) then `1`, `ALPHAREF 1`, `GREATER`, `ZFUNC 4`,
`ZWRITEENABLE 0` (`0x6eba0bd`–`0x6eba122`).

- **The transition is continuous.** Each pass's alpha is what its own stages compute, `Dt.a`
  times the mask's alpha where stage 1 carries one, and B blends over A by it. A hard switch at some
  `Dt.a` reproduces only the end points. `DetailMap2Dm1Msk2Pass` reads `Dm1` for pass A, not `Dm`, as
  its name says (**observed** `bands_planet`).
- **Illum's pass A turns the device's test off**, so a texel at alpha 0 still draws there.
- Their bind is a no-op (`shading!0x6ec9560`): every pass writes stages 0 and 1 itself. A
  one-pass fallback exists for a device that fails validation.

### Atmosphere: UVs written on the CPU

Parameters `Ac`, `Dc`, `Dt`, `Fade` (default 1), `Alpha` (0.75), `Scale` (1.025) (**decomp**
`InitializeAtmospherePropertySchema`). The draw scales the mesh by `Scale`, writes every vertex's
UV from where the camera stands, and draws lit and blended with `ZWRITEENABLE 0`, `ZFUNC LESSEQUAL`.
With `r` the shell's radius, `R = r / Scale` the planet's, `d` the camera's distance from the centre,
`n` the unit vector toward the camera and `P` the vertex's **normal**:

```
t  = R · (Scale − 1)                      floored at 1e-7
k  = (d − r) / (d − r + t)                0 at the shell, toward 1 far away
u  = P·n ≥ r/d  ?  Fade · k³ · (P·n − r/d) / (1 − r/d)  :  0
v  = k³ < 0.5   ?  2 · (1 − Alpha) · k³                   :  1 − Alpha
```

**observed** `planet_earth`, `run1-stock-menu`, `bands_planet`: every vertex's UV.

- **`Fade` scales the lookup**; it is not an exponent or a gain. **`Alpha` picks the texture row**;
  it is not an opacity.
- `k³` fades both toward zero as the camera descends into the shell.
- The UVs come from the unscaled object; only the drawn mesh is scaled.

### Nomad: colour and UV written on the CPU

One class for both names. "Bendy" is a second clock that nothing reads, so the two draw alike
(**decomp** `bNomadRegular_`). Each frame the draw rewrites every vertex and draws with
`ZWRITEENABLE 0` and `CULLMODE NONE`:

```
d       = clamp(1 − fade, 0, 1)                         fade: the object's value, 1 when unset
diffuse = white, alpha byte = trunc((1 − (3 − 2d)·d²) · 255)
ratio   = (dot(axis, N) + 1) / 2                        axis: (0, 0, −1) in object space, one per draw
v       = 1 − fmod(time, 5) / 5                          time never moves: v = 1
colour  = saturate(Dt + nt(ratio, v).rgb),  alpha Dt.a · nt.a · diffuse.a
```

- **checked** `flmaterials!0x66f8c7a` (fade 1 unless the service has a value), `0x66f8cc3`–`0x66f8d87`
  (the smoothstep, `× 255`, `_ftol`, white `0xffffff`), `0x66f8d79`–`0x66f8d96` (`fmod` by 5.0 at
  `0x6704060`).
- **`Dc` is never read** (**decomp**), and lighting is off.
- **The ramp does not scroll.** The clock moves only by the delta given to the material update, and
  every caller in `Freelancer.exe` passes 0 (**observed** `no_fighter`: `v` exactly 1 on every vertex;
  [VALIDATION.md](../VALIDATION.md#open-questions) has the call sites).
- **`axis` is the camera's forward carried into object space**, pointing away from the eye, so a face
  turned to the camera samples the ramp at `u = 0`. One axis per draw, not a per-vertex eye vector
  (**observed** `no_fighter`: every written vertex).
- **The ramp is not in the material.** `nt_name` (lowercase in the schema) defaults to
  `NomadRGB1_NomadAlpha1` (**checked** string in `flmaterials`; **decomp** the schema), which lives in
  `SHIPS/NOMAD/nomad_fx.txm`. Its coordinate field defaults to 5, UV1, the set the draw writes.
- **Unvalidated device**: one stage, every vertex `0x0affe6` (teal) at half alpha (**checked**
  `0x66f8d27`–`0x66f8d52`).
- **On an environment-mapped object the surface is invisible.** `fade` and the environment
  override's cube name share one per-object slot, both read through `0x66fcec0`, so the name's pointer
  is read as a float near 0 (**checked** the shared lookup at `0x66f8ca3` and `0x66f5be1`;
  **observed** `bands`: vertices written `0x00ffffff`). No retail environment-mapped archetype has a
  nomad material.

## Environment maps

**Whether a model reflects is not in the model.** The archetype's `envmap_material` names a cube
texture; absent means none. `GameObject::render` installs the `EnvMapMaterial` override only when
all four hold (**checked** `Freelancer-original!0x539a6a`–`0x539ab4`):

1. the `use_environment_maps` performance option is above 0;
2. the object is in distance band 0: nearer than a positive `distance_render`, or none set;
3. the caller passed no override of its own: a cloaking object passes `CloakMaterial` and reflects
   nothing;
4. the name is non-empty.

Base rooms install it for their props and ships with the name hardcoded as `"envmapbasic"`, not the
archetype's (**checked** `Freelancer-original!0x44b1d8`, string `0x5cbfa0`). **The override wraps
every mesh group of every part**; the stage test below is the only filter.

The override's apply (**checked** `flmaterials!0x66f5af0`):

1. Run the wrapped material's apply. Note whether its class name hashes equal to `GlassMaterial`, the
   name all three glass types report (`0x66f5b7b`–`0x66f5b98`).
2. The cube: `envmapglass` on glass (`0x66f5bb9`, string `0x6701ad8`), else the stored name. It is
   looked up in the texture library: **already loaded or nothing**.
3. On glass, stop: the override's own draw handles it.
4. **The first free stage**: stage 0 or 1, whichever has `COLOROP DISABLE` (`0x66f5cd4`,
   `0x66f5cef`). If both are enabled, or no cube was found, nothing is added.
5. That stage `MODULATE2X(TEXTURE, CURRENT)` colour, `MODULATE` alpha; the next `DISABLE`; texture
   coordinates `TCI_CAMERASPACEREFLECTIONVECTOR` (`0x30000`); `LOCALVIEWER 1` and
   `NORMALIZENORMALS 1` (tables `0x67019c4`, `0x67019fc`; states at `0x66f5d68`–`0x66f5d97`).

What follows from that:

- **No intensity, no texture matrix.** No `TFACTOR`, no parameter: what the stage does is what the
  cube holds. With no texture matrix, the cube is indexed by the camera-space reflection vector as
  it stands, so a face of the cube is fixed to the screen, not the world. In D3D's left-handed camera
  space, which is why [`dcdt.ts`](../../src/material/dcdt.ts) flips the vector's z.
- **`envmapbasic` is almost neutral.** Five faces are flat 127, `2·127/255` under `MODULATE2X`; only
  where the reflection points up the screen does it brighten. Both retail cubes are opaque, so alpha
  is unchanged.
- **Which classes reflect is which leave stage 1 free**: SinglePass and its `*Two` (both passes, the
  second with its negated normals), EcEt, Nebula, LightMap, Atmosphere, HUDIcon, HUDAnim,
  ExclusionZone, PlanetWater, and `DcDtEt` with no `Et`. Not `DcDtEt` with an `Et`, BtDetailMap,
  `DetailMapMaterial` or Nomad. The two-pass planet surfaces rewrite their stages in every pass, so the
  stage is lost, while `NORMALIZENORMALS` stays on.
- **Glass reflects on its outside pass only.** The override replaces glass's draw: inside at
  `CULLMODE 3`, unblended, no environment stage; outside at `CULLMODE 2` with the stage and blended
  (**checked** `flmaterials!0x66f5e18`, `0x66f5ee1`, `0x66f5f45`–`0x66f5fee`).
- **`OcOt` types lose it**; next section.

## `OcOt` batches, and batching reorders draws

`[BatchedMaterials] Type = .*OcOt` wraps every type containing `OcOt`, `*Two` included, in
`BatchedMaterial`. On its first successful verify the wrapper picks a bin from the inner class's
translucency flag: **bin 1 if it blends, bin 0 if not** (**checked** `shading!0x6eb4116`–`0x6eb4138`).
The batcher creates bin 0 with key −1 and bin 1 with key 1 (**checked** `shading!0x6ec8b49`,
`0x6ec8b92`), and its submit queues a draw only when the selected bin's key is ≥ 0 (**checked**
`0x6ec9589`):

- **Bin 0, opaque**: submitted at once. The immediate path binds the inner material again, which
  disables stage 1 over the environment stage (`0x6ec95bc`; **decomp** `FMaterialBatcher::Submit`). `NORMALIZENORMALS` stays on. No
  environment-mapped retail ship has such a draw, so this stands as read and uncaptured.
- **Bin 1, blended**: queued and drawn at the flush, sorted back to front (`Bin1SortOrder` 2;
  **decomp** `src/Shading/MaterialBatcher.cpp`). By then the environment override is gone, so neither
  the stage nor normalized normals (**observed** `ku_dragon`).

So **only `OcOt`-named blended draws are depth-sorted.** A `DcDt` blending over a DXT5 draws in place,
in hierarchy order. The `^alpha_mask` rules exist to keep their materials out of the wrapper, as their
comment in `dacom.ini` says: "we arent using alpha for blending -- just for masking".

## Material UV animation

A `MaterialAnim` drives one material's texture matrix on **stage 0 only**, with
`TEXTURETRANSFORMFLAGS 2` (**checked** `shading!0x6ebd9ff`, reset at teardown `0x6ebda41`). Classes
that ask for one: SinglePass and its twin, HUDAnim, PlanetWater.

**The matrix** (**checked** `shading!0x6ec7330`): identity, then, with `k` the key the segment starts
from and `w` its velocities over the time `t` into the segment,

```
m[0][0] = 1 + k.uScale + w.uScale·t       m[0][2] = k.uOffset + w.uOffset·t
m[1][1] = 1 + k.vScale + w.vScale·t       m[1][2] = k.vOffset + w.vOffset·t
```

so `uv' = uv · scale + offset`, the offset reaching a 2D coordinate after `rp8` transposes the matrix
into D3D's row-vector form (**observed**: `character_eyes` captures the same path's offset in the
third row). Librelancer's `(uv + offset) · scale` agrees only at scale 1.

- **Stored scales are displacements from 1.** Neutral is four zeros. Reading them as absolute
  scales collapses every animated surface onto one texel.
- **A segment starts at the previous key**, or at four zeros for segment 0 (`0x6ec7390`–`0x6ec73c3`).
  Velocities are rates within the segment; nothing carries across a boundary, so a segment may end
  away from where the next starts, and the game jumps there.
- **The advance** (**checked** `shading!0x6ec72a0`) ignores a delta ≤ 0, adds the delta to the time
  in the segment, and while that is **strictly** past the segment's duration subtracts it and moves
  on, **always wrapping** to segment 0 past the last. An animation whose segments all last 0 never
  leaves that loop: the game hangs, which only a mod can reach.
- **The clock**: `Freelancer.exe` advances every instance once a frame by the frame's `dt`, through the
  library's advance-all with index −1 (**checked** `Freelancer-original!0x41b300`;
  `shading!0x6ec7430` walks every instance). An instance starts at 0 when its material loads. No
  scene event starts or stops one.
- **`MAFlags` is stored and never read** (**decomp** `src/Shading/MaterialAnimation.cpp`): the loop
  is unconditional.

[`src/scene/uv-animation.ts`](../../src/scene/uv-animation.ts) samples it.

## The fixed-function arithmetic

Retail's colour math is D3D8's, and a shader that drops any of these draws a different picture.

- **The lit colour saturates per vertex**, before it is interpolated or meets a texture.
- **Each stage saturates.** `MODULATE2X` is `min(2·a·b, 1)`, `ADD` is `min(a + b, 1)`.
- **Alpha is compared as a byte.** `ALPHAREF` is 0 to 255; `GREATER 0x80` passes 129 and up,
  `LESS 0xfe` passes 253 and down.
- **CPU-written colours are `D3DCOLOR` bytes.** The nomad alpha is truncated by `_ftol`, not rounded
  (**checked** `flmaterials!0x66f8d71`).
- Fog, where a nebula sets it, applies after the stages and never to alpha.

## What reimplementations get wrong

MAXLancer's `shaders/*.fx` and Librelancer's shaders disagree with each other and with the DLLs.
Where a reading here differs from either, it is not a typo:

| Commonly drawn | Retail |
| --- | --- |
| `OcOt` in the name decides blending | `Oc < 1` or the `Dt` format; the name batches |
| Alpha test `> 0` on opaque draws only | `> 0` on every draw; `> 0x80` for SinglePass over a one-bit `Dt` at `Oc` 1 |
| `(Ec + Et) × Dt`, or `max(colour, Et)` | `Dt × lit + Et`, no `Ec` |
| BtDetailMap without `Ec`, alpha-tested | keeps `Ec`, no test of its own |
| `Dc × vertex colour` | vertex colour replaces `Dc` and `Oc` |
| `Ac` used when present | overwritten by `Dc` |
| Nebula lit, reading `Dc` | unlit, `Dt` only |
| Nomad scrolling, per-vertex eye, `Dc` multiplied | still, one camera axis, `Dc` unread |
| Glass untextured, blended at `Oc` | `Dt × lit` at `max(Oc, 0.8)`, inside then outside |
| HUD forced two-sided | no cull change |
| `*Two` as culling off | two submissions, normals negated |
| Planet `flip u`/`flip v` as `1 − uv` | ignored |
| Planet two-pass as a hard switch | continuous, fixed tests per pass |
| Atmosphere `u = N·V`, `Fade` an exponent, `Alpha` an opacity | as above |
| Material animation `(uv + offset) · scale` | `uv · (1 + scale) + offset` |
| `DcDtEtTwo`, unmapped `DcDtBt` drawn as something | nothing |

## Open

- **An empty texture stage on a real driver.** The rig reads it as off; D3D8 may read it as white.
  This decides whether retail glass, which has an empty stage 0 under its environment stage, reflects:
  the capture binds `envmapglass` and the rig's screenshot shows no reflection.
  [VALIDATION.md](../VALIDATION.md#open-questions) has the experiment.
- **A UV set the vertex format lacks**, on a real driver: the rig samples (0, 0).
- **Ambient under `AMBIENTMATERIALSOURCE COLOR2`** with no specular colour in the vertex.
- **Device depth function.** `dacom.ini` has `zfunc = 4` (`LESSEQUAL`), yet the captures record
  `LESS` for ordinary draws, and LightMap, PlanetWater and the planet passes set 4 for themselves.
  Why the key does not take is unread.
- **`BtDetailMap`'s V address.** The decomp reads the schema's fourteenth record, `Bt_flags` V
  address, as written past its 13-record table into the atmosphere's (`InitializeBtDetailPropertySchema`,
  `AssignOverlappingZeroAddressMode`), which would leave `Bt`'s V address at wrap whatever the flags
  say. Retail's `Bt` flags never set it, so nothing shows it; not checked in the binary.
- **Who fills the per-object values** (HUD and exclusion overrides, nomad fade) is in
  `Freelancer.exe` and unread.
- `use_environment_maps`: where the game reads `[PerfOptions]` from, and its value when absent. The
  lab's captures show the stage applied (`li_elite`, `prison`).

## Corrections

To `freelancer-vscode/docs/renderer/MATERIALS.md` and `MATERIALS-DLL.md`:

- **"alpha test (`+0x65`) = the `Dt` format has exactly one alpha bit."** Only at `Oc` = 1: the
  post-load pass returns after setting the blend byte when `Oc < 1`, before the format is read
  (`shading!0x6eb221d`). A translucent `DcDtOcOt` over DXT1 is blended and not cut.
- **"The two SinglePass classes raise the reference to `0x80`."** Only for the front faces. The
  two-sided class restores the device's test before its second pass (`shading!0x6ebe086`–`0x6ebe0b9`),
  so back faces are tested at 0.
- **"The wrapper's order is stored as −1 (`0x6ec8b49`), so every `OcOt` draw submits immediately."**
  `0x6ec8b49` is bin 0's key. The wrapper chooses its bin at first verify from translucency
  (`0x6eb4133`): opaque `OcOt` draws submit at once and rebind over the stage; blended ones go to bin 1,
  queued and sorted back to front, and draw after the environment override is gone. The conclusion,
  that `OcOt` loses the environment stage, stands; the mechanism and the draw order do not.
- **"HUDIcon blends only when that alpha is below 1."** It also blends when the load-time byte
  `+0x64` is set, from the material's own `Oc < 1` or an alpha-carrying `Dt` format
  (`flmaterials!0x66f8143`).
- **"`DcDtEt` takes stage 1, so no environment map."** Only when its `Et` slot names a texture
  (`shading!0x6eb62d8`). Without one, stage 1 stays free and the environment stage goes there.
- **"52 detail draws asking for a second UV set fall back to UV0."** `TEXCOORDINDEX` stays 1; the rig
  samples a constant (0, 0) (`bands_one_uv`). Neither is settled for a real driver.
- **"The nomad `fade` is 1 unless the engine says otherwise."** True without an environment map. On an
  environment-mapped object the slot holds the cube name's pointer and the surface draws invisible
  (`bands`).
- **"Vertex colour replacing `Dc` is inferred, one step untraced."** The captured states show
  `COLORVERTEX` with `DIFFUSEMATERIALSOURCE COLOR1` (`li_elite`). It also replaces `Oc`.
