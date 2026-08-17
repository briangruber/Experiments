// CPU twin of the wind-foam field.
//
// Shader copies: src/gpu/tsl/water-detail.js `foamField` and
// src/shaders/water.js. A changed digit here is a changed image there —
// tools/check-foam-lace.mjs is the contract.
//
// Jacobian / fold (FFT foamF/foamR) answers WHERE. This field is only the
// brightness structure inside that footprint — not a stencil. Wake and
// wind coverage stay films; the lace wrinkles them. Grain is brightness
// only.
//
// Failure modes already rejected live:
//   occupied (1−F1) cell fills     → discs
//   thin F2−F1 as the only term    → glowing wireframe
//   domain-warped fbm patches      → unstructured cloud
//   unstretched regular F2−F1      → hexagonal tray
//   wake × a wall field            → honeycomb around the hull
//     (the live ski: concentric white Voronoi Vs. Coverage follows the
//     wake envelope; fd is a brightness wrinkle, never a hole punch.)
//
// Return: { field, thick }. `field` is 0..1, high on the lace, collapsing
// to 0.5 once a pixel spans several cells. `thick` is optical thickness
// (junction cores brighter than mid-edge). Grain never writes coverage.

const fract = ( x ) => x - Math.floor( x );

function hash13( x, y, z ) {

	let px = fract( x * 0.1031 );
	let py = fract( y * 0.1031 );
	let pz = fract( z * 0.1031 );
	const d = px * ( pz + 31.32 ) + py * ( py + 31.32 ) + pz * ( px + 31.32 );
	px += d;
	py += d;
	pz += d;
	return fract( ( px + py ) * pz );

}

function hash12( x, y ) {

	let px = fract( x * 0.1031 );
	let py = fract( y * 0.1031 );
	let pz = fract( x * 0.1031 );
	const d = px * ( py + 33.33 ) + py * ( pz + 33.33 ) + pz * ( px + 33.33 );
	px += d;
	py += d;
	pz += d;
	return fract( ( px + py ) * pz );

}

function hash22( x, y ) {

	let px = fract( x * 0.1031 );
	let py = fract( y * 0.1030 );
	let pz = fract( x * 0.0973 );
	const d = px * ( py + 33.33 ) + py * ( pz + 33.33 ) + pz * ( px + 33.33 );
	px += d;
	py += d;
	pz += d;
	return [ fract( ( px + py ) * pz ), fract( ( px + pz ) * py ) ];

}

function vnoise( x, y, z ) {

	const ix = Math.floor( x ), iy = Math.floor( y ), iz = Math.floor( z );
	let fx = x - ix, fy = y - iy, fz = z - iz;
	fx = fx * fx * ( 3 - 2 * fx );
	fy = fy * fy * ( 3 - 2 * fy );
	fz = fz * fz * ( 3 - 2 * fz );
	const n000 = hash13( ix, iy, iz );
	const n100 = hash13( ix + 1, iy, iz );
	const n010 = hash13( ix, iy + 1, iz );
	const n110 = hash13( ix + 1, iy + 1, iz );
	const n001 = hash13( ix, iy, iz + 1 );
	const n101 = hash13( ix + 1, iy, iz + 1 );
	const n011 = hash13( ix, iy + 1, iz + 1 );
	const n111 = hash13( ix + 1, iy + 1, iz + 1 );
	const n00 = n000 + ( n100 - n000 ) * fx;
	const n10 = n010 + ( n110 - n010 ) * fx;
	const n01 = n001 + ( n101 - n001 ) * fx;
	const n11 = n011 + ( n111 - n011 ) * fx;
	const n0 = n00 + ( n10 - n00 ) * fy;
	const n1 = n01 + ( n11 - n01 ) * fy;
	return n0 + ( n1 - n0 ) * fz;

}

function fbm3( x, y, z, oct ) {

	let a = 0.5, s = 0, n = 0;
	for ( let i = 0; i < 8; i ++ ) {

		if ( i >= oct ) break;
		s += a * vnoise( x, y, z );
		n += a;
		a *= 0.5;
		x = x * 2.02 + 7.13;
		y = y * 2.02 + 7.13;
		z = z * 2.02;

	}
	return s / Math.max( n, 1e-4 );

}

