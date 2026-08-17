// The wave simulation itself, as TSL node graphs: the JONSWAP/TMA spectrum with
// Donelan-Banner spreading, the time evolution, the radix-2 butterfly FFT, the
// assemble step (displacement + slope, two colour attachments) and the foam
// accumulator.
//
// Ported from src/shaders/oceanSim.js, one stage per GLSL program:
//
//   COMMON            :19-28   -> PI_S/TAU_S/G_S, cmul/cconj/cexp/sqr
//   INIT_SPECTRUM_FS  :32-231  -> initSpectrumFragment (+ tmaDepth, jonswap,
//                                 sech2, spreading, swell)
//   TIME_EVOLVE_FS    :235-274 -> timeEvolveFragment   (2 attachments)
//   FFT_FS            :278-303 -> fftFragment          (2 attachments)
//   ASSEMBLE_FS       :307-353 -> assembleFragment     (2 attachments)
//   FOAM_FS           :357-520 -> foamFragment
//   (no GLSL counterpart)      -> foamPublishFragment, see note 9
//
// The schedule, the render targets and the mip protocol live in ./sim-driver.js.
// This file creates no texture, no render target and no material; it is a pile
// of node graphs and the uniforms they read, and it is loadable in node.
//
// One source, both backends. Three compiles these graphs to WGSL on WebGPU and
// to GLSL on WebGL2. No wgslFn, no glslFn - a raw-source node compiles for
// exactly one backend and would put the fallback back where it started.
//
// The physics is unchanged. Every constant, sign, clamp and magic number below
// is the one that shipped, and the GLSL comments explaining *why* each is what
// it is are carried across with them. Several of these numbers look arbitrary
// and are not, so the comment is load-bearing documentation, not decoration.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A FRAGMENT PING-PONG AND NOT COMPUTE
//
// TSL compute does not work on the WebGL2 backend at all - prototypes/
// tsl-mechanics-probe.html fails 4/4 mechanics, one of them inside three itself.
// So a compute-only simulation cannot serve the fallback, and the shipping GLSL
// simulation is already a fragment ping-pong. prototypes/tsl-pingpong-probe.html
// proves the pattern survives the port: dependent passes over swapped float
// targets, with a gather at a computed index and two colour attachments, match a
// CPU reference to 5e-7 on BOTH backends. This module is that pattern at scale.
// The WGSL compute path in src/gpu/kernels/ remains the optimisation, not the
// requirement (docs/tsl-porting-rules.md rule 9).
//
// ---------------------------------------------------------------------------
// TWELVE THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. THE INDEX SPACE IS uv(), NEVER screenCoordinate + .load().
//
//    texelId() is the GLSL's `ivec2 id = ivec2(gl_FragCoord.xy)` and texelUv()
//    is its texelFetch. Mixing screenCoordinate with .load() double-flips on
//    WebGL - ScreenNode.generate already flips y when builder.isFlipY(), and
//    TextureNode.setupUV flips AGAIN for a .load() on a render-target texture
//    (three.webgpu.js:12690) - and silently permutes the field. Measured at
//    worst error 1.5e+1 on both backends (porting rule 9).
//
//    Everything here is expressed in uv, so the destination and the sampler are
//    transformed the same way and the flips cancel.
//
// 2. THE ORIENTATION, WHICH IS THE THING TO GET STRAIGHT BEFORE READING ANY
//    FETCH BELOW. Call "index row i" the row at v = (i + 0.5) / N.
//
//    QuadGeometry's uv is [0,-1 / 0,1 / 2,1] over the NDC triangle
//    [-1,3 / -1,-1 / 3,-1], so v = (1 - ndcY) / 2 and uv row 0 is the NDC TOP on
//    both backends.
//
//      WebGL2: NDC top is framebuffer row N-1, so index row i is written into
//        TEXTURE row N-1-i. Reading it back, TextureNode.setupUV flips v for a
//        render-target texture (three.webgpu.js:12676-12694; the flip is driven
//        by a _flipYUniform whose value is `texture.isRenderTargetTexture` at
//        update time, :13259), so a sample at v reads texture row N-1-i. THE
//        TWO FLIPS CANCEL.
//      WebGPU: neither flip fires. Index row i is texture row i.
//
//    Three consequences, all of which matter:
//
//      (a) Sim-internal reads are self-consistent on both backends, for the same
//          reason the sky LUT round-trips (rule 4, sky-driver.js's header).
//      (b) THE WATER IS ALSO CORRECT ON BOTH. It samples these fields as
//          RENDER-TARGET textures at a world uv, so it takes the same cancelling
//          flip, and the world <-> index mapping comes out identical to the
//          shipping GL path's. This is why the driver must hand the water the
//          RenderTarget's own texture and never a DataArrayTexture copy of a
//          readback: a copy is not a render-target texture, does not take the
//          flip, and comes out mirrored about the tile's z axis on WebGL only.
//      (c) CPU-UPLOADED INPUTS ARE NOT FLIPPED ON EITHER BACKEND. DataTexture and
//          DataArrayTexture default to flipY = false and are not render targets,
//          so the _flipYUniform is false for them. Noise data row r and butterfly
//          data row r are index row r - identical to the GL path, where
//          gl_FragCoord row r is texture row r is data row r.
//
// 3. EVERY TEXTURE FETCH IS EXPLICIT-LOD, `.level(...)`, WITHOUT EXCEPTION.
//    That is faithful - the GLSL uses texelFetch and textureLod exclusively and
//    never an implicit-derivative sample - and it is what makes the branches
//    legal: the spectrum's fetches sit inside two NON-UNIFORM `If`s, where an
//    implicit-LOD fetch is illegal on WGSL. The mapping is
//
//      texelFetch(tex, id, 0)              -> tex.sample( texelUv(id.x, id.y) )
//                                                .depth( uLayer ).level( 0 )
//      textureLod(tex, vec3(uv, layer), L) -> tex.sample( uv ).depth( uLayer )
//                                                .level( L )
//      textureLod(..., 32.0)               -> .level( uTopLod ), see note 5
//
//    with .depth() omitted only for the 2D butterfly table. AN ARRAY SAMPLE
//    WITHOUT .depth() SILENTLY BECOMES LAYER 0 (three.webgpu.js:12948) - never
//    omit it.
//
// 4. A texelFetch IS a `.sample()` HERE, AND IT IS STILL EXACT. On WGSL,
//    WGSLNodeBuilder.isUnfilterable (three.webgpu.js:79067) is true when min and
//    mag are both NearestFilter, and generateTextureSampleLevel then emits
//    textureLoad at `vec2u(clamp(floor(wrap(uv) * dim), 0, dim-1))`
//    (:78904-78938). With uv = (i + 0.5) / N and N a power of two, floor of
//    (i + 0.5) is exactly i, so the fetch is the texel the GLSL's texelFetch
//    read - verified by reading the emitted WGSL. On WebGL the same expression
//    is a textureLod on a NEAREST sampler, which is the same texel. The
//    driver's h0/ping/pong/noise/butterfly resources are therefore
//    Nearest+Nearest deliberately; that filter state is part of the SHADER on
//    WGSL, not a runtime knob (porting rule 11).
//
// 5. uTopLod REPLACES THE GLSL LITERAL 32.0 in the two top-mip fetches
//    (FOAM_FS:431 and :456). GL clamps an out-of-range textureLod level to the
//    last level; WGSL does not guarantee it. uTopLod = floor(log2(N)), which IS
//    the last level of a chain of floor(log2(N))+1 levels, so the value is
//    identical - it is the guarantee that is new.
//
// 6. THE MRT STAGES ARE PLAIN JS FUNCTIONS AND MUST NOT BE WRAPPED IN Fn.
//    `material.fragmentNode` only takes the two-attachment path when the node
//    itself has `.isOutputStructNode === true` (three.webgpu.js:21359); anything
//    else is `.convert()`ed to a single vec4. Measured in node:
//    `outputStruct(vec4,vec4).isOutputStructNode === true`, but
//    `Fn(() => outputStruct(a,b))().isOutputStructNode === undefined` - an
//    Fn-wrapped struct is silently collapsed to one attachment. And `If` /
//    `.toVar()` need a current TSL stack (`If = (...p) => currentStack.If(...p)`,
//    three.webgpu.js:4819), which only exists inside an Fn body.
//
//    So each MRT stage is a plain function returning `outputStruct(fnA(), fnB())`
//    where fnA and fnB are two Fns that each build their own attachment, sharing
//    a plain-JS builder called from inside both. An Fn with no layout is inlined
//    at its call site, so this emits what one fused Fn would have emitted twice.
//    The duplicated work is: for the FFT, one fetch of the tiny fully-cached
//    butterfly table and two divides, on the hot pass; for evolve, one h0 fetch,
//    one sqrt, one tanh and one sin/cos on 4 of 80 draws; for assemble, two
//    texel fetches on 4 of 80 draws.
//
//    ONE VISIBLE CONSEQUENCE: the assemble step computes J twice, once for
//    oDisp.w and once for oSlope.z. Two identical expression trees may contract
//    differently (fma) and differ in the last ulp between the two textures.
//    Nothing ever compares them - foldAt reads oDisp.w, and oSlope.z is read by
//    the shading path only.
//
// 7. RULE 11 IS SATISFIED BY CONSTRUCTION, NOT BY PLACEHOLDERS. Every stage
//    takes its TextureNodes as PARAMETERS instead of owning module-level
//    `texture()` nodes, so the driver builds each material from the REAL target's
//    texture and no placeholder can bake the wrong textureLoad-vs-
//    textureSampleLevel choice into a shader. "No placeholders" here is a
//    decision, not an omission - contrast ./water-common.js, whose samplers are
//    bound long after its graphs are built and which therefore has to give its
//    placeholders the real fields' filter state.
//
// 8. THERE IS NO uChoppy IN ASSEMBLE. ASSEMBLE_FS:311 declares it and the body
//    never reads it: the choppiness gain is already baked into Dx, Dz, dXx, dZz
//    and dXz by the evolve pass, and applying it again squares up the horizontal
//    displacement and folds the Jacobian far too early - whitecaps everywhere. A
//    GLSL uniform may be declared and unused; a TSL node nothing reads simply
//    does not appear in the shader, so there is nothing to declare. The compute
//    port carries the same warning (docs/ocean-sim-port-notes.md §2). Likewise
//    there is NO uCascadeCount: FOAM_FS:362 declares it and never references it,
//    and gl.js's setUniforms skipped it silently. It was load-bearing in the
//    COMPUTE port only, as a layer stride. Here it is genuinely dead.
//
// 9. foamPublishFragment HAS NO GLSL COUNTERPART. Ocean.foamTex alternates
//    between two buffers every step, and handing that alternation to the water's
//    foamTexture node is a measured WebGPU hazard: NodeSampledTexture.update()
//    reports the change, but the bind group is only rebuilt when
//    `binding.generation !== textureData.generation` (three.webgpu.js:33006) and
//    `textureData.generation = texture.version` (:34276) is 0 for every
//    render-target texture that has never been marked needsUpdate - so swapping
//    one render target for another leaves generation equal and WebGPU keeps
//    reading whichever texture was bound first. WebGL2 re-resolves the sampler
//    per draw and is unaffected: "compiles on both, wrong on one" again. The
//    publish pass copies the current foam layer into a target whose texture is
//    the same object forever. It is texel-exact - the source uv is snapped to
//    the texel centre, so the bilinear weights are exactly (1, 0).
//
//    The driver reuses this same graph for its verification readout pass; it is
//    "copy layer uLayer of an array texture, texel for texel" and nothing about
//    it is specific to foam.
//
// 10. `uniform float uPatch[4]` / `uniform float uCompLod[4]` INDEXED BY uLayer
//    (FOAM_FS:360-362, 382, 421, 455, 457) BECOME TWO PLAIN SCALARS, uFoamPatch
//    and uFoamLod, written per draw. uLayer is the ONLY index either array is
//    ever read with, at every one of those five sites. A uniformArray element
//    with a runtime index is legal on both backends but pointless here, and
//    water-common.js's rule ("access ONLY with a compile-time constant index")
//    would otherwise have to be broken. Value-identical.
//
// 11. THE FFT'S `uniform int uVertical` IS A JS BOOLEAN BAKED AT MATERIAL-BUILD
//    TIME, not a uniform. fftFragment(bf, s0, s1, vertical) picks the axis and
//    the two gather coordinates with a JS ternary, so no per-pixel select
//    survives. The driver builds four FFT materials, {horizontal, vertical} x
//    {reads ping, reads pong} - and the second half of that product is forced
//    anyway by note 9's bind-group hazard.
//
// 12. THREE NAMES COLLIDE WITH OTHER MODULES IN THIS DIRECTORY AND ARE SPELLED
//    APART ON PURPOSE. Nothing here imports from another TSL module, and that is
//    load-bearing:
//
//      uWaveTime   is GLSL's uTime = Ocean.time, the SIMULATION clock advanced
//                  by `time += dt * p.timeScale`. cloud-field.js's uTime is the
//                  FRAME clock and is a different number. Importing it would be
//                  a plausible-looking mistake; the rename makes it a visible one.
//      uWindDirRad is GLSL's uWindDir, a float ANGLE IN RADIANS.
//                  water-common.js's uWindDir is a vec2 UNIT DIRECTION and
//                  cloud-field.js's uWindDirV is a vec3 wind VELOCITY in m/s.
//                  All three are derived from p.windDirDeg by derive()
//                  (src/derive.js:31-37), so they cannot drift, but they are not
//                  interchangeable.
//      uWindSpeed  IS declared here even though water-surface.js exports one
//                  with the same meaning from the same source (p.windSpeed).
//                  Rule 7 is deliberately not applied: importing it would make
//                  the SIMULATION depend on the 60 KB shading stack, and the two
//                  things that must run without it - the compile probe and the
//                  fingerprint page - would drag in atmosphere, sky-lut,
//                  water-brdf and water-detail. Both nodes are written from
//                  p.windSpeed by their own setters. Never import one into the
//                  other; if you find yourself doing it you have coupled the sim
//                  to the renderer.
//
// ---------------------------------------------------------------------------
// WHAT IS NOT HERE
//
// Ocean.measure() has no counterpart. It reads specific mip levels with
// framebufferTextureLayer, which the three renderer exposes no route to.
// prototypes/ocean-tsl.html's fingerprint replaces it.

