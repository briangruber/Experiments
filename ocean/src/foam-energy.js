// Persistent foam energy. Coverage lives in a world-anchored field.
//
// Energy is extra wind-foam coverage. Inject a local brush along the hull
// sweep, then decay. Wake rings displace water; they do not print leftover
// foam (that drew expanding circles that popped a metre aft of the transom).
// The water shader writes the film into foamF / foamR so the same lace and
// shading as whitecaps apply.
//
// The stamp field (src/wake.js) still stores the hull RECORD. This field is
// the leftover material — it accumulates, it stays after the crest moves on,
// and a straight run is centred because the inject is a symmetric Gaussian.
//
// GPU twins: src/gpu/tsl/foam-energy.js (update) and foamEnergyAt() in
// water-common.js / FOAM_ENERGY_SAMPLE_GLSL below. A change here is not done
// until tools/check-foam-energy.mjs passes.

import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { planWakeFrame } from './wake-interact.js';
import { wakeFoamMask } from './foam-lace.js';
import { wakeWaveSlopeFieldAt } from './wake-wave.js';
import { KELVIN_TAN } from './kelvin-wake.js';
import { waterlineHalfAt } from './breach-emitters.js';
import { leftoverBubbleRide } from './leftover-bubbles.js';

export const FOAM_ENERGY_DECAY = 1.4;
export const FOAM_ENERGY_DECAY_MIN = 0.12;
export const FOAM_ENERGY_DECAY_MAX = 12;
export const FOAM_ENERGY_BREAK = 0.07;
export const FOAM_ENERGY_HULL = 1.15;
// 0: leftover is the hull sweep only. Ring-shoulder inject printed
// expanding foam circles that popped in a metre aft of the transom.
export const FOAM_ENERGY_CREST = 0;
/** Opt-in gain for a ring-shoulder leftover test. Live leftover ignores this. */
export const FOAM_ENERGY_CREST_TEST = 0.85;
export const FOAM_ENERGY_TELEPORT = 5.0;
/** Headroom above the hull ribbon so motor inject can stack and show. */
export const FOAM_ENERGY_MAX = 2.35;
export const FOAM_ENERGY_BEAM = 0.85;
export const FOAM_ENERGY_BRUSH = 0.85;
/** Soft metres past the sweep ends. A circular aft gaussian printed coins. */
export const FOAM_ENERGY_CAP = 0.45;
/** @deprecated The live ribbon is no longer split into two shoulder lobes. */
export const FOAM_ENERGY_SHOULDER = 0.40;
/** @deprecated The live ribbon is one beam-wide superellipse. */
export const FOAM_ENERGY_SHOULDER_W = 0.22;
/**
 * @deprecated Compatibility export from the former twin-lobe profile.
 */
export const FOAM_ENERGY_STEM_FILL = 0.35;
/**
 * Half-width of the connected hull ribbon as a fraction of full beam
 * when the stamp has no mesh planform. An eighth-power superellipse is
 * flat across the *local* half-beam, then turns down at the chines.
 */
export const FOAM_ENERGY_RIBBON_W = 0.50;
/**
 * Amidships film as a fraction of bow / stern. A real wake is white at
 * the cutwater and the transom wash, then a quieter stretch of sea
 * along the mid-body before the V opens. 1 is the old solid slab.
 */
export const FOAM_ENERGY_ALONG_FLOOR = 0;
/**
 * Centreline film in the transom wake. 0 is a real wedge of sea —
 * a pedestal here integrates to a white slab over a persist window.
 */
export const FOAM_ENERGY_WAKE_CHANNEL = 0;
/**
 * Extra decay (1/s) on the sailing-line channel. The bow still paints a
 * slab; without this, persist turns that slab into the solid ribbon the
 * transom lane can never un-write. Rails are not carved.
 */
export const FOAM_ENERGY_WAKE_CARVE = 22;
/** Finite metres astern the live transom may keep carving. Not a heading strip. */
export const FOAM_ENERGY_WAKE_CARVE_AFT = 5.0;
/** Bow→stern samples of local half-beam (metres) uploaded to the GPU. */
export const FOAM_ENERGY_PLANFORM_N = 16;
/** Gain from wave energy flux (-vertical velocity × height slope) to foam drift. */
export const FOAM_ENERGY_WAVE_CARRY = 1.25;
/**
 * Displacement-speed floor on wave-driven foam drift, m/s. Flux
 * `-dh/dt × ∇h` is only centimetres per second on leftover faces, so
 * this cap is plenty below leftover speed. Once the hull outruns leftover,
 * existing film rides those faces at leftover *c* — see
 * {@link foamEnergyWaveRide} — or the ribbon stays a heading stripe
 * while the V opens as water.
 */
export const FOAM_ENERGY_WAVE_MAX = 0.45;
/** Wave-gated local neighbour exchange; broadens old foam without teleporting it. */
export const FOAM_ENERGY_WAVE_SPREAD = 2.2;
/**
 * Ceiling on the carry multiplier, as a factor of FOAM_ENERGY_WAVE_CARRY.
 *
 * Carry used to be capped twice over, and the second cap cancelled the
 * first: the ride term was clamped to 2x, and then the speed limit was
 * `max(maxSpeed, rideSpeed)` — exactly the magnitude the ride term already
 * had — so the boost was scaled straight back out. The film could never
 * move faster than leftover *c* no matter how far the slider went, which
 * is why turning carry up did not widen the wake. Both scale together now.
 */
export const FOAM_ENERGY_CARRY_MAX = 8;
export function foamEnergyCarryBoost( carry ) {

	return clamp(
		( carry ?? FOAM_ENERGY_WAVE_CARRY ) / FOAM_ENERGY_WAVE_CARRY,
		0, FOAM_ENERGY_CARRY_MAX,
	);

}
/**
 * Optional live-heading Kelvin peel. Off by default: a scalar coverage field
 * does not retain each patch's birth heading, so steering it from the current
 * hull frame can move fresh film sideways during a turn. Gravity-wave height
 * still forms the divergent arms; the material churn stays on the sailed path.
 */
export const FOAM_ENERGY_DIVERGE = 0;
/**
 * How much the Kelvin / Mach arm radius wobbles (± fraction). A fixed
 * half-angle draws a ruled V; this tears the outer white edge.
 */
export const FOAM_ENERGY_ARM_JITTER = 0.48;
/** Metres along the wake for one arm-noise lobe. */
export const FOAM_ENERGY_ARM_NOISE_M = 6.5;
/**
 * Beam fraction the peel takes to cross the centreline. A `sign(lat)`
 * flip reversed drift between neighbouring texels, so foam was pulled
 * apart along a razor-straight line through the hull. Running straight
 * that line hides inside the ribbon; a turn sweeps it across the older,
 * curved trail and it reads as a drawn edge on the V.
 */
