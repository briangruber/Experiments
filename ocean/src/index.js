// Abyssal - public API.
//
// Two ways in:
//
//   import { AbyssalWater, AbyssalSky } from 'abyssal-ocean/three';
//       Drop the sea or the sky into an existing Three.js scene. Start here.
//
//   import { Ocean, Sky, WaterSurface } from 'abyssal-ocean';
//       The raw WebGL2 pieces, for a renderer of your own. Everything takes a
//       WebGL2RenderingContext as its first argument and creates nothing global.
//
// Nothing in this module imports Three.js.

// --- the two components -----------------------------------------------------
export { Ocean, DEFAULT_CASCADES, whitecapFraction } from './ocean.js';
export { WaterSurface } from './water.js';
export { Sky } from './sky.js';

// --- optional extras --------------------------------------------------------
// Spray is a hull spray emitter (GPU particles); Wake is a persistent Kelvin wake
// field. Both are for a vessel moving over the sea and neither is needed to draw
// water. Post is the HDR bloom / exposure / tonemap chain the demo finishes with.
export { Spray } from './spray.js';
export { Wake, WAKE_SAMPLE_GLSL } from './wake.js';
export { Post } from './post.js';

// --- parameters -------------------------------------------------------------
// `defaults` is the full parameter set with every knob at its default value;
// `PRESETS` are sparse overrides on top of it. `newParams('Storm Front')` is the
// normal way to get a parameter object.
export { defaults, PRESETS, applyPreset, newParams, isHandheld } from './presets.js';
export { createDerived, derive } from './derive.js';

// --- WebGL2 plumbing --------------------------------------------------------
// Exposed because a custom renderer needs the same texture and framebuffer
// helpers the components were built against.
export {
  getContext, program, setUniforms, texture2D, textureArray,
  framebuffer, depthBuffer, Blitter, FS_VERT, FS_VERT_FAR,
} from './gl.js';

// --- shader source ----------------------------------------------------------
// The GLSL is plain strings with no preprocessor of our own, so a host that wants
// to splice the atmosphere or the wave sampling into its own material can.
export { WATER_VS, WATER_FS } from './shaders/water.js';
export { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './shaders/sky.js';

export * as math from './math.js';