import {
	Fn, If, uv, float, vec2, vec3, vec4, uniform,
	select, smoothstep, clamp, mix, atan, inverseSqrt, dot, outputStruct,
} from 'three/tsl';

// ---- constants --------------------------------------------------------------

// oceanSim.js COMMON:20-22. These are this file's OWN spellings and must not be
// imported from anywhere: water-common.js's PI_W is 3.14159265 and atmosphere.js's
// PI_A is 3.14159265359. Three different spellings shipped, in three different
// programs, and each is the one that produced the reference image for its own
// pass. Keep all three.
export const PI_S = 3.14159265358979;
export const TAU_S = 6.28318530717959;
export const G_S = 9.80665;

// INIT_SPECTRUM_FS:60-61. Fetch stops growing the sea once it is fully
// developed; past that point the JONSWAP alpha/omega_p laws drift away from the
// measured energy, so the non-dimensional fetch is clamped and everything else
// derived from the clamp.
export const CHI_FULL = 2.2e4;

// ---- complex helpers --------------------------------------------------------
//
// COMMON:24-27.
//
//   vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
//   vec2 cconj(vec2 a){ return vec2(a.x, -a.y); }
//   vec2 cexp(float t){ return vec2(cos(t), sin(t)); }
//   float sqr(float x){ return x*x; }
//
// Fn rather than plain JS so they read like the GLSL at the call sites. None
// carries a layout, so each is INLINED where it is called - which means an
// argument that is an expression is evaluated once per use of the parameter in
// the body. Every value here is used once except sqr's x, whose duplication
// gives `(e) * (e)` for the same expression `e`: bit-identical to GLSL's
// pass-by-value, one extra evaluation of a cheap subtree.

export const cmul = /*@__PURE__*/ Fn( ( [ a, b ] ) => vec2(
	a.x.mul( b.x ).sub( a.y.mul( b.y ) ),
	a.x.mul( b.y ).add( a.y.mul( b.x ) ),
) );

export const cconj = /*@__PURE__*/ Fn( ( [ a ] ) => vec2( a.x, a.y.negate() ) );

export const cexp = /*@__PURE__*/ Fn( ( [ t ] ) => vec2( t.cos(), t.sin() ) );

export const sqr = /*@__PURE__*/ Fn( ( [ x ] ) => x.mul( x ) );

// ---- the index idiom --------------------------------------------------------

/**
 * The GLSL's `ivec2 id = ivec2(gl_FragCoord.xy)`, in floats, from uv.
 *
 * Kept in the float domain: nothing downstream needs an integer type, and
 * porting rule 2 makes an int a liability the moment it meets min/max with a
 * scalar (MathNode.generate forces the scalar operand to float, and GLSL ES 3.00
 * has no min(int, float) overload - WebGL2 fails to compile while WebGPU is
 * fine). The values are exactly integral, so the two are interchangeable.
 *
 * MUST be called from inside an Fn body - `.toVar()` appends to the current TSL
 * stack, and at module scope there is nothing to append to.
 *
 * @returns {Node} vec2 var holding (ix, iy), each an exact integer in 0..N-1.
 */
export function texelId() {

	return uv().mul( uN ).floor().toVar();

}

/**
 * The centre of texel (ix, iy) of an N x N field - the GLSL's texelFetch
 * coordinate, expressed as the uv the sampler wants.
 *
 * NEVER screenCoordinate + .load(): see note 1 in the header.
 *
 * @param {Node} ix - float node holding an integer column index.
 * @param {Node} iy - float node holding an integer row index.
 * @returns {Node} vec2 uv.
 */
export function texelUv( ix, iy ) {

	return vec2( ix.add( 0.5 ).div( uN ), iy.add( 0.5 ).div( uN ) );

}

/**
 * The butterfly table's fetch coordinate. That table is the one buffer in the
 * system not indexed like the others: it is `stages` WIDE and N TALL, written by
 * butterflyData() at (y * stages + s) * 4, and it has no layer - one table
 * serves every cascade.
 *
 * @param {Node} stage - float node holding the stage index (the column).
 * @param {Node} axis - float node holding the transform-axis index (the row).
 */
export function butterflyUv( stage, axis ) {

	return vec2( stage.add( 0.5 ).div( uStages ), axis.add( 0.5 ).div( uN ) );

}

// ---- uniforms ---------------------------------------------------------------
//
// Defaults are src/presets.js `defaults` + DEFAULT_CASCADES[0] + N = 256, so the
// module evaluates to a sane sea before any setter has run - the water-common.js
// precedent. Every setter below is the mirror of one setUniforms() call in
// src/ocean.js, so the two paths cannot drift.

// -- grid: set once per allocation by setSimGrid() --

// GLSL uN. Read by the spectrum, the evolve and the foam stages, and by every
// texelUv in this file.
export const uN = /*@__PURE__*/ uniform( 256.0 );

// NEW. The GL path got the butterfly table's width from the texture; a uv needs
// it as a number. = butterflyData(N).stages = round(log2(N)).
export const uStages = /*@__PURE__*/ uniform( 8.0 );

// NEW. Replaces the GLSL literal 32.0 in the two top-mip fetches - see note 5.
export const uTopLod = /*@__PURE__*/ uniform( 8.0 );