export const FOAM_ENERGY_PEEL_CROSS = 0.5;
/**
 * Seconds of travel the live heading is allowed to steer. The arms
 * belong to the frame the foam was born in; water further astern was
 * laid under a different heading, so the live wedge must let go of it
 * instead of rotating old water with the wheel.
 *
 * Half a second is about as long as the live heading can honestly claim
 * to be the water's own frame. At three seconds this owned some sixty
 * metres of trail, and a turn dragged all of it round with the wheel.
 */
export const FOAM_ENERGY_PEEL_MEMORY = 0.5;
/** Half-width of the motor/prop jet as a fraction of beam. */
export const FOAM_ENERGY_MOTOR_W = 0.16;
/** Metres astern the jet is full strength, then fades to FOAM_ENERGY_MOTOR_REACH. */
export const FOAM_ENERGY_MOTOR_REACH0 = 1.2;
/** Metres astern the transom jet dies. Longer is a rooster, not a heading strip. */
export const FOAM_ENERGY_MOTOR_REACH = 4.0;
/** Extra gain on the motor jet relative to hull ribbon stir. */
export const FOAM_ENERGY_MOTOR = 2.35;
/** Energy above this (after gather) reads as continuous prop wash. */
export const FOAM_ENERGY_MOTOR_CORE = 1.2;

const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const clamp = ( x, a, b ) => Math.min( b, Math.max( a, x ) );
const mix = ( a, b, t ) => a + ( b - a ) * t;

function smoothstep( e0, e1, x ) {

	const t = clamp01( ( x - e0 ) / ( e1 - e0 || 1e-6 ) );
	return t * t * ( 3 - 2 * t );

}

export function foamEnergyDecay( prev, dt, decay = FOAM_ENERGY_DECAY ) {

	return Math.max( 0, prev ) * Math.exp( - Math.max( dt, 0 ) / Math.max( decay, FOAM_ENERGY_DECAY_MIN ) );

}

/**
 * E-folding seconds for leftover stern foam. `wake.persist` on a body
 * wins; otherwise `params.wakeFoamDecay`. The shared field uses the
 * longest persist among this frame's stamps.
 */
export function wakeFoamDecayOf( cfgOrPlan, params ) {

	const fallback = clamp(
		params?.wakeFoamDecay ?? FOAM_ENERGY_DECAY,
		FOAM_ENERGY_DECAY_MIN, FOAM_ENERGY_DECAY_MAX,
	);
	if ( ! cfgOrPlan ) return fallback;
	if ( cfgOrPlan.persist > 0 ) {

		return clamp( cfgOrPlan.persist, FOAM_ENERGY_DECAY_MIN, FOAM_ENERGY_DECAY_MAX );

	}
	const stamps = cfgOrPlan.stamps;
	if ( ! stamps ) return fallback;
	let found = false;
	let d = fallback;
	for ( let i = 0; i < stamps.length; i ++ ) {

		if ( stamps[ i ].persist > 0 ) {

			const next = clamp(
				stamps[ i ].persist, FOAM_ENERGY_DECAY_MIN, FOAM_ENERGY_DECAY_MAX,
			);
			d = found ? Math.max( d, next ) : next;
			found = true;

		}

	}
	return d;

}

/** Cap a long first-frame leap so it cannot dump a slab of foam at once. */
export function foamEnergyBrush( jump ) {

	if ( ! ( jump > 0 ) ) return 1;
	if ( jump >= FOAM_ENERGY_TELEPORT ) return 0;
	return jump <= 0.12 ? 1 : Math.min( 1, FOAM_ENERGY_BRUSH / jump );

}

/**
 * Metres of hull sweep to deposit this frame. Per-metre, not per-second,
 * so a crawl and a cruise lay the same ribbon instead of waiting for
 * energy to pile up and pop.
 */
export function foamEnergyPath( jump ) {

	if ( ! ( jump > 0 ) ) return 0;
	if ( jump >= FOAM_ENERGY_TELEPORT ) return 0;
	return Math.max( jump, 0.05 ) * foamEnergyBrush( jump );

}

/**
 * How much of this frame's A→B stroke a world point belongs to.
 * `t` is the unclamped line parameter (0 at A, 1 at B).
 */
export function foamEnergySweep( t, jump ) {

	const len = Math.max( jump, 1e-5 );
	const metres = t < 0 ? - t * len : t > 1 ? ( t - 1 ) * len : 0;
	if ( metres <= 0 ) return 1;
	const u = metres / FOAM_ENERGY_CAP;
	return Math.exp( - u * u );

}

/**
 * Live hull footprint in bow-local `along`. The A→B sweep only covers the
 * cutwater's travel this frame, so a yaw left the transom sitting on empty
 * water. This keeps foam on the current waterline (and a short wash aft)
 * without painting an infinite heading strip.
 */
export function foamEnergyLiveHull( along, hullLen = 0 ) {

	const L = Math.max( hullLen ?? 0, 0 );
	if ( L < 0.8 ) return 0;
	const behindBow = 1 - smoothstep( 0.05, 0.35, along );
	const stern = - L * 0.96;
	const pastStern = 1 - smoothstep( stern - 0.25, stern - 1.0, along );
	return behindBow * pastStern;

}

/**
 * Along-hull whitewater. Station 0 = bow, 1 = stern. Bow entry and
 * transom wash stay bright; amidships drops toward
 * {@link FOAM_ENERGY_ALONG_FLOOR} so the sea shows through that gap.
 * Path-only stamps (no LOA) stay the old solid stencil.
 *
 * @param {number} along metres ahead of the bow stamp (negative is aft)
 * @param {number} [hullLen=0]
 * @returns {number} 0..1
 */
export function foamEnergyAlong( along, hullLen = 0 ) {

	const L = Math.max( hullLen ?? 0, 0 );
	if ( L < 0.8 ) return 1;
	const s = clamp01( - along / L );
	const bow = 1 - smoothstep( 0.16, 0.40, s );
	const stern = smoothstep( 0.62, 0.88, s );
	const floor = FOAM_ENERGY_ALONG_FLOOR;
	return floor + ( 1 - floor ) * Math.max( bow, stern );

}

/**
 * 0 on the bow run, 1 from the quarters aft. Path-only stamps stay 0
 * so the old solid rectangle does not grow a channel.
 */
export function foamEnergyWakeOpen( along, hullLen = 0 ) {

	const L = Math.max( hullLen ?? 0, 0 );
	if ( L < 0.8 ) return 0;
	const s = clamp01( - along / L );
	const aft = - along - L * 0.96;
	return Math.max( smoothstep( 0.70, 0.90, s ), smoothstep( - 0.15, 1.2, aft ) );

}

/**
 * Flat bow band, then two transom rails with sea on the sailing line.
 * `open` is {@link foamEnergyWakeOpen}; 0 is the old superellipse.
 */
