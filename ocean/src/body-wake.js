// Per-mesh wake recipe for any OceanBody.
//
// The sea still has one shared field (TslWake / Wake). This module is the
// CPU side — parse, stamp station, layer mask, and the uniform payload —
// so a box or a boat can toggle a Kelvin V, a stern boil, a bow cut, and
// how that pattern opens, without a second field.
//
//   false / 0 / omitted / { on: 0 } / { count: 0 }  → off (do not stamp)
//   true / 1                                        → size-scaled defaults
//   a number                                        → defaults × that gain
//   { strength, beam, depth, … }                    → merge over defaults
//   beam: 'auto'                                    → mesh width (size.x)
//
// The sea samples two things for a vehicle:
//   1. Expanding rings (src/wake-wave.js) left at the stern — or, on a
//      piercing mesh, at the same waterline cuts spray uses. Each
//      centre stays in world XZ so a leftover crest is still there
//      after you turn around.
//   2. Aerated foam in the persistent energy field (src/foam-energy.js).
//      The hull sweep injects; the film decays on its own clock. Rings
//      stay as water waves. The stamp field still records the passage.
//      Surface height and Kelvin arms stay off here — the rings own the wave.
// Analytic Kelvin (src/kelvin-wake.js) is the following-V look and
// stays off for vehicles (kelvinOn === 0).

import { foamEnergyCarryBoost } from './foam-energy.js';
import { clamp } from './math.js';
import { wakePhysicsAmp } from './wake-physics.js';

const KELVIN_TAN = 0.3536;

export function wakeDefaults( size = {}, extras = {} ) {

	const L = Math.max( extras.length ?? size.z ?? 2, 0.4 );
	const B = Math.max( extras.beam ?? size.x ?? 0.6, 0.2 );
	return {
		strength: extras.strength ?? 0.9,
		depth: extras.depth ?? 0.28,
		beam: Math.max( B * 1.6, 0.3 ),
		armW: extras.armW ?? 1.5,
		arm: extras.arm ?? 1,
		churn: extras.churn ?? 0.5,
		spread: extras.spread ?? 0.22,
		// 0 = unused. The shader then keeps the historical formula.
		start: 0,
		end: 0,
		origin: 0,
		length: 0,
		life: 0,
		count: 3,
		bow: 0,
		turbulence: 0,
		armRate: 1,
		cut: 0.7,
		// Leftover white film in foam-energy (bow chines on physics hulls;
		// hull sweep on classic). Spray particles stay on `body.spray`.
		foam: 0.9,
		// 0 = use params.wakeFoamDecay. A positive number is e-folding seconds.
		persist: 0,
		// 1 writes the following Kelvin chevron. Vehicles stay 0;
		// leftover foam + expanding rings are their trail.
		kelvin: 0,
		// --- water DEFORMATION at the waterline cuts (src/wake-wave.js) ---
		// A body can trade foam for displaced water: `foam: 0` with these
		// up is a wake you see as shape, not as white.
		// Gain on ring height. `depth` × `strength` is the physical drive.
		wave: 1,
		// Ring thickness multiplier. A long animal wants a fatter crest
		// than a ski, or the rings read as wires.
		waveWidth: 1,
		// Seconds a ring lives. 0 = the field default (5 s).
		waveLife: 0,
		// Metres of travel between rings. 0 = auto from body length, so a
		// 60 m animal does not spend all sixteen stamps in half a second.
		waveGap: 0,
		// Scale on leftover gravity-wave persistence (1 = shipped band
		// damping). Higher = longer-lived ripples; 0.3 is a short chop.
		damp: 1,
		// Stern motor / prop wash: narrow centreline foam + height jet
		// behind the transom. 0 = hull sweep only (creatures, crates).
		// `jet` is the same wash with width / reach / leftover height;
		// `motor` stays the amount alias (`parseWake` fills both).
		motor: 0,
		// Cap on leftover height write stations. Omitted = every cut.
		emit: null,
		// 1 = gravity-wave leftover (src/wake-physics.js). Drops the
		// occupancy cut, expanding rings, and painted V. Foam is then
		// the energy film; airborne whitewater stays on spray emitters.
		physics: 0,
		// --- the V from the foremost cut (src/v-wake.js) ---
		// null = the sd* parameter. A number on the mesh wins.
		v: null,
		vAmp: null,
		vLen: null,
		vWidth: null,
		vAngle: null,
		vMid: null,
		vLife: null,
		// Churned lane between the arms — the only foam the V can write.
		// 0 keeps the wake pure displacement.
		vChurn: null,
	};

}

