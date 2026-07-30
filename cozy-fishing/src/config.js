// The whole mood lives here: palette, sun, waves, camera, bloom, pacing.
// Tune these before touching any module code.

export const PALETTE = {
  sky: {
    zenith:  0x46538c,
    mid:     0x9a6a8e,
    warm:    0xe8925e,
    horizon: 0xffd2a0,
    sun:     0xfff0d0,
  },
  fog: 0xf0b98a,
  water: {
    deep:    0x175a70,
    shallow: 0x2aa392,
    mottle:  0x1b6e60,
    glint:   0xffd9a6,
  },
  wood: {
    light: 0xb57a4a,
    mid:   0x96603a,
    dark:  0x74462a,
    rope:  0xc9a06a,
  },
  paint: {
    hull: 0xe8dcc4,
    trim: 0x3f6e6a,
    roof: 0x2f5a58,
  },
  silhouette: {
    far:     0x4b4670,
    near:    0x33474e,
    land:    0x3a3550,
    village: 0x3b3557,
  },
  glowWindow: 0xffb866,
  lantern:    0xffc070,
};

// Direction *toward* the sun (normalized in code). Low over the water,
// slightly right of the view axis so the glint path passes the boat.
export const SUN_DIR = [0.16, 0.085, -0.98];

// Gentle harbor swell: a few crossing sines, shared verbatim between the
// water shader (GPU) and floating props (CPU) via shaders/chunks.js.
export const WAVES = [
  { dx: 1.0,  dz: 0.3,  freq: 0.28, amp: 0.085, speed: 0.9 },
  { dx: -0.7, dz: 0.6,  freq: 0.5,  amp: 0.055, speed: 1.25 },
  { dx: 0.2,  dz: -1.0, freq: 0.85, amp: 0.032, speed: 1.7 },
  { dx: 0.9,  dz: -0.4, freq: 1.6,  amp: 0.016, speed: 2.3 },
];

export const CAMERA = {
  fov: 44,
  pos: [0.7, 5.4, -1.6],
  target: [0, 2.3, -24],
  swayAmp: 0.16,
  parallax: 0.55,
};

export const BLOOM = { strength: 0.45, radius: 0.85, threshold: 0.85 };

export const FOG = { near: 110, far: 470 };

export const FISHING = {
  castMin: 2,       // min / max cast distance from the rod tip
  castMax: 42,
  waitMin: 2.2,     // seconds before a bite
  waitMax: 6.5,
  biteWindow: 1.5,  // seconds to click once the bobber dips
};
