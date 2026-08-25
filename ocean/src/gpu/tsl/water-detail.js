// The five procedural detail fields of the water pass, in TSL — the layer that
// sits between the cascade textures and the BRDF and puts back everything the
// mip chain averaged away.
//
// Ported from WATER_FS lines 241-339 (src/shaders/water.js):
//
//   windPerp        water.js:241        the cross-wind unit vector
//   scintillation   water.js:252-275    sub-cascade facet glitter
//   sunVisibility   water.js:282-302    swell-scale sun occlusion, a 3-tap march
//   capillarySlope  water.js:307-320    parasitic capillary ripple slope
//   foamField       water.js foamField  foam: drained Worley lace + grain
//
// One source, both backends: Three compiles these node graphs to WGSL on WebGPU
// and to GLSL on WebGL2. No wgslFn, no glslFn — a raw-source node compiles for
// exactly one backend and would put the fallback back where it started
// (docs/webgpu-port.md).
//
// The physics is unchanged except foamField, which is a Jacobian-gated
// brightness field (thickened F2−F1 lace + grain) inside a coverage film,
// not occupancy discs, not a 1-pixel wireframe, not cloudy fbm patches, not
// the old sand relief, and not an unstretched hex tray.
// Every other constant, sign, clamp and magic number below is the one that
// shipped, and the GLSL comment explaining *why* each is what it is is carried
// across with it. Several of these numbers look arbitrary and are not —
// 0.3844 and 0.1444 are 0.62^2 and 0.38^2, the second moments the log-normal
// mean correction needs — so the comments are load-bearing documentation, not
// decoration.
//
// Consumers: ./water-surface.js calls all four of the non-trivial ones from
// main(), and imports uGlitter from here for the gate around the scintillation
// call. Nothing else imports this file. It sits on ./water-common.js,
// ./noise.js, ./sky-lut.js and ./cloud-field.js and imports nothing from
// ./water-brdf.js or ./water-surface.js, so there are no cycles.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE DOES *NOT* OWN
//
// uCapillary, uCapillaryScale, uWindSpeed, uFoamSharp, uFoamCrisp, uFoamAmount
// and uFoamFar all look like they belong here and do not. They shape the CALL
// SITES (WATER_FS:378-390 and 467-528), not these function bodies: capillarySlope
// receives the whole capillary strength pre-multiplied as its `amp` argument, and
// foamField receives p, t, foot and detail (foamDetail, passed in to avoid a
// cycle). They live in ./water-surface.js,
// where main() is. The five below are the only uniforms these five bodies read
// (plus uWindDir, uPatch, uHeightScale and uTime/uSunDir, all imported).
//
// ---------------------------------------------------------------------------
// NINE THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. `.mix()` IS BANNED. `mixElement = (t, e1, e2) => mix(e1, e2, t)`, so the
//    RECEIVER IS THE BLEND FACTOR and `a.mix(b, t)` computes mix(b, t, a). It
//    compiles, it runs, and it blends by the wrong variable. There is exactly
//    one far-field blend in foamField — collapsing the streaks onto 0.5 — and it
//    uses the standalone mix(a, b, t), whose argument order is GLSL's.
//    Porting rule 1; it is the defect that cost the sky port the most time.
//
// 2. THE mat2 IN scintillation IS WRITTEN OUT BY HAND, and must stay that way.
//    The GLSL is
//
//      mat2 rot = mat2(0.8253, 0.5647, -0.5647, 0.8253);
//      ... vnoise(vec3((rot*p)*f2 + 31.7, uTime*2.9)) ...
//
//    and GLSL's mat2 constructor is COLUMN-major, so the columns are
//    (0.8253, 0.5647) and (-0.5647, 0.8253) and
//
//      rot*p = ( 0.8253*p.x - 0.5647*p.y,  0.5647*p.x + 0.8253*p.y )
//
//    which is what is written below as an explicit vec2. WGSL's mat2x2 is
//    column-major too, so TSL's mat2() would *probably* agree — but "probably"
//    on a matrix-vector convention is exactly the class of silent error this
//    port keeps paying for, the transposed form is a plausible-looking image
//    rather than a crash, and the explicit expression is the same arithmetic
//    with nothing left to assume.
//
// 3. THREE EARLY RETURNS BECOME RESULT VARS, and all three return 1.0.
//    scintillation's `if (w1 + w2 < 1e-3) return 1.0;` and sunVisibility's two
//    guards are the whole-function early-outs; TSL's If cannot return a value
//    into an outer scope, so each function initialises its result to float(1.0)
//    and puts the rest of the body inside an If on the complement of the guard.
//    1.0 is the identity for both — scintillation multiplies the specular lobe,
//    sunVisibility multiplies the sun's irradiance — so the guard is a cost
//    guard as much as a value guard, and the untouched initial value IS the
//    early return.
//
//    sunVisibility's second guard is `sl < 1e-3 || uSunDir.y > 0.55`, whose
//    complement is `sl >= 1e-3 && uSunDir.y <= 0.55`, written with .and() the
//    way sky-background.js's cirrusLayer writes its `||` chains. TSL has no
//    short-circuiting operator, but neither test can produce a NaN — sl is a
//    length of a finite vector — so there is nothing for a short-circuit to
//    protect.
//
// 4. sunVisibility's MARCH IS UNROLLED IN JS. The GLSL is
//    `for (int i=1;i<=3;i++){ float t = float(i*i)*3.5*max(uShadowScale,0.05); ... }`
//    and i*i is 1, 4, 9 — compile-time constants, and the loop body indexes
//    uPatch[0] and uPatch[1] with literals anyway. So three inlined blocks with
//    float(1.0), float(4.0), float(9.0), which is what the GLSL compiler would
//    have produced from that loop after unrolling it. Porting rule 6's "small
//    fixed loops are unrolled in JS when the index only picks compile-time
//    constants"; the same call sky-background.js made for its star lattice.
//
// 5. foamField's `out float thick` IS THE PACKED .y OF A vec2 RETURN. Out
//    parameters do not exist in TSL. .x is the 0..1 streak field, .y is optical
//    thickness (streak cores high, mid-edge low). Same translation
//    sky-background.js's cirrusLayer used for its `out float dist`. There is
//    no early-return path, so BOTH components are always meaningful. The
//    caller must not overwrite .y with the old 25 cm / 6 cm vnoise — that
//    field is what read as sand. Splash churn may flatten it; wind foam keeps
//    it. Grain writes .y only — never coverage.
//
// 6. THE TWO HEIGHT TAPS IN sunVisibility ARE .level(0), AND THAT IS BOTH WHAT
//    THE GLSL SAYS AND WHAT KEEPS THEM LEGAL. The GLSL already spells them
//    textureLod(..., 0.0). They also sit inside the result-var If, whose
//    condition depends on `sl` and therefore on the fragment, so the control
//    flow is NOT uniform and an implicit fetch would be rejected by WGSL's
//    uniformity analysis. Explicit LOD is required and exact.
//
//    They read LAYER 0 AND LAYER 1 of the displacement array. Only the two
//    longest cascades are marched: everything shorter shadows at a scale below
//    one pixel and is already accounted for by the Smith masking term
//    (water.js:276-281).
//
// 7. uHeightScale IS IMPORTED FROM ./water-common.js, not redeclared. The march
//    reads the same height field the vertex stage displaced by — that shared
//    reading is the entire reason that uniform lives in water-common rather than
//    in the vertex module. Porting rule 7.
//
// 8. uWindDir IS NOT cloud-field.js's uWindDirV. water's is a UNIT DIRECTION
//    vec2 (cos(windDir), sin(windDir)); cloud-field's is a wind VELOCITY vec3 in
//    m/s. At the default windSpeed of 11 they differ by a factor of 11. Both
//    capillarySlope and foamField use it as an ORTHONORMAL FRAME —
//    `vec2(dot(p,w), dot(p,q))` — so a velocity there would rescale the whole
//    capillary and foam field by the wind speed: a silent, preset-dependent
//    wrong image, not a crash. See note 1 in ./water-common.js. Never import
//    uWindDirV into a water module.
//
// 9. foamField TAKES A FOURTH ARGUMENT `detail` (foamDetail). The GLSL reads
//    uFoamDetail from the shared block; TSL cannot import that uniform from
//    ./water-surface.js (cycle), so the caller passes it. The field is
//    layouted cellular3 (rule 18) plus vnoise. Occupancy fills, thin
//    wires, fbm clouds, and an unstretched hex tray are the looks
//    already rejected. Wake is leftover lace (coverage × the web).

