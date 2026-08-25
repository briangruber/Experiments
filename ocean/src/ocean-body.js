// OceanBody — any mesh can float, drop, splash, plane, and leave a wake.
//
// The sea itself is one shared field (TslWake / Wake). This module is the
// CPU side: mass vs volume, gravity vs buoyancy, and the feature flags that
// decide whether a body writes that field. A box with the SKI coefficients
// planes, launches, and grips like the ride-demo hull; a crate leaves those
// knobs at zero and just falls and floats. `hover` is ride height, not the
// ignition: writing `throttle` / `steer` drives any floating hull.
// `springiness` (from `launch`) is how readily it leaves the face.
// Controllers are optional input. They must not own a second stepper.
//
// No Three.js import. A mesh is an optional duck-typed Object3D
// (`position`, `rotation`, `geometry`, `scale`). Headless checks drive the
// same integrator with plain numbers.

import { clamp, lerp } from './math.js';
import { wakeFoamChurnK, jetMotionOf } from './wake-interact.js';
import { foamEnergyPlanformSamples } from './foam-energy.js';
import { parseSwell, swellDefaults, stepSwell, swellStations, swellReleased } from './body-swell.js';
import {
	parseWake, parseWakeJet, wakeDefaults, wakeLayers, wakeStampPoint, wakeLifeOf,
	wakeArmRateOf, wakeRenderDimsFrom, wakeBowPoint, wakeSternPoint, isAutoWakeBeam, wakeBeamOf,
	wakeFoamBeamOf, isPhysicsWake, physicsRenderDims,
	WAKE_JET_WIDTH, WAKE_JET_REACH, WAKE_JET_HEIGHT, WAKE_JET_AMOUNT,
	WAKE_JET_SPRAY, WAKE_JET_SPRAY_SPEED, WAKE_JET_SPRAY_RISE, WAKE_JET_SPRAY_ANGLE,
} from './body-wake.js';
import {
	parseSpray, sprayDefaults, stepSpray, stepJetSpray, jetSprayLook, applySprayContext,
	stationsFromSize, sprayExtras, sprayLoad, spraySiteCap, sprayContactPoints,
	jetSprayOf, bodyWantsSpray, withJetSpray,
	wakeCutPoints, wakeRingPoints, wakeFoamPoints, wakeLeadContact,
	wakeSpraySites, wakeBehindPoint, wakeBehindPoints, WAKE_CUT_MAX,
} from './body-spray.js';
import {
	parsePierce, pierceDefaults, pierceLocalOffset, pierceSiteFrom,
	pierceSiteFromMesh,
} from './body-pierce.js';
import { FlukeSlickField, flukeWorld } from './fluke-slicks.js';
import { PierceCarveField } from './pierce-carve.js';
import { VWakeField, vWakeWrite, V_WAKE_TAN } from './v-wake.js';
import {
	WakeWaveField, wakeWaveAt, wakeWaveFieldAt, wakeWaveSlopeAt,
	wakeWaveSlopeFieldAt, wakeWaveContactFrom, wakeWaveContactsFrom,
	wakeWaveImpulse, froudeLength, froudeDepth, froudeHumpFactor, froudeShallowResonance,
} from './wake-wave.js';
import { RippleField } from './ripple-field.js';
// Some names below are imported only to be re-exported further down.
// tools/bundle-three.mjs has no representation for a re-export that names
// its source module, and it rewrites an import list onto a single line, so
// keep these lists plain: no comments inside the braces.
import {
	LeftoverBubbleField, parseLeftoverBubbles, leftoverBubbleHull,
	leftoverBubbleRide, LEFTOVER_BUBBLE_DIVERGE,
	leftoverBubbleAlpha, leftoverBubbleInHull, leftoverBubbleBirthXZ,
	leftoverSplashBirthXZ, leftoverBubbleDiverge,
} from './leftover-bubbles.js';
import {
	hullSpeed, hullRippleSite, leftoverTileOrigin, rippleDisplaceGain,
	LEFTOVER_BANDS, LEFTOVER_TILE, LEFTOVER_HEIGHT_CAP, leftoverSplashHeight,
	leftoverBowSplashRadius, leftoverBowSplashGain, leftoverJetSplashSpan, leftoverWriteFootprint,
	LEFTOVER_SPLASH_MIN_SPEED, leftoverBandSite, leftoverSurge, leftoverEmitPoints,
	leftoverWriteSites, leftoverCutStations,
	wakeRegime, hullRunningTrim, hullTrimFromAccel,
	wakePhysicsAt, wakePhysicsInfo, wakePhysicsAmp, gravityWavelength,
	wavemakingGain, planingFraction, TRIM_HUMP, TRIM_PLANE, TRIM_ACCEL,
	gravityWaveSpeed, leftoverChurn, leftoverCapStations, leftoverEmitMax,
	leftoverHullDraft, leftoverSlam, leftoverStationWeight, leftoverEmitStrength,
	wakePhysicsGeometryMask,
} from './wake-physics.js';

export { parseSwell, swellDefaults, stepSwell, swellStations, swellReleased };
export {
	parseWake, parseWakeJet, wakeDefaults, wakeLayers, wakeStampPoint, wakeLifeOf,
	wakeArmRateOf, wakeRenderDimsFrom, wakeBowPoint, wakeSternPoint, isAutoWakeBeam, wakeBeamOf,
	wakeFoamBeamOf, isPhysicsWake, physicsRenderDims,
	WAKE_JET_WIDTH, WAKE_JET_REACH, WAKE_JET_HEIGHT, WAKE_JET_AMOUNT,
	WAKE_JET_SPRAY, WAKE_JET_SPRAY_SPEED, WAKE_JET_SPRAY_RISE, WAKE_JET_SPRAY_ANGLE,
};
export {
	wakePhysicsAt, wakePhysicsInfo, wakePhysicsAmp, hullSpeed, gravityWavelength,
	wakeRegime, wavemakingGain, planingFraction,
	hullRunningTrim, hullTrimFromAccel, TRIM_HUMP, TRIM_PLANE, TRIM_ACCEL,
	hullRippleSite, leftoverTileOrigin, rippleDisplaceGain,
	gravityWaveSpeed, leftoverChurn, leftoverSurge, leftoverEmitPoints,
	leftoverWriteSites, leftoverCutStations, leftoverCapStations, leftoverEmitMax,
	leftoverHullDraft, leftoverSlam, leftoverStationWeight, leftoverEmitStrength,
	wakePhysicsGeometryMask,
	LEFTOVER_BANDS, LEFTOVER_TILE, LEFTOVER_HEIGHT_CAP, leftoverSplashHeight,
	leftoverBowSplashRadius, leftoverBowSplashGain, leftoverJetSplashSpan, leftoverWriteFootprint,
	LEFTOVER_SPLASH_MIN_SPEED, leftoverBandSite,
};
export {
	LeftoverBubbleField, parseLeftoverBubbles, leftoverBubbleAlpha,
	leftoverBubbleHull, leftoverBubbleInHull, leftoverBubbleBirthXZ,
	leftoverSplashBirthXZ, leftoverBubbleRide, leftoverBubbleDiverge,
	LEFTOVER_BUBBLE_DIVERGE,
};
export {
	parseSpray, sprayDefaults, stepSpray, stepJetSpray, jetSprayLook, applySprayContext,
	stationsFromSize, sprayLoad, spraySiteCap, sprayContactPoints,
	jetSprayOf, bodyWantsSpray, withJetSpray, jetMotionOf,
	wakeCutPoints, wakeRingPoints, wakeFoamPoints, wakeLeadContact,
	wakeSpraySites, wakeBehindPoint, wakeBehindPoints, WAKE_CUT_MAX,
};
export { parsePierce, pierceDefaults, pierceLocalOffset, pierceSiteFrom, pierceSiteFromMesh };
export { FlukeSlickField, flukeWorld };
export { VWakeField, vWakeWrite, V_WAKE_TAN };
export {
	WakeWaveField, wakeWaveAt, wakeWaveFieldAt, wakeWaveSlopeAt,
	wakeWaveSlopeFieldAt, wakeWaveContactFrom, wakeWaveContactsFrom,
	wakeWaveImpulse, froudeLength, froudeDepth, froudeHumpFactor, froudeShallowResonance,
};

export const WATER_DENSITY = 1025;   // kg / m³, seawater
export const GRAVITY = 9.81;
/** Metres of water above the high point before leftover foam stops writing. */
export const WAKE_SURFACE_SLACK = 2.4;

/**
 * Slack scales with body height. A ski-sized hull stays at 2.4 m. A
 * 60 m animal (H ≈ 11 m) whose back is a few metres under still works
 * the surface — the silhouette reads as just-under long after a 2.4 m
 * box would count as deep, and a fixed slack then drops the trail.
 */
export function wakeSurfaceSlack( body ) {

	const H = Math.max( body?.size?.y ?? 0.5, 0.15 );
	return Math.max( WAKE_SURFACE_SLACK, H * 0.75 + 1.2 );

}

/** Aft-most waterline cut. Heading 0 is −Z. */
export function aftWakeCut( cuts, heading = 0 ) {

	const fx = Math.sin( heading );
	const fz = - Math.cos( heading );
	let best = cuts[ 0 ];
	let dot = Infinity;
	for ( let i = 0; i < cuts.length; i ++ ) {

		const s = cuts[ i ];
		const x = s.x ?? s[ 0 ];
		const z = s.z ?? s[ 2 ] ?? s[ 1 ];
		const d = x * fx + z * fz;
		if ( d < dot ) {

			dot = d;
			best = s;

		}

	}
	return [ best.x ?? best[ 0 ], best.z ?? best[ 2 ] ?? best[ 1 ] ];

}

/** Aft-most cut as a site (keeps Y / along for fluke prints). */
export function aftWakeSite( cuts, heading = 0 ) {

	if ( ! cuts?.length ) return null;
	if ( cuts.some( ( s ) => s.along != null ) ) {

		let best = cuts[ 0 ];
		for ( let i = 1; i < cuts.length; i ++ ) {

			if ( ( cuts[ i ].along ?? - Infinity ) > ( best.along ?? - Infinity ) ) best = cuts[ i ];

		}

		return best;

	}

	const xz = aftWakeCut( cuts, heading );
	return { x: xz[ 0 ], z: xz[ 1 ], y: cuts[ 0 ].y };

}

/**
 * Water-response coefficients that make any mesh plane like the ride-demo
 * ski. Spread into `bodies.add(mesh, { ...SKI })`. Drive by writing
 * `throttle` / `steer` (and optional `boost` / `carve`) each frame, or by
 * writing `vel` and `heading` directly. `throttle` is −1…1 — the magnitude
 * scales thrust, so a cruise can hold a mid speed instead of only full send.
 */
export const SKI = {
	mass: 1200,
	volume: 7.36,
	size: { x: 2.0, y: 1.15, z: 3.2 },
	drag: 0.25,
	float: true,
	// Gravity-wave leftover + foam-energy ribbon (bow chines).
	// `motor` is the transom jet-tail amount; `wake.jet` adds width /
	// reach / leftover height. Airborne whitewater stays on `spray`.
	wake: {
		on: 1, physics: 1,
		strength: 1.2, depth: 0.56, beam: 0.9,
		origin: - 1, length: 70,
		cut: 0, wave: 0, v: 0, kelvin: 0,
		foam: 1.1, persist: 10.9,
		damp: 1.8, motor: 0.4, emit: 4,
	},
	splash: 'impact',
	// Hull jet / chines. Waterline cuts are the default recipe; a ski
	// is the one body that wants the pump-jet path instead.
	spray: { hull: 1 },
	hull: { push: 1.05, radius: 2.4, bow: 1.25 },
	samples: 5,
	hover: 0.35,
	stiffness: 26,
	damping: 7,
	gravity: 13,
	// Water Pro-style ride: first-order follow + partial wave tilt.
	// A stiff spring on storm chop was the trampoline.
	heightSmoothing: 0.15,
	rotationSmoothing: 0.2,
	rotationInfluence: 0.45,
	// How readily the hull leaves a falling face. 0 is glued; 1 is the
	// SKI crest launch. Hover is ride height, not this.
	springiness: 1,
	launch: 1,
	launchThreshold: 3.2,
	launchG: 0.72,
	jumpSpeed: 5,
	jumpGain: 1.35,
	jumpMax: 6,
	surfFilter: 22,
	landingDrag: 0.35,
	grip: 2.1,
	airGrip: 0.25,
	turnDrag: 0.30,
	topSpeed: 44,
	accel: 19,
	brake: 14,
	boostMul: 1.35,
	turnRate: 0.85,
	steerLag: 5,
	yawInertia: 4.2,
	coastSteer: 0.30,
	airSteer: 0.25,
	bank: 0.55,
	attitudeRate: 9,
	length: 2.4,
	beam: 1.1,
	carveTurn: 1.9,
	carveGrip: 0.45,
	carveDrag: 2.2,
	probeSmooth: 16,
};

let _nextId = 1;

function cubeRoot( v ) {

	return Math.sign( v ) * Math.pow( Math.abs( v ), 1 / 3 );

}

/**
 * Axis-aligned size in metres. Prefers an explicit `size`, then a mesh
 * bounding box (scaled), then a cube that matches `volume`.
 */