// -- per draw --

// GLSL uLayer. Compared and indexed only, never fed to min/max (porting rule 2).
export const uLayer = /*@__PURE__*/ uniform( 0, 'int' );

// GLSL uL - the patch size in metres of the cascade being drawn. Read by the
// spectrum, the evolve and the foam stages, so all three setters write it.
export const uL = /*@__PURE__*/ uniform( 3137.0 );

// -- spectrum: setSpectrumUniforms() --

// Cascade band limits (rad/m). Defaults are bandLimitsOf(DEFAULT_CASCADES, 4, 0),
// i.e. cascade 0: no lower limit, upper limit 12*PI/397.
export const uKLow = /*@__PURE__*/ uniform( 0.0 );
export const uKHigh = /*@__PURE__*/ uniform( 0.09495997945359577 );

// U10 in m/s. See note 12: water-surface.js owns a separate node of the same
// name and the same meaning, on purpose.
export const uWindSpeed = /*@__PURE__*/ uniform( 11.0 );
export const uFetch = /*@__PURE__*/ uniform( 180.0 );        // km

// GLSL uWindDir, a float angle in RADIANS. Default 42 degrees. ALSO READ BY THE
// FOAM PASS (FOAM_FS:394), so setFoamUniforms writes it too. See note 12.
export const uWindDirRad = /*@__PURE__*/ uniform( 0.7330382858376184 );

// m. Also read by the evolve stage's dispersion relation.
export const uDepth = /*@__PURE__*/ uniform( 900.0 );

export const uSpread = /*@__PURE__*/ uniform( 1.0 );         // 1 = Donelan
export const uSpreadTail = /*@__PURE__*/ uniform( 2.2 );     // narrows the equilibrium range
export const uAlignment = /*@__PURE__*/ uniform( 0.92 );     // 0 isotropic, 1 wind aligned
export const uGamma = /*@__PURE__*/ uniform( 3.3 );          // JONSWAP peak enhancement
export const uTailSat = /*@__PURE__*/ uniform( 1.0 );        // equilibrium-range floor
export const uSwellAmount = /*@__PURE__*/ uniform( 0.55 );   // significant swell height, m
export const uSwellPeriod = /*@__PURE__*/ uniform( 13.0 );   // s
// GLSL uSwellDir, radians. Default 10 degrees.
export const uSwellDirRad = /*@__PURE__*/ uniform( 0.17453292519943295 );
export const uSwellSpread = /*@__PURE__*/ uniform( 6.0 );    // larger = tighter
export const uSwellWidth = /*@__PURE__*/ uniform( 0.06 );    // relative bandwidth
export const uAmplitude = /*@__PURE__*/ uniform( 1.0 );      // global gain
export const uShortWaveFade = /*@__PURE__*/ uniform( 0.35 ); // rolloff below Nyquist

// -- evolve: setEvolveUniforms() --

// GLSL uTime. THE SIMULATION CLOCK, not the frame clock - see note 12.
export const uWaveTime = /*@__PURE__*/ uniform( 0.0 );
// choppinessOf(4, 0, defaults) = p.choppiness * (1 + (p.choppyLong - 1) * t).
export const uChoppy = /*@__PURE__*/ uniform( 1.8125 );
export const uLoopPeriod = /*@__PURE__*/ uniform( 0.0 );     // 0 = never repeats

// -- fft: setFftUniforms() --

// GLSL `uniform int uStage`. FLOAT here because it is only ever used to build a
// uv into the butterfly table, and keeping it an int would force an int->float
// convert at the one place it is read. (There is no uVertical - note 11.)
export const uStage = /*@__PURE__*/ uniform( 0.0 );

// -- assemble: setAssembleUniforms() --

// Energy-centre wavenumber of this cascade's band. Default kCharOf(
// DEFAULT_CASCADES, 4, 256, 0).
export const uKChar = /*@__PURE__*/ uniform( 0.07121998459019682 );
// Gain on the bound second harmonic; 1 = Stokes. GLSL uStokes = p.crestSharpen.
export const uStokes = /*@__PURE__*/ uniform( 1.0 );

// -- foam: setFoamUniforms() --

// GLSL uPatch[uLayer] and uCompLod[uLayer], as scalars - see note 10.
export const uFoamPatch = /*@__PURE__*/ uniform( 3137.0 );
export const uFoamLod = /*@__PURE__*/ uniform( 0.0 );

// PER STEP, not per frame: 0.3 during spin-up, else min(dt * p.timeScale, 0.1).
export const uDt = /*@__PURE__*/ uniform( 1.0 / 60.0 );
// foamCutoffOf(whitecapFraction(p.windSpeed, p.foamCoverage, p.foamWindMin)),
// recomputed once per foam step outside the cascade loop, exactly as
// src/ocean.js:404-405. The default is that expression at the shipping defaults,
// measured rather than rounded.
export const uCutoff = /*@__PURE__*/ uniform( 2.507517889696365 );

export const uSoft = /*@__PURE__*/ uniform( 0.28 );          // p.foamSoftness
export const uDecay = /*@__PURE__*/ uniform( 0.42 );         // p.foamDecay
export const uFreshDecay = /*@__PURE__*/ uniform( 0.9 );     // p.foamFreshDecay
export const uInject = /*@__PURE__*/ uniform( 4.0 );         // p.foamInject
export const uThin = /*@__PURE__*/ uniform( 0.18 );          // p.foamThin
export const uSpreadRate = /*@__PURE__*/ uniform( 0.40 );    // p.foamSpread
export const uWeight = /*@__PURE__*/ uniform( 0.20 );        // FOAM_WEIGHTS[c]
export const uDrift = /*@__PURE__*/ uniform( 0.6 );          // p.foamDrift
export const uFaceBias = /*@__PURE__*/ uniform( 0.78 );      // p.foamFace
export const uBreakScale = /*@__PURE__*/ uniform( 3.2 );     // p.foamBreakScale
export const uCrestAniso = /*@__PURE__*/ uniform( 1.7 );     // p.foamCrestAniso
export const uRidge = /*@__PURE__*/ uniform( 0.85 );         // p.foamRidge
export const uBreakup = /*@__PURE__*/ uniform( 0.88 );       // p.foamBreakup

// =============================================================================
// SPECTRUM  (INIT_SPECTRUM_FS)
// =============================================================================

// INIT_SPECTRUM_FS:63-69. Kitaigorodskii depth attenuation (TMA).
//
//   float tmaDepth(float w){
//     float wh = w * sqrt(uDepth / G);
//     if (wh <= 1.0) return 0.5 * wh * wh;
//     if (wh <  2.0) return 1.0 - 0.5 * sqr(2.0 - wh);
//     return 1.0;
//   }
//
// The three-branch return ladder becomes a var initialised to the FINAL return
// followed by If/.ElseIf, which is exactly the same decision tree.
export const tmaDepth = /*@__PURE__*/ Fn( ( [ w ] ) => {

	const wh = w.mul( uDepth.div( G_S ).sqrt() ).toVar();

	const r = float( 1.0 ).toVar();
	If( wh.lessThanEqual( 1.0 ), () => {

		r.assign( float( 0.5 ).mul( wh ).mul( wh ) );

	} ).ElseIf( wh.lessThan( 2.0 ), () => {

		r.assign( float( 1.0 ).sub( float( 0.5 ).mul( sqr( float( 2.0 ).sub( wh ) ) ) ) );

	} );

	return r;

} );

// INIT_SPECTRUM_FS:71-95. JONSWAP frequency spectrum (m^2 s / rad),
// energy-normalised. eScale reconciles the shape with the fetch law; it
// multiplies the peak but not the saturated tail, which is set by Phillips'
// constant and not by the fetch.
//
//   float jonswap(float w, float wp, float alpha, float eScale, float satLevel){
//     float gam   = max(uGamma, 1.0);
//     float norm  = 1.0 - 0.287 * log(gam);
//     float sigma = w <= wp ? 0.07 : 0.09;
//     float r     = exp(-sqr(w - wp) / (2.0 * sqr(sigma * wp)));
//     float shape = norm * pow(gam, r) * eScale;
//     float floorLvl = satLevel * smoothstep(2.2, 3.2, w / wp);
//     float a = alpha * max(shape, floorLvl);
//     return a * G*G / pow(w, 5.0) * exp(-1.25 * pow(wp/w, 4.0));
//   }
export const jonswap = /*@__PURE__*/ Fn( ( [ w, wp, alpha, eScale, satLevel ] ) => {

	const gam = uGamma.max( 1.0 ).toVar();

	// Goda's normaliser: keeps m0 fixed as the peak is sharpened, so gamma is a
	// pure shape control and does not secretly double the wave height.
	const norm = float( 1.0 ).sub( float( 0.287 ).mul( gam.log() ) ).toVar();

	// select(cond, a, b) - argument order is what it looks like (porting rule 5).
	// Both operands are evaluated and that is safe: select PICKS a value rather
	// than multiplying by a mask, and both are finite constants.
	const sigma = select( w.lessThanEqual( wp ), float( 0.07 ), float( 0.09 ) ).toVar();

	const r = sqr( w.sub( wp ) ).negate()
		.div( float( 2.0 ).mul( sqr( sigma.mul( wp ) ) ) ).exp().toVar();

	// The short-gravity range is where every bit of the mean square slope lives,
	// and it is NOT the same population as the peak: its level is set by the wind
	// forcing it, not by the fetch that grew the swell. It therefore gets its own
	// floor. The knee is placed well above the peak (2.2-3.2 wp, i.e. five to ten
	// times the peak wavenumber) for a hard energetic reason: only three percent
	// of m0 lives above 2.5 wp, so the floor can lift that band by whatever the
	// slope statistics demand while the significant wave height stays on the fetch
	// law. Putting the knee at the peak instead - which is what "the tail is
	// saturated above wp" naively gives you - lifts the band that carries m0 and
	// silently inflates the sea by twenty percent.
	const shape = norm.mul( gam.pow( r ) ).mul( eScale ).toVar();
	const floorLvl = satLevel.mul( smoothstep( 2.2, 3.2, w.div( wp ) ) ).toVar();
	const a = alpha.mul( shape.max( floorLvl ) ).toVar();

	return a.mul( G_S ).mul( G_S ).div( w.pow( 5.0 ) )
		.mul( float( - 1.25 ).mul( wp.div( w ).pow( 4.0 ) ).exp() );

} );

