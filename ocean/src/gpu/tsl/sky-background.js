// The sky BACKGROUND pass in TSL — the pass that turns the baked LUT into the
// image behind everything. Ported from main() and its helpers in SKY_BG_FS
// (src/shaders/sky.js:288-866): the celestial discs and their refraction squash,
// the star field, the cirrus veil, and the composition that layers all of it
// under the cumulus deck marched by ./cloud-march.js.
//
// This is the last piece of the sky. ./atmosphere.js has the scattering,
// ./sky-lut.js bakes the table, ./cloud-field.js and ./cloud-march.js do the
// deck; this consumes all four and produces the pixel.
//
// One source, both backends: no wgslFn, no glslFn. See docs/webgpu-port.md.
//
// ---------------------------------------------------------------------------
// FOUR THINGS THAT WILL BITE A READER COMING FROM THE GLSL
//
// 1. SCREEN v IS UPSIDE DOWN RELATIVE TO THE GLSL, ON BOTH BACKENDS.
//
//    The GLSL's vUv comes from FS_VERT_FAR (`vUv = a_pos*0.5+0.5`), so v = 0 is
//    the BOTTOM of the frame. TSL's screenUV is `screenCoordinate / screenSize`,
//    and ScreenNode.generate flips screenCoordinate when `builder.isFlipY()` —
//    which is true for GLSLNodeBuilder and false for WGSLNodeBuilder, precisely
//    so both agree on WebGPU's top-down convention. So screenUV has v = 0 at the
//    TOP on BOTH backends, consistently.
//
//    Measured, not assumed: prototypes/screenuv-probe.html reads the coordinate
//    back out of a float target and reports 0.938 on the bottom row under WebGL2.
//
//    That is good news — one convention, one code path — but it is the OPPOSITE
//    of the GLSL's, so the flip has to happen exactly once. glFragCoord() and
//    glScreenUV() below are that one place. Do not flip again downstream.
//
//    Getting this wrong does not error. It renders a beautifully lit sky with
//    the horizon in the wrong half of the frame.
//
// 2. `out float dist` IS NOT A THING IN TSL. cirrusLayer's second return value
//    (the range to the shell, which the haze term needs) comes back packed:
//    cirrusLayer returns vec2(coverage, dist). The GLSL's early `return 0.0`
//    paths return vec2(0.0, 0.0), and the caller tests .x exactly as the GLSL
//    tests the return value.
//
// 3. THE STAR LOOP IS UNROLLED IN JS. The GLSL walks the 2x2x2 lattice
//    neighbourhood with `for (int i=0;i<8;i++)` and indexes the corner with
//    `i & 1`, `(i >> 1) & 1`, `(i >> 2) & 1`. Bit ops on a loop counter are not
//    something this repo's probes have exercised on both backends, and the
//    corner offsets are compile-time constants anyway, so the eight iterations
//    are emitted as eight inlined blocks — the same call ./cloud-march.js made
//    for its five-tap light cone (note 5 there). The generated code is what the
//    GLSL compiler would have produced from that loop after unrolling it.
//
//    The `if (h < uStarCutoff) continue;` becomes an `If` around the body, which
//    is what a continue at the top of a loop body means.
//
// 4. THE TWO `if (disc > 0.0)` BLOCKS ARE NOT SKIPPED, THEY ARE MULTIPLIED BY
//    ZERO. A dynamic branch around a handful of ALU ops buys nothing on a GPU
//    that runs the whole warp anyway, and TSL's If cannot early-out a value into
//    an outer scope without a var. Both blocks are pure arithmetic that already
//    ends in a multiply by the disc coverage, so evaluating them unconditionally
//    and adding is *identical* in value wherever the coverage is 0. The one
//    hazard is a division by zero inside the block producing a NaN that survives
//    the multiply — so the two divisions (`solid`, `solidAngle`) keep the GLSL's
//    max(..., 1e-7) guards, which is what makes the unconditional form safe.
//
// 5. `.mix()` AND `.smoothstep()` TAKE THE OBJECT IN DIFFERENT SLOTS. This is a
//    genuine asymmetry in the TSL method-chaining aliases, and it is silent:
//
//      smoothstepElement = ( x, low, high ) => smoothstep( low, high, x )
//      mixElement        = ( t, e1, e2 )    => mix( e1, e2, t )
//
//    So `x.smoothstep(lo, hi)` is GLSL's smoothstep(lo, hi, x) — the object is
//    the VALUE, which is what a reader expects. But `x.mix(a, b)` is
//    mix(a, b, x) — the object is the INTERPOLATION FACTOR, not the first
//    endpoint. Writing `col.mix(target, alpha)` for GLSL's mix(col, target,
//    alpha) therefore compiles, runs, and computes mix(target, alpha, col).
//
//    It cost a full diagnosis here: with alpha ~0.0008 the cirrus veil still
//    painted itself over the sky at nearly full strength, because `col` — not
//    alpha — was the blend factor. ./noise.js and ./cloud-field.js both warn
//    about this in their own headers; this file did not, and got it wrong twice.
//
//    So: every blend in this file uses the STANDALONE mix( a, b, t ), whose
//    argument order is GLSL's. Do not "simplify" one back to a method call.

