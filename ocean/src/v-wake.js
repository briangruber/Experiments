// A simple V behind a body on the free surface.
//
// Two soft ridges leaving the snout at ±angle, fading with fetch.
// Optional third ridge on the centreline (`mid`).
// No oscillating gravity waves, no stamp field. Twin of
// src/gpu/tsl/v-wake.js — a change here is not done until
// tools/check-v-wake.mjs passes.

export const V_WAKE_ANGLE = 15 * Math.PI / 180;
export const V_WAKE_TAN = Math.tan( V_WAKE_ANGLE );

/**
 * How hard NEW wake should be written from the body's height.
 * topClear = sea − highest point: + under, − out.
 * Already-written stamps live on their own clock — this only
 * gates generation. Deep or not piercing is 0. Approaching the
 * surface grows it. A pierce at or above the waterline is full.
 */
export function vWakeDepthT( topClear, piercing, fadeM = 9, _emergeM = 7 ) {

	const fade = Math.max( fadeM, 1 );
	if ( ! piercing || ! Number.isFinite( topClear ) ) return 0;
	if ( topClear >= fade ) return 0;
	if ( topClear > 0 ) {

		const x = 1 - topClear / fade;
		return x * x * ( 3 - 2 * x );

	}
	return 1;

}

export function vWakeTan( angleDeg ) {

	const a = Math.min( Math.max( angleDeg ?? 15, 8 ), 45 ) * Math.PI / 180;
	return Math.tan( a );

}

/**
 * Height (m) of the V at a world XZ point.
 * `u` is { hx, hz, fx, fz, amp, len, width, tan, mid }.
 * `mid` is a third ridge on the centreline; 0 keeps the hollow V.
 *
 * `foam` remains in the return shape for compatibility, but is always 0.
 * Foam is deposited into the persistent world-space wake-foam field instead.
 * Tying it to `ridge` is the exact defect that drew white V rails which moved
 * with the wave rather than living on the water that was aerated.
 */
export function vWakeAt( px, pz, u ) {

	if ( ! u || ! ( u.amp > 0.001 ) ) return { h: 0, foam: 0 };
	const fl = Math.hypot( u.fx, u.fz ) || 1;
	const fx = u.fx / fl;
	const fz = u.fz / fl;
	const dx = px - u.hx;
	const dz = pz - u.hz;
	const along = dx * fx + dz * fz;
	const across = - dx * fz + dz * fx;
	// Ahead of the snout is empty — a wake is what is behind you.
	if ( along > 1.2 ) return { h: 0, foam: 0 };
	const fetch = Math.max( - along, 0 );
	const len = Math.max( u.len ?? 70, 8 );
	if ( fetch > len ) return { h: 0, foam: 0 };
	const tanA = u.tan ?? V_WAKE_TAN;
	const arm = fetch * tanA;
	const w = Math.max( u.width ?? 1.3, 0.8 ) + fetch * 0.035;
	const d = Math.abs( Math.abs( across ) - arm );
	const ridgeArm = Math.exp( - ( d * d ) / ( w * w ) );
	const midK = Math.max( u.mid ?? 0, 0 );
	const ridgeMid = midK > 0.001
		? midK * Math.exp( - ( across * across ) / ( w * w ) )
		: 0;
	const ridge = Math.max( ridgeArm, ridgeMid );
	const fade = Math.max( 1 - fetch / len, 0 );
	// Grow out of the bow heap instead of a spike on the snout.
	const t = ( fetch - 2 ) / 8;
	const born = t <= 0 ? 0 : t >= 1 ? 1 : t * t * ( 3 - 2 * t );
	const h = ( u.amp ?? 0 ) * ridge * fade * fade * born;
	return { h, foam: 0 };

}

/**
 * Motorboat churn: aerated water in the LANE between the V arms.
 * Never the arm ridges — painting those was the white-rail defect.
 * Twin of vWakeCore().y in src/gpu/tsl/v-wake.js.
 */
export function vWakeChurnAt( px, pz, u ) {

	if ( ! u || ! ( u.amp > 0.001 ) ) return 0;
	const fl = Math.hypot( u.fx, u.fz ) || 1;
	const fx = u.fx / fl;
	const fz = u.fz / fl;
	const dx = px - u.hx;
	const dz = pz - u.hz;
	const along = dx * fx + dz * fz;
	const across = - dx * fz + dz * fx;
	if ( along > 1.2 ) return 0;
	const fetch = Math.max( - along, 0 );
	const len = Math.max( u.len ?? 70, 8 );
	if ( fetch > len ) return 0;
	const lane = Math.max( u.width ?? 1.3, 0.8 ) * 2.8 + fetch * 0.14;
	const track = Math.exp( - ( across * across ) / ( lane * lane ) );
	const fade = Math.max( 1 - fetch / len, 0 );
	const t = ( fetch - 2 ) / 8;
	const born = t <= 0 ? 0 : t >= 1 ? 1 : t * t * ( 3 - 2 * t );
	const gain = Math.min( ( u.amp ?? 0 ) / 1.39, 1.2 ) * 0.88;
	return Math.min( 1, Math.max( 0, track * fade * fade * born * gain ) );

}

