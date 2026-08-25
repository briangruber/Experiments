// Leftover whitewater. Pixel Lab / Phoenix split: airborne splash and
// surface foam as particles. The ocean stays a displaced plane — leftover
// is height. Foam is born when splash hits the sea (foam-on-hit), then
// rides leftover. Not a painted film, not leftoverChurn, not rising
// under-hull discs.
//
// A change here is not done until tools/check-leftover-bubbles.mjs passes.

import { KELVIN_TAN } from './kelvin-wake.js';

export const LEFTOVER_BUBBLE_POOL = 2048;
export const LEFTOVER_BUBBLE_MAX = 512;
export const LEFTOVER_BUBBLE_AMOUNT = 1;
export const LEFTOVER_BUBBLE_LIFE = 5.2;
export const LEFTOVER_BUBBLE_SIZE = 0.05;
export const LEFTOVER_SPLASH_AMOUNT = 1;
export const LEFTOVER_SPLASH_LIFE = 0.9;
export const LEFTOVER_SPLASH_SIZE = 0.034;
export const LEFTOVER_FOAM_RATE = 6;
export const LEFTOVER_SPLASH_RATE = 20;
export const LEFTOVER_SPLASH_G = 9.81;
export const LEFTOVER_BIRTH_CAP = 24;
export const LEFTOVER_RIDE_HOLD = 0.04;
/**
 * Optional birth-frame Kelvin peel. Off by default so whitewater specks remain
 * on the sailed path instead of receiving metres per second of sideways kick.
 */
export const LEFTOVER_BUBBLE_DIVERGE = 0;
/**
 * Ceiling on that peel, m/s. Above hull speed the Mach rate is `tanθ × U`,
 * which at planing speed is metres per second of pure sideways drift. Left
 * uncapped it threw every speck clear of the hull within a second, so the
 * trail read as two rails of foam with open water against the topsides.
 */
export const LEFTOVER_BUBBLE_PEEL_MAX = 2.2;
/** Seconds of travel bounding the one-shot birth-frame peel helper. */
export const LEFTOVER_BUBBLE_PEEL_MEMORY = 0.5;

