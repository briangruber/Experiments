// Hash, value noise and fbm — the TSL port of NOISE_GLSL in src/shaders/sky.js.
//
// One source, both backends: Three compiles these node graphs to WGSL on
// WebGPU and to GLSL on WebGL2, which is the whole point (see
// docs/webgpu-port.md). No wgslFn, no glslFn — a raw-source node compiles for
// exactly one backend and would put the fallback back where it started.
//
// Every constant here is load-bearing. The hash multipliers (0.1031, 0.1030,
// 0.0973), the two different dot offsets (33.33 in the 1D/2D hashes, 31.32 in
// hash13), the lacunarities (2.02, 2.03, 2.11) and the per-octave offsets
// (7.13, vec2(5.1,-3.7)) are not tuning knobs — they are the field. A changed
// digit does not degrade the noise, it changes the sky. They are transcribed
// digit for digit from the GLSL and must stay that way.
//
// Consumers: the sky background pass (clouds, cirrus, the LUT dither),
// water.js and spray.js all inline NOISE_GLSL today. Each function is exported
// on its own so a port can take the two it needs instead of a monolith.
//
// ---------------------------------------------------------------------------
// THREE THINGS A READER WILL OTHERWISE GET WRONG
//
// 1. `mix` is used in its FUNCTION form, `mix(a, b, t)`, deliberately. Do not
//    "simplify" it to the method form. In TSL the method chaining is
//    `mixElement = (t, e1, e2) => mix(e1, e2, t)` — the RECEIVER IS THE
//    INTERPOLANT, so `a.mix(b, t)` means mix(b, t, a), not mix(a, b, t).
//    (three r185, `addMethodChaining('mix', mixElement)`.) The function form
//    reads exactly like the GLSL it came from and cannot be got backwards.
//    `.smoothstep(lo, hi)`, `.step(edge)` and `.clamp(lo, hi)` DO take the
//    receiver as the value, so those are safe either way; they are written in
//    function form here only for consistency with the GLSL.
//
// 2. The GLSL octave loops are `for (i = 0; i < CAP; i++) { if (i >= oct) break; ... }`.
//    An early `break` does not translate directly, so the break is restructured
//    as a guard: the loop always runs to its fixed CAP and the whole body sits
//    inside `If(i.lessThan(oct), ...)`. That is exactly equivalent — on the
//    skipped iterations the GLSL body never ran either, so `a`, `s`, `n` and `p`
//    are untouched — and it preserves the CAP, which a dynamic `end: oct` would
//    silently drop (GLSL runs at most CAP octaves however large `oct` gets).
//    It also uses only `Loop` + `If`. A fragment-stage `Loop` is verified on the
//    WebGL2 backend in prototypes/tsl-material-probe.html and `Loop` + `If`
//    together on WebGPU in prototypes/tsl-mechanics-probe.html, and the
//    side-by-side run described below exercises both here. `Break()` is exported
//    by three/tsl but is not verified anywhere in this repo, which is the other
//    reason it is not used.
//
// 3. TSL does not do GLSL's implicit int→float promotion, so every mixed
//    expression is explicit. Loop indices are int nodes; `oct` is normalised
//    with `int(oct)` so a caller may pass an int node, a float node or a plain
//    JS number.
//
// GLSL mutates its parameters (`p *= 2.02`). WGSL function parameters are
// immutable, so every mutated parameter is copied into a local with `.toVar()`
// first. `p.xy += 7.13` is written as `p += vec3(7.13, 7.13, 0.0)`, which is
// the identical operation without needing swizzle assignment.
//
// ---------------------------------------------------------------------------
// MEASURED, not asserted. Every function below was rendered side by side with
// NOISE_GLSL running on the same GPU (raw WebGL2 context vs this module through
// WebGPURenderer's WebGL2 backend), 32 samples each, and the two agree
// BIT-EXACTLY - worst absolute difference 0.0, not "within tolerance". The
// octave sweep was run with oct = 0..10 so the clamp at the loop cap is covered,
// and bayer4 was checked against the literal BAYER16 table. The negative control
// (one octave count changed) fails the same comparison, so the check is not
// vacuous. The WebGPU half cannot be rendered in this sandbox - Chromium 141
// rejects the swizzle property Three r185 passes to createView, see
// docs/webgpu-port.md - so the WGSL output needs one run on a real browser.

import { Fn, If, Loop, float, int, vec2, vec3, mix, smoothstep, clamp } from 'three/tsl';

// ---- hashes -----------------------------------------------------------------
// Dave Hoskins' hash family. The `p3 += dot(p3, p3.yzx + k)` step is what
// decorrelates the channels; the constant differs between hash12/hash22 (33.33)
// and hash13 (31.32) in the original and that difference is preserved.