import {
	Fn, If, float, int, vec2, vec3, mix, clamp, smoothstep, uniform,
} from 'three/tsl';

import { vnoise, fbm3, cellular3 } from './noise.js';
import { uTime } from './cloud-field.js';
import { uSunDir } from './sky-lut.js';
import { uWindDir, uPatch, uHeightScale, dispTexture } from './water-common.js';

// ---- uniforms ---------------------------------------------------------------
// Only the five that WATER_FS:241-339 reads inside these bodies and no other
// module reads at all. Defaults are src/presets.js's.

// presets.js glitter. Read inside scintillation AND at the call site in
// ./water-surface.js (the `if (uGlitter > 0.0)` gate at water.js:645 and 675),
// which imports it from here rather than declaring a second one.
export const uGlitter = /*@__PURE__*/ uniform( 0.55 );
export const uGlitterScale = /*@__PURE__*/ uniform( 1.0 );    // presets.js glitterScale

export const uWaveShadow = /*@__PURE__*/ uniform( 0.85 );     // presets.js waveShadow
export const uShadowScale = /*@__PURE__*/ uniform( 1.2 );     // presets.js shadowScale

export const uFoamStreak = /*@__PURE__*/ uniform( 0.16 );     // presets.js foamStreak
export const uFoamDrift = /*@__PURE__*/ uniform( 0.6 );      // presets.js foamDrift — lace slide
export const uFoamFill = /*@__PURE__*/ uniform( 0.55 );      // presets.js foamFill — cell web / veil
export const uFoamCell = /*@__PURE__*/ uniform( 1.0 );       // presets.js foamCell — honeycomb size (1 = authored)

