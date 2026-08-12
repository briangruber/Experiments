// Temporal foam accumulation - WGSL port of FOAM_FS (src/shaders/oceanSim.js),
// driven the way src/ocean.js:_foamStep() drives it.
//
// This is a translation, not a redesign. Every decay constant, every gate, every
// clamp and the breaking test itself are the ones the GLSL has, and the comments
// explaining *why* each number is what it is have been carried across with them.
// If you want to change the physics, change the GLSL and re-translate, or the two
// backends drift.
//
// What it computes, per texel of one cascade: two coupled foam populations
// integrated one step forward in time. Stage one is the bright crest foam born
// the instant this cascade's Jacobian folds (uFreshDecay, seconds); stage two is
// the thin dissipated raft it decays into, which drifts, spreads, streaks and is
// thinned to zero in finite time (uDecay + uThin). Output is
//     vec4(vec3(total, fresh, residue) * uWeight, x * x)
// where x is the crest-aligned compression that drove the breaking test, and its
// square is what the NEXT step's top mip averages into <x^2>.
//
// ---------------------------------------------------------------------------
// READ AND WRITE BUFFERS MUST BE DISTINCT. THIS PASS PING-PONGS.
//   The pass reads its own previous frame - and not merely at its own texel:
//     * the drift tap reads at uv - duv,
//     * the four diffusion taps read at uv - duv +- (wd*alongUV, wn*acrossUV),
//     * `cvar` reads the 1x1 top mip, i.e. a reduction over the WHOLE previous
//       field of this layer.
//   So `prevFoam` and `foamOut` must be two different allocations, swapped after
//   every step, exactly like ocean.js's this.foam[0] / this.foam[1] and foamIdx.
//   Writing in place is a race with no fence that can save it: neighbouring
//   invocations would read texels this dispatch has already overwritten, the
//   result would depend on workgroup scheduling, and the top-mip normaliser would
//   be a reduction over a half-updated field. A fragment pass got this for free
//   (you cannot bind a render target as a texture); compute does not.
//
// ---------------------------------------------------------------------------
// BUFFER LAYOUT (the rule for every kernel in this directory)
//   Every field buffer is array<vec4<f32>>, indexed linearly as
//       idx = layer * N * N + y * N + x
//   with N = uN (the FFT size) and layer = the cascade index (uLayer). One buffer
//   per original render-target attachment; this pass had one attachment, so one
//   output buffer. Nothing about the write side departs from that rule.
//
//   THE READ SIDE NEEDS MIPS, so it extends the rule. FOAM_FS is the one pass in
//   the pipeline that does NOT texelFetch: it reads uDisp, uSlope and uPrevFoam
//   through textureLod at fractional LOD, on textures created LINEAR + REPEAT +
//   mips, which in gl.js means GL_LINEAR_MIPMAP_LINEAR - trilinear, wrapping.
//   That filtering is not incidental decoration, it IS the breaking test:
//     * the fold field is read at the mip whose footprint is a breaker, because a
//       single folding texel is a wrinkle and thresholding one texel at a time
//       makes confetti;
//     * the LOD-32 reads are the 1x1 top mip, i.e. the tile mean, which is what
//       makes the threshold scale-free;
//     * the drift and diffusion taps land between texels by construction.
//   So the three read buffers are MIP PYRAMIDS, packed level after level:
//       S(l)          = max(N >> l, 1)                     side of level l
//       levelBase(0)  = 0
//       levelBase(l+1)= levelBase(l) + C * S(l) * S(l)     C = uCascadeCount
//       idx           = levelBase(l) + layer*S(l)*S(l) + y*S(l) + x
//   Level 0 of that is byte-for-byte the plain rule above, so the assemble kernel
//   can write straight into the level-0 region of the disp/slope pyramids and this
//   kernel's own output is the level-0 region of the next foam pyramid.
//
//   Bindings, and what each was in the GLSL:
//       prevFoam  <- uPrevFoam  (mip pyramid, previous step's field)
//       dispMip   <- uDisp      (mip pyramid; only .w, the Jacobian, is read)
//       slopeMip  <- uSlope     (mip pyramid; .xy = slope, .w = |slope|^2)
//       foamOut   -> fragColor  (level 0 only, this cascade's layer only)
//
//   uCascadeCount was DEAD in the GLSL - declared and never referenced, so
//   gl.js's setUniforms silently skipped it (`if (!info) continue`). Here it is
//   load-bearing: it is the layer stride of every level above 0. A port that
//   leaves it at zero gets a pyramid that reads level 0 for every LOD and a
//   breaking test with no normaliser. Check it is actually being uploaded.
//
//   THE ALTERNATIVE, which is arguably the better engineering: bind disp, slope
//   and prevFoam as texture_2d_array<f32> with a filtering sampler (REPEAT,
//   min filter linear-mipmap-linear) and use textureSampleLevel, which hands the
//   trilinear back to the texture units and drops ~150 lines below. That was not
//   taken here because the porting contract for this directory is storage buffers
//   of vec4<f32>, and because it would make this the only kernel needing a
//   sampler and a mip-capable texture. If you switch, delete sampleLod/bilinear
//   wholesale rather than keeping both paths.
//
// ---------------------------------------------------------------------------
// FILTERING, REPRODUCED EXACTLY
//   bilinear(): GL texel space is p = uv * S - 0.5; the four taps are floor(p) and
//   floor(p)+1, weighted by fract(p). REPEAT wrapping is `& (S - 1)` on the signed
//   texel index - S is a power of two, and i32 two's complement makes that the
//   correct modulo for negative indices too (-1 & 255 = 255). The offsets really
//   do leave the tile: at bs = 30 m the crest kernel reaches two whole periods
//   past the edge of the 17.3 m cascade.
//   sampleLod(): clamp the LOD to [0, log2(N)] (GL clamps to the level count the
//   texture was created with, floor(log2(N)) + 1 levels), then blend levels
//   floor and floor+1 by the fraction. LOD 32.0 therefore lands on the 1x1 level,
//   which is the whole point of writing 32.0.
//   The pyramids must be plain 2x2 box averages - what generateMipmap produces -
//   or the LOD-32 reads stop being means and the normalisation is wrong.
//
// ---------------------------------------------------------------------------
// DRIVER NOTES (all of this is already in ocean.js; none of it changes)
//   * One dispatch per cascade, ceil(N/8) x ceil(N/8) x 1, rebinding uLayer, uL
//     and uWeight. The foam loop runs AFTER every cascade's assemble, because the
//     breaking test needs a current displacement field.
//   * REBUILD THE FOAM PYRAMID AFTER EVERY STEP, before the next one. The
//     scale-free threshold reads <x^2> off the top mip of the step just written;
//     ocean.js calls generateMipmap at the end of every _foamStep for exactly
//     that reason, spin-up steps included.
//   * Spin-up: after a spectrum rebuild ocean.js runs 30 extra steps at dt = 0.3
//     over a frozen wave field so the raft reaches equilibrium coverage instead of
//     fading up over the first ten seconds. Per-frame dt is min(dt*timeScale, 0.1)
//     - foam ages in wave time, not wall time.
//   * ONE-FRAME-STALE disp/slope MIPS. ocean.js regenerates the disp and slope
//     mip chains AFTER the foam loop, not before it, so every level above 0 that
//     foldAt() reads is from the previous frame (and on the first frame after a
//     rebuild, from a never-populated chain). If the WebGPU driver reduces those
//     pyramids eagerly - which is the obvious thing to do - the foam field will
//     differ from the GL path. It will probably differ for the better, but it is a
//     behaviour change and it belongs in a commit of its own, not smuggled in
//     under a port.
//
// PRECISION
//   GLSL `highp float` is f32; WGSL does no implicit int->float promotion, so
//   every mixed expression below carries an explicit f32()/u32(). Index arithmetic
//   is u32 (or i32 where a tap can go negative before wrapping). Two deliberate
//   departures, neither of which is a physics change: the GL slope and foam
//   textures are RGBA16F and these buffers are f32, and hardware bilinear uses
//   fixed-point subtexel weights where this uses full f32. Expect small numerical
//   differences from the GL path; do not expect bit equality, unlike the FFT.
//   N must be a power of two (the FFT requires it anyway) - the wrap mask and
//   firstTrailingBit both depend on it.

