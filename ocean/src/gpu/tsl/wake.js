// The persistent wake field's UPDATE pass, in TSL.
//
// Port of WAKE_FS in src/wake.js. The SAMPLING half of the wake - wakeAt(), and
// every uniform that reconstructs the pattern - was ported with the water and
// lives in ./water-common.js; this is the half that maintains the record.
//
// What the field stores, per texel (src/wake.js's header says it in full):
//
//   .r  how hard the hull was working when it passed  (stir)
//   .g  seconds since it passed                       (age)
//   .b  signed distance from the track, metres        (lat)
//   .a  rate the cusp arms leave that track, m/s
//
// ---------------------------------------------------------------------------
// THREE THINGS THIS PASS GETS RIGHT AND A NAIVE PORT WOULD NOT
//
// 1. THE PASS COORDINATE IS uv(), AND IT WAS MEASURED, NOT REASONED.
//
//    The wake is read back by WORLD position: wakeAt() maps a world point to
//    uv = (p - origin)/extent + 0.5 and samples. What this pass needs is to
//    write the texel that same expression will later fetch.
//
//    The first version used glScreenUV(), this repo's gl_FragCoord-derived vUv
//    equivalent, on the reasoning that the GLSL's vUv is what the reference
//    uses - and a probe that rendered all three candidate coordinates into a
//    target AGREED that glScreenUV matches FS_VERT's convention. The field
//    still came out wrong: 2282 records against the reference's 1575.
//    prototypes/wake-tsl.html settles it empirically, and uv() gives 1575
//    exactly with the lateral distributions matching to 0.057 m.
//
//    The lesson is in the assertions rather than the answer: record COUNT and
//    record CONTENT are orientation-independent, and no amount of flipping
//    turns 2282 into 1575. Trust those over any argument about conventions,
//    this one included.
//
// 2. NO .or() IN A select(). The GLSL stamps a texel when it is abeam AND
//    (the record is empty OR this passage came closer). A boolean .or() feeding
//    a select is precisely the construct Chrome's Metal compiler miscompiles
//    (see the FXAA note in ./post.js), so the disjunction is built from two
//    nested selects instead. Same value, no exotic lowering.
//
// 3. NO SWIZZLE ASSIGNMENT. `rec.g += uDt` becomes an add of vec4(0, dt, 0, 0),
//    which is exact and avoids the swizzle-assignment forms this repo avoids
//    everywhere (see ./noise.js).

import {
	Fn, If, float, vec2, vec4, uniform, texture, clamp, select, uv, smoothstep,
} from 'three/tsl';

import { DataTexture, RGBAFormat, FloatType } from 'three';


// ---- uniforms ---------------------------------------------------------------
//
// Named uWk* rather than uWake*, because ./water-common.js already owns the
// uWake* family (the sampling side) and porting rule 7 says a uniform has one
// owner. These are this pass's own.

export const uWkOrigin = /*@__PURE__*/ uniform( 'vec2' );
export const uWkPrevOrigin = /*@__PURE__*/ uniform( 'vec2' );
export const uWkExtent = /*@__PURE__*/ uniform( 320.0 );
export const uWkPrevExtent = /*@__PURE__*/ uniform( 320.0 );
export const uWkDt = /*@__PURE__*/ uniform( 0.0 );
export const uWkLife = /*@__PURE__*/ uniform( 14.0 );
export const uWkA = /*@__PURE__*/ uniform( 'vec2' );      // hull path this frame, start
export const uWkB = /*@__PURE__*/ uniform( 'vec2' );      // ...and end
export const uWkFwd = /*@__PURE__*/ uniform( 'vec2' );
export const uWkRight = /*@__PURE__*/ uniform( 'vec2' );
export const uWkStir = /*@__PURE__*/ uniform( 0.0 );
export const uWkRate = /*@__PURE__*/ uniform( 0.0 );
export const uWkReach = /*@__PURE__*/ uniform( 0.0 );
export const uWkActive = /*@__PURE__*/ uniform( 0.0 );
export const uWkSize = /*@__PURE__*/ uniform( 512.0 );    // field resolution, texels

// The previous frame's field. A 1x1 placeholder so the node graph can be built
// before any target exists - the same pattern ./post.js uses for its adapt
// textures, and for the same reason.
const prevPlaceholder = /*@__PURE__*/ ( () => {

	const t = new DataTexture( new Float32Array( [ 0, 0, 0, 0 ] ), 1, 1, RGBAFormat, FloatType );
	t.needsUpdate = true;
	return t;

} )();

export const wakePrevTexture = /*@__PURE__*/ texture( prevPlaceholder );

