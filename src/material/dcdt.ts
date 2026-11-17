/**
 * `DcDt` and its kin: D3D8's fixed-function lighting per vertex, then its texture stages.
 * Sources: `src/Shading/Material.cpp`, `FMaterialImpl::BindEnvMap`; the arithmetic is D3D8's own.
 */
import { Matrix4 } from '@treewyrm/freelancer/math'
import { createProgram, type Program } from '#/gl/program.js'
import { ATTRIBUTE_LOCATIONS } from '#/mesh/plan.js'
import { MAX_BONES } from '#/deformable/skin.js'
import type { Draw, Frame, SceneLight } from '#/scene/frame.js'
import { FOG_GLSL, FOG_UNIFORMS, setFog } from './fog.js'

/** Retail lights a model with at most four (library `THORN.md`, `lt_grp`). */
export const MAX_LIGHTS = 4

// `D3DTOP_ADD` for `DcDtEt` (`0x6ed1724`), `D3DTOP_MODULATE2X` for `BtDetailMapMaterial` (`0x6ed14dc`).
const SECOND_STAGE = { none: 0, add: 1, modulate2x: 2 } as const

const ALPHA_FUNCTION = { always: 0, greater: 1, less: 2 } as const

const VERTEX = `#version 300 es
layout(location = ${ATTRIBUTE_LOCATIONS.position}) in vec3 position;
layout(location = ${ATTRIBUTE_LOCATIONS.normal}) in vec3 normal;
layout(location = ${ATTRIBUTE_LOCATIONS.diffuse}) in vec4 diffuse;
layout(location = ${ATTRIBUTE_LOCATIONS.uv0}) in vec2 uv0;
layout(location = ${ATTRIBUTE_LOCATIONS.uv1}) in vec2 uv1;
layout(location = ${ATTRIBUTE_LOCATIONS.boneIndex}) in vec4 boneIndex;
layout(location = ${ATTRIBUTE_LOCATIONS.boneWeight}) in vec4 boneWeight;

layout(std140) uniform Bones {
  mat4 bones[${MAX_BONES}];
};
uniform bool skinned;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;

uniform vec3 sceneAmbient;
uniform vec3 materialAmbient;
uniform vec4 materialDiffuse;
uniform vec3 materialEmissive;
uniform int lightCount;
uniform vec3 lightColor[${MAX_LIGHTS}];
uniform vec3 lightDirection[${MAX_LIGHTS}];
// A point light's world position, with w 1. A directional light has w 0.
uniform vec4 lightPosition[${MAX_LIGHTS}];
uniform float lightRange[${MAX_LIGHTS}];
uniform vec3 lightAttenuation[${MAX_LIGHTS}];
// A spot's cos(theta / 2), cos(phi / 2) and falloff. A falloff of 0 is no spot.
uniform vec3 lightSpot[${MAX_LIGHTS}];
uniform vec3 lightAmbient[${MAX_LIGHTS}];

uniform bool colorVertex;
uniform bool nomad;
uniform bool unlit;
uniform float normalSign;
uniform bool normalizeNormals;
uniform bool reflecting;
uniform int uvSet;
uniform int secondUvSet;
uniform float secondTile;
// Towards the camera and the horizon's cosine, then \`u\`'s gain and the row.
uniform bool atmosphere;
uniform vec4 atmosphereView;
uniform vec2 atmosphereFade;
// Offset, then scale, on stage 0 alone.
uniform vec4 uvTransform;

out vec4 lit;
out vec2 uv;
out vec2 secondUv;
out vec3 reflection;

// The fast inverse root and one Newton step, which always lands a little short of unit length
// (\`deformable2!0x65f6fc3\`–\`0x65f7031\`).
vec3 renormalized(vec3 v) {
  float squared = dot(v, v);
  float guess = uintBitsToFloat(0x5f3759dfu - (floatBitsToUint(squared) >> 1));
  return v * ((1.5 - 0.5 * squared * guess * guess) * guess);
}

void main() {
  mat4 modelView = view * world;
  vec3 place = position;
  vec3 facing = normal;
  // What FMeshArchetype::Skin writes to locked memory when a bone moves. A lone influence is not
  // renormalized, and a blend is.
  // A point with no influence is in no bone's list, and keeps its stored position.
  if (skinned && boneWeight != vec4(0.0)) {
    mat4 skin = bones[int(boneIndex.x)] * boneWeight.x + bones[int(boneIndex.y)] * boneWeight.y
              + bones[int(boneIndex.z)] * boneWeight.z + bones[int(boneIndex.w)] * boneWeight.w;
    place = (skin * vec4(position, 1.0)).xyz;
    facing = (skin * vec4(normal, 0.0)).xyz;
    if (boneWeight != vec4(1.0, 0.0, 0.0, 0.0)) facing = renormalized(facing);
  }
  vec4 eyePosition = modelView * vec4(place, 1.0);
  gl_Position = projection * eyePosition;
  uv = (uvSet == 1 ? uv1 : uv0) * uvTransform.zw + uvTransform.xy;
  secondUv = (secondUvSet == 1 ? uv1 : uv0) * secondTile;

  // What \`SubmitAtmosphereLock\` writes to locked memory each frame, from the vertex's own normal.
  if (atmosphere) {
    float facing = dot(atmosphereView.xyz, normal);
    float u = facing < atmosphereView.w ? 0.0 : (facing - atmosphereView.w) / (1.0 - atmosphereView.w) * atmosphereFade.x;
    uv = vec2(u, atmosphereFade.y);
  }

  // What \`NomadWriteVert\` writes to locked memory each frame: white at the draw's alpha, and a ramp
  // coordinate from one camera axis per draw, carried into object space by the transpose alone.
  if (nomad) {
    lit = vec4(1.0, 1.0, 1.0, materialDiffuse.a);
    vec3 axis = transpose(mat3(modelView)) * vec3(0.0, 0.0, -1.0);
    // \`SubmitNomadGeometry\` has \`1 - fmod(clock, 5) / 5\`, but every caller of the material's update
    // passes a delta of 0 (\`Freelancer.exe\`, \`0x41af28\` and on), so the clock stays at 0 and this at 1.
    secondUv = vec2((dot(axis, normal) + 1.0) * 0.5, 1.0);
    reflection = vec3(0.0);
    return;
  }

  // A normal goes through the inverse transpose, and keeps its length unless asked otherwise.
  vec3 eyeNormal = transpose(inverse(mat3(modelView))) * (facing * normalSign);
  if (normalizeNormals) eyeNormal = normalize(eyeNormal);

  // D3DMCS_COLOR1 under COLORVERTEX (\`BindMaterialAndContext\`; captured source states, \`li_elite\`).
  // Those states also take ambient from COLOR2, which no retail mesh has. What D3D8 reads then is
  // uncaptured, so the material's ambient here is a reading to check. 22 mesh groups depend on it.
  vec4 source = colorVertex ? diffuse.bgra : materialDiffuse;

  vec3 sum = materialEmissive + materialAmbient * sceneAmbient;
  for (int i = 0; i < lightCount; i++) {
    vec3 toLight = -normalize(mat3(view) * lightDirection[i]);
    float attenuation = 1.0;
    // D3D8's point light: nothing past its range, and \`1 / (a0 + a1 d + a2 d²)\` within it.
    if (lightPosition[i].w > 0.5) {
      vec3 offset = (view * vec4(lightPosition[i].xyz, 1.0)).xyz - eyePosition.xyz;
      float d = length(offset);
      if (d > lightRange[i]) continue;
      toLight = offset / d;
      vec3 a = lightAttenuation[i];
      attenuation = 1.0 / (a.x + a.y * d + a.z * d * d);
      // D3D8's spot: rho against the inner and outer cones' half-angle cosines.
      vec3 spot = lightSpot[i];
      if (spot.z > 0.0) {
        float rho = dot(normalize(mat3(view) * lightDirection[i]), -toLight);
        if (rho <= spot.y) continue;
        if (rho <= spot.x) attenuation *= pow((rho - spot.y) / (spot.x - spot.y), spot.z);
      }
    }
    // D3D8 adds each light's own ambient whichever way the surface faces. Specular is never on:
    // nothing sets SPECULARENABLE (\`ShadingInternal.h\` names it; RP8's default is 0).
    sum += materialAmbient * lightAmbient[i] * attenuation;
    sum += source.rgb * lightColor[i] * attenuation * max(dot(eyeNormal, toLight), 0.0);
  }
  // Saturated here, per vertex, before it is interpolated or meets a texture.
  lit = clamp(vec4(sum, source.a), 0.0, 1.0);
  if (unlit) lit = colorVertex ? diffuse.bgra : vec4(1.0, 1.0, 1.0, materialDiffuse.a);

  // D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR with LOCALVIEWER on, in D3D's Z-flipped camera space.
  reflection = vec3(0.0);
  if (reflecting) {
    // A parallel projection (w's row 0, 0, 0, 1) has no eye point: the way to it is the view's.
    vec3 toEye = projection[3][3] == 1.0 ? vec3(0.0, 0.0, 1.0) : normalize(-eyePosition.xyz);
    vec3 r = 2.0 * dot(toEye, eyeNormal) * eyeNormal - toEye;
    reflection = vec3(r.xy, -r.z);
  }
}`