// INIT_SPECTRUM_FS:98. `float sech2(float x){ float c = 2.0/(exp(x)+exp(-x)); return c*c; }`
export const sech2 = /*@__PURE__*/ Fn( ( [ x ] ) => {

	const c = float( 2.0 ).div( x.exp().add( x.negate().exp() ) ).toVar();
	return c.mul( c );

} );

// INIT_SPECTRUM_FS:97-119. Donelan-Banner directional spreading,
// 0.5*b*sech^2(b*theta), integrates to 1.
//
//   float spreading(float w, float wp, float theta){
//     float r = w / wp;
//     float b;
//     if      (r < 0.95) b = 2.61 * pow(max(r, 0.56), 1.3);
//     else if (r < 1.6)  b = 2.28 * pow(r, -1.3);
//     else {
//       float eps = -0.4 + 0.8393 * exp(-0.567 * log(r*r));
//       b = pow(10.0, eps);
//     }
//     b *= mix(1.0, max(uSpreadTail, 0.1), smoothstep(1.4, 5.0, r));
//     b = max(b * uSpread, 0.05);
//     float t = atan(sin(theta), cos(theta));   // wrap to (-pi, pi]
//     float d = 0.5 * b * sech2(b * t);
//     return mix(1.0/TAU, d, clamp(uAlignment, 0.0, 1.0));
//   }
export const spreading = /*@__PURE__*/ Fn( ( [ w, wp, theta ] ) => {

	const r = w.div( wp ).toVar();

	const b = float( 0.0 ).toVar();
	If( r.lessThan( 0.95 ), () => {

		b.assign( float( 2.61 ).mul( r.max( 0.56 ).pow( 1.3 ) ) );

	} ).ElseIf( r.lessThan( 1.6 ), () => {

		b.assign( float( 2.28 ).mul( r.pow( - 1.3 ) ) );

	} ).Else( () => {

		// The `eps` local lives inside this block in the GLSL too.
		const eps = float( - 0.4 ).add(
			float( 0.8393 ).mul( float( - 0.567 ).mul( r.mul( r ).log() ).exp() ),
		).toVar();
		b.assign( float( 10.0 ).pow( eps ) );

	} );

	// Donelan's tail measurements come from a wave staff, which sees the short
	// waves averaged over every long wave they ride. In a photograph they are not
	// that isotropic: the wind-driven chop lies in visible rows across the swell,
	// and letting b fall to ~0.4 above 1.6 wp is what makes the sea read as
	// tinfoil crinkle rather than a wind sea with a direction.
	//
	// STANDALONE mix(a, b, t). `.mix()` is banned everywhere in this project:
	// mixElement is (t, e1, e2) => mix(e1, e2, t), so the RECEIVER IS THE FACTOR
	// (porting rule 1). `.smoothstep(lo, hi)` is the other way round and is
	// correct as a method - object = value - but the standalone form is used here
	// so the line reads as the GLSL does.
	b.mulAssign( mix( float( 1.0 ), uSpreadTail.max( 0.1 ), smoothstep( 1.4, 5.0, r ) ) );
	b.assign( b.mul( uSpread ).max( 0.05 ) );

	// atan(y, x): TSL emits atan(y,x) on GLSL and atan2(y,x) on WGSL, so the
	// branch cut is the platform's and matches the GLSL's (porting rule 5).
	const t = atan( theta.sin(), theta.cos() ).toVar();
	const d = float( 0.5 ).mul( b ).mul( sech2( b.mul( t ) ) ).toVar();

	// Blend toward isotropic so the sea can be made confused / cross-swell.
	// 1.0/TAU is written as a division rather than folded in JS: the shader
	// compiler then folds 1.0 / 6.28318530717959 in f32 exactly as the GLSL's
	// compiler did, instead of this file shipping a double-rounded literal.
	return mix( float( 1.0 ).div( TAU_S ), d, clamp( uAlignment, 0.0, 1.0 ) );

} );

// INIT_SPECTRUM_FS:121-143. Narrow-band swell riding on top of the wind sea.
// Both the frequency band and the directional lobe are normalised to unit
// integral, so uSwellAmount is literally the significant height of the swell
// train in metres.
//
//   float swell(float w, float theta){
//     if (uSwellAmount <= 1e-4) return 0.0;
//     float ws = TAU / max(uSwellPeriod, 1.0);
//     float dwCell = min((TAU / uL) * G / (2.0 * max(ws, 0.05)), 0.25 * ws);
//     float sw = max(max(uSwellWidth, 0.005) * ws, 0.8 * dwCell);
//     float band = exp(-sqr(w - ws) / (2.0 * sqr(sw))) / (sw * sqrt(TAU));
//     float dt = atan(sin(theta - uSwellDir), cos(theta - uSwellDir));
//     float s  = max(uSwellSpread, 0.25);
//     float dir = exp(-s * dt * dt) * sqrt(s / PI);
//     return sqr(uSwellAmount * 0.25) * band * dir;   // m0 = (Hs/4)^2
//   }
//
// The early `return 0.0` becomes a result var and the POSITIVE COMPLEMENT of the
// guard - water-common.js's wakeAt does the same. There is no short-circuit in
// TSL and nothing here needs one.
export const swell = /*@__PURE__*/ Fn( ( [ w, theta ] ) => {

	const out = float( 0.0 ).toVar();

	If( uSwellAmount.greaterThan( 1e-4 ), () => {

		const ws = float( TAU_S ).div( uSwellPeriod.max( 1.0 ) ).toVar();

		// A 14 s swell in the 1789 m patch sits near mode 6, where one cell of the
		// wavenumber grid is ~0.04 rad/s wide - broader than the swell band itself.
		// Left alone the Gaussian falls between samples, so the train is carried by
		// one or two modes: no groups, and a variance that depends on where the peak
		// happens to land. Widening it to the cell keeps the integral (the band is
		// normalised) while giving the swell enough modes to beat against itself.
		// The cap matters: in the short cascades one cell is wider than the swell
		// frequency itself, and widening to it would spray swell energy across the
		// whole equilibrium range instead of leaving those cascades alone.
		const dwCell = float( TAU_S ).div( uL ).mul( G_S )
			.div( float( 2.0 ).mul( ws.max( 0.05 ) ) )
			.min( float( 0.25 ).mul( ws ) ).toVar();

		const sw = uSwellWidth.max( 0.005 ).mul( ws ).max( float( 0.8 ).mul( dwCell ) ).toVar();

		const band = sqr( w.sub( ws ) ).negate().div( float( 2.0 ).mul( sqr( sw ) ) ).exp()
			.div( sw.mul( float( TAU_S ).sqrt() ) ).toVar();

		const dt = atan( theta.sub( uSwellDirRad ).sin(), theta.sub( uSwellDirRad ).cos() ).toVar();
		const s = uSwellSpread.max( 0.25 ).toVar();
		const dir = s.negate().mul( dt ).mul( dt ).exp()
			.mul( s.div( PI_S ).sqrt() ).toVar();

		out.assign( sqr( uSwellAmount.mul( 0.25 ) ).mul( band ).mul( dir ) );   // m0 = (Hs/4)^2

	} );

	return out;

} );