/** Gravity-wave experiment — no stamps, no cut. Leftover foam is the energy film. */
export function isPhysicsWake( cfg ) {

	return ( cfg?.physics ?? 0 ) > 0.5;

}

/** `beam: 'auto'` follows the mesh width (`size.x`). */
export function isAutoWakeBeam( beam ) {

	return beam === 'auto';

}

export function wakeBeamOf( beam, size = {} ) {

	if ( isAutoWakeBeam( beam ) ) return Math.max( size.x ?? 0.6, 0.2 );
	if ( beam > 0 ) return beam;
	return Math.max( ( size.x ?? 0.6 ) * 1.6, 0.3 );

}

/**
 * Leftover foam is born at the bow chines. `beam: 'auto'` on a 60 m
 * animal is eight metres across and reads as a coin glued to the body.
 * Cap it.
 */
export function wakeFoamBeamOf( cfg ) {

	return clamp( cfg?.beam ?? 1.2, 0.35, 2.2 );

}

/** Half-width of the transom jet as a fraction of beam. */
export const WAKE_JET_WIDTH = 0.16;
/** Metres astern the jet foam dies. Longer is a rooster, not a heading strip. */
export const WAKE_JET_REACH = 4;
/** Leftover height gain at the transom (same units as the old 0.42 boil). */
export const WAKE_JET_HEIGHT = 0.42;
/** Default amount when `jet: true` / `{ on: 1 }` with no amount. */
export const WAKE_JET_AMOUNT = 0.4;
/** Airborne rooster gain. 0 = foam + leftover height only. */
export const WAKE_JET_SPRAY = 0;
/** Nozzle exit speed (m/s). Same units as `craftJetSpeed`. */
export const WAKE_JET_SPRAY_SPEED = 17;
/** How much the rooster stands up. Same units as `craftJetRise`. */
export const WAKE_JET_SPRAY_RISE = 0.42;
/** Steer deflection (radians at full lock). Same units as `craftJetAngle`. */
export const WAKE_JET_SPRAY_ANGLE = 0.35;

/**
 * Transom jet tail. A number is amount (`motor: 0.4` still works).
 * `{ amount, width, reach, height, spray }` is the full recipe. `on: 0`
 * / `0` is off. Width is a fraction of beam; reach is metres astern;
 * height is leftover boil at the stern; spray is the airborne rooster
 * (foam still uses amount). Spray stays 0 unless set — a motor number
 * does not turn the rooster on. Spray can fly when amount is 0.
 */
