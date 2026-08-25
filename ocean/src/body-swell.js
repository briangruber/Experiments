// Just-under sea response for any OceanBody: the dorsal pressure dome,
// the co-moving bow heap, and the rigid occupancy loaf along the mass.
//
// These are the same three terms the sea dragon writes into uSwell*
// (demo/three-main.js). The water shader already knows them
// (swellLift in src/gpu/tsl/water-surface.js). This module is the CPU
// side — proximity, ease, and a uniform payload — so a box or any other
// mesh can toggle the look without a creature controller.
//
// Expanding ripple packets stay off here. On the dragon they were the
// leftover compass arcs; the whale look is bow + dome (+ a rigid loaf).

import { swellProximity } from './cut-ripples.js';
import { pressureDomeRadii } from './fluke-slicks.js';

const EASE_TAU = 0.16;

export function swellDefaults( size = {}, extras = {} ) {

	const H = Math.max( size.y ?? extras.height ?? 0.5, 0.15 );
	const L = Math.max( extras.length ?? size.z ?? 2, 0.4 );
	const B = Math.max( extras.beam ?? size.x ?? 0.6, 0.2 );
	return {
		mound: Math.max( 0.12, H * 0.4 ),
		dome: Math.max( 0.2, H * 0.7 ),
		bow: Math.max( 0.22, H * 0.85 ),
		radius: Math.max( B * 0.45, H * 0.55, 0.2 ),
		near: Math.max( L * 0.35, H * 4, 2 ),
		fade: Math.max( L * 0.45, H * 6, 3 ),
		emerge: Math.max( H * 2, 1 ),
		soft: 1,
		bowSoft: 1,
	};

}

function scaleAmps( cfg, gain ) {

	if ( gain === 1 ) return cfg;
	return {
		...cfg,
		mound: cfg.mound * gain,
		dome: cfg.dome * gain,
		bow: cfg.bow * gain,
	};

}

/**
 * `false` / `0` / omitted → off.
 * `true` / `1` → size-scaled defaults.
 * A number → defaults × that gain.
 * An object merges over defaults. `on: 0` is off; `on` as a number is gain.
 */
export function parseSwell( value, size = {}, extras = {} ) {

	if ( value === false || value == null || value === 0 ) return null;
	const d = swellDefaults( size, extras );
	if ( value === true || value === 1 ) return d;
	if ( typeof value === 'number' ) {

		if ( ! ( value > 0.001 ) ) return null;
		return scaleAmps( d, value );

	}

	const on = value.on;
	if ( on === false || on === 0 ) return null;
	const gain = on == null || on === true ? 1 : on;
	if ( ! ( gain > 0.001 ) ) return null;
	const merged = { ...d, ...value };
	delete merged.on;
	return scaleAmps( merged, gain );

}

export function easeToward( current, want, dt, tau = EASE_TAU ) {

	const t = 1 - Math.exp( - Math.max( dt, 0 ) / tau );
	return current + ( want - current ) * t;

}

/** Nose and dorsal stations in world space. Bow is on -Z at heading 0. */
export function swellStations( body, sea = 0 ) {

	const L = Math.max( body.length ?? body.size?.z ?? 2, 0.4 );
	const H = Math.max( body.size?.y ?? 0.5, 0.15 );
	const heading = body.heading ?? 0;
	const pitch = body.pitch ?? 0;
	const hx = Math.sin( heading );
	const hz = - Math.cos( heading );
	const along = L * 0.48;
	const cp = Math.cos( pitch );
	const sp = Math.sin( pitch );
	const x = body.pos?.[ 0 ] ?? 0;
	const y = body.pos?.[ 1 ] ?? 0;
	const z = body.pos?.[ 2 ] ?? 0;
	const noseY = y + along * sp;
	const topY = y + H * 0.5 * Math.max( cp, 0.25 );
	return {
		hx, hz, L, H,
		x, y, z,
		noseX: x + hx * along * cp,
		noseY,
		noseZ: z + hz * along * cp,
		topY,
		noseClear: sea - noseY,
		backClear: sea - topY,
	};

}

