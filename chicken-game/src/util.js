// Small math + random helpers shared across the game.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate independent exponential approach.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// Deterministic PRNG so ?seed= gives reproducible coops.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rand = (rng, a, b) => a + rng() * (b - a);
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

// Rotate `current` toward `target` by at most rate*dt, the short way round.
export function turnToward(current, target, rate, dt) {
  const d = wrapAngle(target - current);
  const step = clamp(d, -rate * dt, rate * dt);
  return current + step;
}
