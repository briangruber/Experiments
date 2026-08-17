// TSL twin of src/kelvin-wake.js. Same numbers, same signs, same early-outs.
// Wikipedia's Kelvin chevron: oscillating gravity waves, not Gaussian tubes.
//
// Uniforms live here (porting rule 7). Head / heading / speed are the ones
// water-common.js already owns for the stamp field — imported, not redeclared.
// A driver calls setKelvinUniforms() next to setWaterCommonUniforms().
//
// No texture fetch, so this is legal in non-uniform control flow (the
// fragment gates on uKelvinOn and the pixel footprint). No .mix() — rule 1.

import {
	Fn, If, float, vec3,
	uniform, smoothstep, clamp,
} from 'three/tsl';

import { uWakeHead, uWakeFwd, uWakeSpeed } from './water-common.js';

// src/kelvin-wake.js — spelled as the digits that file computes, not
// re-derived, so a last-ulp drift cannot open between the twins.
const KELVIN_G = 9.81;
const KELVIN_TAN = 0.3535533905932738;   // 1/√8
const DIVERGE_SIN = 0.5773502691896258;  // 1/√3
const DIVERGE_COS = 0.816496580927726;   // √(2/3)
const KELVIN_REF_M = 12.0;
const SQRT2 = 1.4142135623730951;

export const uKelvinOn = /*@__PURE__*/ uniform( 0.0 );
export const uKelvinAmp = /*@__PURE__*/ uniform( 0.85 );
export const uKelvinDecay = /*@__PURE__*/ uniform( 140.0 );
export const uKelvinFoam = /*@__PURE__*/ uniform( 0.4 );
export const uKelvinLen = /*@__PURE__*/ uniform( 60.0 );
export const uKelvinWidth = /*@__PURE__*/ uniform( 0.0 );

/**
 * @param {object | null | undefined} wake  the object wake.uniforms() returns
 */
export function setKelvinUniforms( wake ) {

	if ( ! wake || ! ( wake.uKelvinOn > 0.5 ) ) {

		uKelvinOn.value = 0.0;
		return;

	}

	uKelvinOn.value = 1.0;
	uKelvinAmp.value = wake.uKelvinAmp ?? 0.85;
	uKelvinDecay.value = wake.uKelvinDecay ?? 140;
	uKelvinFoam.value = wake.uKelvinFoam ?? 0.4;
	uKelvinLen.value = wake.uKelvinLen ?? 60;
	uKelvinWidth.value = wake.uKelvinWidth ?? 0;

}

// Twin of kelvinTan() — min(1/√8, 1/(2√2 Fr)).
const kelvinTanNode = /*@__PURE__*/ Fn( () => {

	const U = uWakeSpeed.abs().max( 0.5 );
	const L = uKelvinLen.max( 1.0 );
	const Fr = U.div( float( KELVIN_G ).mul( L ).sqrt() );
	const tanNarrow = float( 1.0 ).div( float( 2.0 ).mul( SQRT2 ).mul( Fr ) );
	return float( KELVIN_TAN ).min( tanNarrow );

} );

/**
 * foam, height (m, signed), slick. Twin of src/kelvin-wake.js kelvinWakeAt().
 */
export const kelvinWakeAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const outv = vec3( 0.0 ).toVar();

	If( uKelvinOn.greaterThan( 0.5 ).and( uWakeSpeed.greaterThan( 0.5 ) ), () => {

		const rel = p.sub( uWakeHead ).toVar();
		const alo = rel.dot( uWakeFwd ).negate().toVar();

		If( alo.greaterThan( 0.5 ), () => {

			const lat = rel.x.mul( uWakeFwd.y.negate() ).add( rel.y.mul( uWakeFwd.x ) ).toVar();
			const U = uWakeSpeed.abs().max( 2.0 ).toVar();
			const k0 = float( KELVIN_G ).div( U.mul( U ) ).toVar();
			const tanW = kelvinTanNode().toVar();
			const beam = uKelvinWidth.max( 0.0 ).mul( 0.5 );
			const arm = beam.add( alo.mul( tanW ) ).toVar();
			const absLat = lat.abs().toVar();
			const r = alo.mul( alo ).add( lat.mul( lat ) ).sqrt().toVar();

			const decay = uKelvinDecay.max( 20.0 );
			const amp = uKelvinAmp
				.mul( float( KELVIN_REF_M ).div( r.max( KELVIN_REF_M ) ).sqrt() )
				.mul( r.div( decay ).negate().exp() )
				.toVar();

			const lambda = float( 6.28318530718 ).div( k0 ).toVar();
			// Geometric fade at the vertex, not a wavelength. Twin of
			// src/kelvin-wake.js — a λ-scaled born hid the V at speed.
			const born = smoothstep( float( 4.0 ), float( 12.0 ), alo ).toVar();

			const dArm = absLat.sub( arm ).toVar();
			const face = float( 0.22 ).mul( lambda.mul( r ).sqrt() ).max( 1.2 ).toVar();
			const envArm = dArm.mul( dArm ).div( face.mul( face ) ).negate().exp().toVar();
			const outside = dArm.max( 0.0 );
			const evanescent = outside.mul( outside )
				.div( face.mul( face ).mul( 0.35 ) ).negate().exp().toVar();

			const kDiv = k0.mul( 1.5 );
			const phaseDiv = kDiv.mul(
				alo.mul( DIVERGE_COS ).add( absLat.mul( DIVERGE_SIN ) ),
			).toVar();
			const diverging = envArm.mul( evanescent ).mul(
				phaseDiv.cos().add( phaseDiv.mul( 2.0 ).add( 0.7 ).cos().mul( 0.4 ) ),
			).toVar();

			const inside = float( 1.0 ).sub(
				smoothstep( arm.mul( 0.15 ), arm.add( face.mul( 0.6 ) ), absLat ),
			).toVar();
			const transverse = inside.mul( 0.35 ).mul( k0.mul( alo ).cos() );

			const wave = diverging.add( transverse ).mul( amp ).mul( born );
			const steep = diverging.max( 0.0 ).mul( envArm );
			const foam = clamp( steep.mul( amp ).mul( born ).mul( uKelvinFoam ).mul( 1.4 ), 0.0, 1.0 );
			const slick = clamp( inside.mul( born ).mul( 0.45 ), 0.0, 1.0 );

			outv.assign( vec3( foam, wave, slick ) );

		} );

	} );

	return outv;

} );
