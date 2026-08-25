// Leftover surface foam. Waterline / splash foam is created while the
// body is working the sea, then lives on the surface and fades on its
// own clock. It must not follow the animal out of the water or down
// into a dive — that snap-off is what this field exists to stop.
//
// CPU twin of leftoverFoamAccum in src/gpu/tsl/water-surface.js.

export const LEFTOVER_FOAM = 16;
export const LEFTOVER_FOAM_LIFE = 10;
export const LEFTOVER_FOAM_ATTACK = 0.35;
export const LEFTOVER_FOAM_GROW = 0.45;

function smooth01( lo, hi, x ) {

	const t = Math.min( Math.max( ( x - lo ) / ( hi - lo ), 0 ), 1 );
	return t * t * ( 3 - 2 * t );

}

export function leftoverFoamRadius( p ) {

	if ( ! p ) return 0;
	const attack = Math.max( p.attack ?? LEFTOVER_FOAM_ATTACK, 1e-3 );
	const t = smooth01( 0, attack, p.age );
	const r1 = p.r1 ?? p.r0;
	return p.r0 + ( r1 - p.r0 ) * t
		+ ( p.grow ?? LEFTOVER_FOAM_GROW ) * Math.max( 0, p.age - attack );

}

function leftoverFoamAmp( p ) {

	if ( ! p || ! ( p.amp > 0.02 ) || p.age >= p.life ) return 0;
	const attack = Math.max( p.attack ?? LEFTOVER_FOAM_ATTACK, 1e-3 );
	const growIn = smooth01( 0, attack, p.age );
	const u = 1 - p.age / p.life;
	return growIn * u * u * p.amp;

}

export function leftoverFoamMask( px, pz, p ) {

	const a = leftoverFoamAmp( p );
	if ( ! ( a > 0.002 ) ) return 0;
	const r = leftoverFoamRadius( p );
	const d = Math.hypot( px - p.x, pz - p.z );
	if ( d > r ) return 0;
	return smooth01( r, r * 0.52, d ) * a;

}

export function leftoverFoamAt( px, pz, field ) {

	let m = 0;
	const stamps = field?.stamps ?? field ?? [];
	for ( let i = 0; i < stamps.length; i ++ ) {

		const s = leftoverFoamMask( px, pz, stamps[ i ] );
		if ( s > m ) m = s;

	}
	return Math.min( 1, m );

}

export class LeftoverFoamField {

	constructor() {

		this.stamps = [];

	}

	reset() {

		this.stamps.length = 0;

	}

	/** Drop one patch. Used for a leap slap that has no waterline sites. */
	drop( x, z, opts ) {

		const r0 = Math.max( opts?.r0 ?? 2.2, 0.6 );
		this.stamps.push( {
			x, z,
			r0,
			r1: Math.max( opts?.r1 ?? r0 * 2.1, r0 ),
			grow: opts?.grow ?? LEFTOVER_FOAM_GROW,
			attack: opts?.attack ?? LEFTOVER_FOAM_ATTACK,
			age: 0,
			life: opts?.life ?? LEFTOVER_FOAM_LIFE,
			amp: Math.min( Math.max( opts?.amp ?? 1, 0 ), 1.4 ),
		} );
		if ( this.stamps.length > LEFTOVER_FOAM ) this.stamps.shift();

	}

	/**
	 * Age existing patches, then upsert foam at the current waterline
	 * sites. An empty site list is a no-op on creation — leftover
	 * patches keep fading whether the body is airborne or deep.
	 *
	 * @param {number} dt
	 * @param {Array<{x:number,z:number,half?:number}>} sites
	 * @param {{gain?:number, life?:number, r0?:number}} opts
	 */
	step( dt, sites, opts ) {

		const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
		const keep = [];
		for ( let i = 0; i < this.stamps.length; i ++ ) {

			const p = this.stamps[ i ];
			p.age += d;
			if ( p.age >= p.life || p.amp < 0.02 ) continue;
			keep.push( p );

		}
		this.stamps = keep;

		const gain = Math.min( Math.max( opts?.gain ?? 1, 0 ), 1.4 );
		if ( ! ( gain > 0.02 ) || ! sites?.length ) return;

		const life = opts?.life ?? LEFTOVER_FOAM_LIFE;
		for ( let i = 0; i < sites.length; i ++ ) {

			const s = sites[ i ];
			const x = s.x, z = s.z;
			if ( ! Number.isFinite( x ) || ! Number.isFinite( z ) ) continue;
			const half = Math.max( s.half ?? opts?.r0 ?? 2.2, 0.6 );
			const matchR = half * 1.35;
			let hit = null;
			let best = matchR;
			for ( let j = 0; j < this.stamps.length; j ++ ) {

				const p = this.stamps[ j ];
				const dist = Math.hypot( p.x - x, p.z - z );
				if ( dist < best ) {

					best = dist;
					hit = p;

				}

			}
			if ( hit && hit.age < 1.2 ) {

				hit.x = x;
				hit.z = z;
				hit.amp = Math.max( hit.amp, gain );
				hit.life = Math.max( hit.life, life );
				hit.r1 = Math.max( hit.r1, half * 2.1 );

			} else {

				this.drop( x, z, {
					r0: half * 0.95,
					r1: half * 2.1,
					life,
					amp: gain,
				} );

			}

		}

	}

	/** Shader-ready: xy = XZ, z = current radius, w = remaining 0..1. */
	sites( cap ) {

		const n = Math.min( cap ?? LEFTOVER_FOAM, this.stamps.length );
		const out = [];
		for ( let i = 0; i < n; i ++ ) {

			const p = this.stamps[ i ];
			out.push( {
				x: p.x, z: p.z,
				radius: leftoverFoamRadius( p ),
				amp: leftoverFoamAmp( p ),
			} );

		}
		return out;

	}

}
