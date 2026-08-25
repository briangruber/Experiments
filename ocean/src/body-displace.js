// Soft displacement around a swimming body, where it meets the sea.
//
// Two modes:
//
//   body.sites   compact Gaussians at waterline cut points (the dragon).
//                A ring extruded along the spine read as two rails across
//                the whole screen; these do not connect and do not extend
//                past the cut.
//   otherwise    analytic filled capsule along the posed spine, for rigid
//                bodies and the curve check.
//
// The TSL in src/gpu/tsl/water-surface.js is a transcription. Keep the
// constants identical — tools/check-swell-curve.mjs is the CPU twin.
// BODY_STATIONS / SWELL_SITES are unrolled in layouted Fns (rules 17 / 18).

export const BODY_STATIONS = 9;
export const SWELL_SITES = 24;

const TAU = 2 * Math.PI;

export function smoothstep( lo, hi, x ) {

	const t = Math.min( Math.max( ( x - lo ) / ( hi - lo ), 0 ), 1 );
	return t * t * ( 3 - 2 * t );

}

/**
 * Fat amidships, dying at the tips — the same envelope the old Gaussian
 * used for both amplitude and width. A constant tube would read as a
 * sausage under an eel-shaped mesh; this is the profile that already
 * lived on the water, not a new invention.
 */
export function stationTaper( along, half ) {

	return smoothstep( 1.0, 0.25, Math.abs( along ) / Math.max( half, 0.5 ) );

}

export function stationRadius( along, half, rad ) {

	const taper = stationTaper( along, half );
	return Math.max( rad, 0.5 ) * ( 0.55 + 0.45 * taper );

}

/**
 * World XZ of station `s` (0 at the nose, 1 at the tail). Identical to
 * creature.js's vertex offset composed with the pitch=roll=0 craft basis
 * — the curve check-swell-curve.mjs already demanded of the old mound.
 *
 * Pitch is deliberately NOT applied in XZ: the mesh's heading spine is
 * the 2D travelling sine, and foreshortening it by cos(pitch) would
 * disagree with that check. Pitch lives in Y (spineStation).
 */
export function spinePoint( bodyXZ, heading, s, lengthM, waves, ampFrac, phase ) {

	const half = Math.max( lengthM * 0.5, 0.5 );
	const dirx = Math.sin( heading );
	const dirz = - Math.cos( heading );
	const along = half * ( 1 - 2 * s );
	const perpX = - dirz, perpZ = dirx;
	const k = waves * TAU;
	const ph = s * k - phase;
	const ramp = smoothstep( 0.06, 0.85, s );
	const lateral = Math.sin( ph ) * ampFrac * lengthM * ramp;
	return [
		bodyXZ[ 0 ] + dirx * along + perpX * lateral,
		bodyXZ[ 1 ] + dirz * along + perpZ * lateral,
	];

}

/**
 * One station on the posed spine.
 *
 * Y is origin Y + pitch along the body + the mesh's vertical heave
 * (scaled by cos(pitch), the same way breachRuns() poses a local Y).
 * Nose sits at local −Z; positive pitch raises it
 * (`along * sin(pitch)` with along = +half at the nose).
 */
export function spineStation( s, body ) {

	const len = body.len ?? 20;
	const half = Math.max( len * 0.5, 0.5 );
	const along = half * ( 1 - 2 * s );
	const dirx = body.dirx ?? 0;
	const dirz = body.dirz ?? 1;
	const perpX = - dirz, perpZ = dirx;
	const k = ( body.waves ?? 0 ) * TAU;
	const ph = s * k - ( body.phase ?? 0 );
	const ramp = smoothstep( 0.06, 0.85, s );
	const lateral = Math.sin( ph ) * ( body.sweep ?? 0 ) * len * ramp;
	const heave = Math.sin( ph + ( body.liftPhase ?? 0 ) ) * ( body.lift ?? 0 ) * len * ramp;
	const pitch = body.pitch ?? 0;
	const ox = body.x ?? 0, oy = body.y ?? 0, oz = body.z ?? 0;
	return {
		x: ox + dirx * along + perpX * lateral,
		y: oy + along * Math.sin( pitch ) + heave * Math.cos( pitch ),
		z: oz + dirz * along + perpZ * lateral,
		r: stationRadius( along, half, body.rad ?? 7 ),
		along,
		s,
	};

}

