#!/usr/bin/env node
// Leftover surface foam must outlive the body that made it.
//
//   node tools/check-leftover-foam.mjs

import {
	LeftoverFoamField, leftoverFoamAt, LEFTOVER_FOAM, LEFTOVER_FOAM_LIFE,
} from '../src/leftover-foam.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

{
	const f = new LeftoverFoamField();
	f.step( 0.05, [ { x: 4, z: - 2, half: 2 } ], { gain: 1, life: 8 } );
	need( 'a waterline site drops a foam patch',
		f.stamps.length === 1
			&& Math.hypot( f.stamps[ 0 ].x - 4, f.stamps[ 0 ].z + 2 ) < 0.05,
		`n ${ f.stamps.length }` );
	f.step( 0.05, [ { x: 4, z: - 2, half: 2 } ], { gain: 1, life: 8 } );
	const born = leftoverFoamAt( 4, - 2, f );
	need( 'a new patch grows in instead of popping on at full white',
		born > 0.002 && born < 0.35,
		`born ${ born.toFixed( 3 ) }` );
}

{
	const f = new LeftoverFoamField();
	f.step( 0.05, [ { x: 0, z: 0, half: 2.4 } ], { gain: 1, life: 8 } );
	for ( let i = 0; i < 8; i ++ ) f.step( 0.1, [ { x: 0, z: 0, half: 2.4 } ], { gain: 1, life: 8 } );
	const on = leftoverFoamAt( 0, 0, f );
	const far = leftoverFoamAt( 80, 80, f );
	need( 'the patch is white at the cut and empty far away',
		on > 0.2 && far < 0.02,
		`on ${ on.toFixed( 3 ) } far ${ far.toExponential( 2 ) }` );
}

{
	const f = new LeftoverFoamField();
	f.step( 0.05, [ { x: 3, z: 1, half: 2 } ], { gain: 0.9, life: 8 } );
	for ( let i = 0; i < 6; i ++ ) f.step( 0.1, [ { x: 3, z: 1, half: 2 } ], { gain: 0.9, life: 8 } );
	const whileNear = leftoverFoamAt( 3, 1, f );
	// Body leaves / dives: no more sites. Foam must stay.
	for ( let i = 0; i < 8; i ++ ) f.step( 0.1, [], { gain: 0.9, life: 8 } );
	const afterGone = leftoverFoamAt( 3, 1, f );
	need( 'foam stays on the sea after the body leaves or dives',
		f.stamps.length === 1 && afterGone > 0.08 && afterGone < whileNear * 1.05,
		`n ${ f.stamps.length } while ${ whileNear.toFixed( 3 ) } after ${ afterGone.toFixed( 3 ) }` );
}

{
	const f = new LeftoverFoamField();
	f.step( 0.05, [], { gain: 1, life: 8 } );
	need( 'no sites means no foam is created',
		f.stamps.length === 0,
		`n ${ f.stamps.length }` );
}

{
	const f = new LeftoverFoamField();
	f.step( 0.05, [ { x: 0, z: 0, half: 2 } ], { gain: 0, life: 8 } );
	need( 'zero gain does not stamp',
		f.stamps.length === 0,
		`n ${ f.stamps.length }` );
}

{
	const f = new LeftoverFoamField();
	f.drop( 8, - 4, { r0: 3, amp: 1, life: 6 } );
	need( 'a leap slap can drop a patch with no waterline sites',
		f.stamps.length === 1
			&& Math.hypot( f.stamps[ 0 ].x - 8, f.stamps[ 0 ].z + 4 ) < 0.05,
		`n ${ f.stamps.length }` );
}

{
	const f = new LeftoverFoamField();
	for ( let i = 0; i < 40; i ++ ) {

		f.step( 0.2, [ { x: i * 3, z: 0, half: 2 } ], { gain: 1, life: 8 } );

	}
	need( 'the ring buffer stays at the shader cap',
		f.stamps.length === LEFTOVER_FOAM && LEFTOVER_FOAM >= 8,
		`n ${ f.stamps.length } cap ${ LEFTOVER_FOAM }` );
}

{
	const f = new LeftoverFoamField();
	f.step( 0.05, [ { x: 0, z: 0, half: 2 } ], { gain: 1, life: 1.2 } );
	for ( let i = 0; i < 20; i ++ ) f.step( 0.1, [], { gain: 1, life: 1.2 } );
	need( 'patches die after their life instead of sitting forever',
		f.stamps.length === 0 && leftoverFoamAt( 0, 0, f ) < 0.01,
		`leftover ${ f.stamps.length } life default ${ LEFTOVER_FOAM_LIFE }` );
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
