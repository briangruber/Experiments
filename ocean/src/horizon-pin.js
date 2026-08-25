// Whether the outermost radial-grid ring should sit on the sightline tangent.
//
// The pin closes a coverage gap at the horizon (see WATER_VS in
// src/shaders/water.js). A downward look puts that horizon off-screen; the pin
// then lifts the last quads into a sliver that clips the top of the frame as a
// smeared band. Disable it only once the geometric horizon is actually above
// the top of the picture.
//
// The first gate used forward.y vs 85% of half-fov, which treats the horizon
// as horizontal. From a high camera the horizon sits `dip` below level
// (sqrt(2 h / R)), so a typical flight look — down at the sea, horizon still
// on the top edge — dropped the pin and left a black sliver (clear colour /
// the LUT's below-horizon limb). Same pop when pitching the camera through
// that threshold. Keep the pin until every corner of the frame is below the
// horizon, plus a small margin so a high bank or a fast look does not flicker
// it. A centre-only test missed the high side of a rolled view.

const R_EARTH = 6371000;
const OFFSCREEN = 0.04; // ~2.3° past the highest corner of the frame
// Metres under the sea before the underside sees full displacement.
// 0 at the interface so crossing is a fade, not a pop through a crest.
export const UNDER_WAVE_FADE = 2.5;
// Pin stays on for a ski/boat eye (~1.4 m). Only the last half-metre
// above the sea, and everything under it, drops the pin so it cannot
// drag the last ring down through the waves with the camera.
const PIN_SURFACE_FADE = 0.8;

export function horizonDip( ctx, p ) {

	const hEye = Math.max( ( ctx?.camPos?.[ 1 ] ?? 6 ) - ( p?.seaLevel ?? 0 ), 1 );
	const curve = Math.max( p?.earthCurve ?? 1, 1e-3 );
	return Math.sqrt( 2 * hEye * curve / R_EARTH );

}

function dirElevation( fwd, right, up, tanH, tanV, sx, sy ) {

	const x = fwd[ 0 ] + right[ 0 ] * tanH * sx + up[ 0 ] * tanV * sy;
	const y = fwd[ 1 ] + right[ 1 ] * tanH * sx + up[ 1 ] * tanV * sy;
	const z = fwd[ 2 ] + right[ 2 ] * tanH * sx + up[ 2 ] * tanV * sy;
	const len = Math.hypot( x, y, z ) || 1;
	return Math.asin( Math.min( 1, Math.max( - 1, y / len ) ) );

}

/** Highest elevation (rad) of any sample in the view frustum. */
export function frameTopElevation( ctx, p ) {

	const fwd = ctx?.camFwd;
	if ( ! fwd ) return 0;
	const vfov = ( ctx.fov ?? p?.fov ?? 40 ) * Math.PI / 180;
	const el = Math.asin( Math.min( 1, Math.max( - 1, fwd[ 1 ] ) ) );
	const right = ctx.camRight;
	const up = ctx.camUp;
	if ( ! right || ! up ) return el + vfov * 0.5;
	const aspect = Math.max( ctx.aspect ?? p?.aspect ?? 1.6, 0.2 );
	const tanV = Math.tan( vfov * 0.5 );
	const tanH = tanV * aspect;
	let top = el;
	for ( const sx of [ - 1, 0, 1 ] ) {

		for ( const sy of [ 0, 1 ] ) {

			if ( sx === 0 && sy === 0 ) continue;
			top = Math.max( top, dirElevation( fwd, right, up, tanH, tanV, sx, sy ) );

		}

	}
	return top;

}

export function horizonPinAmount( ctx, p ) {

	const fy = ctx?.camFwd?.[ 1 ];
	if ( fy == null ) return 1;
	const sea = p?.seaLevel ?? 0;
	const y = ctx?.camPos?.[ 1 ] ?? 6;
	const above = y - sea;
	if ( above <= 0 ) return 0;
	const surface = above >= PIN_SURFACE_FADE ? 1 : above / PIN_SURFACE_FADE;
	const dip = horizonDip( ctx, p );
	const look = frameTopElevation( ctx, p ) > - dip - OFFSCREEN ? 1 : 0;
	return look * surface;

}