import * as THREE from 'three';
import {
  Fn, float, int, vec2, vec3, vec4, mix,
  texture, uniform, screenUV, screenSize, screenCoordinate,
  fwidth, If, select,
} from 'three/tsl';

import {
  R_PLANET, TAU_A, BETA_R, BETA_MS, BETA_MA, H_RAY,
  uTurbidity, uSunIrradiance, uAtmoExposure,
  miePhase, planetDist, sunTransmittance,
} from './atmosphere.js';

import { dirToSkyUv, uSunDir, uMoonDir, uMoonColor } from './sky-lut.js';
import { hash12, hash13, fbm2, spread01, remap01 } from './noise.js';
import { uTime, uCloudSpeed, uWindDirV, uCamPos } from './cloud-field.js';
import { shellFar, marchClouds } from './cloud-march.js';

// ---- uniforms ---------------------------------------------------------------
// Only the ones SKY_BG_FS declares that no other module owns. uSunDir, uMoonDir
// and uMoonColor come from ./sky-lut.js and uTime/uCamPos/uWindDirV from
// ./cloud-field.js — the GLSL shares one uniform of each across the programs,
// and so does this. Defaults are src/presets.js's.

export const uSunAngularRadius = /*@__PURE__*/ uniform( 0.00465 );
export const uSunDiscIntensity = /*@__PURE__*/ uniform( 1.0 );
export const uSunLimb          = /*@__PURE__*/ uniform( 1.0 );
export const uDiscFlatten      = /*@__PURE__*/ uniform( 0.35 );
export const uDiscCap          = /*@__PURE__*/ uniform( 60000.0 );
export const uSkyDither        = /*@__PURE__*/ uniform( 1.0 );

export const uStars            = /*@__PURE__*/ uniform( 0.0 );
export const uStarSize         = /*@__PURE__*/ uniform( 1.0 );
export const uStarCutoff       = /*@__PURE__*/ uniform( 0.9 );
export const uStarColorTemp    = /*@__PURE__*/ uniform( 1.0 );

export const uCirrus           = /*@__PURE__*/ uniform( 0.0 );
export const uCirrusAlt        = /*@__PURE__*/ uniform( 9000.0 );
export const uCirrusCurl       = /*@__PURE__*/ uniform( 1.0 );
export const uCirrusMask       = /*@__PURE__*/ uniform( 1.0 );

// The camera. The GLSL gets a ray by pushing NDC through uInvViewProj; a
// mat4 uniform is the same thing here.
export const uInvViewProj = /*@__PURE__*/ uniform( new THREE.Matrix4(), 'mat4' );

// ---- the sky LUT ------------------------------------------------------------
// One TextureNode whose value the driver swaps for the real table. A 1x1 black
// placeholder keeps the graph buildable before anything has been baked, so a
// compile probe does not need a renderer to have run first.

const placeholder = /*@__PURE__*/ ( () => {

	const t = new THREE.DataTexture( new Float32Array( [ 0, 0, 0, 1 ] ), 1, 1, THREE.RGBAFormat, THREE.FloatType );
	// The filter state here is not cosmetic on WGSL: isUnfilterable
	// (three.webgpu.js:79067) is true when min and mag are both NearestFilter,
	// and generateTextureLevel then bakes textureLoad() instead of
	// textureSampleLevel() into the shader - decided when the graph is BUILT,
	// from whatever is bound at that moment. TslSky calls setSkyLut() in its
	// constructor before building either material, so the real table is bound
	// first and this never bit; giving the placeholder the table's own sampling
	// state means it cannot bite if that ordering ever changes.
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = THREE.RepeatWrapping;
	t.wrapT = THREE.ClampToEdgeWrapping;
	t.needsUpdate = true;
	return t;

} )();

export const skyLutTexture = /*@__PURE__*/ texture( placeholder );

// Point the background pass at a baked LUT. `tex` is whatever the driver baked
// into — a RenderTarget's .texture, normally.
export function setSkyLut( tex ) {

	skyLutTexture.value = tex;

}

// ---- screen space -----------------------------------------------------------
// See note 1. These two are the ONLY place the v flip happens.

// gl_FragCoord as the GLSL sees it: origin at the BOTTOM left, in pixels.
// screenCoordinate is top-down on both backends, so this undoes that once.
// Used for the two dither hashes, where it decides which pixel gets which
// jitter — a flip here does not change the statistics but it does change every
// individual pixel, which is the difference between matching the reference
// image and merely resembling it.
export const glFragCoord = /*@__PURE__*/ Fn( () => {

	return vec2( screenCoordinate.x, screenSize.y.sub( screenCoordinate.y ) );

} );

// FS_VERT_FAR's vUv: [0,1] with v = 0 at the BOTTOM.
export const glScreenUV = /*@__PURE__*/ Fn( () => {

	return vec2( screenUV.x, float( 1.0 ).sub( screenUV.y ) );

} );