export function foamEnergyLane( lat, half, open = 0 ) {

	const w = Math.max( half, 0.08 );
	const q = lat / w;
	const q2 = q * q;
	const band = Math.exp( - q2 * q2 * q2 * q2 );
	if ( ! ( open > 0.001 ) ) return band;
	const rail = smoothstep( 0.20, 0.50, Math.abs( q ) );
	const floor = FOAM_ENERGY_WAKE_CHANNEL;
	return band * mix( 1, floor + ( 1 - floor ) * rail, clamp01( open ) );

}

/**
 * Wash leans to the OUTSIDE of a turn. The inner rail is quieter, never
 * gone: the hull is still cutting water on that side. yawRate > 0 is a
 * right turn (heading increases); starboard is +lat.
 */
export const FOAM_ENERGY_TURN_INNER = 0.42;
export const FOAM_ENERGY_TURN_OUTER = 0.38;
export function foamEnergyTurnBias( lat, yawRate = 0, beam = 1.2 ) {

	const yaw = yawRate ?? 0;
	if ( ! ( Math.abs( yaw ) > 0.03 ) ) return 1;
	const turnK = clamp( Math.abs( yaw ) / 0.55, 0, 1 );
	const B = Math.max( beam ?? 1.2, 0.35 );
	const outer = yaw > 0 ? - 1 : 1;
	const side = clamp( lat / ( B * 0.42 ), - 1, 1 );
	const towardOuter = side * outer;
	return mix(
		1 - FOAM_ENERGY_TURN_INNER * turnK,
		1 + FOAM_ENERGY_TURN_OUTER * turnK,
		0.5 + 0.5 * towardOuter,
	);

}

/**
 * Eat persist on the sailing line from the quarters aft so the bow slab
 * does not fill the wedge. 1 = fully channel. Path-only stamps stay 0.
 */
export function foamEnergyWakeCarve(
	lat, along, hullLen = 0, beam = 1.2, samples = null,
) {

	const L = Math.max( hullLen ?? 0, 0 );
	if ( L < 0.8 ) return 0;
	const aft = - along - L * 0.96;
	// The window must be FINITE astern. foamEnergyWakeOpen() saturates to 1
	// for every point behind the bow, so max()-ing it in here made the
	// channel an infinite ray in the LIVE heading. Applied field-wide as
	// decay, a turn swung that ray across the older curved trail like a
	// clock hand and erased the whole inboard side of it — the same failure
	// foamEnergyHullOwn() documents for the peel. Carve only what the hull
	// is churning now: the quarters, plus CARVE_AFT metres of wash.
	const s = clamp01( - along / L );
	const k = smoothstep( 0.70, 0.90, s )
		* ( 1 - smoothstep( FOAM_ENERGY_WAKE_CARVE_AFT * 0.5, FOAM_ENERGY_WAKE_CARVE_AFT, aft ) );
	if ( ! ( k > 0.001 ) ) return 0;
	const half = foamEnergyPlanformHalf( along, L, beam, samples );
	const rail = smoothstep( 0.20, 0.50, Math.abs( lat / Math.max( half, 0.08 ) ) );
	// Carve is the sailing-line channel only. It must NOT also lean with
	// the turn: stacking it on foamEnergyTurnBias erased the inner rail.
	return clamp01( k * ( 1 - rail ) );

}

/**
 * Equivalent persist after sailing-line carve. The field applies this as
 * extra `exp(-dt · rate · carve)` so it can go below DECAY_MIN.
 */
export function foamEnergyCarvePersist(
	persist, carve, rate = FOAM_ENERGY_WAKE_CARVE,
) {

	const p = Math.max( persist ?? FOAM_ENERGY_DECAY, FOAM_ENERGY_DECAY_MIN );
	const k = Math.max( rate, 0 ) * clamp01( carve );
	return p / ( 1 + p * k );

}

/**
 * Station 0 = bow, 1 = stern. Fine entry, full beam amidships, slight
 * transom tuck — a displacement waterline, not a box.
 */
export function foamEnergyPlanformK( s ) {

	const t = clamp01( s );
	const entry = mix( 0.11, 1, smoothstep( 0.02, 0.34, t ) );
	const run = mix( 1, 0.84, smoothstep( 0.76, 1, t ) );
	return entry * run;

}

/**
 * Local half-beam of the film, metres. `samples` is bow→stern half-widths
 * from the mesh waterline. Without a LOA this is the old rectangle.
 */
export function foamEnergyPlanformHalf( along, hullLen, beam, samples ) {

	const B = Math.max( beam ?? 1.2, 0.35 );
	const L = Math.max( hullLen ?? 0, 0 );
	if ( L < 0.8 ) return Math.max( B * FOAM_ENERGY_RIBBON_W, 0.10 );
	const s = clamp01( - along / L );
	if ( samples && samples.length >= 2 ) {

		const n = samples.length;
		const x = s * ( n - 1 );
		const i0 = Math.min( n - 2, Math.max( 0, Math.floor( x ) ) );
		const f = x - i0;
		return Math.max( samples[ i0 ] * ( 1 - f ) + samples[ i0 + 1 ] * f, 0.08 );

	}
	return Math.max( B * FOAM_ENERGY_RIBBON_W * foamEnergyPlanformK( s ), 0.08 );

}

/** Bow→stern half-beam samples. Mesh waterline when the body has stations. */
export function foamEnergyPlanformSamples( body, beam, hullLen ) {

	const n = FOAM_ENERGY_PLANFORM_N;
	const out = new Float32Array( n );
	const B = Math.max( beam ?? 1.2, 0.35 );
	const L = Math.max( hullLen ?? 0, 0 );
	const stations = body?.sprayStations;
	if ( stations?.half?.length && stations.maxZ > stations.minZ ) {

		const half = stations.half;
		const bowAtMin = ( half[ 0 ] ?? 1 ) <= ( half[ half.length - 1 ] ?? 1 );
		const pose = {
			origin: body.pos,
			originY: body.pos?.[ 1 ] ?? 0,
			pitch: body.pitch ?? 0,
			seaLevel: Number.isFinite( body.surf ) ? body.surf : 0,
			minHalf: 0.08,
		};
		for ( let i = 0; i < n; i ++ ) {

			const s = n === 1 ? 0 : i / ( n - 1 );
			const t = bowAtMin ? s : 1 - s;
			const z = stations.minZ + t * ( stations.maxZ - stations.minZ );
			out[ i ] = waterlineHalfAt( stations, z, pose );

		}
		return out;

	}
	if ( L < 0.8 ) {

		out.fill( Math.max( B * FOAM_ENERGY_RIBBON_W, 0.10 ) );
		return out;

	}
	for ( let i = 0; i < n; i ++ ) {

		const s = n === 1 ? 0 : i / ( n - 1 );
		out[ i ] = Math.max( B * FOAM_ENERGY_RIBBON_W * foamEnergyPlanformK( s ), 0.08 );

	}
	return out;

}

