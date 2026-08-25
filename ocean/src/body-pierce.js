// Per-mesh cut for any OceanBody.
//
// A profiled mesh (`sprayStations`) cuts along the waterline outline —
// the same pierce runs spray uses. Anything else is a vertical rod at
// one mesh point (default: middle of the dorsal AABB). Live when that
// outline meets the sea: collar, heap, draw-down, hollow, plus a
// shallow look-through along the steel. `life` is seconds the leftover
// trail stays behind the cut.
//
//   false / 0 / omitted / { on: 0 }  → off
//   true / 1                         → size-scaled defaults
//   a number                         → defaults × that gain
//   { r, height, life, gain, rim, bow, marker, … } → merge over defaults
//
// `height` is metres of rod above the attachment point (world +Y).
// `life` is seconds the leftover trench stays after the rod has passed.
// 0 is the live well only.
// `marker` 1 shows the amber overlay rod; 0 (the default) hides it.
// `along` is −1 bow … 0 middle … +1 stern. `up` is 0 at the origin,
// 1 at the top of the AABB. `across` is −1 port … +1 starboard.
// `band` is metres of slack at the waterline.
//
// The TSL twin is one site (src/gpu/tsl/pierce.js). BodyList picks
// the same way swell does: a piloted / driven body first.

import { PIERCE_DEFAULTS, pierceDraft } from './pierce.js';
import { breachRuns } from './breach-emitters.js';

export function pierceDefaults( size = {}, extras = {} ) {

	const B = Math.max( extras.beam ?? size.x ?? 0.6, 0.2 );
	const H = Math.max( size.y ?? extras.height ?? 0.5, 0.15 );
	return {
		...PIERCE_DEFAULTS,
		r: Math.max( B * 0.12, 0.15 ),
		height: Math.max( H * 0.75, 2 ),
		life: 6,
		band: 0.2,
		along: 0,
		up: 1,
		across: 0,
		/** Amber overlay rod. Off by default; 1 shows it. The cut still runs. */
		marker: 0,
	};

}

function pierceTravel( body ) {

	const heading = body?.heading ?? 0;
	const speed = body?.speed ?? 0;
	let vx = body?.vel?.[ 0 ];
	let vz = body?.vel?.[ 2 ];
	if ( ! Number.isFinite( vx ) || ! Number.isFinite( vz )
		|| Math.hypot( vx, vz ) < 1e-4 ) {

		vx = Math.sin( heading ) * speed;
		vz = - Math.cos( heading ) * speed;

	}
	return { heading, speed, vx, vz };

}

function scaleGain( cfg, gain ) {

	if ( gain === 1 ) return cfg;
	return { ...cfg, gain: Math.max( cfg.gain, 0 ) * gain };

}

/**
 * `false` / `0` / omitted → off.
 * `true` / `1` → size-scaled defaults (a rod at the middle top).
 * A number → defaults × that gain.
 * An object merges over defaults. `on: 0` is off; `on` as a number is gain.
 */
export function parsePierce( value, size = {}, extras = {} ) {

	if ( value === false || value == null || value === 0 ) return null;
	const d = pierceDefaults( size, extras );
	if ( value === true || value === 1 ) return d;
	if ( typeof value === 'number' ) {

		if ( ! ( value > 0.001 ) ) return null;
		return scaleGain( d, value );

	}

	const on = value.on;
	if ( on === false || on === 0 ) return null;
	const gain = on == null || on === true ? 1 : on;
	if ( ! ( gain > 0.001 ) ) return null;
	const merged = { ...d, ...value };
	delete merged.on;
	return scaleGain( merged, gain );

}

/**
 * Craft-local metres of the rod BASE. Origin is the body origin
 * (AABB centre): +Y up, +X starboard, +Z aft.
 */
export function pierceLocalOffset( size = {}, cfg = {}, extras = {} ) {

	const L = Math.max( extras.length ?? size.z ?? 2, 0.4 );
	const H = Math.max( size.y ?? 0.5, 0.15 );
	const B = Math.max( extras.beam ?? size.x ?? 0.6, 0.2 );
	const along = cfg.along ?? 0;
	const up = cfg.up ?? 1;
	const across = cfg.across ?? 0;
	return {
		x: across * B * 0.5,
		y: up * H * 0.5,
		z: along * L * 0.5,
	};

}