// ---- discs ------------------------------------------------------------------

// Angular radius from a body's centre, with the vertical axis compressed.
// Differential refraction lifts the lower limb of a low sun more than the upper
// one; at true sunset the disc is visibly wider than it is tall, and that squash
// is one of the strongest "this is a photograph" cues there is.
//
//   float discAngle(vec3 rd, vec3 dir, float flatten){
//     vec3 up = normalize(vec3(0.0,1.0,0.0) - dir*dir.y + vec3(1e-6,0.0,0.0));
//     vec3 rt = normalize(cross(dir, up));
//     float dz = dot(rd, dir);
//     vec2 off = vec2(dot(rd, rt), dot(rd, up) * flatten);
//     return atan(length(off), max(dz, 1e-4));
//   }
//
// The vec3(1e-6,0,0) is a degeneracy guard, not a fudge: for a body exactly at
// the zenith, vec3(0,1,0) - dir*dir.y is the zero vector and normalize() of it
// is a NaN that would spread across the whole disc.
export const discAngle = /*@__PURE__*/ Fn( ( [ rd, dir, flatten ] ) => {

	const up = vec3( 0.0, 1.0, 0.0 ).sub( dir.mul( dir.y ) ).add( vec3( 1e-6, 0.0, 0.0 ) ).normalize().toVar();
	const rt = dir.cross( up ).normalize().toVar();
	const dz = rd.dot( dir ).toVar();
	const off = vec2( rd.dot( rt ), rd.dot( up ).mul( flatten ) ).toVar();

	// Two-argument atan: TSL emits atan(y,x) on GLSL and atan2(y,x) on WGSL, so
	// the quadrant convention is the platform's in both cases (see the note on
	// dirToSkyUv in ./sky-lut.js).
	return off.length().atan( dz.max( 1e-4 ) );

} );

// Refraction only bites in the last couple of degrees, and it is a *ratio* of
// vertical to horizontal extent, so it scales the vertical offset.
//
//   float refractFlatten(float elevSin){
//     float e = asin(clamp(elevSin, -1.0, 1.0));
//     return 1.0 + uDiscFlatten * exp(-max(e, -0.02) / 0.035);
//   }
export const refractFlatten = /*@__PURE__*/ Fn( ( [ elevSin ] ) => {

	const e = elevSin.clamp( - 1.0, 1.0 ).asin().toVar();

	return float( 1.0 ).add( uDiscFlatten.mul( e.max( - 0.02 ).negate().div( 0.035 ).exp() ) );

} );

// RGBA16F tops out at 65504 and the raw solar disc radiance is ~3e5, so it has
// to be capped or the tonemap turns +Inf into NaN and the sun renders black.
// Scale the whole triple by its brightest channel, never clamp per channel: a
// per-channel min flattens R, G and B onto the same ceiling and deletes exactly
// the reddening sunTransmittance just computed — a white sun in an orange sky.
//
//   vec3 capRadiance(vec3 c, float maxV){
//     float m = max(max(c.r, c.g), c.b);
//     return c * (maxV / (maxV + m));
//   }
export const capRadiance = /*@__PURE__*/ Fn( ( [ c, maxV ] ) => {

	const m = c.r.max( c.g ).max( c.b ).toVar();

	return c.mul( maxV.div( maxV.add( m ) ) );

} );

// ---- the LUT fetch ----------------------------------------------------------

// Explicit LOD 0, always. The LUT is mipped (the water pass needs its top mips
// for diffuse irradiance) and the implicit derivative of the lat-long mapping
// grows with elevation, so an implicit fetch crosses mip levels partway up the
// sky and lays down horizontal seams right across the frame.
//
// In TSL an implicit fetch is also illegal in some of the places this is called
// from — inside the cirrus branch, and inside the march — so .level(0) is doing
// double duty as the thing that keeps those legal.
export const sampleSky = /*@__PURE__*/ Fn( ( [ rd ] ) => {

	return skyLutTexture.sample( dirToSkyUv( rd ) ).level( 0 ).rgb;

} );

// Same fetch, with the sample point jittered inside its texel. Bilinear
// reconstruction of a smooth gradient is only C0, so every texel row shows up as
// a Mach band; trading that quantisation for sub-texel noise is invisible once
// the film grain in post lands on top of it.
//
//   vec2 texel = 1.0 / vec2(textureSize(uSkyLUT, 0));
//
// textureSize on a TextureNode is `.size(level)`, but the table's dimensions are
// a compile-time constant of this project (LUT_W x LUT_H in ./sky-lut.js) and
// the GLSL's value is the same number, so the reciprocal is folded in as a
// literal rather than fetched. If the LUT is ever resized, this follows it
// because it imports the same constants.
export const sampleSkyDither = /*@__PURE__*/ Fn( ( [ rd, fc ] ) => {

	const uvC = dirToSkyUv( rd ).toVar();
	const texel = vec2( 1.0 / 512.0, 1.0 / 256.0 );
	const j = vec2( hash12( fc ), hash12( fc.add( 37.7 ) ) ).sub( 0.5 ).mul( uSkyDither ).mul( texel ).toVar();

	return skyLutTexture.sample( uvC.add( j ) ).level( 0 ).rgb;

} );