/** Vertical chord of a station sphere at a water-plane sample. half = 0 outside. */
export function stationColumn( px, pz, st ) {

	const dx = px - st.x, dz = pz - st.z;
	const d2 = dx * dx + dz * dz;
	const r2 = st.r * st.r;
	const inside = d2 < r2;
	const half = Math.sqrt( Math.max( 0, r2 - d2 ) );
	return { half, top: st.y + half, bot: st.y - half, inside };

}

/** Soft unit bump over one spine segment. 0 unless that slice pierces the sea. */
export function ridgeSegment( px, pz, a, b, sea ) {

	const abx = b.x - a.x, abz = b.z - a.z;
	const len2 = abx * abx + abz * abz;
	let t = 0;
	if ( len2 > 1e-8 ) {

		t = Math.min( 1, Math.max( 0, ( ( px - a.x ) * abx + ( pz - a.z ) * abz ) / len2 ) );

	}
	const qx = a.x + t * abx, qz = a.z + t * abz;
	const across = Math.hypot( px - qx, pz - qz );
	const y = a.y + ( b.y - a.y ) * t;
	const r = Math.max( a.r + ( b.r - a.r ) * t, 0.5 );
	if ( across > r * 2.2 ) return { mound: 0, cavity: 0 };
	const top = y + r;
	const bot = y - r;
	if ( ! ( top > sea && bot < sea ) ) return { mound: 0, cavity: 0 };
	const falloff = Math.exp( - ( across * across ) / ( r * r ) );
	return { mound: falloff, cavity: falloff };

}

/**
 * Unit bump at waterline cut points. Each site is a compact Gaussian;
 * nothing connects them, so two fins cannot grow a rail through the neck
 * or off the ends of the animal.
 */
export function sitesOccupancy( px, pz, sites ) {

	let h = 0;
	if ( ! sites ) return 0;
	for ( let i = 0; i < sites.length; i ++ ) {

		const s = sites[ i ];
		const w = s.width ?? s.r ?? s[ 2 ];
		if ( ! ( w > 0.05 ) ) continue;
		const sx = s.x ?? s[ 0 ], sz = s.z ?? s[ 1 ];
		const ring = s.ring ?? 0;
		const d = Math.hypot( px - sx, pz - sz );
		const dist = Math.abs( d - ring );
		if ( dist > w * 2.2 ) continue;
		h += Math.exp( - ( dist * dist ) / ( w * w ) ) * ( s.amp ?? 1 );

	}
	return h;

}

/**
 * Geometric occupancy at a water-plane sample, in metres, before the
 * artist envelope. sign >= 0 follows the back; sign < 0 opens a cavity.
 */
export function bodyOccupancy( px, pz, body ) {

	if ( body.sites ) {

		const h = sitesOccupancy( px, pz, body.sites );
		return ( body.sign ?? 1 ) >= 0 ? h : - h;

	}
	const sea = body.sea ?? 0;
	const sign = body.sign ?? 1;
	let mound = 0, cavity = 0;
	const n = BODY_STATIONS;
	let prev = null;
	for ( let i = 0; i < n; i ++ ) {

		const st = spineStation( i / ( n - 1 ), body );
		if ( prev ) {

			const seg = ridgeSegment( px, pz, prev, st, sea );
			mound = Math.max( mound, seg.mound );
			cavity = Math.max( cavity, seg.cavity );

		}
		prev = st;

	}
	return sign >= 0 ? mound : - cavity;

}

/**
 * Height the sea should move. Occupancy is 0..1; `amp` is the artist
 * metres (already scaled by waterDisplaceScale). Do not multiply by
 * (back − sea) — that is the glass barrel.
 */
export function bodyDisplace( px, pz, body ) {

	const amp = body.amp ?? 0;
	if ( ! ( Math.abs( amp ) > 1e-8 ) ) return 0;
	return bodyOccupancy( px, pz, { ...body, sign: Math.sign( amp ) || 1 } ) * Math.abs( amp );

}
