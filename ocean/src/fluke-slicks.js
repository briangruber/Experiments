// Fluke footprints: the glassy circular slicks a swimming tail leaves.
//
// A caudal stroke sheds an upwelling vortex. When that impulse reaches
// the sea it does not splash — it kills capillary chop and wind foam,
// leaving a mirror-flat patch that expands and fades. BBC Earth whale
// footage is this, not a ring of foam. tools/check-fluke-slicks.mjs is
// the CPU twin of flukeSlickCore in src/gpu/tsl/water-surface.js.

export const FLUKE_PRINTS = 16;
export const FLUKE_LIFE = 18;
export const FLUKE_GROW = 0.85;
export const FLUKE_R0 = 1.05;
export const FLUKE_ATTACK = 0.9;
export const FLUKE_SPEED_MIN = 1.15;
export const FLUKE_CAP_KILL = 0.95;
export const FLUKE_FOAM_KILL = 0.85;
export const FLUKE_ROUGH_KILL = 0.70;
// How hard a print flattens the FFT displacement / slope. Chop-only
// kill was invisible under a real swell — the disc has to calm the sea.
export const FLUKE_FFT_KILL = 0.78;
export const FLUKE_SLOPE_KILL = 0.88;

function smooth01( lo, hi, x ) {

	const t = Math.min( Math.max( ( x - lo ) / ( hi - lo ), 0 ), 1 );
	return t * t * ( 3 - 2 * t );

}

/** World XZ (and Y) of the fluke, aft of the origin along the heading. */
export function flukeWorld( pos, heading, length, pitch = 0 ) {

	const hx = Math.sin( heading ?? 0 );
	const hz = - Math.cos( heading ?? 0 );
	const along = Math.max( length ?? 8, 8 ) * 0.42;
	const sp = Math.sin( pitch ?? 0 );
	return {
		x: ( pos?.[ 0 ] ?? 0 ) - hx * along,
		y: ( pos?.[ 1 ] ?? 0 ) - sp * along,
		z: ( pos?.[ 2 ] ?? 0 ) - hz * along,
	};

}

/** Current disc radius. Starts small and grows in over attack. */
export function flukePrintRadius( p ) {

	if ( ! p ) return 0;
	const attack = Math.max( p.attack ?? FLUKE_ATTACK, 1e-3 );
	const t = smooth01( 0, attack, p.age );
	const r1 = p.r1 ?? p.r0;
	return p.r0 + ( r1 - p.r0 ) * t
		+ ( p.grow ?? FLUKE_GROW ) * Math.max( 0, p.age - attack );

}

function flukePrintAmp( p ) {

	if ( ! p || ! ( p.amp > 0.02 ) || p.age >= p.life ) return 0;
	const attack = Math.max( p.attack ?? FLUKE_ATTACK, 1e-3 );
	const growIn = smooth01( 0, attack, p.age );
	const u = Math.max( 0, 1 - p.age / p.life );
	// Smooth hermite fadeout: zero derivative as it approaches death, eliminating any pop
	const fadeOut = u * u * ( 3 - 2 * u );
	return growIn * fadeOut * p.amp;

}

export function flukePrintMask( px, pz, p ) {

	const a = flukePrintAmp( p );
	if ( ! ( a > 0.002 ) ) return 0;
	const r = flukePrintRadius( p );
	const d = Math.hypot( px - p.x, pz - p.z );
	if ( d > r ) return 0;
	const edge = smooth01( r, r * 0.52, d );
	return edge * a;

}

export function flukeSlick( px, pz, field ) {

	let m = 0;
	const prints = field?.prints ?? field ?? [];
	for ( let i = 0; i < prints.length; i ++ ) {

		const s = flukePrintMask( px, pz, prints[ i ] );
		if ( s > m ) m = s;

	}
	return Math.min( 1, m );

}

export class FlukeSlickField {

	constructor() {

		this.prints = [];
		this._prevCos = null;
		this._prevClear = null;
		this._cool = 0;
		this.hit = false;

	}

	reset() {

		this.prints.length = 0;
		this._prevCos = null;
		this._prevClear = null;
		this._cool = 0;
		this.hit = false;

	}

	/** Explicitly drop a slick print (e.g. at a massive breach landing site). */
	dropPrint( x, z, opts ) {

		const beam = Math.max( opts?.beam ?? 2, 0.6 );
		const gain = Math.min( Math.max( opts?.gain ?? 1, 0 ), 2 );
		const target = Math.max( opts?.r0 ?? beam * FLUKE_R0, 3.0 );
		this.prints.push( {
			x, z,
			r0: Math.max( target * 0.25, 1.0 ),
			r1: target,
			grow: opts?.grow ?? FLUKE_GROW,
			attack: opts?.attack ?? FLUKE_ATTACK,
			age: 0,
			life: ( opts?.life ?? FLUKE_LIFE ) * 1.2,
			amp: gain * 0.95,
		} );
		this._retireExcess();

	}

	/**
	 * When new prints exceed the active capacity, gracefully accelerate retirement
	 * of older prints so they transition out smoothly over 2.0s instead of vanishing.
	 */
	_retireExcess() {

		if ( this.prints.length <= FLUKE_PRINTS ) return;
		const excess = this.prints.length - FLUKE_PRINTS;
		for ( let i = 0; i < excess; i ++ ) {

			const p = this.prints[ i ];
			if ( p && p.life > p.age + 2.0 ) {

				p.life = p.age + 2.0;

			}

		}

	}

