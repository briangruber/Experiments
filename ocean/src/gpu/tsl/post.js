// The HDR post chain in TSL: prefilter -> bloom pyramid -> metering -> iris ->
// accumulate -> composite/tonemap -> FXAA/grain. Every uniform, every helper and
// every one of the ten fragment programs the chain draws.
//
// Ported from src/shaders/post.js, function by function:
//
//   EXPOSURE_FN     post.js:13-24     resolveExposure()      (PREFILTER + COMPOSITE)
//   PREFILTER_FS    post.js:26-57     prefilterFragment()
//   DOWN_FS         post.js:59-73     downFragment()
//   UP_FS           post.js:78-92     upFragment()
//   LUM_FS          post.js:103-130   lumFragment()
//   ADAPT_FS        post.js:134-168   adaptFragment()
//   ACCUM_FS        post.js:170-180   accumFragment()
//   COMPOSITE_FS    post.js:182-510   compositeFragment() + agx/aces/reinhardJodie
//                                     + hash14 + lensLayer
//   FXAA_FS         post.js:516-574   fxaaFragment() + filmGrain
//
// plus the CPU-side pieces of src/post.js that are pure functions of the params:
// whiteBalanceGains (post.js:8-17) and _lensFlow (post.js:121-126).
//
// Two extra programs exist here that have no GLSL counterpart, because the
// shipping path did with a texture upload what a render target cannot do:
// adaptSeedFragment() writes the initial adapt value, and adaptReadFragment()
// stages the 1x1 adapt target for a readback. See "SEEDING" below.
//
// One source, both backends: Three compiles these node graphs to WGSL on WebGPU
// and to GLSL on WebGL2. No wgslFn, no glslFn - a raw-source node compiles for
// exactly one backend and would put the fallback back where it started
// (docs/webgpu-port.md).
//
// The maths is unchanged. Every constant, sign, clamp and magic number below is
// the one that shipped, and the GLSL comment explaining *why* each is what it is
// is carried across with it. The comments in this file are not decoration: half
// of the numbers here (0.4423, 2.9652, -12.47393, 0.44, 1.06) were chosen
// against a rendered image and cannot be re-derived from the code.
//
// Consumers: ./post-driver.js, and nothing else. This file imports ./noise.js,
// ./sky-background.js (for the screen-space flip) and ./cloud-field.js (for the
// clock) and is imported by none of them, so there are no cycles.
//
// ---------------------------------------------------------------------------
// A. THE COORDINATE RULE, WHICH IS THE ONE THING TO READ BEFORE EDITING
//
// THE PASS COORDINATE IS glScreenUV(). EVERY RENDER-TARGET FETCH GOES THROUGH
// srcUV(). There are no exceptions in this file and there should not be one
// added.
//
// Two different flips are in play and they are NOT the same flip.
//
//   FLIP 1 - THE SCREEN (porting rule 3, owned by ./sky-background.js).
//     ScreenNode.generate (three.webgpu.js:14073-14094) emits
//     `vec2(fragCoord.x, size.y - fragCoord.y)` when builder.isFlipY() - true
//     for GLSLNodeBuilder, false for WGSLNodeBuilder - precisely so screenUV.y
//     = 0 is the TOP on BOTH backends. This project's FS_VERT sets
//     `vUv = a_pos*0.5+0.5`, so the GLSL's v = 0 is the BOTTOM. glScreenUV()
//     is that one flip and glFragCoord() is its gl_FragCoord counterpart. Both
//     are imported, never re-derived.
//
//   FLIP 2 - THE SAMPLER (porting rule 4). TextureNode.setupUV
//     (three.webgpu.js:12676-12698) rewrites v as `flipY ? uv.flipY() : uv`
//     through a runtime bool uniform, and TextureNode.updateReference sets that
//     uniform (13255-13261) to `texture.isRenderTargetTexture === true` (among
//     other things) - again only when isFlipY(). So on WebGL a fetch of a render
//     target at v actually reads texcoord 1 - v, and on WebGPU it reads v.
//
// Trace one value all the way through. Write the frame with glScreenUV = g:
//
//   WebGL    framebuffer row 0 is the BOTTOM, so g lands at texcoord g;
//            a fetch at v reads texcoord 1 - v  ->  returns the value at g = 1-v
//   WebGPU   framebuffer row 0 is the TOP, so g lands at texcoord 1 - g;
//            a fetch at v reads texcoord v      ->  returns the value at g = 1-v
//
// Identical on both backends: `node.sample(v)` returns whatever the previous
// pass wrote at glScreenUV 1 - v. The GLSL wants texture(uSrc, C) to return the
// value at vUv = C, so v = 1 - C, which is exactly
//
//     srcUV(C) = vec2(C.x, 1.0 - C.y)
//
// and nothing else in the module needs a sign change. That is the point of
// doing it this way rather than folding the flip into each expression: every
// line below is then the GLSL's line operating on the GLSL's values, which is
// why uLensFlow keeps its sign, why the droplet lattice floor(q) lands on the
// same cells, and why the FXAA NW/NE/SW/SE labels stay literal.
//
// DO NOT USE uv() AS THE PASS COORDINATE. QuadGeometry (three.webgpu.js:38081)
// carries uv `[0,-1, 0,1, 2,1]` against positions `[-1,3, -1,-1, 3,-1]`, so
// uv.y = 0 lands at the NDC TOP - it is screenUV, not FS_VERT's vUv, and it is
// the MIRROR of the GLSL's v. (This is worth stating explicitly because the
// natural guess is the other way round: the attribute looks like a_pos*0.5+0.5
// and is not.) Using uv() as vUv flips the whole chain vertically on BOTH
// backends: the vignette and the distortion are symmetric so they hide it, and
// what is left is a mirrored picture that still looks like a seascape.
//
// vec2(0.5) is its own mirror image, so the three fixed-point fetches - uLum at
// level 8 and the two 1x1 adapt fetches - are written as a literal vec2(0.5)
// with no srcUV. Sending them through srcUV would be harmless and would also be
// a lie about what they are.
//
// ---------------------------------------------------------------------------
// B. WHY EVERY MATERIAL IN THE CHAIN SETS fragmentNode
//
// NodeMaterial.setup (21294-21372) consults `builder.context.getOutput` ONLY on
// the `this.fragmentNode === null` branch; a material with fragmentNode set has
// its value written raw. That is what lets this module own the OETF - the
// composite's own pow(1/2.2) is the only display encoding in the frame, exactly
// as in the GLSL. See ./post-driver.js for the other half of that argument
// (renderer.outputColorSpace).
//
// ---------------------------------------------------------------------------
// C. EXPLICIT LOD ON EVERY FETCH
//
// Every render-target fetch below carries .level(), 0 everywhere except the
// uLum fetch, which is .level(LUM_LEVEL). It is value-identical - nothing but
// the lum target has a mip chain, so an implicit fetch would read level 0 anyway
// - and it is necessary, because three of the composite's texture fetches sit
// inside branches on droplet state (caPx > 0.02, lensBlur > 0.02, lensRim >
// 0.001). That is non-uniform control flow, and WGSL's uniformity analysis
// rejects an implicit-derivative fetch there. Making the whole module explicit
// removes the question instead of answering it per site.
//
// ---------------------------------------------------------------------------
// D. TWO LUMA VECTORS, AND THEY ARE NOT INTERCHANGEABLE
//
// LW = (0.2126, 0.7152, 0.0722) is Rec.709 luminance and is what every grading
// and tonemapping step uses. LUM_FXAA = (0.299, 0.587, 0.114) is NTSC and is
// used by exactly one function - FXAA's edge detector (FXAA_FS:524). The GLSL
// declares both in the same program. Conflating them does not crash and does not
// obviously change the picture; it changes which edges FXAA decides to blur.
//
// ---------------------------------------------------------------------------
// E. SEEDING THE IRIS, AND WHY IT NEEDS ITS OWN DRAW
//
// src/post.js:34-37 creates the adapt textures WITH DATA:
// [0.18, log2(0.18), log2(0.18), 1]. That value is load-bearing three times
// over: it is why ADAPT_FS:160's `if (prev.r <= 0.0)` never fires, it is the
// frame-1 robust key LUM_FS:112 reads back, and it is why the golden adaptSeq
// starts at 0.179579 rather than at some transient.
//
// A RenderTarget cannot be initialised with data, and renderer.setClearColor
// takes a THREE.Color - which is colour-managed and cannot even carry
// log2(0.18) = -2.4739. So the seed is a one-pixel draw of a constant:
// adaptSeedFragment(). ./post-driver.js runs it into both adapt targets at
// allocation.
//
// ---------------------------------------------------------------------------
// F. THE STRUCTURAL TRANSLATIONS
//
// There are no loops anywhere in the post chain, so no break, no continue and
// no bool locals. What there is:
//
//  1. inout PARAMETERS - lensLayer (COMPOSITE_FS:286-332) takes
//     `inout vec2 off, inout float blur, inout float rim, inout float cover`
//     and has THREE early returns. It is a PLAIN JS NODE-GRAPH BUILDER whose
//     last four arguments are .toVar()s the caller created, mutated in place
//     (the water-common.js note-3 precedent). An Fn would be wrong twice over:
//     it would mutate the caller's vars only by the accident of being inlined,
//     and `scale`/`stretch`/`seed` must stay JS numbers so that
//     `max(stretch, 0.2)` folds at build time.
//
//     The three `return`s become three NESTED Ifs on the positive complement of
//     each guard, nested in the order the guarded quantities are computed:
//       `if (h.x > wet) return;`   -> If( h.x.lessThanEqual( wet ), ... )
//       `if (amp < 0.01) return;`  -> If( amp.greaterThanEqual( 0.01 ), ... )
//       `if (dd > 1.06) return;`   -> If( dd.lessThanEqual( 1.06 ), ... )
//     Note the accumulators are not all the same shape: two are max(), one is
//     -=, one is +=.
//
//  2. WHOLE-FUNCTION EARLY RETURN - filmGrain's `if (uGrain <= 0.0) return
//     disp;` becomes a result var initialised to disp with the body inside the
//     complement If, which is water-detail.js note 3's shape.
//
//  3. EARLY RETURN WITH TWO OUTCOMES - FXAA_FS:557 returns a DIFFERENT value in
//     the guard than in the body, so it is If(...).Else(...) writing one shared
//     result var, not a complement guard.
//
//  4. TERNARIES -> select(). Two of them: ADAPT_FS:163's speed asymmetry and
//     FXAA_FS:571's rgbA/rgbB choice. Neither test can produce a NaN, so there
//     is nothing for a short-circuit to protect (water-common note 7).
//     FXAA_FS:571 calls lum(rgbB) twice; it is hoisted into one .toVar() here,
//     which is the same value.
//
//  5. THREE-WAY BRANCH - COMPOSITE_FS:471-473 becomes
//     If(...).ElseIf(...).Else(...), chained off the If return value (StackNode
//     .If/.ElseIf/.Else, three.webgpu.js:35117-35158). Safe because agx, aces
//     and reinhardJodie each snapshot their argument into a .toVar() as their
//     first statement - GLSL parameters are by value and all three reassign c.
//
//  6. COMPONENT-WISE WRITES - COMPOSITE_FS:382-390 writes col.r/.g/.b
//     separately. Both branches build locals and end in ONE col.assign(vec3(..)).
//     There is no swizzle assignment anywhere in this file; `c.x += ...` in
//     lensLayer is likewise written as c.assign(vec2(c.x.add(...), c.y)).
//
//  7. `.mix()` IS BANNED. mixElement = (t, e1, e2) => mix(e1, e2, t), so the
//     RECEIVER IS THE FACTOR and `col.mix(target, alpha)` computes
//     mix(target, alpha, col) - it compiles, it runs, and it blends by the
//     wrong variable (porting rule 1). Every blend below is the standalone
//     mix(a, b, t). Two of them are exactly the shape the rule exists for:
//     reinhardJodie's `mix(c/(l+1.0), tc, tc)`, whose factor is a vec3 that is
//     also an endpoint, and COMPOSITE_FS:428's nested
//     `mix(col, mix(col, vec3(lum), 0.35)*0.88, k)`.
//     (.smoothstep() is the other way round and is fine; the standalone
//     smoothstep(low, high, x) is used here anyway because it reads as the GLSL.)
//
//  8. THE FOUR mat3s ARE WRITTEN OUT BY HAND. GLSL's mat3 constructor is
//     COLUMN-major, so AGX_IN's first three arguments are a COLUMN, not a row.
//     Following water-detail.js note 2, M*c is expanded into three explicit
//     dot products rather than handed to TSL's mat3(): WGSL's mat3x3 is
//     column-major too and TSL would *probably* agree, but "probably" on a
//     matrix convention is the exact class of silent error this port keeps
//     paying for, and a transposed tonemap is a plausible image rather than a
//     crash. The ACES pair expanded this way reproduces the published RRT/ODT
//     fit matrices row for row, which is an independent check that the column
//     reading is right.
//
//  9. EVERY GLSL LOCAL BECOMES A .toVar(). Faithful (a GLSL local IS a
//     variable) and necessary: an Fn without a layout is inlined, so a node read
//     twice is recomputed unless it is pinned (atmosphere.js note 2). The ones
//     that are genuinely reassigned and could not be anything else: `soft`
//     (PREFILTER); `eff`, `key`, `prev` (ADAPT); `lensOff`, `lensBlur`,
//     `lensRim`, `lensCover`, `col`, `bloom`, `t` (COMPOSITE); `c` (lensLayer);
//     `dir` (FXAA); plus the two early-return result vars.
//
// 10. `1.0/2.2`, `1.0/3.0` AND `2.0/3.0` ARE LEFT AS DIVISIONS, not folded in
//     JS. JS folds in float64 and TSL would then emit the float64-rounded
//     decimal; the GLSL compiler folds `1.0/2.2` in float32. The two differ by
//     an ulp or two. It costs nothing to emit the division and let the backend
//     compiler fold it exactly as the GLSL's does.
//
// 11. FLOAT ADDITION IS NOT ASSOCIATIVE, so every accumulation preserves the
//     GLSL's grouping. jimenez13's four groups are summed in the GLSL's order
//     and the nine UP taps are summed left to right.

