// Parameter schema, defaults and presets.
//
// Every entry in SCHEMA is a live control; `defaults` is derived from it, so a
// parameter only has to be declared once. Colours are stored as linear-light
// [r,g,b] triples because that is what the shaders want - the UI converts to and
// from hex on the way in and out.

export const SCHEMA = [
  { group: 'Water body' },
  { key: 'shallowColor', label: 'Shallow tint', type: 'color' },
  { key: 'deepColor', label: 'Deep tint', type: 'color' },
  { key: 'clarity', label: 'Clarity', min: 0.15, max: 3.0, step: 0.01 },
  { key: 'turbidity', label: 'Suspended glow', min: 0, max: 1.6, step: 0.01 },
  { key: 'refraction', label: 'Refraction', min: 0, max: 2.5, step: 0.01 },

  { group: 'Swell' },
  { key: 'waveHeight', label: 'Wave height', min: 0, max: 0.6, step: 0.005 },
  { key: 'waveLength', label: 'Wave scale', min: 0.4, max: 3.0, step: 0.01 },
  { key: 'waveSpeed', label: 'Wave speed', min: 0, max: 2.5, step: 0.01 },
  { key: 'chop', label: 'Chop', min: 0, max: 1.4, step: 0.01 },
  { key: 'ripple', label: 'Ripple detail', min: 0, max: 2.5, step: 0.01 },
  { key: 'windDir', label: 'Wind heading', min: 0, max: 360, step: 1, integer: true },

  { group: 'Surface light' },
  { key: 'sunElevation', label: 'Sun elevation', min: 4, max: 88, step: 0.5 },
  { key: 'sunAzimuth', label: 'Sun heading', min: 0, max: 360, step: 1, integer: true },
  { key: 'sunColor', label: 'Sun colour', type: 'color' },
  { key: 'skyColor', label: 'Sky colour', type: 'color' },
  { key: 'gloss', label: 'Gloss', min: 0.02, max: 1.0, step: 0.005 },
  { key: 'sparkle', label: 'Sparkle', min: 0, max: 2.5, step: 0.01 },
  { key: 'reflectivity', label: 'Reflectivity', min: 0, max: 1.6, step: 0.01 },

  { group: 'Foam' },
  { key: 'shoreFoam', label: 'Shore lace', min: 0, max: 2.0, step: 0.01 },
  { key: 'shoreFoamDepth', label: 'Lace reach', min: 0.05, max: 2.0, step: 0.01 },
  { key: 'crestFoam', label: 'Crest foam', min: 0, max: 2.0, step: 0.01 },
  { key: 'wakeFoam', label: 'Wake foam', min: 0, max: 2.0, step: 0.01 },

  { group: 'Sea floor' },
  { key: 'caustics', label: 'Caustics', min: 0, max: 2.5, step: 0.01 },
  { key: 'causticScale', label: 'Caustic scale', min: 0.2, max: 3.0, step: 0.01 },
  { key: 'sandColor', label: 'Sand', type: 'color' },
  { key: 'reefColor', label: 'Reef', type: 'color' },
  { key: 'floorDepth', label: 'Floor depth', min: 1.0, max: 9.0, step: 0.05 },

  { group: 'Picture' },
  { key: 'stylize', label: 'Painterly banding', min: 0, max: 1, step: 0.01 },
  { key: 'saturation', label: 'Saturation', min: 0.4, max: 1.8, step: 0.01 },
  { key: 'exposure', label: 'Exposure', min: 0.3, max: 2.4, step: 0.01 },
  { key: 'bloom', label: 'Bloom', min: 0, max: 1.6, step: 0.01 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01 },

  { group: 'Scene' },
  { key: 'boatSpeed', label: 'Boat drift', min: 0, max: 3.0, step: 0.01 },
];

