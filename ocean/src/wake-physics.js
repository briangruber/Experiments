// Gravity-wave numbers for a moving hull, and the occupancy site that
// writes leftover waves.
//
//   Fr = U / √(g L)                 length Froude
//   Fr_h = U / √(g h)               depth Froude
//   λ = 2π U² / g                   transverse wavelength that keeps pace
//   hull speed / wave speed: c = √(g L / 2π)  ⇒  Fr ≈ 0.40 when U = c
//
// The surface itself is not this file. A hull with `wake.physics`
// only displaces water (`hullRippleSite` + RippleField.displaceMove)
// at the posed waterline cuts (`leftoverCutStations`). A heel or
// pitch changes which chines are wet. Leftover lives on a few speed
// bands (short / hull-speed / long) so it is not one wavelength glued
// to c. Long leftover outruns short leftover; that is dispersion, not
// random λ. The following analytic Kelvin field (`wakePhysicsAt`)
// stays for the headless check.
//
// Twin: src/gpu/tsl/wake-physics.js. A change here is not done until
// tools/check-wake-physics.mjs passes.

import {
	kelvinTan, KELVIN_G, KELVIN_TAN, DIVERGE_SIN, DIVERGE_COS, KELVIN_REF_M,
} from './kelvin-wake.js';

export { KELVIN_G, KELVIN_TAN, DIVERGE_SIN, DIVERGE_COS, KELVIN_REF_M, kelvinTan };

