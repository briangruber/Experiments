// Seeded random and noise. Everything procedural in the world goes through
// here so a given seed always builds the same bay.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small bundle of the random helpers you actually want. */
export function makeRng(seed) {
  const r = mulberry32(seed);
  return {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => a + Math.floor((b - a + 1) * r()),
    pick: (arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))],
    chance: (p) => r() < p,
    // Signed, roughly normal, in [-1, 1] with most mass near zero.
    gauss: () => (r() + r() + r() - 1.5) / 1.5,
    sign: () => (r() < 0.5 ? -1 : 1),
  };
}

// --- hashes -----------------------------------------------------------------

export function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- noise ------------------------------------------------------------------

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** Gradient (Perlin-style) noise in [-1, 1]. */
export function noise2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const g = (ix, iy, dx, dy) => {
    const a = hash2(ix, iy) * 6.2831853;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4142;
}

/** Value noise in [0, 1] — smoother, cheaper, good for masks. */
export function value2D(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  return lerp(
    lerp(hash2(xi, yi), hash2(xi + 1, yi), u),
    lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u),
    v,
  );
}

export function fbm2D(x, y, octaves = 4, lacunarity = 2.02, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(fx, fy);
    norm += amp;
    amp *= gain;
    fx *= lacunarity; fy *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fbm — the sharp crest shape that reads as rock. */
export function ridged2D(x, y, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2D(fx, fy));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    fx *= lacunarity; fy *= lacunarity;
  }
  return sum / norm;
}

/**
 * Distance to the nearest of a jittered lattice of points, plus the id of that
 * point. Used for coral clumps, rock facets, cloud cells.
 */
export function worley2D(x, y, out) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 1e9, bestId = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const px = cx + hash2(cx, cy);
      const py = cy + hash2(cy, cx * 31 + 7);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bestId = hash2(cx * 17 + 3, cy * 13 + 11); }
    }
  }
  if (out) { out.d = Math.sqrt(best); out.id = bestId; return out; }
  return Math.sqrt(best);
}

export const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const mix = lerp;
