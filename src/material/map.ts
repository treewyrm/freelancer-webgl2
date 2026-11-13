/** Which class a material is shaded as: `[MaterialMap]` in `EXE/dacom.ini`, then what is registered. */
import type { Material } from '@treewyrm/freelancer/material'

export interface MaterialMapRule {
  on: 'name' | 'type'
  pattern: RegExp
  to: string
}

const type = (pattern: RegExp, to: string): MaterialMapRule => ({ on: 'type', pattern, to })
const name = (pattern: RegExp, to: string): MaterialMapRule => ({ on: 'name', pattern, to })

/**
 * Retail's section, in file order. `shading.dll` matches with Spencer's regular expressions, which
 * search rather than anchor (`0x6ed0540`), and these patterns mean the same in JavaScript. So a type
 * rule's plain text matches anywhere in the type. A host with a mod's `dacom.ini` passes its own rules
 * as `SceneModel.materialMap`: JavaScript's patterns are a superset, and how a mod's unusual pattern
 * differs under Spencer's engine is unmeasured.
 */
export const MATERIAL_MAP: readonly MaterialMapRule[] = [
  type(/EcEtOcOt/, 'DcDtOcOt'),
  type(/DcDtEcEt/, 'DcDtEt'),
  name(/^alpha_mask.*/, 'DcDt'),
  name(/^alpha_mask.*2side/, 'DcDtTwo'),
  name(/^detailmap_.*/, 'BtDetailMapMaterial'),
  name(/^tlr_material$/, 'NebulaTwo'),
  name(/^tlr_energy$/, 'NebulaTwo'),
  name(/^nomad.*$/, 'NomadMaterialNoBendy'),
  name(/^n-texture.*$/, 'NomadMaterialNoBendy'),
  name(/^ui_.*/, 'HUDIconMaterial'),
  name(/^exclusion_.*/, 'ExclusionZoneMaterial'),
  name(/^c_glass$/, 'HighGlassMaterial'),
  name(/^cv_glass$/, 'HighGlassMaterial'),
  name(/^b_glass$/, 'HighGlassMaterial'),
  name(/^k_glass$/, 'HighGlassMaterial'),
  name(/^l_glass$/, 'HighGlassMaterial'),
  name(/^r_glass$/, 'HighGlassMaterial'),
  name(/^planet.*_glass$/, 'GFGlassMaterial'),
  name(/^bw_glass$/, 'HighGlassMaterial'),
  name(/^o_glass$/, 'HighGlassMaterial'),
  name(/^anim_hud.*$/, 'HUDAnimMaterial'),
  name(/^sea_anim.*$/, 'PlanetWaterMaterial'),
  name(/^null$/, 'NullMaterial'),
]

// `deformable2.dll` adds this itself, in no `dacom.ini` (`BindEyeMaterials`, `0x65fdfbb`). So it reaches
// rigid models too, 14 retail materials of them. That it outranks the file's is read as it being added
// later, and nothing retail tells the two apart. As a pattern it means `ey`, then any number of `e`.
const EYE_RULE = /^eye*/

// `FMaterialLibrary::CreateAfterMap` (`0x6ec9aa0`) copies both into 64 bytes.
const FIELD_LENGTH = 63

/**
 * The type a material is created as. Each rule is added at the front, so the last listed wins
 * (`FMaterialLibrary::AddMapRule`, `RemapType`). Only the name is lowercased (`_strlwr`, `0x6ec9afa`).
 */
export const mapMaterialType = (
  { name, type }: Pick<Material, 'name' | 'type'>,
  rules: readonly MaterialMapRule[] = MATERIAL_MAP,
): string => {
  const lowered = name.slice(0, FIELD_LENGTH).toLowerCase()
  const original = type.slice(0, FIELD_LENGTH)

  if (EYE_RULE.test(lowered)) return 'EyeMaterial'

  for (let at = rules.length - 1; at >= 0; at--) {
    const rule = rules[at]!
    if (rule.pattern.test(rule.on === 'name' ? lowered : original)) return rule.to
  }

  return original
}

/** The factories of `shading.dll` (`src/Shading/Shading.cpp`), `flmaterials.dll` and `deformable2.dll`. Case matters. */
export const REGISTERED_TYPES: ReadonlySet<string> = new Set([
  'DcDt',
  'DcDtEc',
  'DcDtOcOt',
  'DcDtEcOcOt',
  'DcDtTwo',
  'DcDtEcTwo',
  'DcDtOcOtTwo',
  'DcDtEcOcOtTwo',
  'DcDtEt',
  'EcEt',
  'EcEtTwo',
  'AtmosphereMaterial',
  'Nebula',
  'NebulaTwo',
  'NullMaterial',
  'LightMap',
  'DetailMapMaterial',
  'DetailMap2Dm1Msk2PassMaterial',
  'IllumDetailMapMaterial',
  'Masked2DetailMapMaterial',
  'BtDetailMapMaterial',
  'BtDetailMapTwoMaterial',
  'NomadMaterial',
  'NomadMaterialNoBendy',
  'HUDIconMaterial',
  'HUDAnimMaterial',
  'ColorizeMaterial',
  'CloakMaterial',
  'WireMaterial',
  'WireMaterial2',
  'ExclusionZoneMaterial',
  'GlassMaterial',
  'HighGlassMaterial',
  'GFGlassMaterial',
  'EnvMapMaterial',
  'BackdropMaterial',
  'StarsphereMaterial',
  'ShadowMaterial',
  'EngineGlowMaterial',
  'VisibleCounterMaterial',
  'PlanetWaterMaterial',
  'EyeMaterial',
])