export function estimateSize( mesh, opts = {} ) {

	if ( opts.size ) {

		const s = opts.size;
		return { x: Math.max( s.x || s[ 0 ] || 0, 0.05 ), y: Math.max( s.y || s[ 1 ] || 0, 0.05 ), z: Math.max( s.z || s[ 2 ] || 0, 0.05 ) };

	}

	const geo = mesh?.geometry;
	if ( geo ) {

		if ( ! geo.boundingBox && geo.computeBoundingBox ) geo.computeBoundingBox();
		const b = geo.boundingBox;
		if ( b ) {

			const sx = mesh.scale?.x ?? 1, sy = mesh.scale?.y ?? 1, sz = mesh.scale?.z ?? 1;
			return {
				x: Math.max( Math.abs( ( b.max.x - b.min.x ) * sx ), 0.05 ),
				y: Math.max( Math.abs( ( b.max.y - b.min.y ) * sy ), 0.05 ),
				z: Math.max( Math.abs( ( b.max.z - b.min.z ) * sz ), 0.05 ),
			};

		}

	}

	const edge = Math.max( cubeRoot( opts.volume || 0.08 ), 0.05 );
	return { x: edge, y: edge, z: edge };

}

export function estimateVolume( size, opts = {} ) {

	if ( opts.volume > 0 ) return opts.volume;
	return size.x * size.y * size.z;

}

/**
 * How much of a box of height `height` centred at `posY` is under `seaH`.
 * 0 = fully airborne, 1 = fully submerged.
 */
export function immersedFraction( seaH, posY, height ) {

	const h = Math.max( height, 0.05 );
	const bottom = posY - h * 0.5;
	const top = posY + h * 0.5;
	if ( top <= seaH ) return 1;
	if ( bottom >= seaH ) return 0;
	return ( seaH - bottom ) / h;

}

/** Resting waterline: ρ V_im = m  ⇒  fraction = m / (ρ V). */
export function floatFraction( mass, volume, rho = WATER_DENSITY ) {

	return clamp( mass / Math.max( rho * volume, 1e-6 ), 0.02, 0.98 );

}

/** World Y of the box centre at equilibrium on a flat sea. */
export function floatEquilibriumY( seaH, mass, volume, height, rho = WATER_DENSITY ) {

	const frac = floatFraction( mass, volume, rho );
	return seaH - frac * height + height * 0.5;

}

/** Mean sea under the hull. One wild bow sample cannot yank the ride height. */
export function hullRideHeight( h ) {

	if ( h == null ) return 0;
	if ( typeof h === 'number' ) return h;
	const n = h.length ?? 0;
	if ( ! n ) return 0;
	let s = 0;
	for ( let i = 0; i < n; i ++ ) s += h[ i ];
	return s / n;

}

/**
 * Pitch from multi-point samples. 5-point is bow vs stern over the full
 * span; 4-point cross falls back to bow vs centre. Corner layout is
 * bow-pair vs stern-pair of the AABB.
 */
export function hullPitchFrom( h, along, influence = 1, layout = 'cross' ) {

	const L = Math.max( along, 0.4 );
	const k = clamp( influence, 0, 1 );
	if ( ! h || h.length < 2 ) return 0;
	if ( layout === 'corners' && h.length >= 4 ) {

		const bow = 0.5 * ( h[ 0 ] + h[ 1 ] );
		const stern = 0.5 * ( h[ 2 ] + h[ 3 ] );
		return Math.atan2( bow - stern, 2 * L ) * k;

	}
	if ( h.length >= 5 ) return Math.atan2( h[ 1 ] - h[ 2 ], 2 * L ) * k;
	return Math.atan2( h[ 1 ] - h[ 0 ], L ) * k;

}

/** Roll from port / starboard samples, or port-pair vs starboard-pair. */
export function hullRollFrom( h, across, influence = 1, layout = 'cross' ) {

	const W = Math.max( across, 0.2 );
	const k = clamp( influence, 0, 1 );
	if ( ! h || h.length < 4 ) return 0;
	if ( layout === 'corners' ) {

		const port = 0.5 * ( h[ 0 ] + h[ 2 ] );
		const stbd = 0.5 * ( h[ 1 ] + h[ 3 ] );
		return Math.atan2( stbd - port, 2 * W ) * k;

	}
	if ( h.length >= 5 ) return Math.atan2( h[ 4 ] - h[ 3 ], 2 * W ) * k;
	return Math.atan2( h[ 3 ] - h[ 2 ], 2 * W ) * k;

}

function readMeshPos( mesh, out ) {

	if ( ! mesh?.position ) return out;
	out[ 0 ] = mesh.position.x;
	out[ 1 ] = mesh.position.y;
	out[ 2 ] = mesh.position.z;
	return out;

}

/**
 * Orthonormal craft frame used by `demo/craft.js` `setTransform`.
 * Local +X starboard, +Y up, +Z aft — the bow is -Z, world forward is
 * `(sin yaw, 0, -cos yaw)`. Euler `rotation.y = heading` aims -Z the
 * other way, which is why a box looked like it turned the wrong way.
 */
export function craftBasis( yaw, pitch = 0, roll = 0 ) {

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
	const right = r.map( ( v, i ) => v * cr + u[ i ] * sr );
	const up = u.map( ( v, i ) => v * cr - r[ i ] * sr );
	const back = [ - f[ 0 ], - f[ 1 ], - f[ 2 ] ];
	return { forward: f, right, up, back };

}

const BUOY_ROLES_4 = [ 'center', 'bow', 'port', 'starboard' ];
const BUOY_ROLES_5 = [ 'center', 'bow', 'stern', 'port', 'starboard' ];
const BUOY_ROLES_CORNERS = [ 'bow-port', 'bow-starboard', 'stern-port', 'stern-starboard' ];

/**
 * `false` / `0` / omitted → off.
 * `true` / `1` → spray cuts + buoyancy probes + the pole point.
 * `{ spray, buoyancy, pierce, emit }` turns each independently. `on: 0` is off.
 * `emit` is leftover occupancy points — opt-in, not part of `true`.
 */
export function parseDebug( value ) {

	if ( value === false || value == null || value === 0 ) return null;
	if ( value === true || value === 1 ) {

		return { spray: true, buoyancy: true, pierce: true, emit: false };

	}
	if ( typeof value !== 'object' ) {

		return { spray: true, buoyancy: true, pierce: true, emit: false };

	}
	if ( value.on === false || value.on === 0 ) return null;
	const spray = value.spray == null ? true : !! value.spray;
	const buoyancy = value.buoyancy == null && value.buoy == null
		? true
		: !! ( value.buoyancy ?? value.buoy );
	const pierce = value.pierce == null ? true : !! value.pierce;
	const emit = !! value.emit;
	if ( ! spray && ! buoyancy && ! pierce && ! emit ) return null;
	return { spray, buoyancy, pierce, emit };

}

/**
 * World-space contact markers for the debug overlay, or null when off.
 * Buoyancy uses the live hull probes. Spray uses waterline cuts (and the
 * hull-jet origin when that recipe is on) — even if the emitter is parked.
 */
export function debugContacts( body, opts = {} ) {

	return bodyDebugContacts( body, opts );

}

function pierceExtras( body ) {

	return { length: body?.length, beam: body?.beam };

}

function bodyPiercePoint( body ) {

	if ( ! body ) return null;
	const cfg = parsePierce( body.pierce, body.size, pierceExtras( body ) );
	if ( ! cfg ) return null;
	body.pullFromController?.();
	const loc = pierceLocalOffset( body.size, cfg, pierceExtras( body ) );
	const { right, up, back } = craftBasis( body.heading ?? 0, body.pitch ?? 0, body.roll ?? 0 );
	const px = body.pos?.[ 0 ] ?? 0;
	const py = body.pos?.[ 1 ] ?? 0;
	const pz = body.pos?.[ 2 ] ?? 0;
	return {
		x: px + right[ 0 ] * loc.x + up[ 0 ] * loc.y + back[ 0 ] * loc.z,
		y: py + right[ 1 ] * loc.x + up[ 1 ] * loc.y + back[ 1 ] * loc.z,
		z: pz + right[ 2 ] * loc.x + up[ 2 ] * loc.y + back[ 2 ] * loc.z,
		r: cfg.r,
		height: Math.max( cfg.height ?? 0, 0 ),
	};

}

function bodyDebugContacts( body, opts = {} ) {

	const flags = parseDebug( body?.debug );
	const pierceOn = parsePierce( body?.pierce, body?.size, pierceExtras( body ) );
	const emitOn = !! ( flags?.emit || opts.emit );
	const buoyOn = !! ( flags?.buoyancy || opts.buoyancy );
	if ( ! flags && ! pierceOn && ! emitOn && ! buoyOn ) return null;
	const buoyancy = [];
	if ( buoyOn && body?.probePoints ) {

		const pts = body.probePoints( opts.params );
		const roles = body.probeLayout === 'corners' ? BUOY_ROLES_CORNERS
			: pts.length >= 5 ? BUOY_ROLES_5 : BUOY_ROLES_4;
		for ( let i = 0; i < pts.length; i ++ ) {

			const h = body.samples?.h?.[ i ];
			buoyancy.push( {
				kind: 'buoyancy',
				role: roles[ i ] || ( 'p' + i ),
				x: pts[ i ][ 0 ],
				y: Number.isFinite( h ) ? h : ( body.surf ?? 0 ),
				z: pts[ i ][ 1 ],
			} );

		}

	}

	const spray = [];
	if ( flags?.spray ) {

		const placed = sprayContactPoints( body, opts );
		if ( placed.hull ) spray.push( placed.hull );
		for ( const s of placed.cuts ) spray.push( s );

	}

	const pierce = [];
	if ( pierceOn && ( pierceOn.marker ?? 0 ) > 0.001 && ( ! flags || flags.pierce ) ) {

		const p = bodyPiercePoint( body );
		if ( p ) pierce.push( { kind: 'pierce', role: 'pole', ...p } );

	}

	const emit = [];
	if ( emitOn && isPhysicsWake( body?.wakeConfig?.() ?? body?.wake ) ) {

		for ( const p of leftoverEmitPoints( body, opts ) ) emit.push( p );

	}

	if ( ! buoyancy.length && ! spray.length && ! pierce.length && ! emit.length ) return null;
	return { buoyancy, spray, pierce, emit };

}

/**
 * One object in the sea. Feature flags:
 *
 *   float   gravity + buoyancy. Off = decoration (today's buoy).
 *   wake    true | false | number | { on, origin, start, end, length,
 *           count, bow, turbulence, strength, beam, depth }. Default on
 *           when floating. `count` is 1 = boil, 2 = V, 3 = V+boil, 4 = +bow.
 *           `origin` is −1 stern … +1 bow (past −1 is behind the transom).
 *           `start` / `end` are half-widths
 *           in metres; `length` is metres of visible trail.
 *   splash  'impact' | 'waterline' | false
 *   spray   true | false | number | { on, sites, hull, amount, band } —
 *           GPU particles. `sites` caps simultaneous waterline contacts.
 *           `hull` 1 is the ski's jet / chine / curtain; 0 sheds from the
 *           cuts themselves. Speed, load, turn, slip, and impact still gate.
 *   hull    true | false | { push, radius, bow } — near-field hollow (one slot)
 *   swell   true | false | number | { on, dome, bow, mound, soft } —
 *           just-under loaf (the sea-dragon water look). Dome on the back,
 *           heap at the nose, laminar sheet along the body. Off by default.
 *   pierce  true | false | number | { on, r, height, life, marker, gain, rim, bow, side, trench } —
 *           a vertical rod at one mesh point (default: middle top, stretching
 *           up by `height`). Live when that rod meets the sea; inside the
 *           radius the surface drops to the rod's base. `life` is seconds the
 *           leftover trench stays behind the rod (0 is the live well only).
 *           `r` is the pole, the rest are the near-field knobs from src/pierce.js.
 *           `marker` 1 shows the amber overlay; 0 (the default) hides it.
 *           Off by default.
 *   debug   true | false | { spray, buoyancy, pierce, emit } — draw contact
 *           markers (magenta waterline / hull-jet, cyan buoyancy probes,
 *           amber pole, lime leftover occupancy). `emit` is opt-in — `true`
 *           does not turn it on. BodyList.buoyDebug / rippleEmitDebug can
 *           show probes or occupancy without setting body.debug. The pole
 *           overlay stays off unless `pierce.marker` is on.
 *
 * Surface-craft knobs (`hover`, `grip`, `springiness` / `launch`, …)
 * default off so a crate still just falls and floats. Spread `SKI` to turn
 * any mesh into a planing hull. Drive with `throttle` / `steer`, or write
 * `vel` / `heading`. Hover is metres above the waterline, not a motor.
 */
export class OceanBody {