const FRAGMENT = `#version 300 es
precision highp float;

uniform bool textured;
uniform sampler2D diffuseMap;
uniform bool reflecting;
uniform samplerCube environmentMap;
uniform float alphaReference;
uniform int alphaFunction;
uniform int secondStage;
uniform bool secondTextured;
uniform sampler2D secondMap;
${FOG_GLSL}

in vec4 lit;
in vec2 uv;
in vec2 secondUv;
in vec3 reflection;
out vec4 color;

void main() {
  // An empty stage reads as white: glass has no texture, and still shows its colour.
  color = textured ? clamp(texture(diffuseMap, uv) * lit, 0.0, 1.0) : lit;

  // Stage 1, which saturates like any stage.
  if (secondStage != ${SECOND_STAGE.none} && secondTextured) {
    vec4 second = texture(secondMap, secondUv);
    color.rgb = secondStage == ${SECOND_STAGE.add} ? color.rgb + second.rgb : 2.0 * second.rgb * color.rgb;
    color = clamp(vec4(color.rgb, second.a * color.a), 0.0, 1.0);
  }

  if (reflecting) {
    vec4 cube = texture(environmentMap, reflection);
    color = vec4(clamp(2.0 * cube.rgb * color.rgb, 0.0, 1.0), clamp(cube.a * color.a, 0.0, 1.0));
  }

  // After the stages, before blending, and never on alpha.
  color.rgb = fogged(color.rgb);

  // On the 8-bit value.
  float alpha8 = floor(color.a * 255.0 + 0.5);
  if (alphaFunction == ${ALPHA_FUNCTION.greater} && !(alpha8 > alphaReference)) discard;
  if (alphaFunction == ${ALPHA_FUNCTION.less} && !(alpha8 < alphaReference)) discard;
}`

