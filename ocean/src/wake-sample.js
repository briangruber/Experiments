// CPU twin of wakeAt() in src/wake.js / src/gpu/tsl/water-common.js.
//
// The stamp is a thin strip across the whole reach, reset to age 0
// at the snout. Height-only fade left foam and the slick drawing that
// strip as a ruler through the nose. Every channel grows in with age.
// Foam stays on the track; height rides the travelling Kelvin ridge.

export const WAKE_BORN_LO = 0.06;
export const WAKE_BORN_HI = 0.22;

/**
 * Circular buffer fade. The old min(ed.x, ed.y) was a square in world
 * space: a line of constant Z, which is a dead-straight horizontal
 * cut on screen. Twin of the edge term in wakeAt().
 */
export function wakeEdgeCpu( uvx, uvy, edge = 0.22 ) {

	const radial = Math.hypot( uvx - 0.5, uvy - 0.5 ) * 2;
	if ( radial >= 1 ) return 0;
	const lo = 1 - Math.max( edge, 0.18 ) * 1.8;
	return 1 - smoothstep( lo, 1, radial );

}

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function smoothstep( e0, e1, x ) {

	const t = clamp( ( x - e0 ) / ( e1 - e0 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

/**
 * @param {{ stir: number, age: number, lat: number, rate: number }} rec
 * @param {{ life: number, armW: number, spread: number, beam: number,
 *   arm: number, churn: number, depth: number, strength: number }} u
 * @returns {{ foam: number, h: number, z: number }}
 */
/**
 * CPU twin of the stamp window in WAKE_FS / wakeUpdateFragment.
 * Age resets only on the front mound. Far-lat is first touch, then
 * ages so the Kelvin arms can leave the track. A 7.5 m corridor
 * that reset every frame froze those arms as two parallel rails.
 *
 * @returns {'near'|'far'|null}
 */
export function wakeStampKind( { alo, lat, reach, empty, closer } ) {

	const alongW = smoothstep( 1.2, - 0.4, alo ) * smoothstep( - 12.0, - 6.0, alo );
	const inReach = 1 - smoothstep( reach * 0.88, reach, Math.abs( lat ) );
	const nearLat = 1 - smoothstep( 6.0, 9.0, Math.abs( lat ) );
	if ( alongW <= 0.02 || inReach <= 0.02 ) return null;
	if ( nearLat > 0.02 && ( empty || closer ) ) return 'near';
	if ( empty ) return 'far';
	return null;

}

// Analytic Kelvin lives in src/kelvin-wake.js (first-principles gravity
// waves). Re-exported so older imports keep resolving.
export { kelvinWakeAt, KELVIN_TAN, KELVIN_REF_M } from './kelvin-wake.js';

export function wakeAtCpu( rec, u ) {

	const stir = rec.stir;
	const age = rec.age;
	const lat = rec.lat;
	const rate = rec.rate;
	if ( stir < 0.002 || age >= u.life ) return { foam: 0, h: 0, z: 0 };

	const fade = Math.max( 1 - age / u.life, 0 );
	const arm = rate * age;
	const w = Math.max( u.armW * ( 1 + u.spread * age ), 0.05 );
	const q = ( Math.abs( lat ) - arm ) / w;
	const ridge = Math.exp( - q * q );
	const cq = lat / Math.max( u.beam * ( 1 + 0.55 * age ), 0.15 );
	const churnRaw = Math.exp( - cq * cq );
	const churn = churnRaw * Math.max( 1 - age / ( u.life * 0.5 ), 0 );
	const born = smoothstep( WAKE_BORN_LO, WAKE_BORN_HI, age );
	const live = smoothstep( 0, 0.18, stir );
	// Foam stays on the track. Height stays on the travelling ridge.
	const foamW = Math.max( u.armW * ( 1 + 0.28 * age ), 0.05 );
	const trail = Math.exp( - ( lat / foamW ) * ( lat / foamW ) );
	const foam = ( trail * u.arm + churn * u.churn ) * stir * fade * born;
	const h = ridge * fade * live * born * u.depth;
	const z = churnRaw * stir * fade * born;
	return {
		foam: clamp( foam * u.strength, 0, 1 ),
		h,
		z: clamp( z, 0, 1 ),
	};

}
