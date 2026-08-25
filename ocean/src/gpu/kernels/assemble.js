// Assemble: unpack the IFFT output into the displacement and slope fields, undo
// the DC-at-centre sign convention, apply the bound second harmonic, and compute
// the Jacobian that drives foam. WGSL port of ASSEMBLE_FS from
// src/shaders/oceanSim.js (step 3 of src/ocean.js:update()). This is a
// translation, not a redesign: every constant, sign, clamp and channel order is
// the one the GLSL had.
//
// BUFFER LAYOUT (the rule for every kernel in this directory)
//   Every field buffer is array<vec4<f32>>, one buffer per original render-target
//   attachment, indexed linearly as
//       idx = layer * N * N + y * N + x
//   with N = uN (the FFT size) and layer = the cascade index (uLayer). This
//   replaces sampler2DArray + texelFetch(tex, ivec3(id, layer), 0). Nothing in
//   this pass filters, so no sampler is involved.
//
//       src0     <- was uS0     (whichever of pingA/pongA the FFT ping-pong ended on)
//       src1     <- was uS1     (the matching pingB/pongB)
//       outDisp  <- was oDisp,  attachment 0 -> the `disp`  texture array
//       outSlope <- was oSlope, attachment 1 -> the `slope` texture array
//
//   src0/src1 are the *last written* pair of the FFT ping-pong, i.e. `srcA`/`srcB`
//   as they stand after the 2*log2(N) butterfly dispatches - not the ping buffers.
//   Getting that wrong reads a half-transformed field and looks like a plausible
//   but wrong ocean.
//
// CHANNEL PACKING IN / OUT - the reorder is easy to miss
//   Coming in (set up by TIME_EVOLVE, transformed by the FFT; two real signals ride
//   each complex channel, which is only valid because h(-k) = conj(h(k))):
//       a = src0 = vec4( D_x , D_z , D_y , dD_y/dx )
//       b = src1 = vec4( dD_y/dz , dD_x/dx , dD_z/dz , dD_x/dz )
//   Going out:
//       outDisp  = vec4( D_x , D_y , D_z , J )      <- note x,y,z, NOT the a.xyz order
//       outSlope = vec4( dD_y/dx , dD_y/dz , J , |slope|^2 )
//   The displacement swaps a.y and a.z on the way out. A straight copy of a.xyz
//   would put the height in the Z channel and the sea would shear sideways.
//
// CHOPPINESS - READ THIS BEFORE "FIXING" IT
//   ASSEMBLE_FS declares `uniform float uChoppy` and src/ocean.js sets it, but the
//   GLSL body NEVER references it. That is not an oversight to be corrected here:
//   the choppiness gain is already baked into D_x, D_z, dD_x/dx, dD_z/dz and
//   dD_x/dz by TIME_EVOLVE_FS (hDx/hDz/hXx/hZz/hXz are each multiplied by uChoppy
//   there). Scaling anything by uChoppy in this pass applies the gain twice - the
//   horizontal displacement squares up and the Jacobian folds far too early, which
//   reads as whitecaps everywhere. The field is kept in the params struct only so
//   the uniform block still matches the driver's uniform set; it is deliberately
//   unused, exactly as in the GLSL.
//
// JACOBIAN SIGN CONVENTION
//       J = (1 + dD_x/dx)(1 + dD_z/dz) - (dD_x/dz)^2
//   MINUS the squared cross term, and the cross term is dD_x/dz used twice - the
//   GLSL never computes a separate dD_z/dx because the Gerstner displacement comes
//   from a potential, so the mixed second derivatives are equal and the matrix is
//   symmetric. J = 1 is flat, J < 1 is horizontal compression, J < 0 is a folded
//   (overturning) surface. It is written raw: no abs(), no max(0, .), no 1 - J.
//   The foam pass consumes it as `x = -(J - 1)`, i.e. positive where the surface
//   folds, and src/ocean.js:measure() counts J < 0 as folded area - both of which
//   break if the sign or the offset is flipped here.
//
// PRECISION
//   GLSL `highp float` is f32. WGSL performs no implicit int->float promotion, so
//   every mixed expression carries an explicit f32()/u32(). The checkerboard parity
//   is integer arithmetic on non-negative texel coordinates, done in u32.
//
// DISPATCH
//   One invocation per texel; ceil(N/8) x ceil(N/8) x 1 per cascade, rebinding the
//   uniform block with that cascade's uKChar and uLayer - the same per-cascade loop
//   src/ocean.js:update() runs today. Unlike a fragment pass there is no implicit
//   clear and no scissor, so the bounds check is what keeps a padded dispatch from
//   writing into the next layer.
//
//   The GL path regenerates the mip chains of `disp` and `slope` after this pass,
//   and the foam pass depends on those mips (breaking kernel footprint, and the top
//   mip as <|grad h|^2>). Whatever runs this kernel still owes that reduction.