// INIT_SPECTRUM_FS:145-230, `main`.
//
// Two early returns, both written as the positive complement of the guard around
// the rest of the body, with the result var left at its initial vec4(0.0):
//
//   if (id.x == 0 || id.y == 0){ fragColor = vec4(0.0); return; }
//   if (kk < 1e-6 || kk < uKLow || kk >= uKHigh){ fragColor = vec4(0.0); return; }
//
// `> 0.5` rather than `!= 0` on values that are floor()'d and therefore exactly
// integral: robust, and it reads the same.
//
// @param {Node} noiseTex - TextureNode over the cascade noise DataArrayTexture,
//   layer uLayer. FOUR UNIT GAUSSIANS PER TEXEL, one continuous stream across
//   all cascades. A port that reads layer 0 for every cascade gets four
//   perfectly correlated cascades (docs/ocean-sim-port-notes.md §2).
export const initSpectrumFragment = /*@__PURE__*/ Fn( ( [ noiseTex ] ) => {

	const id = texelId();
	const out = vec4( 0.0 ).toVar();

	// Column/row 0 is the unpaired Nyquist line: it has no partner at -k, so
	// leaving it populated would inject a non-real mode.
	If( id.x.greaterThan( 0.5 ).and( id.y.greaterThan( 0.5 ) ), () => {

		const nm = id.sub( uN.mul( 0.5 ) ).toVar();
		const k = nm.mul( TAU_S ).div( uL ).toVar();
		const kk = k.length().toVar();

		If( kk.greaterThanEqual( 1e-6 ).and( kk.greaterThanEqual( uKLow ) )
			.and( kk.lessThan( uKHigh ) ), () => {

			// Dispersion with capillary term and finite depth.
			const km = float( 370.0 ).toVar();                  // capillary wavenumber
			const cap = float( 1.0 ).add( sqr( kk.div( km ) ) ).toVar();
			const w = float( G_S ).mul( kk ).mul( cap )
				.mul( kk.mul( uDepth ).min( 20.0 ).tanh() ).sqrt().toVar();
			const dwdk = float( G_S ).mul( cap.add( float( 2.0 ).mul( sqr( kk.div( km ) ) ) ) )
				.mul( 0.5 ).div( w.max( 1e-4 ) ).toVar();

			const U = uWindSpeed.max( 0.05 ).toVar();
			const chi = float( G_S ).mul( uFetch.max( 0.1 ) ).mul( 1000.0 )
				.div( U.mul( U ) ).min( CHI_FULL ).toVar();
			const Fe = chi.mul( U ).mul( U ).div( G_S ).toVar();   // fetch after the clamp
			const alpha = float( 0.076 ).mul( chi.pow( - 0.22 ) ).toVar();
			const wp = float( 22.0 ).mul(
				float( G_S ).mul( G_S ).div( U.mul( Fe ) ).pow( float( 1.0 ).div( 3.0 ) ),
			).toVar();

			// Hasselmann's alpha(chi) and wp(chi) fits and the Hs(chi) fit are three
			// independent regressions through the same JONSWAP data and they do not
			// close: integrating alpha g^2 w^-5 exp(-1.25 (wp/w)^4) analytically gives
			// m0 = alpha g^2 / (5 wp^4), which at full development sits about 26% above
			// (0.0016 sqrt(chi) U^2/g / 4)^2. Left alone the sea comes out
			// systematically steeper than the wind that is supposed to have raised it.
			// Scaling the peak to close the gap is the honest fix: the wave height then
			// obeys the fetch law at every fetch, and the equilibrium tail - which is a
			// property of Phillips' constant, not of the fetch - keeps its own level via
			// the floor above.
			const m0pm = alpha.mul( G_S ).mul( G_S )
				.div( float( 5.0 ).mul( sqr( sqr( wp ) ) ) ).toVar();
			const hsFit = float( 0.0016 ).mul( chi.sqrt() ).mul( U ).mul( U ).div( G_S ).toVar();
			const eScale = sqr( hsFit.mul( 0.25 ) ).div( m0pm.max( 1e-12 ) ).toVar();

			// Cox-Munk's mean square slope grows linearly with wind speed; Phillips'
			// constant does not grow at all. Both cannot be right, and the slope
			// measurements are the ones with a sun glitter photograph behind them: the
			// short-gravity range is not truly saturated, its level rises with the wind.
			// Pinning it to a constant alpha leaves the sea roughly half as rough as any
			// slick-free measurement of the real thing, which is exactly what a rendered
			// ocean that looks like poured resin is missing. The floor is set so that a
			// Phillips-shaped range running from the spectral peak out to the 8 mm
			// capillary cutoff carries the Cox-Munk variance; each cascade then resolves
			// whatever share of that range it owns.
			const kPeak = wp.mul( wp ).div( G_S ).toVar();
			const octaves = float( 800.0 ).div( kPeak.max( 1e-4 ) ).max( 2.0 ).log().toVar();
			const satLevel = uTailSat.mul( float( 0.003 ).add( float( 5.12e-3 ).mul( U ) ) )
				.div( float( 0.5 ).mul( alpha ).mul( octaves ).max( 1e-6 ) ).toVar();

			const S = jonswap( w, wp, alpha, eScale, satLevel ).mul( tmaDepth( w ) ).toVar();
			const th = atan( k.y, k.x ).toVar();

			// Directional wavenumber spectrum: Psi(kx,kz) = S(w) D(th) (dw/dk) / k
			const psi = S.mul( spreading( w, wp, th.sub( uWindDirRad ) ) )
				.add( swell( w, th ) ).mul( dwdk ).div( kk ).toVar();
			// The same mode seen from -k: the magnitude is shared, the direction is not.
			const psiM = S.mul( spreading( w, wp, th.add( PI_S ).sub( uWindDirRad ) ) )
				.add( swell( w, th.add( PI_S ) ) ).mul( dwdk ).div( kk ).toVar();

			// Roll the band off before this cascade's own Nyquist. A mode two texels
			// per wavelength cannot be shaded: it aliases in the displacement map, in
			// the slope map and again in the grid it is sampled onto, and that is what
			// turns the sea into crumpled foil. The knee is placed a little over half of
			// Nyquist (four texels per wave) and the fourth power keeps the octave below
			// it intact instead of thinning the whole band.
			const nyq = float( PI_S ).mul( uN ).div( uL ).toVar();
			const kc = nyq.mul( float( 0.92 ).sub(
				float( 0.52 ).mul( clamp( uShortWaveFade, 0.0, 1.0 ) ),
			) ).toVar();
			const roll = sqr( sqr( kk.div( kc ) ) ).negate().exp().toVar();
			psi.mulAssign( roll ); psiM.mulAssign( roll );

			const dk = float( TAU_S ).div( uL ).toVar();
			// Each Hermitian partner carries half the variance of the mode:
			// <|h0|^2> = Psi dk^2 / 2, so that sum_k <|h~|^2> = integral Psi d2k = m0.
			const amp = uAmplitude.mul( dk ).mul( psi.max( 0.0 ).mul( 0.5 ).sqrt() ).toVar();
			const ampM = uAmplitude.mul( dk ).mul( psiM.max( 0.0 ).mul( 0.5 ).sqrt() ).toVar();

			// GLSL: `ivec2 idm = (ivec2(Ni) - id) & (Ni - 1);` - the texel holding -k.
			//
			// THE MASK IS THE IDENTITY HERE, so this is a plain subtraction in float
			// with no bit op. Proof: the enclosing guard has already excluded id.x == 0
			// and id.y == 0, and id is floor(uv*N) so id lies in [0, N-1]; hence N - id
			// lies in [1, N-1], which is already inside [0, N-1] and `& (N-1)` cannot
			// change it. The int()+bitAnd form is exercised elsewhere in this codebase
			// (noise.js:282) and would also work; the arithmetic form is preferred
			// because it stays in the float domain the uv idiom already uses.
			const idm = vec2( uN ).sub( id ).toVar();

			const g = noiseTex.sample( texelUv( id.x, id.y ) ).depth( uLayer ).level( 0 ).toVar();
			const gm = noiseTex.sample( texelUv( idm.x, idm.y ) ).depth( uLayer ).level( 0 ).toVar();

			const h0 = g.xy.mul( amp ).mul( 0.70710678 ).toVar();
			const h0m = gm.xy.mul( ampM ).mul( 0.70710678 ).toVar();   // = h0 at -k

			out.assign( vec4( h0, h0m ) );

		} );

	} );

	return out;

} );

// =============================================================================
// TIME EVOLUTION  (TIME_EVOLVE_FS)  - TWO ATTACHMENTS
// =============================================================================

// The part of TIME_EVOLVE_FS:244-247 that is needed before the kk guard. Cheap
// enough to compute in both attachment Fns; see note 6.
function evolvePrelude() {

	const id = texelId();
	const nm = id.sub( uN.mul( 0.5 ) ).toVar();
	const k = nm.mul( TAU_S ).div( uL ).toVar();
	const kk = k.length().toVar();
	return { id, k, kk };

}

// TIME_EVOLVE_FS:249-260, the shared body of both attachments. PLAIN JS NODE
// BUILDER, not an Fn - it returns three values and no packing fits, which is the
// aerialPerspective precedent (atmosphere.js:440) and water-common.js note 3.
// It appends to the current TSL stack, so it MUST be called from inside an Fn
// body, and specifically from inside the kk guard: `kn = k / kk` is 0/0 at the
// DC texel, which is precisely the texel the guard excludes.
function evolveCore( h0Tex, id, k, kk ) {

	const kn = k.div( kk ).toVar();

	const cap = float( 1.0 ).add( sqr( kk.div( 370.0 ) ) ).toVar();
	const w = float( G_S ).mul( kk ).mul( cap )
		.mul( kk.mul( uDepth ).min( 20.0 ).tanh() ).sqrt().toVar();

	// Optional quantisation to make the whole sea loop seamlessly.
	If( uLoopPeriod.greaterThan( 0.5 ), () => {

		const w0 = float( TAU_S ).div( uLoopPeriod ).toVar();
		w.assign( w.div( w0 ).add( 0.5 ).floor().mul( w0 ) );

	} );

	const h0 = h0Tex.sample( texelUv( id.x, id.y ) ).depth( uLayer ).level( 0 ).toVar();
	const e = cexp( w.mul( uWaveTime ) ).toVar();
	const h = cmul( h0.xy, e ).add( cmul( cconj( h0.zw ), cconj( e ) ) ).toVar();

	const ih = vec2( h.y.negate(), h.x ).toVar();      // i*h

	return { kn, h, ih };

}

// TIME_EVOLVE_FS attachment 0.
//   o0 = vec4(hDx + vec2(-hDz.y, hDz.x), hDy + vec2(-hYx.y, hYx.x));
// c0 = Dx + i Dz , c1 = Dy + i dDy/dx
const evolveO0 = /*@__PURE__*/ Fn( ( [ h0Tex ] ) => {

	const out = vec4( 0.0 ).toVar();
	const { id, k, kk } = evolvePrelude();

	If( kk.greaterThanEqual( 1e-6 ), () => {

		const { kn, h, ih } = evolveCore( h0Tex, id, k, kk );

		const hDy = h;
		const hDx = ih.negate().mul( kn.x ).mul( uChoppy ).toVar();
		const hDz = ih.negate().mul( kn.y ).mul( uChoppy ).toVar();
		const hYx = ih.mul( k.x ).toVar();

		out.assign( vec4(
			hDx.add( vec2( hDz.y.negate(), hDz.x ) ),
			hDy.add( vec2( hYx.y.negate(), hYx.x ) ),
		) );

	} );

	return out;

} );

