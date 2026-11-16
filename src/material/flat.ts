/**
 * A draw's shape alone, in one colour: its geometry, skin and placement as `DcDt` has them, and
 * nothing of its material. What a host's hook redraws a frame's draws with into a target of its own
 * (`HookContext.silhouette`): a selection mask, a pick buffer. The game path never draws with it.
 */
import { createProgram, type Program } from '#/gl/program.js'
import { MAX_BONES } from '#/deformable/skin.js'
import { ATTRIBUTE_LOCATIONS } from '#/mesh/plan.js'
import { BONES_BINDING } from './dcdt.js'

// `DcDt`'s placement and skin, term for term, so a draw lands on the pixels the picture has it on.
const VERTEX = `#version 300 es
layout(location = ${ATTRIBUTE_LOCATIONS.position}) in vec3 position;
layout(location = ${ATTRIBUTE_LOCATIONS.boneIndex}) in vec4 boneIndex;
layout(location = ${ATTRIBUTE_LOCATIONS.boneWeight}) in vec4 boneWeight;

layout(std140) uniform Bones {
  mat4 bones[${MAX_BONES}];
};
uniform bool skinned;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;

void main() {
  mat4 modelView = view * world;
  vec3 place = position;
  if (skinned && boneWeight != vec4(0.0)) {
    mat4 skin = bones[int(boneIndex.x)] * boneWeight.x + bones[int(boneIndex.y)] * boneWeight.y
              + bones[int(boneIndex.z)] * boneWeight.z + bones[int(boneIndex.w)] * boneWeight.w;
    place = (skin * vec4(position, 1.0)).xyz;
  }
  vec4 eyePosition = modelView * vec4(place, 1.0);
  gl_Position = projection * eyePosition;
}
`

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec4 colour;

out vec4 fragColor;

void main() {
  fragColor = colour;
}
`

const UNIFORMS = ['skinned', 'world', 'view', 'projection', 'colour'] as const

export type FlatProgram = Program<(typeof UNIFORMS)[number]>

/** Its bone block reads whatever buffer is bound at `BONES_BINDING`, as `DcDt`'s does. */
export const createFlatProgram = (gl: WebGL2RenderingContext): FlatProgram => {
  const program = createProgram(gl, VERTEX, FRAGMENT, UNIFORMS)

  gl.uniformBlockBinding(
    program.handle,
    gl.getUniformBlockIndex(program.handle, 'Bones'),
    BONES_BINDING,
  )

  return program
}
