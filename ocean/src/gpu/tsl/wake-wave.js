// TSL twin of src/wake-wave.js. Expanding rings. Uniforms live here
// (rule 7). Layouted core is scalars only (rule 18). The stamp loop is
// JS-unrolled — a GPU Loop over stamps previously dropped the sea.

import { Fn, If, float, int, smoothstep, uniform, uniformArray } from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
	WAKE_WAVE_STAMPS, WAKE_WAVE_PROBE_DELAY, WAKE_WAVE_PROBE_FADE,
	wakeWaveAmp, wakeWaveWidth,
} from '../../wake-wave.js';

export const uWakeWaveCount = /*@__PURE__*/ uniform( 0.0 );
export const uWakeWave = /*@__PURE__*/ uniformArray(
	Array.from( { length: WAKE_WAVE_STAMPS * 2 }, ( _, i ) => (
		i % 2 === 0
			? new THREE.Vector4( 0, 0, 0, 0.55 )
			: new THREE.Vector4( 0, 0, 1.4, 0 )
	) ),
	'vec4',
);

const wakeWaveCore = /*@__PURE__*/ Fn( ( [
	px, pz, hx, hz, radius, amp, width,
] ) => {

	const dx = px.sub( hx );
	const dz = pz.sub( hz );
	const r = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();
	const d = r.sub( radius );
	const env = d.div( width.max( 0.45 ) ).mul( d.div( width.max( 0.45 ) ) ).negate().exp();
	return env.mul( amp );

} );

const wakeWaveSlopeCore = /*@__PURE__*/ Fn( ( [
	px, pz, hx, hz, radius, amp, width,
] ) => {

	const dx = px.sub( hx );
	const dz = pz.sub( hz );
	const r = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();
	const w = width.max( 0.45 );
	const d = r.sub( radius );
	const env = d.div( w ).mul( d.div( w ) ).negate().exp();
	return amp.mul( env ).mul( d.mul( 2.0 ) ).div( w.mul( w ) ).abs();

} );

wakeWaveCore.setLayout( {
	name: 'abyssal_wakeWaveCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'hx', type: 'float' },
		{ name: 'hz', type: 'float' },
		{ name: 'radius', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'width', type: 'float' },
	],
} );

wakeWaveSlopeCore.setLayout( {
	name: 'abyssal_wakeWaveSlopeCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'hx', type: 'float' },
		{ name: 'hz', type: 'float' },
		{ name: 'radius', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'width', type: 'float' },
	],
} );

const wakeWaveSumAt = ( p, probe ) => {

	const acc = float( 0.0 ).toVar();
	If( uWakeWaveCount.greaterThan( 0.5 ), () => {

		for ( let i = 0; i < WAKE_WAVE_STAMPS; i ++ ) {

			const a = uWakeWave.element( int( i * 2 ) );
			const b = uWakeWave.element( int( i * 2 + 1 ) );
			If( a.z.abs().greaterThan( 0.002 ), () => {

				const probeGain = probe
					? smoothstep(
						float( WAKE_WAVE_PROBE_DELAY ),
						float( WAKE_WAVE_PROBE_DELAY + WAKE_WAVE_PROBE_FADE ),
						b.w,
					)
					: float( 1.0 );
				acc.addAssign( wakeWaveCore(
					p.x, p.y, a.x, a.y,
					a.w, a.z, b.z,
				).mul( probeGain ) );

			} );

		}

	} );
	return acc;

};

/** Height (m) of every live ring at world XZ `p`, added together. */
export const wakeWaveAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	return wakeWaveSumAt( p, false );

} );

/** |∇h| of every live ring at world XZ `p`. Twin: wakeWaveSlopeFieldAt(). */
export const wakeWaveSlopeAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const acc = float( 0.0 ).toVar();
	If( uWakeWaveCount.greaterThan( 0.5 ), () => {

		for ( let i = 0; i < WAKE_WAVE_STAMPS; i ++ ) {

			const a = uWakeWave.element( int( i * 2 ) );
			const b = uWakeWave.element( int( i * 2 + 1 ) );
			If( a.z.abs().greaterThan( 0.002 ), () => {

				acc.addAssign( wakeWaveSlopeCore(
					p.x, p.y, a.x, a.y, a.w, a.z, b.z,
				) );

			} );

		}

	} );
	return acc;

} );

/** Probe twin: newborn rings render, but cannot immediately relaunch their source. */
export const wakeWaveProbeAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	return wakeWaveSumAt( p, true );

} );

/**
 * @param {import('../../wake-wave.js').WakeWaveField | null | undefined} field
 */
export function setWakeWaveUniforms( field ) {

	const stamps = field?.stamps ?? [];
	let n = 0;
	for ( let i = 0; i < WAKE_WAVE_STAMPS; i ++ ) {

		const s = stamps[ i ];
		const amp = s ? wakeWaveAmp( s ) : 0;
		if ( s && amp > 0.002 ) {

			uWakeWave.array[ i * 2 ].set( s.x, s.z, amp, s.radius ?? 0 );
			uWakeWave.array[ i * 2 + 1 ].set( 0, 0, wakeWaveWidth( s ), s.age ?? 0 );
			n ++;

		} else {

			uWakeWave.array[ i * 2 ].set( 0, 0, 0, 0.55 );
			uWakeWave.array[ i * 2 + 1 ].set( 0, 0, 1.4, 0 );

		}

	}
	uWakeWaveCount.value = n;

}