export function parseWakeJet( raw, fallbackAmount = 0 ) {

	const widthOf = ( v ) => clamp( v ?? WAKE_JET_WIDTH, 0.04, 0.55 );
	const reachOf = ( v ) => clamp( v ?? WAKE_JET_REACH, 0.6, 12 );
	const heightOf = ( v ) => clamp( v ?? WAKE_JET_HEIGHT, 0, 1.2 );
	const sprayOf = ( v ) => clamp( v ?? WAKE_JET_SPRAY, 0, 2 );
	const spraySpeedOf = ( v ) => clamp( v ?? WAKE_JET_SPRAY_SPEED, 2, 40 );
	const sprayRiseOf = ( v ) => clamp( v ?? WAKE_JET_SPRAY_RISE, 0, 1.5 );
	const sprayAngleOf = ( v ) => clamp( v ?? WAKE_JET_SPRAY_ANGLE, 0, 1.4 );
	const withSpray = ( jet, rawJet ) => ( {
		...jet,
		spray: sprayOf( rawJet?.spray ),
		spraySpeed: spraySpeedOf( rawJet?.spraySpeed ),
		sprayRise: sprayRiseOf( rawJet?.sprayRise ),
		sprayAngle: sprayAngleOf( rawJet?.sprayAngle ),
	} );
	const base = {
		on: 0,
		amount: 0,
		width: WAKE_JET_WIDTH,
		reach: WAKE_JET_REACH,
		height: WAKE_JET_HEIGHT,
		spray: WAKE_JET_SPRAY,
		spraySpeed: WAKE_JET_SPRAY_SPEED,
		sprayRise: WAKE_JET_SPRAY_RISE,
		sprayAngle: WAKE_JET_SPRAY_ANGLE,
	};
	if ( raw == null || raw === false || raw === 0 ) return { ...base };
	if ( raw === true || raw === 1 ) {

		const amount = Math.max(
			fallbackAmount > 0.001 ? fallbackAmount : WAKE_JET_AMOUNT, 0,
		);
		return { ...base, on: amount > 0.001 ? 1 : 0, amount };

	}
	if ( typeof raw === 'number' ) {

		const amount = Math.max( raw, 0 );
		return { ...base, on: amount > 0.001 ? 1 : 0, amount };

	}
	if ( typeof raw !== 'object' ) return { ...base };
	const explicitOff = raw.on === false || raw.on === 0;
	const fallback = ( raw.on === true || raw.on === 1 )
		? ( fallbackAmount > 0.001 ? fallbackAmount : WAKE_JET_AMOUNT )
		: fallbackAmount;
	const amount = Math.max( Number( raw.amount ?? raw.motor ?? fallback ), 0 );
	const jet = withSpray( {
		on: 0,
		amount,
		width: widthOf( raw.width ),
		reach: reachOf( raw.reach ),
		height: heightOf( raw.height ),
	}, raw );
	// Airborne spray is not the foam jet. Amount 0 + spray > 0 is a
	// rooster without a leftover mound. `jet: 0` / `on: 0` still parks both.
	jet.on = explicitOff || ! ( amount > 0.001 || jet.spray > 0.001 ) ? 0 : 1;
	return jet;

}

function finishWake( cfg, jetRaw ) {

	if ( ! cfg ) return null;
	if ( jetRaw !== undefined && typeof jetRaw === 'object' && jetRaw !== null ) {

		cfg.jet = parseWakeJet( jetRaw, cfg.motor );

	} else if ( jetRaw !== undefined ) {

		cfg.jet = parseWakeJet( jetRaw, 0 );

	} else {

		cfg.jet = parseWakeJet( cfg.motor );

	}
	cfg.motor = cfg.jet.on ? cfg.jet.amount : 0;
	return cfg;

}

function scaleGain( cfg, gain ) {

	if ( gain === 1 ) return cfg;
	return {
		...cfg,
		strength: cfg.strength * gain,
		depth: cfg.depth * gain,
		bow: cfg.bow * gain,
		turbulence: cfg.turbulence * gain,
	};

}

/**
 * `false` / `0` / omitted → off.
 * `true` / `1` → size-scaled defaults (legacy reconstruction).
 * A number → defaults × that gain.
 * An object merges over defaults. `on: 0` or `count: 0` is off;
 * `on` as a number is gain.
 */
export function parseWake( value, size = {}, extras = {} ) {

	if ( value === false || value == null || value === 0 ) return null;
	const d = wakeDefaults( size, extras );
	if ( value === true || value === 1 ) return finishWake( d );
	if ( typeof value === 'number' ) {

		if ( ! ( value > 0.001 ) ) return null;
		return finishWake( scaleGain( d, value ) );

	}

	const on = value.on;
	if ( on === false || on === 0 ) return null;
	if ( value.count === 0 ) return null;
	const gain = on == null || on === true ? 1 : on;
	if ( ! ( gain > 0.001 ) ) return null;
	const merged = { ...d, ...value };
	delete merged.on;
	if ( isAutoWakeBeam( value.beam ) ) merged.beam = wakeBeamOf( 'auto', size );
	return finishWake( scaleGain( merged, gain ), value.jet );

}

