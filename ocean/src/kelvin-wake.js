// Analytic Kelvin wake — the gravity-wave V behind a body on the free surface.
//
// Wikipedia (Wake (physics)): two wake lines form a chevron with the source
// at the vertex. For sufficiently slow motion each arm sits at
// arcsin(1/3) ≈ 19.47° to the track and is made of feathery wavelets at
// roughly 53° to the path. Energy spreads until friction or dispersion
// spends it. The non-dimensional parameter is the Froude number
// Fr = U / √(g L). At high Fr the apparent wedge narrows (Rabaud & Moisy
// 2013 — the "127-year-old riddle" the article points at).
//
// This is NOT a pair of Gaussian ridges. Those read as tubes. A Kelvin
// wake is oscillating gravity waves whose stationary-phase locus is the
// V: diverging wavelets (the arms) plus transverse waves (the interior).
// Height goes positive and negative. Foam lives on the steep positive
// crests of the arms, not painted on a pipe.
//
// Deep-water dispersion: ω² = g k, so a wave that travels with the body
// has k₀ = g / U². At the Kelvin cusp the wave vector is at
// asin(1/√3) ≈ 35.26° to the track; the crest (⊥ k) is then at 54.74°,
// which is Wikipedia's ~53°. k_div = k₀ / cos²(35.26°) = 1.5 k₀.
//
// Twin: src/gpu/tsl/kelvin-wake.js. A change here is not done until
// tools/check-kelvin-wake.mjs passes.

export const KELVIN_G = 9.81;
/** tan(arcsin(1/3)) = 1/√8 — classical Kelvin half-angle. */
export const KELVIN_TAN = 1 / Math.sqrt( 8 );
/** sin(35.26°) = 1/√3 — diverging-wave vector vs the track. */
export const DIVERGE_SIN = 1 / Math.sqrt( 3 );
/** cos(35.26°) = √(2/3). */
export const DIVERGE_COS = Math.sqrt( 2 / 3 );
/** Metres aft at which cylindrical spreading is 1. */
export const KELVIN_REF_M = 12;

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function smoothstep( e0, e1, x ) {

	const t = clamp( ( x - e0 ) / ( e1 - e0 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

/**
 * Half-angle tangent of the wedge. Classical 0.3536 below Fr ~ 1;
 * then θ ≈ 1/(2√2 Fr) so the V pinches in at speed.
 *
 * @param {number} speed m/s
 * @param {number} length body length, m
 */
export function kelvinTan( speed, length ) {

	const U = Math.max( Math.abs( speed ), 0.5 );
	const L = Math.max( length, 1 );
	const Fr = U / Math.sqrt( KELVIN_G * L );
	const tanNarrow = 1 / ( 2 * Math.SQRT2 * Fr );
	return Math.min( KELVIN_TAN, tanNarrow );

}

/**
 * @param {{ x: number, z: number }} p world xz
 * @param {{ head: number[], fwd: number[], speed: number, length: number,
 *   amp: number, decay: number, foam: number, strength?: number,
 *   width?: number }} u
 * @returns {{ foam: number, h: number, z: number }}
 */
export function kelvinWakeAt( p, u ) {

	const strength = u.strength ?? 1;
	if ( ( u.speed ?? 0 ) <= 0.5 || strength <= 0.001 || ( u.amp ?? 0 ) <= 0 ) {

		return { foam: 0, h: 0, z: 0 };

	}

	const relX = p.x - u.head[ 0 ];
	const relZ = p.z - u.head[ 1 ];
	const alo = - ( relX * u.fwd[ 0 ] + relZ * u.fwd[ 1 ] );
	const lat = relX * ( - u.fwd[ 1 ] ) + relZ * u.fwd[ 0 ];
	if ( alo < 0.5 ) return { foam: 0, h: 0, z: 0 };

	const U = Math.max( Math.abs( u.speed ), 2 );
	const k0 = KELVIN_G / ( U * U );
	const tanW = kelvinTan( u.speed, u.length ?? 60 );
	// Finite beam: a point source is width 0. A real body opens the
	// V from ±width/2, then the Kelvin angle takes over.
	const beam = Math.max( u.width ?? 0, 0 ) * 0.5;
	const arm = beam + alo * tanW;
	const absLat = Math.abs( lat );
	const r = Math.hypot( alo, lat );

	const decay = Math.max( u.decay ?? 140, 20 );
	const amp = u.amp * strength
		* Math.sqrt( KELVIN_REF_M / Math.max( r, KELVIN_REF_M ) )
		* Math.exp( - r / decay );

	const lambda = 2 * Math.PI / k0;
	// The V starts at the source (Wikipedia: the body is the vertex).
	// Fading in over a wavelength hid the pattern for the first 150 m
	// at sprint — a long gravity wave still has a wedge at the snout.
	const born = smoothstep( 4, 12, alo );

	const dArm = absLat - arm;
	const face = Math.max( 1.2, 0.22 * Math.sqrt( lambda * r ) );
	const envArm = Math.exp( - ( dArm * dArm ) / ( face * face ) );
	const outside = Math.max( 0, dArm );
	const evanescent = Math.exp( - ( outside * outside ) / ( face * face * 0.35 ) );

	const kDiv = 1.5 * k0;
	const phaseDiv = kDiv * ( alo * DIVERGE_COS + absLat * DIVERGE_SIN );
	const diverging = envArm * evanescent
		* ( Math.cos( phaseDiv ) + 0.4 * Math.cos( 2 * phaseDiv + 0.7 ) );

	const inside = 1 - smoothstep( arm * 0.15, arm + face * 0.6, absLat );
	const transverse = inside * 0.35 * Math.cos( k0 * alo );

	const wave = ( diverging + transverse ) * amp * born;
	const steep = Math.max( 0, diverging ) * envArm;
	const foam = clamp( steep * amp * born * ( u.foam ?? 0.45 ) * 1.4, 0, 1 );
	const slick = clamp( inside * born * 0.45, 0, 1 );

	return { foam, h: wave, z: slick };

}