	/**
	 * @param {number} dt
	 * @param {{x:number,z:number,phase:number,speed:number,beam:number,clearance:number,fade:number}} opts
	 *        clearance = sea − fluke Y; positive means the tail is under.
	 */
	step( dt, opts ) {

		const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
		const phase = opts.phase ?? 0;
		const c = Math.cos( phase );
		const speed = Math.abs( opts.speed ?? 0 );
		const fade = Math.max( opts.fade ?? 9, 0.5 );
		const clear = opts.clearance ?? 0;
		const beam = Math.max( opts.beam ?? 2, 0.6 );
		const near = clear < fade && clear > - beam * 0.5;
		// Stroke peak while already near the sea, OR the fluke actually
		// crossing the waterline. Waiting only on cos(phase) is why a
		// visible tail slap often left no print — the peak and the hit
		// are different events on an up-down swim.
		const stroke = this._prevCos != null && this._prevCos * c < 0;
		this._cool = Math.max( 0, ( this._cool ?? 0 ) - d );
		const slap = this._prevClear != null && ( this._cool ?? 0 ) <= 0
			&& ( ( this._prevClear > 0.25 && clear <= 0.25 )
				|| ( this._prevClear < - 0.15 && clear >= - 0.15 ) );
		this.hit = false;
		if ( ( stroke || slap ) && speed >= FLUKE_SPEED_MIN && near ) {

			this.hit = true;
			this._cool = 0.45;
			const u = Math.min( speed / 12, 1 );
			const depth = Math.max( 0, 1 - Math.max( clear, 0 ) / fade );
			const gain = Math.min( Math.max( opts.gain ?? 1, 0 ), 2 );
			const target = Math.max( opts.r0 ?? beam * FLUKE_R0, 2.4 );
			this.prints.push( {
				x: opts.x, z: opts.z,
				r0: Math.max( target * 0.22, 0.8 ),
				r1: target,
				grow: opts.grow ?? FLUKE_GROW,
				attack: opts.attack ?? FLUKE_ATTACK,
				age: 0,
				life: ( opts.life ?? FLUKE_LIFE ) * ( 0.75 + 0.35 * u ),
				amp: ( 0.55 + 0.45 * u ) * ( 0.45 + 0.55 * depth ) * gain,
			} );
			this._retireExcess();

		}
		this._prevCos = c;
		this._prevClear = clear;

		const keep = [];
		for ( let i = 0; i < this.prints.length; i ++ ) {

			const p = this.prints[ i ];
			p.age += d;
			if ( p.age >= p.life || flukePrintAmp( p ) <= 0.002 ) continue;
			keep.push( p );

		}
		this.prints = keep;

	}

	/** Shader-ready: xy = XZ, z = current radius, w = remaining 0..1. */
	sites( cap = FLUKE_PRINTS ) {

		const out = [];
		for ( let i = 0; i < this.prints.length; i ++ ) {

			const p = this.prints[ i ];
			const amp = flukePrintAmp( p );
			if ( amp <= 0.002 ) continue;
			out.push( {
				x: p.x, z: p.z,
				radius: flukePrintRadius( p ),
				amp,
			} );

		}
		if ( out.length > cap ) {

			out.sort( ( a, b ) => b.amp - a.amp );
			out.length = cap;

		}
		return out;

	}

}

/**
 * Footprint of the dorsal pressure dome. Height used to stay on a
 * fixed 11 × 9 m ellipse, so a 16 m slider was a tent. The loaf
 * grows with amplitude (slope ~ A / 1.55 A ≈ 0.65 at the 1/e ring)
 * and stays on the back, not the whole animal.
 */
export function pressureDomeRadii( length, beam, amp, soft = 1 ) {

	const L = Math.max( length ?? 8, 8 );
	const A = Math.abs( amp ?? 0 );
	const s = Math.max( soft ?? 1, 0.2 );
	const along = Math.min(
		Math.max( L * 0.22, 6, A * 1.55 ),
		L * 0.42,
	) * s;
	const across = Math.min(
		Math.max( Math.max( beam ?? 0, 0 ) * 1.35, 4, A * 1.05 ),
		L * 0.28,
	) * s;
	return { along, across };

}

/** Unit dorsal pressure dome. Not a spine rail — one ellipse on the mass. */
export function pressureDomeHeight( px, pz, dome ) {

	if ( ! dome || ! ( Math.abs( dome.amp ) > 0.02 ) ) return 0;
	const dx = px - dome.x;
	const dz = pz - dome.z;
	const len = Math.hypot( dome.dirX, dome.dirZ ) || 1;
	const fx = dome.dirX / len;
	const fz = dome.dirZ / len;
	const along = dx * fx + dz * fz;
	const across = - dx * fz + dz * fx;
	const L = Math.max( dome.along ?? 8, 0.5 );
	const W = Math.max( dome.across ?? 4, 0.5 );
	return dome.amp * Math.exp( - ( along / L ) * ( along / L ) )
		* Math.exp( - ( across / W ) * ( across / W ) );

}
