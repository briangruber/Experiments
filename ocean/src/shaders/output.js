// Optional display transform for the water and sky shaders.
//
// Both write scene-referred radiance: a sunlit crest can be 20 or 30 and the sun
// path far more. In this project that is correct, because the frame lands in an
// RGBA16F target and the post chain does exposure and tonemapping afterwards.
//
// Dropped into a host renderer with no HDR pipeline - the common case for a
// Three.js scene rendering straight to the canvas - those values clamp at 1.0 and
// the sea comes out as a white sheet. This is the fallback for that case: an
// exposure stop and an ACES fit applied at the end of the fragment shader.
//
// It is a fallback, not the recommended path. Tonemapping per-shader means each
// component tonemaps in isolation, so the sea and the sky each roll off their own
// highlights and no bloom is possible. Rendering into a half-float target and
// tonemapping the composed frame once is better, and is what docs/threejs.md
// recommends. This exists so that the simple case looks right rather than broken.

// Prepended ahead of the shader body, so it wins the #ifndef guard there.
export const LDR_OUTPUT_GLSL = /* glsl */`
#define ABYSSAL_OUT(c) abyssalDisplay(c)
uniform float uOutExposure;
const mat3 ABYSSAL_ACES_IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
const mat3 ABYSSAL_ACES_OUT = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
vec4 abyssalDisplay(vec3 c){
  c *= uOutExposure;
  c = ABYSSAL_ACES_IN * c;
  vec3 a = c*(c+0.0245786) - 0.000090537;
  vec3 b = c*(0.983729*c + 0.4329510) + 0.238081;
  c = clamp(ABYSSAL_ACES_OUT * (a/b), 0.0, 1.0);
  // sRGB transfer. Three.js encodes its own materials inside their shaders and
  // does nothing to a foreign draw, so this has to be done here.
  return vec4(mix(c*12.92, 1.055*pow(max(c, 1e-5), vec3(1.0/2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;

// The default: hand back linear radiance untouched, for an HDR target.
export const HDR_OUTPUT_GUARD = /* glsl */`
#ifndef ABYSSAL_OUT
#define ABYSSAL_OUT(c) vec4(c, 1.0)
#endif
`;