// ---- the wind frame ---------------------------------------------------------

// vec2 windPerp(){ return vec2(-uWindDirV.y, uWindDirV.x); }
//
// The cross-wind unit vector, i.e. the wind direction rotated a quarter turn.
// Takes no arguments — call it as windPerp(). It is used only inside
// capillarySlope and foamField, to build the orthonormal (along-wind,
// cross-wind) frame both of them work in; main() never calls it.
//
// uWindDir is a UNIT vector, so this one is too, and both call sites depend on
// that. See note 8 at the top.
export const windPerp = /*@__PURE__*/ Fn( () => {

	return vec2( uWindDir.y.negate(), uWindDir.x );

} );

// ---- scintillation ----------------------------------------------------------

// Sub-cascade facet scintillation. The mip chain averages the finest ripples
// into the slope variance, which correctly widens the GGX lobe but erases that a
// real glitter path is thousands of discrete flashes with dark water between
// them. This puts that structure back as a modulation of the *facet density*
// with an analytically unit mean, so the lobe's radiance is redistributed and
// never created - the peaks then clamp against a true mirror, not against an
// arbitrary number. Each octave dies as its wavelength falls under the pixel
// footprint, which is why the glints shrink with distance instead of turning
// into fixed-size aliasing confetti.
//
//   float scintillation(vec2 p, float foot){
//     float gs = 1.0 / max(uGlitterScale, 0.05);
//     float f1 = 1.7*gs, f2 = 6.1*gs;
//     float w1 = 1.0 - smoothstep(0.25, 0.95, foot*f1);
//     float w2 = 1.0 - smoothstep(0.25, 0.95, foot*f2);
//     if (w1 + w2 < 1e-3) return 1.0;
//     // Value noise sampled on one axis-aligned lattice prints its own grid as
//     // diagonal rows once it multiplies a directional lobe, so the second octave
//     // rides a rotated frame.
//     mat2 rot = mat2(0.8253, 0.5647, -0.5647, 0.8253);
//     float n1 = vnoise(vec3(p*f1, uTime*1.3)) - 0.5;
//     float n2 = vnoise(vec3((rot*p)*f2 + 31.7, uTime*2.9)) - 0.5;
//     float n  = n1*0.62*w1 + n2*0.38*w2;
//     // Facet density is a positive quantity, so it modulates log-normally rather
//     // than as a squared linear ramp. The old (1+g n)^2 with g near 2.7 swung the
//     // lobe over a 40:1 range - most of the sea landed either at zero or hard
//     // against the ceiling, which is binary speckle, not glitter. exp() cannot go
//     // negative, is bounded because the noise is bounded, and its mean is corrected
//     // exactly by the second moment, so the lobe's radiance is redistributed and
//     // never created.
//     float g  = 1.6 * clamp(uGlitter, 0.0, 3.0);
//     float wv = 0.06 * (0.3844*w1*w1 + 0.1444*w2*w2);
//     return exp(g*n - 0.5*g*g*wv);
//   }
//
// p is the WORLD xz of the DISPLACED point (vWorld.xz at the call site, not
// vFlat.xz): the flashes have to live on the water and be carried by it, or the
// whole pattern slides across the waves it is supposed to belong to.
//
// 0.3844 = 0.62^2 and 0.1444 = 0.38^2 — the two octave weights squared. wv is
// the variance of n, and `- 0.5*g*g*wv` is exactly the log-normal mean
// correction that makes E[exp(g*n)] = 1. Change one of the four digits and the
// modulation stops being mean-preserving, which shows up as the glitter path
// getting brighter or dimmer overall rather than as anything that looks wrong.
export const scintillation = /*@__PURE__*/ Fn( ( [ p, foot ] ) => {

	// Pinned: an Fn without a layout is inlined at its call site, so a node read
	// more than once is recomputed unless it is a var (atmosphere.js note 2).
	const pV = p.toVar();
	const footV = foot.toVar();

	const gs = float( 1.0 ).div( uGlitterScale.max( 0.05 ) ).toVar();
	const f1 = float( 1.7 ).mul( gs ).toVar();
	const f2 = float( 6.1 ).mul( gs ).toVar();
	const w1 = float( 1.0 ).sub( smoothstep( 0.25, 0.95, footV.mul( f1 ) ) ).toVar();
	const w2 = float( 1.0 ).sub( smoothstep( 0.25, 0.95, footV.mul( f2 ) ) ).toVar();

	// GLSL: `if (w1 + w2 < 1e-3) return 1.0;` — see note 3. 1.0 is the identity
	// for this term, which multiplies the specular lobe.
	const res = float( 1.0 ).toVar();

	If( w1.add( w2 ).greaterThanEqual( 1e-3 ), () => {

		// Value noise sampled on one axis-aligned lattice prints its own grid as
		// diagonal rows once it multiplies a directional lobe, so the second octave
		// rides a rotated frame.
		//
		// mat2(0.8253, 0.5647, -0.5647, 0.8253) written out COLUMN-major, so
		// rot*p = (0.8253*p.x - 0.5647*p.y, 0.5647*p.x + 0.8253*p.y). See note 2 —
		// this is deliberately not TSL's mat2().
		const rp = vec2(
			pV.x.mul( 0.8253 ).sub( pV.y.mul( 0.5647 ) ),
			pV.x.mul( 0.5647 ).add( pV.y.mul( 0.8253 ) ),
		).toVar();

		const n1 = vnoise( vec3( pV.mul( f1 ), uTime.mul( 1.3 ) ) ).sub( 0.5 ).toVar();
		const n2 = vnoise( vec3( rp.mul( f2 ).add( 31.7 ), uTime.mul( 2.9 ) ) ).sub( 0.5 ).toVar();
		const n = n1.mul( 0.62 ).mul( w1 ).add( n2.mul( 0.38 ).mul( w2 ) ).toVar();

		// Facet density is a positive quantity, so it modulates log-normally rather
		// than as a squared linear ramp. The old (1+g n)^2 with g near 2.7 swung the
		// lobe over a 40:1 range - most of the sea landed either at zero or hard
		// against the ceiling, which is binary speckle, not glitter. exp() cannot go
		// negative, is bounded because the noise is bounded, and its mean is corrected
		// exactly by the second moment, so the lobe's radiance is redistributed and
		// never created.
		const g = float( 1.6 ).mul( clamp( uGlitter, 0.0, 3.0 ) ).toVar();
		const wv = float( 0.06 ).mul(
			float( 0.3844 ).mul( w1 ).mul( w1 ).add( float( 0.1444 ).mul( w2 ).mul( w2 ) ),
		).toVar();

		res.assign( g.mul( n ).sub( float( 0.5 ).mul( g ).mul( g ).mul( wv ) ).exp() );

	} );

	return res;

} );