/**
 * Which foam / height layers a `count` (and an optional `bow`) turns on.
 *
 *   1  stern boil only
 *   2  Kelvin V only
 *   3  V + boil  (the photo's core)
 *   4  V + boil + bow cut
 */
export function wakeLayers( cfg ) {

	const n = Math.max( 0, Math.round( cfg?.count ?? 3 ) );
	const bow = cfg?.bow != null ? cfg.bow : ( n >= 4 ? 0.4 : 0 );
	return {
		arms: n >= 2 ? 2 : 0,
		trail: n === 2 || n <= 0 ? 0 : 1,
		bow: bow > 0.001 ? bow : 0,
	};

}

/** Seconds the field keeps a stamp. `length` is metres of visible trail. */
export function wakeLifeOf( cfg, speed, params ) {

	if ( ! cfg ) return params?.wakeLife ?? 14;
	if ( cfg.life > 0 ) return clamp( cfg.life, 1.2, 24 );
	if ( cfg.length > 0 ) {

		return clamp( cfg.length / Math.max( Math.abs( speed ), 2 ), 1.5, 20 );

	}

	return params?.wakeLife ?? 14;

}

/**
 * Scale on tan(19.47°) so the V's half-width at `life` lands on `end`
 * when both start and end are set. Otherwise the physical Kelvin rate.
 */
export function wakeArmRateOf( cfg, speed, life ) {

	if ( ! cfg ) return 1;
	if ( cfg.end > 0.01 && cfg.start >= 0 && life > 0.2 ) {

		const want = Math.max( cfg.end - Math.max( cfg.start, 0 ), 0.05 );
		const physical = KELVIN_TAN * Math.max( Math.abs( speed ), 0.5 ) * life;
		return clamp( want / Math.max( physical, 1e-4 ), 0.12, 4 );

	}

	return cfg.armRate ?? 1;

}

/**
 * World XZ of the stamp station. `origin` is a fraction of half-length:
 * −1 at the stern, 0 at the centre, +1 at the bow. Past −1 is behind
 * the transom. Heading 0 is −Z.
 */
export function wakeStampPoint( body, cfg, xz ) {

	const p = xz || [ body?.pos?.[ 0 ] ?? 0, body?.pos?.[ 2 ] ?? 0 ];
	const origin = cfg?.origin ?? 0;
	if ( ! origin ) return [ p[ 0 ], p[ 1 ] ];
	const L = Math.max( body?.size?.z ?? body?.length ?? 2, 0.4 );
	const heading = body?.heading ?? 0;
	const hx = Math.sin( heading );
	const hz = - Math.cos( heading );
	const along = origin * L * 0.5;
	return [ p[ 0 ] + hx * along, p[ 1 ] + hz * along ];

}

/**
 * XZ of the bow cut. Pass `xz` when writing a Lagrangian water field; omit it
 * for a literal world-space effect such as a particle.
 */
export function wakeBowPoint( body, xz ) {

	const L = Math.max( body?.size?.z ?? body?.length ?? 2, 0.4 );
	const heading = body?.heading ?? 0;
	const hx = Math.sin( heading );
	const hz = - Math.cos( heading );
	const along = L * 0.48;
	const x = xz?.[ 0 ] ?? body?.pos?.[ 0 ] ?? 0;
	const z = xz?.[ 1 ] ?? body?.pos?.[ 2 ] ?? 0;
	return [ x + hx * along, z + hz * along ];

}

/**
 * XZ of the transom / motor. As with wakeBowPoint(), water-field callers pass
 * the hull's surfXZ reference coordinate; particles may use world XZ.
 */
export function wakeSternPoint( body, xz ) {

	const L = Math.max( body?.size?.z ?? body?.length ?? 2, 0.4 );
	const heading = body?.heading ?? 0;
	const hx = Math.sin( heading );
	const hz = - Math.cos( heading );
	const along = L * 0.48;
	const x = xz?.[ 0 ] ?? body?.pos?.[ 0 ] ?? 0;
	const z = xz?.[ 1 ] ?? body?.pos?.[ 2 ] ?? 0;
	return [ x - hx * along, z - hz * along ];

}

