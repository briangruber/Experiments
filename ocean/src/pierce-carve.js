// Leftover trench behind a pole cut.
//
// The live pierce (src/pierce.js) is the well at the rod right now. This
// field is what it leaves: capsules along the path, each as deep as the
// well was when written, fading over `life` seconds. Sixteen stamps span
// about that many seconds of travel, so a sprint is long capsules and a
// crawl is short ones — the trail is a ribbon, not a dashed line of
// holes. Twin: src/gpu/tsl/pierce-carve.js. A change here is not done
// until tools/check-pierce-carve.mjs passes.

import { pierceOccupancy } from './pierce.js';

export const PIERCE_CARVE_STAMPS = 16;
export const PIERCE_CARVE_LIFE = 6;
export const PIERCE_CARVE_TELEPORT = 20;

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function hypot2( ax, az, bx, bz ) {

	return Math.hypot( bx - ax, bz - az );

}

/** Seconds left as a 1…0 envelope. Quadratic, like leftover foam. */
export function pierceCarveFade( s ) {

	if ( ! s || ( ! s._open && s.age >= s.life ) ) return 0;
	if ( s._open ) return 1;
	const u = 1 - s.age / Math.max( s.life, 1e-3 );
	return u * u;

}

/** Metres of leftover drop at a stamp, already faded. */
export function pierceCarveAmp( s ) {

	if ( ! s || ! ( s.well > 1e-4 ) ) return 0;
	return Math.max( s.well, 0 ) * pierceCarveFade( s );

}

/**
 * Metres between new capsules. Grows with speed so the 16-stamp cap
 * covers about `life` seconds of travel instead of filling in a blink.
 */
export function pierceCarveSpacing( speed = 0, life = PIERCE_CARVE_LIFE, r = 0.4 ) {

	const span = Math.max( speed, 0 ) * Math.max( life, 0.05 );
	const byTime = span / Math.max( PIERCE_CARVE_STAMPS - 1, 1 );
	return Math.max( Math.max( r, 0.15 ) * 1.2, byTime, 0.4 );

}

/**
 * Occupancy of one capsule (a segment of thickness `r`). Twin of the
 * live pierce occupancy, measured from the outline.
 */
export function pierceCarveOccupancy( px, pz, s ) {

	if ( ! s ) return 0;
	const ax = s.ax ?? s.x ?? 0;
	const az = s.az ?? s.z ?? 0;
	const bx = s.bx ?? ax;
	const bz = s.bz ?? az;
	const dx = bx - ax;
	const dz = bz - az;
	const len = Math.hypot( dx, dz );
	const half = len * 0.5;
	const cx = ( ax + bx ) * 0.5;
	const cz = ( az + bz ) * 0.5;
	const al = len > 1e-6 ? len : 1;
	return pierceOccupancy( px, pz, {
		x: cx, z: cz,
		ax: dx / al, az: len > 1e-6 ? dz / al : - 1,
		half, r: Math.max( s.r ?? 0.15, 0.02 ),
	} );

}

/**
 * Height (m) of the leftover trench at a world XZ point. Negative is
 * a carve. Overlapping stamps take the deeper well, they do not add.
 */
export function pierceCarveAt( px, pz, field ) {

	let h = 0;
	const stamps = field?.stamps ?? field ?? [];
	for ( let i = 0; i < stamps.length; i ++ ) {

		const amp = pierceCarveAmp( stamps[ i ] );
		if ( ! ( amp > 1e-4 ) ) continue;
		const occ = pierceCarveOccupancy( px, pz, stamps[ i ] );
		if ( occ > 1e-4 ) h = Math.min( h, - amp * occ );

	}
	return { h };

}

export class PierceCarveField {

	constructor() {

		this.stamps = [];

	}

	reset() {

		this.stamps.length = 0;

	}

	live() {

		for ( let i = 0; i < this.stamps.length; i ++ ) {

			if ( pierceCarveAmp( this.stamps[ i ] ) > 1e-4 ) return true;

		}
		return false;

	}