const UNIFORMS = [
  'world',
  'view',
  'projection',
  'sceneAmbient',
  'materialAmbient',
  'materialDiffuse',
  'materialEmissive',
  'lightCount',
  'lightColor',
  'lightDirection',
  'lightPosition',
  'lightRange',
  'lightAttenuation',
  'lightSpot',
  'lightAmbient',
  'colorVertex',
  'nomad',
  'unlit',
  'normalSign',
  'normalizeNormals',
  'reflecting',
  'uvSet',
  'uvTransform',
  'secondUvSet',
  'secondTile',
  'atmosphere',
  'atmosphereView',
  'atmosphereFade',
  'alphaFunction',
  'skinned',
  'secondStage',
  'secondTextured',
  'secondMap',
  'textured',
  'diffuseMap',
  'environmentMap',
  'alphaReference',
  ...FOG_UNIFORMS,
] as const

export type DcDtProgram = Program<(typeof UNIFORMS)[number]> & { boneBuffer: WebGLBuffer }

/** The `Bones` block's binding point, which needs a buffer whether or not this draw skins. */
export const BONES_BINDING = 0

export const DIFFUSE_UNIT = 0
export const ENVIRONMENT_UNIT = 1
export const SECOND_UNIT = 2

export const createDcDtProgram = (gl: WebGL2RenderingContext): DcDtProgram => {
  const program = createProgram(gl, VERTEX, FRAGMENT, UNIFORMS)

  gl.useProgram(program.handle)
  gl.uniform1i(program.uniforms.diffuseMap, DIFFUSE_UNIT)
  gl.uniform1i(program.uniforms.environmentMap, ENVIRONMENT_UNIT)
  gl.uniform1i(program.uniforms.secondMap, SECOND_UNIT)

  gl.uniformBlockBinding(
    program.handle,
    gl.getUniformBlockIndex(program.handle, 'Bones'),
    BONES_BINDING,
  )

  const boneBuffer = gl.createBuffer()

  gl.bindBuffer(gl.UNIFORM_BUFFER, boneBuffer)
  gl.bufferData(gl.UNIFORM_BUFFER, MAX_BONES * 64, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.UNIFORM_BUFFER, null)
  gl.bindBufferBase(gl.UNIFORM_BUFFER, BONES_BINDING, boneBuffer)
  return { ...program, boneBuffer }
}