/**
 * Everything TslWake.uniforms() reads as `dims` for the body that owns
 * the shared reconstruction slot this frame.
 */
export function physicsRenderDims( cfg, body, params ) {

	const heading = body?.heading ?? 0;
	const speed = Math.abs( body?.speed ?? body?.controller?.speed ?? 0 );
	const airborne = !! ( body?.airborne || body?.controller?.jumpAirborne );
	const sea = params?.seaLevel ?? 0;
	const working = ! airborne && (
		!! body?.wet
		|| ( typeof body?.surfaceWorking === 'function' && body.surfaceWorking( sea ) )
	);
	const L = Math.max( body?.length ?? body?.size?.z ?? 12, 0.8 );
	const depth = params?.floorDepth ?? params?.depth ?? params?.waterDepth ?? 40;
	const yaw = Math.abs( body?.yawRate ?? body?.controller?.yawRate ?? 0 );
	const yawK = Math.min( 1, yaw * L / Math.max( speed, 1 ) );
	const surf = body?.controller?.surfXZ
		? body.controller.surfXZ()
		: ( typeof body?.surfXZ === 'function' ? body.surfXZ() : null );
	const head = wakeBowPoint( body, surf );
	return {
		kelvinOn: 0,
		physicsOn: working && speed > 0.55 ? 1 : 0,
		foamOn: ( cfg?.foam ?? 0 ) > 0.001 ? 1 : 0,
		kelvinHead: head,
		kelvinFwd: [ Math.sin( heading ), - Math.cos( heading ) ],
		kelvinSpeed: speed,
		physicsAmp: wakePhysicsAmp( {
			speed, length: L, depth, amp: cfg?.strength ?? 1,
		} ) * ( 1 + 0.28 * yawK ),
		physicsLen: L,
		physicsBeam: cfg?.beam ?? body?.size?.x ?? 2,
		physicsDepth: depth,
		physicsDecay: Math.max( 80, 4 * L ),
		// Height stays with the leftover ripple field. The record only
		// reconstructs the FOAM wedge, so depth / trail stay 0.
		depth: 0,
		trail: 0,
		...physicsArmDims( cfg, body, params, speed ),
	};

}

/**
 * The spreading wedge, RECONSTRUCTED from the record rather than advected.
 *
 * A Kelvin arm leaves the track at ~0.35 U. On the 512 / 320 m field that is
 * about a ninth of a texel per frame, and semi-Lagrangian advection at a
 * fraction of a texel per step is almost entirely numerical diffusion — the
 * ridge dissolves before it has travelled anywhere. See the header of
 * wake.js, which documents that experiment. Rebuilding
 * `|lat| = width0 + rate·age` from the stored age has no such error.
 *
 * It is also why this cannot rotate with the wheel: `age` and signed `lat`
 * were written into each texel as the hull went past, so the wedge follows
 * the track the boat actually took, not the heading it holds now.
 */
