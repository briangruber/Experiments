// Persistent foam-energy UPDATE pass, in TSL.
//
// Twin of FOAM_ENERGY_FS in src/foam-energy.js. Sampling lives in
// ./water-common.js as foamEnergyAt() so the water vertex/fragment share it
// with the stamp field's window. This file only maintains the leftover film:
// reproject, decay, hull inject. Ring-shoulder leftover is off.
//
// Named uFe* (rule 7) — water-common already owns uFoamEnergy*.

import {
	Fn, If, float, int, vec2, vec4, uniform, uniformArray, texture, clamp, uv,
	smoothstep, exp, select, mix,
} from 'three/tsl';
import { DataTexture, RGBAFormat, FloatType } from 'three';
import {
	FOAM_ENERGY_DECAY, FOAM_ENERGY_DECAY_MIN, FOAM_ENERGY_HULL,
	FOAM_ENERGY_TELEPORT, FOAM_ENERGY_MAX,
	FOAM_ENERGY_BRUSH, FOAM_ENERGY_CAP,
	FOAM_ENERGY_RIBBON_W, FOAM_ENERGY_PLANFORM_N,
	FOAM_ENERGY_CARRY_MAX, FOAM_ENERGY_WAVE_CARRY, FOAM_ENERGY_WAVE_MAX,
	FOAM_ENERGY_WAVE_SPREAD, FOAM_ENERGY_DIVERGE,
	FOAM_ENERGY_ALONG_FLOOR, FOAM_ENERGY_WAKE_CHANNEL, FOAM_ENERGY_WAKE_CARVE,
	FOAM_ENERGY_WAKE_CARVE_AFT, FOAM_ENERGY_TURN_INNER, FOAM_ENERGY_TURN_OUTER,
	FOAM_ENERGY_MOTOR_W, FOAM_ENERGY_MOTOR,
	FOAM_ENERGY_MOTOR_REACH, FOAM_ENERGY_MOTOR_REACH0,
	FOAM_ENERGY_PEEL_CROSS, FOAM_ENERGY_PEEL_MEMORY,
} from '../../foam-energy.js';
import { rippleAt, rippleVelAt } from './ripple-field.js';
import { KELVIN_TAN } from '../../kelvin-wake.js';

export const uFeOrigin = /*@__PURE__*/ uniform( 'vec2' );
export const uFePrevOrigin = /*@__PURE__*/ uniform( 'vec2' );
export const uFeExtent = /*@__PURE__*/ uniform( 320.0 );
export const uFePrevExtent = /*@__PURE__*/ uniform( 320.0 );
export const uFeAgeDt = /*@__PURE__*/ uniform( 0.0 );
export const uFeInjectDt = /*@__PURE__*/ uniform( 0.0 );
export const uFeDecay = /*@__PURE__*/ uniform( FOAM_ENERGY_DECAY );
export const uFeA = /*@__PURE__*/ uniform( 'vec2' );
export const uFeB = /*@__PURE__*/ uniform( 'vec2' );
export const uFeFwd = /*@__PURE__*/ uniform( 'vec2' );
export const uFeRight = /*@__PURE__*/ uniform( 'vec2' );
export const uFeStir = /*@__PURE__*/ uniform( 0.0 );
export const uFeBeam = /*@__PURE__*/ uniform( 1.2 );
export const uFeGain = /*@__PURE__*/ uniform( 1.0 );
export const uFeActive = /*@__PURE__*/ uniform( 0.0 );
export const uFeSize = /*@__PURE__*/ uniform( 512.0 );
export const uFeRippleCell = /*@__PURE__*/ uniform( 1.0 );
export const uFeWaveCarry = /*@__PURE__*/ uniform( FOAM_ENERGY_WAVE_CARRY );
export const uFeWaveMax = /*@__PURE__*/ uniform( FOAM_ENERGY_WAVE_MAX );
export const uFeWaveSpread = /*@__PURE__*/ uniform( FOAM_ENERGY_WAVE_SPREAD );
export const uFeOpenSpeed = /*@__PURE__*/ uniform( 0.0 );
export const uFeDiverge = /*@__PURE__*/ uniform( FOAM_ENERGY_DIVERGE );
export const uFeWaveSpeed = /*@__PURE__*/ uniform( 4.0 );
export const uFeMotor = /*@__PURE__*/ uniform( 0.0 );
export const uFeMotorW = /*@__PURE__*/ uniform( FOAM_ENERGY_MOTOR_W );
export const uFeMotorReach = /*@__PURE__*/ uniform( FOAM_ENERGY_MOTOR_REACH );
export const uFeHullLen = /*@__PURE__*/ uniform( 0.0 );
export const uFeYawRate = /*@__PURE__*/ uniform( 0.0 );
export const uFeStern = /*@__PURE__*/ uniform( 'vec2' );
// Twin of foamEnergyPlanformHalf() — bow→stern local half-beam, metres.
export const uFePlanform = /*@__PURE__*/ uniformArray(
	Array.from( { length: FOAM_ENERGY_PLANFORM_N }, () => 1.0 ),
	'float',
);