// ---- stars ------------------------------------------------------------------

// Stars need a point-spread function measured in *pixels*, not in noise cells: a
// star whose profile is narrower than a pixel is a single blown texel and reads
// as a dead pixel, which is an instant tell. pxAng is the angular size of a
// pixel, so the disc stays the same apparent size at any resolution or zoom.
//
// The 2x2x2 neighbourhood walk is unrolled — see note 3 at the top.
const STAR_DENS = 190.0;   // cells per unit direction; ~6k stars on the sphere

export const starField = /*@__PURE__*/ Fn( ( [ rd, pxAng ] ) => {

	const p = rd.mul( STAR_DENS ).toVar();
	const base = p.sub( 0.5 ).floor().toVar();

	// The floor has to stay well under a pixel: at 720p one cell is ~4 px, so a
	// 0.32-cell sigma is a 1.3 px sigma — a 4 px lump, which is what turned the
	// field into a scatter of identical blobs. A real star is a sub-pixel point
	// spread by the optics, so let the pixel footprint drive it and keep the
	// floor only as an anti-alias guard.
	const sig = uStarSize.max( 0.25 ).mul( pxAng ).mul( STAR_DENS ).max( 0.16 ).toVar();
	const inv2 = float( 0.5 ).div( sig.mul( sig ) ).toVar();

	const air = float( 1.0 ).div( rd.y.add( 0.06 ).max( 0.06 ) ).toVar();
	const ext = float( - 0.11 ).mul( air.sub( 1.0 ) ).exp()
		.mul( rd.y.smoothstep( - 0.015, 0.035 ) ).toVar();

	const sum = vec3( 0.0 ).toVar();

	// GLSL: c = base + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1))
	for ( let i = 0; i < 8; i ++ ) {

		const c = base.add( vec3( i & 1, ( i >> 1 ) & 1, ( i >> 2 ) & 1 ) ).toVar();
		const h = hash13( c ).toVar();

		// GLSL: `if (h < uStarCutoff) continue;` — a continue at the top of the
		// body is an If around the rest of it. uStarCutoff is a limiting-magnitude
		// control: raising it thins the field to the bright stars a photographic
		// exposure would actually record.
		If( h.greaterThanEqual( uStarCutoff ), () => {

			const cc = c.add( 0.5 ).add(
				vec3( hash13( c.add( 1.0 ) ), hash13( c.add( 2.0 ) ), hash13( c.add( 3.0 ) ) ).sub( 0.5 ).mul( 0.9 ),
			).toVar();
			const d = p.sub( cc ).toVar();
			const r2 = d.dot( d ).toVar();

			// Real magnitude distribution spans many stops: one Vega for a hundred
			// 5th-magnitude specks. A shallow exponent gives a field of equal white
			// dots, which is what made this read as snow rather than sky.
			const mag = hash13( c.add( 7.0 ) ).pow( 6.2 ).toVar();

			// Gaussian core plus a faint wide halo — the halo is what stops a bright
			// star looking like a sticker.
			const psf = r2.mul( inv2 ).negate().exp()
				.add( float( 0.035 ).div( float( 1.0 ).add( r2.mul( inv2 ).mul( 0.10 ) ) ) ).toVar();

			// Scintillation is atmospheric, so it is far stronger near the horizon.
			const tw = float( 1.0 ).sub(
				float( 0.4 ).mul( air.mul( 0.09 ).min( 1.0 ) )
					.mul( float( 0.5 ).add( float( 0.5 ).mul( uTime.mul( 3.1 ).add( h.mul( 190.0 ) ).sin() ) ) ),
			).toVar();

			// Stellar colour is a subtle B-V shift, not a saturated hue. Most
			// naked-eye stars are white to blue-white; the K/M giants that read
			// orange are the minority, so bias the draw rather than splitting it
			// evenly.
			// Standalone mix(), not `.mix()` — see note 5 at the top of the file.
			const tint = mix(
				vec3( 1.0 ),
				mix( vec3( 1.0, 0.88, 0.76 ), vec3( 0.78, 0.86, 1.0 ), hash13( c.add( 3.7 ) ).pow( 0.42 ) ),
				uStarColorTemp,
			).toVar();

			sum.addAssign( tint.mul( mag ).mul( psf ).mul( tw ) );

		} );

	}

	// The GLSL's two early returns (uStars <= 0.001, ext <= 0.001) are folded into
	// the multiply: both produce vec3(0.0), and so does this.
	return sum.mul( ext ).mul( uStars ).mul( 1.1 );

} );

// ---- cirrus -----------------------------------------------------------------

