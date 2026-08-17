// Camera-in-the-water optics. Twin of src/gpu/tsl/underwater.js and the
// underside branch in water-surface.js / shaders/water.js.
//
// The ocean sheet is a surface at mean sea level. From above it is the sea.
// From below it is an interface: Snell's window in the middle, TIR silver
// around it, and the rest of the frame is a water column (Beer-Lambert).
// A change here is not done until tools/check-underwater.mjs passes.

export const WATER_IOR = 1.333;
export const SNELL_COS_CRIT = Math.cos( Math.asin( 1 / WATER_IOR ) );
export const UNDER_VIS = 36;
export const UNDER_ABSORB_SCALE = 0.42;
// Cinematic shelf the column can hit. Not the FFT `depth` (that is
// wave dispersion). Water Pro's seafloor + caustics need a bed;
// past this the ray runs out to UNDER_VIS and the abyss stays navy.
export const UNDER_FLOOR = 18;

/**
 * Metres along a downward ray to the virtual shelf, or Infinity if
 * the ray misses it (too deep, too glancing, or the bed is past `vis`).
 */
export function underwaterFloorT( depth, rdY, floor = UNDER_FLOOR, vis = UNDER_VIS ) {

	if ( ! ( depth > 0 ) || ! ( rdY < - 0.02 ) ) return Infinity;
	if ( depth >= floor - 0.4 ) return Infinity;
	const t = ( floor - depth ) / - rdY;
	return t > vis ? Infinity : t;

}

/**
 * Metres of water along a view ray from a camera `depth` metres under
 * the mean surface. Looking up hits the interface; looking down hits
 * the virtual shelf when it is in range, otherwise the visibility cap.
 * Above water is 0.
 */
export function underwaterPath( depth, rdY, vis = UNDER_VIS, floor = UNDER_FLOOR ) {

	if ( ! ( depth > 0 ) ) return 0;
	const cap = Math.max( vis, 4 );
	if ( rdY > 0.02 ) return Math.min( depth / rdY, cap );
	const bed = underwaterFloorT( depth, rdY, floor, cap );
	return Number.isFinite( bed ) ? bed : cap;

}

/**
 * Animated caustic web. Twin of `uwCaustic` in src/gpu/tsl/underwater.js.
 * Thin bright lines, dark gaps — a lace, not a sin-product blob field.
 */
function _sm( e0, e1, x ) {

	const u = Math.min( 1, Math.max( 0, ( x - e0 ) / ( e1 - e0 ) ) );
	return u * u * ( 3 - 2 * u );

}

export function uwCaustic( px, pz, t ) {

	const w1 = Math.sin( pz * 0.11 + t * 0.40 ) * 7.5
		+ Math.sin( px * 0.05 + t * 0.18 ) * 3.2;
	const w2 = Math.cos( px * 0.09 - t * 0.35 ) * 7.5
		+ Math.cos( pz * 0.06 + t * 0.12 ) * 3.2;
	const qx = px + w1;
	const qz = pz + w2;
	const a = Math.abs( Math.sin( qx * 0.19 + qz * 0.07 + t * 0.28 ) );
	const b = Math.abs( Math.sin( qz * 0.17 - qx * 0.08 - t * 0.22 ) );
	const c = Math.abs( Math.sin( qx * 0.11 + qz * 0.14 + t * 0.16 ) );
	const l1 = Math.pow( _sm( 0.90, 0.995, a ), 2.1 );
	const l2 = Math.pow( _sm( 0.90, 0.995, b ), 2.1 );
	const l3 = Math.pow( _sm( 0.93, 0.998, c ), 2.6 );
	return Math.min( 3.2, Math.max( l1, l2 ) * 2.5 + l3 * 0.40 );

}

/** Per-channel transmittance through `path` metres of this sea. */
export function beerTrans( absorption, path, scale = UNDER_ABSORB_SCALE ) {

	const a = absorption || [ 0.3, 0.045, 0.03 ];
	const s = Math.max( scale, 0 );
	const p = Math.max( path, 0 );
	return [
		Math.exp( - a[ 0 ] * s * p ),
		Math.exp( - a[ 1 ] * s * p ),
		Math.exp( - a[ 2 ] * s * p ),
	];

}

/** True when the view through the underside is the refracted sky. */
export function snellWindow( cosi, ior = WATER_IOR ) {

	const n = Math.max( ior, 1.01 );
	const crit = Math.cos( Math.asin( Math.min( 1, 1 / n ) ) );
	return cosi > crit;

}

/** Camera is in the water and the look is on. */
export function cameraUnderwater( p, camY ) {

	if ( ( p?.underwater ?? 1 ) < 0.5 ) return false;
	return ( p?.seaLevel ?? 0 ) - camY > 0;

}
