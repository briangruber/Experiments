// What the surface does where a solid actually goes through it.
//
// One pierce site is the waterline OUTLINE of the thing — a slender
// segment (`half` long, `r` thick), which is a fin's chord, a hull's
// waterline cut, or a plain circle when `half` is 0 — plus how fast it
// is moving. Every term is measured from `s`, the distance outside that
// outline, so a fat mesh and a wire read the same at the same distance
// from the steel.
//
// Height is four things summed, all scaled by the dynamic head
// eta = v² / 2g. That is the only length a moving obstacle gives you,
// and it is why a fin at 3 m/s lifts tens of centimetres while the same
// fin at 0.3 m/s barely marks the surface:
//
//   rim     a collar of water standing against the wetted surface.
//           Displaced volume, so it is there at a dead stop too.
//   bow     the stagnation heap ahead: flow stops on the leading face
//           and that pressure becomes height.
//   sides   flow accelerates around the shoulders, pressure drops, the
//           surface is pulled DOWN. This is the term that makes a fin
//           look like it is cutting instead of floating.
//   trench  the hollow directly astern that has not closed yet. It
//           shuts over a length that grows with speed.
//
// Radiating waves are deliberately NOT here. Rings shed from the same
// site are src/wake-wave.js, and their interference is the V — building
// a second travelling-wave model inside the near field is how you get
// two wakes that disagree. Twin: src/gpu/tsl/pierce.js. A change here
// is not done until tools/check-pierce.mjs passes.

export const PIERCE_GRAVITY = 9.81;

/**
 * Defaults are a shark fin at a few metres a second: a hand-sized
 * collar, a heap of a dozen-odd centimetres at 3 m/s, shoulders drawn
 * down most of that, and a hollow a couple of metres long.
 *
 * The gains are FRACTIONS of the head on purpose. A blade is not a
 * bluff body — it slices, so only a part of the flow ever stagnates on
 * it. Handing a fin the whole head built a metre-high hill in front of
 * a metre-high fin, which is the first thing this lab showed.
 */