export const FOAM_WGSL = /* wgsl */`
// ------------------------------------------------------------------- interface
// Field order matches the GLSL uniform list. uPatch and uCompLod were
// "uniform float uPatch[4]" / "uCompLod[4]" indexed by uLayer; a vec4 is the same
// four floats and indexes the same way (max 4 cascades, as in the GLSL).
// uLayer / uCascadeCount were GLSL "uniform int"; both are non-negative, so u32 is
// the faithful and wrap-free choice.
// The block packs tight - two vec4s then twenty scalar words, 112 bytes, already a
// multiple of 16 - so it uploads as one 28-word buffer with no interior padding.
struct FoamParams {
  uPatch        : vec4<f32>,  // patch size (m) per cascade  = ocean.js patchSizes
  uCompLod      : vec4<f32>,  // breaking-kernel mip per cascade = breakLods()
  uLayer        : u32,        // cascade index
  uCascadeCount : u32,        // layer stride of every mip level above 0 - see header
  uDt           : f32,        // s of wave time this step
  uCutoff       : f32,        // breaking threshold, in sigmas of x (probit of W)
  uSoft         : f32,        // half-width of the threshold, same units
  uDecay        : f32,        // raft exponential decay rate (1/s)
  uFreshDecay   : f32,        // crest foam decay rate (1/s); also the raft source
  uInject       : f32,        // gain from fold fraction to newborn area fraction
  uThin         : f32,        // linear raft sink (1/s) - the film killer
  uSpreadRate   : f32,        // diffusion blend rate (1/s)
  uWeight       : f32,        // this cascade's share of the foam budget
  uDrift        : f32,        // surface drift speed (m/s) along the wind
  uWindDir      : f32,        // radians
  uN            : f32,        // resolution
  uL            : f32,        // patch size (m) of this cascade
  uFaceBias     : f32,        // 0..1 strength of the forward-face gate
  uBreakScale   : f32,        // breaker size (m)
  uCrestAniso   : f32,        // along-crest stretch of the breaking kernel
  uRidge        : f32,        // 0..1 strength of the across-crest ridge gate
  uBreakup      : f32,        // roughness modulation of the threshold
};

@group(0) @binding(0) var<uniform>             params   : FoamParams;
@group(0) @binding(1) var<storage, read>       prevFoam : array<vec4<f32>>;  // mip pyramid
@group(0) @binding(2) var<storage, read>       dispMip  : array<vec4<f32>>;  // mip pyramid
@group(0) @binding(3) var<storage, read>       slopeMip : array<vec4<f32>>;  // mip pyramid
@group(0) @binding(4) var<storage, read_write> foamOut  : array<vec4<f32>>;  // level 0 only

// Which pyramid a sample comes from. These stand in for the sampler2DArray
// arguments of the GLSL; every call site passes a constant, so the compiler folds
// the branch away. (A ptr<storage, ...> parameter would read better but needs the
// unrestricted_pointer_parameters language feature, which this file does not
// assume.)
const SRC_DISP  : u32 = 0u;
const SRC_SLOPE : u32 = 1u;
const SRC_FOAM  : u32 = 2u;

// Offsets of the breaking kernel along the crest line, in units of the breaker
// scale times the crest anisotropy. (GLSL: const float CT[5].)
const CT : array<f32, 5> = array<f32, 5>(-1.0, -0.5, 0.0, 0.5, 1.0);

// ------------------------------------------------------- pyramid addressing
// See the header. Level 0 is exactly layer*N*N + y*N + x.
fn levelSide(level : u32) -> u32 { return max(u32(params.uN) >> level, 1u); }

fn maxLevel() -> u32 {
  // N is a power of two, so this is log2(N). gl.js allocates
  // floor(log2(N)) + 1 levels, i.e. 0 .. log2(N), the last one 1x1.
  return firstTrailingBit(u32(params.uN));
}

fn levelBase(level : u32) -> u32 {
  var b : u32 = 0u;
  var s : u32 = u32(params.uN);
  for (var i : u32 = 0u; i < level; i = i + 1u) {
    b = b + params.uCascadeCount * s * s;
    s = max(s >> 1u, 1u);
  }
  return b;
}

fn texelOf(src : u32, i : u32) -> vec4<f32> {
  if (src == SRC_DISP)  { return dispMip[i]; }
  if (src == SRC_SLOPE) { return slopeMip[i]; }
  return prevFoam[i];
}

// GL_REPEAT. The mask is the modulo because the side is a power of two, and it is
// the correct modulo for negative x as well: -1 & (S-1) = S-1.
fn wrapTexel(v : i32, side : u32) -> u32 {
  return u32(v & (i32(side) - 1));
}

// ------------------------------------------------------ trilinear reconstruction
// What textureLod() on a LINEAR_MIPMAP_LINEAR + REPEAT sampler2DArray does.
fn bilinear(src : u32, layer : u32, uv : vec2<f32>, level : u32) -> vec4<f32> {
  let side = levelSide(level);
  let base = levelBase(level) + layer * side * side;

  // GL texel space: the sample point sits half a texel inside the corner.
  let p  = uv * f32(side) - 0.5;
  let fl = floor(p);
  let f  = p - fl;

  let x0 = wrapTexel(i32(fl.x),        side);
  let x1 = wrapTexel(i32(fl.x) + 1,    side);
  let y0 = wrapTexel(i32(fl.y),        side);
  let y1 = wrapTexel(i32(fl.y) + 1,    side);

  let c00 = texelOf(src, base + y0 * side + x0);
  let c10 = texelOf(src, base + y0 * side + x1);
  let c01 = texelOf(src, base + y1 * side + x0);
  let c11 = texelOf(src, base + y1 * side + x1);

  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn sampleLod(src : u32, layer : u32, uv : vec2<f32>, lod : f32) -> vec4<f32> {
  let lmax = f32(maxLevel());
  // GL clamps the explicit LOD to the levels the texture actually has, which is
  // why the LOD-32 reads below land on the 1x1 level rather than out of bounds.
  let l  = clamp(lod, 0.0, lmax);
  let l0 = floor(l);
  let t  = l - l0;
  // Not an approximation: mix(a, a, 0) is a. It skips four redundant fetches on
  // the six integer-LOD reads per texel, which is most of them.
  if (t == 0.0) { return bilinear(src, layer, uv, u32(l0)); }
  let l1 = min(l0 + 1.0, lmax);
  return mix(bilinear(src, layer, uv, u32(l0)),
             bilinear(src, layer, uv, u32(l1)), t);
}

// (J - 1) for THIS cascade at one world point, at the mip whose footprint is a
// breaker: a single folding texel is a wrinkle, not whitewater, and
// thresholding one texel at a time produces confetti that never aggregates.
//
// It has to be this cascade alone. Summing the fold of every cascade is better
// physics - the Jacobian of the summed displacement really is 1 + sum(J_c - 1) -
// but the result is written into a texture the surface shader tiles with period
// uPatch[uLayer], and a field built from four non-commensurate cascades has no
// such period. Stamping it out on that grid printed a visible 17 m lattice of
// whitecaps across the whole sea. Only a function of this cascade shares this
// cascade's period, so only that can live in this buffer. The cross-scale
// modulation - short waves breaking on the back of a swell - belongs in the
// surface shader, where the combined field is available per pixel and unbounded.
fn foldAt(wpos : vec2<f32>) -> f32 {
  return sampleLod(SRC_DISP, params.uLayer,
                   wpos / params.uPatch[params.uLayer],
                   max(params.uCompLod[params.uLayer] - 1.0, 0.0)).w - 1.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let Nu = u32(params.uN);
  // A fragment pass got its bounds from the viewport; a dispatch rounded up to
  // the workgroup size runs past the grid, and the store would land on a real
  // texel of the next row.
  if (gid.x >= Nu || gid.y >= Nu) { return; }

  let layer  = params.uLayer;
  let outIdx = layer * Nu * Nu + gid.y * Nu + gid.x;   // level 0: layer*N*N + y*N + x

  // GLSL: ivec2 id = ivec2(gl_FragCoord.xy) - the pixel-centre 0.5 truncates
  // away, so the integer texel coordinate is just the invocation id, and the
  // +0.5 below puts uv back at the texel centre.
  let idf   = vec2<f32>(f32(gid.x), f32(gid.y));
  let uv    = (idf + 0.5) / params.uN;
  let world = uv * params.uL;
  let wd    = vec2<f32>(cos(params.uWindDir), sin(params.uWindDir));
  let wn    = vec2<f32>(-wd.y, wd.x);
  let bs    = max(params.uBreakScale, 0.2);

  // A breaker is a LINE event, not a disc: the tumbling region runs tens of
  // metres along the crest and only a fraction of a wavelength across it. An
  // isotropic low-pass of the fold field therefore answers the wrong question,
  // and thresholding its broad round maxima is exactly why the whitecaps came
  // out as identical circular rafts with no crest alignment. Averaging along the
  // crest and testing across it turns the same statistics into crest-aligned
  // strips. The offsets are taken perpendicular to the wind because that is the
  // direction the dominant crests run.
  var ct = CT;                       // a var so the loop index can be dynamic
  var comp : f32 = 0.0;
  for (var t : u32 = 0u; t < 5u; t = t + 1u) {
    comp = comp + foldAt(world + wn * (ct[t] * bs * params.uCrestAniso));
  }
  comp = comp * 0.2;
  let x = -comp;                              // positive where the surface folds

  // Ridge test across the crest. Water only tumbles where the fold is at its
  // maximum in the direction the wave is travelling; a metre either side of that
  // the same surface is merely steep. Without it the strip above is as wide as
  // the kernel and the raft still reads as a slab.
  let xf = -foldAt(world + wd * bs);
  let xb = -foldAt(world - wd * bs);
  let crestOff = x - max(xf, xb);

  // Own cascade only, for the same periodicity reason as foldAt.
  // ("patch" alone is a WGSL reserved keyword.)
  let patchL = params.uPatch[layer];
  let grad   = sampleLod(SRC_SLOPE, layer, world / patchL,
                         max(params.uCompLod[layer] - 1.0, 0.0)).xy;

  // Scale-free threshold. The previous frame wrote x*x into channel w, so the
  // top mip of the foam texture is <x^2> over the whole patch and the cutoff can
  // be expressed in units of the sea's own RMS compression. An absolute
  // Jacobian threshold cannot work: a steeper sea trivially exceeds it
  // everywhere, which is how force 10 became a hundred percent white-out.
  // Each cascade now folds on its own account, so each normalises by its own
  // variance: the top mip of this layer's w channel is <x^2> over this tile.
  let cvar = sampleLod(SRC_FOAM, layer, uv, 32.0).w;
  // The GLSL ternary is written as an if so inverseSqrt(0) is never evaluated.
  var inv : f32 = 0.0;
  if (cvar > 1e-9) { inv = inverseSqrt(cvar); }
  let xn = x * inv;
  // In the same sigma units, so the ridge gate keeps its meaning as the sea
  // state changes.
  let ridge = mix(1.0, smoothstep(-0.25, 0.30, crestOff * inv),
                  clamp(params.uRidge, 0.0, 1.0));

  // Spilling breakers live on the forward face, where the surface falls away
  // along the direction of travel. The compression on the back of a wave is the
  // horizontal displacement piling water up against the next crest and it makes
  // no foam, so without this half the whitecaps sit in the wrong place.
  let face = -dot(grad, wd) * inverseSqrt(dot(grad, grad) + 1e-8);
  let gate = mix(1.0, smoothstep(-0.4, 0.5, face), clamp(params.uFaceBias, 0.0, 1.0));

  // What actually trips a crest into breaking is the metre-scale roughness
  // riding on it, so the threshold is modulated by the wind-projected slope of
  // the two shortest cascades, normalised by their own RMS (the top mip of the
  // slope map is <|grad h|^2>, which is exactly that). This is what gives a raft
  // internal structure and a ragged edge instead of the smooth convex outline a
  // thresholded low-pass always has - and unlike a procedural noise it is
  // periodic in each cascade's own tile, so it cannot introduce a seam.
  // Taken from this cascade's own slope at a finer mip than the breaking kernel:
  // the roughness that trips a crest is the detail riding on it. Reading the
  // shorter cascades here would reintroduce the lattice.
  let uvr   = world / patchL;
  let rms   = sqrt(max(sampleLod(SRC_SLOPE, layer, uvr, 32.0).w, 1e-9));
  let rough = dot(sampleLod(SRC_SLOPE, layer, uvr,
                            max(params.uCompLod[layer] - 2.5, 0.0)).xy, wd) / rms;
  let cut   = params.uCutoff - params.uBreakup * rough;

  let fold  = smoothstep(cut - params.uSoft, cut + params.uSoft, xn) * gate * ridge;
  let birth = clamp(params.uInject * fold, 0.0, 1.0);

  // Foam lives in undisplaced (Lagrangian) coordinates, so it already rides the
  // water particle it was born on. What still has to be advected is the surface
  // drift - Stokes plus wind shear - and that is what draws foam into windrows.
  let duv = wd * (params.uDrift * params.uDt / params.uL);
  // Diffusion lengths are metres of sea, not texels. Expressed in texels the
  // same code smeared a raft over eight metres in the 397 m cascade and over
  // thirty centimetres in the 17 m one, so each cascade grew a differently
  // shaped foam and the sum was a soft halo around a hard core.
  let alongUV  = 0.9 * bs / params.uL;
  let acrossUV = 0.16 * bs / params.uL;

  var prev = sampleLod(SRC_FOAM, layer, uv - duv, 0.0);
  // Anisotropic diffusion: a foam raft smears far further along the wind than
  // across it, which is what turns blobs into streaks.
  let blur = 0.25 * (
      sampleLod(SRC_FOAM, layer, uv - duv + wd * alongUV,  0.0)
    + sampleLod(SRC_FOAM, layer, uv - duv - wd * alongUV,  0.0)
    + sampleLod(SRC_FOAM, layer, uv - duv + wn * acrossUV, 0.0)
    + sampleLod(SRC_FOAM, layer, uv - duv - wn * acrossUV, 0.0));
  prev = mix(prev, blur, clamp(params.uSpreadRate * params.uDt, 0.0, 1.0));

  // The buffer is stored pre-multiplied by this cascade's share of the foam
  // budget, but the physics below is a fraction of the texel's own area and has
  // to saturate at one. Left in the weighted frame the raft saturated at one per
  // cascade instead of one in total, and four cascades summing to two is how
  // twenty percent whitecap coverage became a white-out.
  let iw     = 1.0 / max(params.uWeight, 1e-3);
  let pFresh = prev.y * iw;
  let pRes   = prev.z * iw;

  // Two-stage life. Stage one is the dense, bright crest foam that appears the
  // instant the crest folds and is gone within a couple of seconds.
  let fresh = min(max(pFresh * exp(-params.uFreshDecay * params.uDt), birth), 1.0);
  // Stage two is the thin dissipated raft it decays into, which lingers, spreads
  // and streaks long after the wave that made it has passed. In steady state it
  // covers freshDecay/decay times the area of the crest foam feeding it, which
  // is why the raft and not the breaker sets the coverage a photograph shows.
  // Exponential decay alone never reaches zero, so the raft leaves a film of a
  // few percent over most of the sea. That film is invisible in a photograph but
  // it is not invisible to a shader that multiplies it by a foam radiance, and
  // it is what turns a two percent whitecap coverage into a white sheet. Bubbles
  // burst at a rate per unit area, not per unit foam, so the sink is linear and
  // the raft clears in finite time.
  var residue = pRes * exp(-params.uDecay * params.uDt)
              + fresh * params.uFreshDecay * params.uDt;
  residue = clamp(residue - params.uThin * params.uDt, 0.0, 1.0);

  // These are area fractions of the same texel, so they composite. Taking the
  // max threw the raft away wherever a crest was breaking, which pinned the
  // fresh/aged ratio the shading pass reads at exactly one.
  let total = clamp(fresh + residue * (1.0 - fresh), 0.0, 1.0);
  foamOut[outIdx] = vec4<f32>(vec3<f32>(total, fresh, residue) * params.uWeight, x * x);
}
`;