/**
 * A leap owns the splash field, not this loaf. If we keep easing the
 * dome toward zero while writing the current XZ, a 6 m hill slides
 * under the flying body and reads as water coming out with it.
 */
export function swellReleased( body, st ) {

	const c = body?.controller;
	if ( c?.jumpAirborne || body?.jumpAirborne ) return true;
	if ( body?.airborne || c?.airborne ) return true;
	const jumping = !!( c?.jumping || body?.jumping );
	const phase = c?.jumpPhase ?? body?.jumpPhase;
	// The landing / sounding is spray + a ring, not the swim loaf.
	// Easing the dome back in on the slap used to raise a 6 m cone
	// that sat on the body for the whole float-back.
	if ( jumping && phase === 'water' ) return true;
	if ( ! jumping ) return false;
	if ( phase !== 'air' && phase !== 'rise' ) return false;
	if ( ! st ) return false;
	return Math.min( st.noseClear, st.backClear ) < 0;

}

/**
 * One frame of eased swell uniforms, or null when nothing is live.
 * `ease` is mutated (`{ mound, dome, bow }`).
 */
export function stepSwell( body, dt, opts = {}, ease = body._swellEase ) {

	if ( ! ease ) {

		ease = { mound: 0, dome: 0, bow: 0 };
		if ( body ) body._swellEase = ease;

	}

	const cfg = parseSwell( body?.swell, body?.size, {
		length: body?.length,
		beam: body?.beam,
	} );
	const sea = body?._primed && Number.isFinite( body.surf )
		? body.surf
		: ( opts.seaLevel ?? 0 );
	const scale = opts.scale ?? 1;
	const st = swellStations( body || { pos: [ 0, 0, 0 ], size: { x: 1, y: 1, z: 2 } }, sea );
	if ( swellReleased( body, st ) ) {

		ease.bow = 0;
		ease.dome = 0;
		ease.mound = 0;
		return null;

	}

	const near = cfg?.near ?? 3;
	const fade = cfg?.fade ?? 4;
	const emerge = cfg?.emerge ?? 1.2;
	const bowWant = cfg ? ( cfg.bow * scale * swellProximity( st.noseClear, near, emerge ) ) : 0;
	const domeWant = cfg ? ( cfg.dome * scale * swellProximity( st.backClear, near, emerge ) ) : 0;
	const moundWant = cfg ? ( cfg.mound * scale * swellProximity( st.backClear, fade, emerge ) ) : 0;
	ease.bow = easeToward( ease.bow, bowWant, dt );
	ease.dome = easeToward( ease.dome, domeWant, dt );
	ease.mound = easeToward( ease.mound, moundWant, dt );
	if ( ease.bow <= 0.02 && ease.dome <= 0.02 && ease.mound <= 0.0005 ) return null;

	const B = Math.max( body?.beam ?? body?.size?.x ?? 0.6, 0.2 );
	const rh = Math.min( Math.max( B * 0.55, cfg?.radius ?? 0.3, 0.25 ), 4.2 );
	const domeR = pressureDomeRadii( st.L, B, ease.dome, cfg?.soft ?? 1 );
	return {
		pos: [ st.x, st.y, st.z ],
		dir: [ st.hx, st.hz ],
		len: st.L,
		rad: cfg?.radius ?? Math.max( B * 0.45, 0.2 ),
		amp: ease.mound,
		pitch: body?.pitch ?? 0,
		bow: {
			x: st.noseX,
			z: st.noseZ,
			amp: ease.bow,
			rh,
			soft: cfg?.bowSoft ?? 1,
		},
		dome: {
			x: st.x,
			z: st.z,
			amp: ease.dome,
			along: domeR.along,
			across: domeR.across,
		},
	};

}
