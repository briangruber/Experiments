// The seams. Everything a slot variant may rely on, and the exact function each
// slot must define.
//
// These signatures are the compatibility surface of the whole project: a
// variant written against them keeps working when someone else rewrites a
// different slot. Adding a *field* to a struct is backwards compatible; changing
// or removing one is not, and needs a version bump in `slots/index.js`.

export const SLOTS = ['sky', 'shoreline', 'spectrum', 'breaking', 'foam', 'water'];

// What each slot must define. Enforced at assembly time (see index.js) and
// documented for agents in AGENTS.md.
export const CONTRACTS = {
  sky: {
    provides: [
      'vec3 sw_sky(vec3 dir, vec3 sunDir)',
      'vec3 sw_skyNoSun(vec3 dir, vec3 sunDir)',
      'vec3 sw_sunRadiance(vec3 sunDir)',
      'vec3 sw_skyAmbient(vec3 sunDir)',
    ],
    note: 'Radiance looking along `dir`, plus the two light quantities the water shading uses. Owning the sky means owning the light. `sw_skyNoSun` is the same sky without the solar disc: shading slots handle the sun with their own specular lobe, so a reflection that also samples the disc counts it twice and smears a grey blob across the water.',
  },
  shoreline: {
    provides: [
      'float sw_seabedHeight(vec2 p)',
      'float sw_waterDepth(vec2 p)',
    ],
    note: 'Bathymetry in world metres. Depth <= 0 means dry sand. The spectrum consumes this to shoal.',
  },
  spectrum: {
    provides: [
      'Wave sw_waves(vec2 p, float t, float depth, float footprint)',
      'Wave sw_wavesN(vec2 p, float t, float depth, float footprint, int n)',
    ],
    note: 'The wave field. `footprint` is the world size of one pixel: fade wave trains shorter than it or the sea will crawl with aliasing. Must fill Wave.fold honestly — that is the currency the breaking slot spends. `sw_wavesN` is the same field truncated to the `n` longest trains, so downstream slots can take cheap extra samples. Must also fill Wave.foldRms.',
  },
  breaking: {
    provides: ['vec2 sw_breaking(Wave w, vec2 p, float t, float depth, float footprint)'],
    note: 'Returns (coverage, freshness), both 0..1. Where whitecaps are, not what they look like.',
  },
  foam: {
    provides: ['vec3 sw_foamShade(Surf s, float coverage, float fresh)'],
    note: 'What whitecaps look like once something else decided where they are.',
  },
  water: {
    provides: ['vec3 sw_waterShade(Surf s)'],
    note: 'The water surface itself: fresnel, absorption, subsurface, sun glitter.',
  },
};

// Shared preamble, prepended to every assembled shader. Structs, constants and
// the noise a variant would otherwise have to reinvent.
export const PREAMBLE = /* glsl */`
#define SW_PI 3.14159265359
#define SW_TAU 6.28318530718
#define sat(x) clamp((x), 0.0, 1.0)

// One sample of the wave field.
struct Wave {
  vec3  disp;    // displacement from the flat point, world metres
  vec3  normal;  // unit surface normal
  float fold;    // surface compression. 0 = flat, >1 = folding over on itself
  float slope;   // |horizontal gradient| of the height field
  float face;    // +1 the crest faces downwind, -1 it faces upwind
  float foldRms; // RMS of the fold field *as band-limited at this footprint*.
                 // Breaking variants divide fold by it, which is what lets one
                 // threshold mean the same thing in a millpond and a hurricane.
                 // It has to be computed here rather than on the CPU because
                 // only the shader knows which trains survived the fade.
  float subRough; // RMS slope of the wave trains too small to resolve here.
                  // Filtering them out of the geometry does not make the sea
                  // glassy in reality - it makes it rough - so shading slots
                  // must fold this into their microfacet roughness.
};

// Everything a shading slot is handed about the point being shaded.
struct Surf {
  vec3  P;       // world position
  vec3  N;       // shading normal
  vec3  V;       // unit vector toward the eye
  vec3  L;       // unit vector toward the sun
  vec3  sunRad;  // sun radiance
  vec3  skyRad;  // sky ambient
  float depth;   // water depth beneath this point, metres
  float dist;    // distance to camera, metres
  Wave  w;       // the wave sample here
};

float sw_hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float sw_noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sw_hash(i), b = sw_hash(i + vec2(1.0, 0.0));
  float c = sw_hash(i + vec2(0.0, 1.0)), d = sw_hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float sw_fbm(vec2 p, int octaves){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= octaves) break;
    s += a * sw_noise(p); n += a; p *= 2.03; a *= 0.5;
  }
  return s / max(n, 1e-4);
}

// Schlick with a water-appropriate F0, kept here so every water variant agrees
// on what "fresnel" means.
float sw_fresnel(float NoV, float f0){
  float m = pow(1.0 - sat(NoV), 5.0);
  return f0 + (1.0 - f0) * m;
}

vec3 sw_windVec(float deg){
  float a = radians(deg);
  return vec3(cos(a), 0.0, sin(a));
}
`;
