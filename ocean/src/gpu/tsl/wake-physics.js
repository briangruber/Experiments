// TSL twin of src/wake-physics.js. Same numbers, same signs, same early-outs.
// Bound hull wave + Kelvin divergent / transverse modes. No occupancy cut.
//
// Uniforms live here (porting rule 7). Head / heading / speed are the ones
// water-common.js already owns — imported, not redeclared. Amplitude is
// the finished metres from the CPU (Froude gain, draft, shallow, yaw).
//
// No texture fetch, so this is legal in non-uniform control flow.
// No .mix() — rule 1.

import {
	Fn, If, float, vec2,
	uniform, smoothstep, clamp,
} from 'three/tsl';

import { uWakeHead, uWakeFwd, uWakeSpeed } from './water-common.js';
import {
	WAKE_PHYS_MASK_SIDE0, WAKE_PHYS_MASK_SIDE1,
	WAKE_PHYS_MASK_AFT0, WAKE_PHYS_MASK_AFT1,
} from '../../wake-physics.js';

const KELVIN_G = 9.81;
const KELVIN_TAN = 0.3535533905932738;
const DIVERGE_SIN = 0.5773502691896258;
const DIVERGE_COS = 0.816496580927726;
const KELVIN_REF_M = 12.0;
const SQRT2 = 1.4142135623730951;
const TWO_PI = 6.28318530718;

export const uWakePhysOn = /*@__PURE__*/ uniform( 0.0 );
export const uWakePhysAmp = /*@__PURE__*/ uniform( 0.0 );
export const uWakePhysLen = /*@__PURE__*/ uniform( 12.0 );
export const uWakePhysBeam = /*@__PURE__*/ uniform( 3.2 );
export const uWakePhysDepth = /*@__PURE__*/ uniform( 40.0 );
export const uWakePhysDecay = /*@__PURE__*/ uniform( 80.0 );

/**
 * Smooth hull footprint for fragment-only contact distortion. This never
 * displaces vertices: it bends reflections/refraction around the waterline
 * while the wave equation remains responsible for the travelling wake.
 */
export const wakePhysicsContactAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uWakePhysOn.greaterThan( 0.5 ), () => {

		const rel = p.sub( uWakeHead ).toVar();
		const along = rel.dot( uWakeFwd ).negate().toVar();
		const lat = rel.x.mul( uWakeFwd.y.negate() ).add( rel.y.mul( uWakeFwd.x ) ).toVar();
		const L = uWakePhysLen.max( 0.8 ).toVar();
		const beam = uWakePhysBeam.max( 0.35 ).toVar();
		const nearest = clamp( along, 0.0, L );
		const end = along.sub( nearest );
		const d = vec2( end, lat ).length().toVar();
		out.assign(
			float( 1.0 ).sub( smoothstep( beam.mul( 0.38 ), beam.mul( 0.58 ), d ) ),
		);

	} );
	return out;

} );

/** Softly removes near-hull wake height from the vertex mesh only. */
export const wakePhysicsGeometryMaskAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const out = float( 0.0 ).toVar();
	If( uWakePhysOn.greaterThan( 0.5 ), () => {

		const rel = p.sub( uWakeHead ).toVar();
		const along = rel.dot( uWakeFwd ).negate().toVar();
		const lat = rel.x.mul( uWakeFwd.y.negate() ).add( rel.y.mul( uWakeFwd.x ) ).toVar();
		const L = uWakePhysLen.max( 0.8 ).toVar();
		const beam = uWakePhysBeam.max( 0.35 ).toVar();
		const nearest = clamp( along, 0.0, L );
		const d = vec2( along.sub( nearest ), lat ).length().toVar();
		// Twin of wakePhysicsGeometryMask() — sides stay beam-scaled so
		// leftover cannot stand the deck up; aft of the transom the fade
		// is ~1 m so leftover is born on the stern, not a hole behind it.
		const r0 = float( WAKE_PHYS_MASK_AFT0 ).toVar();
		const r1 = float( WAKE_PHYS_MASK_AFT1 ).toVar();
		If( along.lessThanEqual( L ), () => {

			r0.assign( beam.mul( WAKE_PHYS_MASK_SIDE0 ) );
			r1.assign( beam.mul( WAKE_PHYS_MASK_SIDE1 ) );

		} );
		out.assign( float( 1.0 ).sub( smoothstep( r0, r1, d ) ) );

	} );
	return out;

} );

/**
 * @param {object | null | undefined} wake  the object wake.uniforms() returns
 */
export function setWakePhysicsUniforms( wake ) {

	if ( ! wake || ! ( wake.uWakePhysOn > 0.5 ) ) {

		uWakePhysOn.value = 0.0;
		return;

	}

	uWakePhysOn.value = 1.0;
	uWakePhysAmp.value = wake.uWakePhysAmp ?? 0;
	uWakePhysLen.value = wake.uWakePhysLen ?? 12;
	uWakePhysBeam.value = wake.uWakePhysBeam ?? 3.2;
	uWakePhysDepth.value = wake.uWakePhysDepth ?? 40;
	uWakePhysDecay.value = wake.uWakePhysDecay ?? 80;

}