// TIME_EVOLVE_FS attachment 1.
//   o1 = vec4(hYz + vec2(-hXx.y, hXx.x), hZz + vec2(-hXz.y, hXz.x));
// c2 = dDy/dz + i dDx/dx , c3 = dDz/dz + i dDx/dz
const evolveO1 = /*@__PURE__*/ Fn( ( [ h0Tex ] ) => {

	const out = vec4( 0.0 ).toVar();
	const { id, k, kk } = evolvePrelude();

	If( kk.greaterThanEqual( 1e-6 ), () => {

		const { h, ih } = evolveCore( h0Tex, id, k, kk );

		const hYz = ih.mul( k.y ).toVar();
		const hXx = h.mul( k.x.mul( k.x ).div( kk ) ).mul( uChoppy ).toVar();
		const hZz = h.mul( k.y.mul( k.y ).div( kk ) ).mul( uChoppy ).toVar();
		const hXz = h.mul( k.x.mul( k.y ).div( kk ) ).mul( uChoppy ).toVar();

		out.assign( vec4(
			hYz.add( vec2( hXx.y.negate(), hXx.x ) ),
			hZz.add( vec2( hXz.y.negate(), hXz.x ) ),
		) );

	} );

	return out;

} );

/**
 * TIME_EVOLVE_FS:271-272, both attachments.
 *
 * PLAIN JS FUNCTION returning an OutputStructNode - see note 6. Assign the
 * result straight to `material.fragmentNode`.
 *
 * @param {Node} h0Tex - TextureNode over the h0 render target's array texture.
 */
export function timeEvolveFragment( h0Tex ) {

	return outputStruct( evolveO0( h0Tex ), evolveO1( h0Tex ) );

}

// =============================================================================
// FFT  (FFT_FS)  - TWO ATTACHMENTS
// =============================================================================

// FFT_FS:286-301, one lane. The two attachments are THE SAME FUNCTION of
// different sources, so there is one body and it is instantiated twice.
//
//   ivec2 id = ivec2(gl_FragCoord.xy);
//   int axis = uVertical == 0 ? id.x : id.y;
//   vec4 bf = texelFetch(uButterfly, ivec2(uStage, axis), 0);
//   ivec2 topC, botC;
//   if (uVertical == 0){ topC = ivec2(int(bf.z), id.y); botC = ivec2(int(bf.w), id.y); }
//   else               { topC = ivec2(id.x, int(bf.z)); botC = ivec2(id.x, int(bf.w)); }
//   vec4 t = texelFetch(uSrc, ivec3(topC, uLayer), 0);
//   vec4 b = texelFetch(uSrc, ivec3(botC, uLayer), 0);
//   vec2 w = bf.xy;
//   o = vec4(t.xy + cmul(w, b.xy), t.zw + cmul(w, b.zw));
//
// `vertical` is a JS boolean resolved at material-build time (note 11), so the
// axis choice and the two gather coordinates are picked here, in JS, and no
// per-pixel select survives into the shader.
//
// The GLSL's `int(bf.z)` truncation is not reproduced because it is a no-op:
// butterflyData writes exact non-negative integers into .z/.w, so (bf.z + 0.5)/N
// is exactly the centre of texel bf.z. Upload butterflyData(N).data UNCHANGED -
// the wing sign lives in the twiddle and stage 0's .z/.w carry the bit-reversal
// permutation.
function fftLaneBody( bfTex, srcTex, vertical ) {

	const id = texelId();
	const axis = ( vertical ? id.y : id.x ).toVar();

	// The butterfly table is a plain 2D DataTexture, so no .depth().
	const bf = bfTex.sample( butterflyUv( uStage, axis ) ).level( 0 ).toVar();

	const topC = vertical ? vec2( id.x, bf.z ) : vec2( bf.z, id.y );
	const botC = vertical ? vec2( id.x, bf.w ) : vec2( bf.w, id.y );

	const t = srcTex.sample( texelUv( topC.x, topC.y ) ).depth( uLayer ).level( 0 ).toVar();
	const b = srcTex.sample( texelUv( botC.x, botC.y ) ).depth( uLayer ).level( 0 ).toVar();
	const w = bf.xy.toVar();

	return vec4( t.xy.add( cmul( w, b.xy ) ), t.zw.add( cmul( w, b.zw ) ) );

}

const fftLaneH = /*@__PURE__*/ Fn( ( [ bfTex, srcTex ] ) => fftLaneBody( bfTex, srcTex, false ) );
const fftLaneV = /*@__PURE__*/ Fn( ( [ bfTex, srcTex ] ) => fftLaneBody( bfTex, srcTex, true ) );

/**
 * FFT_FS:300-301, both attachments.
 *
 * PLAIN JS FUNCTION returning an OutputStructNode - see note 6.
 *
 * @param {Node} butterflyTex - TextureNode over the (stages x N) butterfly table.
 * @param {Node} src0Tex - TextureNode over attachment 0 of the source target.
 * @param {Node} src1Tex - TextureNode over attachment 1 of the source target.
 * @param {boolean} vertical - JS boolean, GLSL's uVertical. COMPILE-TIME.
 */
export function fftFragment( butterflyTex, src0Tex, src1Tex, vertical ) {

	const lane = vertical ? fftLaneV : fftLaneH;
	return outputStruct( lane( butterflyTex, src0Tex ), lane( butterflyTex, src1Tex ) );

}

// =============================================================================
// ASSEMBLE  (ASSEMBLE_FS)  - TWO ATTACHMENTS
// =============================================================================

// ASSEMBLE_FS:317-344, the shared body. PLAIN JS NODE BUILDER, called from
// inside both attachment Fns - see note 6.
//
//   ivec2 id = ivec2(gl_FragCoord.xy);
//   float s = ((id.x + id.y) & 1) == 0 ? 1.0 : -1.0;
//   vec4 a = texelFetch(uS0, ivec3(id, uLayer), 0) * s;
//   vec4 b = texelFetch(uS1, ivec3(id, uLayer), 0) * s;
//   float Dx = a.x, Dz = a.y, Dy = a.z, dYx = a.w;
//   float dYz = b.x, dXx = b.y, dZz = b.z, dXz = b.w;
//   float corr = clamp(uStokes * uKChar * Dy, -0.45, 0.45);
//   Dy  += corr * Dy;
//   dYx *= 1.0 + 2.0 * corr;
//   dYz *= 1.0 + 2.0 * corr;
//   float Jxx = 1.0 + dXx;
//   float Jzz = 1.0 + dZz;
//   float J   = Jxx * Jzz - dXz * dXz;
function assembleCore( s0Tex, s1Tex ) {

	const id = texelId();

	// Undo the DC-at-centre convention of the spectrum layout.
	//
	// `((id.x + id.y) & 1) == 0 ? 1.0 : -1.0` in float, exactly: id.x + id.y is an
	// integral float no larger than 2N-2 and therefore exact, TSL's .mod() is
	// GLSL's mod on both backends (on WGSL a polyfill with the x - y*floor(x/y)
	// definition - noise.js:274 documents the check), so the result is exactly 0
	// or 1 and s is exactly +1 or -1.
	const s = float( 1.0 ).sub( id.x.add( id.y ).mod( 2.0 ).mul( 2.0 ) ).toVar();

	const a = s0Tex.sample( texelUv( id.x, id.y ) ).depth( uLayer ).level( 0 ).mul( s ).toVar();
	const b = s1Tex.sample( texelUv( id.x, id.y ) ).depth( uLayer ).level( 0 ).mul( s ).toVar();

	const Dx = a.x.toVar(), Dz = a.y.toVar(), Dy = a.z.toVar(), dYx = a.w.toVar();
	const dYz = b.x.toVar(), dXx = b.y.toVar(), dZz = b.z.toVar(), dXz = b.w.toVar();

	// Bound second harmonic. A linear spectrum is symmetric about the mean plane -
	// the crest and the trough have the same curvature - and that symmetry is the
	// single loudest tell that a rendered sea is a sum of sinusoids. To second
	// order a Stokes wave carries eta2 = k(eta1^2 - <eta1^2>), which peaks the
	// crest and broadens the trough while adding almost nothing to the variance.
	// The correction is a pointwise function of the height, so its own derivative
	// is exact: d/dx (k eta^2) = 2 k eta eta_x, and the slope map stays consistent
	// with the geometry the vertex shader builds. Clamped because the expansion is
	// only valid while ka stays small and a steep cascade would otherwise fold.
	const corr = clamp( uStokes.mul( uKChar ).mul( Dy ), - 0.45, 0.45 ).toVar();

	// `Dy += corr * Dy` - corr was computed from the pre-update Dy (it is its own
	// var) and the right-hand Dy is read before the assignment lands, so this is
	// the GLSL's semantics exactly. The dYx*dYx + dYz*dYz in oSlope.w below then
	// uses the CORRECTED values, again as the GLSL does.
	Dy.addAssign( corr.mul( Dy ) );
	dYx.mulAssign( float( 1.0 ).add( float( 2.0 ).mul( corr ) ) );
	dYz.mulAssign( float( 1.0 ).add( float( 2.0 ).mul( corr ) ) );

	const Jxx = float( 1.0 ).add( dXx ).toVar();
	const Jzz = float( 1.0 ).add( dZz ).toVar();
	const J = Jxx.mul( Jzz ).sub( dXz.mul( dXz ) ).toVar();

	return { Dx, Dy, Dz, dYx, dYz, J };

}

// ASSEMBLE_FS:346. `oDisp = vec4(Dx, Dy, Dz, J);` - xyz displacement, w Jacobian.
const assembleDisp = /*@__PURE__*/ Fn( ( [ s0Tex, s1Tex ] ) => {

	const { Dx, Dy, Dz, J } = assembleCore( s0Tex, s1Tex );
	return vec4( Dx, Dy, Dz, J );

} );