export function physicsArmDims( cfg, body, params, speed ) {

	const foam = clamp( cfg?.foam ?? 0, 0, 1.5 );
	// The filled ribbon and the Kelvin rails are different things.
	// foam 0 must still reconstruct the 3-stripe (center wash + two
	// cusp arms) or the ribbon slider erases the whole wake.
	const beam = Math.max( cfg?.beam ?? body?.size?.x ?? 2, 0.35 );
	const half = beam * 0.5;
	const U = Math.max( Math.abs( speed ), 0.5 );
	// Metres per second the cusp leaves the track. tan(19.47°).
	// "Foam carry" is the user-facing knob for how far the wake reaches
	// sideways. On its own it only walks film along leftover faces, so the
	// analytic wedge has to open with it too or turning it up smears the
	// film while the arms stay pinned. Above 1x this is a deliberate
	// stylisation: the real cusp locus sits at 19.47deg at every speed.
	const spreadK = Math.sqrt( Math.max( foamEnergyCarryBoost( params?.wakeFoamWaveCarry ), 0.25 ) );
	const armRate = KELVIN_TAN * U * spreadK;
	// Let the wedge die INSIDE the record window. Running the full extent
	// is what made the trail reach the horizon at full strength.
	const extent = Math.max( params?.wakeExtent ?? 320, 40 );
	const life = clamp( extent * 0.42 / U, 3.5, 24 );
	return {
		arms: 1,
		life,
		armRate,
		// wakeAtCpu() scales the reconstruction by this at the very end.
		// physicsRenderDims never set it while arm was 0, so leaving it
		// out now silently turns the whole wedge into NaN on the CPU twin.
		strength: clamp( cfg?.strength ?? 1, 0, 4 ),
		// Arm ridges, then the entrained air between them.
		// A floor so rails stay visible when the ribbon slider is 0.
		arm: Math.max( foam, 0.55 ) * 1.55,
		churn: Math.max( foam, 0.45 ) * 0.55,
		// The cusp band broadens and softens as it ages.
		armW: Math.max( beam * 0.30, 0.55 ),
		spread: 0.42,
		// width0 is the arm's origin at the transom; passing it also puts
		// the reconstruction in its "photo" mode, where the ridge reads as
		// foam instead of only height.
		width0: Math.max( half, 0.1 ),
		// The boil between the arms widens from the transom beam out to the
		// arms' final stand, which is the filled apron rather than a lane.
		width1: Math.max( half + armRate * life, half + 0.2 ),
		turb: clamp( cfg?.turbulence ?? 0.35, 0, 1 ),
		beam: Math.max( half, 0.15 ),
		cut: 0,
	};

}

export function wakeRenderDimsFrom( cfg, body, params ) {

	if ( isPhysicsWake( cfg ) ) return physicsRenderDims( cfg, body, params );

	const dims = { kelvinOn: 0 };
	if ( ! cfg ) return dims;
	const speed = body?.speed ?? 0;
	const life = wakeLifeOf( cfg, speed, params );
	const foam = clamp( cfg.foam ?? 0.9, 0, 1.5 ) * 1.8;
	dims.life = life;
	dims.strength = cfg.strength ?? 1;
	// Foam-only reconstruction. The field's recorded `stir` is measured from
	// speed, yaw, slip, hull load and impact, so these gains describe the
	// material while the body dynamics decide how much is actually deposited.
	// depth / arms remain zero: expanding rings are the vehicle's real wave.
	dims.depth = 0;
	dims.beam = cfg.beam;
	dims.armW = cfg.armW;
	dims.arm = foam;
	dims.churn = foam * clamp( cfg.churn ?? 0.5, 0, 2 );
	dims.spread = cfg.spread;
	dims.armRate = wakeArmRateOf( cfg, speed, life );
	dims.arms = 0;
	dims.trail = foam > 0.001 ? 1 : 0;
	dims.turb = cfg.turbulence ?? 0;
	dims.width0 = 0;
	dims.width1 = 0;
	dims.cut = 0;
	const heading = body?.heading ?? 0;
	const surf = body?.controller?.surfXZ
		? body.controller.surfXZ()
		: ( typeof body?.surfXZ === 'function' ? body.surfXZ() : null );
	const head = wakeStampPoint( body, cfg, surf );
	dims.kelvinOn = ( cfg.kelvin ?? 0 ) > 0.5 ? 1 : 0;
	dims.kelvinHead = head;
	dims.kelvinFwd = [ Math.sin( heading ), - Math.cos( heading ) ];
	dims.kelvinSpeed = Math.abs( speed );
	if ( dims.kelvinOn ) {

		dims.kelvinAmp = Math.max( cfg.strength ?? 0.85, 0.15 );
		// Height only. White water is the leftover energy trail; Kelvin
		// foam follows the head and looked glued to the body.
		dims.kelvinFoam = cfg.kelvinFoam ?? 0;
		dims.kelvinLen = Math.max( body?.length ?? body?.size?.z ?? 60, 8 );
		dims.kelvinWidth = cfg.beam ?? 0;
		dims.kelvinDecay = cfg.length > 8 ? cfg.length : 140;

	}

	return dims;

}
