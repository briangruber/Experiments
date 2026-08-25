#!/usr/bin/env node
// CPU twin of the foam-mask crisp resolve in water-surface.js / water.js.
// Zero coverage must not light the bubble-noise field (that was the leftover
// white specks after Foam amount / Coverage were already 0).

const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );
const mix = ( a, b, t ) => a + ( b - a ) * t;
const smoothstep = ( e0, e1, x ) => {

	const t = clamp01( ( x - e0 ) / ( e1 - e0 ) );
	return t * t * ( 3 - 2 * t );

};

const mask = ( cov, fd, crisp, e ) => {

	const clumpRes = 1;
	const shape = 1;
	const mul = clamp01( cov * mix( 1, shape, clumpRes ) );
	const resolve = smoothstep( 1 - cov - e, 1 - cov + e, fd ) * smoothstep( 0, e, cov );
	return mix( mul, resolve, crisp );

};

const eF = 0.11;
let failed = 0;
const check = ( name, cond ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name );
		failed ++;

	}

};

// The old centred edge at cov=0 was smoothstep(0.89, 1.11, fd) — a high fd
// still drew foam. That tail has to be gone.
check( 'cov=0, fd=1, crisp=1 is empty', mask( 0, 1, 1, eF ) === 0 );
check( 'cov=0, fd=0.95, crisp=1 is empty', mask( 0, 0.95, 1, eF ) === 0 );
check( 'cov=0, any fd, crisp=0.8 is empty', mask( 0, 0.99, 0.8, eF ) === 0 );

// Mid coverage still resolves: a high field is foam, a low field is not.
check( 'cov=0.5, fd=1, crisp=1 is foam', mask( 0.5, 1, 1, eF ) > 0.9 );
check( 'cov=0.5, fd=0, crisp=1 is empty', mask( 0.5, 0, 1, eF ) < 0.05 );

if ( failed ) {

	console.error( failed + ' foam-mask checks failed' );
	process.exit( 1 );

}

console.log( 'foam-zero-mask: ok' );