const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const mix = ( a, b, t ) => a + ( b - a ) * t;
const smoothstep = ( e0, e1, x ) => {

	const t = clamp01( ( x - e0 ) / ( e1 - e0 ) );
	return t * t * ( 3 - 2 * t );

};

// Twin of src/gpu/tsl/noise.js cellular3. Occupancy is a brightness
// wrinkle only — never coverage (that was the disc look).
export function cellular3( px, py ) {

	const ix = Math.floor( px ), iy = Math.floor( py );
	const fx = px - ix, fy = py - iy;
	let F1 = 8, F2 = 8, occ = 0;
	for ( let y = - 1; y <= 1; y ++ ) {

		for ( let x = - 1; x <= 1; x ++ ) {

			const [ ox, oy ] = hash22( ix + x, iy + y );
			const rx = x + ox - fx, ry = y + oy - fy;
			const d = rx * rx + ry * ry;
			const h = hash12( ix + x + 19.7, iy + y + 7.3 );
			if ( d < F1 ) occ = h;
			F2 = Math.min( F2, Math.max( F1, d ) );
			F1 = Math.min( F1, d );

		}

	}
	return { F1: Math.sqrt( F1 ), F2: Math.sqrt( F2 ), occ };

}

// Same numbers as the shader mask. Fold / coverage 0 → no foam.
export function jacobianGate( fold ) {

	return smoothstep( 0.02, 0.12, clamp01( fold ) );

}

// Churn film inside the hull's trail. High floor so the track stays a
// milky emulsion; fd only mottles brightness. Twin of water.js /
// water-surface.js. Floor 0.12 × walls was the ski honeycomb.
export const WAKE_LACE_FLOOR = 0.78;
export const WAKE_LACE_LO = 0.00;
export const WAKE_LACE_HI = 1.00;
export function wakeFoamMask( wake, fd ) {

	return clamp01( wake * mix(
		WAKE_LACE_FLOOR, 1,
		smoothstep( WAKE_LACE_LO, WAKE_LACE_HI, clamp01( fd ) ),
	) );

}

export function wakeFoamThickness( wake, fd ) {

	return clamp01( wake * mix(
		0.55, 0.92,
		smoothstep( 0.00, 1.00, clamp01( fd ) ),
	) );

}