// ---- swell self-shadowing ---------------------------------------------------

// Large-scale self-shadowing from the swell. At low sun the backs of the long
// waves genuinely go dark, and that light/shade separation across the swell is
// most of what makes a photographed sea look like it has mass. Only the two
// longest cascades are marched: everything shorter shadows at a scale below one
// pixel and is already accounted for by the Smith masking term.
//
//   float sunVisibility(vec2 p, float h, float dist){
//     if (uWaveShadow <= 0.0) return 1.0;
//     vec2 sd = uSunDir.xz;
//     float sl = length(sd);
//     if (sl < 1e-3 || uSunDir.y > 0.55) return 1.0;
//     sd /= sl;
//     float sy = max(uSunDir.y, 0.02) / max(sl, 1e-3);   // rise per metre travelled
//     float occ = 0.0;
//     for (int i=1;i<=3;i++){
//       float t = float(i*i) * 3.5 * max(uShadowScale, 0.05);
//       vec2 q = p + sd*t;
//       float hz = textureLod(uDisp, vec3(q/uPatch[0], 0.0), 0.0).y
//                + textureLod(uDisp, vec3(q/uPatch[1], 1.0), 0.0).y;
//       occ = max(occ, (hz*uHeightScale - h) / t);
//     }
//     float sh = smoothstep(sy*0.10, sy*0.95, occ);
//     // Past a few hundred metres a swell shadow is finer than a pixel, so it is
//     // already inside the mean radiance and re-applying it only causes aliasing.
//     sh *= 1.0 - smoothstep(400.0, 2000.0, dist);
//     return 1.0 - clamp(uWaveShadow, 0.0, 1.0) * 0.9 * sh;
//   }
//
// p is vFlat.xz (the UNDISPLACED grid point — the march walks the flat plane and
// compares heights sampled off it), h is vSwellH, dist is vDist.
//
// The `uSunDir.y > 0.55` cutoff is not a performance guard: above ~33 degrees a
// swell simply does not shadow its own back, and sy — the rise per metre
// travelled along the ground — blows up as the sun approaches the zenith.
//
// Two early returns, two result-var branches; the march's three iterations are
// unrolled in JS; both taps are .level(0). Notes 3, 4 and 6.
export const sunVisibility = /*@__PURE__*/ Fn( ( [ p, h, dist ] ) => {

	const pV = p.toVar();
	const hV = h.toVar();

	// Both GLSL early returns are this untouched initial value.
	const res = float( 1.0 ).toVar();

	// GLSL: `if (uWaveShadow <= 0.0) return 1.0;`
	If( uWaveShadow.greaterThan( 0.0 ), () => {

		const sd = uSunDir.xz.toVar();
		const sl = sd.length().toVar();

		// GLSL: `if (sl < 1e-3 || uSunDir.y > 0.55) return 1.0;` — the positive
		// complement, with .and(). See note 3.
		If( sl.greaterThanEqual( 1e-3 ).and( uSunDir.y.lessThanEqual( 0.55 ) ), () => {

			sd.divAssign( sl );
			// rise per metre travelled
			const sy = uSunDir.y.max( 0.02 ).div( sl.max( 1e-3 ) ).toVar();

			const occ = float( 0.0 ).toVar();

			// GLSL: for (int i=1;i<=3;i++) with `float(i*i)`, so 1, 4, 9. Unrolled
			// in JS — see note 4.
			for ( const isq of [ 1.0, 4.0, 9.0 ] ) {

				const t = float( isq ).mul( 3.5 ).mul( uShadowScale.max( 0.05 ) ).toVar();
				const q = pV.add( sd.mul( t ) ).toVar();

				// textureLod(uDisp, vec3(q/uPatch[c], float(c)), 0.0).y for c = 0 and
				// c = 1. uniformArray.element() builds its index as uint unless the
				// index node is already an integer type, so the JS number goes through
				// int() — otherwise this emits `uPatch[ uint( 0.0 ) ]`.
				const hz = dispTexture
					.sample( q.div( uPatch.element( int( 0 ) ) ) ).depth( int( 0 ) ).level( 0 ).y
					.add(
						dispTexture
							.sample( q.div( uPatch.element( int( 1 ) ) ) ).depth( int( 1 ) ).level( 0 ).y,
					).toVar();

				// uHeightScale is water-common's: the march reads the same height
				// field the vertex stage displaced by. Note 7.
				occ.assign( occ.max( hz.mul( uHeightScale ).sub( hV ).div( t ) ) );

			}

			const sh = smoothstep( sy.mul( 0.10 ), sy.mul( 0.95 ), occ ).toVar();
			// Past a few hundred metres a swell shadow is finer than a pixel, so it is
			// already inside the mean radiance and re-applying it only causes aliasing.
			sh.mulAssign( float( 1.0 ).sub( smoothstep( 400.0, 2000.0, dist ) ) );

			res.assign( float( 1.0 ).sub( clamp( uWaveShadow, 0.0, 1.0 ).mul( 0.9 ).mul( sh ) ) );

		} );

	} );

	return res;

} );