/** Write `dest` with the half-beam the GPU / CPU inject share. */
export function foamEnergyFillPlanform( dest, beam, hullLen, samples ) {

	const n = dest.length;
	const B = Math.max( beam ?? 1.2, 0.35 );
	const rect = Math.max( B * FOAM_ENERGY_RIBBON_W, 0.10 );
	if ( hullLen >= 0.8 && samples && samples.length >= 2 ) {

		for ( let i = 0; i < n; i ++ ) {

			const s = n === 1 ? 0 : i / ( n - 1 );
			dest[ i ] = foamEnergyPlanformHalf( - s * hullLen, hullLen, B, samples );

		}
		return dest;

	}
	if ( hullLen >= 0.8 ) {

		for ( let i = 0; i < n; i ++ ) {

			const s = n === 1 ? 0 : i / ( n - 1 );
			dest[ i ] = Math.max( rect * foamEnergyPlanformK( s ), 0.08 );

		}
		return dest;

	}
	dest.fill( rect );
	return dest;

}

/** One connected, flat-topped band across the *local* waterline beam. */
export function foamEnergyAcross( lat, beam, along = 0, hullLen = 0, samples = null ) {

	const w = foamEnergyPlanformHalf( along, hullLen, beam, samples );
	return foamEnergyLane( lat, w, foamEnergyWakeOpen( along, hullLen ) );

}

/**
 * Leftover phase speed the film may ride, or 0 when the hull is still
 * slower than leftover. Direction always comes from leftover faces
 * ({@link leftoverBubbleRide}), never the live heading — a turn must
 * not peel old film into a heading V.
 *
 * @param {number} [openSpeed]
 * @param {number} [waveSpeed]
 * @returns {number} m/s
 */
export function foamEnergyWaveRide( openSpeed, waveSpeed ) {

	const U = Math.abs( openSpeed ?? 0 );
	const c = Math.max( waveSpeed ?? 0, 0.35 );
	return U > c * 1.02 ? c : 0;

}

/**
 * Cheap surface transport from the gravity-wave field.
 *
 * For a travelling linear wave, `-dh/dt * grad(h)` points in its direction of
 * energy travel on both faces. Using it avoids the alternating in/out motion
 * that a raw slope warp creates and lets old foam migrate with the wake.
 *
 * That flux is O(A²ω/c) — centimetres per second on leftover. When
 * `rideSpeed` is leftover *c* (hull faster than leftover), the film
 * instead rides the face the way leftover specks do, so it can stay on
 * the Mach arms. Flat leftover still does not invent a direction.
 *
 * @param {object} field
 * @param {number} x
 * @param {number} z
 * @param {number} [carry]
 * @param {number} [maxSpeed]
 * @param {number} [rideSpeed] leftover phase speed, or 0
 */
export function foamEnergyWaveFlow(
	field, x, z,
	carry = FOAM_ENERGY_WAVE_CARRY,
	maxSpeed = FOAM_ENERGY_WAVE_MAX,
	rideSpeed = 0,
) {

	if ( ! field || ! ( carry > 0 ) || ! ( maxSpeed > 0 )
		|| typeof field.sampleSlopeAt !== 'function'
		|| typeof field.sampleVelAt !== 'function' ) return { x: 0, z: 0 };
	const slope = field.sampleSlopeAt( x, z );
	const vel = field.sampleVelAt( x, z );
	const slx = slope?.x ?? 0;
	const slz = slope?.z ?? 0;
	let fx = - vel * slx * carry;
	let fz = - vel * slz * carry;
	if ( rideSpeed > 0 ) {

		const ride = leftoverBubbleRide( slx, slz, vel, rideSpeed );
		const k = foamEnergyCarryBoost( carry );
		const rx = ride.vx * k;
		const rz = ride.vz * k;
		if ( rx * rx + rz * rz > fx * fx + fz * fz ) {

			fx = rx;
			fz = rz;

		}

	}
	const speed = Math.hypot( fx, fz );
	// The cap has to rise with carry or it undoes the boost above.
	const cap = Math.max( maxSpeed, rideSpeed )
		* Math.max( foamEnergyCarryBoost( carry ), 1 );
	if ( speed > cap ) {

		const s = cap / speed;
		fx *= s;
		fz *= s;

	}
	return { x: fx, z: fz };

}

/** 0..1 local wave activity used to gate foam spreading. */
export function foamEnergyWaveActivity( field, x, z ) {

	if ( ! field || typeof field.sampleSlopeAt !== 'function'
		|| typeof field.sampleVelAt !== 'function' ) return 0;
	const slope = field.sampleSlopeAt( x, z );
	const vel = Math.abs( field.sampleVelAt( x, z ) );
	return Math.min( 1, vel * 0.25 + Math.hypot( slope?.x ?? 0, slope?.z ?? 0 ) * 0.65 );

}

/**
 * Crest concentration for divergent-arm foam. Peaks keep the white;
 * troughs nearly clear. Dense motor trail bypasses this at render time
 * via {@link foamEnergyCrestGate}.
 */
export function foamEnergyWaveGather( field, x, z ) {

	if ( ! field || typeof field.sampleAt !== 'function' ) return 1;
	const crest = smoothstep( - 0.08, 0.18, field.sampleAt( x, z ) );
	return clamp(
		0.06 + crest * 0.92 + foamEnergyWaveActivity( field, x, z ) * 0.18,
		0.04, 1.18,
	);

}

/**
 * Multiply leftover film by leftover water. Crests keep the white;
 * troughs show the sea through a thin connected film. A still leftover
 * field leaves the ribbon alone — that is a painted stripe only when
 * leftover is actually rippling and the gate stays near 1.
 *
 * The water look applies this only when leftover-crest *look* is on
 * (`wakeFoamCrestLook` / `uRippleFoam`). Wave carry can still advect
 * the film when look is 0, so leftover rings do not punch doughnuts.
 *
 * `activity` is leftover |v| / slope (0..1). Ripples on a mid-height
 * plateau still wrinkle the film. A ~0.24 floor keeps the two bow-wave
 * rails from detaching; the old 0.80 dense floor was the solid stripe.
 *
 * @param {number} energy
 * @param {number} height leftover ripple height
 * @param {number} [activity=0]
 * @returns {number} 0..1 multiplier
 */
export function foamEnergyCrestGate( energy, height, activity = 0, gate = 1 ) {

	const e = Math.max( energy ?? 0, 0 );
	const h = height ?? 0;
	const ripples = clamp( activity ?? 0, 0, 1 );
	const live = smoothstep( 0.012, 0.10, Math.max( Math.abs( h ), ripples * 0.22 ) );
	const crest = smoothstep( - 0.08, 0.20, h );
	const peak = crest * crest;
	const wave = clamp( peak + ripples * ( 1 - peak ) * 0.55, 0, 1 );
	const dense = smoothstep( 0.22, 0.85, e );
	const troughFloor = 0.10 + dense * 0.16;
	const thinFade = Math.max( smoothstep( 0.025, 0.18, e ), dense * 0.80 );
	const gated = ( troughFloor + wave * ( 1 - troughFloor ) ) * thinFade;
	// `gate` is uRippleCrestGate: fade the trough wipe in rather than
	// snapping to full the instant it is switched on.
	const k = live * clamp( gate ?? 1, 0, 1 );
	return ( 1 - k ) + gated * k;

}