import {
	Fn, If, float, int, vec2, vec3, vec4,
	uniform, texture, mix, select, clamp, smoothstep, step,
} from 'three/tsl';

import {
	DataTexture, RGBAFormat, FloatType, HalfFloatType, UnsignedByteType,
	LinearFilter, LinearMipmapLinearFilter, NearestFilter, ClampToEdgeWrapping,
	NoColorSpace,
} from 'three';

// PORTING RULE 7 / 13: the clock is not the cloud field's, it is the FRAME's.
// ./cloud-field.js declares uTime because the cloud field needed it first; the
// composite (droplet age, dither jitter) and FXAA (grain resample) read the same
// one. demo/main.js:582 passes the same `simTime` to post.render that ctx.time
// carries into the sky and the water (demo/main.js:464), so it is genuinely one
// clock and importing it is correct rather than merely convenient.
// setPostUniforms writes it, which is how ./post-driver.js satisfies rule 13
// without calling setCloudUniforms - that would need camPos and windVec3, which
// nothing in the post chain reads.
import { uTime } from './cloud-field.js';

// PORTING RULE 3: the screen flip has exactly one home and this is not it.
// glScreenUV() is bit-for-bit FS_VERT's vUv; glFragCoord() is bit-for-bit the
// GLSL's gl_FragCoord and is required at COMPOSITE_FS:506 (dither) and
// FXAA_FS:540 (grain), where a flip does not move the statistics but changes
// every individual pixel. Importing them pulls the whole sky module graph in as
// a dependency of this one - uniform nodes plus a handful of 1x1 placeholders at
// module scope, no renderer needed, and the import already loads cleanly under
// node. That weight is accepted deliberately: a second copy of the flip is the
// thing rule 3 exists to prevent.
import { glFragCoord, glScreenUV } from './sky-background.js';

// noise.js:84's hash12 is bit-identical to the two private copies in the GLSL
// (COMPOSITE_FS:257 and FXAA_FS:525 - both are NOISE_GLSL's).
//
// FXAA_FS:526's `vnoise(vec2)` is noise.js's **vnoise2**, not its `vnoise`:
// same four hash12 corners, same f*f*(3-2f) smoothing, same bilinear mix.
// noise.js also exports a 3-D `vnoise`, which is a different function. The
// import is left unaliased so that reaching for the wrong one is a visible
// mistake rather than a plausible-looking one.
import { hash12, vnoise2 } from './noise.js';

// ---- constants --------------------------------------------------------------

// src/post.js:4. Six levels in the bloom pyramid; the driver allocates
// chain[0..5] and up[0..4] from it.
export const MIPS = 6;

// The metering target is 256x256 (src/post.js:75-78), which is 8 mip levels
// down to 1x1 - hence LUM_LEVEL. ADAPT_FS:139 spells the 8.0 inline; it is a
// constant here so the target size and the fetch level cannot drift apart.
export const LUM_SIZE = 256;
export const LUM_LEVEL = 8.0;

// src/post.js:36. r = linear effective key (what resolveExposure divides by),
// g = its log2, b = the log2 robust key the metering pass reads back. See note E.
export const ADAPT_SEED = [ 0.18, Math.log2( 0.18 ), Math.log2( 0.18 ), 1 ];

// shaders/post.js:8, the LUMA block shared by PREFILTER, LUM, COMPOSITE and
// FXAA. Rec.709.
export const LW = /*@__PURE__*/ vec3( 0.2126, 0.7152, 0.0722 );

// FXAA_FS:524. NTSC weights, and NOT LW - see note D. Used by the edge detector
// only; filmGrain, in the same program, uses LW.
export const LUM_FXAA = /*@__PURE__*/ vec3( 0.299, 0.587, 0.114 );

// ---- uniforms ---------------------------------------------------------------
// Defaults are src/presets.js's, so every graph here evaluates to the shipping
// look before anything has called setPostUniforms().
//
// NAMING: the GLSL declares `uniform vec2 uTexel` in four different programs and
// `uniform sampler2D uSrc` in four more. They are four (and eleven) distinct
// nodes here, each with a comment naming the GLSL uniform it mirrors, because
// the five DOWN draws and the five UP draws each need a different value and they
// share one material. No name below collides with any `export const u*` in
// src/gpu/tsl/ (checked against all nine existing modules).

// ---- exposure block: read by PREFILTER and COMPOSITE (EXPOSURE_FN:15) --------
export const uExposure       = /*@__PURE__*/ uniform( 1.0 );
export const uAutoExposure   = /*@__PURE__*/ uniform( 1.0 );
export const uExposureBias   = /*@__PURE__*/ uniform( 0.0 );
export const uExposureTarget = /*@__PURE__*/ uniform( 0.105 );

// ---- PREFILTER (PREFILTER_FS:28-30) -----------------------------------------
// GLSL uTexel: 1/w, 1/h of the FULL-RES source, not of the half-res destination.
// Driver-owned; (0,0) is inert (all thirteen taps collapse onto the centre).
export const uPrefilterTexel = /*@__PURE__*/ uniform( 'vec2' );
export const uThreshold = /*@__PURE__*/ uniform( 1.1 );
export const uKnee      = /*@__PURE__*/ uniform( 0.6 );
export const uClamp     = /*@__PURE__*/ uniform( 120.0 );
export const uVeil      = /*@__PURE__*/ uniform( 0.016 );

// ---- DOWN (DOWN_FS:62) ------------------------------------------------------
// GLSL uTexel: 1/w, 1/h of chain[i-1], which changes on every one of the five
// draws. Driver-owned.
export const uDownTexel = /*@__PURE__*/ uniform( 'vec2' );

// ---- UP (UP_FS:81-82) -------------------------------------------------------
// GLSL uTexel: 1/w, 1/h of the SMALL (source) level, again per draw.
export const uUpTexel    = /*@__PURE__*/ uniform( 'vec2' );
export const uRadius     = /*@__PURE__*/ uniform( 1.0 );
export const uAnamorphic = /*@__PURE__*/ uniform( 0.15 );
export const uWeight     = /*@__PURE__*/ uniform( 0.82 );

// ---- LUM (LUM_FS:106) -------------------------------------------------------
export const uMeterCenter = /*@__PURE__*/ uniform( 0.65 );
export const uMeterHi     = /*@__PURE__*/ uniform( 1.8 );
export const uMeterLo     = /*@__PURE__*/ uniform( 0.4 );

// ---- ADAPT (ADAPT_FS:136) ---------------------------------------------------
export const uDt      = /*@__PURE__*/ uniform( 1 / 60 );
export const uSpeed   = /*@__PURE__*/ uniform( 1.6 );
export const uSpeedUp = /*@__PURE__*/ uniform( 2.4 );
export const uMinLog  = /*@__PURE__*/ uniform( Math.log2( 0.004 ) );
export const uMaxLog  = /*@__PURE__*/ uniform( Math.log2( 6.0 ) );
export const uSigma   = /*@__PURE__*/ uniform( 1.75 );
// The metering pass weights by area with a Gaussian centre bias; its frame mean
// is a pure function of that bias, so the moments are normalised with it here
// instead of burning a fourth channel on the weight sum (src/post.js:159-162).
export const uCwMean  = /*@__PURE__*/ uniform( 1 - 0.4423 * 0.65 );
// Stops of separation allowed between the midtone key and the bright percentile
// before the meter starts protecting the highlights instead (src/post.js:163-165).
export const uHiHeadroom = /*@__PURE__*/ uniform( Math.log2( 0.82 / 0.105 ) );

// ---- ACCUM (ACCUM_FS:173) ---------------------------------------------------
// 1/max(sampleIndex,1). Driver-owned; 1.0 means "take the new frame whole",
// which is what sample 1 does.
export const uBlend = /*@__PURE__*/ uniform( 1.0 );

// ---- COMPOSITE (COMPOSITE_FS:185-201) ---------------------------------------
// GLSL uRes: the composite's own size in pixels. Driver-owned; (1,1) is inert in
// the sense that the aspect comes out 1.
export const uRes = /*@__PURE__*/ uniform( 'vec2' );

export const uBloomIntensity  = /*@__PURE__*/ uniform( 0.08 );
export const uBloomTint       = /*@__PURE__*/ uniform( 'vec3' );
export const uBloomTintAmount = /*@__PURE__*/ uniform( 0.35 );
export const uGlareIntensity  = /*@__PURE__*/ uniform( 0.09 );

export const uVignette      = /*@__PURE__*/ uniform( 0.5 );
export const uVignetteRound = /*@__PURE__*/ uniform( 0.7 );

export const uChromatic  = /*@__PURE__*/ uniform( 1.2 );
export const uDistortion = /*@__PURE__*/ uniform( -0.02 );

// Water on the front element. uLensWet is the master and is NOT a plain preset
// value: the driver computes (opts.lensWet ?? 0) * p.lensWater, i.e. how wet the
// glass is right now times the preset's allowance for it.
export const uLensWet     = /*@__PURE__*/ uniform( 0.0 );
export const uLensDrops   = /*@__PURE__*/ uniform( 0.30 );
export const uLensSize    = /*@__PURE__*/ uniform( 0.60 );
export const uLensRefract = /*@__PURE__*/ uniform( 0.8 );
export const uLensStreak  = /*@__PURE__*/ uniform( 0.55 );
export const uLensRim     = /*@__PURE__*/ uniform( 0.09 );
export const uLensFilm    = /*@__PURE__*/ uniform( 0.12 );
// (sin, cos) of p.lensFlowAngle in radians - src/post.js:121-126. The default is
// 8 degrees. This is a DIRECTION in the GLSL's lens space and needs no sign
// change here, because srcUV moves the flip onto the sampling coordinate and
// nothing else (note A).
export const uLensFlow = /*@__PURE__*/ uniform( 'vec2' );
export const uLensBody = /*@__PURE__*/ uniform( 0.55 );