const TWO_PI = Math.PI * 2;

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function smoothstep( e0, e1, x ) {

	const t = clamp( ( x - e0 ) / Math.max( e1 - e0, 1e-6 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

/** Fr_L = U / √(g L). */
export function froudeLength( speed, length ) {

	return Math.abs( speed ?? 0 ) / Math.sqrt( KELVIN_G * Math.max( length ?? 12, 0.5 ) );

}

/** Fr_h = U / √(g h). */
export function froudeDepth( speed, depth ) {

	return Math.abs( speed ?? 0 ) / Math.sqrt( KELVIN_G * Math.max( depth ?? 40, 0.2 ) );

}

/**
 * Speed at which one gravity wavelength fits the waterline.
 * U = √(g L / 2π), Fr = 1/√(2π) ≈ 0.399.
 */
export function hullSpeed( length ) {

	return Math.sqrt( KELVIN_G * Math.max( length ?? 12, 0.5 ) / TWO_PI );

}

/** Deep-water wavelength that travels with the ship. */
export function gravityWavelength( speed ) {

	const U = Math.max( Math.abs( speed ?? 0 ), 0.4 );
	return TWO_PI * U * U / KELVIN_G;

}

/** plow | hump | plane */
export function wakeRegime( Fr ) {

	const f = Math.max( Fr ?? 0, 0 );
	if ( f < 0.28 ) return 'plow';
	if ( f < 0.70 ) return 'hump';
	return 'plane';

}

/** 0 at displacement, 1 fully on plane. */
export function planingFraction( Fr ) {

	return smoothstep( 0.55, 1.20, Math.max( Fr ?? 0, 0 ) );

}

/**
 * Wavemaking vs Fr. Quadratic rise through displacement, peak at the
 * hump (Fr ≈ 0.50), then planing relief as the hull lifts out.
 */
export function wavemakingGain( Fr ) {

	const f = Math.max( Fr ?? 0, 0 );
	const rise = smoothstep( 0.05, 0.40, f );
	const hump = Math.exp( - 6.0 * ( f - 0.50 ) * ( f - 0.50 ) );
	const plane = 1.0 - 0.70 * planingFraction( f );
	return ( 0.62 * rise + 0.58 * hump ) * plane;

}

export function draftFraction( Fr ) {

	return 1.0 - 0.72 * planingFraction( Fr );

}

/** Bow-up trim at the hump, radians (~7.5°). */
export const TRIM_HUMP = 0.13;
/** Settled bow-up running trim once on plane, radians (~3°). */
export const TRIM_PLANE = 0.055;
/** Bow-up trim per g of surge. Opening the taps squats the stern. */
export const TRIM_ACCEL = 0.10;

/**
 * Running trim: how far the bow rides up, in radians, purely from what the
 * water is doing to the hull at this Froude number. Positive is bow up.
 *
 * Three regimes, one curve:
 *   - Displacement (Fr < ~0.3) sits on its lines. There is no wave to climb
 *     and no dynamic lift, so the boat stays level.
 *   - The hump (Fr ≈ 0.5) is the worst of it. The hull is trying to climb
 *     over its own bow wave and squatting into the trough behind it, so the
 *     bow points at the sky — this is the plowing attitude, maximum trim and
 *     maximum wake for the least speed.
 *   - On plane (Fr > 1) the hull rides on top of the water instead of
 *     through it. The bow drops back to a few degrees, and eases further as
 *     speed shortens the wetted length.
 */
export function hullRunningTrim( Fr, opts = {} ) {

	const f = Math.max( Fr ?? 0, 0 );
	const humpTrim = opts.hump ?? TRIM_HUMP;
	const planeTrim = opts.plane ?? TRIM_PLANE;
	// A crawl has no bow wave worth climbing.
	const awake = smoothstep( 0.12, 0.38, f );
	const dF = f - 0.55;
	const hump = Math.exp( - 8.0 * dF * dF );
	const settle = planingFraction( f ) / ( 1 + 0.35 * Math.max( f - 1.2, 0 ) );
	return awake * humpTrim * hump + planeTrim * settle;

}

/**
 * Extra trim from surge. Thrust squats the stern and lifts the bow; coming
 * off the throttle drops it again. `accel` is m/s² along the heading.
 */
export function hullTrimFromAccel( accel, opts = {} ) {

	const gain = opts.gain ?? TRIM_ACCEL;
	return clamp( ( accel ?? 0 ) / KELVIN_G, - 0.6, 0.6 ) * gain;

}

export function shallowResonance( Fr_h, depth ) {

	if ( ! ( depth < 30 ) ) return 1;
	const dFr = ( Fr_h ?? 0 ) - 1;
	const resonance = 0.60 / ( 1 + 8 * dFr * dFr );
	return 1 + resonance * clamp( ( 30 - depth ) / 25, 0, 1 );

}

/**
 * Metres of surface displacement at full strength for this hull / speed.
 */
export function wakePhysicsAmp( u ) {

	const U = Math.abs( u?.speed ?? 0 );
	const L = Math.max( u?.length ?? 12, 0.8 );
	const depth = u?.depth ?? 40;
	const Fr = froudeLength( U, L );
	const cap = Math.min( 0.11 * L, 2.0 );
	return ( u?.amp ?? 1 ) * cap
		* wavemakingGain( Fr )
		* draftFraction( Fr )
		* shallowResonance( froudeDepth( U, depth ), depth );

}

export function wakePhysicsInfo( u ) {

	const U = Math.abs( u?.speed ?? 0 );
	const L = Math.max( u?.length ?? 12, 0.8 );
	const Fr = froudeLength( U, L );
	return {
		speed: U,
		length: L,
		Fr,
		Frh: froudeDepth( U, u?.depth ?? 40 ),
		lambda: gravityWavelength( U ),
		hullSpeed: hullSpeed( L ),
		regime: wakeRegime( Fr ),
		planing: planingFraction( Fr ),
		amp: wakePhysicsAmp( u ),
	};

}

/**
 * Signed height (m) and a little crest foam at world XZ `p`.
 *
 * `u.head` is the bow, `u.fwd` is the unit heading on XZ, `along` is
 * metres aft of the bow.
 *
 * @param {{ x: number, z: number }} p
 * @param {{ head: number[], fwd: number[], speed: number, length: number,
 *   beam?: number, depth?: number, amp?: number, decay?: number,
 *   yaw?: number, strength?: number }} u
 */
export function wakePhysicsAt( p, u ) {

	const strength = u.strength ?? 1;
	const U = Math.abs( u.speed ?? 0 );
	if ( U <= 0.55 || strength <= 0.001 || ( u.amp ?? 1 ) <= 0 ) {

		return { h: 0, foam: 0 };

	}

	const L = Math.max( u.length ?? 12, 0.8 );
	const beam = Math.max( u.beam ?? L * 0.22, 0.35 );
	const depth = u.depth ?? 40;
	const A0 = wakePhysicsAmp( { ...u, speed: U, length: L, depth } ) * strength;
	if ( A0 <= 0.001 ) return { h: 0, foam: 0 };

	const relX = p.x - u.head[ 0 ];
	const relZ = p.z - u.head[ 1 ];
	const along = - ( relX * u.fwd[ 0 ] + relZ * u.fwd[ 1 ] );
	const lat = relX * ( - u.fwd[ 1 ] ) + relZ * u.fwd[ 0 ];

	const lambda = Math.max( gravityWavelength( U ), 0.8 );
	const k0 = TWO_PI / lambda;
	const tanW = kelvinTan( U, L, depth );
	const yaw = clamp( Math.abs( u.yaw ?? 0 ) * L / Math.max( U, 1 ), 0, 1 );
	const A = A0 * ( 1 + 0.28 * yaw );

	const sig = Math.max( beam * 0.55, 0.35 );
	const latEnv = Math.exp( - ( lat * lat ) / ( sig * sig ) );
	const boundEnv = smoothstep( - 0.18 * L, 0.04 * L, along )
		* ( 1 - smoothstep( L * 0.82, L * 1.28, along ) )
		* latEnv;
	const phase = TWO_PI * along / lambda;
	let h = A * 0.92 * Math.cos( phase ) * boundEnv;

	const nose = along + 0.08 * L;
	const noseW = 0.14 * L;
	h += A * 0.28 * Math.exp( - ( nose * nose ) / ( noseW * noseW ) ) * latEnv;

	if ( along > 0.2 * L ) {

		const alo = along;
		const absLat = Math.abs( lat );
		const r = Math.hypot( alo, lat );
		const decay = Math.max( u.decay ?? Math.max( 80, 4 * L ), 24 );
		const spread = Math.sqrt( KELVIN_REF_M / Math.max( r, KELVIN_REF_M ) )
			* Math.exp( - r / decay );
		const born = smoothstep( L * 0.28, L * 0.72, alo );
		const arm = beam * 0.5 + alo * tanW;
		const face = Math.max( 1.4, 0.20 * Math.sqrt( lambda * r ) );
		const dArm = absLat - arm;
		const envArm = Math.exp( - ( dArm * dArm ) / ( face * face ) );
		const outside = Math.max( 0, dArm );
		const evanescent = Math.exp( - ( outside * outside ) / ( face * face * 0.35 ) );
		const inside = 1 - smoothstep( arm * 0.12, arm + face * 0.55, absLat );

		let free = 0;
		for ( const n of [ 1, 2, 3 ] ) {

			const kn = k0 * n;
			const phaseDiv = ( 1.5 * kn ) * ( alo * DIVERGE_COS + absLat * DIVERGE_SIN );
			const vis = n === 1 ? 1 : ( n === 2 ? 0.42 : 0.18 );
			free += vis * (
				envArm * evanescent * Math.cos( phaseDiv )
				+ inside * 0.34 * Math.cos( kn * alo )
			);

		}

		h += A * 0.70 * spread * born * free;

	}

	return { h, foam: clamp( Math.max( 0, h ) * 0.18, 0, 0.55 ) };

}

/**
 * Phase speed of the hull-speed gravity wave: c = √(g L / 2π).
 * A source slower than c radiates circles; faster, a leftover Mach V.
 */
export function gravityWaveSpeed( length ) {

	return hullSpeed( length );

}

/**
 * Leftover spectrum. One wave-equation tile cannot disperse (one c).
 * Three bands at k·c is the cheap lie that still lets long leftover
 * outrun short leftover. Weights sum to 1.
 */
export const LEFTOVER_BANDS = [
	{ k: 0.62, w: 0.30, damping: 0.11 },
	{ k: 1.00, w: 0.42, damping: 0.040 },
	{ k: 1.58, w: 0.28, damping: 0.016 },
];
/**
 * Physics leftover tile. 256² × 1.25 m is still a 320 m window — the
 * older 384² × 1.05 m field was the same water with 2.25× the CPU.
 */
export const LEFTOVER_TILE = {
	size: 256, cell: 1.25, sponge: 22, displaceCap: 1.4, displace: 0.30,
};
/** Honest leftover never needs more than this. A taller spike is a bug. */
export const LEFTOVER_HEIGHT_CAP = 1.45;
/** Below this (m/s) bow/motor leftover is off — a crawl is not a jet. */
export const LEFTOVER_SPLASH_MIN_SPEED = 1.5;
/** Bow/motor leftover height is authored at this rate, then scaled by dt. */
export const LEFTOVER_BOIL_FPS = 60;

/**
 * Per-frame leftover jet height. `amount` is the 60 Hz impulse so a
 * 10 fps idle tab cannot dump six frames of boil into one cell.
 */
export function leftoverSplashHeight( amount, dt ) {

	if ( ! ( amount > 0 ) ) return 0;
	const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
	return amount * d * LEFTOVER_BOIL_FPS;

}

/**
 * Bow leftover heap radius. The leftover tile is 1.25 m/cell: a
 * splash at `max(radius, cell)` that is only one cell tall is a
 * vertex pyramid. Two cells is enough to round it — a 3 m cosine
 * plus side blobs stood the hull on a travelling pedestal.
 */
/**
 * Motor leftover is a sausage along the sailing line. A circular
 * `splash()` is a raindrop: the wave equation radiates rings that
 * punch doughnuts through the foam ribbon.
 */
export function leftoverJetSplashSpan( beam, width = 0.16, jump = 0 ) {

	const across = Math.max( ( beam ?? 2 ) * Math.max( width ?? 0.16, 0.08 ), 0.18 );
	const along = Math.max( across * 2.8, Math.abs( jump ) * 0.55 + across * 1.15, 1.4 );
	return { across, along };

}

export function leftoverBowSplashRadius( beam, cell = LEFTOVER_TILE.cell ) {

	return Math.max( Math.max( beam ?? 0, 0.6 ) * 0.28, cell * 1.68, 1.70 );

}

/**
 * How hard the cutwater writes leftover height this frame.
 * Foam still gates “is there an entry boil”; planing eases the
 * heap so a fast hull does not plow a 1.45 m hill.
 */
export function leftoverBowSplashGain( foamAmt, churnK, bandW, Fr ) {

	const plane = planingFraction( Fr );
	return Math.max( foamAmt ?? 0, 0 ) * Math.max( churnK ?? 0, 0 )
		* Math.max( bandW ?? 0, 0 ) * 0.20 * ( 1 - 0.65 * plane );

}

function hash01( n ) {

	const x = Math.sin( n * 127.1 ) * 43758.5453;
	return x - Math.floor( x );

}

/**
 * Slight spatial irregularity on the occupancy, per band. Not a random
 * wavelength — just so every emit is not the same cut. Keep the
 * scale tight so jitter cannot reopen a wide cradle.
 */
export function leftoverBandSite( site, bandIndex = 0 ) {

	if ( ! site ) return null;
	const u = hash01( Math.round( site.x * 2 ) * 13.7 + Math.round( site.z * 2 ) * 7.3 + bandIndex * 31.1 );
	const s = 0.96 + 0.08 * u;
	return {
		...site,
		half: site.half * s,
		r: site.r * s,
	};

}

/**
 * Pierce-shaped occupancy for RippleField.displaceMove — the hull
 * pushes water aside; the wave equation carries what it left.
 */
export function hullRippleSite( body ) {

	if ( ! body ) return null;
	const L = Math.max( body.length ?? body.size?.z ?? 12, 0.8 );
	const beam = Math.max( body.size?.x ?? body.beam ?? 2, 0.4 );
	const heading = body.heading ?? 0;
	const xz = body.controller?.surfXZ
		? body.controller.surfXZ()
		: ( typeof body.surfXZ === 'function' ? body.surfXZ() : [ body.pos[ 0 ], body.pos[ 2 ] ] );
	const Fr = froudeLength( body.speed ?? 0, L );
	const r = Math.max( beam * 0.38, 0.22 );
	const half = Math.max( L * 0.5 - r, L * 0.22 );
	return {
		x: xz[ 0 ],
		z: xz[ 1 ],
		ax: Math.sin( heading ),
		az: - Math.cos( heading ),
		half,
		r,
		// Soft edge on the beam, not on pierceScale(half) — that was the
		// wide oval around a moving box.
		soft: Math.max( r * 0.22, 0.35 ),
		tight: 1,
		// Metres actually in the water. Fr draft is only a fallback
		// when the hull has no pose — leftover size follows the cut.
		submerged: leftoverHullDraft( body, Fr ),
	};

}

/**
 * World XZ for RippleField.recentreOn so most of the tile sits aft of
 * the hull. Centering on the boat clips the Kelvin V at ~halfExtent;
 * biasing aft lets divergent arms keep opening before the sponge.
 *
 * @param {{ x:number, z:number, ax?:number, az?:number }} site
 * @param {number} halfExtent metres from tile centre to edge
 * @param {number} [bias=0.38] fraction of halfExtent to shift aft
 */
export function leftoverTileOrigin( site, halfExtent, bias = 0.38 ) {

	const aft = Math.max( halfExtent ?? 0, 1 ) * Math.min( Math.max( bias, 0 ), 0.45 );
	const ax = site?.ax ?? 0;
	const az = site?.az ?? - 1;
	return {
		x: ( site?.x ?? 0 ) - ax * aft,
		z: ( site?.z ?? 0 ) - az * aft,
	};

}

/**
 * How deep the hull sits, metres. Prefer the posed keel vs the sea;
 * Fr draft is the no-pose guess (planing eases that guess).
 */
export function leftoverHullDraft( body, Fr = null ) {

	const sizeY = Math.max( body?.size?.y ?? 1, 0.35 );
	const posY = body?.pos?.[ 1 ];
	const sea = body?.surf ?? 0;
	if ( Number.isFinite( posY ) ) {

		const keel = posY - sizeY * 0.5;
		return clamp( sea - keel, 0, sizeY );

	}
	const f = Fr ?? froudeLength( body?.speed ?? 0, body?.length ?? body?.size?.z ?? 12 );
	return sizeY * 0.45 * Math.max( 0.35, draftFraction( f ) );

}

/**
 * How hard the hull is hitting the sea this frame. Landing impact,
 * dropping onto a face, or punching (fwdAccel) — not leftover heave,
 * which would feed back into itself.
 */
export function leftoverSlam( body ) {

	if ( ! body ) return 0;
	const land = clamp( ( body.impact ?? 0 ) * 2.4, 0, 1.5 );
	const vy = body.vel?.[ 1 ] ?? 0;
	const drop = body.airborne ? 0 : clamp( ( - vy ) / 4.5, 0, 1 );
	const punch = clamp( Math.max( 0, body.fwdAccel ?? 0 ) / 7, 0, 0.85 );
	return Math.min( 1.7, land + drop * 0.6 + punch );

}

/**
 * −1 stern … +1 bow. A hull makes waves at the entry and the transom,
 * not a uniform tube of leftover.
 */
export function leftoverStationWeight( alongNorm ) {

	const a = clamp( alongNorm, - 1, 1 );
	const bow = smoothstep( 0.18, 0.88, a );
	const stern = smoothstep( 0.18, 0.88, - a );
	return clamp( 0.12 + 0.88 * bow + 0.46 * stern, 0, 1.35 );

}

/** Twin of TSL `wakePhysicsGeometryMaskAt`. 1 hides leftover under the mesh. */
export const WAKE_PHYS_MASK_SIDE0 = 0.50;
export const WAKE_PHYS_MASK_SIDE1 = 1.10;
/** Metres astern the mask lets leftover through — not a beam-radius cap. */
export const WAKE_PHYS_MASK_AFT0 = 0.12;
export const WAKE_PHYS_MASK_AFT1 = 0.95;

/**
 * `along` is metres from the bow (0 at the cutwater, `length` at the
 * transom), `lat` metres to starboard. Sides still use a beam-scaled
 * stadium so leftover cannot stand the deck up. Aft of the transom the
 * fade is ~1 m so a turn does not leave a dark hole behind the stern.
 */
export function wakePhysicsGeometryMask( along, lat, length, beam ) {

	const L = Math.max( length ?? 0, 0.8 );
	const B = Math.max( beam ?? 0, 0.35 );
	const nearest = clamp( along, 0, L );
	const d = Math.hypot( along - nearest, lat ?? 0 );
	const aft = along > L;
	const r0 = aft ? WAKE_PHYS_MASK_AFT0 : B * WAKE_PHYS_MASK_SIDE0;
	const r1 = aft ? WAKE_PHYS_MASK_AFT1 : B * WAKE_PHYS_MASK_SIDE1;
	return 1 - smoothstep( r0, r1, d );

}

/**
 * Object-term gain from how fast the hull is going. Swept water
 * grows with U, dynamic pressure with (U/c)². Planing does not
 * mute this — coming out of the water does (per-station draft).
 */
export function rippleDisplaceGain( cfg, body ) {

	const speed = Math.abs( body?.speed ?? 0 );
	if ( speed < 0.55 ) return 0;
	const L = Math.max( body?.length ?? body?.size?.z ?? 12, 0.8 );
	const Fr = froudeLength( speed, L );
	const c = hullSpeed( L );
	const uc = speed / Math.max( c, 0.01 );
	const rise = smoothstep( 0.05, 0.32, Fr );
	const sweep = Math.min( uc, 1.65 );
	const pressure = 0.28 + 0.72 * Math.min( uc * uc, 1.85 );
	return ( cfg?.strength ?? 1 ) * 0.22 * rise * sweep * pressure;

}

/**
 * Same craft frame as ocean-body craftBasis — kept here so this file
 * does not import ocean-body (that import is the other way).
 * Local +X starboard, +Y up, +Z aft.
 */
function leftoverFrame( body ) {

	const yaw = body?.heading ?? 0;
	const pitch = body?.pitch ?? 0;
	const roll = body?.roll ?? 0;
	const cy = Math.cos( yaw ), sy = Math.sin( yaw );
	const cp = Math.cos( pitch ), sp = Math.sin( pitch );
	const cr = Math.cos( roll ), sr = Math.sin( roll );
	const f = [ cp * sy, sp, - cp * cy ];
	const r = [ cy, 0, sy ];
	let u = [
		f[ 1 ] * r[ 2 ] - f[ 2 ] * r[ 1 ],
		f[ 2 ] * r[ 0 ] - f[ 0 ] * r[ 2 ],
		f[ 0 ] * r[ 1 ] - f[ 1 ] * r[ 0 ],
	];
	u = [ - u[ 0 ], - u[ 1 ], - u[ 2 ] ];
	return {
		right: r.map( ( v, i ) => v * cr + u[ i ] * sr ),
		up: u.map( ( v, i ) => v * cr - r[ i ] * sr ),
		back: [ - f[ 0 ], - f[ 1 ], - f[ 2 ] ],
	};

}

/** Sea at a hull station: bilinear from the four AABB probe heights. */
function leftoverStationSea( body, along, across, fallback ) {

	const h = body?.samples?.h;
	if ( ! ( body?.probeLayout === 'corners' && h && h.length >= 4 ) ) return fallback;
	const live = h.slice( 0, 4 );
	if ( ! live.every( Number.isFinite ) ) return fallback;
	if ( ! body._probePrimed && ! live.some( ( v ) => Math.abs( v ) > 1e-4 ) ) return fallback;
	const a = ( 1 - along ) * 0.5;
	const c = ( across + 1 ) * 0.5;
	const bow = h[ 0 ] * ( 1 - c ) + h[ 1 ] * c;
	const stern = h[ 2 ] * ( 1 - c ) + h[ 3 ] * c;
	return bow * ( 1 - a ) + stern * a;

}

/**
 * Waterline cuts on the posed AABB keel ring. A heel or pitch changes
 * which stations are wet — leftover only writes where the mesh cuts.
 */
export function leftoverCutStations( body, opts = {} ) {

	if ( ! body ) return [];
	const size = body.size ?? {};
	const L = Math.max( size.z ?? body.length ?? 8, 0.8 ) * 0.5;
	// Mesh AABB, not `body.beam` — that is the SKI / wake recipe and can
	// be a metre slimmer than the box (the bench spreads SKI at 1.1 m
	// onto a 3.4 m hull, which parked every cut in the middle of the face).
	const B = Math.max( size.x ?? body.beam ?? 2, 0.4 ) * 0.5;
	const Y = - Math.max( size.y ?? 1, 0.35 ) * 0.5;
	const draft = Math.max( ( size.y ?? 1 ) * 0.45, 0.16 );
	const pos = body.pos ?? [ 0, 0, 0 ];
	// FFT/ripple fields are indexed by the undisplaced reference coordinate.
	// A caller writing those fields passes the inverted hull centre here;
	// particle/debug callers can omit it and keep literal world XZ.
	const fieldXZ = opts.xz ?? [ pos[ 0 ], pos[ 2 ] ];
	const sea0 = opts.seaLevel ?? body.surf ?? 0;
	const { right, up, back } = leftoverFrame( body );
	const cfg = body.wakeConfig?.() ?? body.wake;
	const base = rippleDisplaceGain( cfg, body );
	const slam = leftoverSlam( body );
	const pitchRate = body.pitchRate ?? 0;
	const rollRate = body.rollRate ?? 0;
	const uc = Math.abs( body.speed ?? 0 ) / Math.max( hullSpeed( L * 2 ), 0.01 );
	const pace = clamp( 0.32 + 0.42 * Math.min( uc, 1.8 ), 0, 1 );
	const locals = [];
	const waterline = L * 2;
	const nAlong = Math.max( 3, Math.min( 7, Math.round( waterline / 1.8 ) ) );
	for ( let i = 0; i < nAlong; i ++ ) {

		const along = 1 - 2 * ( i / ( nAlong - 1 ) );
		const lz = - along * L;
		locals.push( { lx: - B, ly: Y, lz, along, across: - 1, role: 'port' } );
		locals.push( { lx: B, ly: Y, lz, along, across: 1, role: 'starboard' } );

	}
	locals.push( { lx: 0, ly: Y, lz: - L, along: 1, across: 0, role: 'bow' } );
	locals.push( { lx: 0, ly: Y, lz: L, along: - 1, across: 0, role: 'stern' } );
	const nAcross = Math.max( 3, Math.min( 5, Math.round( ( B * 2 ) / 0.85 ) ) );
	for ( let j = 1; j < nAcross - 1; j ++ ) {

		const across = - 1 + 2 * ( j / ( nAcross - 1 ) );
		if ( Math.abs( across ) < 0.05 ) continue;
		locals.push( { lx: across * B, ly: Y, lz: - L, along: 1, across, role: 'bow' } );
		locals.push( { lx: across * B, ly: Y, lz: L, along: - 1, across, role: 'stern' } );

	}

	const mapped = locals.map( ( loc ) => {

		const x = fieldXZ[ 0 ] + right[ 0 ] * loc.lx + up[ 0 ] * loc.ly + back[ 0 ] * loc.lz;
		const y = pos[ 1 ] + right[ 1 ] * loc.lx + up[ 1 ] * loc.ly + back[ 1 ] * loc.lz;
		const z = fieldXZ[ 1 ] + right[ 2 ] * loc.lx + up[ 2 ] * loc.ly + back[ 2 ] * loc.lz;
		const sea = leftoverStationSea( body, loc.along, loc.across, sea0 );
		const immersion = sea - y;
		const draftM = Math.max( 0, immersion );
		const wet = clamp( draftM / draft, 0, 1.35 );
		const cutting = wet > 0.05;
		const slamY = - ( pitchRate * loc.along * L + rollRate * loc.across * B );
		const close = clamp( slamY / 3.5, 0, 1 );
		const hit = 1 + slam * ( 0.22 + 0.78 * smoothstep( 0.15, 0.85, loc.along ) )
			+ 0.55 * close;
		// Cut volume: a kissing station is a sliver, a buried chine is a wall.
		const cut = clamp( draftM / 0.42, 0, 2.2 );
		const w = leftoverStationWeight( loc.along ) * cut * hit;
		const gain = cutting && base > 0 ? Math.min( base * w, 0.85 ) : 0;
		const strength = cutting && base > 0 ? clamp( w * pace * 0.38, 0, 1 ) : 0;
		return {
			...loc, x, y: sea, z, keelY: y, sea, immersion, wet, draftM,
			gain, strength, live: strength > 0.04,
		};

	} );
	// Cap is wake.emit / wake.emitMax / opts.emitMax. opts.emit is the
	// debug overlay flag (`debug: { emit: 1 }`) — not a one-point wake.
	return leftoverCapStations( mapped, leftoverEmitMax( cfg )
		?? leftoverEmitMax( { emitMax: opts.emitMax } ) );

}

/**
 * Live leftover write cap. Omitted / null = every waterline cut.
 * `0` writes nothing. `1+` is that many stations.
 * Debug overlay is `debug: { emit: 1 }`, not this knob.
 */
export function leftoverEmitMax( cfg ) {

	const raw = cfg?.emitMax ?? cfg?.emit;
	if ( raw == null || raw === false ) return null;
	const n = Number( raw );
	if ( ! Number.isFinite( n ) ) return null;
	return Math.round( clamp( n, 0, 48 ) );

}

/** Thin a cut list to `cap` while keeping bow, stern, and both chines. */
export function leftoverCapStations( cuts, cap ) {

	if ( cap == null || cap < 0 ) return cuts ?? [];
	const n = Math.round( cap );
	if ( n === 0 ) return [];
	if ( ! cuts?.length || cuts.length <= n ) return cuts ?? [];
	const picked = [];
	const used = new Set();
	const take = ( c ) => {

		if ( ! c || used.has( c ) || picked.length >= n ) return;
		used.add( c );
		picked.push( c );

	};
	take( cuts.find( ( c ) => c.role === 'bow' && Math.abs( c.across ) < 0.05 ) );
	take( cuts.find( ( c ) => c.role === 'stern' && Math.abs( c.across ) < 0.05 ) );
	const port = cuts.filter( ( c ) => c.role === 'port' );
	const stbd = cuts.filter( ( c ) => c.role === 'starboard' );
	take( port[ Math.floor( port.length / 2 ) ] );
	take( stbd[ Math.floor( stbd.length / 2 ) ] );
	const rest = cuts.filter( ( c ) => ! used.has( c ) );
	const need = n - picked.length;
	if ( need <= 0 ) return picked;
	if ( rest.length <= need ) return picked.concat( rest );
	for ( let i = 0; i < need; i ++ ) {

		const t = need === 1 ? 0 : i / ( need - 1 );
		take( rest[ Math.round( t * ( rest.length - 1 ) ) ] );

	}
	return picked;

}

/**
 * Per-cut leftover occupancy size. Side cuts stay tight on the
 * chines. The bow cut is the heap in front of the hull — a 0.4 m
 * tight stamp on a 1.25 m tile is one cell, so the sea mesh
 * stands up as a pyramid.
 */
export function leftoverWriteFootprint( hull, cut ) {

	const wet = clamp( cut?.wet ?? 0, 0, 1.35 );
	const cell = LEFTOVER_TILE.cell;
	if ( cut?.role === 'bow' ) {

		return {
			half: Math.max( ( hull?.half ?? 1 ) * 0.10, 0.22 ),
			r: Math.max( ( hull?.r ?? 0.4 ) * 0.55, cell * 1.35, 1.15 ),
			soft: Math.max( hull?.soft ?? 0, cell * 0.7, 0.45 ),
			tight: 0,
		};

	}
	return {
		half: Math.max( ( hull?.half ?? 1 ) * 0.07 * ( 0.50 + 0.50 * wet ), 0.12 ),
		r: Math.max( ( hull?.r ?? 0.4 ) * ( 0.14 + 0.22 * wet ), 0.10 ),
		soft: hull?.soft,
		tight: 1,
	};

}

/** Occupancy blobs at the live waterline cuts. */
export function leftoverWriteSites( body, opts = {} ) {

	const hull = hullRippleSite( body );
	if ( ! hull ) return [];
	const cuts = opts.cuts ?? leftoverCutStations( body, opts );
	return cuts.map( ( cut ) => {

		const foot = leftoverWriteFootprint( hull, cut );
		return {
			...hull,
			x: cut.x,
			z: cut.z,
			...foot,
			gain: cut.gain,
			role: cut.role,
			along: cut.along,
			across: cut.across,
			submerged: clamp( cut.draftM ?? hull.submerged, 0.03, 1.2 ),
		};

	} );

}

/** 0 parked / dry … 1 a slamming wet bow. */
export function leftoverEmitStrength( body, alongNorm, across = 0 ) {

	const cuts = leftoverCutStations( body );
	if ( ! cuts.length ) return 0;
	let best = 0, bestD = 1e9;
	for ( const c of cuts ) {

		const d = Math.abs( c.along - alongNorm ) + Math.abs( ( c.across ?? 0 ) - across ) * 0.35;
		if ( d < bestD ) { bestD = d; best = c.strength; }

	}
	return best;

}

/** Debug dots: the same waterline cuts leftover writes. */
export function leftoverEmitPoints( body, opts = {} ) {

	return leftoverCutStations( body, opts ).map( ( c ) => ( {
		kind: 'emit',
		role: c.role,
		along: c.along,
		across: c.across,
		strength: c.strength,
		live: c.live,
		x: c.x, y: c.y, z: c.z,
	} ) );

}

/**
 * Horizontal shove from leftover slope under the hull. A face from
 * astern (stern high, bow low) accelerates; a bow face brakes.
 * Couple is modest — leftover should bias speed a bit, never yank.
 * At plane speed the hull's own bow/motor boil would otherwise flip
 * slope every frame and read as fore-aft teleport; fade with |U|.
 *
 * @param {number[]} h leftover heights at the probe layout
 * @param {number} along half-length probe span (m)
 * @param {number} across half-beam probe span (m)
 * @param {string} [layout]
 * @param {number} [speed] hull speed along heading (m/s)
 */
export function leftoverSurge( h, along, across, layout = 'cross', speed = 0 ) {

	if ( ! h ) return { along: 0, across: 0 };
	const L = Math.max( along, 0.4 );
	const W = Math.max( across, 0.2 );
	let slopeA = 0, slopeC = 0;
	if ( layout === 'corners' && h.length >= 4 ) {

		const bow = 0.5 * ( h[ 0 ] + h[ 1 ] );
		const stern = 0.5 * ( h[ 2 ] + h[ 3 ] );
		const port = 0.5 * ( h[ 0 ] + h[ 2 ] );
		const stbd = 0.5 * ( h[ 1 ] + h[ 3 ] );
		slopeA = ( bow - stern ) / ( 2 * L );
		slopeC = ( stbd - port ) / ( 2 * W );

	} else if ( h.length >= 5 ) {

		slopeA = ( h[ 1 ] - h[ 2 ] ) / ( 2 * L );
		slopeC = ( h[ 4 ] - h[ 3 ] ) / ( 2 * W );

	} else {

		return { along: 0, across: 0 };

	}
	// Own boil is steeper than a real swell face — keep the shove gentle.
	slopeA = Math.max( - 0.22, Math.min( 0.22, slopeA ) );
	slopeC = Math.max( - 0.22, Math.min( 0.22, slopeC ) );
	const u = Math.abs( speed );
	const couple = 0.48 / ( 1 + ( u / 7 ) * ( u / 7 ) );
	return {
		along: - KELVIN_G * slopeA * couple,
		across: - KELVIN_G * slopeC * couple,
	};

}

/**
 * White churn on leftover crests. Same numbers as the TSL film in
 * water-surface.js. `uRippleFoam` is wave-influence × foam ribbon — 0
 * of either keeps leftover height as water, not a detached white V.
 */
export function leftoverChurn( h, steep = 0 ) {

	const crest = Math.max( h, 0 );
	const s = Math.max( steep, 0 );
	return clamp(
		smoothstep( 0.008, 0.10, crest ) * 0.72
		+ smoothstep( 0.045, 0.26, s ) * 0.40,
		0, 0.90,
	);

}
