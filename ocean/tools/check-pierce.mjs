#!/usr/bin/env node
// The near field where a solid goes through the surface. No GPU, no
// browser, no server — this is the fast one, run it on every edit.
//
//   node tools/check-pierce.mjs

import {
	pierceAt, pierceAmps, pierceHead, pierceOutlineDist, pierceDraft,
	pierceScale, pierceWellAmp, pierceOccupancy, pierceWellWall,
	PIERCE_DEFAULTS, PIERCE_GRAVITY,
} from '../src/pierce.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

/** A fin, chord 1.2 m, 0.12 m thick, running −Z at `speed`. */
const fin = ( speed = 3, extra = {} ) => ( {
	x: 0, z: 0, ax: 0, az: - 1, half: 0.6, r: 0.12,
	vx: 0, vz: - speed, submerged: 1.4,
	...extra,
} );

const h = ( px, pz, u ) => pierceAt( px, pz, u ).h;

{
	need( 'the head is v² / 2g',
		Math.abs( pierceHead( 3, 99 ) - 9 / ( 2 * PIERCE_GRAVITY ) ) < 1e-9,
		`eta ${ pierceHead( 3, 99 ).toFixed( 3 ) }` );
	need( 'a cap keeps a 20 m/s body from building a 20 m wall',
		pierceHead( 20 ) === PIERCE_DEFAULTS.headCap );
	need( 'doubling speed roughly quadruples the heap',
		Math.abs( pierceAmps( fin( 4 ) ).bow / pierceAmps( fin( 2 ) ).bow - 4 ) < 1e-6,
		`ratio ${ ( pierceAmps( fin( 4 ) ).bow / pierceAmps( fin( 2 ) ).bow ).toFixed( 3 ) }` );
}

{
	const u = fin( 3 );
	const ahead = h( 0, - 1.1, u );
	const abeam = h( 1.1, 0, u );
	const astern = h( 0, 1.1, u );
	need( 'water heaps ahead of a moving pierce',
		ahead > 0.05,
		`h ${ ahead.toFixed( 3 ) }` );
	need( 'the shoulders are pulled DOWN, not up — it is cutting',
		abeam < - 0.02,
		`h ${ abeam.toFixed( 3 ) }` );
	need( 'a hollow follows astern',
		astern < - 0.05,
		`h ${ astern.toFixed( 3 ) }` );
	need( 'ahead is the tall side of the site',
		ahead > Math.abs( astern ) * 0.4 && ahead > 0,
		`ahead ${ ahead.toFixed( 3 ) } astern ${ astern.toFixed( 3 ) }` );
	need( 'far water is flat — the near field does not radiate for ever',
		Math.abs( h( 0, - 30, u ) ) < 1e-3 && Math.abs( h( 30, 0, u ) ) < 1e-3,
		`fore ${ h( 0, - 30, u ).toFixed( 4 ) } side ${ h( 30, 0, u ).toFixed( 4 ) }` );
}

{
	const slow = fin( 0.4 );
	const fast = fin( 6 );
	need( 'a crawl barely marks the surface',
		Math.abs( h( 0, - 1.1, slow ) ) < 0.05,
		`h ${ h( 0, - 1.1, slow ).toFixed( 4 ) }` );
	need( 'and the same fin at speed lifts a real heap',
		h( 0, - 1.1, fast ) > 0.2,
		`h ${ h( 0, - 1.1, fast ).toFixed( 3 ) }` );
	need( 'the hollow lengthens with speed instead of shutting at a fixed distance',
		h( 0, 4, fast ) < h( 0, 4, slow ) - 0.02,
		`fast ${ h( 0, 4, fast ).toFixed( 3 ) } slow ${ h( 0, 4, slow ).toFixed( 3 ) }` );
}

{
	const parked = fin( 0 );
	const at = h( 0.2, 0, parked );
	need( 'a parked pierce still holds a collar — displaced volume does not need motion',
		at > 0.02,
		`h ${ at.toFixed( 3 ) }` );
	need( 'but a parked pierce has no ahead / astern — nothing is flowing',
		Math.abs( h( 0, - 1.1, parked ) - h( 0, 1.1, parked ) ) < 1e-9 );
}

{
	const out = fin( 3, { submerged: 0 } );
	need( 'a fin held clear of the water disturbs nothing',
		h( 0, - 1.1, out ) === 0 && h( 0, 1.1, out ) === 0 );
	const dipping = fin( 3, { submerged: 0.12 } );
	need( 'and one just touching is a fraction of one that is properly in',
		h( 0, - 1.1, dipping ) > 0
			&& h( 0, - 1.1, dipping ) < h( 0, - 1.1, fin( 3 ) ) * 0.6,
		`tip ${ h( 0, - 1.1, dipping ).toFixed( 3 ) } in ${ h( 0, - 1.1, fin( 3 ) ).toFixed( 3 ) }` );
	need( 'draft is metres under the sea, clamped at the surface',
		pierceDraft( - 2, 0 ) === 2 && pierceDraft( 3, 0 ) === 0 );
	need( 'gain 0 is a body that does not touch the surface at all',
		h( 0, - 1.1, fin( 3, { gain: 0 } ) ) === 0 );
}