	constructor( mesh = null, opts = {} ) {

		if ( mesh && typeof mesh === 'object' && ! mesh.position && ( mesh.mass || mesh.float || mesh.wake !== undefined ) ) {

			opts = mesh;
			mesh = opts.mesh ?? null;

		}

		this.id = _nextId ++;
		this.mesh = mesh;
		this.mass = opts.mass ?? 40;
		this.size = estimateSize( mesh, opts );
		this.volume = estimateVolume( this.size, opts );
		this.drag = opts.drag ?? 0.4;
		this.float = opts.float === true;
		this.wake = opts.wake === undefined ? this.float : opts.wake;
		this.splash = opts.splash === undefined ? ( this.float ? 'impact' : false ) : opts.splash;
		this.spray = opts.spray === undefined ? !! this.float : opts.spray;
		this.hull = opts.hull === undefined ? false : opts.hull;
		this.swell = opts.swell === undefined ? false : opts.swell;
		this.pierce = opts.pierce === undefined ? false : opts.pierce;
		this.debug = opts.debug === undefined ? false : opts.debug;
		this._swellEase = { mound: 0, dome: 0, bow: 0 };
		this.sampleCount = opts.samples === 1 || opts.samples === 4 || opts.samples === 5
			? opts.samples
			: ( this.size.z > this.size.x * 1.4 ? 5 : 1 );
		const physicsWake = isPhysicsWake( parseWake( this.wake, this.size, {
			length: opts.length, beam: opts.beam,
		} ) );
		this.probeLayout = opts.probeLayout === 'corners' || opts.probeLayout === 'cross'
			? opts.probeLayout
			: ( physicsWake ? 'corners' : 'cross' );
		if ( this.probeLayout === 'corners' ) this.sampleCount = 4;
		this.paramPrefix = opts.paramPrefix || null;
		this.topSpeed = opts.topSpeed ?? 12;
		this.controller = opts.controller ?? null;

		this.hover = opts.hover ?? 0;
		this.stiffness = opts.stiffness ?? 0;
		this.damping = opts.damping ?? 0;
		this.gravity = opts.gravity ?? GRAVITY;
		this.launch = opts.launch ?? 0;
		this.springiness = opts.springiness ?? this.launch;
		this.launchThreshold = opts.launchThreshold ?? 3.2;
		this.launchG = opts.launchG ?? 0.72;
		this.jumpSpeed = opts.jumpSpeed ?? 5;
		this.jumpGain = opts.jumpGain ?? 1.35;
		this.jumpMax = opts.jumpMax ?? 6;
		this.surfFilter = opts.surfFilter ?? 22;
		this.landingDrag = opts.landingDrag ?? 0.35;
		this.grip = opts.grip ?? 0;
		this.airGrip = opts.airGrip ?? 0.25;
		this.turnDrag = opts.turnDrag ?? 0;
		this.accel = opts.accel ?? 0;
		this.brake = opts.brake ?? 0;
		this.boostMul = opts.boostMul ?? 1.35;
		this.turnRate = opts.turnRate ?? 0;
		this.steerLag = opts.steerLag ?? 5;
		this.yawInertia = opts.yawInertia ?? 3;
		this.coastSteer = opts.coastSteer ?? 0.3;
		this.airSteer = opts.airSteer ?? 0.25;
		this.bankGain = opts.bank ?? 0.55;
		this.attitudeRate = opts.attitudeRate ?? 9;
		this.heightSmoothing = opts.heightSmoothing ?? ( this.hover > 0 ? 0.15 : 0.08 );
		this.rotationSmoothing = opts.rotationSmoothing ?? 0.2;
		this.rotationInfluence = opts.rotationInfluence ?? 0.5;
		this.length = opts.length ?? null;
		this.beam = opts.beam ?? null;
		this.carveTurn = opts.carveTurn ?? 1.9;
		this.carveGrip = opts.carveGrip ?? 0.45;
		this.carveDrag = opts.carveDrag ?? 2.2;
		this.probeSmooth = opts.probeSmooth ?? 8;
		// Gain on the Froude running trim: how far the bow rides up as the
		// hull works through displacement, over the hump, and onto plane.
		// 0 keeps the deck flat to the water and is the old behaviour.
		this.trim = opts.trim ?? 1;
		// Smoothed surge along the heading, m/s². Drives the squat.
		this.surgeAccel = 0;

		this.throttle = opts.throttle ?? null;
		this.steer = opts.steer ?? null;
		this.boost = !! opts.boost;
		this.carve = !! opts.carve;

		this.pos = new Float32Array( 3 );
		readMeshPos( mesh, this.pos );
		if ( opts.pos ) {

			this.pos[ 0 ] = opts.pos[ 0 ]; this.pos[ 1 ] = opts.pos[ 1 ]; this.pos[ 2 ] = opts.pos[ 2 ];

		}

		this.vel = new Float32Array( 3 );
		if ( opts.vel ) {

			this.vel[ 0 ] = opts.vel[ 0 ]; this.vel[ 1 ] = opts.vel[ 1 ]; this.vel[ 2 ] = opts.vel[ 2 ];

		}

		this.heading = opts.heading ?? ( mesh?.rotation?.y ?? 0 );
		this.pitch = 0;
		this.roll = 0;
		this.yawRate = 0;
		this.speed = Math.hypot( this.vel[ 0 ], this.vel[ 2 ] );
		this.alt = opts.alt ?? ( this.hover > 0 ? this.hover : 0 );
		this.worldY = this.pos[ 1 ];
		// Crates start falling. A driven / SKI hull starts on the water
		// even at hover 0 — hover is clearance, not "this is a ski".
		this.airborne = opts.airborne ?? (
			this.hover > 0
				? this.pos[ 1 ] > this.hover + 2
				: ! ( this.accel > 0 || this.throttle != null || this.steer != null )
		);
		this.wet = false;
		this.impact = 0;
		this._impactSeq = 0;
		this.lastSplash = null;
		this._sprayEntryHold = 0;
		this._sprayEntryDraw = 0;
		this.surf = 0;
		this.surfTarget = 0;
		this.surfVel = 0;
		this.surfAcc = 0;
		this._lastSurf = undefined;
		this._lastHover = this.hover;
		this._probePrimed = false;
		this.steerIn = 0;
		this.slip = 0;
		this.slipSigned = 0;
		this.hullLoad = 0;
		this.fwdAccel = 0;
		this.yawAcc = 0;
		this.pitchRate = 0;
		this.rollRate = 0;
		this._prevSpeed = this.speed;
		this._prevYawRate = this.yawRate;
		this._prevPitch = this.pitch;
		this._prevRoll = this.roll;
		this._kinPrimed = false;
		this.bank = 0;
		this.airTime = 0;
		this._lastU = 0;
		this.lag = [ 0, 0 ];
		this.samples = { h: [ 0, 0, 0, 0, 0 ], foam: 0, dx: 0, dz: 0 };
		this._probeH = null;
		this._primed = false;
		this._probeSlot = 0;
		this._probeCount = 0;

	}

	attach( controller ) {

		this.controller = controller;
		this.pullFromController();
		return this;

	}

	pullFromController() {

		const c = this.controller;
		if ( ! c ) return;
		if ( c.pos ) {

			this.pos[ 0 ] = c.pos[ 0 ];
			this.pos[ 1 ] = c.deckY ?? c.pos[ 1 ];
			this.pos[ 2 ] = c.pos[ 2 ];

		}

		if ( c.heading != null ) this.heading = c.heading;
		if ( c.pitch != null ) this.pitch = c.pitch;
		if ( c.roll != null ) this.roll = c.roll;
		if ( c.speed != null ) this.speed = c.speed;
		if ( c.yawRate != null ) this.yawRate = c.yawRate;
		if ( c.airborne != null ) this.airborne = !! c.airborne;
		if ( c.impact != null ) {

			if ( c.impact > 0.12 && this.impact <= 0.12 ) this._impactSeq ++;
			this.impact = c.impact;

		}
		if ( c.lag ) {

			this.lag[ 0 ] = c.lag[ 0 ]; this.lag[ 1 ] = c.lag[ 1 ];

		}

		if ( c.floatRig ) this.wet = !! c.floatRig.active;
		else if ( c.jumpAirborne != null ) this.wet = ! c.jumpAirborne;
		else this.wet = !! c.active && ! c.airborne;

	}

	/**
	 * Apply one GPU probe reading (async, one frame late). Same contract as
	 * WaveRunner.acceptProbe: the value is a target the integrator chases.
	 */
	acceptSamples( rows ) {

		if ( ! rows || ! rows.length ) return;
		const n = Math.min( rows.length, 5 );
		if ( ! this._probeH ) this._probeH = [ 0, 0, 0, 0, 0 ];
		for ( let i = 0; i < n; i ++ ) {

			this.samples.h[ i ] = rows[ i ].h;
			this._probeH[ i ] = rows[ i ].h;

		}
		this.surfTarget = hullRideHeight( this.samples.h.slice( 0, n ) );
		this.samples.foam = rows[ 0 ].foam ?? 0;
		this.samples.dx = rows[ 0 ].dx ?? 0;
		this.samples.dz = rows[ 0 ].dz ?? 0;
		this.lag[ 0 ] = this.samples.dx;
		this.lag[ 1 ] = this.samples.dz;
		// First GPU reading snaps. `_primed` used to be set by the mean-sea
		// fallback on frame 1, so this path never ran and the hull eased
		// toward the swell from y=0 instead of sitting on it.
		if ( ! this._probePrimed ) {

			this.surf = this.surfTarget;
			this._lastSurf = this.surf;
			this._probePrimed = true;
			this._primed = true;

		}

		if ( this.controller?.acceptProbe ) this.controller.acceptProbe( rows );

	}

	probePoints( params ) {

		if ( this.controller?.probePoints ) {

			const pts = this.controller.probePoints( params || {} );
			if ( pts && typeof pts[ 0 ] === 'number' ) {

				const out = [];
				for ( let i = 0; i + 1 < pts.length; i += 2 ) out.push( [ pts[ i ], pts[ i + 1 ] ] );
				return out;

			}

			return pts || [ [ this.pos[ 0 ], this.pos[ 2 ] ] ];

		}

		const x = this.pos[ 0 ], z = this.pos[ 2 ];
		if ( this.sampleCount < 4 ) return [ [ x, z ] ];
		const s = Math.sin( this.heading ), c = Math.cos( this.heading );
		const fx = s, fz = - c, rx = c, rz = s;
		const { along: L, across: W } = this.probeSpan();
		if ( this.probeLayout === 'corners' ) {

			return [
				[ x + fx * L - rx * W, z + fz * L - rz * W ],
				[ x + fx * L + rx * W, z + fz * L + rz * W ],
				[ x - fx * L - rx * W, z - fz * L - rz * W ],
				[ x - fx * L + rx * W, z - fz * L + rz * W ],
			];

		}
		const pts = [
			[ x, z ],
			[ x + fx * L, z + fz * L ],
		];
		if ( this.sampleCount >= 5 ) pts.push( [ x - fx * L, z - fz * L ] );
		pts.push( [ x - rx * W, z - rz * W ], [ x + rx * W, z + rz * W ] );
		return pts;

	}

	/**
	 * Half-extent of the hull samples, metres. Bow and stern sit on the
	 * waterline, not past the mesh — a probe beyond the bow was reading a
	 * different wave and standing the box on end in a storm.
	 */
	probeSpan() {

		const along = ( this.length ?? this.size.z ) * 0.5;
		const across = ( this.beam ?? this.size.x ) * 0.5;
		if ( this.probeLayout === 'corners' ) {

			return {
				along: Math.max( this.size.z * 0.5, 0.2 ),
				across: Math.max( this.size.x * 0.5, 0.2 ),
			};

		}
		return {
			along: Math.min( along, this.size.z * 0.48 ),
			across: Math.min( across, this.size.x * 0.48 ),
		};

	}

	wantsProbe() {

		if ( this.controller?.probePoints && this.controller.active ) return true;
		return this.float && ! this.controller;

	}

	/** Someone is writing drive inputs. Hover is not part of this. */
	isDriven() {

		return this.throttle != null || this.steer != null;

	}

	/**
	 * Metres above the sea the ride follows. Hover is clearance;
	 * hover 0 sits on the mass/volume waterline.
	 */
	rideRest() {

		if ( this.hover > 0 ) return this.planingRest();
		return floatEquilibriumY( this.surf, this.mass, this.volume, this.size.y ) - this.surf;

	}