const vectors = (values: { x: number; y: number; z: number }[]): Float32Array =>
  new Float32Array(values.flatMap(({ x, y, z }) => [x, y, z]))

/** What stays the same through a frame. The program must be in use. */
export const setFrameUniforms = (
  gl: WebGL2RenderingContext,
  { uniforms }: DcDtProgram,
  { view, projection, ambient, lights }: Frame,
): void => {
  if (lights.length > MAX_LIGHTS) throw new RangeError(`More than ${MAX_LIGHTS} lights`)
  gl.uniformMatrix4fv(uniforms.view, false, Matrix4.toArray(view))
  gl.uniformMatrix4fv(uniforms.projection, false, Matrix4.toArray(projection))
  gl.uniform3f(uniforms.sceneAmbient, ambient.x, ambient.y, ambient.z)
  setLights(gl, uniforms, lights)
}

const ORIGIN = { x: 0, y: 0, z: 0 }

/** A frame's lights, or one draw's in their place. */
export const setLights = (
  gl: WebGL2RenderingContext,
  uniforms: DcDtProgram['uniforms'],
  lights: readonly SceneLight[],
): void => {
  if (lights.length > MAX_LIGHTS) throw new RangeError(`More than ${MAX_LIGHTS} lights`)
  gl.uniform1i(uniforms.lightCount, lights.length)
  if (!lights.length) return
  gl.uniform3fv(uniforms.lightColor, vectors(lights.map(({ color }) => color)))
  gl.uniform3fv(uniforms.lightDirection, vectors(lights.map(({ direction }) => direction)))
  gl.uniform4fv(
    uniforms.lightPosition,
    new Float32Array(
      lights.flatMap(({ position }) => {
        const { x, y, z } = position ?? ORIGIN

        return [x, y, z, position ? 1 : 0]
      }),
    ),
  )
  gl.uniform1fv(uniforms.lightRange, new Float32Array(lights.map(({ range }) => range ?? 0)))
  gl.uniform3fv(
    uniforms.lightAttenuation,
    vectors(lights.map(({ attenuation }) => attenuation ?? ORIGIN)),
  )
  gl.uniform3fv(uniforms.lightAmbient, vectors(lights.map(({ ambient }) => ambient ?? ORIGIN)))
  // The cosines of half of each cone, and the falloff. A zero falloff marks no spot.
  gl.uniform3fv(
    uniforms.lightSpot,
    new Float32Array(
      lights.flatMap(({ spot }) =>
        spot ? [Math.cos(spot.theta / 2), Math.cos(spot.phi / 2), spot.falloff] : [0, 0, 0],
      ),
    ),
  )
}