const prevPlaceholder = /*@__PURE__*/ ( () => {

	const t = new DataTexture( new Float32Array( [ 0, 0, 0, 0 ] ), 1, 1, RGBAFormat, FloatType );
	t.needsUpdate = true;
	return t;

} )();

export const foamEnergyPrevTexture = /*@__PURE__*/ texture( prevPlaceholder );

/** Twin of foamEnergyPeelSide() — ramps across the centreline, never flips. */
const foamEnergyPeelSideTsl = /*@__PURE__*/ Fn( ( [ lat, beam ] ) => {

	// Not `half`: that is a reserved word in GLSL and toVar() carries the
	// name straight into the generated shader.
	const crossW = beam.max( 0.35 ).mul( float( FOAM_ENERGY_PEEL_CROSS ) ).max( 0.35 ).toVar();
	return clamp( lat.div( crossW ), - 1.0, 1.0 );

} );

/** Twin of foamEnergyPeelReach() — metres astern the live heading owns. */
const foamEnergyPeelReachTsl = /*@__PURE__*/ Fn( ( [ open ] ) => {

	return clamp( open.max( 0.0 ).mul( float( FOAM_ENERGY_PEEL_MEMORY ) ), 6.0, 40.0 );

} );

/** Twin of foamEnergyHullOwn() — the disc of water the live wheel may steer. */
const foamEnergyHullOwnTsl = /*@__PURE__*/ Fn( ( [ lat, aft, reach ] ) => {

	const r = reach.max( 1e-3 ).toVar();
	const dist = vec2( lat, aft ).length().toVar();
	return smoothstep( 0.0, 1.2, aft )
		.mul( float( 1.0 ).sub( smoothstep( r.mul( 0.55 ), r, dist ) ) );

} );