	/**
	 * Gravity + buoyancy + drag, or a driven ride. Hover is rest
	 * height; throttle / steer turn the motor on. A leftover WaveRunner
	 * controller still skips this (BodyList.step copies pose only) so
	 * the ride demo does not get two steppers.
	 *
	 * @param {number} dt
	 * @param {{ h?: number[]|number, seaLevel?: number }} [samples]
	 */
	step( dt, samples = {} ) {

		const d = Math.min( Math.max( dt, 0 ), 1 / 20 );
		if ( d <= 0 ) return;

		if ( this.controller ) {

			this.pullFromController();
			this.noteKinematics( d );
			this.syncMesh();
			return;

		}

		const sea = Array.isArray( samples.h ) ? hullRideHeight( samples.h )
			: ( typeof samples.h === 'number' ? samples.h
				: ( this._primed ? this.surfTarget : ( samples.seaLevel ?? 0 ) ) );
		if ( Array.isArray( samples.h ) ) {

			for ( let i = 0; i < Math.min( samples.h.length, 5 ); i ++ ) this.samples.h[ i ] = samples.h[ i ];
			if ( samples.h.length >= 2 ) this._probePrimed = true;

		}

		const riding = this.hover > 0 || this.isDriven();
		const rideTau = riding
			? Math.max( this.heightSmoothing, 1e-3 )
			: 1 / Math.max( this.probeSmooth || 8, 1 );
		const pk = 1 - Math.exp( - d / Math.max( rideTau * 0.45, 0.04 ) );
		this.surfTarget = sea;
		if ( ! this._primed ) {

			this.surf = sea; this._primed = true;

		}

		this.surf += ( this.surfTarget - this.surf ) * pk;

		if ( ! this.float ) {

			this.wet = false;
			this.airborne = this.pos[ 1 ] > this.surf + this.size.y * 0.5;
			this._lastHover = this.hover;
			this.noteKinematics( d );
			this.syncMesh();
			return;

		}

		// Planing parks at surf+hover. Turning hover off used to leave the
		// mesh in the air while the swell dropped out from under it.
		if ( this._lastHover > 0 && this.hover <= 0 ) {

			this.pos[ 1 ] = floatEquilibriumY( this.surf, this.mass, this.volume, this.size.y );
			this.vel[ 1 ] = 0;
			this.airborne = false;
			this.wet = true;
			this.alt = 0;
			this.worldY = this.pos[ 1 ];
			this.airTime = 0;

		}

		this._lastHover = this.hover;
		if ( this.hover > 0 || this.isDriven() ) this._stepPlaning( d, pk );
		else this._stepFloat( d, pk );
		this.noteKinematics( d );
		this.syncMesh();

	}

	/**
	 * Measured ds/dt, dω/dt, d pitch/dt. `this.accel` is the motor
	 * coefficient and must not be overwritten.
	 */
	noteKinematics( dt ) {

		const d = Math.max( dt, 1e-4 );
		if ( this._kinPrimed ) {

			this.fwdAccel = ( this.speed - this._prevSpeed ) / d;
			this.yawAcc = ( this.yawRate - this._prevYawRate ) / d;
			this.pitchRate = ( this.pitch - this._prevPitch ) / d;
			this.rollRate = ( this.roll - this._prevRoll ) / d;

		} else {

			this.fwdAccel = 0;
			this.yawAcc = 0;
			this.pitchRate = 0;
			this.rollRate = 0;
			this._kinPrimed = true;

		}

		this._prevSpeed = this.speed;
		this._prevYawRate = this.yawRate;
		this._prevPitch = this.pitch;
		this._prevRoll = this.roll;

	}

	/** Hydrostatic crate: mass vs immersed volume. */
	_stepFloat( d, pk ) {

		// Ride the heave first. Buoyancy is in the sea's frame — without
		// this a trough drops a metre while the box is still falling and
		// the mesh hangs in the air (hover 0 on a live swell).
		const last = this._lastSurf;
		const dh = last != null ? this.surf - last : 0;
		const surfVel = last != null ? dh / Math.max( d, 1e-3 ) : 0;
		this.surfVel = surfVel;
		const keel = this.pos[ 1 ] - this.size.y * 0.5;
		if ( last != null && ( this.wet || keel < this.surf + this.size.y ) ) {

			this.pos[ 1 ] += dh;

		}

		this._lastSurf = this.surf;

		const frac = immersedFraction( this.surf, this.pos[ 1 ], this.size.y );
		const wasAir = this.airborne;
		this.wet = frac > 0.02;
		const inWater = frac > 0.01;
		const hDrag = this.drag * ( inWater ? 1.6 : 0.04 );

		if ( ! inWater ) {

			this.airborne = true;
			this.vel[ 1 ] -= GRAVITY * d;

		} else {

			if ( wasAir && this.vel[ 1 ] < 0 ) {

				const hit = Math.min( 1, Math.abs( this.vel[ 1 ] ) / 12 );
				this.impact = Math.max( this.impact, hit );
				this._impactSeq ++;
				this.vel[ 1 ] *= 1 - 0.7 * hit;
				if ( this.splash === 'impact' && hit > 0.04 ) {

					this.lastSplash = { kind: 'impact', impact: hit, x: this.pos[ 0 ], z: this.pos[ 2 ], mass: this.mass };

				}

			}

			this.airborne = false;
			this.vel[ 1 ] = surfVel;

		}

		this.vel[ 0 ] *= Math.exp( - hDrag * d );
		this.vel[ 2 ] *= Math.exp( - hDrag * d );
		this.pos[ 0 ] += this.vel[ 0 ] * d;
		this.pos[ 2 ] += this.vel[ 2 ] * d;
		// Heave already moved Y with the sea. Adding vel[1]*d again doubled
		// every swell and the box porpoised off the waterline. Airborne
		// still integrates gravity; wet pins to the mass/volume sit height.
		if ( inWater ) {

			const sit = floatEquilibriumY( this.surf, this.mass, this.volume, this.size.y );
			this.pos[ 1 ] += ( sit - this.pos[ 1 ] ) * ( 1 - Math.exp( - 14 * d ) );

		} else {

			this.pos[ 1 ] += this.vel[ 1 ] * d;

		}
		this.speed = Math.hypot( this.vel[ 0 ], this.vel[ 2 ] );
		if ( this.speed > 0.08 ) this.heading = Math.atan2( this.vel[ 0 ], - this.vel[ 2 ] );
		this.impact = Math.max( 0, this.impact - d * 2.2 );
		this._attitudeFromProbes( d, pk, false );

	}

	/** Length Froude number for this hull right now. */
	froude() {

		return froudeLength( this.speed, this.length ?? this.size?.z ?? 8 );

	}

	/** plow | hump | plane — what the water is doing to the hull. */
	regime() {

		return wakeRegime( this.froude() );

	}

	/**
	 * Bow-up running trim in radians, on top of whatever the wave under the
	 * hull is doing. Level at a crawl, bow at the sky over the hump, settled
	 * to a few degrees once it is up and planing. Airborne keeps its
	 * ballistic attitude instead.
	 */
	runningTrim() {

		if ( ! ( this.trim > 0 ) || this.airborne ) return 0;
		const t = hullRunningTrim( this.froude() )
			+ hullTrimFromAccel( this.surgeAccel );
		// A hull that is barely touching cannot be trimmed by water it is
		// not in — and a stopped one has nothing to climb.
		const bite = clamp( Math.abs( this.speed ?? 0 ) / 0.8, 0, 1 );
		return t * this.trim * bite;

	}

	/**
	 * Rest height of the planing spring. The spring is an acceleration
	 * (not N/m), so mass is folded in as sag around the SKI preset: heavier
	 * sits lower, lighter rides higher. Hover 0 is the hydrostatic path.
	 */
	planingRest() {

		const sag = ( this.mass / SKI.mass - 1 ) * ( this.gravity / Math.max( this.stiffness, 1e-3 ) );
		// Stay on the water. The old −1.2 floor let a heavy SKI box sit a
		// metre under the sea it was sampling — it still tracked the probe,
		// but the mesh was buried and looked like it was ignoring the swell.
		// Hover 0 is the hydrostatic path that actually sinks.
		return clamp( this.hover - sag, Math.min( this.hover, 0.06 ), this.hover + 0.8 );

	}

	/**
	 * Driven / planing hull: first-order ride (Water Pro heightSmoothing),
	 * crest launch only when springiness > 0 and rising into a falling
	 * face, then a ballistic land. Hover picks the rest height; it does
	 * not turn the motor on. A spring on storm chop overshot and
	 * launched off every trough.
	 */
	_stepPlaning( d, pk ) {

		this._drive( d );

		const surf = this.surf;
		const rest = this.rideRest();
		const dhdtRaw = ( surf - ( this._lastSurf ?? surf ) ) / Math.max( d, 1e-3 );
		const kf = 1 - Math.exp( - this.surfFilter * d );
		const prevVel = this.surfVel;
		this.surfVel = prevVel + ( dhdtRaw - prevVel ) * kf;
		const accRaw = ( this.surfVel - prevVel ) / Math.max( d, 1e-3 );
		this.surfAcc += ( accRaw - this.surfAcc ) * kf;
		const targetY = surf + rest;
		const tau = Math.max( this.heightSmoothing, 1e-3 );
		const hk = 1 - Math.exp( - d / tau );

		if ( this.airborne ) {

			this.vel[ 1 ] -= this.gravity * d;
			this.worldY += this.vel[ 1 ] * d;
			this.alt = this.worldY - surf;
			this.pos[ 1 ] = this.worldY;
			if ( this.vel[ 1 ] < 0 && this.worldY <= targetY ) {

				const hit = Math.min( 1, Math.abs( this.vel[ 1 ] ) / 12 );
				this.impact = Math.max( this.impact, hit );
				this._impactSeq ++;
				const keep = 1 - this.landingDrag * hit;
				this.vel[ 0 ] *= keep; this.vel[ 2 ] *= keep;
				this.vel[ 1 ] = 0;
				this.alt = rest;
				this.worldY = targetY;
				this.pos[ 1 ] = this.worldY;
				this.airborne = false;
				this.airTime = 0;
				if ( this.splash === 'impact' && hit > 0.04 ) {

					this.lastSplash = { kind: 'impact', impact: hit, x: this.pos[ 0 ], z: this.pos[ 2 ], mass: this.mass };

				}

			} else {

				this.airTime += d;

			}

		} else {

			const prevY = this.pos[ 1 ];
			const nextY = prevY + ( targetY - prevY ) * hk;
			const followVel = ( nextY - prevY ) / Math.max( d, 1e-4 );
			const fast = Math.abs( this.speed ) > Math.max( this.jumpSpeed, 0.1 );
			// Leave only when the hull is still climbing into a face that has
			// already started to fall. A downward storm face is ridden.
			const crestJump = this.springiness > 0
				&& fast
				&& dhdtRaw < 0
				&& this.surfAcc < - this.gravity * this.launchG
				&& this.vel[ 1 ] > 0.8;
			if ( crestJump ) {

				this.airborne = true;
				this.vel[ 1 ] = Math.min( Math.max( this.vel[ 1 ], 0 ), Math.max( this.jumpMax, 0 ) );
				this.worldY = prevY;
				this.pos[ 1 ] = prevY;
				this.alt = prevY - surf;
				this.airTime = 0;

			} else {

				this.pos[ 1 ] = nextY;
				this.worldY = nextY;
				this.alt = nextY - surf;
				this.vel[ 1 ] = followVel;

			}

		}

		this._lastSurf = surf;
		this.wet = ! this.airborne || this.impact > 0.02;
		this.impact = Math.max( 0, this.impact - d * 2.2 );
		this._attitudeFromProbes( d, pk, true );

	}

	/** Thrust, steer, grip. No-op unless the caller is writing drive inputs. */
	_drive( d ) {

		const driving = this.throttle != null || this.steer != null;
		const fx = Math.sin( this.heading ), fz = - Math.cos( this.heading );
		let along = this.vel[ 0 ] * fx + this.vel[ 2 ] * fz;

		if ( driving && this.turnRate > 0 ) {

			const steer = clamp( this.steer ?? 0, - 1, 1 );
			const throttle = this.throttle ?? 0;
			const boost = this.boost ? this.boostMul : 1;
			const top = this.topSpeed * boost;
			this.steerIn = lerp( this.steerIn, steer, 1 - Math.exp( - this.steerLag * d ) );
			const speedT = clamp( Math.abs( along ) / Math.max( this.topSpeed * 0.45, 1 ), 0, 1 );
			const bite = ( this.airborne ? this.airSteer : 1 ) * ( throttle > 0 ? 1 : this.coastSteer );
			const carveGain = this.carve ? this.carveTurn : 1;
			const targetYaw = this.steerIn * this.turnRate * bite * carveGain
				* ( 0.2 + 0.8 * speedT ) * Math.sign( along || 1 );
			this.yawRate = lerp( this.yawRate, targetYaw, 1 - Math.exp( - this.yawInertia * d ) );
			this.heading += this.yawRate * d;

			let acc = 0;
			if ( throttle > 0 ) acc = this.accel * boost * clamp( throttle, 0, 1 );
			else if ( throttle < 0 ) acc = - this.brake * clamp( - throttle, 0, 1 );
			let u = along + acc * d;
			u -= u * Math.abs( u ) * ( this.accel / Math.max( top * top, 1 ) ) * d;
			u *= Math.exp( - Math.abs( this.yawRate ) * this.turnDrag * ( this.carve ? this.carveDrag : 1 ) * d );
			u = clamp( u, - this.topSpeed * 0.35, top * 1.25 );

			const nfx = Math.sin( this.heading ), nfz = - Math.cos( this.heading );
			let latX = this.vel[ 0 ] - nfx * along;
			let latZ = this.vel[ 2 ] - nfz * along;
			const gripK = this.airborne ? this.airGrip : this.grip * ( this.carve ? this.carveGrip : 1 );
			const gripDecay = Math.exp( - gripK * d );
			latX *= gripDecay; latZ *= gripDecay;
			this.vel[ 0 ] = nfx * u + latX;
			this.vel[ 2 ] = nfz * u + latZ;
			this.slip = Math.hypot( latX, latZ );
			this.slipSigned = - latX * nfz + latZ * nfx;
			const lateral = Math.abs( u * this.yawRate );
			const dU = ( u - this._lastU ) / Math.max( d, 1e-3 );
			this.surgeAccel += ( dU - this.surgeAccel ) * ( 1 - Math.exp( - d / 0.28 ) );
			const decel = Math.max( 0, ( this._lastU - u ) / Math.max( d, 1e-3 ) );
			this._lastU = u;
			this.hullLoad = lateral + this.slip * 3 + decel * 0.5 + this.impact * 14;
			this.speed = u;
			const targetBank = - this.yawRate * this.bankGain * ( 0.4 + 0.6 * speedT );
			this.bank = lerp( this.bank, targetBank, 1 - Math.exp( - 5 * d ) );

		} else if ( this.grip > 0 ) {

			const gripK = this.airborne ? this.airGrip : this.grip;
			const gripDecay = Math.exp( - gripK * d );
			const latX = ( this.vel[ 0 ] - fx * along ) * gripDecay;
			const latZ = ( this.vel[ 2 ] - fz * along ) * gripDecay;
			this.vel[ 0 ] = fx * along + latX;
			this.vel[ 2 ] = fz * along + latZ;
			this.slip = Math.hypot( latX, latZ );
			this.speed = along;
			this.hullLoad = this.slip * 3 + this.impact * 14;

		} else {

			this.speed = along;
			this.hullLoad = this.impact * 14;

		}

		this.pos[ 0 ] += this.vel[ 0 ] * d;
		this.pos[ 2 ] += this.vel[ 2 ] * d;

	}

