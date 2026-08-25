#!/usr/bin/env node
// CPU twin of the fluke-slick field and the dorsal pressure dome.
//
//   node tools/check-fluke-slicks.mjs

import {
	FlukeSlickField, flukeSlick, flukeWorld, pressureDomeHeight, pressureDomeRadii,
	FLUKE_PRINTS, FLUKE_LIFE, FLUKE_SPEED_MIN,
} from '../src/fluke-slicks.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

{
	const t = flukeWorld( [ 0, 4, 0 ], 0, 60, 0 );
	need( 'a level fluke sits aft of the origin, not on the nose',
		t.z > 20 && Math.abs( t.x ) < 0.05 && Math.abs( t.y - 4 ) < 0.05,
		`fluke ${ t.x.toFixed( 2 ) }, ${ t.y.toFixed( 2 ) }, ${ t.z.toFixed( 2 ) }` );
	const noseDown = flukeWorld( [ 0, 4, 0 ], 0, 60, - 0.4 );
	need( 'a nose-down pitch lifts the fluke',
		noseDown.y > t.y + 2,
		`level y ${ t.y.toFixed( 2 ) } pitched y ${ noseDown.y.toFixed( 2 ) }` );
}

{
	const f = new FlukeSlickField();
	const opts = {
		x: 10, z: - 4, phase: 0, speed: 8, beam: 3,
		clearance: 1.2, fade: 9,
	};
	f.step( 0.05, opts );
	need( 'no print until a stroke peak',
		f.prints.length === 0,
		`n ${ f.prints.length }` );
	// cos goes + → − across π/2
	f.step( 0.05, { ...opts, phase: 1.6 } );
	need( 'a stroke peak drops a print at the fluke',
		f.prints.length === 1
			&& Math.hypot( f.prints[ 0 ].x - 10, f.prints[ 0 ].z + 4 ) < 0.05,
		`n ${ f.prints.length } at ${ f.prints[ 0 ]?.x }, ${ f.prints[ 0 ]?.z }` );
}

{
	const f = new FlukeSlickField();
	const opts = { x: 0, z: 0, phase: 0, speed: 8, beam: 3, clearance: 1, fade: 9 };
	f.step( 0.05, opts );
	f.step( 0.05, { ...opts, phase: 1.6 } );
	const born = flukeSlick( 0, 0, f );
	need( 'a new print grows in instead of appearing at full strength',
		born > 0.002 && born < 0.18,
		`born ${ born.toFixed( 3 ) }` );
	for ( let i = 0; i < 10; i ++ ) f.step( 0.1, { ...opts, phase: 1.6 } );
	const on = flukeSlick( 0, 0, f );
	const far = flukeSlick( 80, 80, f );
	need( 'the print is glassy at the fluke and empty far away',
		on > 0.2 && far < 0.02,
		`on ${ on.toFixed( 3 ) } far ${ far.toExponential( 2 ) }` );
	const edge = ( f.prints[ 0 ].r1 ?? f.prints[ 0 ].r0 ) * 0.95;
	const mid = flukeSlick( edge, 0, f );
	need( 'the slick edge fades instead of cutting off',
		mid > 0.02 && mid < on * 0.55,
		`centre ${ on.toFixed( 3 ) } edge ${ mid.toFixed( 3 ) }` );
}

{
	const f = new FlukeSlickField();
	f.step( 0.05, { x: 0, z: 0, phase: 0, speed: 0.2, beam: 3, clearance: 1, fade: 9 } );
	f.step( 0.05, { x: 0, z: 0, phase: 1.6, speed: 0.2, beam: 3, clearance: 1, fade: 9 } );
	need( 'a loafing stroke does not print (below the speed floor)',
		f.prints.length === 0 && FLUKE_SPEED_MIN > 0.5,
		`n ${ f.prints.length }` );
}

{
	const f = new FlukeSlickField();
	f.step( 0.05, { x: 0, z: 0, phase: 0, speed: 8, beam: 3, clearance: 20, fade: 9 } );
	f.step( 0.05, { x: 0, z: 0, phase: 1.6, speed: 8, beam: 3, clearance: 20, fade: 9 } );
	need( 'a deep tail does not print on the sea',
		f.prints.length === 0,
		`n ${ f.prints.length }` );
}

{
	const f = new FlukeSlickField();
	const opts = { x: 0, z: 12, phase: 0, speed: 10, beam: 6, clearance: - 2.4, fade: 9 };
	f.step( 0.05, opts );
	f.step( 0.05, { ...opts, phase: 1.6 } );
	need( 'a raised fluke still prints on the sea under it',
		f.prints.length === 1 && Math.hypot( f.prints[ 0 ].x, f.prints[ 0 ].z - 12 ) < 0.05,
		`n ${ f.prints.length }` );
}