function laceAt( p, t, foot, detail, wind, streak, drift, fill, cell ) {

	const [ wx, wz ] = wind;
	const qx = - wz, qz = wx;
	const xAlong = p[ 0 ] * wx + p[ 1 ] * wz;
	const xCross = p[ 0 ] * qx + p[ 1 ] * qz;
	const sx = xAlong * ( 1 - 0.38 * streak );
	const sy = xCross * ( 1 + 0.70 * streak );
	// Slide with the surface current (same m/s as the sim's foamDrift).
	// 0.12 m/s was invisible — the web sat still and coverage just faded.
	const slide = Math.max( drift, 0 ) * t;
	// Slow, large warp so cells stretch and shear as they travel, not
	// translate as a rigid stamp.
	const flow = t * 0.08;
	const warpX = ( vnoise( sx * 0.04, sy * 0.04, flow ) - 0.5 ) * 3.1;
	const warpY = ( vnoise( sx * 0.04 + 17.3, sy * 0.04 + 17.3, flow + 3.1 ) - 0.5 ) * 2.7;
	const spx = sx + warpX - wx * slide;
	const spy = sy + warpY - wz * slide;

	// 1 = authored clump scale. Higher = bigger rafts. Warp stays in world
	// metres so large patches still shear instead of looking zoomed.
	const inv = 1 / Math.max( cell, 0.2 );
	const dens = vnoise( spx * 0.07 * inv, spy * 0.07 * inv, t * 0.03 );
	const localScale = mix( 0.68, 1.34, dens );
	const fillK = clamp01( fill );

	// Irregular leftover rafts. Occupied Voronoi cells were discs; F2−F1
	// walls were the glowing wireframe on the ski. fbm patches with a
	// second tear so edges unzip instead of closing into blobs.
	const raftN = fbm3( spx * 0.10 * inv * localScale, spy * 0.10 * inv * localScale, t * 0.05, 3 );
	const tearN = vnoise( spx * 0.22 * inv, spy * 0.22 * inv, t * 0.07 );
	const chewN = vnoise( spx * 0.40 * inv, spy * 0.40 * inv, t * 0.11 );
	const raftLo = mix( 0.50, 0.26, fillK );
	const raft = smoothstep( raftLo, 0.70, raftN )
		* mix( 0.48, 1.0, smoothstep( 0.12, 0.68, tearN ) )
		* mix( 0.58, 1.0, smoothstep( 0.10, 0.58, chewN ) );

	const grain = vnoise( spx * 9.2 * inv, spy * 9.2 * inv, t * 0.55 );
	const film = raft * ( 0.70 + 0.30 * grain );

	// Mild draining-strand accent. Never the coverage stencil.
	const width = mix( 0.20, 0.36, dens );
	const broken = smoothstep( 0.20, 0.52, vnoise( spx * 0.52 * inv, spy * 0.52 * inv, t * 0.08 ) );
	const c0 = cellular3( spx * 0.72 * inv * localScale, spy * 0.72 * inv * localScale );
	const gap0 = c0.F2 - c0.F1;
	const wallGate = mix( 0.06, 1.0, smoothstep( 0.18, 0.78, broken ) );
	const fil0 = smoothstep( width, 0.040, gap0 ) * wallGate;
	const core0 = smoothstep( width * 0.38, 0.016, gap0 ) * wallGate;

	const fillN = fillK / 0.55;
	const extra = clamp01( ( fillK - 0.55 ) / 0.45 );
	const fineScale = mix( 0.98, 1.52, 1 - dens );
	const c1 = cellular3( spx * fineScale * inv + 8.1, spy * fineScale * inv + 8.1 );
	const gap1 = c1.F2 - c1.F1;
	const chordGate = smoothstep( 0.46, 0.76, dens * 0.58 + ( 1 - broken ) * 0.42 );
	const fil1 = smoothstep( mix( 0.16, 0.28, dens ), 0.028, gap1 )
		* chordGate
		* Math.min( fillN, 1 )
		* mix( 1.0, 1.55, extra );

	const hazeLo = mix( 0.46, 0.68, extra );
	const haze = smoothstep( hazeLo, 0.10, gap0 )
		* ( 1 - fil0 )
		* mix( 0.05, 0.30, dens )
		* ( 0.45 + 0.55 * grain )
		* fillN;

	const accent = Math.max( fil0, fil1 ) * mix( 0.02, 0.10, fillK ) + haze * 0.28;
	const lace = clamp01( film * 0.90 + accent );

	const fineAmt = Math.min( Math.max( detail / 1.85, 0 ), 2.4 );
	const fineFade = ( 1 - smoothstep( 0.08, 0.55, foot ) ) * fineAmt;
	const bub = 0.42 + 0.58 * mix( 0.50, grain, Math.min( fineFade, 1 ) );
	const core = core0 * mix( 0.45, 1.0, dens );
	const grainAmt = 0.28 * Math.min( fineFade, 1 );
	const thick = clamp01(
		film * 0.78 * bub
			+ core * 0.35 * bub
			+ fil0 * 0.18 * bub
			+ fil1 * 0.12 * bub
			+ haze * 0.10 * bub
			+ grainAmt * grain * film,
	);

	const near = 1 - smoothstep( 0.12, 1.8, foot );
	return {
		field: mix( 0.5, clamp01( lace ), near ),
		thick,
		crest: fil0,
		veins: fil1,
		residual: haze + film,
		core,
	};

}

// p = [x, z] world metres, t = time (s), foot = pixel footprint (m),
// detail = foamDetail (default 1.85), wind = unit [wx, wz], streak = foamStreak,
// drift = foamDrift m/s (the lace slides at the same speed the sim advects coverage),
// fill = foamFill (0 = sparse torn clumps, 0.55 = authored, 1 = broader rafts),
// cell = foamCell (1 = authored clump size; higher = bigger rafts).
export function foamField( p, t, foot, detail = 1.85, wind = [ 1, 0 ], streak = 0.16, drift = 0.6, fill = 0.55, cell = 1 ) {

	const L = laceAt( p, t, foot, detail, wind, streak, drift, fill, cell );
	return { field: L.field, thick: L.thick };

}

export function foamLaceParts( p, t, foot, detail = 1.85, wind = [ 1, 0 ], streak = 0.16, drift = 0.6, fill = 0.55, cell = 1 ) {

	return laceAt( p, t, foot, detail, wind, streak, drift, fill, cell );

}
