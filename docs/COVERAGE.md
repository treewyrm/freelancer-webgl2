# Coverage

Where each material stands. Update when evidence moves. **A row only moves on evidence**: "picture
matched" means a named reference scene, not that it looks right.

- **Read**: source read, and what it computes is understood.
- **Built**: implemented, with pure and GPU tests.
- **State**: matches a retail capture in a reference scene.
- **Picture**: matches a screenshot within tolerance.

`bands` is a generated sphere: it shows what a class does, not how retail's assets using it look.

**Draws** counts mesh draws in retail by the type they're shaded as, after `[MaterialMap]`, from
`freelancer-vscode/docs/renderer/MATERIALS.md`. Not re-measured here; M3's corpus suite will confirm
it. Sphere materials aren't counted there. The nine `DcDt` rows hold 21,153 of the 22,635 draws (93%).

## Rigid models (M1, M3)

| Type | Draws | Read | Built | State | Picture |
| ---- | ----: | ---- | ----- | ----- | ------- |
| `DcDt` | 15,016 | Yes | Yes | `li_elite`, `li_elite_turned`, `ku_dragon`, `prison` | `li_elite`, `li_elite_turned`, `ku_dragon`, `prison` |
| `DcDtEc` | 3,200 | Yes | Yes | `prison` | `prison` |
| `DcDtEt` | 1,334 | Yes | Yes | `prison`, `lair_core` | `prison`, `lair_core` |
| `DcDtTwo` | 522 | Yes | Yes | `li_elite`, `li_elite_turned` | `li_elite`, `li_elite_turned` |
| `DcDtOcOt` | 484 | Yes | Yes | `ku_dragon`, `prison`, both blended | `ku_dragon`, `prison` |
| `DcDtEcOcOtTwo` | 318 | Yes | Yes | `bands` | `bands` |
| `DcDtEcOcOt` | 179 | Yes | Yes | `bands` | `bands` |
| `DcDtOcOtTwo` | 78 | Yes | Yes | `lair_core`, `lair`, blended | `lair_core`, `lair` |
| `DcDtEcTwo` | 22 | Yes | Yes | `bands` | `bands` |
| `BtDetailMapMaterial` | 845 | Yes | Yes | `prison`, `lair_core` | `prison`, `lair_core` |
| `BtDetailMapTwoMaterial` |  | Yes | Yes | `bands` | `bands` |
| `HUDIconMaterial` | 195 | Yes | Yes | `bands` | `bands` |
| `HighGlassMaterial` | 113 | Yes | Yes | `li_elite`, `li_elite_turned` | Open: [VALIDATION.md](VALIDATION.md#open-questions) |
| `GlassMaterial`, `GFGlassMaterial` |  | Yes | Yes | `bands` | `bands` |
| `NomadMaterialNoBendy` | 30 | Yes | Yes | `no_fighter`, `dyson_door_shield` | `no_fighter`, wider tolerance; `dyson_door_shield`, no ramp |
| `NomadMaterial` |  | Yes | Yes | | |
| `HUDAnimMaterial` | 26 | Yes | Yes | `bands` | `bands` |
| `ExclusionZoneMaterial` | 20 | Yes | Yes | `bands` | `bands` |
| `PlanetWaterMaterial` | 4 | Yes | Yes | `bands` | `bands` |
| `EcEt`, `EcEtTwo`, `LightMap` | 0 | Yes | Yes | `bands` | `bands` |
| `NullMaterial` | | | | | |

`DcDtBt` and `DcDtEtTwo` are authored in retail, but no DLL registers them, so they draw nothing.

## Engine overrides (M3, M7, M8)

No file names these; the engine applies them.

| Type | Milestone | Read | Built | State | Picture |
| ---- | --------- | ---- | ----- | ----- | ------- |
| `EnvMapMaterial` | M3 | Yes | Yes | `li_elite`, `ku_dragon`, `prison` | `li_elite`, `prison` |
| `ColorizeMaterial` | M10 | | | | |
| `CloakMaterial` | M3 | Yes | Yes | | |
| `WireMaterial` | M10 | | | | |
| `WireMaterial2` | M3, untested as a `Type` | | | | |
| `EngineGlowMaterial` | M3, a mod can name it | Yes | Yes | `bands` | `bands` |
| `StarsphereMaterial` | M4 | Yes | Yes | `starsphere_li01`, `starsphere_st03b`, `starsphere_ew05`, `starsphere_ew06` | The same four, `starsphere_ew05` at a wider tolerance |
| `BackdropMaterial` | M4, M8 | Yes | Yes | | |
| `ShadowMaterial` | M8; crashes as a `Type` | | | | |
| `VisibleCounterMaterial` | M7; crashes as a `Type` | | | | |

## Spheres and sky (M4)

| Type | Read | Built | State | Picture |
| ---- | ---- | ----- | ----- | ------- |
| `DetailMapMaterial` | Yes | Yes | `bands_planet`, `run1-stock-menu` | `bands_planet` |
| `DetailMap2Dm1Msk2PassMaterial` | Yes | Yes | `bands_planet` | `bands_planet` |
| `IllumDetailMapMaterial` | Yes | Yes | `bands_planet`, `run1-stock-menu` | `bands_planet` |
| `Masked2DetailMapMaterial` | Yes | Yes | `bands_planet`, `planet_earth` | `bands_planet`, `planet_earth` |
| `AtmosphereMaterial` | Yes | Yes | `bands_planet`, `run1-stock-menu`, `planet_earth`, each vertex's UV | `bands_planet`, `planet_earth` |
| `Nebula`, `NebulaTwo` | Yes | Yes | `bands`, `starsphere_li01`, `starsphere_ew05`, `starsphere_ew06` | The same, `starsphere_ew05` at a wider tolerance |

## Other (M5, M6)

| Type | Milestone | Read | Built | State | Picture |
| ---- | --------- | ---- | ----- | ----- | ------- |
| `EyeMaterial` | M5 | Yes | Yes | `character_reed`, `character_eyes` | `character_reed`, `character_eyes` |
| Skinned `DcDt` | M5 | Yes | Yes | `character_reed` | `character_reed` |
| Alchemy appearances | M6 | Partly; see [ADAPTING.md](ADAPTING.md#alchemy-m6) | | | |