// Returns vec2(coverage, distance-to-shell). See note 2: the GLSL's `out float
// dist` is the .y here, and every early return is vec2(0.0).
export const cirrusLayer = /*@__PURE__*/ Fn( ( [ rd, ro, pxAng ] ) => {

	const outv = vec2( 0.0 ).toVar();

	// GLSL: if (uCirrus <= 0.002) return 0.0;
	If( uCirrus.greaterThan( 0.002 ), () => {

		const c = vec3( 0.0, ro.y.max( 0.5 ).add( R_PLANET ), 0.0 ).toVar();

		// GLSL: if (planetDist(c, rd) > 0.0) return 0.0;  — the ground is in the way.
		If( planetDist( c, rd ).lessThanEqual( 0.0 ), () => {

			const H = uCirrusAlt.max( 4000.0 ).toVar();
			const t = shellFar( c, rd, H.add( R_PLANET ) ).toVar();

			// GLSL: if (t <= 0.0 || t > 400000.0) return 0.0;
			If( t.greaterThan( 0.0 ).and( t.lessThanEqual( 400000.0 ) ), () => {

				// Distance to the shell goes as H/elevation, so d(range)/d(pixel) grows
				// as t^2/H: within a few degrees of the horizon one pixel covers
				// KILOMETRES of the layer. A five-octave field sampled that coarsely
				// does not look like cirrus, it aliases into a fan of perfectly
				// straight converging stripes — that fan, not the wind shear, is what
				// read as a ruled venetian-blind hatch. Drop octaves as the footprint
				// grows and dissolve the veil before it aliases.
				const fp = t.mul( t ).div( H ).mul( pxAng ).div( 9000.0 ).toVar();

				// GLSL: int oct = fp > 0.30 ? 2 : (fp > 0.10 ? 3 : 5);
				const oct = select( fp.greaterThan( 0.30 ), int( 2 ),
					select( fp.greaterThan( 0.10 ), int( 3 ), int( 5 ) ) ).toVar();

				const aa = float( 1.0 ).sub( fp.smoothstep( 0.22, 0.85 ) ).toVar();

				// GLSL: if (aa <= 0.002) return 0.0;
				If( aa.greaterThan( 0.002 ), () => {

					// Cirrus fibres are kilometre-scale; at 34 km per noise cell the whole
					// sky fits inside one lobe and the veil reads as a single grey smear.
					const xz = ro.xz.add( rd.xz.mul( t ) )
						.add( uWindDirV.xz.mul( uTime ).mul( uCloudSpeed ).mul( 2.2 ) ).div( 9000.0 ).toVar();
					const w = uWindDirV.xz.add( vec2( 1e-3, 0.0 ) ).normalize().toVar();
					const s = vec2( xz.dot( w ), xz.dot( vec2( w.y.negate(), w.x ) ) ).toVar();

					// Shear alone draws a ruled hatch: parallel, evenly spaced, edge to
					// edge. Real cirrus is fibrous and hooked, because the fall streaks
					// are dragged through a sheared wind field. It takes TWO scales of
					// domain warp to get that: a single coarse field whose period is
					// wider than the frame only slides the whole sheet sideways, and the
					// streaks stay as straight as they ever were. The tight field is the
					// one that does the visible bending.
					const g0 = vec2( fbm2( s.mul( 0.30 ).add( 4.7 ), int( 3 ) ),
						fbm2( s.mul( 0.30 ).add( 19.1 ), int( 3 ) ) ).sub( 0.5 ).toVar();
					const g1 = vec2( fbm2( s.mul( 1.15 ).add( 31.4 ), int( 2 ) ),
						fbm2( s.mul( 1.15 ).add( 57.2 ), int( 2 ) ) ).sub( 0.5 ).toVar();

					s.addAssign(
						vec2( g0.y.negate(), g0.x ).mul( 2.4 )
							.add( vec2( g1.y.negate(), g1.x ).mul( 0.75 ) ).mul( uCirrusCurl ),
					);

					// Even spacing is the other half of the ruled-hatch read, so let the
					// cross-wind scale breathe: no two fibres then sit the same distance
					// apart.
					s.y.mulAssign( float( 1.0 ).add( g0.x.mul( uCirrusCurl ).mul( 0.9 ) ) );
					s.mulAssign( vec2( 0.55, 1.6 ) );

					const f = spread01( fbm2( s, oct ) ).toVar();
					f.assign( remap01( f, float( 0.62 ).sub( uCirrus.mul( 0.42 ) ), float( 1.0 ) ) );

					// Independent low-frequency mask so the veil is patchy: without it
					// every streak runs the full width of the frame at constant density,
					// which is the single most obvious tell that it is procedural.
					const mask = fbm2( xz.div( uCirrusMask.max( 0.05 ) ).add( 61.7 ), int( 3 ) )
						.smoothstep( 0.30, 0.78 ).toVar();

					outv.assign( vec2(
						f.mul( f ).mul( mask ).mul( aa ).mul( rd.y.smoothstep( 0.0, 0.05 ) ),
						t,
					) );

				} );

			} );

		} );

	} );

	return outv;

} );

// ---- the pass ---------------------------------------------------------------