{
	const f = new FlukeSlickField();
	f.step( 0.05, { x: 4, z: 2, phase: 0.4, speed: 8, beam: 3, clearance: 2.2, fade: 9 } );
	f.step( 0.05, { x: 4, z: 2, phase: 0.4, speed: 8, beam: 3, clearance: - 0.05, fade: 9 } );
	need( 'a tail that slaps the sea prints even mid-stroke',
		f.prints.length === 1 && f.hit === true
			&& Math.hypot( f.prints[ 0 ].x - 4, f.prints[ 0 ].z - 2 ) < 0.05,
		`n ${ f.prints.length } hit ${ f.hit }` );
}

{
	const f = new FlukeSlickField();
	let phase = 0;
	for ( let i = 0; i < 40; i ++ ) {

		phase += 0.9;
		f.step( 0.2, { x: i, z: 0, phase, speed: 10, beam: 3, clearance: 1, fade: 9 } );

	}
	need( 'the ring buffer stays at the shader cap',
		f.sites( FLUKE_PRINTS ).length <= FLUKE_PRINTS,
		`n ${ f.prints.length } cap ${ FLUKE_PRINTS } sites ${ f.sites( FLUKE_PRINTS ).length }` );
	for ( let i = 0; i < 220; i ++ ) f.step( 0.1, { x: 0, z: 0, phase: 0, speed: 0, beam: 3, clearance: 1, fade: 9 } );
	need( 'prints die after their life instead of sitting forever',
		f.prints.length === 0 && FLUKE_LIFE > 4,
		`leftover ${ f.prints.length }` );
}

{
	const p = {
		x: 0, z: 0, r0: 2, r1: 4, grow: 0.85, attack: 0.9, age: 0, life: 10, amp: 1.0,
	};
	p.age = 0.9; // end of attack
	const peak = flukeSlick( 0, 0, [ p ] );
	p.age = 8.0; // 80% life
	const late = flukeSlick( 0, 0, [ p ] );
	p.age = 9.3; // 93% life
	const dying = flukeSlick( 0, 0, [ p ] );
	p.age = 10.0; // 100% life
	const dead = flukeSlick( 0, 0, [ p ] );
	need( 'fluke prints smoothly transition out at the end of life with zero pop',
		late < peak && late > dying && dying < 0.05 && dying > 0 && dead === 0,
		`peak ${ peak.toFixed( 3 ) } 80% ${ late.toFixed( 3 ) } 93% ${ dying.toFixed( 3 ) } dead ${ dead.toFixed( 3 ) }` );
}

{
	const dome = { x: 0, z: 0, dirX: 1, dirZ: 0, amp: 1, along: 10, across: 4 };
	const mid = pressureDomeHeight( 0, 0, dome );
	const along = pressureDomeHeight( 8, 0, dome );
	const side = pressureDomeHeight( 0, 8, dome );
	const far = pressureDomeHeight( 40, 40, dome );
	need( 'the pressure dome is a single ellipse on the mass, not a spine rail',
		mid > 0.8 && along > 0.15 && side < 0.05 && far < 0.01,
		`mid ${ mid.toFixed( 3 ) } along ${ along.toFixed( 3 ) } side ${ side.toFixed( 3 ) } far ${ far.toExponential( 2 ) }` );
	const short = pressureDomeRadii( 60, 6, 3.5 );
	const tall = pressureDomeRadii( 60, 6, 16 );
	need( 'a taller dome is a wider loaf, not a tent on the same ellipse',
		tall.along > short.along * 1.35 && tall.across > short.across * 1.2
			&& tall.along < 60 * 0.45 && tall.across < 60 * 0.3,
		`3.5 m ${ short.along.toFixed( 1 )}×${ short.across.toFixed( 1 ) }  16 m ${ tall.along.toFixed( 1 )}×${ tall.across.toFixed( 1 ) }` );
	const soft = pressureDomeRadii( 60, 6, 3.5, 2 );
	need( 'dome smoothness widens the loaf without changing its height law',
		Math.abs( soft.along - short.along * 2 ) < 0.01
			&& Math.abs( soft.across - short.across * 2 ) < 0.01,
		`soft 2× ${ soft.along.toFixed( 1 )}×${ soft.across.toFixed( 1 ) } vs ${ short.along.toFixed( 1 )}×${ short.across.toFixed( 1 ) }` );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}
const allOk = results.every( ( r ) => r.ok );
console.log( `\n${ allOk ? 'ALL PASS' : 'SOME FAILED' }` );
process.exit( allOk ? 0 : 1 );