// Values that are not exposed as sliders but still want a home.
const BASE = {
  shallowColor: [0.16, 0.72, 0.70],
  deepColor: [0.015, 0.13, 0.30],
  clarity: 1.45,
  turbidity: 0.5,
  refraction: 1.0,

  waveHeight: 0.115,
  waveLength: 1.0,
  waveSpeed: 1.0,
  chop: 0.55,
  ripple: 1.0,
  windDir: 205,

  sunElevation: 58,
  sunAzimuth: 128,
  sunColor: [1.0, 0.93, 0.78],
  skyColor: [0.30, 0.55, 0.92],
  gloss: 0.16,
  sparkle: 0.8,
  reflectivity: 1.0,

  shoreFoam: 1.0,
  shoreFoamDepth: 0.55,
  crestFoam: 0.5,
  wakeFoam: 1.0,

  caustics: 1.7,
  causticScale: 1.0,
  sandColor: [0.60, 0.53, 0.38],
  reefColor: [0.22, 0.38, 0.22],
  floorDepth: 4.6,

  stylize: 0.42,
  saturation: 1.2,
  exposure: 1.0,
  bloom: 0.55,
  vignette: 0.35,

  boatSpeed: 0.85,
};

export const defaults = structuredClone(BASE);

export const PRESETS = {
  'Midday Cove': {},
  'Turquoise Reef': {
    shallowColor: [0.13, 0.80, 0.66],
    deepColor: [0.01, 0.16, 0.36],
    clarity: 1.55,
    turbidity: 0.55,
    sunElevation: 70,
    waveHeight: 0.085,
    caustics: 1.5,
    sandColor: [0.92, 0.85, 0.66],
    saturation: 1.22,
  },
  'Golden Hour': {
    shallowColor: [0.20, 0.62, 0.60],
    deepColor: [0.02, 0.10, 0.24],
    sunElevation: 12,
    sunAzimuth: 250,
    sunColor: [1.0, 0.66, 0.36],
    skyColor: [0.42, 0.48, 0.80],
    waveHeight: 0.14,
    sparkle: 1.6,
    caustics: 0.75,
    exposure: 0.92,
    bloom: 0.7,
    saturation: 1.05,
  },
  'Overcast Shallows': {
    shallowColor: [0.20, 0.56, 0.56],
    deepColor: [0.04, 0.14, 0.26],
    clarity: 0.8,
    sunElevation: 46,
    sunColor: [0.86, 0.88, 0.92],
    skyColor: [0.56, 0.62, 0.70],
    gloss: 0.42,
    sparkle: 0.25,
    reflectivity: 1.25,
    caustics: 0.35,
    waveHeight: 0.16,
    crestFoam: 1.15,
    saturation: 0.9,
    bloom: 0.25,
  },
  'Breezy Afternoon': {
    waveHeight: 0.26,
    chop: 0.9,
    waveSpeed: 1.35,
    crestFoam: 1.4,
    shoreFoam: 1.35,
    sparkle: 1.4,
    turbidity: 0.7,
    clarity: 0.95,
  },
  'Deep Channel': {
    floorDepth: 7.5,
    clarity: 1.0,
    deepColor: [0.008, 0.09, 0.26],
    caustics: 0.7,
    waveHeight: 0.17,
  },
};

// Camera framings. Each is [target, distance, yaw(deg), pitch(deg)].
export const VIEWS = {
  postcard: { target: [-3.0, 0, 2.5], dist: 20, yaw: 36, pitch: 30 },
  skim: { target: [1.0, 0.2, 0], dist: 9.5, yaw: 96, pitch: 7 },
  dock: { target: [-9.5, 0.6, -2], dist: 15, yaw: -34, pitch: 16 },
  shore: { target: [-24, 0, 2], dist: 17, yaw: 62, pitch: 22 },
  chart: { target: [1.0, 0, 0], dist: 30, yaw: 20, pitch: 72 },
};

export function applyPreset(params, name) {
  Object.assign(params, structuredClone(BASE), structuredClone(PRESETS[name] || {}));
  return params;
}