/**
 * One circular pierce site for a vertical rod whose base is (wx,wy,wz)
 * and whose top is `height` metres up. Null when the rod is entirely
 * above the sea or entirely below it (does not break the surface).
 */
export function pierceSiteFrom( wx, wy, wz, body, cfg, sea = 0 ) {

	if ( ! cfg ) return null;
	const band = Math.max( cfg.band ?? 0.2, 0 );
	const height = Math.max( cfg.height ?? 0, 0 );
	const topY = wy + height;
	if ( topY < sea - band ) return null;
	if ( wy > sea + band ) return null;

	const { speed, vx, vz } = pierceTravel( body );

	const well = Math.max( 0, Math.min( sea, topY ) - wy );

	return {
		x: wx,
		z: wz,
		y: wy,
		height,
		ax: 0,
		az: - 1,
		half: 0,
		r: Math.max( cfg.r ?? 0.15, 0.02 ),
		vx,
		vz,
		speed,
		submerged: Math.max( pierceDraft( wy - band, sea ), well ),
		well,
		gain: cfg.gain,
		rim: cfg.rim,
		bow: cfg.bow,
		side: cfg.side,
		trench: cfg.trench,
		rimReach: cfg.rimReach,
		bowReach: cfg.bowReach,
		sideReach: cfg.sideReach,
		trenchWide: cfg.trenchWide,
		trenchRun: cfg.trenchRun,
		headCap: cfg.headCap,
		wetDepth: cfg.wetDepth,
	};

}

function knobsFrom( cfg ) {

	return {
		gain: cfg.gain,
		rim: cfg.rim,
		bow: cfg.bow,
		side: cfg.side,
		trench: cfg.trench,
		rimReach: cfg.rimReach,
		bowReach: cfg.bowReach,
		sideReach: cfg.sideReach,
		trenchWide: cfg.trenchWide,
		trenchRun: cfg.trenchRun,
		headCap: cfg.headCap,
		wetDepth: cfg.wetDepth,
	};

}

/**
 * Waterline outline of a profiled mesh: a segment along the longest
 * pierce run (the back / fin that actually cuts), not a dorsal pole.
 * Null when nothing breaks the surface. Twin of spray's breachRuns.
 */
export function pierceSiteFromMesh( body, cfg, sea = 0 ) {

	if ( ! cfg || ! body?.sprayStations ) return null;
	const stations = body.sprayStations;
	const origin = body.pos ?? [ 0, 0, 0 ];
	const info = breachRuns( stations, {
		originY: origin[ 1 ],
		pitch: body.pitch ?? 0,
		seaLevel: sea,
		band: Math.max( cfg.band ?? 0.2, 0 ),
		swim: body.spraySwim,
	} );
	const runs = info.runs;
	if ( ! runs?.length ) return null;

	let run = runs[ 0 ];
	for ( let i = 1; i < runs.length; i ++ ) {

		if ( runs[ i ].hi - runs[ i ].lo > run.hi - run.lo ) run = runs[ i ];

	}

	const { heading, speed, vx, vz } = pierceTravel( body );
	const sx = Math.sin( heading );
	const cx = Math.cos( heading );
	const x0 = origin[ 0 ] - sx * run.lo;
	const z0 = origin[ 2 ] + cx * run.lo;
	const x1 = origin[ 0 ] - sx * run.hi;
	const z1 = origin[ 2 ] + cx * run.hi;
	const dx = x1 - x0;
	const dz = z1 - z0;
	const len = Math.hypot( dx, dz );
	const half = len * 0.5;
	const al = len > 1e-6 ? len : 1;
	const r = Math.max( cfg.r ?? 0.15, 0.04 );
	const well = Math.max( cfg.well ?? 0, r * 0.55, 0.14 );
	const vl = Math.hypot( vx, vz );
	const fx = vl > 1e-4 ? vx / vl : sx;
	const fz = vl > 1e-4 ? vz / vl : - cx;

	return {
		x: ( x0 + x1 ) * 0.5,
		z: ( z0 + z1 ) * 0.5,
		y: sea - well,
		height: Math.max( cfg.height ?? 0, 0 ),
		ax: dx / al,
		az: len > 1e-6 ? dz / al : - 1,
		half,
		r,
		vx,
		vz,
		speed,
		submerged: well,
		well,
		tx: ( x0 + x1 ) * 0.5 - fx * half,
		tz: ( z0 + z1 ) * 0.5 - fz * half,
		...knobsFrom( cfg ),
	};

}