export const uContrast       = /*@__PURE__*/ uniform( 1.13 );
export const uSaturation     = /*@__PURE__*/ uniform( 1.02 );
export const uPostSaturation = /*@__PURE__*/ uniform( 1.04 );
export const uSplit          = /*@__PURE__*/ uniform( 0.25 );
export const uSplitShadow    = /*@__PURE__*/ uniform( 'vec3' );
export const uSplitHigh      = /*@__PURE__*/ uniform( 'vec3' );

export const uBlackPoint    = /*@__PURE__*/ uniform( 0.0 );
export const uToe           = /*@__PURE__*/ uniform( 0.45 );
export const uToeRange      = /*@__PURE__*/ uniform( 2.6 );
export const uChromaRestore = /*@__PURE__*/ uniform( 0.18 );

export const uLift         = /*@__PURE__*/ uniform( 'vec3' );
export const uGammaCC      = /*@__PURE__*/ uniform( 'vec3' );
export const uGain         = /*@__PURE__*/ uniform( 'vec3' );
// whiteBalanceGains(p.temperature, p.tintCC), computed on the CPU exactly as
// src/post.js:8-17 does. (0,0) renormalises to (1,1,1).
export const uWhiteBalance = /*@__PURE__*/ uniform( 'vec3' );

// The ONLY int uniform in the module. It is compared against and never fed to
// min/max, so porting rule 2 (a scalar second operand of min/max on an int
// builds as float, and GLSL ES 3.00 has no min(int, float) overload) is
// unreachable here. Keep it that way.
export const uTonemap = /*@__PURE__*/ uniform( 0, 'int' );

export const uHighlightRoll = /*@__PURE__*/ uniform( 1.0 );
export const uHalation      = /*@__PURE__*/ uniform( 0.030 );
export const uHalationTint  = /*@__PURE__*/ uniform( 'vec3' );

// ---- FXAA (FXAA_FS:519-521) -------------------------------------------------
// GLSL uTexel: 1/w, 1/h of the LDR source. Driver-owned.
export const uFxaaTexel = /*@__PURE__*/ uniform( 'vec2' );
// Driver-owned, and deliberately NOT written by setPostUniforms: in photo mode
// it is a ramp over the accumulated sample count, not p.fxaa (src/post.js:249-251).
export const uAmount      = /*@__PURE__*/ uniform( 1.0 );
export const uGrain       = /*@__PURE__*/ uniform( 0.0 );
export const uGrainSize   = /*@__PURE__*/ uniform( 1.7 );
export const uGrainChroma = /*@__PURE__*/ uniform( 0.22 );
export const uGrainShadow = /*@__PURE__*/ uniform( 0.35 );

// Vector defaults, set once at module scope. src/presets.js.
uPrefilterTexel.value.set( 0, 0 );
uDownTexel.value.set( 0, 0 );
uUpTexel.value.set( 0, 0 );
uFxaaTexel.value.set( 0, 0 );
uRes.value.set( 1, 1 );
uBloomTint.value.set( 1.0, 0.96, 0.92 );
uSplitShadow.value.set( 0.93, 0.97, 1.08 );
uSplitHigh.value.set( 1.05, 1.0, 0.95 );
uLift.value.set( 0.0, 0.002, 0.006 );
uGammaCC.value.set( 1.0, 1.0, 1.0 );
uGain.value.set( 1.0, 1.0, 1.0 );
uWhiteBalance.value.set( 1.0, 1.0, 1.0 );
uHalationTint.value.set( 1.0, 0.30, 0.10 );
// (sin, cos) of 8 degrees, p.lensFlowAngle's default.
uLensFlow.value.set( 0.13917310096006544, 0.9902680687415704 );

// ---- textures ---------------------------------------------------------------
// Eleven TextureNodes whose values ./post-driver.js swaps for real render
// targets. The placeholders keep every graph buildable before a renderer has
// drawn anything, so a compile probe does not need a frame first - the same
// arrangement sky-background.js uses for the sky LUT.
//
// PORTING RULE 11, WITH A WIDER READING THAN THE RULE SPELLS OUT.
// WGSLNodeBuilder.isUnfilterable (three.webgpu.js:79066-79074) is
//
//     getComponentTypeFromTexture(texture) !== 'float'
//  || ( !isAvailable('float32Filterable') && texture.type === FloatType )
//  || ( isSampleCompare(texture) === false && minFilter === NearestFilter
//                                          && magFilter === NearestFilter )
//  || getTextureSampleData(texture).primarySamples > 1
//
// and generateTextureLevel (79284) emits textureLoad() instead of
// textureSampleLevel() whenever it is true - decided when the node graph is
// BUILT, from whatever texture happens to be bound at that moment, and kept
// forever after. So it is not only the NearestFilter clause that matters: a
// FloatType placeholder standing in for a HalfFloatType target would bake an
// unfiltered texel fetch on any device without the float32-filterable feature.
// Every placeholder below therefore carries its real target's TYPE as well as
// its filter, wrap and mip state. WebGL2 resolves the sampler per draw and is
// unaffected, which is the "compiles on both, wrong on one" class again.
//
// ANISOTROPY (porting rule 12): every post texture is aniso 1. src/gl.js:139
// only sets anisotropy when an `aniso` option is passed and src/post.js never
// passes one, so the rule is satisfied by NOT adding it here. Do not "improve"
// this.

// A 1x1 RGBA16F white-alpha texel: half-float 0x3C00 is 1.0.
function halfPlaceholder() {

	const t = new DataTexture( new Uint16Array( [ 0, 0, 0, 0x3C00 ] ), 1, 1, RGBAFormat, HalfFloatType );
	t.minFilter = LinearFilter;
	t.magFilter = LinearFilter;
	t.wrapS = t.wrapT = ClampToEdgeWrapping;
	t.generateMipmaps = false;
	t.needsUpdate = true;
	return t;

}

// GLSL uSrc in PREFILTER, LUM, ACCUM and COMPOSITE - the scene HDR buffer.
// ONE node shared by four programs, which is correct because the driver points
// it at the right texture once per entry point (accumulate() and render() each
// set it at the top and run to completion before the other is called; photo mode
// calls accumulate() first and feeds its output into render(), demo/main.js:543
// then :582).
export const srcTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );

// DOWN's uSrc: chain[i-1].
export const downSrcTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );
// UP's uSrc: chain[MIPS-1] on the first step, up[i] afterwards.
export const upSrcTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );
// UP's uPrev: chain[i-1], the octave being added to.
export const upPrevTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );
// COMPOSITE's uBloom: up[0].
export const bloomTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );
// COMPOSITE's uGlare: up[glareLevel], the wide veiling tail.
export const glareTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );
// ACCUM's uHistory: the other half of the photo-mode ping-pong.
export const historyTexture = /*@__PURE__*/ texture( /*@__PURE__*/ halfPlaceholder() );

// ADAPT's uLum: the 256x256 metering target, which is MIPPED - the whole pass
// is a level-8 fetch of it.
export const lumTexture = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = halfPlaceholder();
	t.minFilter = LinearMipmapLinearFilter;
	// generateMipmaps stays false on the PLACEHOLDER (there is nothing to mip in
	// a 1x1) while the real target has it true. minFilter is what
	// isUnfilterable reads, and it matches.
	return t;

} )() );

// FXAA's uSrc: the RGBA8 composite output.
export const ldrTexture = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = new DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1, RGBAFormat, UnsignedByteType );
	t.minFilter = LinearFilter;
	t.magFilter = LinearFilter;
	t.wrapS = t.wrapT = ClampToEdgeWrapping;
	t.generateMipmaps = false;
	// See ./post-driver.js: the real target MUST be NoColorSpace or WebGPU picks
	// rgba8unorm-srgb and encodes a second time over the composite's own OETF.
	t.colorSpace = NoColorSpace;
	t.needsUpdate = true;
	return t;

} )() );

// A 1x1 RGBA32F texel carrying ADAPT_SEED, NEAREST both ways - matching
// src/post.js:34-37 exactly, including the negative log2(0.18) that only a float
// format can hold.
function adaptPlaceholder() {

	const t = new DataTexture( new Float32Array( ADAPT_SEED ), 1, 1, RGBAFormat, FloatType );
	t.minFilter = NearestFilter;
	t.magFilter = NearestFilter;
	t.wrapS = t.wrapT = ClampToEdgeWrapping;
	t.generateMipmaps = false;
	t.needsUpdate = true;
	return t;

}

// uAdapt, read by resolveExposure in PREFILTER and COMPOSITE. Points at the
// adapt target the iris just wrote.
export const adaptTexture = /*@__PURE__*/ texture( /*@__PURE__*/ adaptPlaceholder() );
// uPrev in LUM and ADAPT. Points at the adapt target from LAST frame.
//
// TWO DISTINCT NODES ON PURPOSE. src/post.js:147-171 flips adaptIdx BEFORE
// calling exposureUniforms(p), so within one frame LUM and ADAPT read the OLD
// adapt while PREFILTER and COMPOSITE read the NEW one. Collapsing these into
// one node would make the frame's exposure depend on the metering it just
// computed - a different, self-referential filter, and one that still produces a
// perfectly plausible image.
export const adaptPrevTexture = /*@__PURE__*/ texture( /*@__PURE__*/ adaptPlaceholder() );

// ---- the coordinate transform -----------------------------------------------

// GLSL vUv -> the coordinate a TSL fetch of a screen-aligned render target needs.
// The one and only place this module touches v. See note A for the derivation;
// it is the SAMPLER flip (rule 4), not a second helping of the screen flip
// (rule 3), which is why it composes with glScreenUV() rather than cancelling it.
export const srcUV = /*@__PURE__*/ Fn( ( [ uvGl ] ) => {

	return vec2( uvGl.x, float( 1.0 ).sub( uvGl.y ) );

} );

// ---- shared exposure --------------------------------------------------------

// The bloom prefilter has to agree with the composite about the working stop, or
// a threshold in scene units becomes meaningless the moment auto exposure moves.
//
//   float resolveExposure(){
//     float ev = uExposure;
//     if (uAutoExposure > 0.0){
//       float avg = max(texelFetch(uAdapt, ivec2(0), 0).r, 1e-5);
//       ev = mix(ev, ev * (uExposureTarget / avg), uAutoExposure);
//     }
//     return ev * exp2(uExposureBias);
//   }
//
// texelFetch(uAdapt, ivec2(0), 0) on a 1x1 target is .sample(vec2(0.5)).level(0):
// vec2(0.5) is the centre of the single texel, and it is its own mirror image so
// it needs no srcUV.
export const resolveExposure = /*@__PURE__*/ Fn( () => {

	const ev = uExposure.toVar();

	If( uAutoExposure.greaterThan( 0.0 ), () => {

		const avg = adaptTexture.sample( vec2( 0.5 ) ).level( 0 ).r.max( 1e-5 ).toVar();
		ev.assign( mix( ev, ev.mul( uExposureTarget.div( avg ) ), uAutoExposure ) );

	} );

	return ev.mul( uExposureBias.exp2() );

} );

// ---- the 13-tap Jimenez kernel ----------------------------------------------