/** What one draw changes. The textures themselves are the caller's to bind. */
export const setDrawUniforms = (
  gl: WebGL2RenderingContext,
  { uniforms }: DcDtProgram,
  draw: Pick<
    Draw,
    | 'world'
    | 'diffuse'
    | 'ambient'
    | 'emissive'
    | 'colorVertex'
    | 'nomad'
    | 'unlit'
    | 'sceneAmbient'
    | 'negateNormals'
    | 'normalizeNormals'
    | 'alphaReference'
    | 'alphaFunction'
    | 'atmosphere'
    | 'skin'
    | 'texture'
    | 'environment'
    | 'second'
    | 'uvTransform'
    | 'fog'
  >,
): void => {
  gl.uniformMatrix4fv(uniforms.world, false, Matrix4.toArray(draw.world))
  setFog(gl, uniforms, draw.fog)
  gl.uniform4fv(uniforms.materialDiffuse, draw.diffuse)
  gl.uniform3f(uniforms.materialAmbient, draw.ambient.x, draw.ambient.y, draw.ambient.z)
  gl.uniform3f(uniforms.materialEmissive, draw.emissive.x, draw.emissive.y, draw.emissive.z)

  if (draw.sceneAmbient) {
    const { x, y, z } = draw.sceneAmbient

    gl.uniform3f(uniforms.sceneAmbient, x, y, z)
  }

  gl.uniform1i(uniforms.colorVertex, draw.colorVertex ? 1 : 0)
  gl.uniform1i(uniforms.nomad, draw.nomad ? 1 : 0)
  gl.uniform1i(uniforms.unlit, draw.unlit ? 1 : 0)
  gl.uniform1f(uniforms.normalSign, draw.negateNormals ? -1 : 1)
  gl.uniform1i(uniforms.normalizeNormals, draw.normalizeNormals ? 1 : 0)
  gl.uniform1f(uniforms.alphaReference, draw.alphaReference)
  gl.uniform1i(uniforms.alphaFunction, ALPHA_FUNCTION[draw.alphaFunction])
  gl.uniform1i(uniforms.skinned, draw.skin ? 1 : 0)
  gl.uniform1i(uniforms.atmosphere, draw.atmosphere ? 1 : 0)

  if (draw.atmosphere) {
    const { direction, threshold, gain, v } = draw.atmosphere

    gl.uniform4f(uniforms.atmosphereView, direction.x, direction.y, direction.z, threshold)
    gl.uniform2f(uniforms.atmosphereFade, gain, v)
  }

  gl.uniform1i(uniforms.textured, draw.texture ? 1 : 0)
  gl.uniform1i(uniforms.uvSet, draw.texture?.uvSet ?? 0)

  const { offset, scale } = draw.uvTransform ?? { offset: [0, 0], scale: [1, 1] }

  gl.uniform4f(uniforms.uvTransform, offset[0]!, offset[1]!, scale[0]!, scale[1]!)
  gl.uniform1i(uniforms.reflecting, draw.environment ? 1 : 0)
  gl.uniform1i(uniforms.secondStage, SECOND_STAGE[draw.second?.operation ?? 'none'])
  gl.uniform1i(uniforms.secondTextured, draw.second?.texture ? 1 : 0)
  gl.uniform1i(uniforms.secondUvSet, draw.second?.texture?.uvSet ?? 0)
  gl.uniform1f(uniforms.secondTile, draw.second?.tile ?? 1)
}