// ASSEMBLE_FS:351. `oSlope = vec4(dYx, dYz, J, dYx*dYx + dYz*dYz);`
//
// The fourth channel carries the second moment of the slope. Mip filtering it
// gives <|grad h|^2> over a footprint, which the surface shader turns into
// filtered microfacet roughness instead of aliasing sparkle, and whose top mip
// is the cascade's contribution to the total mean square slope.
const assembleSlope = /*@__PURE__*/ Fn( ( [ s0Tex, s1Tex ] ) => {

	const { dYx, dYz, J } = assembleCore( s0Tex, s1Tex );
	return vec4( dYx, dYz, J, dYx.mul( dYx ).add( dYz.mul( dYz ) ) );

} );

/**
 * ASSEMBLE_FS:346-351, both attachments.
 *
 * PLAIN JS FUNCTION returning an OutputStructNode - see note 6, including why J
 * is computed twice and what that costs.
 *
 * @param {Node} s0Tex - TextureNode over attachment 0 of the ping target.
 * @param {Node} s1Tex - TextureNode over attachment 1 of the ping target.
 */
export function assembleFragment( s0Tex, s1Tex ) {

	return outputStruct( assembleDisp( s0Tex, s1Tex ), assembleSlope( s0Tex, s1Tex ) );

}

// =============================================================================
// FOAM  (FOAM_FS)
// =============================================================================

// FOAM_FS:368-384.
//
//   float foldAt(vec2 wpos){
//     return textureLod(uDisp, vec3(wpos / uPatch[uLayer], float(uLayer)),
//                       max(uCompLod[uLayer] - 1.0, 0.0)).w - 1.0;
//   }
//
// (J - 1) for THIS cascade at one world point, at the mip whose footprint is a
// breaker: a single folding texel is a wrinkle, not whitewater, and thresholding
// one texel at a time produces confetti that never aggregates.
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
const foldAt = /*@__PURE__*/ Fn( ( [ dispTex, wpos ] ) => dispTex
	.sample( wpos.div( uFoamPatch ) )
	.depth( uLayer )
	.level( uFoamLod.sub( 1.0 ).max( 0.0 ) )
	.w.sub( 1.0 ) );

// FOAM_FS:388. Offsets of the breaking kernel along the crest line, in units of
// the breaker scale times the crest anisotropy.
//
//   const float CT[5] = float[5](-1.0, -0.5, 0.0, 0.5, 1.0);
//
// UNROLLED IN JS (porting rule 6: small fixed loops are unrolled when the index
// only picks compile-time constants). KEEP THE MULTIPLICATION ORDER
// `CT[t] * bs * uCrestAniso` - it is float arithmetic and reassociating it moves
// the last bit.
const CT = [ - 1.0, - 0.5, 0.0, 0.5, 1.0 ];

/**
 * FOAM_FS:390-518, `main`.
 *
 * @param {Node} prevFoamTex - TextureNode over the foam buffer written LAST step
 *   (the pass writes the other one). LINEAR + REPEAT + MIPPED is load-bearing
 *   here, unlike on the FFT pair: this pass samples it at uv - duv, at four
 *   diffusion taps that are not texel centres and do leave [0,1], and at the
 *   1x1 top mip.
 * @param {Node} dispTex - TextureNode over the assemble target's attachment 0.
 * @param {Node} slopeTex - TextureNode over the assemble target's attachment 1.
 */
export const foamFragment = /*@__PURE__*/ Fn( ( [ prevFoamTex, dispTex, slopeTex ] ) => {

	const id = texelId();
	const uvI = texelUv( id.x, id.y ).toVar();
	const world = uvI.mul( uL ).toVar();
	const wd = vec2( uWindDirRad.cos(), uWindDirRad.sin() ).toVar();
	const wn = vec2( wd.y.negate(), wd.x ).toVar();
	const bs = uBreakScale.max( 0.2 ).toVar();

	// A breaker is a LINE event, not a disc: the tumbling region runs tens of
	// metres along the crest and only a fraction of a wavelength across it. An
	// isotropic low-pass of the fold field therefore answers the wrong question,
	// and thresholding its broad round maxima is exactly why the whitecaps came
	// out as identical circular rafts with no crest alignment. Averaging along the
	// crest and testing across it turns the same statistics into crest-aligned
	// strips. The offsets are taken perpendicular to the wind because that is the
	// direction the dominant crests run.
	const comp = float( 0.0 ).toVar();
	for ( const t of CT ) {

		comp.addAssign( foldAt( dispTex, world.add(
			wn.mul( float( t ).mul( bs ).mul( uCrestAniso ) ),
		) ) );

	}

	comp.mulAssign( 0.2 );
	const x = comp.negate().toVar();                 // positive where the surface folds

	// Ridge test across the crest. Water only tumbles where the fold is at its
	// maximum in the direction the wave is travelling; a metre either side of that
	// the same surface is merely steep. Without it the strip above is as wide as
	// the kernel and the raft still reads as a slab.
	const xf = foldAt( dispTex, world.add( wd.mul( bs ) ) ).negate().toVar();
	const xb = foldAt( dispTex, world.sub( wd.mul( bs ) ) ).negate().toVar();
	const crestOff = x.sub( xf.max( xb ) ).toVar();

	// Own cascade only, for the same periodicity reason as foldAt.
	const grad = slopeTex.sample( world.div( uFoamPatch ) ).depth( uLayer )
		.level( uFoamLod.sub( 1.0 ).max( 0.0 ) ).xy.toVar();

	// Scale-free threshold. The previous frame wrote x*x into channel w, so the
	// top mip of the foam texture is <x^2> over the whole patch and the cutoff can
	// be expressed in units of the sea's own RMS compression. An absolute Jacobian
	// threshold cannot work: a steeper sea trivially exceeds it everywhere, which
	// is how force 10 became a hundred percent white-out. Each cascade now folds on
	// its own account, so each normalises by its own variance: the top mip of this
	// layer's w channel is <x^2> over this tile.
	//
	// The GLSL's literal 32.0 is uTopLod here - note 5.
	const cvar = prevFoamTex.sample( uvI ).depth( uLayer ).level( uTopLod ).w.toVar();
	// At cvar = 0 the untaken branch is +Inf, and select DISCARDS it rather than
	// multiplying by a mask, so nothing propagates. (water-surface.js:480 makes
	// the same argument for capFade.)
	const inv = select( cvar.greaterThan( 1e-9 ), inverseSqrt( cvar ), float( 0.0 ) ).toVar();
	const xn = x.mul( inv ).toVar();

	// In the same sigma units, so the ridge gate keeps its meaning as the sea state
	// changes.
	const ridge = mix( float( 1.0 ),
		smoothstep( - 0.25, 0.30, crestOff.mul( inv ) ),
		clamp( uRidge, 0.0, 1.0 ) ).toVar();

	// Spilling breakers live on the forward face, where the surface falls away
	// along the direction of travel. The compression on the back of a wave is the
	// horizontal displacement piling water up against the next crest and it makes
	// no foam, so without this half the whitecaps sit in the wrong place.
	const face = dot( grad, wd ).negate()
		.mul( inverseSqrt( dot( grad, grad ).add( 1e-8 ) ) ).toVar();
	const gate = mix( float( 1.0 ),
		smoothstep( - 0.4, 0.5, face ),
		clamp( uFaceBias, 0.0, 1.0 ) ).toVar();

	// What actually trips a crest into breaking is the metre-scale roughness riding
	// on it, so the threshold is modulated by the wind-projected slope, normalised
	// by its own RMS (the top mip of the slope map is <|grad h|^2>, which is
	// exactly that). This is what gives a raft internal structure and a ragged edge
	// instead of the smooth convex outline a thresholded low-pass always has - and
	// unlike a procedural noise it is periodic in each cascade's own tile, so it
	// cannot introduce a seam. Taken from this cascade's own slope at a finer mip
	// than the breaking kernel: the roughness that trips a crest is the detail
	// riding on it. Reading the shorter cascades here would reintroduce the lattice.
	const uvr = world.div( uFoamPatch ).toVar();
	const rms = slopeTex.sample( uvr ).depth( uLayer ).level( uTopLod ).w
		.max( 1e-9 ).sqrt().toVar();
	const rough = dot(
		slopeTex.sample( uvr ).depth( uLayer )
			.level( uFoamLod.sub( 2.5 ).max( 0.0 ) ).xy,
		wd,
	).div( rms ).toVar();
	const cut = uCutoff.sub( uBreakup.mul( rough ) ).toVar();

	const fold = smoothstep( cut.sub( uSoft ), cut.add( uSoft ), xn )
		.mul( gate ).mul( ridge ).toVar();
	const birth = clamp( uInject.mul( fold ), 0.0, 1.0 ).toVar();

	// Foam lives in undisplaced (Lagrangian) coordinates, so it already rides the
	// water particle it was born on. What still has to be advected is the surface
	// drift - Stokes plus wind shear - and that is what draws foam into windrows.
	const duv = wd.mul( uDrift.mul( uDt ).div( uL ) ).toVar();

	// Diffusion lengths are metres of sea, not texels. Expressed in texels the same
	// code smeared a raft over eight metres in the 397 m cascade and over thirty
	// centimetres in the 17 m one, so each cascade grew a differently shaped foam
	// and the sum was a soft halo around a hard core.
	const alongUV = float( 0.45 ).mul( bs ).div( uL ).toVar();
	const acrossUV = float( 0.28 ).mul( bs ).div( uL ).toVar();

	const prev = prevFoamTex.sample( uvI.sub( duv ) ).depth( uLayer ).level( 0.0 ).toVar();

	// Mild along-wind bias (~1.6:1), not the old 5.6:1 smear. That ratio turned
	// every breaker into a filament; real foam keeps clumps and holes while it
	// drifts.
	const blur = prevFoamTex.sample( uvI.sub( duv ).add( wd.mul( alongUV ) ) )
		.depth( uLayer ).level( 0.0 )
		.add( prevFoamTex.sample( uvI.sub( duv ).sub( wd.mul( alongUV ) ) )
			.depth( uLayer ).level( 0.0 ) )
		.add( prevFoamTex.sample( uvI.sub( duv ).add( wn.mul( acrossUV ) ) )
			.depth( uLayer ).level( 0.0 ) )
		.add( prevFoamTex.sample( uvI.sub( duv ).sub( wn.mul( acrossUV ) ) )
			.depth( uLayer ).level( 0.0 ) )
		.mul( 0.25 ).toVar();

	// Frame-rate independent: a linear rate*dt blend has to be clamped, and the
	// clamp is a cliff - at the top of the old 0..8 range one frame replaced the
	// foam field wholesale with its own blur, so whitecaps stopped being streaks
	// and became a smooth grey crust. 1 - exp(-rate*dt) approaches total diffusion
	// asymptotically instead, and at the default 0.4 it differs from the old form
	// by 0.4%, so the sea it was tuned against is unchanged.
	//
	// STANDALONE mix - porting rule 1.
	prev.assign( mix( prev, blur,
		float( 1.0 ).sub( uSpreadRate.max( 0.0 ).negate().mul( uDt ).exp() ) ) );

	// The buffer is stored pre-multiplied by this cascade's share of the foam
	// budget, but the physics below is a fraction of the texel's own area and has
	// to saturate at one. Left in the weighted frame the raft saturated at one per
	// cascade instead of one in total, and four cascades summing to two is how
	// twenty percent whitecap coverage became a white-out.
	const iw = float( 1.0 ).div( uWeight.max( 1e-3 ) ).toVar();
	const pFresh = prev.y.mul( iw ).toVar();
	const pRes = prev.z.mul( iw ).toVar();

	// Two-stage life. Stage one is the dense, bright crest foam that appears the
	// instant the crest folds and is gone within a couple of seconds.
	const fresh = pFresh.mul( uFreshDecay.negate().mul( uDt ).exp() )
		.max( birth ).min( 1.0 ).toVar();

	// Stage two is the thin dissipated raft it decays into, which lingers, spreads
	// and streaks long after the wave that made it has passed. In steady state it
	// covers freshDecay/decay times the area of the crest foam feeding it, which is
	// why the raft and not the breaker sets the coverage a photograph shows.
	// Exponential decay alone never reaches zero, so the raft leaves a film of a
	// few percent over most of the sea. That film is invisible in a photograph but
	// it is not invisible to a shader that multiplies it by a foam radiance, and it
	// is what turns a two percent whitecap coverage into a white sheet. Bubbles
	// burst at a rate per unit area, not per unit foam, so the sink is linear and
	// the raft clears in finite time.
	const residue = pRes.mul( uDecay.negate().mul( uDt ).exp() )
		.add( fresh.mul( uFreshDecay ).mul( uDt ) ).toVar();
	residue.assign( clamp( residue.sub( uThin.mul( uDt ) ), 0.0, 1.0 ) );

	// These are area fractions of the same texel, so they composite. Taking the max
	// threw the raft away wherever a crest was breaking, which pinned the
	// fresh/aged ratio the shading pass reads at exactly one.
	const total = clamp( fresh.add( residue.mul( float( 1.0 ).sub( fresh ) ) ), 0.0, 1.0 ).toVar();

	return vec4( vec3( total, fresh, residue ).mul( uWeight ), x.mul( x ) );

} );