// PREFILTER_FS:38-44 and DOWN_FS:65-71 are the same thirteen taps in the same
// arrangement; the GLSL duplicates the whole block because its only difference
// is whether each tap is clamped. Here it is one builder taking the tap function.
//
//   vec3 a = tap(vUv + t*vec2(-2,-2)), b = tap(vUv + t*vec2(0,-2)), c = tap(...);
//   vec3 d = ..., e = tap(vUv), f = ...;  vec3 g = ..., h = ..., i = ...;
//   vec3 j = tap(vUv + t*vec2(-1,-1)), k = tap(vUv + t*vec2(1,-1));
//   vec3 l = tap(vUv + t*vec2(-1, 1)), m = tap(vUv + t*vec2(1, 1));
//   col = (j+k+l+m)*0.5*0.25 + (a+c+g+i)*0.125*0.25 + (b+d+f+h)*0.25*0.25 + e*0.125;
//
// A 13-tap Jimenez downsample avoids the fireflies a naive box filter keeps.
//
// THE SUMMATION ORDER IS THE GLSL'S, GROUP FOR GROUP AND TERM FOR TERM. Float
// addition is not associative; regrouping this is a change to the output, not a
// tidy-up. `(j+k+l+m)` is `((j+k)+l)+m` and `*0.5*0.25` is `(x*0.5)*0.25`.
//
// PLAIN JS BUILDER, not an Fn: `tap` is a JS function (an Fn for PREFILTER, an
// inline arrow for DOWN) and could not survive being passed as a node argument.
export function jimenez13( tap, uvGl, t ) {

	const a = tap( uvGl.add( t.mul( vec2( - 2, - 2 ) ) ) ).toVar();
	const b = tap( uvGl.add( t.mul( vec2( 0, - 2 ) ) ) ).toVar();
	const c = tap( uvGl.add( t.mul( vec2( 2, - 2 ) ) ) ).toVar();
	const d = tap( uvGl.add( t.mul( vec2( - 2, 0 ) ) ) ).toVar();
	const e = tap( uvGl ).toVar();
	const f = tap( uvGl.add( t.mul( vec2( 2, 0 ) ) ) ).toVar();
	const g = tap( uvGl.add( t.mul( vec2( - 2, 2 ) ) ) ).toVar();
	const h = tap( uvGl.add( t.mul( vec2( 0, 2 ) ) ) ).toVar();
	const i = tap( uvGl.add( t.mul( vec2( 2, 2 ) ) ) ).toVar();
	const j = tap( uvGl.add( t.mul( vec2( - 1, - 1 ) ) ) ).toVar();
	const k = tap( uvGl.add( t.mul( vec2( 1, - 1 ) ) ) ).toVar();
	const l = tap( uvGl.add( t.mul( vec2( - 1, 1 ) ) ) ).toVar();
	const m = tap( uvGl.add( t.mul( vec2( 1, 1 ) ) ) ).toVar();

	return j.add( k ).add( l ).add( m ).mul( 0.5 ).mul( 0.25 )
		.add( a.add( c ).add( g ).add( i ).mul( 0.125 ).mul( 0.25 ) )
		.add( b.add( d ).add( f ).add( h ).mul( 0.25 ).mul( 0.25 ) )
		.add( e.mul( 0.125 ) );

}

// ---- PREFILTER --------------------------------------------------------------

// vec3 tap(vec2 uv){ return min(texture(uSrc, uv).rgb, vec3(uClamp)); }
//
// PREFILTER has this helper and DOWN does not; the asymmetry is the GLSL's and
// is kept, because it is the only difference between the two programs.
const prefilterTap = /*@__PURE__*/ Fn( ( [ uvGl ] ) => {

	return srcTexture.sample( srcUV( uvGl ) ).level( 0 ).rgb.min( vec3( uClamp ) );

} );

// PREFILTER_FS:36-56.
//
//   float lum = dot(col, LW) * resolveExposure();
//   float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0*uKnee);
//   soft = soft*soft / (4.0*uKnee + 1e-5);
//   float w = max(soft, lum - uThreshold) / max(lum, 1e-5);
//   fragColor = vec4(col * (w + uVeil), 1.0);
export const prefilterFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();
	const t = uPrefilterTexel.toVar();

	const col = jimenez13( prefilterTap, vUv, t ).toVar();

	// Threshold in *exposed* units so the bloom looks the same at dawn and noon.
	const lum = col.dot( LW ).mul( resolveExposure() ).toVar();
	const soft = clamp( lum.sub( uThreshold ).add( uKnee ), 0.0, float( 2.0 ).mul( uKnee ) ).toVar();
	soft.assign( soft.mul( soft ).div( float( 4.0 ).mul( uKnee ).add( 1e-5 ) ) );
	const w = soft.max( lum.sub( uThreshold ) ).div( lum.max( 1e-5 ) ).toVar();

	// Veiling glare is not a threshold effect: glass and the sensor stack scatter
	// a little of *all* the light in the frame, which is what fills shadows next
	// to a bright sky and keeps the image from looking synthetically clean.
	return vec4( col.mul( w.add( uVeil ) ), 1.0 );

} );

// ---- DOWN -------------------------------------------------------------------

// DOWN_FS:64-72. The same thirteen taps, unclamped and straight into the output.
export const downFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();
	const t = uDownTexel.toVar();

	// No tap() helper here, exactly as in the GLSL.
	const col = jimenez13(
		( c ) => downSrcTexture.sample( srcUV( c ) ).level( 0 ).rgb,
		vUv, t,
	).toVar();

	return vec4( col, 1.0 );

} );

// ---- UP ---------------------------------------------------------------------

// UP_FS:84-91. Each octave is added with weight uWeight^level. Equal weight per
// octave (1.0) spreads equal energy over 4x the area each step, i.e. an
// intensity falloff of 1/r^2 -- the actual point spread function of a lens.
// Below 1 tightens it.
//
//   vec2 t = uTexel * uRadius * vec2(1.0 + uAnamorphic*3.0, 1.0);
//   vec3 s = <3x3 tent, weights 1 2 1 / 2 4 2 / 1 2 1>;
//   fragColor = vec4(texture(uPrev, vUv).rgb + (s/16.0) * uWeight, 1.0);
//
// The nine taps are summed left to right, as the GLSL's single expression is.
export const upFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();
	const t = uUpTexel.mul( uRadius ).mul( vec2( float( 1.0 ).add( uAnamorphic.mul( 3.0 ) ), 1.0 ) ).toVar();

	const tap = ( x, y ) => upSrcTexture.sample( srcUV( vUv.add( t.mul( vec2( x, y ) ) ) ) ).level( 0 ).rgb;

	const s = tap( - 1, - 1 ).mul( 1.0 )
		.add( tap( 0, - 1 ).mul( 2.0 ) )
		.add( tap( 1, - 1 ).mul( 1.0 ) )
		.add( tap( - 1, 0 ).mul( 2.0 ) )
		.add( upSrcTexture.sample( srcUV( vUv ) ).level( 0 ).rgb.mul( 4.0 ) )
		.add( tap( 1, 0 ).mul( 2.0 ) )
		.add( tap( - 1, 1 ).mul( 1.0 ) )
		.add( tap( 0, 1 ).mul( 2.0 ) )
		.add( tap( 1, 1 ).mul( 1.0 ) )
		.toVar();

	const prev = upPrevTexture.sample( srcUV( vUv ) ).level( 0 ).rgb.toVar();

	return vec4( prev.add( s.div( 16.0 ).mul( uWeight ) ), 1.0 );

} );

// ---- LUM --------------------------------------------------------------------

// LUM_FS:109-129. Metering. Two populations are measured at once, both area
// weighted:
//   rg -- a robust key (outliers discounted), i.e. "what is the midtone?"
//   ba -- the first two central moments of the *undiscounted* distribution,
//         from which the adaptation pass recovers a percentile. A percentile is
//         what a highlight-weighted meter actually protects; a "count the bright
//         pixels" mass term cannot tell a frame that is 3 stops over from one
//         that is 9 stops over, so it under-protects exactly the bimodal frames
//         (storm sea, sun glitter) that need it most.
// Everything is in log2, so the units of every meter knob are stops.
export const lumFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();

	const c = srcTexture.sample( srcUV( vUv ) ).level( 0 ).rgb.toVar();
	const lg = c.dot( LW ).max( 1e-4 ).log2().toVar();
	// last frame's robust key, log2
	const key = adaptPrevTexture.sample( vec2( 0.5 ) ).level( 0 ).b.toVar();
	// stops away from it
	const rel = lg.sub( key ).toVar();

	// Centre weighting: the sea occupies the middle of frame and is what has to
	// be correctly exposed; the sky is allowed to go where it goes.
	const d = vUv.sub( 0.5 ).toVar();
	const cw = mix( float( 1.0 ), float( - 4.0 ).mul( d.dot( d ) ).exp(), uMeterCenter ).toVar();

	// Soft histogram weighting around the running key. Specular glitter and a
	// blown sky are outliers by definition, so they get discounted instead of
	// dragging the whole frame down; deep troughs are discounted more gently.
	const w = cw.div(
		float( 1.0 ).add( uMeterHi.mul( rel.max( 0.0 ) ) )
			.mul( float( 1.0 ).add( uMeterLo.mul( rel.negate().max( 0.0 ) ) ) ),
	).toVar();

	// Moments are taken about the running key rather than about zero: the mip
	// reduction happens in half float, and E[x^2] - E[x]^2 with x ~ -8 would lose
	// the entire variance to cancellation.
	return vec4( w.mul( lg ), w, cw.mul( rel ), cw.mul( rel ).mul( rel ) );

} );

// ---- ADAPT ------------------------------------------------------------------

// ADAPT_FS:138-167. rgb = (linear effective key, log2 of it, log2 robust key);
// the robust key is fed back to the metering pass, the effective one drives
// exposure.
export const adaptFragment = /*@__PURE__*/ Fn( () => {

	// textureLod(uLum, vec2(0.5), 8.0): 256 -> 1x1, i.e. the weighted sums of the
	// whole frame. The mip chain IS the reduction; see note in ./post-driver.js
	// about who regenerates it.
	const s = lumTexture.sample( vec2( 0.5 ) ).level( LUM_LEVEL ).toVar();
	const key = s.x.div( s.y.max( 1e-4 ) ).toVar();
	const prevKey = adaptPrevTexture.sample( vec2( 0.5 ) ).level( 0 ).b.toVar();

	// Percentile from moments. Log luminance of a lit scene is close to normal,
	// so key + sigma*sd tracks a high percentile without a histogram: sigma 1.65
	// is the 95th, 2.05 the 98th. Unlike a mean it scales with how blown the
	// frame is, so a flat scene is left alone and a bimodal one is stopped down.
	const m1 = s.z.div( uCwMean.max( 1e-4 ) ).toVar();
	const sd = s.w.div( uCwMean.max( 1e-4 ) ).sub( m1.mul( m1 ) ).max( 0.0 ).sqrt().toVar();
	const hi = prevKey.add( m1 ).add( uSigma.mul( sd ) ).toVar();

	// Highlight priority. Raising the key by whatever the bright percentile
	// overshoots is what a camera's highlight-weighted mode does, and it is the
	// only honest fix for a bimodal frame: the midtone target is a preference,
	// clipping is not.
	const eff = key.max( hi.sub( uHiHeadroom ) ).toVar();
	eff.assign( clamp( eff, uMinLog, uMaxLog ) );
	key.assign( clamp( key, uMinLog, uMaxLog ) );

	const prev = adaptPrevTexture.sample( vec2( 0.5 ) ).level( 0 ).rgb.toVar();
	// Never fires in practice - the target is seeded with ADAPT_SEED, whose r is
	// 0.18 (note E). It is transcribed anyway because it is the GLSL's guard
	// against an unseeded target, and dropping it would make the seed silently
	// load-bearing instead of explicitly so.
	If( prev.r.lessThanEqual( 0.0 ), () => {

		prev.assign( vec3( eff.exp2(), eff, key ) );

	} );

	// An iris (and an eye) stops down faster than it opens up; matching that
	// asymmetry is what stops the image pumping when a wave throws a highlight.
	//
	//   float t = 1.0 - exp(-uDt * uSpeed * (eff > prev.y ? uSpeedUp : 1.0));
	const t = float( 1.0 ).sub(
		uDt.negate().mul( uSpeed )
			.mul( select( eff.greaterThan( prev.y ), uSpeedUp, float( 1.0 ) ) )
			.exp(),
	).toVar();
	const e = mix( prev.y, eff, t ).toVar();
	const k = mix( prev.z, key, float( 1.0 ).sub( uDt.negate().mul( uSpeed ).exp() ) ).toVar();

	return vec4( e.exp2(), e, k, 1.0 );

} );

// ---- ACCUM ------------------------------------------------------------------