// ---- the pass ---------------------------------------------------------------
//
// src/wake.js WAKE_FS, statement for statement.
export const wakeUpdateFragment = /*@__PURE__*/ Fn( () => {

	// GLSL: vec2 w = uOrigin + (vUv - 0.5) * uExtent;   (note 1)
	const vUv = uv().toVar();
	const w = uWkOrigin.add( vUv.sub( 0.5 ).mul( uWkExtent ) ).toVar();

	// The buffer was centred somewhere else last frame, so every texel is
	// fetched from where its water actually was. The CPU snaps the origin to the
	// texel grid, which makes this an exact tap rather than a resample that
	// would soften the whole field a little more every frame.
	const rec = vec4( 0.0 ).toVar();
	const pv = w.sub( uWkPrevOrigin ).div( uWkPrevExtent ).add( 0.5 ).toVar();

	// SNAP THE TAP TO A TEXEL CENTRE.
	//
	// This is meant to be an exact copy of one texel, not a resample - the CPU
	// snaps the origin to the texel grid precisely so it can be. The GLSL gets
	// that for free because its vUv lands on fragment centres and the origins
	// differ by whole texels, so the arithmetic comes out exact. Relying on
	// that here does NOT survive: measured against the GL reference, the first
	// stamp matched to 0.000 on every channel and then the fields diverged as
	// soon as frames accumulated - a fractional tap plus LinearFilter bleeds a
	// live record into its neighbours a little more every frame, and the live
	// texel count grew about 45% over 90 frames.
	//
	// Snapping states the intent instead of depending on it: floor to the texel
	// and add a half. A no-op wherever the tap was already exact.
	pv.assign( pv.mul( uWkSize ).floor().add( 0.5 ).div( uWkSize ) );
	If( pv.x.greaterThan( 0.0 )
		.and( pv.x.lessThan( 1.0 ) )
		.and( pv.y.greaterThan( 0.0 ) )
		.and( pv.y.lessThan( 1.0 ) ), () => {

		rec.assign( wakePrevTexture.sample( pv ).level( 0 ) );

	} );

	// GLSL: rec.g += uDt;   (note 3)
	rec.assign( rec.add( vec4( 0.0, uWkDt, 0.0, 0.0 ) ) );

	// Clear expired records outright rather than letting them fade: a record is
	// (stir, age, lateral) and interpolating a live one against a stale one
	// would invent a wake that was never laid down.
	If( rec.y.greaterThanEqual( uWkLife ), () => {

		rec.assign( vec4( 0.0 ) );

	} );

	If( uWkActive.greaterThan( 0.5 ).and( uWkStir.greaterThan( 0.001 ) ), () => {

		// Measured against the segment the hull swept this frame, not against a
		// point: at 20 m/s a point test would skip whole rows of texels at any
		// frame rate the sim can actually hit.
		const seg = uWkB.sub( uWkA ).toVar();
		const ll = seg.dot( seg ).max( 1e-5 ).toVar();
		const t = clamp( w.sub( uWkA ).dot( seg ).div( ll ), 0.0, 1.0 ).toVar();
		const d = w.sub( uWkA.add( seg.mul( t ) ) ).toVar();
		const lat = d.dot( uWkRight ).toVar();
		const alo = d.dot( uWkFwd ).toVar();

		// Abeam of that segment is the moment this patch of water gets disturbed
		// and the moment its clock starts - strictly at or behind the hull, never
		// in front. See the long note in src/wake.js: a symmetric window put a
		// shimmering edge a metre AHEAD of the bow, and a wake is what is behind
		// you.
		//
		// The old boolean window was 1.6 m thick and `reach` wide — two
		// texels by 144 m, a ruler through an open-water snout. Feather
		// the front and the far-lat ends so the record does not turn on
		// as a wall. Stir ramps with the along window only; far-lat
		// texels keep full stir so the arms can still grow into them.
		// Keep whichever passage came closest, so a second lap adds to the
		// history instead of resetting the clock on a 150 m strip of it.
		//
		// GLSL: empty || abs(lat) <= abs(rec.b) + 0.01   - built as nested
		// selects, never .or() (note 2).
		const empty = rec.x.lessThan( 0.002 );
		const closer = lat.abs().lessThanEqual( rec.z.abs().add( 0.01 ) );
		const keep = select( empty, float( 1.0 ), select( closer, float( 1.0 ), float( 0.0 ) ) ).toVar();

		// Full reach, thick enough along that a fast swim cannot skip
		// texels. Age RESETS only on the front mound. Far-lat is first
		// touch only, then ages so the Kelvin arms leave the track
		// (the V). Resetting a 13 m corridor every frame froze those
		// arms as two parallel rails.
		const alongW = smoothstep( float( 1.2 ), float( - 0.4 ), alo )
			.mul( smoothstep( float( - 12.0 ), float( - 6.0 ), alo ) ).toVar();
		const inReach = float( 1.0 ).sub(
			smoothstep( uWkReach.mul( 0.88 ), uWkReach, lat.abs() ),
		).toVar();
		const nearLat = float( 1.0 ).sub(
			smoothstep( float( 6.0 ), float( 9.0 ), lat.abs() ),
		).toVar();
		const near = alongW.mul( inReach ).mul( nearLat ).mul( keep ).toVar();
		const far = alongW.mul( inReach )
			.mul( select( empty, float( 1.0 ), float( 0.0 ) ) ).toVar();

		If( near.greaterThan( 0.02 ), () => {

			rec.assign( vec4( uWkStir.mul( alongW ), 0.0, lat, uWkRate ) );

		}, () => {

			If( far.greaterThan( 0.02 ), () => {

				rec.assign( vec4( uWkStir.mul( alongW ), 0.0, lat, uWkRate ) );

			} );

		} );

	} );

	return rec;

} );