// SKY_BG_FS's main(), returning the vec3 of linear HDR radiance the pass writes.
// The GLSL's ABYSSAL_OUT() wrapper is the HDR output guard, which is the
// driver's business (and a no-op in value terms), so it is not applied here.
export const skyBackground = /*@__PURE__*/ Fn( () => {

	// vec4 ndc = vec4(vUv*2.0-1.0, 1.0, 1.0); wp = uInvViewProj * ndc;
	// rd = normalize(wp.xyz/wp.w - uCamPos);
	//
	// glScreenUV() is the GLSL's vUv — see note 1. z = 1 is the far plane, which
	// is where this pass draws.
	const ndc = vec4( glScreenUV().mul( 2.0 ).sub( 1.0 ), 1.0, 1.0 ).toVar();
	const wp = uInvViewProj.mul( ndc ).toVar();
	const rd = wp.xyz.div( wp.w ).sub( uCamPos ).normalize().toVar();

	// Angular footprint of one pixel: drives the star PSF and the disc antialias
	// so neither depends on render resolution.
	//
	// GLSL: `length(fwidth(rd))`. TSL exports fwidth (MathNode.FWIDTH), so this is
	// the direct translation rather than spelling out abs(dFdx) + abs(dFdy).
	//
	// Both forms were measured against the reference and left the SAME single-pixel
	// residual of 2.2e-3 (pixel 113,58, with every other pixel exact), so the
	// derivative form is not where that residual comes from — it is a pixel sitting
	// on one of the hard octave switches in cirrusLayer (fp = 0.10 / 0.30), where a
	// last-ulp difference changes the octave count and so the noise value. It is
	// 0.06% of one pixel and it is what the per-pixel tolerance exists for.
	const fw = fwidth( rd ).toVar();
	const pxAng = fw.length().mul( 0.7 ).max( 1e-6 ).toVar();

	const fc = glFragCoord().toVar();
	const col = sampleSkyDither( rd, fc ).toVar();

	const atmoRo = vec3( 0.0, uCamPos.y.max( 1.0 ).add( R_PLANET ), 0.0 ).toVar();
	const sunTr = sunTransmittance( atmoRo, uSunDir ).toVar();
	const sunCol = uSunIrradiance.mul( sunTr ).mul( uAtmoExposure ).toVar();

	// Stars behind everything, drowned by airglow as soon as the sky lifts. A
	// reciprocal rather than an exponential: moonlit sky is already ~100x a star,
	// and an exponential falloff tuned to kill stars by day also kills them on any
	// night with a moon in it.
	const night = float( 1.0 ).div(
		float( 1.0 ).add( col.dot( vec3( 0.2126, 0.7152, 0.0722 ) ).mul( 240.0 ) ),
	).toVar();
	col.addAssign( starField( rd, pxAng ).mul( night ) );

	// ---- moon: a real disc, reddened and flattened by the same air the sun is.
	const moonR = float( 0.00475 ).toVar();
	const mAng = discAngle( rd, uMoonDir, refractFlatten( uMoonDir.y ) ).toVar();
	const moonTr = sunTransmittance( atmoRo, uMoonDir ).toVar();

	// Antialias the limb against the pixel footprint — a hard step on a disc this
	// small is a staircase of blown texels.
	const mDisc = float( 1.0 ).sub(
		mAng.smoothstep( moonR.sub( pxAng.mul( 0.8 ) ), moonR.add( pxAng.mul( 0.8 ) ) ),
	).toVar();

	// See note 4: multiplied by mDisc rather than branched on it. The moon is a
	// rough Lambertian ball, not a limb-darkened star: nearly uniform across the
	// disc with a slight brightening at the edge.
	{

		// GLSL: float m = sqrt(max(0.0, 1.0 - (mAng/moonR)*(mAng/moonR)));
		const mq = mAng.div( moonR ).toVar();
		const m = float( 1.0 ).sub( mq.mul( mq ) ).max( 0.0 ).sqrt().toVar();
		// GLSL: float solid = TAU_A * (1.0 - cos(moonR));
		const solid = float( TAU_A ).mul( float( 1.0 ).sub( moonR.cos() ) ).toVar();
		// 0.22 is the visible disc. moonIntensity feeds the LUT / glitter path;
		// raising that instead lifts the whole night. Daytime moonColor is 0.
		const disc = uMoonColor.div( solid.max( 1e-7 ) )
			.mul( float( 0.62 ).add( float( 0.38 ).mul( m ) ) )
			.mul( mDisc ).mul( moonTr ).mul( uAtmoExposure ).mul( 0.22 ).toVar();
		col.addAssign( capRadiance( disc, uDiscCap ) );

	}

	If( uMoonColor.dot( uMoonColor ).greaterThan( 1e-8 ), () => {

		const mMu = rd.dot( uMoonDir ).max( 0.0 ).toVar();
		col.addAssign(
			uMoonColor.mul( moonTr ).mul( uAtmoExposure )
				.mul( mMu.pow( 80.0 ).mul( 1.15 ).add( mMu.pow( 12.0 ).mul( 0.09 ) ) ),
		);
		const nightW = uSunDir.y.smoothstep( 0.06, - 0.10 ).toVar();
		const hzGlow = rd.y.max( 0.0 ).mul( - 10.0 ).exp()
			.mul( rd.y.smoothstep( - 0.02, 0.04 ) ).toVar();
		const rdH = vec3( rd.x, 0.0, rd.z ).toVar();
		const moH = vec3( uMoonDir.x, 0.0, uMoonDir.z ).toVar();
		const towardMoon = rdH.dot( moH )
			.div( rdH.length().mul( moH.length() ).max( 1e-4 ) ).max( 0.0 ).toVar();
		col.addAssign(
			uMoonColor.mul( moonTr ).mul( uAtmoExposure ).mul( nightW ).mul( hzGlow )
				.mul( float( 0.10 ).add( towardMoon.mul( towardMoon ).mul( 0.28 ) ) ),
		);

	} );

	// ---- sun disc with limb darkening.
	const sAng = discAngle( rd, uSunDir, refractFlatten( uSunDir.y ) ).toVar();
	const sDisc = float( 1.0 ).sub(
		sAng.smoothstep( uSunAngularRadius.sub( pxAng.mul( 0.8 ) ), uSunAngularRadius.add( pxAng.mul( 0.8 ) ) ),
	).toVar();

	{

		const q = sAng.div( uSunAngularRadius.max( 1e-5 ) ).min( 1.0 ).toVar();
		const m = float( 1.0 ).sub( q.mul( q ) ).max( 0.0 ).sqrt().toVar();

		// Eddington limb darkening, plus a redder limb because the cooler edge of
		// the photosphere darkens more in blue than in red.
		const u = vec3( 0.64, 0.58, 0.53 ).mul( uSunLimb ).toVar();
		const limb = vec3( 1.0 ).sub( u ).add( u.mul( m.pow( 0.42 ) ) ).toVar();
		const solidAngle = float( TAU_A ).mul( float( 1.0 ).sub( uSunAngularRadius.cos() ) ).toVar();

		// Irradiance -> radiance across the solar disc's actual solid angle. This is
		// what makes the sun read as blindingly bright next to the sky around it.
		const disc = uSunIrradiance.div( solidAngle.max( 1e-7 ) )
			.mul( uSunDiscIntensity ).mul( limb ).mul( sDisc ).mul( sunTr ).mul( uAtmoExposure ).toVar();
		col.addAssign( capRadiance( disc, uDiscCap ) );

	}

	const skyTop = sampleSky( vec3( 0.0, 1.0, 0.0 ) ).toVar();
	const skyLow = sampleSky( vec3( rd.x, 0.12, rd.z ).normalize() ).toVar();

	// ---- cirrus veil above the cumulus deck: optically thin, so it mostly shows
	// as forward-scattered light with a little of its own shadowing.
	const ciV = cirrusLayer( rd, uCamPos, pxAng ).toVar();
	const ci = ciV.x.toVar();
	const cDist = ciV.y.toVar();

	If( ci.greaterThan( 0.001 ), () => {

		// Ice cloud at 9 km is above most of the reddening air, so it sees a far
		// shorter slant path than the sea does. That is exactly why cirrus is the
		// last thing still burning after the sun has left the surface, and why it is
		// the most saturated pink in a sunset — lighting it with the *camera's*
		// transmittance puts it out early and leaves it grey.
		const hiPos = vec3( 0.0, uCirrusAlt.max( 4000.0 ).add( R_PLANET ), 0.0 ).toVar();
		const fwd = miePhase( rd.dot( uSunDir ), float( 0.62 ) ).mul( 2.6 ).add( 0.09 ).toVar();
		const fwdM = miePhase( rd.dot( uMoonDir ), float( 0.62 ) ).mul( 2.6 ).add( 0.09 ).toVar();

		const lit = uSunIrradiance.mul( sunTransmittance( hiPos, uSunDir ) ).mul( fwd )
			.add( uMoonColor.mul( sunTransmittance( hiPos, uMoonDir ) ).mul( fwdM )
				.mul( select( uMoonColor.dot( uMoonColor ).greaterThan( 1e-8 ), 2.2, 1.0 ) ) ).toVar();

		// Ambient is the sky behind *this* direction, never the zenith: pasting
		// zenith blue over a warm horizon drags every streak colder and darker than
		// the sky it lies on, which is the opposite of what ice cloud does.
		const back = sampleSky( rd ).toVar();
		const cc = lit.mul( uAtmoExposure ).mul( ci.mul( - 1.4 ).exp() ).add( back.mul( 0.72 ) ).toVar();

		const ext = BETA_R.add( vec3( BETA_MS + BETA_MA ).mul( uTurbidity ) ).toVar();
		const hz = ext.mul( - 0.42 ).mul( cDist.min( 200000.0 ) ).exp().toVar();

		const a = ci.mul( uCirrus ).mul( 1.1 ).clamp( 0.0, 0.92 ).toVar();
		// GLSL: col = mix(col, cc*hz + back*(1.0-hz), a);
		// Standalone mix(), not `.mix()` — see note 5 at the top of the file.
		col.assign( mix( col, cc.mul( hz ).add( back.mul( vec3( 1.0 ).sub( hz ) ) ), a ) );

	} );

	// ---- the cumulus deck, over everything above.
	const moonCol = uMoonColor.mul( moonTr ).mul( uAtmoExposure )
		.mul( select( uMoonColor.dot( uMoonColor ).greaterThan( 1e-8 ), 2.6, 1.0 ) ).toVar();
	const cl = marchClouds(
		uCamPos, rd, uSunDir, sunCol, uMoonDir, moonCol, skyTop, skyLow,
		sampleSky( rd ), fc,
	).toVar();

	col.assign( col.mul( float( 1.0 ).sub( cl.a ) ).add( cl.rgb ) );

	return col;

} );

