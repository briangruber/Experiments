// The sea bed, in JavaScript, agreeing with the GPU to the centimetre.
//
// TWIN: floorTerrainDepth() in vendor/abyssal/src/shaders/water.js. The shader
// draws the bottom; this file is what anything on the CPU has to use to sit on
// it. They are the same arithmetic, deliberately transcribed rather than
// approximated, because the moment they disagree the rocks either float above
// the sand or sink out of sight -- and a rock hovering half a metre over the
// bed is the single most obvious way to say "this is a texture, not a place".
//
// Any edit here needs the same edit there. The noise primitives below are
// ports of the ones in shaders/sky.js, which water.js includes.
//
// On precision: GLSL runs these in 32-bit and JavaScript in 64-bit, so the two
// do not agree bit for bit. The hashes are evaluated on small lattice integers
// and the divergence works out around a centimetre of depth, which is far
// inside the margin a boulder is bedded by.

const fract = ( x ) => x - Math.floor( x );
const mix = ( a, b, t ) => a + ( b - a ) * t;
const clamp01 = ( x ) => x < 0 ? 0 : x > 1 ? 1 : x;

function smoothstep( e0, e1, x ) {

	const t = clamp01( ( x - e0 ) / ( e1 - e0 ) );
	return t * t * ( 3 - 2 * t );

}

/** Twin: hash12() in shaders/sky.js. */
function hash12( px, py ) {

	let x = fract( px * 0.1031 ), y = fract( py * 0.1031 ), z = fract( px * 0.1031 );
	const d = x * ( y + 33.33 ) + y * ( z + 33.33 ) + z * ( x + 33.33 );
	x += d; y += d; z += d;
	return fract( ( x + y ) * z );

}

/** Twin: hash22() in shaders/sky.js. Returns [x, y]. */
function hash22( px, py ) {

	let x = fract( px * 0.1031 ), y = fract( py * 0.1030 ), z = fract( px * 0.0973 );
	const d = x * ( y + 33.33 ) + y * ( z + 33.33 ) + z * ( x + 33.33 );
	x += d; y += d; z += d;
	return [ fract( ( x + x ) * z ), fract( ( x + y ) * y ) ];

}

/** Twin: vnoise2(). */
function vnoise2( px, py ) {

	const ix = Math.floor( px ), iy = Math.floor( py );
	let fx = px - ix, fy = py - iy;
	fx = fx * fx * ( 3 - 2 * fx );
	fy = fy * fy * ( 3 - 2 * fy );
	const a = hash12( ix, iy ), b = hash12( ix + 1, iy );
	const c = hash12( ix, iy + 1 ), d = hash12( ix + 1, iy + 1 );
	return mix( mix( a, b, fx ), mix( c, d, fx ), fy );

}

/** Twin: fbm2(). */
function fbm2( px, py, oct ) {

	let a = 0.5, s = 0, n = 0, x = px, y = py;
	for ( let i = 0; i < 6 && i < oct; i ++ ) {
		s += a * vnoise2( x, y );
		n += a;
		a *= 0.5;
		x = x * 2.03 + 5.1;
		y = y * 2.03 - 3.7;
	}
	return s / Math.max( n, 1e-4 );

}

/** Twin: cellular3(). Returns [F1, F2, occ]; only F1 is used here. */
function cellular3( px, py ) {

	const ix = Math.floor( px ), iy = Math.floor( py );
	const fx = px - ix, fy = py - iy;
	let F1 = 8, F2 = 8, occ = 0;
	for ( let y = - 1; y <= 1; y ++ ) {
		for ( let x = - 1; x <= 1; x ++ ) {
			const o = hash22( ix + x, iy + y );
			const rx = x + o[ 0 ] - fx, ry = y + o[ 1 ] - fy;
			const d = rx * rx + ry * ry;
			const h = hash12( ix + x + 19.7, iy + y + 7.3 );
			if ( d < F1 ) occ = h;
			F2 = Math.min( F2, Math.max( F1, d ) );
			F1 = Math.min( F1, d );
		}
	}
	return [ Math.sqrt( F1 ), Math.sqrt( F2 ), occ ];

}

/**
 * DEPTH of water over the bed at a world point, in metres, always positive.
 *
 * `lo` is the shallowest the bed comes and `hi` the deepest; the shader is
 * handed the same pair as uFloorDepthMin / uFloorDepthMax.
 */
export function bedDepth( px, pz, lo, hi, scale = 26 ) {

	if ( hi - lo < 0.05 ) return hi;
	const s = Math.max( scale, 4 );
	const u = px / s, v = pz / s;
	const wx = fbm2( u * 0.17, v * 0.17, 3 ) * 2 - 1;
	const wz = fbm2( ( u + 31.4 ) * 0.17, ( v - 17.2 ) * 0.17, 3 ) * 2 - 1;
	const uw = u + wx * 3.4, vw = v + wz * 3.4;
	const bars = Math.sin( uw * 1.7 + Math.sin( vw * 0.9 ) * 0.65 );
	const channels = Math.sin( vw * 1.15 - Math.sin( uw * 0.55 ) * 0.8 );
	const dunes = Math.sin( uw * 2.4 - vw * 1.3 + Math.sin( uw * 0.7 ) * 0.45 );
	const drift = fbm2( u * 0.23, v * 0.23, 3 ) * 2 - 1;
	const grain = fbm2( u * 1.9, v * 1.9, 2 ) * 2 - 1;
	// The lagoon-scale term. Everything above works in units of the terrain
	// scale, which is tens of metres -- bars and channels and ripples. This one
	// is in WORLD metres and slow enough to build banks and basins hundreds of
	// metres across, which is the shape the eye reads as a place rather than as
	// a texture: pale shallows, a drop-off, deep blue, and then it comes up
	// again somewhere else.
	const basin = fbm2( px * 0.00085, pz * 0.00085, 4 ) * 2 - 1;
	const hcw = cellular3( px * 0.055, pz * 0.055 );
	const hseed = fbm2( px * 0.03 + 71, pz * 0.03 + 71, 2 );
	const heads = ( 1 - smoothstep( 0.10, 0.34, hcw[ 0 ] ) )
		* smoothstep( 0.42, 0.58, hseed );
	const w = clamp01( 0.5 + 0.5 * ( bars * 0.20 + channels * 0.15 + dunes * 0.08
		+ drift * 0.42 + grain * 0.12 + basin * 1.25 ) );
	return Math.max( mix( hi, lo, w ) - heads * 2.2, 0.8 );

}