/**
 * Lateral open rate for foam. Below wave speed use the Kelvin half-angle;
 * above it use the leftover Mach cone so foam tracks the divergent arms
 * instead of peeling past them into still water.
 *
 *   Kelvin:  tan θ_K = 1/√8
 *   Mach:    tan α = c / √(U² − c²)   (sin α = c/U)
 */
export function foamEnergyOpenTan( openSpeed, waveSpeed ) {

	const U = Math.abs( openSpeed ?? 0 );
	const c = Math.max( waveSpeed ?? 0, 0.35 );
	if ( U > c * 1.02 ) {

		return c / Math.sqrt( Math.max( U * U - c * c, 1e-4 ) );

	}
	return KELVIN_TAN;

}

/** Cheap 0..1 hash in world XZ — twin of gpu/tsl hash12 for arm jitter. */
export function foamEnergyArmNoise( x, z ) {

	const n = Math.sin( x * 127.1 + z * 311.7 ) * 43758.5453;
	const a = n - Math.floor( n );
	const m = Math.sin( x * 74.3 - z * 189.2 ) * 24634.8571;
	const b = m - Math.floor( m );
	return a * 0.62 + b * 0.38;

}

/**
 * Multiplier on the divergent-arm radius. ~1 ± FOAM_ENERGY_ARM_JITTER.
 * Longer lobes along aft so the tear follows the ribbon, not a salt grain.
 */
export function foamEnergyArmWarp( x, z, aft = 0 ) {

	const s = 1 / Math.max( FOAM_ENERGY_ARM_NOISE_M, 1 );
	const along = Math.max( aft, 0 ) * s;
	const n = foamEnergyArmNoise( x * s + along * 0.35, z * s - along * 0.55 );
	const n2 = foamEnergyArmNoise( x * s * 2.1 - 3.1, z * s * 2.1 + 1.7 );
	const wobble = ( n * 2 - 1 ) * 0.72 + ( n2 * 2 - 1 ) * 0.28;
	return 1 + FOAM_ENERGY_ARM_JITTER * wobble;

}

/**
 * Which way the peel pushes, ramped across the centreline instead of
 * flipped. Beyond half a beam this is the old ±1.
 */
export function foamEnergyPeelSide( lat, beam ) {

	const half = Math.max( Math.max( beam, 0.35 ) * FOAM_ENERGY_PEEL_CROSS, 0.35 );
	return clamp( lat / half, - 1, 1 );

}

/** Metres astern the live heading still owns for the divergent peel. */
export function foamEnergyPeelReach( openSpeed ) {

	return clamp( Math.max( openSpeed, 0 ) * FOAM_ENERGY_PEEL_MEMORY, 6, 40 );

}

/**
 * How much of the water at hull-local (`lat`, `aft`) the LIVE hull frame may
 * still steer, 0..1. Ramps in behind the beam, and releases on the RADIAL
 * distance so what the wheel owns is a disc trailing the hull.
 *
 * Anything keyed to the hull's axes needs this. A bare `aft > 0.2` test is a
 * straight line through the hull, square to the heading and as long as the
 * tile; a turn sweeps it across the whole old trail, and every cell it
 * crosses changes behaviour on the frame it is crossed. That is a hard edge
 * rotating with the wheel — with, if the gated term deposits anything, a
 * bank of foam appearing along it in water the hull never churned.
 *
 * Releasing on `aft` alone is not enough, and this is the part that was
 * missed the first time: it bounds how far back the wedge reaches but not
 * how far out, so water a hundred metres abeam and two metres astern still
 * answered to the wheel. The swept line gets narrower, not shorter.
 */
export function foamEnergyHullOwn( lat, aft, reach ) {

	const r = Math.max( reach, 1e-3 );
	const dist = Math.hypot( lat, aft );
	return smoothstep( 0, 1.2, aft ) * ( 1 - smoothstep( r * 0.55, r, dist ) );

}

/**
 * Lateral peel onto the divergent arms. Foam aft of the bow drifts
 * toward the Kelvin / Mach locus rather than hanging on the heading line.
 *
 * @param {number} x
 * @param {number} z
 * @param {{ b?:number[], fwd?:number[], right?:number[], beam?:number,
 *   openSpeed?:number, waveSpeed?:number, waveCarry?:number, waveMax?:number,
 *   diverge?:number }} [opts]
 */
export function foamEnergyDivergeFlow( x, z, opts = {} ) {

	const carry = opts.waveCarry ?? FOAM_ENERGY_WAVE_CARRY;
	const diverge = opts.diverge ?? FOAM_ENERGY_DIVERGE;
	const open = opts.openSpeed ?? 0;
	const maxSpeed = opts.waveMax ?? FOAM_ENERGY_WAVE_MAX;
	if ( ! ( carry > 0 ) || ! ( diverge > 0 ) || ! ( open > 0.25 ) ) return { x: 0, z: 0 };
	const fwd = opts.fwd || [ 0, 1 ];
	const right = opts.right || [ - fwd[ 1 ], fwd[ 0 ] ];
	const b = opts.b || [ 0, 0 ];
	const along = ( x - b[ 0 ] ) * fwd[ 0 ] + ( z - b[ 1 ] ) * fwd[ 1 ];
	const lat = ( x - b[ 0 ] ) * right[ 0 ] + ( z - b[ 1 ] ) * right[ 1 ];
	const aft = Math.max( 0, - along );
	const beam = Math.max( opts.beam ?? 1.2, 0.35 );
	const openTan = foamEnergyOpenTan( open, opts.waveSpeed );
	const side = foamEnergyPeelSide( lat, beam );
	// No arm locus here. Gating the peel on |lat| ≈ beam·0.42 + aft·tanθ
	// put a ridge in the advection velocity right along that ray, and
	// advection sharpens a velocity ridge into a drawn line. The ray is
	// straight in the LIVE frame, so a turn swept a hard painted V across
	// the older curved trail. The half-angle sets how fast water leaves
	// the hull; where the arms end up is the wave field's business.
	const reach = foamEnergyPeelReach( open );
	// The scalar field remembers coverage, not the heading it was born under.
	// Therefore the live heading may only steer a small RADIAL neighbourhood
	// around the hull. An aft-only leash is still an infinite strip abeam;
	// turning that strip sweeps a straight advection boundary through old foam.
	const own = foamEnergyHullOwn( lat, aft, reach );
	if ( own <= 0 ) return { x: 0, z: 0 };
	let vLat = side * openTan * open * diverge * foamEnergyCarryBoost( carry )
		* own;
	const cap = Math.max( maxSpeed * 1.35, openTan * open * Math.max( diverge, 1 ) )
		* Math.max( foamEnergyCarryBoost( carry ), 1 );
	vLat = clamp( vLat, - cap, cap );
	return { x: right[ 0 ] * vLat, z: right[ 1 ] * vLat };

}

