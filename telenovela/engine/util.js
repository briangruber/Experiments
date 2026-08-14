// Small helpers shared by the rig, the camera and the director.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = lerp;
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const invLerp = (a, b, v) => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const remap = (v, a, b, c, d) => lerp(c, d, invLerp(a, b, v));
export const deg = (d) => (d * Math.PI) / 180;

// Shortest-path angle lerp, so a chicken never turns the long way round.
export function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// Frame-rate independent exponential approach. `rate` is roughly "per second".
export const approach = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

export const ease = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inOut: smoothstep,
  soft: smootherstep,
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  quartOut: (t) => 1 - Math.pow(1 - t, 4),
  expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoIn: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  backOut: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2),
  backIn: (t) => 2.2 * t * t * t - 1.4 * t * t,
  elasticOut: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * 2.1) + 1),
  // Up and back down: for gestures that return to rest.
  pulse: (t) => Math.sin(clamp01(t) * Math.PI),
  // Snap out, hold, drift back — the shape of a flinch.
  flinch: (t) => (t < 0.12 ? ease.expoOut(t / 0.12) : 1 - ease.in((t - 0.12) / 0.88) * 0.92),
  bounceOut: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

// Deterministic hash noise — every actor gets its own stream so their idle
// fidgets never sync up into a chorus line.
export function hash11(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// Smooth 1D value noise in [-1,1].
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash11(i + seed * 71.3), b = hash11(i + 1 + seed * 71.3);
  return lerp(a, b, u) * 2 - 1;
}

// Two octaves is enough for breathing and handheld drift.
export function fbm1(x, seed = 0) {
  return noise1(x, seed) * 0.65 + noise1(x * 2.13 + 5.1, seed + 3) * 0.35;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Critically damped spring — the camera operator's shoulder.
export class Spring {
  constructor(value = 0, smooth = 0.3) {
    this.value = value; this.target = value; this.vel = 0; this.smooth = smooth;
  }
  set(v) { this.value = this.target = v; this.vel = 0; return this; }
  step(dt) {
    // Game Programming Gems 4 critically damped approach; stable at any dt.
    const omega = 2 / Math.max(1e-4, this.smooth);
    const x = omega * Math.min(dt, 0.1);
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.value - this.target;
    const temp = (this.vel + omega * change) * Math.min(dt, 0.1);
    this.vel = (this.vel - omega * temp) * exp;
    this.value = this.target + (change + temp) * exp;
    return this.value;
  }
}
