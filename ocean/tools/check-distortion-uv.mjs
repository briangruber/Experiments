#!/usr/bin/env node
// CPU twin of the composite radial-distortion scale. Barrel (the default
// −0.02) used to sample past the top/bottom mid-edges; those fetches clamped
// and printed the smeared band at the top of the frame.

import { distortedUv, distortionScale } from '../src/distortion-uv.js';

let failed = 0;
const check = ( name, cond ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name );
		failed ++;

	}

};

const inside = ( uv ) => uv[ 0 ] >= 0 && uv[ 0 ] <= 1 && uv[ 1 ] >= 0 && uv[ 1 ] <= 1;

const aspect = 16 / 9;
const barrel = - 0.02;
const pinch = 0.02;
const topCenter = [ 0.5, 1 ];
const bottomCenter = [ 0.5, 0 ];
const corner = [ 1, 1 ];
const center = [ 0.5, 0.5 ];

const top = distortedUv( topCenter, barrel, aspect );
const bot = distortedUv( bottomCenter, barrel, aspect );
check( 'barrel top-center stays inside', inside( top ) && top[ 1 ] < 1 );
check( 'barrel bottom-center stays inside', inside( bot ) && bot[ 1 ] > 0 );
check( 'barrel centre is identity', Math.abs( distortedUv( center, barrel, aspect )[ 0 ] - 0.5 ) < 1e-9 );

// The old (1+k*rn2)/(1+k) at the top mid-edge is > 1 and walks off the texture.
const dTop = [ 0, 0.5 ];
const r2max = ( 0.5 * aspect ) ** 2 + 0.25;
const rn2Top = 0.25 / r2max;
const oldKd = ( 1 + barrel * rn2Top ) / ( 1 + barrel );
check( 'old barrel mid-edge kd is > 1 (the smear)', oldKd > 1 );
check( 'new barrel mid-edge kd is <= 1', distortionScale( barrel, rn2Top ) <= 1 );

// Positive k must still pin the corners (same number the GLSL had).
const pinchCorner = distortedUv( corner, pinch, aspect );
check( 'pincushion corner stays pinned', Math.abs( pinchCorner[ 0 ] - 1 ) < 1e-6 && Math.abs( pinchCorner[ 1 ] - 1 ) < 1e-6 );
check( 'pincushion matches the old (1+k) divide', Math.abs( distortionScale( pinch, 1 ) - 1 ) < 1e-12 );

if ( failed ) {

	console.error( failed + ' distortion-uv checks failed' );
	process.exit( 1 );

}

console.log( 'distortion-uv: ok' );
