/**
 * D3D8's table fog on W, per pixel, which `FogApplyColorAndRange` picks on any device with W-fog and
 * T&L (`FDirectX8`'s ability 13). Shared by every program a fogged draw goes through.
 */
import type { Fog } from '#/scene/nebula.js'

export const FOG_UNIFORMS = ['fogMode', 'fogColor', 'fogRange', 'fogDensity'] as const

/** Declares the uniforms, and `fogged`, which blends a colour into the fog by this pixel's W. */
export const FOG_GLSL = `
// 0 off, then D3DFOGMODE's 1 exp, 2 exp2 and 3 linear.
uniform int fogMode;
uniform vec3 fogColor;
// Start and end, which only linear fog reads.
uniform vec2 fogRange;
uniform float fogDensity;

vec3 fogged(vec3 color) {
  if (fogMode == 0) return color;
  // W is eye depth. How finely the hardware's fog factor steps is uncaptured.
  float w = 1.0 / gl_FragCoord.w;
  float d = fogDensity * w;
  float f = fogMode == 1 ? exp(-d)
    : fogMode == 2 ? exp(-d * d)
    : (fogRange.y - w) / (fogRange.y - fogRange.x);
  return mix(fogColor, color, clamp(f, 0.0, 1.0));
}`

type FogUniforms = Record<(typeof FOG_UNIFORMS)[number], WebGLUniformLocation | null>

const MODES = { exp: 1, exp2: 2, linear: 3 } as const

export const setFog = (gl: WebGL2RenderingContext, uniforms: FogUniforms, fog?: Fog): void => {
  gl.uniform1i(uniforms.fogMode, fog ? MODES[fog.mode ?? 'linear'] : 0)
  if (!fog) return
  gl.uniform3f(uniforms.fogColor, fog.color.x, fog.color.y, fog.color.z)
  gl.uniform2f(uniforms.fogRange, fog.start, fog.end)
  gl.uniform1f(uniforms.fogDensity, fog.density ?? 0)
}