// ---- capillary ripples ------------------------------------------------------

// Parasitic capillary ripples ride the windward face of the short gravity waves
// and die out within tens of metres of the eye, where the pixel footprint starts
// averaging them away. They are what stops the first few metres reading as mush.
//
//   vec2 capillarySlope(vec2 p, float t, float amp){
//     vec2 w = uWindDirV, q = windPerp();
//     vec2 x = vec2(dot(p, w), dot(p, q));
//     // Crests a few centimetres apart across the wind, stretched along it: well
//     // below the finest cascade, which is why they have to be procedural.
//     vec3 c = vec3(x.x*3.0, x.y*11.0, t*1.6);
//     float e = 0.30;
//     float n0 = fbm3(c, 2);
//     float nx = fbm3(c + vec3(e, 0.0, 0.0), 2);
//     float ny = fbm3(c + vec3(0.0, e, 0.0), 2);
//     vec2 g = vec2(nx - n0, ny - n0) / e;
//     // Cross-wind slope dominates: the ripples run along the wind.
//     return (w*g.x*0.35 + q*g.y) * amp;
//   }
//
// The gradient is a FORWARD difference at e = 0.30 — not a central one — over
// three two-octave fbm3 evaluations. That asymmetry is a half-texel bias in the
// slope and it is what shipped; a central difference would need four
// evaluations and would move every ripple.
//
// The 3.0 / 11.0 pair in `c` is the anisotropy, and it is the whole point of
// working in the wind frame: crests a few centimetres apart ACROSS the wind
// (x.y*11.0), stretched ALONG it (x.x*3.0). That is also why the return weights
// the along-wind component down by 0.35 and leaves the cross-wind one at full
// strength — the cross-wind slope dominates because the ripples run along the
// wind.
//
// `amp` arrives with the whole capillary strength already folded in by the
// caller (WATER_FS:386-388: uCapillary, the distance fade, the wind-speed clamp
// and the windward bias). This module owns none of those.
export const capillarySlope = /*@__PURE__*/ Fn( ( [ p, t, amp ] ) => {

	// Pinned for the same reason as in scintillation: p is read twice below and
	// an Fn without a layout is inlined, so an un-var'd node is recomputed.
	const pV = p.toVar();

	const w = uWindDir.toVar();
	const q = windPerp().toVar();
	const x = vec2( pV.dot( w ), pV.dot( q ) ).toVar();

	// Crests a few centimetres apart across the wind, stretched along it: well
	// below the finest cascade, which is why they have to be procedural.
	const c = vec3( x.x.mul( 3.0 ), x.y.mul( 11.0 ), t.mul( 1.6 ) ).toVar();
	const e = float( 0.30 ).toVar();

	const n0 = fbm3( c, int( 2 ) ).toVar();
	const nx = fbm3( c.add( vec3( e, 0.0, 0.0 ) ), int( 2 ) ).toVar();
	const ny = fbm3( c.add( vec3( 0.0, e, 0.0 ) ), int( 2 ) ).toVar();
	const g = vec2( nx.sub( n0 ), ny.sub( n0 ) ).div( e ).toVar();

	// Cross-wind slope dominates: the ripples run along the wind.
	return w.mul( g.x ).mul( 0.35 ).add( q.mul( g.y ) ).mul( amp );

} );