const kelvinTanNode = /*@__PURE__*/ Fn( () => {

	const U = uWakeSpeed.abs().max( 0.5 );
	const L = uWakePhysLen.max( 1.0 );
	const out = float( KELVIN_TAN ).toVar();
	If( L.greaterThanEqual( 12.0 ), () => {

		const Fr = U.div( float( KELVIN_G ).mul( L ).sqrt() );
		const tanNarrow = float( 1.0 ).div( float( 2.0 ).mul( SQRT2 ).mul( Fr ) );
		out.assign( float( KELVIN_TAN ).min( tanNarrow ) );

	} );
	If( uWakePhysDepth.greaterThan( 0.1 ), () => {

		const Frh = U.div( float( KELVIN_G ).mul( uWakePhysDepth ).sqrt() );
		If( Frh.lessThan( 1.0 ), () => {

			out.assign( out.div( float( 1.0 ).sub( Frh.mul( Frh ) ).max( 0.08 ).sqrt() ) );

		} );

	} );
	return out;

} );

/**
 * height (m, signed), crest foam. Twin of src/wake-physics.js wakePhysicsAt().
 */
export const wakePhysicsAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const outv = vec2( 0.0 ).toVar();

	If( uWakePhysOn.greaterThan( 0.5 )
		.and( uWakeSpeed.greaterThan( 0.55 ) )
		.and( uWakePhysAmp.greaterThan( 0.001 ) ), () => {

		const rel = p.sub( uWakeHead ).toVar();
		const along = rel.dot( uWakeFwd ).negate().toVar();
		const lat = rel.x.mul( uWakeFwd.y.negate() ).add( rel.y.mul( uWakeFwd.x ) ).toVar();

		const L = uWakePhysLen.max( 0.8 ).toVar();
		const beam = uWakePhysBeam.max( 0.35 ).toVar();
		const U = uWakeSpeed.abs().max( 0.4 ).toVar();
		const lambda = float( TWO_PI ).mul( U ).mul( U ).div( KELVIN_G ).max( 0.8 ).toVar();
		const k0 = float( TWO_PI ).div( lambda ).toVar();
		const A = uWakePhysAmp.toVar();

		const sig = beam.mul( 0.55 ).max( 0.35 );
		const latEnv = lat.mul( lat ).div( sig.mul( sig ) ).negate().exp().toVar();
		const boundEnv = smoothstep( L.mul( - 0.18 ), L.mul( 0.04 ), along )
			.mul( float( 1.0 ).sub( smoothstep( L.mul( 0.82 ), L.mul( 1.28 ), along ) ) )
			.mul( latEnv )
			.toVar();
		const phase = float( TWO_PI ).mul( along ).div( lambda );
		const h = A.mul( 0.92 ).mul( phase.cos() ).mul( boundEnv ).toVar();

		const nose = along.add( L.mul( 0.08 ) );
		const noseW = L.mul( 0.14 );
		h.addAssign( A.mul( 0.28 )
			.mul( nose.mul( nose ).div( noseW.mul( noseW ) ).negate().exp() )
			.mul( latEnv ) );

		If( along.greaterThan( L.mul( 0.2 ) ), () => {

			const alo = along;
			const absLat = lat.abs();
			const r = alo.mul( alo ).add( lat.mul( lat ) ).sqrt().toVar();
			const decay = uWakePhysDecay.max( 24.0 );
			const spread = float( KELVIN_REF_M ).div( r.max( KELVIN_REF_M ) ).sqrt()
				.mul( r.div( decay ).negate().exp() )
				.toVar();
			const born = smoothstep( L.mul( 0.28 ), L.mul( 0.72 ), alo );
			const tanW = kelvinTanNode();
			const arm = beam.mul( 0.5 ).add( alo.mul( tanW ) ).toVar();
			const face = float( 0.20 ).mul( lambda.mul( r ).sqrt() ).max( 1.4 ).toVar();
			const dArm = absLat.sub( arm ).toVar();
			const envArm = dArm.mul( dArm ).div( face.mul( face ) ).negate().exp().toVar();
			const outside = dArm.max( 0.0 );
			const evanescent = outside.mul( outside )
				.div( face.mul( face ).mul( 0.35 ) ).negate().exp().toVar();
			const inside = float( 1.0 ).sub(
				smoothstep( arm.mul( 0.12 ), arm.add( face.mul( 0.55 ) ), absLat ),
			).toVar();

			const free = float( 0.0 ).toVar();
			{
				const kn = k0;
				const phaseDiv = kn.mul( 1.5 ).mul(
					alo.mul( DIVERGE_COS ).add( absLat.mul( DIVERGE_SIN ) ),
				);
				free.addAssign(
					envArm.mul( evanescent ).mul( phaseDiv.cos() )
						.add( inside.mul( 0.34 ).mul( kn.mul( alo ).cos() ) ),
				);
			}
			{
				const kn = k0.mul( 2.0 );
				const phaseDiv = kn.mul( 1.5 ).mul(
					alo.mul( DIVERGE_COS ).add( absLat.mul( DIVERGE_SIN ) ),
				);
				free.addAssign( float( 0.42 ).mul(
					envArm.mul( evanescent ).mul( phaseDiv.cos() )
						.add( inside.mul( 0.34 ).mul( kn.mul( alo ).cos() ) ),
				) );
			}
			{
				const kn = k0.mul( 3.0 );
				const phaseDiv = kn.mul( 1.5 ).mul(
					alo.mul( DIVERGE_COS ).add( absLat.mul( DIVERGE_SIN ) ),
				);
				free.addAssign( float( 0.18 ).mul(
					envArm.mul( evanescent ).mul( phaseDiv.cos() )
						.add( inside.mul( 0.34 ).mul( kn.mul( alo ).cos() ) ),
				) );
			}

			h.addAssign( A.mul( 0.70 ).mul( spread ).mul( born ).mul( free ) );

		} );

		outv.assign( vec2( h, clamp( h.max( 0.0 ).mul( 0.18 ), 0.0, 0.55 ) ) );

	} );

	return outv;

} );