// ---- uniform plumbing -------------------------------------------------------

// Mirror of the setUniforms() call in Sky.drawBackground (src/sky.js:95-141),
// restricted to the uniforms this module owns. The atmosphere block, the LUT
// block, the cloud field and the cloud march each have their own setter, and the
// driver calls all of them — exactly as the GLSL shares one uniform block per
// concern across the programs.
export function setSkyBackgroundUniforms( p, ctx ) {

	uSunAngularRadius.value = p.sunAngularRadius;
	uSunDiscIntensity.value = p.sunDiscIntensity;
	uSunLimb.value = p.sunLimbDarkening;
	uDiscFlatten.value = p.sunRefractFlatten;
	uDiscCap.value = p.sunDiscCap;
	uSkyDither.value = p.skyDither;

	uStars.value = p.stars;
	uStarSize.value = p.starSize;
	// The knob reads as "how much of the field shows"; the shader wants the hash
	// cutoff, which runs the other way.
	uStarCutoff.value = 1.0 - 0.14 * p.starDensity;
	uStarColorTemp.value = p.starColorTemp;

	uCirrus.value = p.cirrus;
	uCirrusAlt.value = p.cirrusAltitude;
	uCirrusCurl.value = p.cirrusCurl;
	uCirrusMask.value = p.cirrusMask;

	if ( ctx?.invViewProj ) uInvViewProj.value.fromArray( ctx.invViewProj );

}