	_attitudeFromProbes( d, pk, planing ) {

		const h = this.samples.h;
		if ( this.sampleCount < 4 || ! this._probePrimed ) return;
		const { along, across } = this.probeSpan();
		const tau = planing
			? Math.max( this.rotationSmoothing, 1 / Math.max( this.attitudeRate, 1 ) )
			: 1 / 2.4;
		const rate = 1 - Math.exp( - d / tau );
		const influence = planing ? this.rotationInfluence : this.rotationInfluence * 0.65;
		// Wave slope is only half the deck angle. The other half is running
		// trim: the hull's own attitude against the water at this Froude
		// number, which is what makes a boat rear up at the hump and settle
		// once it climbs onto plane.
		const tgtPitch = this.airborne
			? clamp( this.vel[ 1 ] * 0.03, - 0.35, 0.45 )
			: hullPitchFrom( h, along, influence, this.probeLayout )
				+ ( planing ? this.runningTrim() : 0 );
		const tgtRoll = this.airborne ? 0 : hullRollFrom( h, across, influence, this.probeLayout );
		this.pitch += ( tgtPitch - this.pitch ) * rate;
		this.roll += ( tgtRoll - this.roll ) * rate;
		if ( planing ) {

			// Bank is the turn heel (starboard-down is negative roll). The
			// old 0.35 mix left a planing hull visually level.
			this.roll += ( this.bank - this.roll ) * rate * 0.85;
			this.pitch = clamp( this.pitch, - 0.55, 0.55 );
			this.roll = clamp( this.roll, - 0.45, 0.45 );

		} else {

			// Closed foam only wets the bottom slab. Using the full height
			// as draft let a taller box stand its bow out of a swell even
			// when the origin sat on the waterline.
			const draft = Math.min( floatFraction( this.mass, this.volume ) * this.size.y, 0.12 );
			const half = Math.max( this.size.z, this.size.x ) * 0.45;
			const maxTilt = Math.atan2( Math.max( draft, 0.05 ) * 2.4, half );
			this.pitch = clamp( this.pitch, - maxTilt, maxTilt );
			this.roll = clamp( this.roll, - maxTilt, maxTilt );

		}

	}

	surfXZ() {

		return [ this.pos[ 0 ] + this.lag[ 0 ], this.pos[ 2 ] + this.lag[ 1 ] ];

	}

	_wakeSea( params ) {

		if ( this._primed && Number.isFinite( this.surf ) ) return this.surf;
		const sea = params?.seaLevel;
		return Number.isFinite( sea ) ? sea : 0;

	}

	/**
	 * Metres of water above the highest of nose / back. Positive is under
	 * the sea; negative is emerged. Pitch lifts the snout, so a climb can
	 * work the surface while the origin is still metres down.
	 */
	surfaceClearance( sea = 0 ) {

		const st = swellStations( this, sea );
		return Math.min( st.noseClear, st.backClear );

	}

	/**
	 * Leftover foam and rings only write when something is actually working
	 * the sea. Slack is body-height scaled (`wakeSurfaceSlack`): a ski
	 * still dies at 2.4 m, a 60 m animal just under still trails. A
	 * landing still writes — the slap is the contact.
	 */
	surfaceWorking( sea = 0, slack = wakeSurfaceSlack( this ) ) {

		if ( ( this.impact ?? 0 ) > 0.12 ) return true;
		if ( ( this.controller?.impact ?? 0 ) > 0.12 ) return true;
		return this.surfaceClearance( sea ) < slack;

	}

	/**
	 * What TslWake.update stamps, or null if this body must not write the field.
	 * An idle / `wake: false` body is never a source — recentering on an
	 * escort used to wipe the ski's trail. Pass `{ escort: true }` for
	 * expanding rings / leftover water that stay in world XZ; those
	 * must not join the stamp-field follow list.
	 */
	asWakeSource( params, opts = {} ) {

		const cfg = this.wakeConfig();
		if ( ! cfg ) return null;
		if ( isPhysicsWake( cfg ) ) return null;
		this.pullFromController();
		const sea = this._wakeSea( params );
		const c = this.controller;
		if ( c?.floatRig ) {

			if ( ! c.active || ! c.floatRig.active ) return null;
			if ( ! this.surfaceWorking( sea ) ) return null;
			const fr = c.floatRig;
			return this._sourceFrom( {
				speed: fr.speed, heading: fr.heading, yawRate: fr.yawRate,
				slip: fr.slip, hullLoad: fr.hullLoad, impact: fr.impact,
				airborne: false, surfXZ: () => c.surfXZ(),
			}, params, cfg );

		}

		const cuts = wakeCutPoints( this, { seaLevel: sea } );
		const slap = ( c?.impact ?? this.impact ?? 0 ) > 0.12;
		// Origin leftover while the high point works the sea, plus any
		// pierce cuts. Requiring a cut used to kill the stern ribbon
		// (and the V) the moment the tail left the water.
		if ( ! this.surfaceWorking( sea ) && ! cuts.length && ! slap ) return null;

		if ( c ) {

			if ( ! c.active && ! opts.escort ) return null;
			// A leap's exit splash is not a landing hit. Treating it as
			// impact used to keep stamping rings under the flying body.
			if ( c.jumpAirborne ) return null;
			if ( c.airborne && ! ( c.impact > 0.01 ) ) return null;
			return this._sourceFrom( {
				speed: c.speed, heading: c.heading, yawRate: c.yawRate ?? 0,
				slip: c.slip ?? 0, hullLoad: c.hullLoad ?? 0, impact: c.impact ?? 0,
				airborne: !! c.airborne,
				surfXZ: c.surfXZ ? () => c.surfXZ() : () => this.surfXZ(),
				stampA: c.stampA, stampB: c.stampB, stampPoints: c.stampPoints,
			}, params, cfg, cuts );

		}

		if ( ! this.wet && this.impact < 0.02 ) return null;
		return this._sourceFrom( {
			speed: this.speed, heading: this.heading, yawRate: this.yawRate,
			slip: this.slip, hullLoad: this.hullLoad, impact: this.impact,
			airborne: this.airborne && this.impact < 0.02,
			surfXZ: () => this.surfXZ(),
		}, params, cfg, cuts );

	}

	/**
	 * Passage record for reconstructing the Kelvin corridor (center wash +
	 * two cusp rails). Physics hulls do not join `asWakeSource()` — that
	 * path also writes leftover rings / stamp height. This one only lays
	 * stir / age / lat / rate, and it stays on when the foam ribbon is 0.
	 */
	asRecordSource( params ) {

		const cfg = this.wakeConfig();
		if ( ! cfg ) return null;
		if ( ! isPhysicsWake( cfg ) ) return this.asWakeSource( params );
		this.pullFromController();
		const airborne = !! this.airborne && ! ( ( this.impact ?? 0 ) > 0.01 );
		if ( ! airborne ) {

			if ( Math.abs( this.speed ?? 0 ) < 0.55 && ( this.impact ?? 0 ) < 0.12 ) return null;
			if ( ! this.wet && ( this.impact ?? 0 ) < 0.02 ) return null;

		}
		const surfaceXZ = () => this.controller?.surfXZ
			? this.controller.surfXZ()
			: this.surfXZ();
		const src = this._sourceFrom( {
			speed: this.speed, heading: this.heading, yawRate: this.yawRate,
			yawAcc: this.yawAcc, fwdAccel: this.fwdAccel,
			slip: this.slipSigned ?? this.slip, hullLoad: this.hullLoad, impact: this.impact,
			steer: this.steerIn ?? this.steer,
			airborne,
			surfXZ: surfaceXZ,
		}, params, cfg, null );
		src.foamBeam = Math.max( this.size?.x ?? cfg.beam ?? 2, 0.6 );
		src.beam = src.foamBeam;
		// The foam texture is indexed by the undisplaced water coordinate.
		// Using raw world XZ here puts the ribbon one FFT horizontal
		// displacement away from the hull — metres off in a storm.
		const surf = surfaceXZ();
		const bow = wakeBowPoint( this, surf );
		src.stampB = bow;
		src.stampPoints = null;
		// Motor wash is pinned to the transom in hull space (not bow+offset).
		src.stern = wakeSternPoint( this, surf );
		src.hullLen = Math.max( this.length ?? this.size?.z ?? 12, 0.8 );
		src.planform = foamEnergyPlanformSamples( this, src.foamBeam, src.hullLen );
		return src;

	}

	/**
	 * Leftover foam energy. Physics hulls birth whitewater at the bow
	 * chines; motor wash stays a separate stern jet. Airborne still
	 * returns a source so the foam window tracks the hull mid-jump —
	 * stir is zero until the hull is wet again. Ribbon 0 parks this;
	 * the passage record still writes via {@link asRecordSource}.
	 */
	asFoamSource( params ) {

		const cfg = this.wakeConfig();
		if ( ! cfg ) return null;
		if ( ( cfg.foam ?? 0 ) <= 0.001 && ( cfg.motor ?? 0 ) <= 0.001 ) return null;
		if ( ! isPhysicsWake( cfg ) ) return this.asWakeSource( params );
		return this.asRecordSource( params );

	}

	wakeConfig() {

		return parseWake( this.wake, this.size, {
			length: this.length,
			beam: this.beam,
		} );

	}

	_sourceFrom( kin, params, cfg, cuts ) {

		const prefix = this.paramPrefix;
		const top = this.topSpeed ?? ( prefix && params ? params[ prefix + 'TopSpeed' ] : undefined );
		const speed = kin.speed ?? 0;
		const life = wakeLifeOf( cfg, speed, params );
		const xz = kin.surfXZ ? kin.surfXZ() : this.surfXZ();
		const heading = kin.heading ?? 0;
		const pierce = cuts?.length ? cuts : null;
		const stern = kin.stampB || wakeStampPoint( this, cfg, xz );
		const sites = pierce ? wakeRingPoints( pierce ) : [];
		const behind = sites.length ? wakeBehindPoints( sites, heading, 0.9 ) : null;
		const rings = sites.length ? sites : null;
		return {
			active: true,
			airborne: !! kin.airborne,
			speed,
			heading,
			yawRate: kin.yawRate ?? 0,
			yawAcc: kin.yawAcc ?? this.yawAcc ?? 0,
			fwdAccel: kin.fwdAccel ?? this.fwdAccel ?? 0,
			steer: kin.steer ?? this.steerIn ?? this.steer ?? 0,
			slip: kin.slip ?? 0,
			slipSigned: kin.slip ?? this.slipSigned ?? 0,
			hullLoad: kin.hullLoad ?? 0,
			impact: kin.impact ?? 0,
			impactSeq: this._impactSeq,
			pitch: this.pitch,
			roll: this.roll,
			pitchRate: this.pitchRate,
			vy: this.vel[ 1 ],
			surfVel: this.surfVel,
			surfXZ: kin.surfXZ,
			stampA: kin.stampA,
			stampB: behind?.[ 0 ] || stern,
			// A piercing mesh leaves a ribbon behind each spray run
			// (head / spine / tail). The ski has no stations and keeps
			// one stern sweep. Stamping every emitter glued a blob.
			stampPoints: behind,
			stampRings: rings ? rings.map( ( s ) => [ s.x, s.z ] ) : null,
			wake: this.wake,
			wakeCfg: cfg,
			length: this.length ?? this.size?.z ?? 3,
			life,
			wakeArmRate: wakeArmRateOf( cfg, speed, life ),
			topSpeed: top,
			id: this.id,
			beam: cfg.beam,
			foamBeam: wakeFoamBeamOf( cfg ),
			foam: cfg.foam ?? 0.9,
			waterDepth: params?.floorDepth ?? params?.seaDepth ?? params?.waterDepth ?? undefined,
		};

	}

