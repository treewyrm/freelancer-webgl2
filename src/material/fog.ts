/**
 * D3D8's linear table fog on W, per pixel, which `FogApplyColorAndRange` picks on any device with
 * W-fog and T&L (`FDirectX8`'s ability 13). Shared by every program a fogged draw goes through.
 */
import type { Fog } from '#/scene/nebula.js'

export const FOG_UNIFORMS = ['fogOn', 'fogColor', 'fogRange'] as const

/** Declares the uniforms, and `fogged`, which blends a colour into the fog by this pixel's W. */
export const FOG_GLSL = `
uniform bool fogOn;
uniform vec3 fogColor;
// Start and end.
uniform vec2 fogRange;

vec3 fogged(vec3 color) {
  if (!fogOn) return color;
  // W is eye depth. How finely the hardware's fog factor steps is uncaptured.
  float w = 1.0 / gl_FragCoord.w;
  float f = clamp((fogRange.y - w) / (fogRange.y - fogRange.x), 0.0, 1.0);
  return mix(fogColor, color, f);
}`

type FogUniforms = Record<(typeof FOG_UNIFORMS)[number], WebGLUniformLocation | null>

export const setFog = (gl: WebGL2RenderingContext, uniforms: FogUniforms, fog?: Fog): void => {
  gl.uniform1i(uniforms.fogOn, fog ? 1 : 0)
  if (!fog) return
  gl.uniform3f(uniforms.fogColor, fog.color.x, fog.color.y, fog.color.z)
  gl.uniform2f(uniforms.fogRange, fog.start, fog.end)
}
