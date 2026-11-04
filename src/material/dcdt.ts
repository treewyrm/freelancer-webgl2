/**
 * `DcDt` and its kin: D3D8's fixed-function lighting per vertex, then its texture stages.
 * Sources: `src/Shading/Material.cpp`, `FMaterialImpl::BindEnvMap`; the arithmetic is D3D8's own.
 */
import { Matrix4 } from '@treewyrm/freelancer/math'
import { createProgram, type Program } from '#/gl/program.js'
import { ATTRIBUTE_LOCATIONS } from '#/mesh/plan.js'
import type { Draw, Frame } from '#/scene/frame.js'

/** Retail lights a model with at most four (library `THORN.md`, `lt_grp`). */
export const MAX_LIGHTS = 4

// `D3DTOP_ADD` for `DcDtEt` (`0x6ed1724`), `D3DTOP_MODULATE2X` for `BtDetailMapMaterial` (`0x6ed14dc`).
const SECOND_STAGE = { none: 0, add: 1, modulate2x: 2 } as const

const VERTEX = `#version 300 es
layout(location = ${ATTRIBUTE_LOCATIONS.position}) in vec3 position;
layout(location = ${ATTRIBUTE_LOCATIONS.normal}) in vec3 normal;
layout(location = ${ATTRIBUTE_LOCATIONS.diffuse}) in vec4 diffuse;
layout(location = ${ATTRIBUTE_LOCATIONS.uv0}) in vec2 uv0;
layout(location = ${ATTRIBUTE_LOCATIONS.uv1}) in vec2 uv1;

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

uniform bool colorVertex;
uniform bool nomad;
uniform float normalSign;
uniform bool normalizeNormals;
uniform bool reflecting;
uniform int uvSet;
uniform int secondUvSet;

out vec4 lit;
out vec2 uv;
out vec2 secondUv;
out vec3 reflection;

void main() {
  mat4 modelView = view * world;
  vec4 eyePosition = modelView * vec4(position, 1.0);
  gl_Position = projection * eyePosition;
  uv = uvSet == 1 ? uv1 : uv0;
  secondUv = secondUvSet == 1 ? uv1 : uv0;

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
  vec3 eyeNormal = transpose(inverse(mat3(modelView))) * (normal * normalSign);
  if (normalizeNormals) eyeNormal = normalize(eyeNormal);

  // D3DMCS_COLOR1 under COLORVERTEX (\`BindMaterialAndContext\`; captured source states, \`li_elite\`).
  // Those states also take ambient from COLOR2, which no retail mesh has. What D3D8 reads then is
  // uncaptured, so the material's ambient here is a reading to check. 22 mesh groups depend on it.
  vec4 source = colorVertex ? diffuse.bgra : materialDiffuse;

  vec3 sum = materialEmissive + materialAmbient * sceneAmbient;
  for (int i = 0; i < lightCount; i++) {
    vec3 toLight = -normalize(mat3(view) * lightDirection[i]);
    sum += source.rgb * lightColor[i] * max(dot(eyeNormal, toLight), 0.0);
  }
  // Saturated here, per vertex, before it is interpolated or meets a texture.
  lit = clamp(vec4(sum, source.a), 0.0, 1.0);

  // D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR with LOCALVIEWER on, in D3D's Z-flipped camera space.
  reflection = vec3(0.0);
  if (reflecting) {
    vec3 toEye = normalize(-eyePosition.xyz);
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
uniform int secondStage;
uniform bool secondTextured;
uniform sampler2D secondMap;

in vec4 lit;
in vec2 uv;
in vec2 secondUv;
in vec3 reflection;
out vec4 color;

void main() {
  // An empty stage reads as white: glass has no texture, and still shows its colour.
  color = textured ? clamp(texture(diffuseMap, uv) * lit, 0.0, 1.0) : lit;

  // Stage 1, which saturates like any stage. An empty one reads as white, as stage 0 does.
  if (secondStage != ${SECOND_STAGE.none}) {
    vec4 second = secondTextured ? texture(secondMap, secondUv) : vec4(1.0);
    color.rgb = secondStage == ${SECOND_STAGE.add} ? color.rgb + second.rgb : 2.0 * second.rgb * color.rgb;
    color = clamp(vec4(color.rgb, second.a * color.a), 0.0, 1.0);
  }

  if (reflecting) {
    vec4 cube = texture(environmentMap, reflection);
    color = vec4(clamp(2.0 * cube.rgb * color.rgb, 0.0, 1.0), clamp(cube.a * color.a, 0.0, 1.0));
  }

  // D3DCMP_GREATER, on the 8-bit value.
  if (!(floor(color.a * 255.0 + 0.5) > alphaReference)) discard;
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
  'colorVertex',
  'nomad',
  'normalSign',
  'normalizeNormals',
  'reflecting',
  'uvSet',
  'secondUvSet',
  'secondStage',
  'secondTextured',
  'secondMap',
  'textured',
  'diffuseMap',
  'environmentMap',
  'alphaReference',
] as const

export type DcDtProgram = Program<(typeof UNIFORMS)[number]>

export const DIFFUSE_UNIT = 0
export const ENVIRONMENT_UNIT = 1
export const SECOND_UNIT = 2

export const createDcDtProgram = (gl: WebGL2RenderingContext): DcDtProgram => {
  const program = createProgram(gl, VERTEX, FRAGMENT, UNIFORMS)
  gl.useProgram(program.handle)
  gl.uniform1i(program.uniforms.diffuseMap, DIFFUSE_UNIT)
  gl.uniform1i(program.uniforms.environmentMap, ENVIRONMENT_UNIT)
  gl.uniform1i(program.uniforms.secondMap, SECOND_UNIT)
  return program
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
  gl.uniform1i(uniforms.lightCount, lights.length)
  if (!lights.length) return
  gl.uniform3fv(uniforms.lightColor, vectors(lights.map(({ color }) => color)))
  gl.uniform3fv(uniforms.lightDirection, vectors(lights.map(({ direction }) => direction)))
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
    | 'negateNormals'
    | 'normalizeNormals'
    | 'alphaReference'
    | 'texture'
    | 'environment'
    | 'second'
  >,
): void => {
  gl.uniformMatrix4fv(uniforms.world, false, Matrix4.toArray(draw.world))
  gl.uniform4fv(uniforms.materialDiffuse, draw.diffuse)
  gl.uniform3f(uniforms.materialAmbient, draw.ambient.x, draw.ambient.y, draw.ambient.z)
  gl.uniform3f(uniforms.materialEmissive, draw.emissive.x, draw.emissive.y, draw.emissive.z)
  gl.uniform1i(uniforms.colorVertex, draw.colorVertex ? 1 : 0)
  gl.uniform1i(uniforms.nomad, draw.nomad ? 1 : 0)
  gl.uniform1f(uniforms.normalSign, draw.negateNormals ? -1 : 1)
  gl.uniform1i(uniforms.normalizeNormals, draw.normalizeNormals ? 1 : 0)
  gl.uniform1f(uniforms.alphaReference, draw.alphaReference)
  gl.uniform1i(uniforms.textured, draw.texture ? 1 : 0)
  gl.uniform1i(uniforms.uvSet, draw.texture?.uvSet ?? 0)
  gl.uniform1i(uniforms.reflecting, draw.environment ? 1 : 0)
  gl.uniform1i(uniforms.secondStage, SECOND_STAGE[draw.second?.operation ?? 'none'])
  gl.uniform1i(uniforms.secondTextured, draw.second?.texture ? 1 : 0)
  gl.uniform1i(uniforms.secondUvSet, draw.second?.texture?.uvSet ?? 0)
}
