#!/usr/bin/env node
// Does placeBreachEmitters put spray on the waterline where a mesh actually
// pierces, and never on the underwater gap between two distant fins?
//
//   node tools/check-breach-emitters.mjs
//
// Pure CPU, no GPU and no browser. The profile is a synthetic animal with the
// shape that made the old single-emitter hop fail: a head out of the water, a
// neck that dips under, a dorsal fin out again. If the placer averages those
// two stretches, every site lands on the neck - which is exactly where spray
// must not come from.

import { placeBreachEmitters, MAX_BREACH_EMITTERS } from '../src/breach-emitters.js';

const need = ( cond, msg ) => {

	if ( ! cond ) {

		console.error( 'FAIL  ' + msg );
		process.exit( 1 );

	}

};

const bins = 48;
const minZ = - 26, maxZ = 26;
const top = new Float32Array( bins );
const half = new Float32Array( bins );
const step = ( maxZ - minZ ) / bins;
// Head around local Z = -18 (tall), neck around 0 (under), fin around +10 (tall).
for ( let b = 0; b < bins; b ++ ) {

	const z = minZ + step * ( b + 0.5 );
	const head = Math.exp( - ( ( ( z + 18 ) / 4 ) ** 2 ) ) * 7;
	const fin = Math.exp( - ( ( ( z - 10 ) / 3 ) ** 2 ) ) * 5;
	const belly = 1.2;
	top[ b ] = Math.max( head, fin, belly );
	half[ b ] = 1.5 + ( fin > head ? 0.4 : 1.2 );

}

const stations = { minZ, maxZ, top, half };
const origin = [ 100, - 2.0, - 40 ];
const heading = Math.PI / 2;   // looking down +X
const seaLevel = 0;

const placed = placeBreachEmitters( stations, {
	origin, heading, pitch: 0, seaLevel, count: 6,
} );

need( placed.runs.length === 2, `expected 2 breach runs, got ${ placed.runs.length }` );
need( placed.sites.length === 6, `expected 6 sites, got ${ placed.sites.length }` );
need( placed.sites.length <= MAX_BREACH_EMITTERS, 'site count exceeds the shader cap' );

// Every site at the waterline, on the animal, and NOT in the neck gap.
const neckLo = - 8, neckHi = 4;
let port = 0, starboard = 0;
let minAlong = Infinity, maxAlong = - Infinity;
for ( const s of placed.sites ) {

	need( Math.abs( s.y - seaLevel ) < 1e-6, `site y ${ s.y } is not at sea level` );
	// Along-body: local Z from the world offset. heading π/2 →
	// wx = ox - 1*z + 0*side*hw  ⇒  z = ox - wx
	const along = origin[ 0 ] - s.x;
	need( along < neckLo || along > neckHi,
		`site at local Z ${ along.toFixed( 2 ) } landed in the underwater neck` );
	need( Math.hypot( s.x - origin[ 0 ], s.z - origin[ 2 ] ) < 30,
		`site drifted off the animal (${ s.x }, ${ s.z })` );
	if ( s.side > 0 ) port ++; else starboard ++;
	if ( along < minAlong ) minAlong = along;
	if ( along > maxAlong ) maxAlong = along;

}

need( port >= 1 && starboard >= 1, `expected both flanks, got port=${ port } starboard=${ starboard }` );
need( maxAlong - minAlong > 15, `sites are stacked, span only ${ ( maxAlong - minAlong ).toFixed( 2 ) } m` );
const crosses = placed.sites.filter( ( s ) => s.kind === 'cross' );
need( crosses.length >= 2, `expected pierce crossings, got ${ crosses.length } (${ placed.sites.map( ( s ) => s.kind ).join( ',' ) })` );
need( placed.wake && placed.fore && placed.runs.length === 2, 'wake span missing on a two-run body' );
const runEnds = placed.runs.flatMap( ( r ) => [ r.lo, r.hi ] );
need( runEnds.some( ( z ) => Math.abs( z - placed.wake.along ) < 0.6 ),
	`aft wake along ${ placed.wake.along } is not a run end (${ runEnds })` );