export const ASSEMBLE_WGSL = /* wgsl */`
// ------------------------------------------------- ported from GLSL COMMON
// ASSEMBLE_FS is prepended with COMMON; it happens to use none of it. Ported
// verbatim anyway so the block stays identical across kernels and nobody
// reinvents sqr() further down.
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
// Field order follows the GLSL uniform list, with uN added: the fragment pass got
// the resolution from gl_FragCoord / the texture dimensions, a flat buffer has to
// be told. uLayer was a GLSL "uniform int" but is only ever a non-negative cascade
// index, so u32 is the faithful (and wrap-free) choice. _pad* only rounds the block
// out to 32 bytes.
struct AssembleParams {
  uN      : f32,   // resolution
  uChoppy : f32,   // DELIBERATELY UNUSED - see the header. Already applied upstream.
  uKChar  : f32,   // energy-centre wavenumber of this cascade's band
  uStokes : f32,   // gain on the bound second harmonic
  uLayer  : u32,   // cascade index
  _pad0   : u32,
  _pad1   : u32,
  _pad2   : u32,
};

@group(0) @binding(0) var<uniform>             params   : AssembleParams;
@group(0) @binding(1) var<storage, read>       src0     : array<vec4<f32>>;  // was uS0
@group(0) @binding(2) var<storage, read>       src1     : array<vec4<f32>>;  // was uS1
@group(0) @binding(3) var<storage, read_write> outDisp  : array<vec4<f32>>;  // was oDisp
@group(0) @binding(4) var<storage, read_write> outSlope : array<vec4<f32>>;  // was oSlope

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let Nu : u32 = u32(params.uN);
  if (gid.x >= Nu || gid.y >= Nu) { return; }

  // GLSL: ivec2 id = ivec2(gl_FragCoord.xy) - the pixel-centre 0.5 truncates away,
  // so the integer texel coordinate is just the invocation id.
  // idx = layer * N * N + y * N + x
  let idx : u32 = params.uLayer * Nu * Nu + gid.y * Nu + gid.x;

  // Undo the DC-at-centre convention of the spectrum layout. Shifting the origin
  // by N/2 in k-space is a (-1)^(x+z) modulation in world space, so the whole
  // transform is un-shifted here for the price of one sign. Integer parity, in u32:
  // the texel coordinates are non-negative, so there is no wrapping subtlety.
  let s : f32 = select(-1.0, 1.0, ((gid.x + gid.y) & 1u) == 0u);

  // The sign multiplies the entire vec4: after the IFFT all four floats of each
  // attachment are real signals (the packed pairs have already separated), so they
  // all carry the same modulation.
  let a : vec4<f32> = src0[idx] * s;
  let b : vec4<f32> = src1[idx] * s;

  let Dx  : f32 = a.x;
  let Dz  : f32 = a.y;
  var Dy  : f32 = a.z;
  var dYx : f32 = a.w;
  var dYz : f32 = b.x;
  let dXx : f32 = b.y;
  let dZz : f32 = b.z;
  let dXz : f32 = b.w;

  // Bound second harmonic. A linear spectrum is symmetric about the mean plane -
  // the crest and the trough have the same curvature - and that symmetry is the
  // single loudest tell that a rendered sea is a sum of sinusoids. To second
  // order a Stokes wave carries eta2 = k(eta1^2 - <eta1^2>), which peaks the
  // crest and broadens the trough while adding almost nothing to the variance.
  // The correction is a pointwise function of the height, so its own derivative
  // is exact: d/dx (k eta^2) = 2 k eta eta_x, and the slope map stays consistent
  // with the geometry the vertex shader builds. Clamped because the expansion is
  // only valid while ka stays small and a steep cascade would otherwise fold.
  //
  // ORDER MATTERS: corr is a function of the UNCORRECTED Dy, and the slopes are
  // scaled by the same corr. Folding the update into Dy before reading it for the
  // slope factor would apply the correction one and a half times.
  let corr : f32 = clamp(params.uStokes * params.uKChar * Dy, -0.45, 0.45);
  Dy  = Dy + corr * Dy;
  dYx = dYx * (1.0 + 2.0 * corr);
  dYz = dYz * (1.0 + 2.0 * corr);

  // Jacobian of the horizontal displacement map. Symmetric by construction, hence
  // the single cross term squared and subtracted - see the header.
  let Jxx : f32 = 1.0 + dXx;
  let Jzz : f32 = 1.0 + dZz;
  let J   : f32 = Jxx * Jzz - dXz * dXz;

  outDisp[idx] = vec4<f32>(Dx, Dy, Dz, J);
  // The fourth channel carries the second moment of the slope. Mip filtering it
  // gives <|grad h|^2> over a footprint, which the surface shader turns into
  // filtered microfacet roughness instead of aliasing sparkle, and whose top mip
  // is the cascade's contribution to the total mean square slope. It uses the
  // Stokes-corrected slopes, because those are the slopes of the surface that is
  // actually drawn.
  outSlope[idx] = vec4<f32>(dYx, dYz, J, dYx * dYx + dYz * dYz);
}
`;