/**
 * Hull whitewater at the bow entry and forward chines. `along` is metres
 * ahead of the bow stamp; negative reaches a few metres aft along the
 * waterline so the sides churn, not only the tip.
 */
export function foamEnergyHullInject(
	lat, along, stir, beam, gain = 1, hullLen = 0, samples = null,
	yawRate = 0,
) {

	if ( ! ( stir > 0.001 ) ) return 0;
	// The stamp is the cutwater. Water already traversed may churn; water in
	// front of the bow may not. The old 1.1 m forward reach visibly projected
	// both shoulder peaks in front of the mesh at speed.
	const behindBow = 1 - smoothstep( 0.05, 0.35, along );
	return Math.max( 0, stir ) * Math.max( gain, 0 )
		* behindBow * foamEnergyAcross( lat, beam, along, hullLen, samples )
		* foamEnergyAlong( along, hullLen )
		* foamEnergyTurnBias( lat, yawRate, beam )
		* FOAM_ENERGY_HULL;

}

/**
 * Narrow stern jet — motor / prop wash. `lat` / `along` are metres from
 * the live transom in hull axes (positive along = ahead of the stern).
 * Callers must pass stern-local coords so a turn keeps the jet on the
 * back of the mesh.
 */
export function foamEnergyMotorInject(
	lat, along, stir, beam, motor = 0,
	width = FOAM_ENERGY_MOTOR_W, reach = FOAM_ENERGY_MOTOR_REACH,
) {

	if ( ! ( motor > 0.001 ) || ! ( stir > 0.001 ) ) return 0;
	// This is a moving transom brush, not a ray. The former one-sided `ahead`
	// gate stayed at 1 for every point astern, so every frame painted a narrow
	// half-strip all the way to the field edge. Turning swept that strip into a
	// solid white sector in water the boat never crossed.
	const behind = 1 - smoothstep( 0.05, 0.45, along );
	const aft = Math.max( - along, 0 );
	const reach1 = Math.max( reach ?? FOAM_ENERGY_MOTOR_REACH, 0.4 );
	const reach0 = reach1 * ( FOAM_ENERGY_MOTOR_REACH0 / FOAM_ENERGY_MOTOR_REACH );
	const tail = 1 - smoothstep( reach0, reach1, aft );
	const B = Math.max( beam ?? 1.2, 0.35 );
	const wFrac = clamp( width ?? FOAM_ENERGY_MOTOR_W, 0.04, 0.55 );
	const w = Math.max( B * wFrac, 0.08 );
	const q2 = ( lat / w ) * ( lat / w );
	return Math.max( 0, stir ) * motor * behind * tail
		* Math.exp( - q2 * q2 ) * FOAM_ENERGY_HULL * FOAM_ENERGY_MOTOR;

}

export function foamEnergyCrestInject( slopeMag, breakT = FOAM_ENERGY_BREAK ) {

	return smoothstep( breakT, breakT + 0.28, Math.max( slopeMag, 0 ) );

}

export function foamEnergyStep( prev, dt, inject, decay = FOAM_ENERGY_DECAY ) {

	return clamp( foamEnergyDecay( prev, dt, decay ) + Math.max( inject, 0 ), 0, FOAM_ENERGY_MAX );

}

/** Extra wind-foam coverage. Twin of foamF/foamR inject in the water shaders. */
export function foamEnergyMask( energy, lace ) {

	return wakeFoamMask( energy, lace );

}

function bilinear( data, size, u, v ) {

	const x = clamp( u * size - 0.5, 0, size - 1.0001 );
	const y = clamp( v * size - 0.5, 0, size - 1.0001 );
	const x0 = Math.floor( x ), y0 = Math.floor( y );
	const tx = x - x0, ty = y - y0;
	const x1 = Math.min( x0 + 1, size - 1 );
	const y1 = Math.min( y0 + 1, size - 1 );
	const a = data[ y0 * size + x0 ];
	const b = data[ y0 * size + x1 ];
	const c = data[ y1 * size + x0 ];
	const d = data[ y1 * size + x1 ];
	return a * ( 1 - tx ) * ( 1 - ty ) + b * tx * ( 1 - ty )
		+ c * ( 1 - tx ) * ty + d * tx * ty;

}

/**
 * CPU grid twin of the GPU energy pass. Used by the headless check — the
 * live field is the ping-pong texture in FoamEnergy / TslFoamEnergy.
 */
export class FoamEnergyField {

	constructor( { size = 48, extent = 24 } = {} ) {

		this.size = size;
		this.extent = extent;
		this.origin = [ 0, 0 ];
		this.data = new Float32Array( size * size );

	}

	clear() {

		this.data.fill( 0 );

	}

	worldOf( i, j ) {

		return [
			this.origin[ 0 ] + ( ( i + 0.5 ) / this.size - 0.5 ) * this.extent,
			this.origin[ 1 ] + ( ( j + 0.5 ) / this.size - 0.5 ) * this.extent,
		];

	}

	sample( x, z ) {

		const uvx = ( x - this.origin[ 0 ] ) / this.extent + 0.5;
		const uvz = ( z - this.origin[ 1 ] ) / this.extent + 0.5;
		const radial = Math.hypot( uvx - 0.5, uvz - 0.5 ) * 2;
		if ( radial >= 1 ) return 0;
		return bilinear( this.data, this.size, uvx, uvz );

	}