// ---- foam field -------------------------------------------------------------
//
// Jacobian / fold coverage (foamF/foamR) still answers WHERE. This field
// mottles brightness inside that footprint; it is not a coverage stencil.
// Occupied (1−F1) cells were discs; thin F2−F1-only was a wireframe; fbm
// patches were a cloud; unstretched regular F2−F1 was a hex tray; wake ×
// walls was the honeycomb around the hull. Do not restore the 25 cm / 6 cm
// sand relief. CPU twin: src/foam-lace.js.
//
// RETURNS vec2( field, thick ): .x is the 0..1 lace field used to resolve
// coverage, .y is optical thickness (cores brighter than mid-edge). See note 5.
//
// Far-field collapse onto 0.5 is load-bearing: the multiplicative coverage
// path assumes a mean-centred field, and a sparse field whose mean stayed
// 0.25 would silently shrink every distant raft.
export const foamField = /*@__PURE__*/ Fn( ( [ p, t, foot, detail ] ) => {

	const pV = p.toVar();
	const tV = t.toVar();
	const footV = foot.toVar();
	const detailV = detail.toVar();

	const w = uWindDir.toVar();
	const q = windPerp().toVar();
	const x = vec2( pV.dot( w ), pV.dot( q ) ).toVar();

	const s = vec2(
		x.x.mul( float( 1.0 ).sub( float( 0.38 ).mul( uFoamStreak ) ) ),
		x.y.mul( float( 1.0 ).add( float( 0.70 ).mul( uFoamStreak ) ) ),
	).toVar();

	const slide = w.mul( tV ).mul( uFoamDrift.max( 0.0 ) ).toVar();
	const flow = tV.mul( 0.08 ).toVar();
	const wx = vnoise( vec3( s.mul( 0.04 ), flow ) ).sub( 0.5 ).toVar();
	const wy = vnoise( vec3( s.mul( 0.04 ).add( 17.3 ), flow.add( 3.1 ) ) ).sub( 0.5 ).toVar();
	const sp = s.add( vec2( wx.mul( 3.1 ), wy.mul( 2.7 ) ) ).sub( slide ).toVar();

	const inv = float( 1.0 ).div( uFoamCell.max( 0.2 ) ).toVar();
	const dens = vnoise( vec3( sp.mul( 0.07 ).mul( inv ), tV.mul( 0.03 ) ) ).toVar();
	const localScale = mix( float( 0.68 ), float( 1.34 ), dens ).toVar();
	const fillK = uFoamFill.max( 0.0 ).min( 1.0 ).toVar();

	const raftN = fbm3( vec3( sp.mul( 0.10 ).mul( inv ).mul( localScale ), tV.mul( 0.05 ) ), int( 3 ) ).toVar();
	const tearN = vnoise( vec3( sp.mul( 0.22 ).mul( inv ), tV.mul( 0.07 ) ) ).toVar();
	const chewN = vnoise( vec3( sp.mul( 0.40 ).mul( inv ), tV.mul( 0.11 ) ) ).toVar();
	const raft = smoothstep( mix( float( 0.50 ), float( 0.26 ), fillK ), 0.70, raftN )
		.mul( mix( float( 0.48 ), float( 1.0 ), smoothstep( 0.12, 0.68, tearN ) ) )
		.mul( mix( float( 0.58 ), float( 1.0 ), smoothstep( 0.10, 0.58, chewN ) ) ).toVar();

	const grain = vnoise( vec3( sp.mul( 9.2 ).mul( inv ), tV.mul( 0.55 ) ) ).toVar();
	const film = raft.mul( float( 0.70 ).add( float( 0.30 ).mul( grain ) ) ).toVar();

	const width = mix( float( 0.20 ), float( 0.36 ), dens ).toVar();
	const broken = smoothstep( 0.20, 0.52, vnoise( vec3( sp.mul( 0.52 ).mul( inv ), tV.mul( 0.08 ) ) ) ).toVar();
	const c0 = cellular3( sp.mul( 0.72 ).mul( inv ).mul( localScale ) ).toVar();
	const gap0 = c0.y.sub( c0.x ).toVar();
	const wallGate = mix(
		float( 0.06 ), float( 1.0 ), smoothstep( 0.18, 0.78, broken ),
	).toVar();
	const fil0 = smoothstep( width, 0.040, gap0 ).mul( wallGate ).toVar();
	const core0 = smoothstep( width.mul( 0.38 ), 0.016, gap0 ).mul( wallGate ).toVar();

	const fillN = fillK.div( 0.55 ).toVar();
	const extra = fillK.sub( 0.55 ).div( 0.45 ).max( 0.0 ).min( 1.0 ).toVar();

	const fineScale = mix( float( 0.98 ), float( 1.52 ), float( 1.0 ).sub( dens ) ).toVar();
	const c1 = cellular3( sp.mul( fineScale ).mul( inv ).add( 8.1 ) ).toVar();
	const gap1 = c1.y.sub( c1.x ).toVar();
	const chordGate = smoothstep(
		0.46, 0.76,
		dens.mul( 0.58 ).add( float( 1.0 ).sub( broken ).mul( 0.42 ) ),
	).toVar();
	const fil1 = smoothstep( mix( float( 0.16 ), float( 0.28 ), dens ), 0.028, gap1 )
		.mul( chordGate )
		.mul( fillN.min( 1.0 ) )
		.mul( mix( float( 1.0 ), float( 1.55 ), extra ) ).toVar();

	const hazeLo = mix( float( 0.46 ), float( 0.68 ), extra ).toVar();
	const haze = smoothstep( hazeLo, 0.10, gap0 ).mul( float( 1.0 ).sub( fil0 ) )
		.mul( mix( float( 0.05 ), float( 0.30 ), dens ) )
		.mul( float( 0.45 ).add( float( 0.55 ).mul( grain ) ) )
		.mul( fillN ).toVar();

	const accent = fil0.max( fil1 ).mul( mix( float( 0.02 ), float( 0.10 ), fillK ) )
		.add( haze.mul( 0.28 ) ).toVar();
	const lace = clamp( film.mul( 0.90 ).add( accent ), 0.0, 1.0 ).toVar();

	const fineAmt = clamp( detailV.div( float( 1.85 ) ), 0.0, 2.4 ).toVar();
	const fineFade = float( 1.0 ).sub( smoothstep( 0.08, 0.55, footV ) ).mul( fineAmt ).toVar();
	const bub = float( 0.42 ).add( float( 0.58 ).mul( mix( float( 0.50 ), grain, fineFade.min( 1.0 ) ) ) ).toVar();
	const core = core0.mul( mix( float( 0.45 ), float( 1.0 ), dens ) ).toVar();
	const grainAmt = float( 0.28 ).mul( fineFade.min( 1.0 ) ).toVar();
	const thick = clamp(
		film.mul( 0.78 ).mul( bub )
			.add( core.mul( 0.35 ).mul( bub ) )
			.add( fil0.mul( 0.18 ).mul( bub ) )
			.add( fil1.mul( 0.12 ).mul( bub ) )
			.add( haze.mul( 0.10 ).mul( bub ) )
			.add( grainAmt.mul( grain ).mul( film ) ),
		0.0, 1.0,
	).toVar();

	// STANDALONE mix — note 1.
	const near = float( 1.0 ).sub( smoothstep( 0.12, 1.8, footV ) ).toVar();
	const field = mix( float( 0.5 ), clamp( lace, 0.0, 1.0 ), near ).toVar();

	return vec2( field, clamp( thick, 0.0, 1.0 ) );

} );

// ---- uniform plumbing -------------------------------------------------------

// Mirror of the uniform block in WaterSurface.render (src/water.js:137-180),
// restricted to what this module owns. The driver calls this alongside
// setWaterCommonUniforms, setWaterBrdfUniforms and setWaterSurfaceUniforms,
// exactly as the GLSL shares one uniform block per concern across its programs.
export function setWaterDetailUniforms( p ) {

	uGlitter.value = p.glitter;
	uGlitterScale.value = p.glitterScale;

	uWaveShadow.value = p.waveShadow;
	uShadowScale.value = p.shadowScale;

	uFoamStreak.value = p.foamStreak;
	uFoamDrift.value = p.foamDrift;
	uFoamFill.value = p.foamFill ?? 0.55;
	uFoamCell.value = p.foamCell ?? 1;

}