// float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
export const hash11 = Fn(([p]) => {
  const q = float(p).mul(0.1031).fract().toVar();
  q.mulAssign(q.add(33.33));
  q.mulAssign(q.add(q));
  return q.fract();
});

// float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
export const hash12 = Fn(([p]) => {
  // vec3(p.xyx), written out so the vec2→vec3 swizzle expansion is explicit.
  const p3 = vec3(p.x, p.y, p.x).mul(0.1031).fract().toVar();
  p3.addAssign(p3.dot(p3.yzx.add(33.33)));
  return p3.x.add(p3.y).mul(p3.z).fract();
});

// vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
// Note 0.1031 / 0.1030 / 0.0973 are three *different* multipliers - the near
// pair is intentional, it is what makes the two outputs independent.
export const hash22 = Fn(([p]) => {
  const p3 = vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973)).fract().toVar();
  p3.addAssign(p3.dot(p3.yzx.add(33.33)));
  return p3.xx.add(p3.yz).mul(p3.zy).fract();
});

// float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
export const hash13 = Fn(([p]) => {
  const q = p.mul(0.1031).fract().toVar();
  q.addAssign(q.dot(q.zyx.add(31.32)));
  return q.x.add(q.y).mul(q.z).fract();
});

// ---- value noise ------------------------------------------------------------

// 3D value noise: 8 lattice hashes, Hermite-smoothed trilinear blend.
export const vnoise = Fn(([p]) => {
  const i = p.floor().toVar();
  const f = p.fract().toVar();
  // f = f*f*(3.0-2.0*f)  - the smoothstep quintic's cheaper cubic cousin.
  f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));

  const n000 = hash13(i);                             // i + vec3(0,0,0)
  const n100 = hash13(i.add(vec3(1.0, 0.0, 0.0)));
  const n010 = hash13(i.add(vec3(0.0, 1.0, 0.0)));
  const n110 = hash13(i.add(vec3(1.0, 1.0, 0.0)));
  const n001 = hash13(i.add(vec3(0.0, 0.0, 1.0)));
  const n101 = hash13(i.add(vec3(1.0, 0.0, 1.0)));
  const n011 = hash13(i.add(vec3(0.0, 1.0, 1.0)));
  const n111 = hash13(i.add(vec3(1.0, 1.0, 1.0)));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z,
  );
});

// 2D value noise: 4 lattice hashes, Hermite-smoothed bilinear blend.
export const vnoise2 = Fn(([p]) => {
  const i = p.floor().toVar();
  const f = p.fract().toVar();
  f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));

  const a = hash12(i);                                // i + vec2(0,0)
  const b = hash12(i.add(vec2(1.0, 0.0)));
  const c = hash12(i.add(vec2(0.0, 1.0)));
  const d = hash12(i.add(vec2(1.0, 1.0)));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
});

// ---- fbm --------------------------------------------------------------------
// The sum is normalised by the accumulated amplitude, so dropping octaves
// changes the detail but not the mean level - which is why every threshold
// downstream can be written against a fixed range.
//
// CAPS: fbm3 8, fbm2 6, billow 6. These are the GLSL loop bounds and they are
// the hard ceiling on octaves regardless of `oct`. See note 2 in the header for
// why the cap survives as a fixed `end` with an `If` guard rather than becoming
// a dynamic loop bound.

// float fbm3(vec3 p, int oct)  - lacunarity 2.02, +7.13 in xy each octave.
export const fbm3 = Fn(([p, oct]) => {
  const pv = p.toVar();
  const octN = int(oct).toVar();
  const a = float(0.5).toVar();
  const s = float(0.0).toVar();
  const n = float(0.0).toVar();

  Loop({ start: int(0), end: int(8) }, ({ i }) => {
    If(i.lessThan(octN), () => {          // GLSL: if (i >= oct) break;
      s.addAssign(a.mul(vnoise(pv)));
      n.addAssign(a);
      a.mulAssign(0.5);
      pv.mulAssign(2.02);
      // GLSL: p.xy += 7.13  - the z axis deliberately does not shift, so the
      // vertical structure of a cloud stays put while the horizontal pattern
      // decorrelates between octaves.
      pv.addAssign(vec3(7.13, 7.13, 0.0));
    });
  });

  return s.div(n.max(1e-4));
});

// float fbm2(vec2 p, int oct)  - lacunarity 2.03, offset vec2(5.1,-3.7).
export const fbm2 = Fn(([p, oct]) => {
  const pv = p.toVar();
  const octN = int(oct).toVar();
  const a = float(0.5).toVar();
  const s = float(0.0).toVar();
  const n = float(0.0).toVar();

  Loop({ start: int(0), end: int(6) }, ({ i }) => {
    If(i.lessThan(octN), () => {          // GLSL: if (i >= oct) break;
      s.addAssign(a.mul(vnoise2(pv)));
      n.addAssign(a);
      a.mulAssign(0.5);
      pv.assign(pv.mul(2.03).add(vec2(5.1, -3.7)));
    });
  });

  return s.div(n.max(1e-4));
});