	/**
	 * @param {number} dt
	 * @param {{ a:number[], b:number[], fwd:number[], stir:number,
	 *   beam?:number, gain?:number, decay?:number, rings?:object,
	 *   crest?:number, teleport?:boolean, ripples?:object,
	 *   waveCarry?:number, waveMax?:number, waveSpread?:number,
	 *   openSpeed?:number, diverge?:number, motor?:number }} [opts]
	 */
	step( dt, opts = {} ) {

		const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
		const a = opts.a || this.origin;
		const b = opts.b || a;
		const fwd = opts.fwd || [ 0, 1 ];
		const right = [ - fwd[ 1 ], fwd[ 0 ] ];
		const jump = Math.hypot( ( b[ 0 ] - a[ 0 ] ), ( b[ 1 ] - a[ 1 ] ) );
		const hullOk = ! opts.teleport
			&& jump < FOAM_ENERGY_TELEPORT
			&& ( opts.stir ?? 0 ) > 0.001;
		const beam = opts.beam ?? 1.2;
		const gain = opts.gain ?? 1;
		const rings = opts.rings;
		const openSpeed = opts.openSpeed ?? ( d > 1e-6 ? jump / d : 0 );
		const waveSpeed = opts.waveSpeed ?? opts.ripples?.speed;
		const ride = foamEnergyWaveRide( openSpeed, waveSpeed );
		const next = new Float32Array( this.data.length );

		for ( let j = 0; j < this.size; j ++ ) {

			for ( let i = 0; i < this.size; i ++ ) {

				const [ x, z ] = this.worldOf( i, j );
				const flow = foamEnergyWaveFlow(
					opts.ripples, x, z, opts.waveCarry, opts.waveMax, ride,
				);
				const diverge = foamEnergyDivergeFlow( x, z, {
					b, fwd, right, beam, openSpeed,
					waveSpeed: opts.waveSpeed ?? opts.ripples?.speed,
					waveCarry: opts.waveCarry, waveMax: opts.waveMax,
					diverge: opts.diverge,
				} );
				const px = x - ( flow.x + diverge.x ) * d;
				const pz = z - ( flow.z + diverge.z ) * d;
				let prev = this.sample( px, pz );
				const activity = foamEnergyWaveActivity( opts.ripples, x, z );
				const spread = opts.waveSpread ?? FOAM_ENERGY_WAVE_SPREAD;
				// Local breakup rides leftover faces even when extra flux
				// carry is off. Carry only advects the sample lookup above.
				if ( activity > 0 && spread > 0 ) {

					const texel = this.extent / this.size;
					const slope = opts.ripples?.sampleSlopeAt?.( x, z ) || { x: 0, z: 0 };
					const slopeLength = Math.hypot( slope.x, slope.z );
					const nx = slopeLength > 1e-6 ? slope.x / slopeLength : right[ 0 ];
					const nz = slopeLength > 1e-6 ? slope.z / slopeLength : right[ 1 ];
					const tx = - nz, tz = nx;
					// Exchange with adjacent water only. The old radius grew
					// to fourteen texels (8.75 m on the live 320 m tile) and
					// `max(shed)` copied the sample into clear cells, so foam
					// leapfrogged across a storm every frame.
					const reach = texel * ( 1 + activity * 1.5 );
					const nearby = (
						this.sample( px - nx * reach, pz - nz * reach )
						+ this.sample( px + nx * reach, pz + nz * reach )
						+ this.sample( px - tx * reach, pz - tz * reach )
						+ this.sample( px + tx * reach, pz + tz * reach )
					) * 0.25;
					const k = Math.min( 0.08, d * activity * spread * 0.8 );
					prev += ( nearby - prev ) * k;

				}
				let inject = 0;
				let lat = 0;
				let along = 0;
				if ( hullOk ) {

					const seg = [ b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ];
					const ll = Math.max( seg[ 0 ] * seg[ 0 ] + seg[ 1 ] * seg[ 1 ], 1e-5 );
					const t = (
						( x - a[ 0 ] ) * seg[ 0 ] + ( z - a[ 1 ] ) * seg[ 1 ]
					) / ll;
					lat = ( x - b[ 0 ] ) * right[ 0 ] + ( z - b[ 1 ] ) * right[ 1 ];
					along = ( x - b[ 0 ] ) * fwd[ 0 ] + ( z - b[ 1 ] ) * fwd[ 1 ];
					inject += foamEnergyHullInject(
						lat, along, opts.stir, beam, gain,
						opts.hullLen, opts.planform, opts.yawRate,
					)
						* foamEnergyPath( jump )
						* Math.max(
							foamEnergySweep( t, jump ),
							foamEnergyLiveHull( along, opts.hullLen ),
						);
					const stern = opts.stern || [
						b[ 0 ] - fwd[ 0 ] * Math.max( opts.hullLen ?? 0, 0 ) * 0.96,
						b[ 1 ] - fwd[ 1 ] * Math.max( opts.hullLen ?? 0, 0 ) * 0.96,
					];
					const mLat = ( x - stern[ 0 ] ) * right[ 0 ] + ( z - stern[ 1 ] ) * right[ 1 ];
					const mAlong = ( x - stern[ 0 ] ) * fwd[ 0 ] + ( z - stern[ 1 ] ) * fwd[ 1 ];
					// Point splat at the live transom — not gated by the bow sweep.
					inject += foamEnergyMotorInject(
						mLat, mAlong, opts.stir, beam, opts.motor ?? 0,
						opts.jetWidth, opts.jetReach,
					) * foamEnergyPath( jump );

				}
				const crestGain = opts.crest ?? FOAM_ENERGY_CREST;
				if ( rings && crestGain > 0 ) {

					inject += foamEnergyCrestInject(
						wakeWaveSlopeFieldAt( x, z, rings ).slope,
					) * crestGain * d;

				}
				const carve = hullOk
					? foamEnergyWakeCarve( lat, along, opts.hullLen, beam, opts.planform )
					: 0;
				// Carve is extra decay, not a persist below DECAY_MIN — that
				// floor left the bow slab opaque on the sailing line.
				const aged = foamEnergyDecay( prev, d, opts.decay ?? FOAM_ENERGY_DECAY )
					* Math.exp( - d * FOAM_ENERGY_WAKE_CARVE * carve );
				next[ j * this.size + i ] = clamp(
					aged + Math.max( inject, 0 ), 0, FOAM_ENERGY_MAX,
				);

			}

		}

		this.data = next;

	}

}

export const FOAM_ENERGY_SAMPLE_GLSL = /* glsl */`
uniform sampler2D uFoamEnergy;
uniform float uFoamEnergyOn;

// Twin of foamEnergyAt() in gpu/tsl/water-common.js. Same window as the
// stamp field. Coverage is leftover energy; lace never writes this.
float foamEnergyAt(vec2 p){
  if (uFoamEnergyOn < 0.5) return 0.0;
  vec2 uv = (p - uWakeOrigin) / uWakeExtent + 0.5;
  float radial = length(uv - 0.5) * 2.0;
  if (radial >= 1.0) return 0.0;
  float edgeLo = 1.0 - max(uWakeEdge, 0.18) * 1.8;
  float edge = 1.0 - smoothstep(edgeLo, 1.0, radial);
  return texture(uFoamEnergy, uv).r * edge;
}
`;

