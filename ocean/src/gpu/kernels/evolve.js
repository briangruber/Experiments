// Time evolution of the ocean spectrum: h0 -> h(k, t), packed into the four
// complex fields the IFFT will transform. WGSL port of TIME_EVOLVE_FS from
// src/shaders/oceanSim.js. Physics is unchanged - every constant, sign and
// clamp is the one the GLSL had.
//
// BUFFER LAYOUT (rule for every kernel in this directory)
//   All fields live in flat storage buffers of vec4<f32>, one buffer per
//   original render-target attachment, indexed linearly as
//       idx = layer * N * N + y * N + x
//   where N is the FFT size (uN) and `layer` is the cascade index (uLayer).
//   This replaces the sampler2DArray / texelFetch(tex, ivec3(id, layer), 0) of
//   the GLSL. Nothing here filters, so no sampler is involved.
//
//   h0Buf  <- the static h0 spectrum   (was uH0, a sampler2DArray)
//   out0   <- attachment 0             (was o0, the pingA target)
//   out1   <- attachment 1             (was o1, the pingB target)
//
// PACKING (as documented at the head of oceanSim.js)
//   out0 = vec4(c0, c1)  with  c0 = D_x      + i D_z
//                              c1 = D_y      + i dD_y/dx
//   out1 = vec4(c2, c3)  with  c2 = dD_y/dz  + i dD_x/dx
//                              c3 = dD_z/dz  + i dD_x/dz
//   Two real signals ride each complex transform, which is only valid because
//   every transform output is exactly real - i.e. because h(-k) = conj(h(k)).
//
// THE CONJUGATE PAIR - read this before "fixing" the indexing
//   This pass does NOT fetch a mirrored texel. h0Buf[idx].xy is h0(k) and
//   h0Buf[idx].zw is h0(-k): the init pass already paired them by reading the
//   mirrored texel of the *same* noise field at
//       idm = (ivec2(N) - id) & (N - 1)
//   which, for the power-of-two N this pipeline uses, is exactly (N - x) % N
//   and (N - y) % N - NOT N - x, which would run off the end at x = 0 and,
//   worse, silently pair index 0 with index N. Both partners therefore arrive
//   in one texel and the Hermitian pair is formed here purely arithmetically:
//       h = h0(k) e^{+iwt} + conj(h0(-k)) e^{-iwt}
//   Two independent draws for the two partners leave an imaginary residue that
//   leaks D_z into D_x and dD_y/dx into the height itself.
//
// PRECISION NOTES
//   GLSL `highp float` is f32. WGSL has no implicit int->float promotion, so
//   every mixed expression below carries an explicit f32()/u32(). The buffer
//   index arithmetic is u32 throughout; `uLayer` was a GLSL `int` but is only
//   ever a non-negative cascade index, so u32 is the faithful (and wrap-free)
//   choice.
//
// DISPATCH
//   One invocation per texel; dispatch ceil(N/8) x ceil(N/8) x 1 per cascade,
//   rebinding the uniform block with that cascade's uL, uChoppy and uLayer -
//   the same per-cascade loop src/ocean.js:update() runs today.