need( runEnds.some( ( z ) => Math.abs( z - placed.fore.along ) < 0.6 ),
	`fore wake along ${ placed.fore.along } is not a run end (${ runEnds })` );
need( Math.abs( placed.fore.along - placed.wake.along ) > 15,
	`wake span is only ${ Math.abs( placed.fore.along - placed.wake.along ).toFixed( 2 ) } m - should cover both runs` );
need( placed.nose && placed.nose.along < placed.fore.along + 0.5,
	`anatomical nose along ${ placed.nose?.along } should sit at or ahead of the foremost run` );

const one = placeBreachEmitters( stations, {
	origin, heading, pitch: 0, seaLevel, count: 1,
} );
need( one.sites.length === 1, `count=1 should place one site, got ${ one.sites.length }` );
need( Math.abs( one.sites[ 0 ].y - seaLevel ) < 1e-6, 'count=1 site is not at sea level' );

const eight = placeBreachEmitters( stations, {
	origin, heading, pitch: 0, seaLevel, count: 99,
} );
need( eight.sites.length <= MAX_BREACH_EMITTERS,
	`count is not clamped to ${ MAX_BREACH_EMITTERS } (got ${ eight.sites.length })` );
need( eight.sites.length >= placed.sites.length,
	`a higher cap should not place fewer sites than count=6` );

// Deep body, nothing out: still one sane site at the highest station.
const deep = placeBreachEmitters( stations, {
	origin: [ 0, - 20, 0 ], heading: 0, pitch: 0, seaLevel, count: 6,
} );
need( deep.runs.length === 0, 'a deep body should have no breach runs' );
need( deep.sites.length === 1, `deep fallback should be one site, got ${ deep.sites.length }` );
need( Math.abs( deep.sites[ 0 ].y - seaLevel ) < 1e-6, 'deep fallback is not at sea level' );

// Wide underwater belly + a thin fin that actually pierces. Sites must sit
// on the fin's waterline width, not on the pectorals 8 m out.
const yBins = 8;
const finTop = new Float32Array( bins ).fill( 6 );
const finLow = new Float32Array( bins ).fill( - 4 );
const finHalf = new Float32Array( bins ).fill( 8 );
const finBand = new Float32Array( bins * yBins );
for ( let b = 0; b < bins; b ++ ) {

	for ( let yb = 0; yb < yBins; yb ++ ) {

		const y = - 4 + ( yb + 0.5 ) / yBins * 10;
		finBand[ b * yBins + yb ] = y < 1.2 ? 8 : 0.35;

	}

}
const finBody = {
	minZ, maxZ, top: finTop, low: finLow, half: finHalf, yBins, band: finBand,
};
const finPlaced = placeBreachEmitters( finBody, {
	origin: [ 0, - 2, 0 ], heading: 0, pitch: 0, seaLevel, count: 6,
} );
need( finPlaced.runs.length >= 1, 'a piercing fin should make a run' );
need( Math.abs( finPlaced.bottom + 6 ) < 1e-5,
	`posed bottom should be -6m, got ${ finPlaced.bottom }` );
need( finPlaced.sites.length >= 2, `fin should get both flanks, got ${ finPlaced.sites.length }` );
for ( const s of finPlaced.sites ) {

	need( s.half < 1.2,
		`fin site used the belly beam (${ s.half.toFixed( 2 ) }m) instead of the fin` );
	need( s.half >= 0.25, `fin site collapsed to nothing (${ s.half })` );

}

// The posed bottom is also the mound's contact gate. It must follow pitch and
// vertical translation so a raised nose cannot declare a still-submerged tail
// airborne.
const pitched = placeBreachEmitters( finBody, {
	origin: [ 0, 0, 0 ], heading: 0, pitch: 0.55, seaLevel, count: 6,
} );
need( pitched.bottom < - 10,
	`pitched body's tail should reach well below sea level, got ${ pitched.bottom.toFixed( 2 ) }` );
