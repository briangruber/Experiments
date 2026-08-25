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

function fract( x ) {

	return x - Math.floor( x );

}

function wakeHash( x, z ) {

	return fract( Math.sin( x * 12.9898 + z * 78.233 ) * 43758.5453 );

}

export function wakeAtCpu( rec, u ) {

	const stir = rec.stir;
	const age = rec.age;
	const lat = rec.lat;
	const rate = rec.rate;
	if ( stir < 0.002 || age >= u.life ) return { foam: 0, h: 0, z: 0 };

	const fade = Math.max( 1 - age / u.life, 0 );
	const width0 = u.width0 ?? 0;
	const width1 = u.width1 ?? 0;
	const arms = u.arms ?? 2;
	const trailGain = u.trail ?? 1;
	const arm = width0 + rate * age;
	const w = Math.max( u.armW * ( 1 + u.spread * age ), 0.05 );
	const q = ( Math.abs( lat ) - arm ) / w;
	const ridge = arms > 0.5 ? Math.exp( - q * q ) : 0;
	const tAge = clamp( age / Math.max( u.life, 0.001 ), 0, 1 );
	const beamW = width1 > 0.01
		? Math.max( width0, 0.15 ) + ( width1 - Math.max( width0, 0.15 ) ) * tAge
		: Math.max( u.beam * ( 1 + 0.55 * age ), 0.15 );
	const cq = lat / beamW;
	const churnRaw = Math.exp( - cq * cq );
	const born = smoothstep( WAKE_BORN_LO, WAKE_BORN_HI, age );
	const live = smoothstep( 0, 0.18, stir );
	const photo = width0 > 0.05 ? 1 : 0;
	const foamBorn = photo ? smoothstep( 0, 0.1, age ) : born;
	const foamW = Math.max( u.armW * ( photo ? 0.42 : ( 1 + 0.28 * age ) ), 0.08 );
	const trail = Math.exp( - ( lat / foamW ) * ( lat / foamW ) );
	let parked = 0;
	if ( width0 > 0.05 && arms > 0.5 ) {

		const pq = ( Math.abs( lat ) - width0 ) / Math.max( u.armW, 0.05 );
		parked = Math.exp( - pq * pq );

	}

	const boilLife = u.life * ( photo ? 0.26 : 0.5 );
	const boil = churnRaw * Math.max( 1 - age / Math.max( boilLife, 0.12 ), 0 );
	const armFoam = photo * ridge * u.arm;
	const histFoam = trail * u.arm * trailGain + boil * u.churn * trailGain
		+ parked * u.arm + armFoam;
	const photoFoam = ridge * u.arm + boil * u.churn * trailGain;
	let foam = ( photo ? photoFoam : histFoam ) * stir * fade * foamBorn;
	const px = rec.x ?? 0;
	const pz = rec.z ?? 0;
	const n = wakeHash( px, pz );
	foam *= 1 + ( n - 0.5 ) * ( u.turb ?? 0 ) * ( photo ? 0.45 : 1.4 );
	const osc = photo ? 0.72 + 0.28 * Math.cos( age * 4.4 ) : 1;
	const trough = photo ? - churnRaw * ( 1 - ridge ) * ( u.cut ?? 0.55 ) : 0;
	let h = ( ridge * osc + trough ) * fade * live * born * u.depth;
	const bowAmp = u.bowAmp ?? 0;
	if ( bowAmp > 0.001 ) {

		const bx = ( rec.x ?? 0 ) - ( u.bowX ?? 0 );
		const bz = ( rec.z ?? 0 ) - ( u.bowZ ?? 0 );
		const hx = u.fwdX ?? 0;
		const hz = u.fwdZ ?? 1;
		const blo = bx * hx + bz * hz;
		const bla = bx * ( - hz ) + bz * hx;
		const brh = Math.max( u.bowR ?? 0.2, 0.08 );
		const bq = bla / ( brh * 0.45 );
		const bAlong = blo / brh;
		const bowMask = Math.exp( - bq * bq ) * Math.exp( - bAlong * bAlong );
		foam += bowAmp * bowMask;
		h += bowAmp * bowMask * u.depth * 0.85;

	}

	const z = churnRaw * stir * fade * born;
	return {
		foam: clamp( foam * u.strength, 0, 1 ),
		h,
		z: clamp( z, 0, 1 ),
	};

}