	wakeRenderDims( params ) {

		const cfg = this.wakeConfig();
		if ( ! cfg ) return { kelvinOn: 0 };
		const raw = this.wake;
		if ( raw === true || raw === 1 ) {

			if ( this.paramPrefix === 'boat' && params ) {

				cfg.beam = Math.max( params.boatBeam ?? 1.65, 0.3 ) * 1.6;

			} else if ( this.float ) {

				cfg.beam = Math.max( this.size.x, 0.3 ) * 1.2;
				cfg.depth = 0.25;
				cfg.strength = 0.7;

			}

		}

		return wakeRenderDimsFrom( cfg, this, params );

	}

	hullState() {

		if ( ! this.hull || ( this.controller && ! this.wet && ! this.controller.floatRig?.active ) ) {

			return null;

		}

		if ( this.airborne || this.controller?.jumpAirborne ) return null;

		const h = this.hull === true ? {} : this.hull;
		const s = this.controller?.surfXZ ? this.controller.surfXZ() : this.surfXZ();
		const heading = this.heading;
		const L = Math.max( this.length ?? this.size?.z ?? 3, 0.5 );
		const isShip = L >= 12;
		const basePush = h.push ?? ( isShip ? 0.35 * Math.sqrt( L / 12 ) : 0.2 );
		const baseBow = h.bow ?? ( isShip ? 0.25 : 0.4 );
		// Physics wakes already have an object source in the wave equation.
		// Its separately uploaded footprint now bends the fragment normal;
		// adding this analytic vertex hollow as well reopened the broad moat.
		const contactOnly = isPhysicsWake( this.wakeConfig() );
		return {
			pos: [ s[ 0 ], this.pos[ 1 ], s[ 1 ] ],
			fwd: [ Math.sin( heading ), - Math.cos( heading ) ],
			push: contactOnly ? 0 : basePush,
			radius: h.radius ?? Math.max( this.size.x, this.size.z ) * 0.4,
			bow: baseBow,
			plane: Math.min( 1, 0.35 + 0.65 * Math.abs( this.speed ) / Math.max( this.topSpeed, 1 ) ),
		};

	}

	/**
	 * Just-under displacement for the shared uSwell* slot. `false` / `on: 0`
	 * is off. Same proximity curve the dragon uses: grows from below, peaks
	 * at the waterline, dies once the station is well emerged.
	 */
	swellState( dt, opts = {} ) {

		this.pullFromController();
		return stepSwell( this, dt, opts, this._swellEase );

	}

	sprayConfig() {

		return parseSpray( this.spray, this.size, sprayExtras( this ) );

	}

	/**
	 * GPU spray payload for this body, or null when the emitter must park.
	 * Waterline sites are the mesh cuts; hull mode keeps the ski's jet.
	 */
	sprayState( dt, opts = {} ) {

		this.pullFromController();
		return stepSpray( this, dt, opts );

	}

	pierceConfig() {

		return parsePierce( this.pierce, this.size, pierceExtras( this ) );

	}

	/**
	 * World position of the pole point, or null when pierce is off.
	 */
	piercePoint() {

		return bodyPiercePoint( this );

	}

	/**
	 * Live pierce site for the shared TSL slot. A profiled mesh
	 * (`sprayStations`) cuts along the waterline outline; anything else
	 * is the dorsal pole. Null when nothing meets the sea.
	 */
	pierceSite( opts = {} ) {

		this.pullFromController();
		const cfg = this.pierceConfig();
		if ( ! cfg ) return null;
		const sea = opts.seaLevel ?? ( this._primed && Number.isFinite( this.surf ) ? this.surf : 0 );
		if ( this.sprayStations ) return pierceSiteFromMesh( this, cfg, sea );
		const p = bodyPiercePoint( this );
		if ( ! p ) return null;
		return pierceSiteFrom( p.x, p.y, p.z, this, cfg, sea );

	}

	debugContacts( opts = {} ) {

		return bodyDebugContacts( this, opts );

	}

	syncMesh() {

		const m = this.mesh;
		if ( ! m?.position ) return;
		const { right, up, back } = craftBasis( this.heading, this.pitch, this.roll );
		const sx = m.scale?.x ?? 1, sy = m.scale?.y ?? 1, sz = m.scale?.z ?? 1;
		if ( m.position.set ) m.position.set( this.pos[ 0 ], this.pos[ 1 ], this.pos[ 2 ] );
		else {

			m.position.x = this.pos[ 0 ];
			m.position.y = this.pos[ 1 ];
			m.position.z = this.pos[ 2 ];

		}

		// Same sixteen floats as the ride-demo hull. Writing Euler yaw =
		// heading points the mesh backward and swaps the bank, so A/D
		// looked inverted on a box even though the path was correct.
		if ( m.matrix?.set ) {

			m.matrixAutoUpdate = false;
			m.matrix.set(
				right[ 0 ] * sx, up[ 0 ] * sy, back[ 0 ] * sz, this.pos[ 0 ],
				right[ 1 ] * sx, up[ 1 ] * sy, back[ 1 ] * sz, this.pos[ 1 ],
				right[ 2 ] * sx, up[ 2 ] * sy, back[ 2 ] * sz, this.pos[ 2 ],
				0, 0, 0, 1,
			);
			m.matrixWorldNeedsUpdate = true;

		} else if ( m.rotation ) {

			if ( 'order' in m.rotation ) m.rotation.order = 'YXZ';
			if ( 'x' in m.rotation ) m.rotation.x = this.pitch;
			if ( 'y' in m.rotation ) m.rotation.y = - this.heading;
			if ( 'z' in m.rotation ) m.rotation.z = this.roll;

		}

	}

}

/**
 * The list `createAbyssal()` owns. add / remove / step / stamp.
 */
export class BodyList {

	constructor() {

		this.items = [];
		this.waves = new WakeWaveField();
		this.flukes = new FlukeSlickField();
		this.carve = new PierceCarveField();
		this.vWake = new VWakeField();
		this.vWakeShape = { len: 70, width: 1.3, tan: V_WAKE_TAN, mid: 0.83, churn: 1 };
		// Leftover gravity waves. Three speed bands on one 320 m tile —
		// long leftover outruns short leftover, then we sum for the GPU.
		const tile = { ...LEFTOVER_TILE, heightCap: LEFTOVER_HEIGHT_CAP };
		this.rippleBands = LEFTOVER_BANDS.map( ( b ) => new RippleField( {
			...tile, speed: 4.3 * b.k, damping: b.damping,
		} ) );
		this.ripples = new RippleField( { ...tile, speed: 4.3, damping: 0 } );
		this._ripplePrev = null;
		this._ripplePrevSites = null;
		this.rippleDebug = 0;
		this.rippleVis = 1;
		this.rippleEmitDebug = 0;
		this.buoyDebug = 0;
		this.bubbles = new LeftoverBubbleField();

	}

	get length() { return this.items.length; }

	/**
	 * @param {object} mesh - a THREE.Object3D, or null for a headless body
	 * @param {object} [opts]
	 * @returns {OceanBody}
	 */
	add( mesh, opts = {} ) {

		const body = mesh instanceof OceanBody ? mesh : new OceanBody( mesh, opts );
		this.items.push( body );
		return body;

	}

	remove( bodyOrMesh ) {

		this.items = this.items.filter( ( b ) => b !== bodyOrMesh && b.mesh !== bodyOrMesh );

	}

	pullControllers() {

		for ( const b of this.items ) b.pullFromController();

	}

	step( dt, opts = {} ) {

		for ( const b of this.items ) {

			if ( b.controller ) {

				b.pullFromController();
				b.noteKinematics( dt );
				continue;

			}

			const sea = opts.seaLevel ?? 0;
			const pts = b.probePoints( opts );
			const base = b._probeH;
			const h = [];
			const leftover = [];
			if ( ! b._leftoverSmooth || b._leftoverSmooth.length !== pts.length ) {

				b._leftoverSmooth = new Array( pts.length ).fill( 0 );
				b._leftoverSmoothPrimed = false;

			}
			// Cap leftover Δh so own bow/motor boil cannot teleport the deck.
			const maxDh = 2.8 * Math.max( dt, 1e-4 );
			const smoothK = 1 - Math.exp( - dt / 0.12 );
			for ( let i = 0; i < pts.length; i ++ ) {

				const p = pts[ i ];
				const bh = base ? ( base[ i ] ?? base[ 0 ] ?? sea ) : sea;
				let lh = this.leftoverRideAt( p[ 0 ], p[ 1 ], b );
				const prev = b._leftoverSmooth[ i ];
				if ( b._leftoverSmoothPrimed ) {

					lh = prev + ( lh - prev ) * smoothK;
					lh = Math.max( prev - maxDh, Math.min( prev + maxDh, lh ) );

				}
				b._leftoverSmooth[ i ] = lh;
				leftover.push( lh );
				h.push( bh + lh );

			}
			b._leftoverSmoothPrimed = true;
			b.step( dt, { h, seaLevel: sea } );
			this.applyLeftoverSurge( b, leftover, dt );

		}

	}

	syncMeshes() {

		for ( const b of this.items ) b.syncMesh();

	}

	wakeSources( params ) {

		const out = [];
		for ( const b of this.items ) {

			const src = b.asWakeSource( params );
			if ( src ) out.push( src );

		}

		return out;

	}

	foamSources( params ) {

		const out = [];
		for ( const b of this.items ) {

			const src = b.asFoamSource( params );
			if ( src ) out.push( src );

		}

		return out;

	}

	recordSources( params ) {

		const out = [];
		for ( const b of this.items ) {

			const src = b.asRecordSource( params );
			if ( src ) out.push( src );

		}

		return out;

	}

	/**
	 * Expanding-ring contacts, including an escort that is cutting the
	 * sea. Those stay in world XZ and must not join `wakeSources()` —
	 * that list recenters the leftover-foam window.
	 */
	waveSources( params ) {

		const out = [];
		for ( const b of this.items ) {

			const src = b.asWakeSource( params, { escort: true } );
			if ( src ) out.push( src );

		}

		return out;

	}

	/**
	 * Ridden / flown body first, else the nearest wet hull to `camXZ`.
	 * Never a `wake: false` body — that slot is the analytic hollow under
	 * the camera, and the dragon must not steal it.
	 */
	primaryHull( camXZ ) {

		let ridden = null;
		for ( const b of this.items ) {

			if ( ! b.wakeConfig() ) continue;
			if ( b.controller?.active || b.isDriven() ) {

				ridden = b; break;

			}

		}

		if ( ridden ) return ridden;
		if ( ! camXZ ) return this.items.find( ( b ) => b.wakeConfig() && b.wet ) || null;
		let best = null, bestD = Infinity;
		for ( const b of this.items ) {

			if ( ! b.wakeConfig() || ! b.hull ) continue;
			if ( ! b.wet && ! b.controller ) continue;
			const d = Math.hypot( b.pos[ 0 ] - camXZ[ 0 ], b.pos[ 2 ] - camXZ[ 1 ] );
			if ( d < bestD ) { bestD = d; best = b; }

		}

		return best;

	}

	hasPhysicsWake() {

		for ( const b of this.items ) {

			if ( isPhysicsWake( b.wakeConfig() ) ) return true;

		}
		return false;

	}

	/**
	 * Shared leftover-wave slot. Piloted first, else the fastest
	 * `wake.physics` hull still touching the sea. Do not require
	 * `physicsOn` — that flag dies when a ski planes or leaves, and
	 * leftover must keep writing at high U.
	 */
	physicsWakeBody( params ) {

		let pick = null;
		let best = - 1;
		const sea = params?.seaLevel ?? 0;
		for ( const b of this.items ) {

			const cfg = b.wakeConfig();
			if ( ! isPhysicsWake( cfg ) ) continue;
			b.pullFromController();
			const airborne = !! ( b.airborne || b.controller?.jumpAirborne );
			const slap = ( b.impact ?? 0 ) > 0.12
				|| ( b.controller?.impact ?? 0 ) > 0.12;
			// Mid-jump: follow the tile, do not write — surfaceWorking can
			// stay true from a stale clearance and would keep punching water.
			if ( airborne && ! slap ) continue;
			const wet = !! b.wet
				|| ( typeof b.surfaceWorking === 'function' && b.surfaceWorking( sea ) )
				|| slap;
			if ( ! wet ) continue;
			const score = ( b.controller?.active ? 1000 : 0 )
				+ Math.abs( b.speed ?? 0 );
			if ( score > best ) {

				best = score;
				pick = b;

			}

		}
		return pick;

	}

	/**
	 * Hull that owns the leftover tile even mid-jump. Writes still go
	 * through {@link physicsWakeBody}; this only keeps the window from
	 * sliding off the trail when the boat leaves the sea.
	 */
	physicsWakeFollowBody( params ) {

		const writing = this.physicsWakeBody( params );
		if ( writing ) return writing;
		let pick = null;
		let best = - 1;
		for ( const b of this.items ) {

			const cfg = b.wakeConfig();
			if ( ! isPhysicsWake( cfg ) ) continue;
			b.pullFromController();
			const score = ( b.controller?.active ? 1000 : 0 )
				+ Math.abs( b.speed ?? 0 );
			if ( score > best ) {

				best = score;
				pick = b;

			}

		}
		return pick;

	}

	physicsWakeDims( params ) {

		const body = this.physicsWakeBody( params );
		return body ? body.wakeRenderDims( params ) : null;

	}

