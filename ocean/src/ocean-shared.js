// The parts of the ocean simulation that are pure arithmetic: the cascade
// layout, the butterfly table, the noise field, the band limits, and the foam
// statistics.
//
// Split out of ./ocean.js so that a renderer which does NOT use the raw-WebGL
// simulation can still share these. Re-deriving them instead is how the first
// port of this simulation got five things wrong at once - the butterfly table
// transposed, the twiddle sign flipped, the noise reseeded per cascade, and two
// different band formulas - so there is exactly one home for each and every
// backend reads it.
//
// Nothing here touches a GPU. ./ocean.js imports it and re-exports every name,
// so existing callers are unaffected; src/gpu/tsl/sim-driver.js imports it
// directly, which is what keeps src/gl.js and src/shaders/oceanSim.js out of a
// three.js build entirely.

import { mulberry32, gauss2 } from './math.js';
// Multi-cascade FFT ocean.
//
// Four independent spectra with deliberately non-commensurate patch sizes are
// summed in the surface shader. Because the periods share no common multiple at
// any believable viewing distance, the surface never shows a repeating tile.


// Patch sizes chosen so no pair has a simple rational ratio. The largest patch
// has to resolve the peak of the spectrum with enough modes that the swell reads
// as travelling wave groups rather than one slow lump. Groups are a beat between
// neighbouring modes, so a peak carried by three or four of them cannot make
// any: at 3137 m a 14 s swell lands on mode 10 and the 17 s peak of a full gale
// on mode 7, both with enough neighbours to beat against. Cascade 0 never
// carries anything shorter than 66 m, so its 12 m texels are not the constraint
// - the mode count at the peak is.
export const DEFAULT_CASCADES = [3137.0, 397.0, 87.0, 17.3];

// How much of each cascade's whitecap contribution the surface shader should
// see. Every cascade now tests the same combined Jacobian, so without a
// partition the four foam layers would simply stack up in the near field. The
// weights sum to one when all four are visible.
//
// The split is a resolution argument, not a distance one. Cascade 0's texels are
// twelve metres across, so *any* structure it stores is at least a twenty metre
// blob - which is exactly what a third of the foam budget living there looked
// like. A breaker is metres wide, so the budget belongs in the cascades whose
// texels can hold that shape (1.6 m and 0.34 m). Cascade 0 keeps a token share
// for the far field, where a whitecap is sub-pixel anyway and only its area
// matters. Cascade 3 gets none at all: every cascade evaluates the same
// world-space fold field but can only store the part of it that falls inside its
// own tile, so a 17 m patch would stamp the same whitecap every 17 metres - and
// a 17 m window is too small a sample of a two-percent-coverage field to even
// contain one reliably. The bulk sits in the 397 m tile for the same reason in
// reverse: it is the longest period that still resolves a breaker.
// Each cascade's foam is periodic in that cascade's own tile - unavoidably, it
// lives in that tile's texture. So no single cascade may dominate, or its period
// prints a lattice of whitecaps across a sea whose waves do not repeat. Spread
// across incommensurate periods the sum has no period, exactly as the wave field
// does not. The bias toward the middle two is where breaking waves actually are.
export const FOAM_WEIGHTS = [0.20, 0.34, 0.30, 0.16];

// Monahan & O'Muircheartaigh's whitecap law, W = 3.84e-6 U10^3.41. It is the one
// number in the foam model with a boat and a camera behind it, so the breaking
// threshold is derived from it rather than dialled in by eye: ~0.3% at force 4,
// ~3% at force 6, ~25% at force 10. Above force 11 the fit runs away and real
// seas saturate, hence the cap.
// `windMin` is a hard gate below it: the fit is a power law and never quite
// reaches zero, but a real sea below force 3 has no whitecaps at all, and a
// glassy preset showing its statistical quota of three rafts per square
// kilometre is worse than showing none.
export function whitecapFraction(U10, gain = 1, windMin = 4.0) {
  const U = Math.max(U10, 0.1);
  const gate = windMin > 0 ? Math.min(Math.max((U - windMin) / 2.5, 0), 1) ** 2 : 1;
  return Math.min(3.84e-6 * Math.pow(U, 3.41) * gain * gate, 0.42);
}

// Upper-tail quantile of a unit normal (Abramowitz & Stegun 26.2.23), good to
// 5e-4 over the range of coverages we ask for. The low-passed compression is a
// linear functional of a Gaussian wave field, so its own tail is Gaussian too
// and this converts "I want W of the surface breaking" into a cutoff in sigmas.
export function probit(p) {
  const q = Math.min(Math.max(p, 1e-6), 0.5);
  const t = Math.sqrt(-2 * Math.log(q));
  return t - (2.30753 + 0.27061 * t) / (1 + 0.99229 * t + 0.04481 * t * t);
}

// Share of the total whitecap coverage that is *actively* folding at any
// instant; the rest of W is the dissipating raft the breaker leaves behind.
// Calibrated against the measured mean of the foam texture.
export const ACTIVE_SHARE = 0.38;