// =============================================================================
// PUBLISH  (no GLSL counterpart - note 9)
// =============================================================================

/**
 * Copy layer uLayer of an array texture, texel for texel, into the layer of the
 * target currently bound.
 *
 * Texel-exact: texelId()/texelUv() snap the source uv to the texel centre, and
 * (i + 0.5)/N times N is exactly i + 0.5 for power-of-two N, so a bilinear fetch
 * has weights exactly (1, 0) - including on WebGL, where the sampler reads 1 - v
 * and lands on row N-1-i, also exact.
 *
 * Used twice: to give the water a STABLE foam texture identity (note 9), and by
 * the driver's readLayer() to get an array layer onto a plain 2D target that
 * readRenderTargetPixelsAsync can actually read.
 *
 * @param {Node} srcTex - TextureNode over any RGBA array texture.
 */
export const foamPublishFragment = /*@__PURE__*/ Fn( ( [ srcTex ] ) => {

	const id = texelId();
	return srcTex.sample( texelUv( id.x, id.y ) ).depth( uLayer ).level( 0 );

} );

// =============================================================================
// UNIFORM SETTERS
// =============================================================================
//
// One setter per concern, as every other module in this directory does, and each
// is the mirror of one setUniforms() call in src/ocean.js. The driver calls all
// of them. Rule 13 does not bite here in the usual direction - this module reads
// no uniform another module owns and writes none - but it does impose an order on
// the caller: TslOceanSim.update() must run BEFORE the water is drawn.

/**
 * The grid description. Once per allocation.
 *
 * @param {object} o
 * @param {number} o.N - field resolution.
 * @param {number} o.stages - butterflyData(N).stages = round(log2(N)).
 * @param {number} o.topLod - floor(log2(N)), the last level of the mip chain.
 */
export function setSimGrid( { N, stages, topLod } ) {

	uN.value = N;
	uStages.value = stages;
	uTopLod.value = topLod;

}

/**
 * Mirror of the setUniforms() call in Ocean.buildSpectrum (src/ocean.js:306-317).
 *
 * @param {object} p - the parameter set (src/presets.js `defaults`).
 * @param {object} o - { L, kLow, kHigh, layer } for the cascade being drawn.
 */
export function setSpectrumUniforms( p, { L, kLow, kHigh, layer } ) {

	// derive() writes p.windDir and p.swellDir from p.windDirDeg / p.swellDirDeg
	// (src/derive.js:36-37) and is the ONLY place either is produced. The GL path
	// silently uploads NaN when it has not run, which comes back as a black
	// spectrum with nothing anywhere saying why.
	if ( p.windDir === undefined || p.swellDir === undefined ) {

		throw new Error(
			'setSpectrumUniforms: p.windDir / p.swellDir are undefined - call ' +
			'derive(p, d) from src/derive.js before building the spectrum.',
		);

	}

	uL.value = L;
	uKLow.value = kLow;
	uKHigh.value = kHigh;
	uLayer.value = layer;

	uWindSpeed.value = p.windSpeed;
	uFetch.value = p.fetch;
	uWindDirRad.value = p.windDir;
	uDepth.value = p.depth;
	uSpread.value = p.spread;
	uSpreadTail.value = p.spreadTail;
	uAlignment.value = p.alignment;
	uGamma.value = p.peakEnhancement;
	uTailSat.value = p.tailSaturation;
	uSwellAmount.value = p.swellAmount;
	uSwellPeriod.value = p.swellPeriod;
	uSwellDirRad.value = p.swellDir;
	uSwellSpread.value = p.swellSpread;
	uSwellWidth.value = p.swellWidth;
	uAmplitude.value = p.amplitude;
	uShortWaveFade.value = p.shortWaveFade;

}

/**
 * Mirror of the setUniforms() call in Ocean.update's evolve step (src/ocean.js:337-341).
 *
 * @param {object} p
 * @param {object} o - { L, time, choppy, layer }. `time` is Ocean.time, the
 *   SIMULATION clock - not the frame clock (note 12).
 */
export function setEvolveUniforms( p, { L, time, choppy, layer } ) {

	uL.value = L;
	uWaveTime.value = time;
	uDepth.value = p.depth;
	uChoppy.value = choppy;
	uLoopPeriod.value = p.loopPeriod;
	uLayer.value = layer;

}

/**
 * Mirror of the setUniforms() call in Ocean.update's FFT loop (src/ocean.js:351-355),
 * minus uVertical, which is compile-time here (note 11).
 *
 * @param {object} o - { stage, layer }.
 */
export function setFftUniforms( { stage, layer } ) {

	uStage.value = stage;
	uLayer.value = layer;

}

/**
 * Mirror of the setUniforms() call in Ocean.update's assemble step
 * (src/ocean.js:366-370), minus uChoppy, which the GLSL declares and never reads
 * (note 8).
 *
 * @param {object} p
 * @param {object} o - { kChar, layer }.
 */
export function setAssembleUniforms( p, { kChar, layer } ) {

	uKChar.value = kChar;
	uStokes.value = p.crestSharpen;
	uLayer.value = layer;

}

/**
 * Mirror of the setUniforms() call in Ocean._foamStep (src/ocean.js:408-418),
 * minus uCascadeCount, which the GLSL declares and never reads (note 8).
 *
 * @param {object} p
 * @param {object} o - { L, patch, compLod, weight, layer, dt, cutoff }. `dt` is
 *   PER STEP (0.3 during spin-up), and `cutoff` is computed once per step outside
 *   the cascade loop.
 */
export function setFoamUniforms( p, { L, patch, compLod, weight, layer, dt, cutoff } ) {

	uL.value = L;
	uFoamPatch.value = patch;
	uFoamLod.value = compLod;
	uWeight.value = weight;
	uLayer.value = layer;
	uDt.value = dt;
	uCutoff.value = cutoff;

	uSoft.value = p.foamSoftness;
	uFaceBias.value = p.foamFace;
	uDecay.value = p.foamDecay;
	uFreshDecay.value = p.foamFreshDecay;
	uInject.value = p.foamInject;
	uSpreadRate.value = p.foamSpread;
	uThin.value = p.foamThin;
	uDrift.value = p.foamDrift;
	uBreakScale.value = p.foamBreakScale;
	uCrestAniso.value = p.foamCrestAniso;
	uRidge.value = p.foamRidge;
	uBreakup.value = p.foamBreakup;
	uWindDirRad.value = p.windDir;

}

/**
 * The publish (and readout) pass reads exactly one uniform.
 *
 * @param {object} o - { layer }.
 */
export function setPublishUniforms( { layer } ) {

	uLayer.value = layer;

}