// THE LAYOUT RULE, LEARNED THE EXPENSIVE WAY: only PURE functions may carry a
// layout - parameters and literals only, no uniform and no texture reads.
// builder.buildFunctionNode caches the generated code per backend PER Fn, not
// per program (three.webgpu.js:52904). A layouted body that references a
// uniform bakes the FIRST program's binding name into the cached code; every
// later pipeline reuses it against its own, different bind layout. Measured:
// the sky LUT built first, the background pass reused densities()/extinctionAt()
// with the LUT's bindings, and every pixel came out wrong on WGSL (100%/16000)
// while GLSL misread 5% and failed to compile in dual-renderer pages. A pure
// function's code references nothing outside itself, so the cache is safe.
// ---- WGSL function layouts --------------------------------------------------
// setLayout() makes three compile a TSL Fn as a REAL shader function instead of
// inlining its body at every call site. This is not an optimisation nicety here,
// it is what lets the sky exist on iOS at all:
//
//   Three's WGSL builder declares every inlined node variable at MODULE scope as
//   var<private>, and WebKit enforces a hard 8192-byte budget on the private
//   address space. Fully inlined, the background pass emitted 1,891 private vars
//   (~17.5 KB) - the light-cone unroll alone inlines the cloud density evaluator
//   ten times - and WebKit refused the pipeline:
//
//     "The combined byte size of all variables in the private address space
//      exceeds 8192 bytes"      (captured from an iPhone by the app's own panel)
//
//   As real functions, locals live in FUNCTION address space, outside that
//   budget, and each helper has one body instead of N inlined copies. Chromium
//   imposes no such limit, which is why nothing here ever caught it.
//
// Layout names carry the abyssal prefix so they cannot collide with three's own
// layouted helpers in the same shader module.

discAngle.setLayout( { name: 'abyssal_discAngle', type: 'float', inputs: [ { name: 'rd', type: 'vec3' }, { name: 'dir', type: 'vec3' }, { name: 'flatten', type: 'float' } ] } );
// IMPURE, NOT LAYOUTED (reads uniforms - see the layout rule above)
// refractFlatten.setLayout( { name: 'abyssal_refractFlatten', type: 'float', inputs: [ { name: 'elevSin', type: 'float' } ] } );
capRadiance.setLayout( { name: 'abyssal_capRadiance', type: 'vec3', inputs: [ { name: 'c', type: 'vec3' }, { name: 'maxV', type: 'float' } ] } );
// IMPURE, NOT LAYOUTED (reads uniforms - see the layout rule above)
// starField.setLayout( { name: 'abyssal_starField', type: 'vec3', inputs: [ { name: 'rd', type: 'vec3' }, { name: 'pxAng', type: 'float' } ] } );
// IMPURE, NOT LAYOUTED (reads uniforms - see the layout rule above)
// cirrusLayer.setLayout( { name: 'abyssal_cirrusLayer', type: 'vec2', inputs: [ { name: 'rd', type: 'vec3' }, { name: 'ro', type: 'vec3' }, { name: 'pxAng', type: 'float' } ] } );