export const foamEnergyUpdateFragment = /*@__PURE__*/ Fn( () => {

	const vUv = uv().toVar();
	const w = uFeOrigin.add( vUv.sub( 0.5 ).mul( uFeExtent ) ).toVar();
	const e = float( 0.0 ).toVar();
	const pv = w.sub( uFePrevOrigin ).div( uFePrevExtent ).add( 0.5 ).toVar();
	const waveActivity = float( 0.0 ).toVar();
	const waveAxis = vec2( 1.0, 0.0 ).toVar();
	const waveGather = float( 1.0 ).toVar();
	const alongHull = w.sub( uFeB ).dot( uFeFwd ).toVar();
	const latHull = w.sub( uFeB ).dot( uFeRight ).toVar();
	const aft = alongHull.negate().max( 0.0 ).toVar();
	pv.assign( pv.mul( uFeSize ).floor().add( 0.5 ).div( uFeSize ) );
	// Leftover-wave activity is independent of extra flux carry. Carry
	// only advects the sample; faces still exchange foam when carry is 0.
	If( uFeAgeDt.greaterThan( 0.0 ), () => {

		const de = uFeRippleCell.max( 0.05 ).toVar();
		const h = rippleAt( w ).toVar();
		const gx = rippleAt( w.add( vec2( de, 0.0 ) ) )
			.sub( rippleAt( w.sub( vec2( de, 0.0 ) ) ) ).div( de.mul( 2.0 ) ).toVar();
		const gz = rippleAt( w.add( vec2( 0.0, de ) ) )
			.sub( rippleAt( w.sub( vec2( 0.0, de ) ) ) ).div( de.mul( 2.0 ) ).toVar();
		const vel = rippleVelAt( w ).toVar();
		const waveSlope = vec2( gx, gz ).dot( vec2( gx, gz ) ).sqrt().toVar();
		waveActivity.assign( clamp(
			vel.abs().mul( 0.25 ).add( waveSlope.mul( 0.65 ) ),
			0.0, 1.0,
		) );
		// Peaks keep the white; troughs nearly clear. Motor trail bypasses
		// this at water composite via foamEnergyCrestGate.
		waveGather.assign( clamp(
			float( 0.06 ).add( h.smoothstep( - 0.08, 0.18 ).mul( 0.92 ) )
				.add( waveActivity.mul( 0.18 ) ),
			0.04, 1.18,
		) );
		waveAxis.assign( select(
			waveSlope.greaterThan( 1e-5 ),
			vec2( gx, gz ).div( waveSlope.max( 1e-5 ) ),
			uFeRight,
		) );
		If( uFeWaveCarry.greaterThan( 0.0 ), () => {

			const flow = vec2( gx, gz ).mul( vel.negate() ).mul( uFeWaveCarry ).toVar();
			// Twin of foamEnergyCarryBoost(). Every cap below scales with it
			// or the boost is clamped straight back out — see the CPU note.
			const carryBoost = uFeWaveCarry.div( FOAM_ENERGY_WAVE_CARRY )
				.clamp( 0.0, FOAM_ENERGY_CARRY_MAX ).toVar();
			// Twin of foamEnergyWaveRide() + leftoverBubbleRide(): flux is
			// centimetres per second on leftover faces. Once the hull
			// outruns leftover, ride those faces at leftover *c* so the
			// film can open with the Mach V. Direction is leftover, never
			// the live heading.
			const leftoverC = uFeWaveSpeed.max( 0.35 ).toVar();
			const rideSpeed = select(
				uFeOpenSpeed.greaterThan( leftoverC.mul( 1.02 ) ),
				leftoverC,
				float( 0.0 ),
			).toVar();
			If( rideSpeed.greaterThan( 0.0 ), () => {

				const g2 = vec2( gx, gz ).dot( vec2( gx, gz ) ).toVar();
				If( g2.greaterThan( 1e-8 ), () => {

					const rideDir = vec2( gx.negate().mul( vel ), gz.negate().mul( vel ) ).toVar();
					const rideLen = rideDir.dot( rideDir ).sqrt().toVar();
					If( rideLen.lessThan( 1e-6 ), () => {

						rideDir.assign( vec2( gx.negate(), gz.negate() ) );
						rideLen.assign( g2.sqrt() );

					} );
					const rideAmt = rideSpeed
						.mul( g2.sqrt().div( 0.045 ).min( 1.0 ) )
						.mul( carryBoost )
						.toVar();
					const rideFlow = rideDir.div( rideLen.max( 1e-5 ) ).mul( rideAmt ).toVar();
					If( rideFlow.dot( rideFlow ).greaterThan( flow.dot( flow ) ), () => {

						flow.assign( rideFlow );

					} );

				} );

			} );
			const flowSpeed = flow.dot( flow ).sqrt().toVar();
			const flowCap = uFeWaveMax.max( 0.0 ).max( rideSpeed )
				.mul( carryBoost.max( 1.0 ) ).toVar();
			flow.mulAssign( flowCap.div( flowSpeed.max( 1e-5 ) ).min( 1.0 ) );
			// Kelvin half-angle peel: open existing foam with the divergent arms.
			const divergeFlow = vec2( 0.0 ).toVar();
			If( uFeDiverge.greaterThan( 0.0 ).and( uFeOpenSpeed.greaterThan( 0.25 ) ), () => {

			const c = uFeWaveSpeed.max( 0.35 ).toVar();
			const openTan = select(
				uFeOpenSpeed.greaterThan( c.mul( 1.02 ) ),
				c.div( uFeOpenSpeed.mul( uFeOpenSpeed ).sub( c.mul( c ) ).max( 1e-4 ).sqrt() ),
				float( KELVIN_TAN ),
			).toVar();
			const side = foamEnergyPeelSideTsl( latHull, uFeBeam ).toVar();
			// No arm locus here — see the note in the CPU twin. Gating on
			// |lat| ≈ beam·0.42 + aft·tanθ put a ridge in the advection
			// velocity along a ray that is straight in the LIVE frame, and
			// a turn swept that painted V across the older curved trail.
			const reach = foamEnergyPeelReachTsl( uFeOpenSpeed ).toVar();
			// The live hull frame owns a radial neighbourhood, never an
			// aft-only strip that reaches across the whole tile. A turn swept
			// that strip's straight boundary through old foam.
			const own = foamEnergyHullOwnTsl( latHull, aft, reach ).toVar();
			const vLat = side.mul( openTan ).mul( uFeOpenSpeed )
				.mul( uFeDiverge )
				.mul( carryBoost )
				.mul( own )
				.toVar();
			const cap = uFeWaveMax.mul( 1.35 ).max(
				openTan.mul( uFeOpenSpeed ).mul( uFeDiverge.max( 1.0 ) ),
			).mul( carryBoost.max( 1.0 ) );
			divergeFlow.assign( uFeRight.mul( clamp( vLat, cap.negate(), cap ) ) );

		} );
		pv.subAssign( flow.add( divergeFlow ).mul( uFeAgeDt ).div( uFePrevExtent ) );

		} );

	} );
	If( pv.x.greaterThan( 0.0 )
		.and( pv.x.lessThan( 1.0 ) )
		.and( pv.y.greaterThan( 0.0 ) )
		.and( pv.y.lessThan( 1.0 ) ), () => {

		const center = foamEnergyPrevTexture.sample( pv ).level( 0 ).r.toVar();
		If( uFeWaveSpread.greaterThan( 0.0 ).and(
			waveActivity.greaterThan( 0.001 ),
		), () => {

			const texel = float( 1.0 ).div( uFeSize ).toVar();
			// Local, normalized exchange. The old offset reached fourteen
			// texels (8.75 m on this tile) and max(shed) copied that sample
			// into clear water, allowing foam to leapfrog across a storm.
			const reach = texel.mul( waveActivity.mul( 1.5 ).add( 1.0 ) ).toVar();
			const along = waveAxis.mul( reach ).toVar();
			const tangent = vec2( waveAxis.y.negate(), waveAxis.x ).mul( reach ).toVar();
			const nearby = foamEnergyPrevTexture.sample( pv.add( along ) ).level( 0 ).r
				.add( foamEnergyPrevTexture.sample( pv.sub( along ) ).level( 0 ).r )
				.add( foamEnergyPrevTexture.sample( pv.add( tangent ) ).level( 0 ).r )
				.add( foamEnergyPrevTexture.sample( pv.sub( tangent ) ).level( 0 ).r )
				.mul( 0.25 )
				.toVar();
			const spread = uFeAgeDt.mul( waveActivity )
				.mul( uFeWaveSpread ).mul( 0.8 ).min( 0.08 ).toVar();
			center.assign( mix( center, nearby, spread ) );

		} );
		e.assign( center );

	} );

	e.assign( e.mul( exp( uFeAgeDt.negate().div( uFeDecay.max( float( FOAM_ENERGY_DECAY_MIN ) ) ) ) ) );

	If( uFeActive.greaterThan( 0.5 ).and( uFeStir.greaterThan( 0.001 ) ).and(
		uFeInjectDt.greaterThan( 0.0 ),
	), () => {

		const seg = uFeB.sub( uFeA ).toVar();
		const jump = seg.dot( seg ).sqrt().toVar();
		If( jump.lessThan( float( FOAM_ENERGY_TELEPORT ) ), () => {

			const ll = seg.dot( seg ).max( 1e-5 ).toVar();
			const t = w.sub( uFeA ).dot( seg ).div( ll ).toVar();
			// Lat from the live bow stamp, not the previous point — otherwise
			// the chine lobes drift off the hull when the path bends.
			const lat = w.sub( uFeB ).dot( uFeRight ).toVar();
			const along = w.sub( uFeB ).dot( uFeFwd ).toVar();
			// The stamp is the cutwater: do not project two bright rails into
			// untouched water in front of the bow.
			const behindBow = float( 1.0 ).sub(
				smoothstep( float( 0.05 ), float( 0.35 ), along ),
			).toVar();
			// Twin of foamEnergyLiveHull() — the bow sweep is only this
			// frame's cutwater travel; the live waterline must stay foamed
			// or a yaw leaves the transom on empty water.
			const liveHull = float( 0.0 ).toVar();
			If( uFeHullLen.greaterThan( 0.8 ), () => {

				const sternAlong = uFeHullLen.negate().mul( 0.96 ).toVar();
				const pastStern = float( 1.0 ).sub(
					smoothstep( sternAlong.sub( 0.25 ), sternAlong.sub( 1.0 ), along ),
				);
				liveHull.assign( behindBow.mul( pastStern ) );

			} );
			// Twin of foamEnergyPlanformHalf() — local half-beam, not a box.
			const s = clamp( along.negate().div( uFeHullLen.max( 0.8 ) ), 0.0, 1.0 ).toVar();
			// Twin of foamEnergyAlong() — bow + transom bright, amidships
			// a quieter window of sea. No LOA keeps the old solid slab.
			const alongK = float( 1.0 ).toVar();
			If( uFeHullLen.greaterThan( 0.8 ), () => {

				const bowK = float( 1.0 ).sub( smoothstep( 0.16, 0.40, s ) ).toVar();
				const sternK = smoothstep( 0.62, 0.88, s ).toVar();
				alongK.assign(
					float( FOAM_ENERGY_ALONG_FLOOR ).add(
						float( 1.0 - FOAM_ENERGY_ALONG_FLOOR ).mul( bowK.max( sternK ) ),
					),
				);

			} );
			const x = s.mul( float( FOAM_ENERGY_PLANFORM_N - 1 ) ).toVar();
			const i0 = int( x.floor() );
			const i1 = int( x.floor().add( 1.0 ).min( float( FOAM_ENERGY_PLANFORM_N - 1 ) ) );
			const rw = mix(
				uFePlanform.element( i0 ), uFePlanform.element( i1 ), x.fract(),
			).max( 0.08 ).toVar();
			const q2 = lat.div( rw ).mul( lat.div( rw ) ).toVar();
			// Twin of foamEnergyLane() — bow stays a flat band; the
			// transom wake opens a dark sailing-line channel.
			const wakeOpen = float( 0.0 ).toVar();
			If( uFeHullLen.greaterThan( 0.8 ), () => {

				const aft = along.negate().sub( uFeHullLen.mul( 0.96 ) ).toVar();
				wakeOpen.assign(
					smoothstep( float( 0.70 ), float( 0.90 ), s ).max(
						smoothstep( float( - 0.15 ), float( 1.2 ), aft ),
					),
				);

			} );
			const rail = smoothstep( float( 0.20 ), float( 0.50 ), lat.abs().div( rw ) ).toVar();
			const turnK = select(
				uFeYawRate.abs().greaterThan( 0.03 ),
				clamp( uFeYawRate.abs().div( 0.55 ), 0.0, 1.0 ),
				float( 0.0 ),
			).toVar();
			const outer = select( uFeYawRate.greaterThan( 0.0 ), float( - 1.0 ), float( 1.0 ) ).toVar();
			const side = clamp( lat.div( uFeBeam.max( 0.35 ).mul( 0.42 ) ), - 1.0, 1.0 ).toVar();
			const towardOuter = side.mul( outer ).toVar();
			const turnBias = mix(
				float( 1.0 ).sub( turnK.mul( FOAM_ENERGY_TURN_INNER ) ),
				float( 1.0 ).add( turnK.mul( FOAM_ENERGY_TURN_OUTER ) ),
				float( 0.5 ).add( towardOuter.mul( 0.5 ) ),
			).toVar();
			const lane = mix(
				float( 1.0 ),
				float( FOAM_ENERGY_WAKE_CHANNEL ).add(
					float( 1.0 - FOAM_ENERGY_WAKE_CHANNEL ).mul( rail ),
				),
				wakeOpen,
			).toVar();
			const across = q2.mul( q2 ).mul( q2 ).mul( q2 ).negate().exp()
				.mul( lane ).mul( turnBias ).toVar();
			// Twin of foamEnergyWakeCarve() — eat the bow slab on the
			// sailing line so persist cannot fill the transom wedge. The
			// window must be FINITE astern: wakeOpen saturates to 1 behind
			// the bow, and this is decay over a world-anchored field, so
			// reusing it here swung an infinite heading ray across the old
			// curved trail on every turn and wiped one side of it.
			const aftM = along.negate().sub( uFeHullLen.mul( 0.96 ) ).toVar();
			const carveWin = smoothstep( float( 0.70 ), float( 0.90 ), s ).mul(
				float( 1.0 ).sub( smoothstep(
					float( FOAM_ENERGY_WAKE_CARVE_AFT * 0.5 ),
					float( FOAM_ENERGY_WAKE_CARVE_AFT ),
					aftM,
				) ),
			).toVar();
			const carve = carveWin.mul( float( 1.0 ).sub( rail ) ).toVar();
			If( uFeHullLen.greaterThan( 0.8 ), () => {

				e.mulAssign( exp(
					uFeAgeDt.negate().mul( FOAM_ENERGY_WAKE_CARVE ).mul( carve ),
				) );

			} );
			const metres = select(
				t.lessThan( 0.0 ),
				t.negate().mul( jump ),
				select( t.greaterThan( 1.0 ), t.sub( 1.0 ).mul( jump ), float( 0.0 ) ),
			).toVar();
			const sweep = float( 1.0 ).toVar();
			If( metres.greaterThan( 0.0 ), () => {

				sweep.assign(
					metres.div( FOAM_ENERGY_CAP ).mul( metres.div( FOAM_ENERGY_CAP ) ).negate().exp(),
				);

			} );
			const brush = float( 1.0 ).toVar();
			If( jump.greaterThan( 0.12 ), () => {

				brush.assign( float( FOAM_ENERGY_BRUSH ).div( jump ).min( 1.0 ) );

			} );
			const path = jump.max( 0.05 ).mul( brush ).toVar();
			e.addAssign( uFeStir.mul( uFeGain.max( 0.0 ) ).mul( behindBow ).mul( across )
				.mul( sweep.max( liveHull ) ).mul( alongK )
				.mul( FOAM_ENERGY_HULL ).mul( path ) );

		} );

	} );
	// Motor wash is pinned to the live transom in hull axes — independent
	// of the bow sweep so a turn keeps the jet on the back of the mesh. It is
	// also finite astern: the old one-sided gate painted an infinite half-strip
	// that swept a solid white sector across the inside of every turn.
	If( uFeActive.greaterThan( 0.5 ).and( uFeStir.greaterThan( 0.001 ) ).and(
		uFeInjectDt.greaterThan( 0.0 ),
	).and( uFeMotor.greaterThan( 0.001 ) ), () => {

		const stern = uFeStern.toVar();
		const mLat = w.sub( stern ).dot( uFeRight ).toVar();
		const mAlong = w.sub( stern ).dot( uFeFwd ).toVar();
		const mBehind = float( 1.0 ).sub(
			smoothstep( float( 0.05 ), float( 0.45 ), mAlong ),
		).toVar();
		const mAft = mAlong.negate().max( 0.0 ).toVar();
		const mReach = uFeMotorReach.max( 0.4 ).toVar();
		const mReach0 = mReach.mul(
			float( FOAM_ENERGY_MOTOR_REACH0 / FOAM_ENERGY_MOTOR_REACH ),
		).toVar();
		const mTail = float( 1.0 ).sub(
			smoothstep( mReach0, mReach, mAft ),
		).toVar();
		const mw = uFeBeam.mul( uFeMotorW ).max( 0.08 ).toVar();
		const mq2 = mLat.div( mw ).mul( mLat.div( mw ) ).toVar();
		const motorAcross = mq2.mul( mq2 ).negate().exp().toVar();
		const jumpM = uFeB.sub( uFeA ).dot( uFeB.sub( uFeA ) ).sqrt().toVar();
		const brushM = select(
			jumpM.greaterThan( 0.12 ),
			float( FOAM_ENERGY_BRUSH ).div( jumpM ).min( 1.0 ),
			float( 1.0 ),
		).toVar();
		const pathM = jumpM.max( 0.05 ).mul( brushM ).toVar();
		If( jumpM.lessThan( float( FOAM_ENERGY_TELEPORT ) ), () => {

			e.addAssign( uFeStir.mul( uFeMotor ).mul( mBehind ).mul( mTail ).mul( motorAcross )
				.mul( FOAM_ENERGY_HULL ).mul( FOAM_ENERGY_MOTOR ).mul( pathM ) );

		} );

	} );

	return vec4( clamp( e, 0.0, FOAM_ENERGY_MAX ), waveGather, 1.0, 1.0 );

} );