// ACCUM_FS:175-179. Temporal accumulation used by photo mode: n frames of
// jitter, no motion.
export const accumFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();
	const c = srcTexture.sample( srcUV( vUv ) ).level( 0 ).rgb.toVar();
	const h = historyTexture.sample( srcUV( vUv ) ).level( 0 ).rgb.toVar();
	return vec4( mix( h, c, uBlend ), 1.0 );

} );

// ---- tonemaps ---------------------------------------------------------------
// Convention, from the head of src/shaders/post.js: every tonemap returns
// DISPLAY-LINEAR values and the composite applies the OETF exactly once, at the
// very end. AgX's sigmoid is already display-encoded, so agx() undoes that
// encoding before returning -- without it the frame gets gamma applied twice and
// washes out to milk.

// 6th-order fit to the AgX sigmoid; f(0.5) = 0.5 and f(log2(0.18) mapped) sits
// at 0.4967, i.e. middle grey lands on middle grey in display code values.
//
//   vec3 agxContrast(vec3 x){
//     vec3 x2 = x*x, x4 = x2*x2;
//     return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2
//            + 0.1191*x - 0.00232;
//   }
export const agxContrast = /*@__PURE__*/ Fn( ( [ xIn ] ) => {

	const x = vec3( xIn ).toVar();
	const x2 = x.mul( x ).toVar();
	const x4 = x2.mul( x2 ).toVar();

	return x4.mul( 15.5 ).mul( x2 )
		.sub( x4.mul( 40.14 ).mul( x ) )
		.add( x4.mul( 31.96 ) )
		.sub( x2.mul( 6.868 ).mul( x ) )
		.add( x2.mul( 0.4298 ) )
		.add( x.mul( 0.1191 ) )
		.sub( 0.00232 );

} );

// AGX_IN folds sRGB->Rec.2020 into the AgX inset; AGX_OUT is its inverse.
//
//   const mat3 AGX_IN = mat3(
//     0.842479062253094, 0.0423282422610123, 0.0423756549057051,
//     0.0784335999999992, 0.878468636469772,  0.0784336,
//     0.0792237451477643, 0.0791661274605434, 0.879142973793104);
//   const mat3 AGX_OUT = mat3(
//      1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
//     -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
//     -0.0990297440797205,-0.0989611768448433,  1.15107367264116);
//
// GLSL's mat3(...) is COLUMN-major: the first three numbers are column 0. So
// (M*v).x is column0.x*v.x + column1.x*v.y + column2.x*v.z, which is what the two
// helpers below compute. See note F8 for why this is not written as a mat3().
//
// The argument is snapshotted into a .toVar() first, in all four: each is read
// nine times below, and acesOut is called with an EXPRESSION (a/b) that would
// otherwise be rebuilt nine times over.
function agxIn( cIn ) {

	const c = vec3( cIn ).toVar();
	return vec3(
		c.x.mul( 0.842479062253094 ).add( c.y.mul( 0.0784335999999992 ) ).add( c.z.mul( 0.0792237451477643 ) ),
		c.x.mul( 0.0423282422610123 ).add( c.y.mul( 0.878468636469772 ) ).add( c.z.mul( 0.0791661274605434 ) ),
		c.x.mul( 0.0423756549057051 ).add( c.y.mul( 0.0784336 ) ).add( c.z.mul( 0.879142973793104 ) ),
	);

}

function agxOut( cIn ) {

	const c = vec3( cIn ).toVar();
	return vec3(
		c.x.mul( 1.19687900512017 ).add( c.y.mul( - 0.0980208811401368 ) ).add( c.z.mul( - 0.0990297440797205 ) ),
		c.x.mul( - 0.0528968517574562 ).add( c.y.mul( 1.15190312990417 ) ).add( c.z.mul( - 0.0989611768448433 ) ),
		c.x.mul( - 0.0529716355144438 ).add( c.y.mul( - 0.0980434501171241 ) ).add( c.z.mul( 1.15107367264116 ) ),
	);

}

//   vec3 agx(vec3 c){
//     const float minEv = -12.47393, maxEv = 4.026069;
//     c = AGX_IN * max(c, vec3(0.0));
//     c = clamp(log2(max(c, 1e-10)), minEv, maxEv);
//     c = (c - minEv)/(maxEv - minEv);
//     c = agxContrast(c);
//     float l = dot(c, LW);
//     c = l + (c - l) * (1.0 + 0.18*uHighlightRoll);
//     c = clamp(AGX_OUT * c, 0.0, 1.0);
//     return pow(c, vec3(2.2));
//   }
export const agx = /*@__PURE__*/ Fn( ( [ cIn ] ) => {

	const minEv = - 12.47393, maxEv = 4.026069;

	const c = vec3( cIn ).toVar();

	c.assign( agxIn( c.max( vec3( 0.0 ) ) ) );
	c.assign( clamp( c.max( 1e-10 ).log2(), minEv, maxEv ) );
	// (maxEv - minEv) is emitted as a division-free subtraction NODE rather than
	// folded in JS: JS folds in float64, the GLSL compiler folds in float32, and
	// the two can differ by an ulp. See note F10.
	c.assign( c.sub( minEv ).div( float( maxEv ).sub( minEv ) ) );
	c.assign( agxContrast( c ) );

	// The "look" belongs here, on the sigmoid output and before the outset -- a
	// touch of saturation back into highlights that the per-channel curve ate.
	const l = c.dot( LW ).toVar();
	c.assign( vec3( l ).add( c.sub( l ).mul( float( 1.0 ).add( float( 0.18 ).mul( uHighlightRoll ) ) ) ) );
	c.assign( clamp( agxOut( c ), 0.0, 1.0 ) );

	// Undo AgX's built-in display encoding: this function owes its caller LINEAR.
	return c.pow( vec3( 2.2 ) );

} );

//   const mat3 ACES_IN  = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
//   const mat3 ACES_OUT = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
//
// Read as columns, these expand to the published ACES RRT-fit input and output
// matrices row for row - which is an independent check that the column reading
// is the right one.
function acesIn( cIn ) {

	const c = vec3( cIn ).toVar();
	return vec3(
		c.x.mul( 0.59719 ).add( c.y.mul( 0.35458 ) ).add( c.z.mul( 0.04823 ) ),
		c.x.mul( 0.07600 ).add( c.y.mul( 0.90834 ) ).add( c.z.mul( 0.01566 ) ),
		c.x.mul( 0.02840 ).add( c.y.mul( 0.13383 ) ).add( c.z.mul( 0.83777 ) ),
	);

}

function acesOut( cIn ) {

	const c = vec3( cIn ).toVar();
	return vec3(
		c.x.mul( 1.60475 ).add( c.y.mul( - 0.53108 ) ).add( c.z.mul( - 0.07367 ) ),
		c.x.mul( - 0.10208 ).add( c.y.mul( 1.10813 ) ).add( c.z.mul( - 0.00605 ) ),
		c.x.mul( - 0.00327 ).add( c.y.mul( - 0.07276 ) ).add( c.z.mul( 1.07602 ) ),
	);

}

//   vec3 aces(vec3 c){
//     float l = dot(c, LW);
//     float hot = 1.0 - 1.0/(1.0 + 0.06*max(l - 2.0, 0.0));
//     c = mix(c, vec3(l), hot * clamp(uHighlightRoll, 0.0, 1.5) * 0.8);
//     c = ACES_IN * c;
//     vec3 a = c*(c+0.0245786) - 0.000090537;
//     vec3 b = c*(0.983729*c + 0.4329510) + 0.238081;
//     return clamp(ACES_OUT * (a/b), 0.0, 1.0);
//   }
export const aces = /*@__PURE__*/ Fn( ( [ cIn ] ) => {

	const c = vec3( cIn ).toVar();

	// The fitted RRT clips hot colours to hard primaries; bleeding the brightest
	// values toward their own luminance first is the cheap stand-in for the glow
	// module and keeps the sun path from turning into a magenta hole.
	const l = c.dot( LW ).toVar();
	const hot = float( 1.0 ).sub( float( 1.0 ).div( float( 1.0 ).add( float( 0.06 ).mul( l.sub( 2.0 ).max( 0.0 ) ) ) ) ).toVar();
	c.assign( mix( c, vec3( l ), hot.mul( clamp( uHighlightRoll, 0.0, 1.5 ) ).mul( 0.8 ) ) );
	c.assign( acesIn( c ) );

	const a = c.mul( c.add( 0.0245786 ) ).sub( 0.000090537 ).toVar();
	const b = c.mul( c.mul( 0.983729 ).add( 0.4329510 ) ).add( 0.238081 ).toVar();

	return clamp( acesOut( a.div( b ) ), 0.0, 1.0 );

} );

//   vec3 reinhardJodie(vec3 c){
//     float l = dot(c, LW);
//     vec3 tc = c/(c+1.0);
//     return clamp(mix(c/(l+1.0), tc, tc), 0.0, 1.0);
//   }
//
// The mix's FACTOR is a vec3 and is also its second endpoint. Written with
// `.mix()` this would silently become mix(tc, tc, c/(l+1)) - porting rule 1's
// exact shape. Standalone only.
export const reinhardJodie = /*@__PURE__*/ Fn( ( [ cIn ] ) => {

	const c = vec3( cIn ).toVar();
	const l = c.dot( LW ).toVar();
	const tc = c.div( c.add( 1.0 ) ).toVar();
	return clamp( mix( c.div( l.add( 1.0 ) ), tc, tc ), 0.0, 1.0 );

} );

// ---- hashes -----------------------------------------------------------------

// COMPOSITE_FS:259-263. Not in ./noise.js - this module owns it.
//
//   vec4 hash14(vec2 p){
//     vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
//     p4 += dot(p4, p4.wzxy + 33.33);
//     return fract((p4.xxyz + p4.yzzw) * p4.zywx);
//   }
//
// vec4(p.xyxy) is written out as vec4(p.x, p.y, p.x, p.y) so the vec2->vec4
// swizzle expansion is explicit, matching ./noise.js's treatment of vec3(p.xyx).
// The .wzxy / .xxyz / .yzzw / .zywx swizzles on the right-hand sides are all
// valid TSL and are used as-is.
export const hash14 = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const p4 = vec4( p.x, p.y, p.x, p.y ).mul( vec4( 0.1031, 0.1030, 0.0973, 0.1099 ) ).fract().toVar();
	p4.addAssign( p4.dot( p4.wzxy.add( 33.33 ) ) );
	return p4.xxyz.add( p4.yzzw ).mul( p4.zywx ).fract();

} );

