// TSL twin of src/v-wake.js. Same numbers, same signs, same early-outs.
// Layouted core is scalars only (rule 18). Uniforms are read in vWakeAt.
// One frozen generating contact: a dive stops writing, this chevron
// fades on its own clock. A stamp loop in the water shader compiled
// on the CPU check and then dropped the sea (orange frame).

import { Fn, float, vec2, uniform, If, select, smoothstep } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { vWakeStampAmp } from '../../v-wake.js';

export const uVWakeOn = /*@__PURE__*/ uniform( 0.0 );
export const uVWakeHead = /*@__PURE__*/ uniform( new THREE.Vector2( 0, 0 ) );
export const uVWakeFwd = /*@__PURE__*/ uniform( new THREE.Vector2( 0, 1 ) );
export const uVWakeAmp = /*@__PURE__*/ uniform( 0.0 );
export const uVWakeLen = /*@__PURE__*/ uniform( 70.0 );
export const uVWakeWidth = /*@__PURE__*/ uniform( 1.3 );
export const uVWakeTan = /*@__PURE__*/ uniform( 0.2679 ); // tan(15°)
export const uVWakeMid = /*@__PURE__*/ uniform( 0.83 );

// Twin of vWakeAt() / vWakeChurnAt() — height in x, motorboat-lane
// churn in y. y is the water BETWEEN the arms, never the ridges.
const vWakeCore = /*@__PURE__*/ Fn( ( [ px, pz, hx, hz, fx, fz, amp, len, width, tanA, mid ] ) => {

	const dirLen = fx.mul( fx ).add( fz.mul( fz ) ).sqrt().max( 1e-5 );
	const fxx = fx.div( dirLen );
	const fzz = fz.div( dirLen );
	const dx = px.sub( hx );
	const dz = pz.sub( hz );
	const along = dx.mul( fxx ).add( dz.mul( fzz ) );
	const across = dx.mul( fzz ).negate().add( dz.mul( fxx ) );
	const fetch = along.negate().max( 0.0 );
	const L = len.max( 8.0 );
	const arm = fetch.mul( tanA );
	const w = width.max( 0.8 ).add( fetch.mul( 0.035 ) );
	const d = across.abs().sub( arm ).abs();
	const ridgeArm = d.div( w ).mul( d.div( w ) ).negate().exp();
	const ridgeMid = mid.max( 0.0 ).mul(
		across.div( w ).mul( across.div( w ) ).negate().exp(),
	);
	const ridge = ridgeArm.max( ridgeMid );
	const fade = float( 1.0 ).sub( fetch.div( L ) ).max( 0.0 );
	const fade2 = fade.mul( fade );
	const born = smoothstep( float( 2.0 ), float( 10.0 ), fetch );
	const live = select(
		along.greaterThan( 1.2 ).or( fetch.greaterThan( L ) ),
		float( 0.0 ),
		float( 1.0 ),
	);
	const h = amp.mul( ridge ).mul( fade2 ).mul( born ).mul( live );
	const lane = width.max( 0.8 ).mul( 2.8 ).add( fetch.mul( 0.14 ) );
	const track = across.div( lane ).mul( across.div( lane ) ).negate().exp();
	const gain = amp.div( 1.39 ).min( 1.2 ).mul( 0.88 );
	const churn = track.mul( fade2 ).mul( born ).mul( live ).mul( gain );
	return vec2( h, churn.min( 1.0 ) );

} );

vWakeCore.setLayout( {
	name: 'abyssal_vWakeCore',
	type: 'vec2',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'hx', type: 'float' },
		{ name: 'hz', type: 'float' },
		{ name: 'fx', type: 'float' },
		{ name: 'fz', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'len', type: 'float' },
		{ name: 'width', type: 'float' },
		{ name: 'tanA', type: 'float' },
		{ name: 'mid', type: 'float' },
	],
} );

/** Uniform reads stay HERE (rule 18). Two scalars, not a vec2. */
export const vWakeAt = /*@__PURE__*/ Fn( ( [ px, pz ] ) => {

	const out = vec2( 0.0, 0.0 ).toVar();
	If( uVWakeOn.greaterThan( 0.5 ).and( uVWakeAmp.abs().greaterThan( 0.001 ) ), () => {

		out.assign( vWakeCore(
			px, pz,
			uVWakeHead.x, uVWakeHead.y,
			uVWakeFwd.x, uVWakeFwd.y,
			uVWakeAmp, uVWakeLen, uVWakeWidth, uVWakeTan, uVWakeMid,
		) );

	} );
	return out;

} );

export function setVWakeUniforms( u ) {

	const stamps = u?.stamps;
	let head = u?.head;
	let fwd = u?.fwd;
	let amp = u?.amp ?? 0;
	if ( stamps?.length ) {

		let best = null;
		let bestA = 0;
		for ( let i = 0; i < stamps.length; i ++ ) {

			const a = vWakeStampAmp( stamps[ i ] );
			if ( a > bestA ) {

				bestA = a;
				best = stamps[ i ];

			}

		}
		if ( best ) {

			head = [ best.x, best.z ];
			fwd = [ best.fx, best.fz ];
			amp = bestA;

		} else {

			amp = 0;

		}

	}
	uVWakeOn.value = amp > 0.001 ? 1 : 0;
	if ( head ) uVWakeHead.value.set( head[ 0 ], head[ 1 ] );
	if ( fwd ) uVWakeFwd.value.set( fwd[ 0 ], fwd[ 1 ] );
	uVWakeAmp.value = amp;
	uVWakeLen.value = u?.len ?? 70;
	uVWakeWidth.value = u?.width ?? 1.3;
	uVWakeTan.value = u?.tan ?? 0.2679;
	uVWakeMid.value = u?.mid ?? 0.83;

}