	_closeHead() {

		const last = this.stamps[ this.stamps.length - 1 ];
		if ( last ) last._open = false;

	}

	_push( x, z, r, well, life ) {

		this.stamps.push( {
			ax: x, az: z, bx: x, bz: z,
			r, well, age: 0, life, _open: true,
		} );
		if ( this.stamps.length > PIERCE_CARVE_STAMPS ) this.stamps.shift();

	}

	/**
	 * @param {number} dt
	 * @param {{x:number,z:number,r?:number,well?:number,speed?:number}|null} site
	 * @param {{life?:number,speed?:number}} [opts]
	 */
	step( dt, site, opts = {} ) {

		const d = clamp( dt ?? 0, 0, 0.1 );
		const life = Math.max( opts.life ?? PIERCE_CARVE_LIFE, 0 );
		const keep = [];
		for ( let i = 0; i < this.stamps.length; i ++ ) {

			const s = this.stamps[ i ];
			if ( ! s._open ) s.age += d;
			if ( s._open || ( s.age < s.life && pierceCarveAmp( s ) > 1e-4 ) ) {

				keep.push( s );

			}

		}
		this.stamps = keep;

		if ( ! ( life > 0.05 ) || ! site || ! ( site.well > 0.02 ) ) {

			this._closeHead();
			return;

		}

		const x = site.x;
		const z = site.z;
		if ( ! Number.isFinite( x ) || ! Number.isFinite( z ) ) {

			this._closeHead();
			return;

		}

		const r = Math.max( site.r ?? 0.15, 0.02 );
		const well = Math.max( site.well, 0 );
		const speed = Math.abs( opts.speed ?? site.speed ?? 0 );
		const spacing = pierceCarveSpacing( speed, life, r );
		const last = this.stamps[ this.stamps.length - 1 ];

		if ( last && last._open ) {

			const leap = hypot2( last.bx, last.bz, x, z );
			if ( leap > PIERCE_CARVE_TELEPORT ) {

				last._open = false;
				this._push( x, z, r, well, life );
				return;

			}

			last.bx = x;
			last.bz = z;
			last.well = Math.max( last.well, well );
			last.r = r;
			last.life = life;
			if ( hypot2( last.ax, last.az, last.bx, last.bz ) >= spacing ) {

				last._open = false;
				this._push( x, z, r, well, life );

			}
			return;

		}

		this._push( x, z, r, well, life );

	}

}

/**
 * Wall meshes for the leftover trench and, when `life` is 0, the live
 * rod. Open stamps already include the live site as `bx`, so a second
 * live cylinder is only added when nothing is being written.
 *
 * @param {{x:number,z:number,y?:number,r?:number,well?:number}|null} site
 * @param {PierceCarveField | {stamps?: object[] } | null | undefined} field
 * @param {number} [seaLevel=0]
 */
export function pierceWellStamps( site, field, seaLevel = 0 ) {

	const out = [];
	const stamps = field?.stamps ?? [];
	let open = false;
	for ( let i = 0; i < stamps.length; i ++ ) {

		const s = stamps[ i ];
		const amp = pierceCarveAmp( s );
		if ( ! ( amp > 0.02 ) ) continue;
		out.push( {
			ax: s.ax, az: s.az, bx: s.bx, bz: s.bz,
			r: Math.max( s.r ?? 0.15, 0.02 ),
			yTop: seaLevel,
			yBot: seaLevel - amp,
		} );
		if ( s._open ) open = true;

	}
	if ( site && site.well > 0.02 && ! open ) {

		const r = Math.max( site.r ?? 0.15, 0.02 );
		const yBot = Number.isFinite( site.y ) ? site.y : seaLevel - site.well;
		out.push( {
			ax: site.x, az: site.z, bx: site.x, bz: site.z,
			r, yTop: seaLevel, yBot,
		} );

	}
	return out;

}