// ---- water on the lens ------------------------------------------------------
//
// A droplet sitting on the front element is nowhere near the focal plane, so it
// does not behave like a little magnifier with a sharp picture inside it: it
// smears whatever is behind it and picks up a bright rim off the grazing light.
// That, plus the fact that they arrive in bursts and then creep outward under the
// airflow before drying, is the whole of the effect.
//
// A droplet and the streak it has been drawn into together make an ellipse
// elongated along the airflow, so cellularising in a frame stretched along that
// direction lets one cell hold one whole droplet - which is one hash per layer
// instead of a nine-cell neighbourhood search, and this runs on every pixel of
// the composite.
//
// The flow direction has to be constant across the frame. Deriving it per pixel
// from the radial direction seemed more physical - water is dragged outward from
// wherever the camera is pointed - but normalize(p) is perpendicular to its own
// perpendicular by construction, so the lattice's second coordinate came out
// identically zero and the whole field collapsed into concentric rings with no
// droplets in them at all. The radial character is put back below as a streak
// length that grows toward the edges, where the airflow is faster.
//
//   void lensLayer(vec2 p, float rn, float scale, float stretch, float sizeK,
//                  float seed, float wet,
//                  inout vec2 off, inout float blur, inout float rim, inout float cover){
//     vec2 fl = uLensFlow;
//     vec2 perp = vec2(-fl.y, fl.x);
//     vec2 q = vec2(dot(p, fl) / max(stretch, 0.2), dot(p, perp)) * scale + seed;
//     vec2 cell = floor(q);
//     vec4 h = hash14(cell);
//     if (h.x > wet) return;
//     float life = 1.6 + 3.4 * h.y;
//     float age  = fract(uTime / life + h.z);
//     float amp  = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.5, 1.0, age));
//     if (amp < 0.01) return;
//     vec2 local = fract(q) - 0.5;
//     vec2 c = (vec2(h.w, fract(h.x * 71.3)) - 0.5) * 0.44;
//     float tail = 1.0 + age * uLensStreak * 3.0 * (1.0 + 0.45 * rn);
//     c.x += (age - 0.5) * uLensStreak * 0.30;
//     float rad = (0.17 + 0.20 * h.y) * sizeK;
//     vec2 dv = (local - c) / vec2(tail, 1.0);
//     float dd = length(dv) / max(rad, 1e-3);
//     if (dd > 1.06) return;
//     float prof = max(1.0 - dd * dd, 0.0);
//     vec2 dir = dv / max(length(dv), 1e-4);
//     vec2 dirL = normalize(fl * dir.x * max(stretch, 0.2) + perp * dir.y + vec2(1e-6));
//     off  -= dirL * dd * prof * uLensRefract * rad * amp;
//     blur  = max(blur, amp * prof);
//     rim  += amp * smoothstep(0.55, 0.97, dd) * (1.0 - smoothstep(1.0, 1.06, dd));
//     cover = max(cover, amp * (1.0 - smoothstep(0.92, 1.04, dd)));
//   }
//
// PLAIN JS BUILDER WITH FOUR MUTABLE OUT-PARAMETERS, not an Fn - see note F1.
// `scale`, `stretch` and `seed` are JS numbers; `sizeK`, `wet` and `rn` are
// nodes; `off`, `blur`, `rim` and `cover` are .toVar()s the caller owns.
//
// Note the accumulators are NOT all the same shape: off is -=, rim is +=, and
// blur and cover are both max(). Getting one of those wrong makes a picture that
// still has droplets in it.
export function lensLayer( p, rn, scale, stretch, sizeK, seed, wet, off, blur, rim, cover ) {

	// max(stretch, 0.2) with stretch a compile-time literal - folded in JS, which
	// is exactly what the GLSL compiler does with it.
	const stretchC = Math.max( stretch, 0.2 );

	const fl = uLensFlow;
	const perp = vec2( fl.y.negate(), fl.x ).toVar();
	const q = vec2( p.dot( fl ).div( stretchC ), p.dot( perp ) ).mul( scale ).add( seed ).toVar();
	const cell = q.floor().toVar();
	const h = hash14( cell ).toVar();

	// Only some cells ever hold a droplet, and the fraction rises with how wet the
	// lens is - so drying off thins the field rather than just fading it out.
	//   if (h.x > wet) return;
	If( h.x.lessThanEqual( wet ), () => {

		// Its own clock: lands fast, sits, creeps, dries slowly.
		const life = float( 1.6 ).add( float( 3.4 ).mul( h.y ) ).toVar();
		const age = uTime.div( life ).add( h.z ).fract().toVar();
		const amp = smoothstep( 0.0, 0.05, age ).mul( float( 1.0 ).sub( smoothstep( 0.5, 1.0, age ) ) ).toVar();

		//   if (amp < 0.01) return;
		If( amp.greaterThanEqual( 0.01 ), () => {

			const local = q.fract().sub( 0.5 ).toVar();
			const c = vec2( h.w, h.x.mul( 71.3 ).fract() ).sub( 0.5 ).mul( 0.44 ).toVar();

			// It creeps a little, and draws out into a tail as it goes. Expressing the
			// streak as elongation rather than as bodily translation is what keeps the
			// droplet inside the cell that owns it - sliding it out culls most of them
			// against the cell test before they are ever drawn.
			// Streaking grows toward the frame edge, where the airflow is faster - but only
			// mildly. At 0.9 the edge droplets were drawn out nearly twice as far as the
			// central ones, which thinned them and made the middle of the frame look like
			// where the water was landing.
			const tail = float( 1.0 ).add(
				age.mul( uLensStreak ).mul( 3.0 ).mul( float( 1.0 ).add( float( 0.45 ).mul( rn ) ) ),
			).toVar();

			// c.x += (age - 0.5) * uLensStreak * 0.30
			// Reconstructed, never swizzle-assigned.
			c.assign( vec2( c.x.add( age.sub( 0.5 ).mul( uLensStreak ).mul( 0.30 ) ), c.y ) );

			const rad = float( 0.17 ).add( float( 0.20 ).mul( h.y ) ).mul( sizeK ).toVar();
			const dv = local.sub( c ).div( vec2( tail, 1.0 ) ).toVar();
			const dd = dv.length().div( rad.max( 1e-3 ) ).toVar();

			//   if (dd > 1.06) return;
			If( dd.lessThanEqual( 1.06 ), () => {

				// A spherical cap's slope grows toward its edge, which is why a droplet bends
				// the picture hardest around its rim and barely at all through its middle.
				const prof = float( 1.0 ).sub( dd.mul( dd ) ).max( 0.0 ).toVar();
				const dir = dv.div( dv.length().max( 1e-4 ) ).toVar();
				// Back into lens space: the offset has to point where the geometry does, not
				// where the stretched cell frame does.
				const dirL = fl.mul( dir.x ).mul( stretchC ).add( perp.mul( dir.y ) ).add( vec2( 1e-6 ) ).normalize().toVar();

				off.subAssign( dirL.mul( dd ).mul( prof ).mul( uLensRefract ).mul( rad ).mul( amp ) );
				blur.assign( blur.max( amp.mul( prof ) ) );
				rim.addAssign(
					amp.mul( smoothstep( 0.55, 0.97, dd ) ).mul( float( 1.0 ).sub( smoothstep( 1.0, 1.06, dd ) ) ),
				);
				cover.assign( cover.max( amp.mul( float( 1.0 ).sub( smoothstep( 0.92, 1.04, dd ) ) ) ) );

			} );

		} );

	} );

}

// ---- COMPOSITE --------------------------------------------------------------