{
	// A chord is not a circle: the outline is what the field measures from.
	const blade = fin( 3, { half: 3, r: 0.1 } );
	need( 'a long chord holds the collar along its whole length',
		Math.abs( pierceOutlineDist( 0.3, 2.5, blade ) - 0.2 ) < 1e-9
			&& pierceOutlineDist( 0.3, 0, blade ) === pierceOutlineDist( 0.3, 2.5, blade ),
		`s ${ pierceOutlineDist( 0.3, 2.5, blade ).toFixed( 3 ) }` );
	need( 'past the end of the chord the distance opens up again',
		pierceOutlineDist( 0, 5, blade ) > 1.8 );
	need( 'inside the outline there is nothing to measure',
		pierceOutlineDist( 0, 0, blade ) === 0 );
	const round = fin( 3, { half: 0, r: 0.4 } );
	need( 'half 0 is a plain circular rod',
		Math.abs( pierceOutlineDist( 0, 1, round ) - 0.6 ) < 1e-9
			&& Math.abs( pierceOutlineDist( 1, 0, round ) - 0.6 ) < 1e-9 );
}

{
	// Turning the fin does not turn the flow: the outline can lie across
	// the direction of travel, which is a body slipping sideways.
	const across = fin( 3, { ax: 1, az: 0, half: 1.2 } );
	need( 'a broadside outline still heaps on the leading edge',
		h( 0, - 0.9, across ) > 0.05,
		`h ${ h( 0, - 0.9, across ).toFixed( 3 ) }` );
	need( 'and the draw-down sits off its ends, where the flow accelerates',
		h( 1.5, 0, across ) < 0,
		`h ${ h( 1.5, 0, across ).toFixed( 3 ) }` );
}

{
	// The reason reaches are multiples and not metres: the same recipe
	// has to work on a hand-sized fin and on a whale's back. A site ten
	// times the size disturbs ten times the water, at the same height.
	const small = fin( 3 );
	const big = fin( 3, { half: 6, r: 1.2 } );
	const ratio = pierceScale( big ) / pierceScale( small );
	need( 'site size is its thickness or half its chord, whichever is bigger',
		Math.abs( pierceScale( small ) - 0.3 ) < 1e-9 && Math.abs( ratio - 10 ) < 1e-9,
		`small ${ pierceScale( small ).toFixed( 2 ) } ratio ${ ratio.toFixed( 1 ) }` );
	need( 'a ten-times site holds its heap ten times further out',
		Math.abs( h( 0, - 1.1 - 0.6, small ) - h( 0, ( - 1.1 - 0.6 ) * 10, big ) ) < 0.02,
		`small ${ h( 0, - 1.7, small ).toFixed( 3 ) } big ${ h( 0, - 17, big ).toFixed( 3 ) }` );
	need( 'and it is no taller for being bigger — height is speed, not size',
		Math.abs( pierceAmps( big ).bow - pierceAmps( small ).bow ) < 1e-9 );
}

{
	const u = fin( 3 );
	const deeper = fin( 3, { trench: PIERCE_DEFAULTS.trench * 2 } );
	need( 'every term is a live knob, not a baked number',
		h( 0, 1.1, deeper ) < h( 0, 1.1, u ) - 0.02
			&& h( 0, - 1.1, fin( 3, { bow: 0 } ) ) < h( 0, - 1.1, u )
			&& h( 1.1, 0, fin( 3, { side: 0 } ) ) > h( 1.1, 0, u ),
		`trench ${ h( 0, 1.1, deeper ).toFixed( 3 ) } was ${ h( 0, 1.1, u ).toFixed( 3 ) }` );
}

{
	const rod = fin( 0, { half: 0, r: 0.4, well: 2, gain: 1, submerged: 1 } );
	need( 'inside the rod the surface drops to the base, not a collar stamp',
		Math.abs( h( 0, 0, rod ) + 2 ) < 0.05,
		`h ${ h( 0, 0, rod ).toFixed( 3 ) }` );
	need( 'occupancy is 1 on the axis and 0 just outside the rod',
		pierceOccupancy( 0, 0, rod ) > 0.98
		&& pierceOccupancy( 4, 0, rod ) < 0.02 );
	need( 'the occupancy lip is centimetres — walls are not a sea-mesh ramp',
		pierceWellWall( 0.4, 2 ) < 0.2
		&& pierceWellWall( 0.4, 2 ) > 0.03
		&& pierceOccupancy( 0.4, 0, rod ) > 0.95
		&& pierceOccupancy( 0.4 + pierceWellWall( 0.4, 2 ) * 0.5, 0, rod ) > 0.08
		&& pierceOccupancy( 0.4 + pierceWellWall( 0.4, 2 ) * 0.5, 0, rod ) < 0.92 );
	need( 'well 0 is the old near-field — the centre is not a pit',
		h( 0, 0, fin( 0, { half: 0, r: 0.4, well: 0, submerged: 1 } ) ) > 0.02 );
	need( 'gain 0 keeps the well (the steel is still there) and kills the collar',
		pierceWellAmp( { well: 4, gain: 0 } ) === 4
		&& Math.abs( h( 0, 0, fin( 0, { half: 0, r: 0.4, well: 2, gain: 0, submerged: 1 } ) ) + 2 ) < 0.05 );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok' : 'FAIL' }  ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
console.log( `${ results.length - failed.length }/${ results.length } ok` );
process.exit( failed.length ? 1 : 0 );
