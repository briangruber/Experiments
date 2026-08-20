// Every knob the ocean exposes.
//
// `defaults` is the single source of truth for values; `SCHEMA` only describes
// how to present them. Scenes and tunings are *sparse overrides* on top of
// `defaults`, so adding a knob never invalidates an existing scene or a tuning
// someone posted six months ago.
//
// Slot variants may declare extra knobs of their own (see `slots/index.js`);
// those are merged in at load time and behave identically.

export const defaults = {
  // ---- sea state -----------------------------------------------------------
  windSpeed: 9.0,           // U10, m/s. Drives the whole spectrum.
  windDirDeg: 40.0,
  fetch: 160.0,             // km of open water the wind has worked on
  waveCount: 42,            // number of summed wave trains (quality/perf knob)
  amplitude: 1.0,           // global gain on wave height
  choppiness: 1.0,          // horizontal Gerstner displacement
  crestSharpen: 0.55,       // bound second harmonic; sharpens crests, flattens troughs
  spread: 0.85,             // directional spreading; 1 = tightly aligned to wind
  detail: 1.0,              // gain on the short-wave tail
  timeScale: 1.0,

  // ---- swell ---------------------------------------------------------------
  swellHeight: 0.9,         // significant height of the long train, m
  swellPeriod: 12.0,        // s
  swellDirDeg: 20.0,
  swellSpread: 0.15,

  // ---- breaking (where whitecaps appear) -----------------------------------
  foamCoverage: 1.0,        // gain on breaking area
  foamThreshold: 0.42,      // fold value at which the surface starts to break
  foamSoftness: 0.28,       // width of the breaking ramp
  foamDecay: 0.55,          // 1/s; how fast a raft dissipates behind the crest
  foamScale: 0.09,          // size of the clump noise, cycles/m
  foamStreak: 0.45,         // stretch of clumps into downwind windrows
  foamFace: 0.55,           // how strongly breaking prefers forward faces

  // ---- foam shading --------------------------------------------------------
  foamBrightness: 1.0,
  foamRoughness: 0.62,
  foamColor: [0.94, 0.96, 0.97],

  // ---- water shading -------------------------------------------------------
  waterDeep: [0.008, 0.045, 0.075],
  waterShallow: [0.09, 0.32, 0.34],
  absorption: 0.085,        // 1/m; how fast depth swallows light
  scatter: 1.0,             // subsurface glow through a backlit crest
  roughness: 0.075,         // microfacet roughness of the water itself
  specular: 1.0,
  refract: 0.55,            // bending of the seabed seen through the surface

  // ---- sky and light -------------------------------------------------------
  sunElevationDeg: 8.0,
  sunAzimuthDeg: 40.0,
  sunIntensity: 1.0,
  turbidity: 2.6,
  overcast: 0.0,            // 0 = clear, 1 = solid storm deck
  fogDensity: 0.55,         // aerial perspective toward the horizon

  // ---- shoreline -----------------------------------------------------------
  seaFloorDepth: 400.0,     // depth of the open-ocean floor, m
  shoreEnabled: 0.0,        // 0 = no land at all
  shoreZ: -120.0,           // world z of the still-water line
  beachSlope: 0.035,        // rise over run of the sand
  shoalStrength: 1.0,       // how hard shallow water pumps up wave height
  sandColor: [0.62, 0.53, 0.41],

  // ---- camera and post -----------------------------------------------------
  earthCurve: 1.0,          // how hard distant water falls below the horizon
  fov: 45.0,
  exposure: 1.0,
  vignette: 0.35,
};

// Grouping and ranges for the UI. Anything in `defaults` without a schema entry
// still works, it just does not get a slider.
export const SCHEMA = [
  { group: 'Sea state', keys: [
    ['windSpeed', 0, 40, 0.1, 'm/s'],
    ['windDirDeg', 0, 360, 1, '°'],
    ['fetch', 5, 800, 1, 'km'],
    ['waveCount', 8, 96, 1, ''],
    ['amplitude', 0, 3, 0.01, '×'],
    ['choppiness', 0, 2.5, 0.01, '×'],
    ['crestSharpen', 0, 1.5, 0.01, ''],
    ['spread', 0, 1, 0.01, ''],
    ['detail', 0, 2, 0.01, '×'],
    ['timeScale', 0, 3, 0.01, '×'],
  ]},
  { group: 'Swell', keys: [
    ['swellHeight', 0, 8, 0.01, 'm'],
    ['swellPeriod', 4, 22, 0.1, 's'],
    ['swellDirDeg', 0, 360, 1, '°'],
    ['swellSpread', 0, 1, 0.01, ''],
  ]},
  { group: 'Breaking', keys: [
    ['foamCoverage', 0, 3, 0.01, '×'],
    ['foamThreshold', 0, 1.2, 0.005, ''],
    ['foamSoftness', 0.01, 1, 0.005, ''],
    ['foamDecay', 0.02, 3, 0.01, '1/s'],
    ['foamScale', 0.005, 0.5, 0.001, '/m'],
    ['foamStreak', 0, 1, 0.01, ''],
    ['foamFace', 0, 1, 0.01, ''],
  ]},
  { group: 'Foam', keys: [
    ['foamBrightness', 0, 2, 0.01, '×'],
    ['foamRoughness', 0.02, 1, 0.01, ''],
    ['foamColor', 'color'],
  ]},
  { group: 'Water', keys: [
    ['waterDeep', 'color'],
    ['waterShallow', 'color'],
    ['absorption', 0.005, 0.5, 0.001, '1/m'],
    ['scatter', 0, 3, 0.01, '×'],
    ['roughness', 0.005, 0.4, 0.001, ''],
    ['specular', 0, 2, 0.01, '×'],
    ['refract', 0, 2, 0.01, '×'],
  ]},
  { group: 'Sky and light', keys: [
    ['sunElevationDeg', -6, 90, 0.1, '°'],
    ['sunAzimuthDeg', 0, 360, 1, '°'],
    ['sunIntensity', 0, 3, 0.01, '×'],
    ['turbidity', 1, 12, 0.05, ''],
    ['overcast', 0, 1, 0.01, ''],
    ['fogDensity', 0, 3, 0.01, '×'],
  ]},
  { group: 'Shoreline', keys: [
    ['shoreZ', -600, 200, 1, 'm'],
    ['beachSlope', 0.004, 0.2, 0.001, ''],
    ['shoalStrength', 0, 2, 0.01, '×'],
    ['seaFloorDepth', 5, 2000, 1, 'm'],
    ['sandColor', 'color'],
  ]},
  { group: 'Camera and post', keys: [
    ['earthCurve', 0, 2, 0.01, '×'],
    ['fov', 15, 90, 0.5, '°'],
    ['exposure', 0.05, 4, 0.01, '×'],
    ['vignette', 0, 1, 0.01, ''],
  ]},
];

// Sparse-override merge. Used for scenes, for slot-declared knobs, and for
// tunings pasted in from someone else's viewer.
export function resolve(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

// The inverse: what did this tuning actually change? This is the thing worth
// posting, and the thing an agent should be handed.
export function diff(base, tuned) {
  const out = {};
  const same = (a, b) => Array.isArray(a)
    ? Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
    : Math.abs(a - b) < 1e-9;
  for (const [k, v] of Object.entries(tuned)) {
    if (!(k in base) || !same(base[k], v)) out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}