const FOAM_ENERGY_FS = /* glsl */`
uniform sampler2D uPrev;
uniform vec2  uOrigin, uPrevOrigin;
uniform float uExtent, uPrevExtent;
uniform float uAgeDt, uInjectDt, uDecay;
uniform vec2  uA, uB, uFwd, uRight;
uniform float uStir, uBeam, uGain, uActive, uSize;
in  vec2 vUv;
out vec4 fragColor;

void main(){
  vec2 w = uOrigin + (vUv - 0.5) * uExtent;
  float e = 0.0;
  vec2 pv = (w - uPrevOrigin) / uPrevExtent + 0.5;
  pv = (floor(pv * uSize) + 0.5) / uSize;
  if (pv.x > 0.0 && pv.x < 1.0 && pv.y > 0.0 && pv.y < 1.0)
    e = texture(uPrev, pv).r;
  e *= exp(-uAgeDt / max(uDecay, ${ FOAM_ENERGY_DECAY_MIN.toFixed( 3 ) }));

  if (uActive > 0.5 && uStir > 0.001 && uInjectDt > 0.0) {
    vec2 seg = uB - uA;
    float jump = length(seg);
    if (jump < ${ FOAM_ENERGY_TELEPORT.toFixed( 2 ) }) {
      float ll = max(dot(seg, seg), 1e-5);
      float t = dot(w - uA, seg) / ll;
      float lat = dot(w - uB, uRight);
      float along = dot(w - uB, uFwd);
      float behindBow = 1.0 - smoothstep(0.05, 0.35, along);
      float rw = max(uBeam * ${ FOAM_ENERGY_RIBBON_W.toFixed( 3 ) }, 0.10);
      float q2 = (lat / rw) * (lat / rw);
      float across = exp(-q2*q2*q2*q2);
      float metres = t < 0.0 ? -t * jump : t > 1.0 ? (t - 1.0) * jump : 0.0;
      float sweep = metres <= 0.0 ? 1.0
        : exp(-(metres / ${ FOAM_ENERGY_CAP.toFixed( 3 ) }) * (metres / ${ FOAM_ENERGY_CAP.toFixed( 3 ) }));
      float brush = jump <= 0.12 ? 1.0 : min(1.0, ${ FOAM_ENERGY_BRUSH.toFixed( 3 ) } / jump);
      float path = max(jump, 0.05) * brush;
      e += uStir * max(uGain, 0.0) * behindBow * across * sweep
         * ${ FOAM_ENERGY_HULL.toFixed( 3 ) } * path;
    }
  }

  fragColor = vec4(clamp(e, 0.0, ${ FOAM_ENERGY_MAX.toFixed( 3 ) }), 0.0, 0.0, 1.0);
}
`;

/**
 * Classic WebGL2 energy field. Same window as Wake — copy origin from the
 * stamp field after it updates so the water samples one aligned pair.
 */
export class FoamEnergy {

	constructor( gl, blit, { size = 512 } = {} ) {

		this.gl = gl;
		this.blit = blit;
		this.size = size;
		this.prog = program( gl, FS_VERT, FOAM_ENERGY_FS, 'foam-energy' );
		this.tex = [ 0, 1 ].map( () => texture2D( gl, {
			width: size, height: size,
			internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
			filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
		} ) );
		this.fbo = this.tex.map( ( t ) => framebuffer( gl, [ t ] ) );
		this.src = 0;
		this.origin = new Float32Array( [ 0, 0 ] );
		this.prevOrigin = new Float32Array( [ 0, 0 ] );
		this.extent = 320;
		this.prevExtent = 320;
		this.clear();

	}

	get field() { return this.tex[ this.src ]; }

	clear() {

		const gl = this.gl;
		for ( const f of this.fbo ) {

			gl.bindFramebuffer( gl.FRAMEBUFFER, f );
			gl.viewport( 0, 0, this.size, this.size );
			gl.clearColor( 0, 0, 0, 0 );
			gl.clear( gl.COLOR_BUFFER_BIT );

		}
		gl.bindFramebuffer( gl.FRAMEBUFFER, null );

	}

	/**
	 * @param {number} dt
	 * @param {object} p
	 * @param {object|object[]} wr
	 * @param {{ camera?:number[], follow?:object, rings?:object }} [opts]
	 */
	update( dt, p, wr, opts = {} ) {

		if ( dt <= 0 ) return;
		const follow = opts.follow;
		this.prevOrigin[ 0 ] = this.origin[ 0 ];
		this.prevOrigin[ 1 ] = this.origin[ 1 ];
		this.prevExtent = this.extent;
		if ( follow ) {

			this.origin[ 0 ] = follow.origin[ 0 ];
			this.origin[ 1 ] = follow.origin[ 1 ];
			this.extent = follow.extent;
			const plan = follow.lastPlan || { stamps: [], stepDt: Math.min( dt, 1 / 15 ) };
			const sources = Array.isArray( wr ) ? wr : ( wr ? [ wr ] : [] );
			this._run(
				sources.length ? plan : { stamps: [], stepDt: plan.stepDt },
				wakeFoamDecayOf( sources.length ? plan : null, p ),
			);
			return;

		}

		this.extent = Math.max( p.wakeExtent ?? 320, 40 );
		const sources = Array.isArray( wr ) ? wr : ( wr ? [ wr ] : [] );
		const planned = planWakeFrame( dt, p, sources, {
			origin: [ this.origin[ 0 ], this.origin[ 1 ] ],
			hadWet: sources.length > 0,
			extent: this.extent,
			size: this.size,
		}, { camera: opts.camera } );
		this.origin[ 0 ] = planned.origin[ 0 ];
		this.origin[ 1 ] = planned.origin[ 1 ];
		this._run( planned, wakeFoamDecayOf( planned, p ) );

	}

	_run( plan, decay ) {

		this._decay = decay ?? FOAM_ENERGY_DECAY;
		const stamps = plan.stamps || [];
		const stepDt = plan.stepDt ?? 1 / 60;
		if ( ! stamps.length ) {

			this._flush( {
				a: [ this.origin[ 0 ], this.origin[ 1 ] ],
				b: [ this.origin[ 0 ], this.origin[ 1 ] ],
				fwd: [ 0, 1 ], stir: 0, beam: 1.2, gain: 0,
				ageDt: stepDt, injectDt: 0, active: false,
			} );
			return;

		}

		for ( let i = 0; i < stamps.length; i ++ ) {

			if ( i > 0 ) {

				this.prevOrigin[ 0 ] = this.origin[ 0 ];
				this.prevOrigin[ 1 ] = this.origin[ 1 ];
				this.prevExtent = this.extent;

			}
			this._flush( {
				...stamps[ i ],
				ageDt: i === 0 ? stepDt : 0,
				injectDt: stepDt,
			} );

		}

	}

	_flush( { a, b, fwd, stir, beam, gain, ageDt, injectDt, active } ) {

		const gl = this.gl;
		const dst = 1 - this.src;
		gl.bindFramebuffer( gl.FRAMEBUFFER, this.fbo[ dst ] );
		gl.viewport( 0, 0, this.size, this.size );
		gl.disable( gl.DEPTH_TEST );
		gl.disable( gl.BLEND );
		gl.useProgram( this.prog );
		setUniforms( gl, this.prog, {
			uPrev: this.tex[ this.src ],
			uOrigin: this.origin, uPrevOrigin: this.prevOrigin,
			uExtent: this.extent, uPrevExtent: this.prevExtent,
			uAgeDt: ageDt ?? 0, uInjectDt: injectDt ?? 0,
			uDecay: this._decay ?? FOAM_ENERGY_DECAY,
			uA: new Float32Array( a ), uB: new Float32Array( b ),
			uFwd: new Float32Array( fwd ),
			uRight: new Float32Array( [ - fwd[ 1 ], fwd[ 0 ] ] ),
			uStir: stir ?? 0,
			uBeam: beam ?? 1.2,
			uGain: gain ?? 1,
			uActive: active ? 1 : 0,
			uSize: this.size,
		} );
		this.blit.draw();
		gl.bindFramebuffer( gl.FRAMEBUFFER, null );
		this.src = dst;

	}

}
