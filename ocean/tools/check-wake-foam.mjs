#!/usr/bin/env node
// Persistent body-trail foam: deposited in world space, then drifts, broadens,
// morphs and dies independently of the source and the analytic V.
//
//   node tools/check-wake-foam.mjs

import {
	WakeFoamField, wakeFoamAt, wakeFoamRadii, WAKE_FOAM_STAMPS,
} from '../src/wake-foam.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );
const source = ( x, z = 0 ) => ( { x, z, fx: 1, fz: 0, half: 1.8 } );

{
	const f = new WakeFoamField();
	f.step( 0.05, source( 0 ), { gain: 1, life: 8, spacing: 3 } );
	need( 'a surface cut deposits one world-space patch',
		f.stamps.length === 1 && Math.hypot( f.stamps[ 0 ].x, f.stamps[ 0 ].z ) < 0.01,
		`n ${ f.stamps.length }` );
	f.step( 0.05, source( 0 ), { gain: 1, life: 8, spacing: 3 } );
	const born = wakeFoamAt( 0, 0, f );
	need( 'new foam attacks instead of popping on full white',
		born > 0.002 && born < 0.25,
		`born ${ born.toFixed( 3 )}` );
}

{
	const f = new WakeFoamField();
	f.step( 0.05, source( 0 ), { gain: 1, life: 8, spacing: 3 } );
	for ( let x = 4; x <= 20; x += 4 ) {

		f.step( 0.1, source( x ), { gain: 1, life: 8, spacing: 3 } );

	}
	const first = f.stamps[ 0 ];
	need( 'old foam does not chase the moving body',
		first.x < 0.2 && f.stamps.some( ( p ) => p.x > 15 ),
		`old x ${ first.x.toFixed( 2 )}, newest ${ f.stamps.at( - 1 ).x.toFixed( 2 )}` );
}

{
	const f = new WakeFoamField();
	f.step( 0.05, source( 0 ), { gain: 1, life: 8, driftX: 0.8, driftZ: 0.25 } );
	const p = f.stamps[ 0 ];
	const x0 = p.x, z0 = p.z;
	for ( let i = 0; i < 10; i ++ ) {

		f.step( 0.1, null, { driftX: 0.8, driftZ: 0.25 } );

	}
	need( 'leftover foam drifts with the surface current',
		p.x > x0 + 0.55 && p.z > z0 + 0.15,
		`drift ${ ( p.x - x0 ).toFixed( 2 )},${ ( p.z - z0 ).toFixed( 2 ) } m` );
}

{
	const f = new WakeFoamField();
	f.step( 0.05, source( 0 ), {
		gain: 1, life: 8, along: 2, across: 1.5, growAlong: 0.3, growAcross: 0.55,
	} );
	const p = f.stamps[ 0 ];
	const a = wakeFoamRadii( p );
	for ( let i = 0; i < 12; i ++ ) f.step( 0.1, null, {} );
	const b = wakeFoamRadii( p );
	need( 'the patch shears and broadens as it ages',
		b.along > a.along + 0.2 && b.across > a.across + 0.45,
		`radii ${ a.along.toFixed( 2 )}/${ a.across.toFixed( 2 ) } -> ${ b.along.toFixed( 2 )}/${ b.across.toFixed( 2 ) }` );
}

{
	const f = new WakeFoamField();
	f.step( 0.05, source( 0 ), { gain: 1, life: 1.2 } );
	for ( let i = 0; i < 20; i ++ ) f.step( 0.1, null, {} );
	need( 'foam dies after its own lifetime',
		f.stamps.length === 0 && wakeFoamAt( 0, 0, f ) < 0.001,
		`n ${ f.stamps.length }` );
}

{
	const f = new WakeFoamField();
	for ( let i = 0; i < 40; i ++ ) {

		f.step( 0.1, source( i * 4 ), { gain: 1, life: 20, spacing: 2 } );

	}
	need( 'the stamp history stays at the shader cap',
		f.stamps.length === WAKE_FOAM_STAMPS,
		`n ${ f.stamps.length } cap ${ WAKE_FOAM_STAMPS }` );
}

{
	const f = new WakeFoamField();
	f.step( 0.05, source( 0 ), {
		gain: 1, life: 8, spacing: 3, along: 4, across: 4,
	} );
	for ( let i = 0; i < 10; i ++ ) f.step( 0.1, null, {} );
	const c = wakeFoamAt( 0, 0, f );
	const mid = wakeFoamAt( 2.0, 0, f );
	const rim = wakeFoamAt( 3.4, 0, f );
	need( 'a patch is a soft mound, not a flat disc',
		c > mid * 1.12 && mid > rim && rim < c * 0.50,
		`c ${ c.toFixed( 3 ) } mid ${ mid.toFixed( 3 ) } rim ${ rim.toFixed( 3 ) }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}
if ( failed.length ) {

	console.error( `\n${ failed.length } FAILED` );
	process.exit( 1 );

}
console.log( '\nALL PASS' );