need( pitched.bottomZ > 8,
	`lowest station should be the dropped tail, bottomZ=${ pitched.bottomZ.toFixed( 2 ) }` );
const lifted = placeBreachEmitters( finBody, {
	origin: [ 0, - pitched.bottom + 0.25, 0 ],
	heading: 0, pitch: 0.55, seaLevel, count: 6,
} );
need( Math.abs( lifted.bottom - 0.25 ) < 1e-4,
	`lifting by the posed lower reach should clear the body, bottom=${ lifted.bottom.toFixed( 3 ) }` );

// Fully emerged mid-back: low is above the sea along the middle, only the
// enter/leave belts pierce. Sites must not land on the dry back.
const dryTop = new Float32Array( bins );
const dryLow = new Float32Array( bins );
for ( let b = 0; b < bins; b ++ ) {

	const z = minZ + step * ( b + 0.5 );
	// A mound: middle of the body is fully out (low > 0), ends still pierce.
	const mound = Math.exp( - ( ( z / 10 ) ** 2 ) ) * 5;
	dryTop[ b ] = 2 + mound;
	dryLow[ b ] = - 2 + mound;

}
const dry = placeBreachEmitters( {
	minZ, maxZ, top: dryTop, low: dryLow, half: new Float32Array( bins ).fill( 2 ),
}, {
	origin: [ 0, 0, 0 ], heading: 0, pitch: 0, seaLevel, count: 6,
} );
need( dry.runs.length >= 1, `emerged back should still have pierce belts, got ${ dry.runs.length } runs` );
for ( const s of dry.sites ) {

	need( Math.abs( s.along ) > 6,
		`site at local Z ${ s.along.toFixed( 2 ) } sat on the dry back instead of a waterline belt` );

}

// Three isolated dorsal spikes. Nose-first allocation used to spend the
// whole cap on the first spike's crossings and leave the others bare.
const spikeTop = new Float32Array( bins );
const spikeLow = new Float32Array( bins ).fill( - 2 );
const spikeHalf = new Float32Array( bins ).fill( 0.4 );
const spikeZs = [ - 16, 0, 16 ];
for ( let b = 0; b < bins; b ++ ) {

	const z = minZ + step * ( b + 0.5 );
	let t = - 0.5;
	for ( const sz of spikeZs ) {

		const g = Math.exp( - ( ( ( z - sz ) / 0.8 ) ** 2 ) ) * 4;
		if ( g > 0.2 ) t = Math.max( t, g );

	}
	spikeTop[ b ] = t;

}
const spikes = placeBreachEmitters( {
	minZ, maxZ, top: spikeTop, low: spikeLow, half: spikeHalf,
}, {
	origin: [ 0, 0, 0 ], heading: 0, pitch: 0, seaLevel, count: 6,
} );
need( spikes.runs.length === 3, `expected 3 spike runs, got ${ spikes.runs.length }` );
for ( const sz of spikeZs ) {

	need( spikes.sites.some( ( s ) => Math.abs( s.along - sz ) < 3 ),
		`no site near the spike at Z ${ sz } (sites ${ spikes.sites.map( ( s ) => s.along.toFixed( 1 ) ).join( ',' ) })` );

}

// A spike just under mean sea still counts when the spray band reaches it.
const lowSpike = placeBreachEmitters( {
	minZ, maxZ,
	top: new Float32Array( bins ).fill( 1.0 ),
	low: new Float32Array( bins ).fill( - 3 ),
	half: new Float32Array( bins ).fill( 0.4 ),
}, {
	origin: [ 0, - 1.5, 0 ], heading: 0, pitch: 0, seaLevel, count: 4, band: 1.1,
} );
need( lowSpike.runs.length >= 1,
	`spray band should count a spike 0.5 m under mean sea, got ${ lowSpike.runs.length } runs` );