	/**
	 * Leftover height the hull should sit on. Occupancy cancel removes
	 * the hole this hull is punching (so a moving box does not sit in
	 * its own cradle). Driving over leftover punches that same hole
	 * through the wave, so the probes go flat while the sea still
	 * shows the wake. Sample leftover just outside the occupancy and
	 * mix a little crest / trough back — running into leftover swell.
	 * Keep the mix light and lateral: looking into the live bow boil
	 * made probe height flip every frame at plane speed (fore-aft snap).
	 */
	leftoverRideAt( x, z, body ) {

		const raw = this.ripples.sampleAt( x, z );
		if ( ! body || ! isPhysicsWake( body.wakeConfig() ) ) return raw;
		const occ = this.leftoverOccupancyAt( x, z, body );
		const cancelled = raw + occ;
		const heading = body.heading ?? 0;
		const fx = Math.sin( heading ), fz = - Math.cos( heading );
		const rx = Math.cos( heading ), rz = Math.sin( heading );
		const px = body.pos?.[ 0 ] ?? x, pz = body.pos?.[ 2 ] ?? z;
		const across = ( x - px ) * rx + ( z - pz ) * rz;
		const L = Math.max( body.length ?? body.size?.z ?? 8, 1 );
		const B = Math.max( body.size?.x ?? body.beam ?? 2, 0.4 );
		const side0 = Math.sign( across || 1 );
		// Side / slightly aft looks only — never dead-ahead into the bow pile.
		const looks = [
			[ - Math.max( L * 0.06, 0.6 ), B * 0.42 * side0 ],
			[ Math.max( L * 0.04, 0.4 ), B * 0.55 * side0 ],
			[ Math.max( L * 0.10, 0.8 ), B * 0.70 * side0 ],
		];
		let crest = cancelled;
		let trough = cancelled;
		let felt = false;
		for ( let i = 0; i < looks.length; i ++ ) {

			const ax = x + fx * looks[ i ][ 0 ] + rx * looks[ i ][ 1 ];
			const az = z + fz * looks[ i ][ 0 ] + rz * looks[ i ][ 1 ];
			if ( this.leftoverOccupancyAt( ax, az, body ) > 0.05 ) continue;
			const h = this.ripples.sampleAt( ax, az );
			felt = true;
			if ( h > crest ) crest = h;
			if ( h < trough ) trough = h;

		}
		if ( ! felt ) return cancelled;
		// Soft mix — enough to feel a leftover face, not pitch-snap the deck.
		return cancelled + 0.28 * ( 0.55 * ( crest - cancelled ) + 0.45 * ( trough - cancelled ) );

	}

	leftoverOccupancyAt( x, z, body ) {

		const sites = this._ripplePrevSites;
		if ( ! sites?.length || ! body || ! isPhysicsWake( body.wakeConfig() ) ) return 0;
		let s = 0;
		for ( let k = 0; k < sites.length; k ++ ) {

			const site = sites[ k ];
			if ( ! ( site.gain > 0 ) ) continue;
			for ( let i = 0; i < this.rippleBands.length; i ++ ) {

				s += this.rippleBands[ i ].occupancyAt(
					x, z,
					leftoverBandSite( site, i ),
					site.gain * LEFTOVER_BANDS[ i ].w,
				);

			}

		}
		return s;

	}

	applyLeftoverSurge( body, leftoverH, dt ) {

		if ( body.airborne || ! leftoverH || leftoverH.length < 4 ) return;
		const { along, across } = body.probeSpan();
		const a = leftoverSurge( leftoverH, along, across, body.probeLayout, body.speed );
		if ( a.along === 0 && a.across === 0 ) return;
		// Hard cap on Δv so a noisy face never snaps the path.
		const u = Math.abs( body.speed ?? 0 );
		const maxA = 1.6 / ( 1 + ( u / 8 ) * ( u / 8 ) );
		const ax = Math.max( - maxA, Math.min( maxA, a.along ) );
		const ay = Math.max( - maxA, Math.min( maxA, a.across ) );
		const fx = Math.sin( body.heading ), fz = - Math.cos( body.heading );
		const rx = Math.cos( body.heading ), rz = Math.sin( body.heading );
		body.vel[ 0 ] += ( fx * ax + rx * ay ) * dt;
		body.vel[ 2 ] += ( fz * ax + rz * ay ) * dt;
		body.speed = body.vel[ 0 ] * fx + body.vel[ 2 ] * fz;

	}

	_compositeRipples() {

		const out = this.ripples.h;
		const vel = this.ripples.v;
		const source = this.ripples.source;
		out.fill( 0 );
		vel.fill( 0 );
		source.fill( 0 );
		const n = out.length;
		for ( let b = 0; b < this.rippleBands.length; b ++ ) {

			const h = this.rippleBands[ b ].h;
			const v = this.rippleBands[ b ].v;
			const s = this.rippleBands[ b ].source;
			for ( let i = 0; i < n; i ++ ) {

				out[ i ] += h[ i ];
				vel[ i ] += v[ i ];
				source[ i ] += s[ i ];

			}

		}
		const src = this.rippleBands[ 0 ];
		this.ripples.ox = src.ox;
		this.ripples.oz = src.oz;
		this.ripples.cell = src.cell;
		this.ripples.speed = src.speed;
		this.ripples._clampHeight();
		this.ripples.revision ++;

	}

	/**
	 * The hull only displaces water. Leftover lives on a few speed
	 * bands in world XZ, then we sum them so long leftover outruns
	 * short leftover.
	 */
	stepRipples( dt, params = {} ) {

		const write = this.physicsWakeBody( params );
		const follow = this.physicsWakeFollowBody( params );
		if ( ! follow ) {

			for ( let i = 0; i < this.rippleBands.length; i ++ ) {

				this.rippleBands[ i ].beginDisplacementFrame();
				this.rippleBands[ i ].step( dt );

			}
			this._compositeRipples();
			if ( ! this.hasPhysicsWake() ) {

				this._ripplePrev = null;
				this._ripplePrevSites = null;

			}
			this.stepBubbles( dt, params );
			return this.ripples;

		}

		const body = follow;
		const L = Math.max( body.length ?? body.size?.z ?? 12, 0.8 );
		const c = hullSpeed( L );
		const now = hullRippleSite( body );
		// `now` is the hull centre in the same undisplaced frame the ripple
		// textures use. Keep every waterline station in that frame too.
		const cuts = write ? leftoverCutStations( body, {
			seaLevel: params?.seaLevel ?? body.surf ?? 0,
			xz: [ now.x, now.z ],
		} ) : [];
		const nowSites = write ? leftoverWriteSites( body, { cuts } ) : [];
		const prev = this._ripplePrev;
		const prevSites = this._ripplePrevSites;
		const jump = prev
			? Math.hypot( now.x - prev.x, now.z - prev.z )
			: 0;
		const cfg = body.wakeConfig?.() ?? parseWake( body.wake, body.size, {
			length: body.length, beam: body.beam,
		} );
		const waveLife = Math.min( Math.max( cfg?.damp ?? 1, 0.2 ), 4 );
		// Below 1.8, square the persist so 0.3 is a short leftover instead
		// of a 7 s e-fold the 320 m tile swallows before you see it.
		const persist = waveLife < 1.8 ? 1.8 / waveLife : 1;
		const emitCap = leftoverEmitMax( cfg );
		const emitOn = emitCap !== 0;
		const motor = write && emitOn ? Math.max( cfg?.motor ?? 0, 0 ) : 0;
		const jetW = cfg?.jet?.width ?? WAKE_JET_WIDTH;
		const jetH = cfg?.jet?.height ?? WAKE_JET_HEIGHT;
		const motorFill = jetMotionOf( body ).work;
		for ( let i = 0; i < this.rippleBands.length; i ++ ) {

			const spec = LEFTOVER_BANDS[ i ];
			const band = this.rippleBands[ i ];
			band.beginDisplacementFrame();
			band.speed = c * spec.k;
			band.damping = spec.damping / waveLife * persist;
			// Follow the hull even mid-jump so the trail does not leave the tile.
			const tile = leftoverTileOrigin( now, band.extent );
			band.recentreOn( tile.x, tile.z );
			if ( write && prevSites && jump < 16 ) {

				for ( let k = 0; k < nowSites.length; k ++ ) {

					const site = nowSites[ k ];
					if ( ! ( site.gain > 0 ) || ! prevSites[ k ] ) continue;
					band.displaceMove(
						leftoverBandSite( prevSites[ k ], i ),
						leftoverBandSite( site, i ),
						site.gain * spec.w,
					);

				}

			}
			// Prop wash: a tight stern jet of height, not the whole waterline.
			// Intensity fills toward wake.jet.amount (wake.motor) with
			// speed, accel, and turn — not a parked throttle stick.
			// Rate × dt — a per-frame impulse piled into a vertex tower
			// when the hull crawled or the tab went idle.
			const moving = Math.abs( body.speed ?? 0 ) > LEFTOVER_SPLASH_MIN_SPEED;
			if ( write && motor > 0.01 && moving ) {

				const fieldXZ = [ now.x, now.z ];
				const stern = wakeSternPoint( body, fieldXZ );
				const boil = leftoverSplashHeight( motor * motorFill * spec.w * jetH, dt );
				if ( boil > 1e-5 ) {

					const prevXZ = prev ? [ prev.x, prev.z ] : fieldXZ;
					const prevStern = wakeSternPoint( body, prevXZ );
					const jump = Math.hypot(
						stern[ 0 ] - prevStern[ 0 ], stern[ 1 ] - prevStern[ 1 ],
					);
					const span = leftoverJetSplashSpan(
						body.beam ?? body.size?.x ?? 2, jetW, jump,
					);
					const hx = stern[ 0 ] - prevStern[ 0 ];
					const hz = stern[ 1 ] - prevStern[ 1 ];
					const heading = jump > 0.04
						? Math.atan2( hx, - hz )
						: ( body.heading ?? 0 );
					const mx = ( stern[ 0 ] + prevStern[ 0 ] ) * 0.5;
					const mz = ( stern[ 1 ] + prevStern[ 1 ] ) * 0.5;
					band.splashAlong( mx, mz, heading, span.across, span.along, boil );

				}

			}
			// Bow entry: water shoved aside at the cutwater — same leftover
			// boil recipe as the motor jet, scaled by wake.foam (the ribbon).
			const foamAmt = write && emitOn ? Math.max( cfg?.foam ?? 0, 0 ) : 0;
			if ( write && foamAmt > 0.01 && moving ) {

				const fieldXZ = [ now.x, now.z ];
				const bow = wakeBowPoint( body, fieldXZ );
				const churnK = wakeFoamChurnK( body.speed, body.topSpeed );
				const beam = Math.max( body.beam ?? body.size?.x ?? 2, 0.6 );
				const Fr = froudeLength( body.speed, body.length ?? body.size?.z ?? 12 );
				const entry = leftoverSplashHeight(
					leftoverBowSplashGain( foamAmt, churnK, spec.w, Fr ), dt,
				);
				if ( entry > 1e-5 ) {

					const r = leftoverBowSplashRadius( beam, band.cell );
					band.splash( bow[ 0 ], bow[ 1 ], r, entry );

				}

			}
			band.step( dt );

		}
		this._compositeRipples();
		this._ripplePrev = now;
		if ( write ) this._ripplePrevSites = nowSites;
		this.stepBubbles( dt, params, write ? cuts : undefined );
		return this.ripples;

	}

	/**
	 * Pixel Lab whitewater: splash in the air, foam on leftover when
	 * it hits. Amount / splash 0 ages the pool only.
	 */
	stepBubbles( dt, params = {}, cuts ) {

		const body = this.physicsWakeBody( params );
		const cfg = parseLeftoverBubbles( body?.wake?.bubbles ?? body?.wakeConfig?.()?.bubbles );
		if ( ! body || ! cfg ) {

			this.bubbles.step( dt );
			return;

		}
		const sea = params.seaLevel ?? body.surf ?? 0;
		const sites = cuts ?? leftoverCutStations( body, { seaLevel: sea } );
		const field = this.ripples;
		this.bubbles.step( dt, sites, {
			amount: cfg.amount,
			splash: cfg.splash,
			life: cfg.life,
			size: cfg.size,
			count: cfg.count,
			speed: body.speed,
			openSpeed: Math.abs( body.speed ?? 0 ),
			diverge: params.wakeFoamDiverge ?? LEFTOVER_BUBBLE_DIVERGE,
			heading: body.heading,
			sea,
			hull: leftoverBubbleHull( body ),
			waveSpeed: field.speed,
			leftoverLook: ( x, z ) => {

				const h = field.sampleAt( x, z );
				const vh = field.sampleVelAt( x, z );
				if ( Math.abs( h ) < 0.004 && Math.abs( vh ) < 0.02 ) {

					return { h, vx: 0, vz: 0 };

				}
				const e = field.cell;
				return {
					h,
					...leftoverBubbleRide(
						( field.sampleAt( x + e, z ) - h ) / e,
						( field.sampleAt( x, z + e ) - h ) / e,
						vh,
						field.speed,
					),
				};

			},
		} );

	}