// COMPOSITE_FS:334-509, in order.
export const compositeFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();

	const d = vUv.sub( 0.5 ).toVar();
	const asp = vec2( uRes.x.div( uRes.y ), 1.0 ).toVar();
	// Aspect-corrected image-circle coordinates: one unit of p.y is one unit of
	// p.x is one unit of picture height, so "pixels" means the same thing in both.
	const p = d.mul( asp ).toVar();
	const r2max = asp.mul( 0.5 ).dot( asp.mul( 0.5 ) ).toVar();
	// 0 at centre, 1 at the corner
	const rn2 = p.dot( p ).div( r2max ).toVar();

	// Radial distortion. Positive k (pincushion) is divided by (1+k) so the
	// corners stay pinned — without that the frame samples past the render
	// target and smears. Negative k (barrel, the default −0.02) must NOT use
	// that same divide: (1+k*rn2)/(1+k) is > 1 anywhere inside the rectangle,
	// so the top and bottom mid-edges look up past the texture and clamp-to-
	// edge repeats the first/last row as a 5–10 px smeared band. Leaving the
	// denominator at 1 keeps the centre 1:1 and pulls the corners in slightly.
	const kDenom = float( 1.0 ).add( uDistortion.max( 0.0 ) );
	const kd = float( 1.0 ).add( uDistortion.mul( rn2 ) ).div( kDenom.max( 1e-4 ) ).toVar();
	const pd = p.mul( kd ).toVar();
	const base = pd.div( asp ).toVar();

	// Water on the front element, in lens space - it belongs to the glass, so it
	// must not move with the radial distortion applied to the scene below.
	const lensOff = vec2( 0.0 ).toVar();
	const lensBlur = float( 0.0 ).toVar();
	const lensRim = float( 0.0 ).toVar();
	const lensCover = float( 0.0 ).toVar();

	If( uLensWet.greaterThan( 0.003 ), () => {

		// The airflow over a housing at speed carries water up and off the glass.
		// Cell counts matter more than they look. At scale 5 with stretch 2.4 the
		// coarse layer had 2.1 rows across the whole frame height, so a big droplet
		// could only ever land in one of two vertical bands - and since the expected
		// count at riding wetness was 0.4, the one droplet you did get was almost
		// always the middle one. That is the "they mostly hit the centre". Finer
		// lattice, lower occupancy per cell: same number of droplets, spread over
		// ten times as many possible positions, and half the size.
		lensLayer( p, rn2, 10.0, 2.0, uLensSize.mul( 1.00 ), 0.0, uLensWet.mul( uLensDrops ),
			lensOff, lensBlur, lensRim, lensCover );
		lensLayer( p, rn2, 21.0, 1.6, uLensSize.mul( 0.50 ), 41.7, uLensWet.mul( uLensDrops ).mul( 0.6 ),
			lensOff, lensBlur, lensRim, lensCover );

		// Before it beads up it is an unbroken film, which does not draw shapes - it
		// just softens and slightly swims.
		const fw = uLensWet.mul( uLensFilm ).toVar();
		If( fw.greaterThan( 0.002 ), () => {

			lensOff.addAssign(
				vec2(
					p.y.mul( 8.5 ).add( uTime.mul( 1.7 ) ).sin(),
					p.x.mul( 10.5 ).sub( uTime.mul( 2.1 ) ).cos(),
				).mul( 0.004 ).mul( fw ),
			);
			lensBlur.assign( lensBlur.max( fw.mul( 0.40 ) ) );

		} );

	} );

	const lensUv = lensOff.div( asp ).toVar();

	// Lateral chromatic aberration: a pure radial scale difference between the
	// channels. uChromatic is the red-to-blue separation AT THE CORNER, in
	// pixels, so it stays a ~1px optical detail instead of tracking feature size
	// and painting rainbows onto every sub-pixel glint.
	const col = vec3( 0.0 ).toVar();
	const caPx = uChromatic.mul( rn2 ).toVar();

	If( caPx.greaterThan( 0.02 ), () => {

		const len = pd.length().max( 1e-6 ).toVar();
		const caStep = pd.div( len ).mul( float( 0.5 ).mul( caPx ).div( uRes.y ) ).div( asp ).toVar();
		const cb = vec2( 0.5 ).add( base ).add( lensUv ).toVar();
		// Built into locals and written once - no swizzle assignment (note F6).
		const cr = srcTexture.sample( srcUV( cb.add( caStep ) ) ).level( 0 ).r.toVar();
		const cg = srcTexture.sample( srcUV( cb ) ).level( 0 ).g.toVar();
		const cbl = srcTexture.sample( srcUV( cb.sub( caStep ) ) ).level( 0 ).b.toVar();
		col.assign( vec3( cr, cg, cbl ) );

	} ).Else( () => {

		col.assign( srcTexture.sample( srcUV( vec2( 0.5 ).add( base ).add( lensUv ) ) ).level( 0 ).rgb );

	} );

	// Whatever is behind a droplet is thrown far out of focus, so it has to be
	// sampled wide rather than sharp - a sharp image inside a droplet is the single
	// thing that makes this read as a decal stuck on the picture.
	If( lensBlur.greaterThan( 0.02 ), () => {

		const e = vec2( lensBlur.mul( 0.012 ), 0.0 ).div( asp ).toVar();
		const cb = vec2( 0.5 ).add( base ).add( lensUv ).toVar();
		const sm = srcTexture.sample( srcUV( cb.add( e ) ) ).level( 0 ).rgb
			.add( srcTexture.sample( srcUV( cb.sub( e ) ) ).level( 0 ).rgb )
			.add( srcTexture.sample( srcUV( cb.add( e.yx ) ) ).level( 0 ).rgb )
			.add( srcTexture.sample( srcUV( cb.sub( e.yx ) ) ).level( 0 ).rgb )
			.toVar();
		col.assign( mix( col, sm.mul( 0.25 ), clamp( lensBlur, 0.0, 1.0 ).mul( 0.85 ) ) );

	} );

	const buv = vec2( 0.5 ).add( base ).add( lensUv ).toVar();
	const bloom = bloomTexture.sample( srcUV( buv ) ).level( 0 ).rgb.toVar();
	const glare = glareTexture.sample( srcUV( buv ) ).level( 0 ).rgb.toVar();
	bloom.assign( mix( bloom, bloom.mul( uBloomTint ), uBloomTintAmount ) );
	col.addAssign( bloom.mul( uBloomIntensity ) );
	// The wide tail, kept separate: a low, broad lift around every bright area
	// rather than a ring hugging the highlight.
	col.addAssign( glare.mul( uGlareIntensity ) );

	// The bright edge of each droplet: grazing light caught by the meniscus. Scaled
	// by what is actually behind it, so a droplet against a dark sea stays dark
	// instead of glowing on its own.
	If( lensRim.greaterThan( 0.001 ), () => {

		// The GLSL re-fetches uBloom here rather than reusing `bloom`, which by
		// this point has been tinted. Kept as a second fetch for that reason.
		const around = bloomTexture.sample( srcUV( buv ) ).level( 0 ).rgb.add( col ).toVar();
		col.addAssign( around.mul( lensRim ).mul( uLensRim ) );

	} );

	// A droplet has a body, not just an outline. Without this the rim was the only
	// thing marking it and the middle stayed as clear as the air around it, so they
	// read as soft rings drawn on the picture rather than as beads of water sitting
	// on the glass. Water absorbs a little and scatters the rest, so the body is a
	// slight darkening and a slight loss of saturation - both small, because the
	// thing is a millimetre of water and not a filter.
	If( lensCover.greaterThan( 0.002 ), () => {

		const k = lensCover.mul( uLensBody ).toVar();
		// The GLSL spells vec3(0.2126, 0.7152, 0.0722) inline here; same numbers as LW.
		const lum = col.dot( LW ).toVar();
		// Nested mix, and both are standalone (note F7).
		col.assign( mix( col, mix( col, vec3( lum ), 0.35 ).mul( 0.88 ), k ) );

	} );

	// Halation is the red-weighted back-scatter off the film base / sensor stack.
	col.addAssign( glare.mul( uHalationTint ).mul( uHalation ) );

	col.mulAssign( resolveExposure() );

	// Natural (optical) vignetting belongs in scene-linear, ahead of the curve:
	// corners then lose exposure and roll off, instead of being painted grey.
	// Normalised so vd2 == 1 exactly at the corner, whatever the aspect ratio.
	const vr = mix( float( 1.0 ), uRes.x.div( uRes.y ), uVignetteRound ).toVar();
	const vv = vec2( d.x.mul( vr ), d.y ).toVar();
	// The GLSL spells vec2(0.5*vr, 0.5) out twice inside the dot; one var, same
	// value, and the corner still normalises to exactly 1.
	const vCorner = vec2( float( 0.5 ).mul( vr ), 0.5 ).toVar();
	const vd2 = vv.dot( vv ).div( vCorner.dot( vCorner ) ).toVar();
	// ~ -1.3 stops at full
	const fall = float( 1.0 ).div(
		float( 1.0 ).add( float( 0.55 ).mul( vd2 ) ).mul( float( 1.0 ).add( float( 0.55 ).mul( vd2 ) ) ),
	).toVar();
	col.mulAssign( mix( float( 1.0 ), fall, uVignette ).max( 0.0 ) );

	// Black point, subtracted in scene-linear the way a densitometer defines it.
	// Doing this before the curve means the shadows lose *exposure* and fall down
	// the toe; doing it after the curve would only paint the low end darker and
	// flatten it. Negative is the useful other direction -- flare on the print.
	col.assign( col.sub( uBlackPoint.mul( 0.02 ) ).max( vec3( 0.0 ) ) );

	// ---- grade, scene-referred, ahead of the tone curve ----
	col.mulAssign( uWhiteBalance );
	col.assign( col.mul( uGain ).add( uLift.mul( vec3( 1.0 ).sub( col ).max( vec3( 0.0 ) ) ) ) );
	col.assign( col.max( vec3( 0.0 ) ).pow( vec3( 1.0 ).div( uGammaCC.max( vec3( 0.05 ) ) ) ) );
	const l0 = col.dot( LW ).toVar();
	col.assign( mix( vec3( l0 ), col, uSaturation ).max( vec3( 0.0 ) ) );

	// Contrast about middle grey in log2 -- the axis a film curve works on. Doing
	// it linearly (as this used to) shears the highlights and fights the tonemap,
	// which is the other half of why the frame read flat.
	const t = col.max( vec3( 1e-6 ) ).div( 0.18 ).log2().mul( uContrast ).toVar();

	// Film toe. Extra density that is zero at middle grey, ramps in over the
	// shadows and then saturates, so the wave backs gain weight without the
	// midtones moving. A Gaussian ramp keeps dD/dlogE positive everywhere, i.e.
	// the curve stays monotone and never inverts however hard it is driven --
	// which a plain shadow gamma does not.
	const sh = t.negate().max( vec3( 0.0 ) ).div( uToeRange.max( 0.25 ) ).toVar();
	t.subAssign( uToe.mul( vec3( 1.0 ).sub( sh.mul( sh ).negate().exp() ) ) );
	col.assign( t.exp2().mul( 0.18 ) );

	// `pre` is a SNAPSHOT taken before tonemapping, which chroma restore steers
	// back toward. vec3(col) makes it unambiguously a copy rather than an alias.
	const pre = vec3( col ).toVar();

	If( uTonemap.equal( int( 0 ) ), () => {

		col.assign( agx( col ) );

	} ).ElseIf( uTonemap.equal( int( 1 ) ), () => {

		col.assign( aces( col ) );

	} ).Else( () => {

		col.assign( reinhardJodie( col ) );

	} );

	// Per-channel tone curves are what give film its highlight rolloff, but they
	// also drag every hot colour toward white -- the reason a lit sea can come out
	// of the shoulder as monochrome sepia. Steering part of the way back to the
	// scene chromaticity at the *displayed* luminance restores the hue without
	// undoing the rolloff. This is the same idea as AgX's outset, applied as a
	// continuously dialable amount.
	If( uChromaRestore.greaterThan( 0.0 ), () => {

		const lp = pre.dot( LW ).toVar();
		const lt = col.dot( LW ).toVar();
		col.assign( clamp( mix( col, pre.mul( lt.div( lp.max( 1e-5 ) ) ), uChromaRestore ), 0.0, 1.0 ) );

	} );

	// Split toning. Every film stock and every graded photograph carries a
	// different hue in the toe than in the shoulder; a perfectly neutral ramp is
	// one of the tells that an image was rendered rather than shot.
	If( uSplit.greaterThan( 0.0 ), () => {

		// The selector has to be perceptual, not linear: 0.5 in linear is 73% of
		// the way up the display ramp, so a linear crossover calls almost the whole
		// picture "shadow" and the highlight tint never arrives.
		const ls = clamp( col.dot( LW ), 0.0, 1.0 ).pow( float( 1.0 ).div( 2.2 ) ).toVar();
		col.mulAssign( mix( vec3( 1.0 ), uSplitShadow, float( 1.0 ).sub( smoothstep( 0.0, 0.55, ls ) ).mul( uSplit ) ) );
		col.mulAssign( mix( vec3( 1.0 ), uSplitHigh, smoothstep( 0.45, 1.0, ls ).mul( uSplit ) ) );

	} );

	// Print saturation, after the curve, where it behaves like a film stock.
	const l1 = col.dot( LW ).toVar();
	col.assign( mix( vec3( l1 ), col, uPostSaturation ).max( vec3( 0.0 ) ) );

	const disp = clamp( col, 0.0, 1.0 ).pow( vec3( float( 1.0 ).div( 2.2 ) ) ).toVar();

	// Dither in display space, where the 8-bit quantisation actually happens.
	// (Grain is deliberately NOT here -- see fxaaFragment.)
	// gl_FragCoord, not screenCoordinate: glFragCoord() is the GLSL's bottom-up
	// pixel coordinate, and a flip here changes which pixel gets which jitter.
	disp.addAssign(
		hash12(
			glFragCoord().mul( 1.7 ).add( vec2( uTime.fract().mul( 13.0 ) ) ),
		).sub( 0.5 ).div( 255.0 ),
	);

	return vec4( clamp( disp, 0.0, 1.0 ), 1.0 );

} );

// ---- FXAA + grain -----------------------------------------------------------

// FXAA_FS:524. NTSC luma - the edge detector's, NOT LW. See note D.
const lumFxaa = /*@__PURE__*/ Fn( ( [ c ] ) => {

	return c.dot( LUM_FXAA );

} );

// Grain is added after the edge filter, not in the composite: an antialiaser
// cannot tell grain from aliasing and will happily average away most of it,
// which is why the frame ends up looking like clean video with a faint dirty
// overlay instead of like film.
//
// Grain lives in density space, so it goes on after the OETF. It peaks in the
// midtones: film has almost no visible grain in the toe or a blown highlight.
//
//   vec3 filmGrain(vec3 disp){
//     if (uGrain <= 0.0) return disp;
//     float fr = floor(uTime*24.0);
//     vec2 gp = gl_FragCoord.xy / max(uGrainSize, 0.35)
//             + vec2(hash12(vec2(fr, 1.7)), hash12(vec2(fr, 9.3))) * 512.0;
//     float mono = vnoise(gp) - 0.5;
//     vec3 chroma = vec3(vnoise(gp + 31.7), vnoise(gp + 71.3), vnoise(gp + 117.1)) - 0.5;
//     vec3 g = mix(vec3(mono), chroma, uGrainChroma);
//     float ld = dot(disp, LW);
//     float shape = mix(sqrt(clamp(4.0*ld*(1.0 - ld), 0.0, 1.0)),
//                       1.0/(1.0 + 7.0*ld), uGrainShadow);
//     return disp + g * (uGrain * 1.7) * (0.12 + 0.88*shape);
//   }
//
// The early return becomes a result var seeded with `disp` (note F2). FXAA_FS's
// `vnoise` is ./noise.js's vnoise2, the 2-D one.
export const filmGrain = /*@__PURE__*/ Fn( ( [ dispIn ] ) => {

	const disp = vec3( dispIn ).toVar();
	const res = vec3( disp ).toVar();

	If( uGrain.greaterThan( 0.0 ), () => {

		// Resample the grain field once per 24fps frame, at a decorrelated offset,
		// so it flickers like film rather than crawling along a diagonal.
		const fr = uTime.mul( 24.0 ).floor().toVar();
		const gp = glFragCoord().div( uGrainSize.max( 0.35 ) )
			.add( vec2( hash12( vec2( fr, 1.7 ) ), hash12( vec2( fr, 9.3 ) ) ).mul( 512.0 ) )
			.toVar();

		const mono = vnoise2( gp ).sub( 0.5 ).toVar();
		const chroma = vec3(
			vnoise2( gp.add( vec2( 31.7 ) ) ),
			vnoise2( gp.add( vec2( 71.3 ) ) ),
			vnoise2( gp.add( vec2( 117.1 ) ) ),
		).sub( 0.5 ).toVar();
		const g = mix( vec3( mono ), chroma, uGrainChroma ).toVar();

		const ld = disp.dot( LW ).toVar();
		// Two different noises share this knob because both are real and they live in
		// opposite places: silver-halide granularity peaks in the midtones, while
		// sensor read noise is loudest where there is least signal. uGrainShadow
		// slides between "shot on film" and "shot at high ISO".
		const shape = mix(
			clamp( float( 4.0 ).mul( ld ).mul( float( 1.0 ).sub( ld ) ), 0.0, 1.0 ).sqrt(),
			float( 1.0 ).div( float( 1.0 ).add( float( 7.0 ).mul( ld ) ) ),
			uGrainShadow,
		).toVar();

		res.assign( disp.add( g.mul( uGrain.mul( 1.7 ) ).mul( float( 0.12 ).add( float( 0.88 ).mul( shape ) ) ) ) );

	} );

	return res;

} );

