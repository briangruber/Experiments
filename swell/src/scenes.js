// The four fixtures.
//
// A scene is a sparse knob override plus a *pinned* camera, sun and set of
// capture timestamps. The pinning is the point: two variants of one slot can
// only be argued about if everything else in the frame is identical, down to
// the wave phase. Change a scene and every stored comparison against it is void,
// so treat these numbers as a public interface.

export const SCENES = {
  'golden-hour': {
    label: 'Golden Hour',
    note: 'Low sun down the wind, moderate wind sea over a long swell. The scene that ' +
          'punishes a bad sky model and a bad subsurface term at the same time.',
    camera: { position: [0, 3.4, 0], target: [46, 3.0, 38] },
    knobs: {
      windSpeed: 8.2, windDirDeg: 40, fetch: 220,
      swellHeight: 1.35, swellPeriod: 11.5, swellDirDeg: 32,
      sunElevationDeg: 3.2, sunAzimuthDeg: 40, sunIntensity: 1.0,
      turbidity: 3.4, fogDensity: 0.85, exposure: 0.9,
      waterDeep: [0.008, 0.042, 0.07], waterShallow: [0.075, 0.28, 0.30],
      foamCoverage: 0.9, scatter: 1.35, fov: 42,
    },
    times: [7.0, 19.5, 33.25, 48.0],
  },

  'deep-ocean': {
    label: 'Deep Ocean',
    note: 'High sun, big long-period swell, nothing on the horizon. Everything here is ' +
          'about water colour, glitter statistics and how the sea meets the sky.',
    camera: { position: [0, 16.0, 0], target: [60, 8.5, 26] },
    knobs: {
      windSpeed: 11.5, windDirDeg: 24, fetch: 600,
      swellHeight: 2.6, swellPeriod: 15.0, swellDirDeg: 12, swellSpread: 0.1,
      sunElevationDeg: 52, sunAzimuthDeg: 24, sunIntensity: 1.05,
      turbidity: 2.1, fogDensity: 0.5, exposure: 0.72,
      waterDeep: [0.004, 0.026, 0.062], waterShallow: [0.03, 0.20, 0.30],
      absorption: 0.055, foamCoverage: 0.85, fov: 46,
    },
    times: [7.0, 19.5, 33.25, 48.0],
  },

  hurricane: {
    label: 'Hurricane',
    note: 'Storm force ten at short fetch — a young, steep sea rather than the long ' +
          '350 m swell a fully developed one would give, because that reads as a gentle ' +
          'slope from any camera you can put on it. Streaked windrows, and a ' +
          'flat overcast that removes the sun as a crutch - if a foam model only looks ' +
          'good in sunlight, this is where it falls over.',
    camera: { position: [0, 4.6, 0], target: [46, 1.2, 27] },
    knobs: {
      windSpeed: 31.0, windDirDeg: 30, fetch: 130,
      amplitude: 1.1, choppiness: 1.35, crestSharpen: 0.85, spread: 0.9, detail: 1.3,
      swellHeight: 4.2, swellPeriod: 13.0, swellDirDeg: 26,
      foamCoverage: 0.55, foamSoftness: 0.34,
      foamDecay: 0.34, foamStreak: 0.8, foamScale: 0.055,
      sunElevationDeg: 21, sunAzimuthDeg: 30, sunIntensity: 0.9,
      overcast: 0.93, turbidity: 6.2, fogDensity: 1.4, exposure: 0.85,
      waterDeep: [0.012, 0.034, 0.045], waterShallow: [0.10, 0.20, 0.21],
      roughness: 0.11, fov: 50,
    },
    times: [7.0, 19.5, 33.25, 48.0],
  },

  'sandy-beach': {
    label: 'Sandy Beach',
    note: 'A shelving beach with the swell running in from -Z. Shoaling, refraction and ' +
          'the depth-limited break all have to work at once, and the waterline has to ' +
          'move. This is the scene that separates a real spectrum from a sine sum.',
    camera: { position: [-11, 7.2, -26], target: [13, 0.2, -118] },
    knobs: {
      shoreEnabled: 1, shoreZ: -60, beachSlope: 0.028, seaFloorDepth: 55,
      windSpeed: 6.8, windDirDeg: 90, fetch: 240, spread: 0.9,
      swellHeight: 1.6, swellPeriod: 12.5, swellDirDeg: 90, swellSpread: 0.08,
      shoalStrength: 1.0, foamCoverage: 1.15, foamDecay: 0.5,
      sunElevationDeg: 26, sunAzimuthDeg: 150, sunIntensity: 1.0,
      turbidity: 3.0, fogDensity: 0.7, exposure: 0.62,
      absorption: 0.16, refract: 0.7,
      waterShallow: [0.10, 0.34, 0.33], sandColor: [0.66, 0.57, 0.45],
      fov: 46,
    },
    times: [7.0, 19.5, 33.25, 48.0],
  },
};

export const SCENE_IDS = Object.keys(SCENES);