const noBand = placeBreachEmitters( {
	minZ, maxZ,
	top: new Float32Array( bins ).fill( 1.0 ),
	low: new Float32Array( bins ).fill( - 3 ),
	half: new Float32Array( bins ).fill( 0.4 ),
}, {
	origin: [ 0, - 1.5, 0 ], heading: 0, pitch: 0, seaLevel, count: 4, band: 0,
} );
need( noBand.runs.length === 0, 'without a band, that same spike must not count' );

// The body-wave axis has to match creature.js. With a thick profile that
// remains piercing at both phases, up/down motion must NOT add a common
// side-to-side translation to the emitter sites. Sideways motion still should.
const waveBody = {
	minZ, maxZ,
	top: new Float32Array( bins ).fill( 5 ),
	low: new Float32Array( bins ).fill( - 5 ),
	half: new Float32Array( bins ).fill( 1 ),
};
const waveOpts = {
	origin: [ 0, 0, 0 ], heading: 0, pitch: 0, seaLevel, count: 6,
};
const phaseA = Math.PI * 0.5, phaseB = - Math.PI * 0.5;
const upA = placeBreachEmitters( waveBody, {
	...waveOpts,
	swim: { length: 52, waves: 0, amp: 0.04, phase: phaseA, axis: 'Up and down' },
} );
const upB = placeBreachEmitters( waveBody, {
	...waveOpts,
	swim: { length: 52, waves: 0, amp: 0.04, phase: phaseB, axis: 'Up and down' },
} );
need( upA.sites.length === upB.sites.length, 'up/down phases changed the stable fixture site count' );
const upShift = Math.max( ...upA.sites.map( ( s, i ) =>
	Math.hypot( s.x - upB.sites[ i ].x, s.z - upB.sites[ i ].z ) ) );
need( upShift < 1e-6,
	`up/down wave swept emitters sideways by ${ upShift.toFixed( 3 ) }m` );

const sideA = placeBreachEmitters( waveBody, {
	...waveOpts,
	swim: { length: 52, waves: 0, amp: 0.04, phase: phaseA, axis: 0 },
} );
const sideB = placeBreachEmitters( waveBody, {
	...waveOpts,
	swim: { length: 52, waves: 0, amp: 0.04, phase: phaseB, axis: 0 },
} );
const sideShift = Math.max( ...sideA.sites.map( ( s, i ) =>
	Math.hypot( s.x - sideB.sites[ i ].x, s.z - sideB.sites[ i ].z ) ) );
need( sideShift > 2,
	`sideways wave did not carry emitter sites with the mesh (${ sideShift.toFixed( 3 ) }m)` );

// Up/down still has visible work to do: it moves the profile vertically and
// therefore changes which stations actually pierce the water.
const nearSurface = {
	minZ, maxZ,
	top: new Float32Array( bins ).fill( - 0.2 ),
	low: new Float32Array( bins ).fill( - 5 ),
	half: new Float32Array( bins ).fill( 1 ),
};
const liftedWave = placeBreachEmitters( nearSurface, {
	...waveOpts,
	swim: { length: 52, waves: 0, amp: 0.04, phase: phaseB, axis: 1 },
} );
const loweredWave = placeBreachEmitters( nearSurface, {
	...waveOpts,
	swim: { length: 52, waves: 0, amp: 0.04, phase: phaseA, axis: 1 },
} );
need( liftedWave.runs.length > 0,
	'upward body-wave phase did not bring the near-surface profile through the waterline' );
need( loweredWave.runs.length === 0,
	'downward body-wave phase left a false waterline pierce' );

console.log( JSON.stringify( {
	runs: placed.runs.length,
	sites: placed.sites.length,
	span: +( maxAlong - minAlong ).toFixed( 2 ),
	port, starboard,
	halfLen: +placed.halfLen.toFixed( 3 ),
	upShift: +upShift.toFixed( 3 ),
	sideShift: +sideShift.toFixed( 3 ),
}, null, 1 ) );
console.log( 'ok' );
