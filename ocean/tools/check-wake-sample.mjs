#!/usr/bin/env node
// CPU twin of wakeAt(): the snout stamp must not rule a line, and the
// V must still stand up once the arms have left the track.
//
//   node tools/check-wake-sample.mjs

import { wakeAtCpu, wakeEdgeCpu, wakeStampKind } from '../src/wake-sample.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const u = {
	life: 14,
	armW: 2.6,
	spread: 0.28,
	beam: 2.4,
	arm: 1,
	churn: 0.5,
	depth: 0.79,
	strength: 1.15,
};

const at = ( rec ) => wakeAtCpu( rec, u );
const quiet = ( s ) => Math.abs( s.foam ) < 0.002 && Math.abs( s.h ) < 0.002 && Math.abs( s.z ) < 0.002;

{
	const nose = at( { stir: 1.4, age: 0, lat: 0, rate: 21 } );
	need( 'a brand-new stamp on the track is silent — no ruler through the nose',
		quiet( nose ),
		`foam ${ nose.foam.toFixed( 3 ) } h ${ nose.h.toFixed( 3 ) } z ${ nose.z.toFixed( 3 ) }` );
}

{
	const slab = at( { stir: 1.4, age: 0, lat: 40, rate: 21 } );
	need( 'the same stamp far abeam is silent too — that was the 144 m line',
		quiet( slab ),
		`foam ${ slab.foam.toFixed( 3 ) } h ${ slab.h.toFixed( 3 ) } z ${ slab.z.toFixed( 3 ) }` );
}

{
	const young = at( { stir: 1.4, age: 0.06, lat: 0, rate: 21 } );
	need( 'a few frames later the snout is still quiet',
		quiet( young ),
		`foam ${ young.foam.toFixed( 3 ) } h ${ young.h.toFixed( 3 ) } z ${ young.z.toFixed( 3 ) }` );
}

{
	const age = 0.55;
	const rate = 21;
	const arm = rate * age;
	const crest = at( { stir: 1.4, age, lat: arm, rate } );
	need( 'once the arms have left the track the V has real height',
		crest.h > 0.12,
		`h ${ crest.h.toFixed( 3 ) } at lat ${ arm.toFixed( 1 ) }` );
	const track = at( { stir: 1.4, age, lat: 0, rate } );
	need( 'foam is on the track, not glued to the travelling arm',
		track.foam > 0.05 && track.foam > crest.foam * 1.15,
		`track foam ${ track.foam.toFixed( 3 ) } arm foam ${ crest.foam.toFixed( 3 ) }` );
}

{
	const far = at( { stir: 1.4, age: 0.55, lat: 80, rate: 21 } );
	need( 'far from the arms the sea stays flat',
		Math.abs( far.h ) < 0.01 && far.foam < 0.01,
		`h ${ far.h.toFixed( 3 ) } foam ${ far.foam.toFixed( 3 ) }` );
}

{
	const mid = at( { stir: 1.4, age: 0.7, lat: 0, rate: 21 } );
	need( 'the track is not a gouged groove',
		mid.h >= - 0.02,
		`h ${ mid.h.toFixed( 3 ) }` );
	const early = 0.7;
	const later = 2.2;
	const rate = 21;
	const a0 = at( { stir: 1.4, age: early, lat: rate * early, rate } );
	const a1 = at( { stir: 1.4, age: later, lat: rate * later, rate } );
	need( 'the arms leave the track — a V, not two parallel rails',
		rate * later - rate * early > 20 && a0.h > 0.2 && a1.h > 0.15,
		`early lat ${( rate * early ).toFixed( 1 )} h ${ a0.h.toFixed( 3 )}  later lat ${( rate * later ).toFixed( 1 )} h ${ a1.h.toFixed( 3 )}` );
	const left = at( { stir: 1.4, age: later, lat: 0, rate } );
	need( 'older foam stays on the track after the arms have scanned past',
		left.foam > a1.foam * 1.2 && left.foam > 0.04,
		`track foam ${ left.foam.toFixed( 3 ) } arm foam ${ a1.foam.toFixed( 3 ) }` );
	const slab = at( { stir: 1.4, age: later, lat: 0, rate } );
	need( 'the wedge stays hollow — that filled rectangle was fat arms',
		slab.h < a1.h * 0.35,
		`centre ${ slab.h.toFixed( 3 )} arm ${ a1.h.toFixed( 3 )}` );
	const wing = at( { stir: 1.4, age: 0.35, lat: 18, rate: 21 } );
	need( 'young far-lat wings stay down — those were the triangle spikes',
		Math.abs( wing.h ) < 0.04,
		`h ${ wing.h.toFixed( 3 ) } at lat 18` );
}

{
	const mid = wakeEdgeCpu( 0.5, 0.5, 0.22 );
	const wall = wakeEdgeCpu( 0.5, 0.0, 0.22 );
	need( 'the buffer centre is live and the mid-edge is dead',
		mid > 0.95 && wall < 0.001,
		`centre ${ mid.toFixed( 3 ) } wall ${ wall.toFixed( 3 ) }` );
}

{
	// A square fade is constant along a line of constant V (world Z).
	// That constant is the horizontal ruler. A circle must differ.
	const a = wakeEdgeCpu( 0.5, 0.12, 0.22 );
	const b = wakeEdgeCpu( 0.25, 0.12, 0.22 );
	need( 'a line of constant Z is not a constant fade — that was the ruler',
		Math.abs( a - b ) > 0.05,
		`mid ${ a.toFixed( 3 ) } side ${ b.toFixed( 3 ) }` );
}

{
	const reach = 144;
	need( 'abeam of the snout, near the track, the mound resets',
		wakeStampKind( { alo: - 3, lat: 2, reach, empty: false, closer: true } ) === 'near' );
	need( 'far-lat empty water is first-touched — that is the V seed',
		wakeStampKind( { alo: - 3, lat: 40, reach, empty: true, closer: false } ) === 'far' );
	need( 'far-lat that already has a record is left to age — that is the V opening',
		wakeStampKind( { alo: - 3, lat: 40, reach, empty: false, closer: false } ) === null );
	need( 'ahead of the hull is not stamped',
		wakeStampKind( { alo: 3, lat: 2, reach, empty: true, closer: true } ) === null );
	need( 'a 7.5 m corridor is not the whole write — 20 m off the track still seeds',
		wakeStampKind( { alo: - 3, lat: 20, reach, empty: true, closer: false } ) === 'far' );
}

// Analytic Kelvin gravity-wave V: tools/check-kelvin-wake.mjs.

for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}

const allOk = results.every( ( r ) => r.ok );
console.log( `\n${ allOk ? 'ALL PASS' : 'SOME FAILED' }` );
process.exit( allOk ? 0 : 1 );