// Worley-ish billow used for cloud erosion.
// float billow(vec3 p, int oct)  - lacunarity 2.11, no per-octave offset.
// abs(2n-1) folds the field about its midpoint, which is what turns smooth
// value noise into rounded cumuliform lobes; the final 1.0 - s inverts it so
// the lobes read as mass rather than as holes.
export const billow = Fn(([p, oct]) => {
  const pv = p.toVar();
  const octN = int(oct).toVar();
  const a = float(0.5).toVar();
  const s = float(0.0).toVar();
  const n = float(0.0).toVar();

  Loop({ start: int(0), end: int(6) }, ({ i }) => {
    If(i.lessThan(octN), () => {          // GLSL: if (i >= oct) break;
      s.addAssign(a.mul(vnoise(pv).mul(2.0).sub(1.0).abs()));
      n.addAssign(a);
      a.mulAssign(0.5);
      pv.mulAssign(2.11);
    });
  });

  return float(1.0).sub(s.div(n.max(1e-4)));
});

// ---- shared shaping helpers -------------------------------------------------
// These live in SKY_BG_FS in the GLSL rather than in NOISE_GLSL, but they are
// pure functions of a noise value and every consumer of the noise uses them
// (cloud density, the cirrus veil, the march dither). They belong next to the
// field they shape, not copied into each pass.

// float remap01(float x, float lo, float hi){ return clamp((x - lo) / max(hi - lo, 1e-4), 0.0, 1.0); }
// The max() guards a zero-width window; it is a divide-by-zero guard, not a
// tuning constant.
export const remap01 = Fn(([x, lo, hi]) => {
  return clamp(x.sub(lo).div(hi.sub(lo).max(1e-4)), 0.0, 1.0);
});

// float spread01(float x){ return smoothstep(0.28, 0.72, x); }
// Summed value noise is a near-Gaussian that only really occupies the middle
// third of [0,1]. Every threshold downstream assumes a full-range field, so
// stretch it once here instead of hand-tuning every constant against a hidden
// scale.
export const spread01 = Fn(([x]) => smoothstep(0.28, 0.72, x));

// float bayer4(vec2 c)  - the ordered 4x4 dither the cloud march offsets its
// first sample with. An ordered matrix, not a white-noise hash and not
// interleaved-gradient noise: the hash clumps into salt-and-pepper and IGN's
// frequency is far higher in x than in y, which combs a still frame into
// vertical stripes.
//
// The GLSL indexes a constant array:
//
//   const float BAYER16[16] = float[16](
//      0.0,  8.0,  2.0, 10.0,
//     12.0,  4.0, 14.0,  6.0,
//      3.0, 11.0,  1.0,  9.0,
//     15.0,  7.0, 13.0,  5.0);
//   float bayer4(vec2 c){ ivec2 p = ivec2(mod(c, 4.0)); return (BAYER16[p.y*4 + p.x] + 0.5) / 16.0; }
//
// This is the ONE function here that is not a line-for-line transcription, and
// the reason is portability: TSL's `array([...])` emits an array *constructor
// expression* at the use site, and indexing a value (rather than a variable) of
// array type with a runtime index is not something WGSL is guaranteed to accept.
// Rather than risk it, the table is reproduced in closed form.
//
// That is safe because this table is the standard recursive Bayer matrix
// M(2n) = [[4M, 4M+2],[4M+3, 4M+1]], whose closed form is the bit-reversed
// interleave of y with x^y:
//
//   v = x ^ y;   value = 8*(v&1) + 4*(y&1) + 2*((v>>1)&1) + ((y>>1)&1)
//
// Checked exhaustively against the 16 literal entries above for every (x,y) in
// [0,4)^2 - all 16 match. If you touch this, re-run that check; do not eyeball it.
export const bayer4 = Fn(([c]) => {
  // ivec2(mod(c, 4.0)). GLSL mod() is x - y*floor(x/y), which TSL's `.mod()`
  // reproduces on both backends (WGSL gets a tsl_mod polyfill with exactly that
  // definition), so a negative coordinate wraps the same way it does today.
  const m = c.mod(4.0).toVar();
  const x = int(m.x).toVar();
  const y = int(m.y).toVar();
  const v = x.bitXor(y).toVar();

  const idx = v.bitAnd(int(1)).mul(int(8))
    .add(y.bitAnd(int(1)).mul(int(4)))
    .add(v.shiftRight(int(1)).bitAnd(int(1)).mul(int(2)))
    .add(y.shiftRight(int(1)).bitAnd(int(1)));

  return float(idx).add(0.5).div(16.0);
});