export const TIME_EVOLVE_WGSL = /* wgsl */`
// ------------------------------------------------- ported from GLSL COMMON
const PI  : f32 = 3.14159265358979;
const TAU : f32 = 6.28318530717959;
const G   : f32 = 9.80665;

fn cmul(a : vec2<f32>, b : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
fn cconj(a : vec2<f32>) -> vec2<f32> { return vec2<f32>(a.x, -a.y); }
fn cexp(t : f32) -> vec2<f32> { return vec2<f32>(cos(t), sin(t)); }
fn sqr(x : f32) -> f32 { return x * x; }

// ------------------------------------------------------------- interface
// Field order matches the GLSL uniform list; _pad only exists to round the
// block to 32 bytes. uLayer was a GLSL "uniform int uLayer".
struct EvolveParams {
  uN          : f32,   // resolution
  uL          : f32,   // patch size (m) of this cascade
  uTime       : f32,   // seconds of wave time
  uDepth      : f32,   // m
  uChoppy     : f32,   // horizontal (Gerstner) displacement gain
  uLoopPeriod : f32,   // s; <= 0.5 disables the loop quantisation
  uLayer      : u32,   // cascade index
  _pad        : u32,
};

@group(0) @binding(0) var<uniform>              params : EvolveParams;
@group(0) @binding(1) var<storage, read>        h0Buf  : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write>  out0   : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write>  out1   : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let Nu : u32 = u32(params.uN);
  if (gid.x >= Nu || gid.y >= Nu) { return; }

  // idx = layer * N * N + y * N + x
  let idx : u32 = params.uLayer * Nu * Nu + gid.y * Nu + gid.x;

  // GLSL: ivec2 id = ivec2(gl_FragCoord.xy) -- the pixel-centre 0.5 truncates
  // away, so the integer texel coordinate is just the invocation id.
  let id : vec2<f32> = vec2<f32>(f32(gid.x), f32(gid.y));
  let nm : vec2<f32> = id - params.uN * 0.5;
  let k  : vec2<f32> = TAU * nm / params.uL;
  let kk : f32       = length(k);

  // DC mode: no direction, and nothing to evolve. The GLSL wrote zeros rather
  // than discarding, so the target is fully defined; do the same here.
  if (kk < 1e-6) {
    out0[idx] = vec4<f32>(0.0);
    out1[idx] = vec4<f32>(0.0);
    return;
  }
  let kn : vec2<f32> = k / kk;

  // Dispersion with the capillary term and finite depth. 370 rad/m is the
  // capillary wavenumber; the tanh argument is clamped at 20 because tanh has
  // saturated there and larger values only cost precision.
  let cap : f32 = 1.0 + sqr(kk / 370.0);
  var w   : f32 = sqrt(G * kk * cap * tanh(min(kk * params.uDepth, 20.0)));
  // Optional quantisation to make the whole sea loop seamlessly. Snapping every
  // omega onto a multiple of the fundamental 2*pi/T makes every mode share the
  // period T, so the entire field repeats exactly after T seconds.
  if (params.uLoopPeriod > 0.5) {
    let w0 : f32 = TAU / params.uLoopPeriod;
    w = floor(w / w0 + 0.5) * w0;
  }

  // .xy = h0(k), .zw = h0(-k), both written by the init pass at this texel.
  let h0 : vec4<f32> = h0Buf[idx];
  let e  : vec2<f32> = cexp(w * params.uTime);
  let h  : vec2<f32> = cmul(h0.xy, e) + cmul(cconj(h0.zw), cconj(e));

  let ih : vec2<f32> = vec2<f32>(-h.y, h.x);      // i*h

  let hDy : vec2<f32> = h;
  let hDx : vec2<f32> = -ih * kn.x * params.uChoppy;
  let hDz : vec2<f32> = -ih * kn.y * params.uChoppy;
  let hYx : vec2<f32> = ih * k.x;
  let hYz : vec2<f32> = ih * k.y;
  let hXx : vec2<f32> = h * (k.x * k.x / kk) * params.uChoppy;
  let hZz : vec2<f32> = h * (k.y * k.y / kk) * params.uChoppy;
  let hXz : vec2<f32> = h * (k.x * k.y / kk) * params.uChoppy;

  // Each pair rides one complex channel: real part from the first field,
  // imaginary part from the second, the second pre-multiplied by i.
  out0[idx] = vec4<f32>(hDx + vec2<f32>(-hDz.y, hDz.x),
                        hDy + vec2<f32>(-hYx.y, hYx.x));
  out1[idx] = vec4<f32>(hYz + vec2<f32>(-hXx.y, hXx.x),
                        hZz + vec2<f32>(-hXz.y, hXz.x));
}
`;