// FXAA_FS:555-573.
export const fxaaFragment = /*@__PURE__*/ Fn( () => {

	const vUv = glScreenUV().toVar();
	const t = uFxaaTexel.toVar();

	const tap = ( c ) => ldrTexture.sample( srcUV( c ) ).level( 0 ).rgb;

	const rgbM = tap( vUv ).toVar();
	const out = vec3( 0.0 ).toVar();

	// Two DIFFERENT outcomes, so If/Else on one shared result var rather than a
	// complement guard (note F3).
	If( uAmount.lessThanEqual( 0.0 ), () => {

		out.assign( clamp( filmGrain( rgbM ), 0.0, 1.0 ) );

	} ).Else( () => {

		const rgbNW = tap( vUv.add( t.mul( vec2( - 1, - 1 ) ) ) ).toVar();
		const rgbNE = tap( vUv.add( t.mul( vec2( 1, - 1 ) ) ) ).toVar();
		const rgbSW = tap( vUv.add( t.mul( vec2( - 1, 1 ) ) ) ).toVar();
		const rgbSE = tap( vUv.add( t.mul( vec2( 1, 1 ) ) ) ).toVar();

		const lNW = lumFxaa( rgbNW ).toVar();
		const lNE = lumFxaa( rgbNE ).toVar();
		const lSW = lumFxaa( rgbSW ).toVar();
		const lSE = lumFxaa( rgbSE ).toVar();
		const lM = lumFxaa( rgbM ).toVar();

		const lMin = lM.min( lNW.min( lNE ).min( lSW.min( lSE ) ) ).toVar();
		const lMax = lM.max( lNW.max( lNE ).max( lSW.max( lSE ) ) ).toVar();

		const dir = vec2(
			lNW.add( lNE ).sub( lSW.add( lSE ) ).negate(),
			lNW.add( lSW ).sub( lNE.add( lSE ) ),
		).toVar();

		const reduce = lNW.add( lNE ).add( lSW ).add( lSE ).mul( 0.03125 ).max( 0.0078125 ).toVar();
		const rcpDir = float( 1.0 ).div( dir.x.abs().min( dir.y.abs() ).add( reduce ) ).toVar();
		dir.assign( clamp( dir.mul( rcpDir ), - 8.0, 8.0 ).mul( t ) );

		const rgbA = tap( vUv.add( dir.mul( float( 1.0 ).div( 3.0 ).sub( 0.5 ) ) ) )
			.add( tap( vUv.add( dir.mul( float( 2.0 ).div( 3.0 ).sub( 0.5 ) ) ) ) )
			.mul( 0.5 ).toVar();
		const rgbB = rgbA.mul( 0.5 ).add(
			tap( vUv.add( dir.mul( - 0.5 ) ) ).add( tap( vUv.add( dir.mul( 0.5 ) ) ) ).mul( 0.25 ),
		).toVar();

		// The GLSL calls lum(rgbB) twice in the same expression; one .toVar() is
		// the same value (note F4).
		const lb = lumFxaa( rgbB ).toVar();
		// NOT the boolean select the GLSL spells. This was
		//   select( lb.lessThan( lMin ).or( lb.greaterThan( lMax ) ), rgbA, rgbB )
		// and that formulation is the one thing in this program that Chrome's
		// Metal shader compiler miscompiles: field-bisected on an Apple metal-3
		// adapter to exactly this pass (composite LDR healthy at 0.258/0.515,
		// this program's output black; grain and the taps exonerated by running
		// the uAmount<=0 branch, which measured bright). SwiftShader and WebKit
		// execute the same WGSL correctly, so the WGSL is right and the .or()+
		// select lowering is what breaks. Arithmetic instead, equality-exact:
		// step(e,x) is 0 when x<e else 1, so 1-step(lMin,lb) is the STRICT
		// lb<lMin and 1-step(lb,lMax) the STRICT lb>lMax, matching the
		// comparisons at their boundaries bit for bit - the post golden agrees
		// to 0/16000 on both backends.
		const outside = clamp(
			float( 1.0 ).sub( step( lMin, lb ) ).add( float( 1.0 ).sub( step( lb, lMax ) ) ),
			0.0, 1.0,
		).toVar();
		const res = mix( rgbB, rgbA, outside ).toVar();

		out.assign( clamp( filmGrain( mix( rgbM, res, uAmount ) ), 0.0, 1.0 ) );

	} );

	return vec4( out, 1.0 );

} );

// ---- the two programs with no GLSL counterpart ------------------------------

// Writes ADAPT_SEED into a 1x1 RGBA32F target. See note E: this is what
// src/post.js does with a texture upload, which a RenderTarget cannot do.
export const adaptSeedFragment = /*@__PURE__*/ Fn( () => {

	return vec4( ADAPT_SEED[ 0 ], ADAPT_SEED[ 1 ], ADAPT_SEED[ 2 ], ADAPT_SEED[ 3 ] );

} );

// Copies the current adapt value into a wider staging target so it can be read
// back. A 1x1 RGBA32F target has a 16-byte row and WebGPU's copy needs a
// 256-byte pitch (porting rule 10); ./post-driver.js stages through 64x1.
export const adaptReadFragment = /*@__PURE__*/ Fn( () => {

	return adaptTexture.sample( vec2( 0.5 ) ).level( 0 );

} );

// ---- CPU-side helpers -------------------------------------------------------

// src/post.js:8-17, verbatim.
//
// Approximate Planckian-locus RGB gains. Positive temperature = warmer image
// (as on a camera's Kelvin dial), positive tint = greener.
export function whiteBalanceGains( temperature, tint ) {

	const t = Math.max( - 1, Math.min( 1, temperature || 0 ) );
	const g = Math.max( - 1, Math.min( 1, tint || 0 ) );
	const r = 1 + 0.22 * t + 0.02 * g;
	const gr = 1 - 0.02 * Math.abs( t ) + 0.14 * g;
	const b = 1 - 0.22 * t + 0.02 * g;
	// Renormalise on luminance so white balance never doubles as an exposure knob.
	const y = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
	return new Float32Array( [ r / y, gr / y, b / y ] );

}

// src/post.js:121-126, verbatim.
// Direction the airflow drags water across the glass, normalised.
export function lensFlow( p ) {

	const a = p.lensFlowAngle * Math.PI / 180;
	return [ Math.sin( a ), Math.cos( a ) ];

}

// The white balance gains are a pure function of two params and involve a
// division, so src/post.js:215-216 recomputes them only when those two change.
// Same cache, same key.
let _wb = /*@__PURE__*/ whiteBalanceGains( 0, 0 );
let _wbKey = '0,0';

/**
 * Write every uniform the post chain reads that comes from the params or the
 * frame. Mirrors the four setUniforms() calls in src/post.js.render() plus
 * exposureUniforms().
 *
 * NOT set here, deliberately, because they are per-DRAW rather than per-frame
 * and ./post-driver.js owns them: uPrefilterTexel, uDownTexel, uUpTexel,
 * uFxaaTexel, uRes, uBlend and uAmount (the last because photo mode ramps it
 * over the sample count instead of using p.fxaa - src/post.js:249-251).
 *
 * @param {object} p - the params object.
 * @param {object} ctx - { time, dt, lensWet }.
 */
export function setPostUniforms( p, ctx ) {

	// PORTING RULE 13. uTime is declared in ./cloud-field.js and read here; the
	// driver must not be able to draw a frame whose clock was last written by
	// whoever happened to render before it.
	uTime.value = ctx.time;

	// exposureUniforms(p) - src/post.js:112-118.
	uExposure.value = p.exposure;
	uAutoExposure.value = p.autoExposure;
	uExposureBias.value = p.exposureBias;
	uExposureTarget.value = p.exposureTarget;

	// prefilter - src/post.js:178-183.
	uThreshold.value = p.bloomThreshold;
	uKnee.value = Math.max( p.bloomKnee, 1e-3 );
	uClamp.value = p.bloomClamp;
	uVeil.value = p.bloomVeil;

	// up - src/post.js:200-205.
	uRadius.value = p.bloomRadius;
	uAnamorphic.value = p.bloomAnamorphic;
	uWeight.value = p.bloomFalloff;

	// lum - src/post.js:139-142.
	uMeterCenter.value = p.meterCenter;
	uMeterHi.value = p.meterHighlight;
	uMeterLo.value = p.meterShadow;

	// adapt - src/post.js:151-166.
	// Clamped so a dropped frame cannot jump the iris, but not so hard that a
	// genuinely slow machine takes a hundred frames to settle.
	uDt.value = Math.min( ctx.dt, 0.3 );
	uSpeed.value = p.exposureSpeed;
	uSpeedUp.value = Math.max( p.exposureSpeedUp, 0.05 );
	uMinLog.value = Math.log2( p.exposureMin );
	uMaxLog.value = Math.log2( p.exposureMax );
	uSigma.value = p.meterSigma;
	uCwMean.value = 1 - 0.4423 * p.meterCenter;
	uHiHeadroom.value = Math.log2( Math.max( p.meterHiTarget, 1e-3 ) / Math.max( p.exposureTarget, 1e-4 ) );

	// composite - src/post.js:221-242.
	uBloomIntensity.value = p.bloomIntensity;
	uBloomTint.value.set( p.bloomTint[ 0 ], p.bloomTint[ 1 ], p.bloomTint[ 2 ] );
	uBloomTintAmount.value = p.bloomTintAmount;
	uGlareIntensity.value = p.glareIntensity;
	uVignette.value = p.vignette;
	uVignetteRound.value = p.vignetteRound;
	uChromatic.value = p.chromatic;
	uDistortion.value = p.distortion;
	uContrast.value = p.contrast;
	uSaturation.value = p.saturation;
	uPostSaturation.value = p.postSaturation;
	uBlackPoint.value = p.blackPoint;
	uToe.value = p.toeStrength;
	uToeRange.value = p.toeRange;
	uChromaRestore.value = p.chromaRestore;
	uSplit.value = p.splitTone;
	uSplitShadow.value.set( p.splitShadow[ 0 ], p.splitShadow[ 1 ], p.splitShadow[ 2 ] );
	uSplitHigh.value.set( p.splitHighlight[ 0 ], p.splitHighlight[ 1 ], p.splitHighlight[ 2 ] );
	uLift.value.set( p.lift[ 0 ], p.lift[ 1 ], p.lift[ 2 ] );
	uGammaCC.value.set( p.gammaCC[ 0 ], p.gammaCC[ 1 ], p.gammaCC[ 2 ] );
	uGain.value.set( p.gain[ 0 ], p.gain[ 1 ], p.gain[ 2 ] );

	const wbKey = `${ p.temperature },${ p.tintCC }`;
	if ( wbKey !== _wbKey ) {

		_wb = whiteBalanceGains( p.temperature, p.tintCC );
		_wbKey = wbKey;

	}

	uWhiteBalance.value.set( _wb[ 0 ], _wb[ 1 ], _wb[ 2 ] );

	uTonemap.value = p.tonemap;
	uHighlightRoll.value = p.highlightRoll;
	uHalation.value = p.halation;
	uHalationTint.value.set( p.halationTint[ 0 ], p.halationTint[ 1 ], p.halationTint[ 2 ] );

	// The lens water block. uLensWet is the only one that is not a straight param
	// read: how wet the glass is right now, times the preset's allowance.
	uLensWet.value = ( ctx.lensWet ?? 0 ) * p.lensWater;
	uLensDrops.value = p.lensDrops;
	uLensSize.value = p.lensSize;
	uLensRefract.value = p.lensRefract;
	uLensStreak.value = p.lensStreak;
	uLensRim.value = p.lensRim;
	uLensFilm.value = p.lensFilm;
	const fl = lensFlow( p );
	uLensFlow.value.set( fl[ 0 ], fl[ 1 ] );
	uLensBody.value = p.lensBody;

	// fxaa/grain - src/post.js:255-259. uAmount is the driver's.
	uGrain.value = p.grain;
	uGrainSize.value = p.grainSize;
	uGrainChroma.value = p.grainChroma;
	uGrainShadow.value = p.grainShadow;

}
