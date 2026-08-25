// TSL twin of src/pierce-carve.js. Uniforms live here (rule 7).
// Layouted core is scalars only (rule 18). The stamp loop is JS-unrolled
// — a GPU Loop over leftover wells previously dropped the sea.

import { Fn, If, float, int, uniform, uniformArray, smoothstep } from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
	PIERCE_CARVE_STAMPS, pierceCarveAmp, pierceCarveFade,
} from '../../pierce-carve.js';
import { pierceOccupancyAt, uPierceWell } from './pierce.js';

export const uPierceCarveCount = /*@__PURE__*/ uniform( 0.0 );
export const uPierceCarve = /*@__PURE__*/ uniformArray(
	Array.from( { length: PIERCE_CARVE_STAMPS * 2 }, ( _, i ) => (
		i % 2 === 0
			? new THREE.Vector4( 0, 0, 0, 0 )
			: new THREE.Vector4( 0.15, 0, 0, 0 )
	) ),
	'vec4',
);

const pierceCarveCore = /*@__PURE__*/ Fn( ( [
	px, pz, ax, az, bx, bz, r, amp,
] ) => {

	const dx = bx.sub( ax );
	const dz = bz.sub( az );
	const len = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();
	const half = len.mul( 0.5 );
	const cx = ax.add( bx ).mul( 0.5 );
	const cz = az.add( bz ).mul( 0.5 );
	const al = len.max( 1e-6 );
	const ux = dx.div( al );
	const uz = dz.div( al );
	const qx = px.sub( cx );
	const qz = pz.sub( cz );
	const t = qx.mul( ux ).add( qz.mul( uz ) ).clamp( half.negate(), half );
	const rx = qx.sub( ux.mul( t ) );
	const rz = qz.sub( uz.mul( t ) );
	const radial = rx.mul( rx ).add( rz.mul( rz ) ).sqrt();
	const thick = r.max( float( 0.02 ) );
	const wall = thick.max( float( 0.15 ) ).mul( 0.28 ).max( float( 0.08 ) );
	const occ = float( 1.0 ).sub( smoothstep( thick, thick.add( wall ), radial ) );
	return amp.negate().mul( occ );

} );

pierceCarveCore.setLayout( {
	name: 'abyssal_pierceCarveCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'ax', type: 'float' },
		{ name: 'az', type: 'float' },
		{ name: 'bx', type: 'float' },
		{ name: 'bz', type: 'float' },
		{ name: 'r', type: 'float' },
		{ name: 'amp', type: 'float' },
	],
} );

/** Height (m) of the leftover trench at world XZ `p`. Negative is a carve. */
export const pierceCarveAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const acc = float( 0.0 ).toVar();
	If( uPierceCarveCount.greaterThan( 0.5 ), () => {

		for ( let i = 0; i < PIERCE_CARVE_STAMPS; i ++ ) {

			const a = uPierceCarve.element( int( i * 2 ) );
			const b = uPierceCarve.element( int( i * 2 + 1 ) );
			If( b.y.greaterThan( 1e-4 ), () => {

				acc.assign( acc.min( pierceCarveCore(
					p.x, p.y, a.x, a.y, a.z, a.w, b.x, b.y,
				) ) );

			} );

		}

	} );
	return acc;

} );

/** 1 inside a leftover capsule, 0 outside. Twin of pierceCarveOccupancy. */
export const pierceCarveMaskAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const acc = float( 0.0 ).toVar();
	If( uPierceCarveCount.greaterThan( 0.5 ), () => {

		for ( let i = 0; i < PIERCE_CARVE_STAMPS; i ++ ) {

			const a = uPierceCarve.element( int( i * 2 ) );
			const b = uPierceCarve.element( int( i * 2 + 1 ) );
			If( b.y.greaterThan( 1e-4 ), () => {

				const h = pierceCarveCore(
					p.x, p.y, a.x, a.y, a.z, a.w, b.x, b.y,
				);
				acc.assign( acc.max(
					h.negate().div( b.y.max( float( 1e-3 ) ) ).mul( b.z ),
				) );

			} );

		}

	} );
	return acc.min( float( 1.0 ) );

} );

/**
 * Occupancy of the live rod and leftover trench. The sea looks through
 * here (refraction / darker column) instead of dropping vertices.
 */
export const pierceCutAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const cut = float( 0.0 ).toVar();
	If( uPierceWell.greaterThan( 1e-4 ), () => {

		cut.assign( pierceOccupancyAt( p ) );

	} );
	If( uPierceCarveCount.greaterThan( 0.5 ), () => {

		cut.assign( cut.max( pierceCarveMaskAt( p ) ) );

	} );
	return cut;

} );

/**
 * @param {import('../../pierce-carve.js').PierceCarveField | null | undefined} field
 */
export function setPierceCarveUniforms( field ) {

	const stamps = field?.stamps ?? [];
	let n = 0;
	for ( let i = 0; i < PIERCE_CARVE_STAMPS; i ++ ) {

		const s = stamps[ i ];
		const amp = s ? pierceCarveAmp( s ) : 0;
		if ( s && amp > 1e-4 ) {

			uPierceCarve.array[ i * 2 ].set( s.ax, s.az, s.bx, s.bz );
			uPierceCarve.array[ i * 2 + 1 ].set(
				Math.max( s.r ?? 0.15, 0.02 ), amp, pierceCarveFade( s ), 0,
			);
			n ++;

		} else {

			uPierceCarve.array[ i * 2 ].set( 0, 0, 0, 0 );
			uPierceCarve.array[ i * 2 + 1 ].set( 0.15, 0, 0, 0 );

		}

	}
	uPierceCarveCount.value = n;

}