export const V_WAKE_STAMPS = 8;
export const V_WAKE_LIFE = 7;
export const V_WAKE_SPACING = 8;
export const V_WAKE_SLIDE = 0.16;

/** Remaining height of a stamp. Quadratic fade, like leftover foam. */
export function vWakeStampAmp( s ) {

	if ( ! s || ! ( s.amp > 0.001 ) || s.age >= s.life ) return 0;
	const u = 1 - s.age / Math.max( s.life, 1e-3 );
	return s.amp * u * u;

}

/** Max of every live stamp's V. A dive stops writing; old chevrons stay. */
export function vWakeFieldAt( px, pz, field, shape ) {

	let h = 0;
	const stamps = field?.stamps ?? [];
	for ( let i = 0; i < stamps.length; i ++ ) {

		const amp = vWakeStampAmp( stamps[ i ] );
		if ( ! ( amp > 0.001 ) ) continue;
		const s = stamps[ i ];
		const r = vWakeAt( px, pz, {
			...shape,
			hx: s.x, hz: s.z, fx: s.fx, fz: s.fz, amp,
		} );
		if ( r.h > h ) h = r.h;

	}
	return { h, foam: 0 };

}

/**
 * Path of generating contacts. While the body is writing, the newest
 * stamp follows the first waterline cut. When writing stops, that
 * stamp freezes and fades over `life` — the V does not dive with it.
 */
export class VWakeField {

	constructor() {

		this.stamps = [];
		this.hx = 0;
		this.hz = 0;
		this.hfx = 0;
		this.hfz = - 1;
		this.hasHead = false;
		this.lost = 0;

	}

	reset() {

		this.stamps.length = 0;
		this.hasHead = false;
		this.lost = 0;

	}

	get live() {

		for ( let i = 0; i < this.stamps.length; i ++ ) {

			if ( vWakeStampAmp( this.stamps[ i ] ) > 0.001 ) return true;

		}
		return false;

	}

	/**
	 * @param {number} dt
	 * @param {{x:number,z:number,fx:number,fz:number,amp:number}|null} contact
	 * @param {{life?:number, spacing?:number}} [opts]
	 */
	step( dt, contact, opts ) {

		const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
		const life = Math.max( opts?.life ?? V_WAKE_LIFE, 0.4 );
		const spacing = Math.max( opts?.spacing ?? V_WAKE_SPACING, 2 );
		const keep = [];
		for ( let i = 0; i < this.stamps.length; i ++ ) {

			const s = this.stamps[ i ];
			s.age += d;
			if ( s.age < s.life && s.amp > 0.02 ) keep.push( s );

		}
		this.stamps = keep;

		if ( ! contact || ! ( contact.amp > 0.02 ) ) {

			this.lost += d;
			if ( this.lost > 0.35 ) this.hasHead = false;
			return;

		}
		this.lost = 0;
		const tx = contact.x, tz = contact.z;
		const tfx = contact.fx, tfz = contact.fz;
		if ( ! Number.isFinite( tx ) || ! Number.isFinite( tz ) ) return;
		// The first-cut sample hops between stations. Chase it so the
		// vertex slides along the body instead of teleporting.
		const tau = Math.max( opts?.slide ?? V_WAKE_SLIDE, 0.04 );
		const k = 1 - Math.exp( - d / tau );
		if ( ! this.hasHead ) {

			this.hx = tx;
			this.hz = tz;
			this.hfx = tfx;
			this.hfz = tfz;
			this.hasHead = true;

		} else {

			this.hx += ( tx - this.hx ) * k;
			this.hz += ( tz - this.hz ) * k;
			this.hfx += ( tfx - this.hfx ) * k;
			this.hfz += ( tfz - this.hfz ) * k;
			const fl = Math.hypot( this.hfx, this.hfz ) || 1;
			this.hfx /= fl;
			this.hfz /= fl;

		}
		const x = this.hx, z = this.hz, fx = this.hfx, fz = this.hfz;
		const last = this.stamps[ this.stamps.length - 1 ];
		if ( last && last.age < 0.28
			&& Math.hypot( last.x - x, last.z - z ) < spacing ) {

			last.x = x;
			last.z = z;
			last.fx = fx;
			last.fz = fz;
			last.amp = contact.amp;
			last.life = life;
			last.age = 0;
			return;

		}
		this.stamps.push( {
			x, z, fx, fz,
			amp: contact.amp,
			age: 0,
			life,
		} );
		if ( this.stamps.length > V_WAKE_STAMPS ) this.stamps.shift();

	}

}