const clamp = ( x, a, b ) => Math.min( b, Math.max( a, x ) );
const smoothstep = ( e0, e1, x ) => {

	const t = clamp( ( x - e0 ) / Math.max( e1 - e0, 1e-6 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

};

function hash01( n ) {

	const x = Math.sin( n * 127.1 + 311.7 ) * 43758.5453123;
	return x - Math.floor( x );

}

function hullAxes( hull ) {

	if ( hull?.hx != null ) {

		return { hx: hull.hx, hz: hull.hz, rx: hull.rx, rz: hull.rz };

	}
	const heading = hull?.heading ?? 0;
	return {
		hx: Math.sin( heading ),
		hz: - Math.cos( heading ),
		rx: Math.cos( heading ),
		rz: Math.sin( heading ),
	};

}

/** Posed hull footprint in XZ. Pad keeps specks off the deck and chines. */
export function leftoverBubbleHull( body, pad = 0.22 ) {

	if ( ! body ) return null;
	const L = Math.max( body.size?.z ?? body.length ?? 8, 0.8 );
	const B = Math.max( body.size?.x ?? body.beam ?? 2, 0.4 );
	const pos = body.pos ?? [ 0, 0, 0 ];
	const heading = body.heading ?? 0;
	return {
		x: pos[ 0 ],
		z: pos[ 2 ],
		heading,
		halfL: L * 0.5,
		halfB: B * 0.5,
		pad,
		...hullAxes( { heading } ),
	};

}

export function leftoverBubbleInHull( x, z, hull ) {

	if ( ! hull ) return false;
	const { hx, hz, rx, rz } = hullAxes( hull );
	const dx = x - hull.x;
	const dz = z - hull.z;
	const along = dx * hx + dz * hz;
	const across = dx * rx + dz * rz;
	return Math.abs( along ) <= hull.halfL + hull.pad
		&& Math.abs( across ) <= hull.halfB + hull.pad;

}

/** World XZ in the water behind the transom — never on the deck. */
export function leftoverBubbleBirthXZ( hull, rand = Math.random, opts = {} ) {

	const { hx, hz, rx, rz } = hullAxes( hull );
	const aft = hull.halfL + hull.pad + 0.15 + 1.8 * rand();
	// Birth on the waterline cuts (±beam), not a Kelvin arm outside the hull.
	const side = ( rand() - 0.5 ) * ( hull.halfB * 2.0 + 0.45 );
	return {
		x: hull.x - hx * aft + rx * side,
		z: hull.z - hz * aft + rz * side,
		zone: 'stern',
	};

}

/**
 * Splash births at the turbulent bow and behind the transom. The dedicated
 * body-spray system owns the airborne chine sheet. Leaving long-lived surface
 * specks all along both chines stamped two parallel dotted rows behind the
 * boat, even after the continuous foam ribbon itself was joined.
 */
export function leftoverSplashBirthXZ( hull, rand = Math.random ) {

	const { hx, hz, rx, rz } = hullAxes( hull );
	const u = rand();
	if ( u < 0.52 ) {

		const along = hull.halfL + hull.pad + 0.18 + 0.85 * rand();
		const side = ( rand() - 0.5 ) * ( hull.halfB * 1.15 + 0.25 );
		return {
			x: hull.x + hx * along + rx * side,
			z: hull.z + hz * along + rz * side,
			zone: 'bow',
		};

	}
	return leftoverBubbleBirthXZ( hull, rand );

}

/**
 * Horizontal leftover ride. A 2-D wave travels along k̂ ∝ −∇h · (∂h/∂t).
 * Flat water does not shove. A crest peak (v ≈ 0) slides off the face
 * so specks still spread with the ring.
 */
export function leftoverBubbleRide( slx, slz, vh, speed ) {

	const c = Math.max( speed ?? 0, 0 );
	const g2 = slx * slx + slz * slz;
	if ( ! ( c > 0.01 ) || g2 < 1e-8 ) return { vx: 0, vz: 0 };
	let dx = - slx * vh;
	let dz = - slz * vh;
	let m = Math.hypot( dx, dz );
	if ( m < 1e-6 ) {

		m = Math.sqrt( g2 );
		dx = - slx;
		dz = - slz;

	}
	const ride = c * Math.min( 1, Math.sqrt( g2 ) / 0.045 );
	return { vx: dx / m * ride, vz: dz / m * ride };

}

/**
 * One-shot lateral birth velocity at the Kelvin half-angle.
 *
 * Do not apply this every frame with the live hull pose. A settled speck is a
 * world-space parcel and remembers the heading under which it was born; it
 * cannot turn when the boat turns later. The old per-frame call steered up to
 * three seconds of existing particles with the wheel, collecting them into two
 * rails and sweeping a straight boundary through the old trail.
 *
 * @param {number} x
 * @param {number} z
 * @param {{ hull?:object, openSpeed?:number, diverge?:number }} [opts]
 */
export function leftoverBubbleDiverge( x, z, opts = {} ) {

	const hull = opts.hull;
	const open = opts.openSpeed ?? 0;
	const diverge = opts.diverge ?? LEFTOVER_BUBBLE_DIVERGE;
	if ( ! hull || ! ( open > 0.25 ) || ! ( diverge > 0 ) ) return { vx: 0, vz: 0 };
	const { hx, hz, rx, rz } = hullAxes( hull );
	const dx = x - hull.x;
	const dz = z - hull.z;
	const along = dx * hx + dz * hz;
	const lat = dx * rx + dz * rz;
	const aft = Math.max( 0, - along - hull.halfL );
	if ( aft < 0.15 ) return { vx: 0, vz: 0 };
	const c = Math.max( opts.waveSpeed ?? 0, 0.35 );
	const openTan = open > c * 1.02
		? c / Math.sqrt( Math.max( open * open - c * c, 1e-4 ) )
		: KELVIN_TAN;
	// Ramp across the sailing line rather than flipping on sign(): a
	// one-speck reversal blew a clean lane down the middle of the trail.
	const side = clamp( lat / Math.max( hull.halfB, 0.35 ), - 1, 1 );
	// Keep even helper-only use safe: an aft leash by itself is an infinite
	// strip abeam. Bound the live birth frame radially and avoid an arm-locus
	// ridge that could collect particles into two ruled rows.
	const reach = clamp( open * LEFTOVER_BUBBLE_PEEL_MEMORY, 6, 40 );
	const dist = Math.hypot( lat, aft );
	const own = smoothstep( 0, 1.2, aft )
		* ( 1 - smoothstep( reach * 0.55, reach, dist ) );
	if ( own <= 0 ) return { vx: 0, vz: 0 };
	const raw = side * openTan * open * diverge * own;
	const vLat = clamp( raw, - LEFTOVER_BUBBLE_PEEL_MAX, LEFTOVER_BUBBLE_PEEL_MAX );
	return { vx: rx * vLat, vz: rz * vLat };

}

export function leftoverBubbleAlpha( p ) {

	if ( ! p || p.age < 0 || p.age >= p.life ) return 0;
	const u = p.age / Math.max( p.life, 1e-3 );
	if ( p.kind === 'splash' ) {

		const attack = clamp( u / 0.06, 0, 1 );
		const hold = 1 - clamp( ( u - 0.48 ) / 0.52, 0, 1 );
		return attack * ( 3 - 2 * attack ) * hold;

	}
	const attack = clamp( u / 0.08, 0, 1 );
	const hold = 1 - clamp( ( u - 0.58 ) / 0.42, 0, 1 );
	return attack * attack * ( 3 - 2 * attack ) * hold * hold;

}

/**
 * `false` / `0` / omitted → off.
 * `true` / `1` / a number → foam amount on the shipped defaults (splash on).
 * `{ on, amount, splash, life, size, count }` merges.
 */
export function parseLeftoverBubbles( raw ) {

	if ( raw === false || raw == null || raw === 0 ) return null;
	const d = {
		on: 1,
		amount: LEFTOVER_BUBBLE_AMOUNT,
		splash: LEFTOVER_SPLASH_AMOUNT,
		life: LEFTOVER_BUBBLE_LIFE,
		size: LEFTOVER_BUBBLE_SIZE,
		count: LEFTOVER_BUBBLE_MAX,
	};
	if ( raw === true || raw === 1 ) return d;
	if ( typeof raw === 'number' ) {

		if ( ! ( raw > 0.001 ) ) return null;
		return { ...d, amount: raw };

	}
	if ( raw.on === false || raw.on === 0 ) return null;
	return {
		on: 1,
		amount: Math.max( raw.amount ?? d.amount, 0 ),
		splash: Math.max( raw.splash ?? d.splash, 0 ),
		life: clamp( raw.life ?? d.life, 0.25, 16 ),
		size: clamp( raw.size ?? d.size, 0.012, 0.28 ),
		count: Math.round( clamp( raw.count ?? raw.max ?? d.count, 1, LEFTOVER_BUBBLE_POOL ) ),
	};

}

function settleFoam( p, sea, opts, rand ) {

	p.kind = 'foam';
	p.y = sea;
	p.vy = 0;
	p.floated = true;
	p.age = 0;
	p.life = ( opts.life ?? LEFTOVER_BUBBLE_LIFE ) * ( 0.62 + 0.55 * rand() );
	p.size = ( opts.size ?? LEFTOVER_BUBBLE_SIZE ) * ( 0.55 + 0.7 * rand() );
	p.vx *= 0.38;
	p.vz *= 0.38;
	return p;

}

export class LeftoverBubbleField {

	constructor( { max = LEFTOVER_BUBBLE_MAX } = {} ) {

		this.max = max;
		this.particles = [];
		this._seed = 1;
		this._foamCarry = 0;
		this._splashCarry = 0;

	}

	setMax( n ) {

		this.max = Math.round( clamp( n ?? LEFTOVER_BUBBLE_MAX, 1, LEFTOVER_BUBBLE_POOL ) );
		if ( this.particles.length > this.max ) this.particles.length = this.max;

	}

	clear() {

		this.particles.length = 0;
		this._foamCarry = 0;
		this._splashCarry = 0;

	}

	get count() { return this.particles.length; }

	_rand() {

		this._seed += 1;
		return hash01( this._seed );

	}

	/** Drop one particle. Used by the check and by step(). */
	spawn( site = {} ) {

		if ( this.particles.length >= this.max ) return null;
		const kind = site.kind === 'splash' ? 'splash' : 'foam';
		const sea = site.sea ?? 0;
		const y0 = site.y ?? ( kind === 'splash'
			? sea + ( site.height ?? 0.10 )
			: sea );
		const p = {
			kind,
			x: site.x ?? 0,
			y: y0,
			z: site.z ?? 0,
			vx: site.vx ?? 0,
			vy: site.vy ?? ( kind === 'splash' ? 1.6 : 0 ),
			vz: site.vz ?? 0,
			life: site.life ?? ( kind === 'splash' ? LEFTOVER_SPLASH_LIFE : LEFTOVER_BUBBLE_LIFE ),
			size: site.size ?? ( kind === 'splash' ? LEFTOVER_SPLASH_SIZE : LEFTOVER_BUBBLE_SIZE ),
			age: 0,
			sea,
			floated: kind === 'foam',
		};
		this.particles.push( p );
		return p;

	}

	/**
	 * Age splash (ballistic) and foam (surface), then birth new splash
	 * at the wet cuts. Splash that hits the sea becomes foam.
	 */
	step( dt, sites = [], opts = {} ) {

		const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
		if ( opts.count != null ) this.setMax( opts.count );
		const leftoverAt = opts.leftoverAt;
		const leftoverRide = opts.leftoverRide;
		const leftoverLook = opts.leftoverLook ?? ( leftoverAt || leftoverRide
			? ( x, z ) => {

				const h = leftoverAt ? leftoverAt( x, z ) : 0;
				const ride = leftoverRide ? leftoverRide( x, z ) : { vx: 0, vz: 0 };
				return { h, vx: ride.vx, vz: ride.vz };

			}
			: null );
		const sea0 = opts.sea ?? 0;
		const openSpeed = Math.abs( opts.openSpeed ?? opts.speed ?? 0 );
		const divergeGain = opts.diverge ?? LEFTOVER_BUBBLE_DIVERGE;
		const lookAt = ( p ) => {

			if ( ! leftoverLook ) return { h: 0, vx: 0, vz: 0 };
			if ( p._rideT > 0 ) {

				p._rideT -= d;
				return { h: p._rh, vx: p._rvx, vz: p._rvz };

			}
			const look = leftoverLook( p.x, p.z );
			p._rh = look.h;
			p._rvx = look.vx;
			p._rvz = look.vz;
			p._rideT = LEFTOVER_RIDE_HOLD;
			return look;

		};
		let w = 0;
		for ( let i = 0; i < this.particles.length; i ++ ) {

			const p = this.particles[ i ];
			p.age += d;
			if ( p.age >= p.life ) continue;

			if ( p.kind === 'splash' ) {

				p.vy -= LEFTOVER_SPLASH_G * d;
				p.x += p.vx * d;
				p.z += p.vz * d;
				p.y += p.vy * d;
				if ( leftoverBubbleInHull( p.x, p.z, opts.hull ) ) continue;
				// Airborne splash skips leftover. Sample only near the sea.
				if ( p.y < sea0 + 0.22 ) {

					const look = lookAt( p );
					const sea = look.h + ( p.sea ?? sea0 );
					if ( p.y < sea + 0.14 ) {

						p.x += look.vx * d * 0.55;
						p.z += look.vz * d * 0.55;

					}
					if ( leftoverBubbleInHull( p.x, p.z, opts.hull ) ) continue;
					if ( p.y <= sea ) settleFoam( p, sea, opts, () => this._rand() );

				}

			} else {

				const look = lookAt( p );
				// p.vx/vz were written in the birth heading and are world
				// velocities. Once the speck has settled, only that momentum
				// and the water may move it; the live wheel may not.
				p.x += ( p.vx + look.vx ) * d;
				p.z += ( p.vz + look.vz ) * d;
				if ( leftoverBubbleInHull( p.x, p.z, opts.hull ) ) continue;
				p.y = look.h + ( p.sea ?? sea0 );
				p.floated = true;
				p.vx *= Math.exp( - d * 0.55 );
				p.vz *= Math.exp( - d * 0.55 );

			}
			this.particles[ w ++ ] = p;

		}
		this.particles.length = w;

		const foamAmt = opts.amount ?? 0;
		const splashAmt = opts.splash ?? 0;
		const speed = Math.abs( opts.speed ?? 0 );
		if ( ( ! ( foamAmt > 0.001 ) && ! ( splashAmt > 0.001 ) ) || speed < 0.55 || ! sites.length ) return;

		let weight = 0;
		const live = [];
		for ( let i = 0; i < sites.length; i ++ ) {

			const s = sites[ i ];
			const w = Math.max( s.gain ?? 0, s.live ? 0.2 : 0 ) * ( 0.35 + 0.65 * ( s.wet ?? 1 ) );
			if ( w <= 0.02 ) continue;
			live.push( { s, w, acc: weight + w } );
			weight += w;

		}
		if ( ! weight ) return;

		const speedK = Math.min( speed / 4.2, 1.6 );
		const load = Math.min( weight, 8 );
		this._splashCarry += splashAmt * LEFTOVER_SPLASH_RATE * speedK * load * d;
		this._foamCarry += foamAmt * LEFTOVER_FOAM_RATE * speedK * load * d;

		const heading = opts.heading ?? 0;
		const { hx, hz, rx, rz } = hullAxes( { heading } );
		const hull = opts.hull;
		let born = 0;

		const pickSite = () => {

			const pick = this._rand() * weight;
			for ( let i = 0; i < live.length; i ++ ) {

				if ( pick <= live[ i ].acc ) return live[ i ].s;

			}
			return live[ 0 ].s;

		};

		const bodyHull = hull ?? {
			x: 0, z: 0, heading, halfL: 0, halfB: 0, pad: 0.28,
		};

		while ( this._splashCarry >= 1 && this.particles.length < this.max && born < LEFTOVER_BIRTH_CAP ) {

			this._splashCarry -= 1;
			born ++;
			const site = pickSite();
			const origin = hull ?? {
				...bodyHull,
				x: site.x ?? 0,
				z: site.z ?? 0,
			};
			const xz = leftoverSplashBirthXZ( origin, () => this._rand() );
			if ( leftoverBubbleInHull( xz.x, xz.z, opts.hull ) ) continue;
			const sideSign = Math.sign( ( xz.x - origin.x ) * rx + ( xz.z - origin.z ) * rz ) || ( this._rand() < 0.5 ? - 1 : 1 );
			const bow = xz.zone === 'bow' ? 1.25 : 0.85;
			this.spawn( {
				kind: 'splash',
				x: xz.x,
				z: xz.z,
				sea: site.sea ?? sea0,
				height: 0.04 + 0.22 * this._rand(),
				vx: ( this._rand() - 0.5 ) * 0.55 + rx * sideSign * ( 0.45 + 1.1 * this._rand() ) - hx * 0.15,
				vz: ( this._rand() - 0.5 ) * 0.55 + rz * sideSign * ( 0.45 + 1.1 * this._rand() ) - hz * 0.15,
				vy: ( 1.1 + 2.4 * this._rand() ) * bow,
				life: LEFTOVER_SPLASH_LIFE * ( 0.55 + 0.7 * this._rand() ),
				size: ( opts.size ?? LEFTOVER_BUBBLE_SIZE ) * 0.68 * ( 0.6 + 0.7 * this._rand() ),
			} );

		}

		while ( this._foamCarry >= 1 && this.particles.length < this.max && born < LEFTOVER_BIRTH_CAP ) {

			this._foamCarry -= 1;
			born ++;
			const site = pickSite();
			const origin = hull ?? {
				...bodyHull,
				x: site.x ?? 0,
				z: site.z ?? 0,
			};
			const xz = leftoverBubbleBirthXZ( origin, () => this._rand(), { openSpeed } );
			if ( leftoverBubbleInHull( xz.x, xz.z, opts.hull ) ) continue;
			const sideSign = Math.sign(
				( xz.x - origin.x ) * rx + ( xz.z - origin.z ) * rz,
			) || ( this._rand() < 0.5 ? - 1 : 1 );
			// Small outward kick only — Kelvin/Mach diverge opens the trail
			// as foam ages aft of the waterline cuts.
			const peel = Math.min( openSpeed, 6 ) * 0.08 * divergeGain
				* ( 0.35 + 0.4 * this._rand() );
			this.spawn( {
				kind: 'foam',
				x: xz.x,
				z: xz.z,
				sea: site.sea ?? sea0,
				y: site.sea ?? sea0,
				vx: ( this._rand() - 0.5 ) * 0.18 - hx * 0.12 + rx * sideSign * peel,
				vz: ( this._rand() - 0.5 ) * 0.18 - hz * 0.12 + rz * sideSign * peel,
				life: ( opts.life ?? LEFTOVER_BUBBLE_LIFE ) * ( 0.7 + 0.5 * this._rand() ),
				size: ( opts.size ?? LEFTOVER_BUBBLE_SIZE ) * ( 0.55 + 0.7 * this._rand() ),
			} );

		}

	}

	live() {

		return this.particles;

	}

}