	/**
	 * Nearest body that wants the just-under swell slot. Unlike
	 * `primaryHull`, a `wake: false` body may own this — that is the
	 * dragon's slot, and any other mesh with `swell` on uses the same one.
	 */
	primarySwell( camXZ ) {

		let ridden = null;
		for ( const b of this.items ) {

			if ( ! parseSwell( b.swell, b.size, { length: b.length, beam: b.beam } ) ) continue;
			if ( b.controller?.active || b.isDriven() ) {

				ridden = b; break;

			}

		}

		if ( ridden ) return ridden;
		let best = null, bestD = Infinity;
		for ( const b of this.items ) {

			if ( ! parseSwell( b.swell, b.size, { length: b.length, beam: b.beam } ) ) continue;
			if ( ! camXZ ) return b;
			const d = Math.hypot( b.pos[ 0 ] - camXZ[ 0 ], b.pos[ 2 ] - camXZ[ 1 ] );
			if ( d < bestD ) { bestD = d; best = b; }

		}

		return best;

	}

	/**
	 * Profiled swimmer / dragon that owns tail prints. A planing hull
	 * with swell on must not steal this — those are ski leftovers.
	 */
	primaryFluke( camXZ ) {

		let pick = null;
		for ( const b of this.items ) {

			if ( b.sprayLook !== 'dragon' && ! b.sprayStations ) continue;
			if ( b.controller?.active || b.isDriven() ) return b;
			if ( ! pick ) pick = b;

		}

		if ( pick || ! camXZ ) return pick;
		let best = null, bestD = Infinity;
		for ( const b of this.items ) {

			if ( b.sprayLook !== 'dragon' && ! b.sprayStations ) continue;
			const d = Math.hypot( b.pos[ 0 ] - camXZ[ 0 ], b.pos[ 2 ] - camXZ[ 1 ] );
			if ( d < bestD ) { bestD = d; best = b; }

		}

		return best;

	}

	/**
	 * One tail stroke (or a waterline slap) drops a glassy disc.
	 * Prints age even when the loaf is off so a leap cannot snap them.
	 */
	stepFlukes( dt, opts = {}, camXZ ) {

		const body = this.primaryFluke( camXZ );
		const airborne = !!( body?.controller?.jumpAirborne || body?.jumpAirborne );
		if ( ! body || airborne ) {

			this.flukes.step( dt, {
				x: 0, z: 0,
				phase: body?.controller?.phase ?? body?.phase ?? 0,
				speed: 0, beam: 2, clearance: 80, fade: 9,
			} );
			return;

		}

		body.pullFromController();
		const L = body.length ?? body.size?.z ?? 60;
		const fluke = flukeWorld( body.pos, body.heading, L, body.pitch );
		const sea = body._primed && Number.isFinite( body.surf )
			? body.surf
			: ( opts.seaLevel ?? 0 );
		const cuts = wakeCutPoints( body, { seaLevel: sea } );
		let fx = fluke.x, fz = fluke.z, fy = fluke.y;
		if ( cuts.length ) {

			const aft = aftWakeSite( cuts, body.heading );
			const ax = aft?.x ?? aft?.[ 0 ];
			const az = aft?.z ?? aft?.[ 2 ] ?? aft?.[ 1 ];
			const tailish = ( aft?.along ?? - Infinity ) > L * 0.12
				|| Math.hypot( ( ax ?? 0 ) - fluke.x, ( az ?? 0 ) - fluke.z ) < Math.max( L * 0.18, 6 );
			if ( aft && tailish ) {

				fx = ax;
				fz = az;
				fy = aft.y ?? fluke.y;

			}

		}

		const params = opts.params || {};
		this.flukes.step( dt, {
			x: fx, z: fz,
			phase: body.controller?.phase ?? body.phase ?? 0,
			speed: body.speed ?? 0,
			beam: Math.max( body.beam ?? body.size?.x ?? 2, 1.2 ),
			clearance: sea - fy,
			fade: params.sdSwellFade ?? opts.flukeFade ?? 9,
			r0: params.sdFlukeSize ?? opts.flukeSize,
			life: params.sdFlukeLife ?? opts.flukeLife,
			gain: params.sdFluke ?? opts.fluke ?? 1,
		} );

	}

	/**
	 * Step every body's swell ease (so a toggle-off fades) and return
	 * the uniform payload for the shared slot. Fluke prints ride along
	 * even when the loaf is released.
	 */
	swellState( dt, opts = {}, camXZ ) {

		this.stepFlukes( dt, opts, camXZ );
		const pick = this.primarySwell( camXZ );
		let leftover = null;
		let chosen = null;
		for ( const b of this.items ) {

			const s = b.swellState( dt, opts );
			if ( b === pick ) chosen = s;
			if ( s ) leftover = s;

		}

		const swell = chosen || leftover;
		const prints = this.flukes.sites();
		if ( ! swell && ! prints.length ) return null;
		return {
			...( swell || { amp: 0, pos: [ 0, - 1e4, 0 ], dir: [ 0, 1 ], len: 1, rad: 1 } ),
			flukes: prints,
		};

	}

	/**
	 * Ridden / flown body first, else the nearest mesh that wants spray.
	 * Same pick as swell: a `wake: false` body may own this slot.
	 */
	primarySpray( camXZ ) {

		let piloted = null;
		let driven = null;
		for ( const b of this.items ) {

			if ( ! bodyWantsSpray( b ) ) continue;
			if ( b.controller?.active ) {

				piloted = b;
				break;

			}
			if ( ! driven && b.isDriven() ) driven = b;

		}

		if ( piloted ) return piloted;
		if ( driven ) return driven;
		let best = null, bestD = Infinity;
		for ( const b of this.items ) {

			if ( ! bodyWantsSpray( b ) ) continue;
			if ( ! camXZ ) return b;
			const d = Math.hypot( b.pos[ 0 ] - camXZ[ 0 ], b.pos[ 2 ] - camXZ[ 1 ] );
			if ( d < bestD ) { bestD = d; best = b; }

		}

		return best;

	}

	/**
	 * Payload for the shared GPU spray emitter, or null to park it.
	 */
	sprayState( dt, opts = {}, camXZ ) {

		const pick = this.primarySpray( camXZ );
		if ( ! pick ) return null;
		return pick.sprayState( dt, opts );

	}

	/**
	 * Ridden / flown body first, else the nearest mesh that wants a pole
	 * cut. Same pick as swell: a `wake: false` body may own this slot.
	 */
	primaryPierce( camXZ ) {

		let piloted = null;
		let driven = null;
		for ( const b of this.items ) {

			if ( ! parsePierce( b.pierce, b.size, pierceExtras( b ) ) ) continue;
			if ( b.controller?.active ) {

				piloted = b;
				break;

			}
			if ( ! driven && b.isDriven() ) driven = b;

		}

		if ( piloted ) return piloted;
		if ( driven ) return driven;
		let best = null, bestD = Infinity;
		for ( const b of this.items ) {

			if ( ! parsePierce( b.pierce, b.size, pierceExtras( b ) ) ) continue;
			if ( ! camXZ ) return b;
			const d = Math.hypot( b.pos[ 0 ] - camXZ[ 0 ], b.pos[ 2 ] - camXZ[ 1 ] );
			if ( d < bestD ) { bestD = d; best = b; }

		}

		return best;

	}

	/**
	 * Payload for the shared GPU pierce site, or null to switch it off.
	 */
	pierceState( opts = {}, camXZ ) {

		const pick = this.primaryPierce( camXZ );
		if ( ! pick || isPhysicsWake( pick.wakeConfig() ) ) return null;
		return pick.pierceSite( opts );

	}

	/**
	 * Age leftover pole-cut capsules and drop new ones from the live rod.
	 * Stamps keep fading after the rod leaves the sea.
	 */
	stepPierceCarve( dt, opts = {}, camXZ ) {

		const pick = this.primaryPierce( camXZ );
		if ( isPhysicsWake( pick?.wakeConfig() ) ) {

			this.carve.step( dt, null, { life: 0, speed: 0 } );
			return;

		}
		const cfg = pick?.pierceConfig() ?? null;
		const life = cfg?.life ?? 0;
		const site = life > 0.05 ? pick?.pierceSite( opts ) ?? null : null;
		const trail = site && Number.isFinite( site.tx ) && Number.isFinite( site.tz )
			? { ...site, x: site.tx, z: site.tz, half: 0 }
			: site;
		this.carve.step( dt, trail, {
			life,
			speed: pick?.speed ?? site?.speed ?? 0,
		} );

	}

	/**
	 * Chevron from the first waterline cut on a profiled body.
	 * A piloted mesh wins the shared slot; an escort that is still
	 * cutting writes the same way — the V is world-space, so it does
	 * not recenter the ski's leftover-foam field. Leftover stamps
	 * keep fading after a dive. A hull without `sprayStations`
	 * (the ski) never writes this slot.
	 */
	stepVWake( dt, params = {} ) {

		let body = null;
		let escort = null;
		for ( const b of this.items ) {

			if ( ! b.sprayStations ) continue;
			b.pullFromController();
			const cfg = b.wakeConfig();
			if ( ! cfg || isPhysicsWake( cfg ) ) continue;
			if ( b.controller?.jumpAirborne || b.jumpAirborne ) continue;
			if ( b.controller?.active || b.isDriven() ) {

				body = b;
				break;

			}
			if ( ! escort ) escort = b;

		}
		if ( ! body ) body = escort;
		const write = body
			? vWakeWrite( body, params, { seaLevel: params.seaLevel ?? 0 } )
			: null;
		this.vWake.step( dt, write?.contact ?? null, {
			life: write?.life ?? params.sdVWakeLife ?? 8.2,
		} );
		if ( write ) {

			this.vWakeShape = {
				len: write.len, width: write.width,
				tan: write.tan, mid: write.mid, churn: write.churn,
			};

		}

	}

	vWakeUniforms() {

		return {
			stamps: this.vWake.stamps,
			len: this.vWakeShape.len,
			width: this.vWakeShape.width,
			tan: this.vWakeShape.tan,
			mid: this.vWakeShape.mid,
			churn: this.vWakeShape.churn,
		};

	}

	stampWake( wake, dt, params, camera ) {

		const sources = this.wakeSources( params );
		const foam = this.foamSources( params );
		const waves = this.waveSources( params );
		// Physics hulls are not wakeSources (no leftover rings / stamp
		// height). They still have to write the passage record or the
		// 3-stripe has nothing to reconstruct from — jet and spray are
		// a different layer and vanish when those sliders are 0.
		const records = sources.length ? sources : this.recordSources( params );
		const cam = camera?.position
			? [ camera.position.x, camera.position.z ]
			: ( camera?.pos ? [ camera.pos[ 0 ], camera.pos[ 2 ] ] : null );
		wake.update( dt, params, records, { camera: cam } );
		if ( ! records.length && foam.length && typeof wake.trackWindow === 'function' ) {

			wake.trackWindow( dt, params, foam, { camera: cam } );

		}
		const contacts = [];
		for ( let i = 0; i < waves.length; i ++ ) {

			const list = wakeWaveContactsFrom( waves[ i ] );
			for ( let j = 0; j < list.length; j ++ ) contacts.push( list[ j ] );

		}
		this.waves.step( dt, contacts );
		wake.energy?.update( dt, params, foam, {
			camera: cam, follow: wake, rings: this.waves, ripples: this.ripples,
		} );
		return records;

	}

	packProbes( params ) {

		const points = [];
		let primary = null;
		for ( const b of this.items ) {

			if ( ! b.wantsProbe() ) { b._probeCount = 0; continue; }
			if ( points.length >= 16 ) { b._probeCount = 0; continue; }
			const pts = b.probePoints( params );
			b._probeSlot = points.length;
			const n = Math.min( pts.length, 16 - points.length );
			b._probeCount = n;
			for ( let i = 0; i < n; i ++ ) points.push( pts[ i ][ 0 ], pts[ i ][ 1 ] );
			if ( ! primary ) primary = b;

		}

		const half = primary
			? Math.max( primary.length ?? primary.size.z * 0.35, 0.4 )
			: 1.6;
		const xz = primary
			? ( primary.controller?.surfXZ ? primary.controller.surfXZ() : primary.surfXZ() )
			: [ 0, 0 ];
		const speed = Math.abs( primary?.speed ?? 0 );
		const top = primary?.topSpeed ?? 12;
		return {
			count: points.length >> 1,
			points,
			opts: {
				seaLevel: params?.seaLevel ?? 0,
				craftXZ: xz,
				wakeProbe: params?.wakeProbe ?? 0,
				wakeNear: half * 2.5,
				footprint: half,
				chop: 1 - Math.min( 0.9, speed / Math.max( top, 1 ) ),
			},
		};

	}

	acceptProbe( rows ) {

		if ( ! rows ) return;
		for ( const b of this.items ) {

			if ( ! b._probeCount ) continue;
			b.acceptSamples( rows.slice( b._probeSlot, b._probeSlot + b._probeCount ) );

		}

	}

	issueProbe( probe, params ) {

		const pack = this.packProbes( params );
		if ( ! pack.count ) return null;
		return probe.update( pack.points, pack.opts )
			.then( ( rows ) => this.acceptProbe( rows ) )
			.catch( () => {} );

	}

}
