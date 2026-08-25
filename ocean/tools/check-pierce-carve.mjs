#!/usr/bin/env node
// Leftover trench behind a pole cut. No GPU, no browser.
//
//   node tools/check-pierce-carve.mjs

import {
	PierceCarveField, pierceCarveAt, pierceCarveAmp, pierceCarveSpacing,
	pierceWellStamps,
	PIERCE_CARVE_STAMPS, PIERCE_CARVE_LIFE,
} from '../src/pierce-carve.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const site = ( x, z, extra = {} ) => ( {
	x, z, r: 0.4, well: 2, speed: 8, ...extra,
} );

function hypotLen( s ) {

	return Math.hypot( ( s.bx ?? s.ax ) - s.ax, ( s.bz ?? s.az ) - s.az );

}

{
	need( 'spacing grows with speed so sixteen stamps cover about life seconds',
		pierceCarveSpacing( 45, 6, 0.8 ) > 15
		&& pierceCarveSpacing( 2, 6, 0.8 ) < 2,
		`fast ${ pierceCarveSpacing( 45, 6, 0.8 ).toFixed( 2 ) } slow ${ pierceCarveSpacing( 2, 6, 0.8 ).toFixed( 2 ) }` );
	need( 'a crawl still spaces by the pole, not by millimetres',
		pierceCarveSpacing( 0, 6, 0.8 ) >= 0.8 * 1.2 - 1e-9 );
}

{
	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0, { speed: 0 } ), { life: 6, speed: 0 } );
	need( 'a parked rod does not lay a trail — the live well is the hole',
		f.stamps.length <= 1
		&& ( ! f.stamps[ 0 ] || hypotLen( f.stamps[ 0 ] ) < 0.05 ),
		`n ${ f.stamps.length } len ${ f.stamps[ 0 ] ? hypotLen( f.stamps[ 0 ] ).toFixed( 3 ) : 0 }` );
}

{
	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0 ), { life: 6, speed: 8 } );
	for ( let i = 1; i <= 40; i ++ ) {

		f.step( 0.05, site( 0, - i * 0.4 ), { life: 6, speed: 8 } );

	}
	need( 'a moving rod writes a capsule behind itself',
		f.stamps.length >= 2,
		`n ${ f.stamps.length }` );
	const mid = pierceCarveAt( 0, - 4, f ).h;
	need( 'the leftover well is a drop, not a collar stamp',
		mid < - 0.4,
		`h ${ mid.toFixed( 3 ) }` );
	need( 'far water is uncut',
		Math.abs( pierceCarveAt( 40, 0, f ).h ) < 1e-3,
		`h ${ pierceCarveAt( 40, 0, f ).h.toFixed( 4 ) }` );
	need( 'overlapping stamps take the deeper well, they do not add',
		mid > - 2.05,
		`h ${ mid.toFixed( 3 ) }` );
}

{
	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0 ), { life: 1.2, speed: 8 } );
	for ( let i = 1; i <= 8; i ++ ) f.step( 0.05, site( 0, - i ), { life: 1.2, speed: 8 } );
	const born = pierceCarveAt( 0, - 2, f ).h;
	need( 'a fresh carve is about as deep as the well',
		born < - 1.2,
		`h ${ born.toFixed( 3 ) }` );
	for ( let i = 0; i < 40; i ++ ) f.step( 0.05, null, { life: 1.2 } );
	need( 'after life the trench is gone',
		! f.live() && Math.abs( pierceCarveAt( 0, - 2, f ).h ) < 1e-3,
		`live ${ f.live() } h ${ pierceCarveAt( 0, - 2, f ).h.toFixed( 4 ) }` );
}

{
	const f = new PierceCarveField();
	for ( let i = 0; i < 10; i ++ ) {

		f.step( 0.05, site( 0, - i * 0.5 ), { life: 0, speed: 8 } );

	}
	need( 'life 0 never lays a trail',
		f.stamps.length === 0,
		`n ${ f.stamps.length }` );
}

{
	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0 ), { life: 6, speed: 8 } );
	f.step( 0.05, site( 0, - 2 ), { life: 6, speed: 8 } );
	f.step( 0.05, site( 80, 80 ), { life: 6, speed: 8 } );
	const slash = pierceCarveAt( 40, 40, f ).h;
	need( 'a teleport does not carve a slash across the sea',
		Math.abs( slash ) < 0.05,
		`h ${ slash.toFixed( 3 ) } n ${ f.stamps.length }` );
}

{
	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0 ), { life: 4, speed: 8 } );
	for ( let i = 1; i <= 12; i ++ ) f.step( 0.05, site( 0, - i * 0.5 ), { life: 4, speed: 8 } );
	const n = f.stamps.length;
	f.step( 0.05, null, { life: 4 } );
	need( 'lifting the rod leaves the leftover trench to fade on its own',
		f.stamps.length === n && pierceCarveAt( 0, - 3, f ).h < - 0.2,
		`n ${ f.stamps.length } was ${ n } h ${ pierceCarveAt( 0, - 3, f ).h.toFixed( 3 ) }` );
}

{
	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0, { well: 1.4 } ), { life: 6, speed: 8 } );
	need( 'amp is the well on a newborn open stamp',
		Math.abs( pierceCarveAmp( f.stamps[ 0 ] ) - 1.4 ) < 1e-9 );
	need( 'the cap is sixteen stamps, the same as the other leftover fields',
		PIERCE_CARVE_STAMPS === 16 && PIERCE_CARVE_LIFE === 6 );
}

{
	const live = pierceWellStamps(
		{ x: 2, z: - 1, y: - 4, r: 0.8, well: 4 },
		null,
		0,
	);
	need( 'life 0 still poses a live well cylinder down to the rod base',
		live.length === 1
		&& Math.abs( live[ 0 ].ax - 2 ) < 1e-9
		&& Math.abs( live[ 0 ].yBot + 4 ) < 1e-9
		&& Math.abs( live[ 0 ].yTop ) < 1e-9
		&& Math.abs( live[ 0 ].bx - live[ 0 ].ax ) < 1e-9,
		`n ${ live.length } yBot ${ live[ 0 ]?.yBot }` );

	const f = new PierceCarveField();
	f.step( 0.05, site( 0, 0 ), { life: 6, speed: 8 } );
	for ( let i = 1; i <= 20; i ++ ) f.step( 0.05, site( 0, - i * 0.4 ), { life: 6, speed: 8 } );
	const walls = pierceWellStamps(
		{ x: 0, z: - 8, y: - 2, r: 0.4, well: 2 },
		f,
		0,
	);
	need( 'a moving rod poses leftover stadiums, not only the live circle',
		walls.length >= 2
		&& walls.some( ( s ) => Math.hypot( s.bx - s.ax, s.bz - s.az ) > 0.3 ),
		`n ${ walls.length }` );
	need( 'an open leftover stamp is the live hole — no extra rod on top',
		walls.length === f.stamps.filter( ( s ) => pierceCarveAmp( s ) > 0.02 ).length,
		`walls ${ walls.length } stamps ${ f.stamps.length }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok ' : 'FAIL' }  ${ r.name}${ r.detail ? ` — ${ r.detail }` : '' }` );

}

if ( failed.length ) {

	console.error( `\n${ failed.length }/${ results.length } failed` );
	process.exit( 1 );

}

console.log( `\n${ results.length }/${ results.length } ok` );