// The breaking test is gated after the threshold - on the forward face and on
// the ridge of the fold field - and the injection gain then re-saturates
// whatever survives, so the area that ends up white is not the area of the
// Gaussian tail the probit sized. Measured against the mean of the foam texture
// across the preset range.
export const GATE_PASS = 0.85;

// The breaking threshold, in sigmas of the low-passed compression, for a target
// whitecap coverage. Hoisted out of Ocean._foamStep so there is exactly ONE
// spelling of `probit(W * ACTIVE_SHARE / GATE_PASS)` and the TSL driver
// (src/gpu/tsl/sim-driver.js) cannot drift from this one.
export function foamCutoffOf(whitecap) {
  return probit(whitecap * ACTIVE_SHARE / GATE_PASS);
}

export function butterflyData(N) {
  const stages = Math.round(Math.log2(N));
  const bits = stages;
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const data = new Float32Array(stages * N * 4);
  for (let s = 0; s < stages; s++) {
    const span = 1 << s;
    for (let y = 0; y < N; y++) {
      // k carries the wing sign implicitly: the lower wing lands on k + N/2.
      const k = ((y * (N / (span * 2))) % N);
      const ang = 2 * Math.PI * k / N;             // e^{+i.} => inverse transform
      const topWing = (y % (span * 2)) < span;
      let top, bot;
      if (s === 0) {
        top = topWing ? rev[y] : rev[y - 1];
        bot = topWing ? rev[y + 1] : rev[y];
      } else {
        top = topWing ? y : y - span;
        bot = topWing ? y + span : y;
      }
      const o = (y * stages + s) * 4;              // texture is stages wide, N tall
      data[o + 0] = Math.cos(ang);
      data[o + 1] = Math.sin(ang);
      data[o + 2] = top;
      data[o + 3] = bot;
    }
  }
  return { data, stages };
}

// The gaussian field h0 is seeded from. One continuous stream across all
// cascades, NOT a reseed per cascade: cascade 1 continues where cascade 0 left
// off. Reseeding per cascade gives a different sea from the same seed.
export function cascadeNoise(N, C, seed) {
  const rand = mulberry32(seed);
  const data = new Float32Array(N * N * C * 4);
  for (let c = 0; c < C; c++) {
    for (let i = 0; i < N * N; i++) {
      const [a, b] = gauss2(rand);
      const [d, e] = gauss2(rand);
      const o = (c * N * N + i) * 4;
      data[o] = a; data[o + 1] = b; data[o + 2] = d; data[o + 3] = e;
    }
  }
  return data;
}

// Each cascade owns the band up to a comfortable margin below the next
// cascade's fundamental, so the four spectra tile k-space without overlap.
export function bandLimitsOf(L, C, c) {
  const low = c === 0 ? 0.0 : (2 * Math.PI / L[c]) * 6.0;
  const high = c === C - 1 ? 1e9 : (2 * Math.PI / L[c + 1]) * 6.0;
  return [low, high];
}

export function kCharOf(L, C, N, c) {
  const [lo, hi] = bandLimitsOf(L, C, c);
  const top = Math.min(hi, Math.PI * N / L[c]);
  return lo > 0 ? Math.sqrt(lo * top) : 0.75 * top;
}

export function choppinessOf(C, c, p) {
  const t = C > 1 ? (C - 1 - c) / (C - 1) : 1;
  return p.choppiness * (1 + (p.choppyLong - 1) * t);
}

// Per-cascade weight of the folding test that drives spray. Droplets tear off
// waves that can carry a plunging crest; anything shorter than `scale` metres
// just wrinkles. Rolls off over two octaves above that.
//
// Hoisted verbatim out of Ocean.breakWeights so a simulation that is not this
// class - src/gpu/tsl/sim-driver.js - can reuse it rather than re-derive it.
export function breakWeightsOf(L, C, N, scale) {
  const kb = 2 * Math.PI / Math.max(scale, 0.2);
  const w = new Float32Array(4);
  for (let c = 0; c < C; c++) {
    const [lo, hi] = bandLimitsOf(L, C, c);
    const nyq = Math.PI * N / L[c];
    const kMid = c === 0 ? Math.min(hi, nyq) * 0.3 : Math.sqrt(lo * Math.min(hi, nyq));
    const t = Math.log(kMid / kb) / Math.log(4.0);
    w[c] = 1 - Math.min(Math.max(t, 0), 1);
  }
  return w;
}

// Mip level per cascade whose footprint is `scale` metres across, i.e. the
// level at which the breaking test sees a breaker-sized patch of surface
// rather than one texel of ripple. Cascades whose texels are already coarser
// than a breaker clamp to level 0.
//
// Hoisted verbatim out of Ocean.breakLods, same reason as breakWeightsOf.
export function breakLodsOf(L, C, N, scale) {
  const lods = new Float32Array(4);
  const maxLod = Math.log2(N) - 2;
  for (let c = 0; c < C; c++) {
    const texel = L[c] / N;
    lods[c] = Math.min(Math.max(Math.log2(Math.max(scale, 0.05) / texel), 0), maxLod);
  }
  return lods;
}