export const PIERCE_DEFAULTS = {
	/** Master gain. 0 is a body that does not touch the surface. */
	gain: 1,
	/** Collar height (m) at rest. It grows with the head. */
	rim: 0.06,
	/** Heap ahead, × head. */
	bow: 0.3,
	/** Draw-down at the shoulders, × head. */
	side: 0.22,
	/** Depth of the hollow astern, × head. */
	trench: 0.4,
	// Reaches are MULTIPLES of the site's own size (pierceScale), never
	// metres. A fin's heap runs a metre; the same numbers on a whale's
	// back run ten, which is the whole point of tuning on a rod and
	// reusing it on a mesh.
	/** Collar reach, × site size. */
	rimReach: 1.3,
	/** Reach of the heap ahead, × site size. */
	bowReach: 4.6,
	/** Reach of the draw-down, × site size. */
	sideReach: 4,
	/** Half-width of the hollow, × site size. */
	trenchWide: 2.7,
	/** How far astern the hollow closes, × site size, before speed. */
	trenchRun: 8,
	/** Metres of head a fast body is allowed. 20 m/s is not a 20 m wall. */
	headCap: 1.2,
	/** Draft (m) at which the site counts as fully in the water. */
	wetDepth: 0.3,
	/** Metres to drop the surface *inside* the outline. 0 is the old
	 *  near-field only (collar / heap / draw-down / hollow). A rod
	 *  poking through sets this to how far the base sits under the sea,
	 *  so the cut is a well down to the steel, not a stamp on the plane. */
	well: 0,
};

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function smoothstep( a, b, x ) {

	const t = clamp( ( x - a ) / Math.max( b - a, 1e-6 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

/** Dynamic head (m): the height the flow's own speed is worth. */
export function pierceHead( speed, cap = PIERCE_DEFAULTS.headCap ) {

	const v = Math.abs( speed ?? 0 );
	return Math.min( v * v / ( 2 * PIERCE_GRAVITY ), Math.max( cap, 0 ) );

}

/**
 * The four amplitudes in metres, already carrying speed, draft and
 * gain. The shader is handed exactly these, so CPU and GPU cannot
 * drift on the physics — only on the geometry.
 *
 * @param {object} u site + knobs; `speed` wins over `vx`/`vz`
 */
export function pierceAmps( u = {} ) {
	const k = { ...PIERCE_DEFAULTS, ...u };
	const speed = u.speed != null
		? Math.abs( u.speed )
		: Math.hypot( u.vx ?? 0, u.vz ?? 0 );
	const eta = pierceHead( speed, k.headCap );
	const wet = smoothstep( 0, Math.max( k.wetDepth, 1e-3 ), u.submerged ?? 0 );
	const g = Math.max( k.gain, 0 ) * wet;
	return {
		// A parked hull still holds its collar; motion piles more on.
		rim: Math.max( k.rim, 0 ) * ( 1 + eta ) * g,
		bow: Math.max( k.bow, 0 ) * eta * g,
		side: Math.max( k.side, 0 ) * eta * g,
		trench: Math.max( k.trench, 0 ) * eta * g,
		eta,
		wet,
		speed,
	};
}

/** Centimetres of occupancy lip. The well is a per-pixel cylinder plus
 *  dedicated wall geometry (`src/gpu/pierce-well.js`); a metre ramp on
 *  the sea mesh was the side-on sawtooth. `well` is kept so callers
 *  that passed it do not have to change. */
export function pierceWellWall( r = 0.15, well = 0 ) {

	void well;
	return Math.max( Math.max( r, 0.15 ) * 0.28, 0.08 );

}

/** How far (m) the surface drops inside the outline. Geometric, not
 *  speed and not gain — the steel is still there when the collar is off. */
export function pierceWellAmp( u = {} ) {

	return Math.max( u.well ?? 0, 0 );

}

/**
 * 1 inside the steel, 0 outside, blended across pierceWellWall.
 * Twin of the occupancy term in src/gpu/tsl/pierce.js.
 */
export function pierceOccupancy( px, pz, u = {} ) {

	const dx = px - ( u.x ?? 0 );
	const dz = pz - ( u.z ?? 0 );
	const al = Math.hypot( u.ax ?? 0, u.az ?? - 1 ) || 1;
	const ax = ( u.ax ?? 0 ) / al;
	const az = ( u.az ?? - 1 ) / al;
	const half = Math.max( u.half ?? 0, 0 );
	const t = clamp( dx * ax + dz * az, - half, half );
	const radial = Math.hypot( dx - ax * t, dz - az * t );
	const r = Math.max( u.r ?? 0.15, 0.02 );
	const wall = pierceWellWall( r, u.well ?? 0 );
	return 1 - smoothstep( r, r + wall, radial );

}

/**
 * The size of the site itself (m): its thickness, or half its chord if
 * that is larger. Every reach is measured in these.
 */
export function pierceScale( u = {} ) {

	return Math.max( u.r ?? 0.15, ( u.half ?? 0 ) * 0.5, 0.08 );

}

/** How far astern the hollow takes to close (m), speed included. */
export function pierceTrenchLen( k = PIERCE_DEFAULTS, eta = 0, scale = 0.3 ) {

	return Math.max( ( k.trenchRun ?? PIERCE_DEFAULTS.trenchRun ) * scale, 0.2 )
		* ( 0.4 + eta * 0.9 );

}

/** How far behind the trailing edge the hollow opens (m). */
export function pierceTrenchOpen( scale = 0.3 ) {

	return Math.max( scale * 1.2, 0.1 );

}

/** Distance from a world point to the outline segment, minus its thickness. */
export function pierceOutlineDist( px, pz, u = {} ) {

	const dx = px - ( u.x ?? 0 );
	const dz = pz - ( u.z ?? 0 );
	const al = Math.hypot( u.ax ?? 0, u.az ?? - 1 ) || 1;
	const ax = ( u.ax ?? 0 ) / al;
	const az = ( u.az ?? - 1 ) / al;
	const half = Math.max( u.half ?? 0, 0 );
	const t = clamp( dx * ax + dz * az, - half, half );
	const qx = dx - ax * t;
	const qz = dz - az * t;
	return Math.max( Math.hypot( qx, qz ) - Math.max( u.r ?? 0.15, 0.02 ), 0 );

}

/**
 * Height (m) of the near field at a world XZ point.
 * Twin: pierceCore() in src/gpu/tsl/pierce.js.
 *
 * @param {object} u site: x, z, ax, az (outline axis), half, r,
 *   vx, vz (or speed + heading dir), submerged, and any knob overrides
 * @param {object} [amps] from pierceAmps(u); passed in when a caller
 *   already has them (the shader path always does)
 */
export function pierceAt( px, pz, u = {}, amps = null ) {

	const a = amps ?? pierceAmps( u );
	const k = { ...PIERCE_DEFAULTS, ...u };
	const well = pierceWellAmp( u );
	if ( ! ( well > 1e-4 || a.rim > 1e-4 || a.bow > 1e-4 || a.side > 1e-4 || a.trench > 1e-4 ) ) {

		return { h: 0 };

	}
	const s = pierceOutlineDist( px, pz, u );
	const dx = px - ( u.x ?? 0 );
	const dz = pz - ( u.z ?? 0 );
	const dist = Math.hypot( dx, dz );

	// Direction of travel splits the field into ahead / abeam / astern.
	// A parked site has no direction, so it keeps the collar only.
	const vl = Math.hypot( u.vx ?? 0, u.vz ?? 0 );
	const vhx = vl > 1e-4 ? ( u.vx ?? 0 ) / vl : 0;
	const vhz = vl > 1e-4 ? ( u.vz ?? 0 ) / vl : 0;
	const fore = dx * vhx + dz * vhz;
	const cosT = fore / Math.max( dist, 1e-4 );
	const lateral = Math.abs( - dx * vhz + dz * vhx );
	const aft = Math.max( - fore, 0 );

	const gauss = ( x, w ) => Math.exp( - ( x * x ) / Math.max( w * w, 1e-6 ) );
	const sc = pierceScale( u );

	const rim = a.rim * gauss( s, k.rimReach * sc );
	const bow = a.bow * gauss( s, k.bowReach * sc ) * Math.max( cosT, 0 );
	const side = a.side * gauss( s, k.sideReach * sc ) * ( 1 - cosT * cosT );
	// The hollow opens BEHIND the trailing edge (a thicker body opens it
	// further back) and closes over a length that grows with speed: at a
	// crawl it shuts right there, at speed you can see it metres astern.
	// Without the opening term the decay reads 1 everywhere ahead, which
	// sank the whole sea in front of the site.
	const trench = a.trench
		* gauss( lateral, k.trenchWide * sc )
		* smoothstep( 0, pierceTrenchOpen( sc ), aft )
		* Math.exp( - aft / pierceTrenchLen( k, a.eta, sc ) );

	const field = rim + bow - side - trench;
	if ( well > 1e-4 ) {

		const occ = pierceOccupancy( px, pz, u );
		return { h: field * ( 1 - occ ) - well * occ };

	}
	return { h: field };

}

/**
 * Sea-level draft of a site: how many metres of the outline are under
 * the surface. Above the water is 0, which switches the whole field off.
 */
export function pierceDraft( lowY, sea = 0 ) {

	return Math.max( sea - ( lowY ?? 0 ), 0 );

}
