// Does the bow actually pick up the way a real hull does?
//
// Sweeps the wake-physics bench yacht from a crawl to flat out and prints
// the deck angle it settles at. What we are looking for is the classic
// running-trim curve: level at displacement speed, bow at the sky over the
// hump where it is climbing its own bow wave, then settling back to a few
// degrees once it is up and planing.
//
//   node tools/probe-trim.mjs

import { BodyList } from '../src/ocean-body.js';
import { hullRunningTrim, froudeLength, wakeRegime } from '../src/wake-physics.js';

const DEG = 180 / Math.PI;
const L = 12;

console.log( 'open-water trim curve (no waves), L = ' + L + ' m\n' );
console.log( '  Fr    U m/s    kn   regime   trim°' );
for ( const Fr of [ 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.7, 0.9, 1.2, 1.6, 2.5, 4.0, 5.5 ] ) {

	const U = Fr * Math.sqrt( 9.81 * L );
	console.log(
		`  ${ Fr.toFixed( 2 ) }  ${ U.toFixed( 1 ).padStart( 6 ) }` +
		`  ${ ( U / 0.514444 ).toFixed( 0 ).padStart( 4 ) }` +
		`   ${ wakeRegime( Fr ).padEnd( 6 ) }` +
		`  ${ ( hullRunningTrim( Fr ) * DEG ).toFixed( 2 ).padStart( 6 ) }`,
	);

}

// Now through the body, on flat water, so the smoothing and the surge squat
// are in the loop too. Hold each speed until the deck stops moving.
function settle( target ) {

	const list = new BodyList();
	const boat = list.add( null, {
		mass: 82000, float: true,
		size: { x: 3.4, y: 2.4, z: L }, length: L, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.75, beam: 3.4 },
		hover: 0.05, springiness: 0.28, launch: 0.06,
		heightSmoothing: 0.22, rotationSmoothing: 0.28, rotationInfluence: 0.38,
		probeLayout: 'corners',
		topSpeed: 60, accel: 5.5, brake: 9, turnRate: 0.48, grip: 1.35,
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0; boat.steer = 0; boat.wet = true;
	boat.vel[ 2 ] = - target; boat.speed = target;
	// Throttle just enough to hold the speed, so this is steady-state trim
	// rather than the extra bow-up you get while accelerating.
	for ( let i = 0; i < 900; i ++ ) {

		boat.throttle = boat.speed < target ? 0.35 : 0;
		boat.vel[ 2 ] = - target; boat.speed = target;
		list.step( 1 / 60, { seaLevel: 0, h: 0 } );

	}
	return boat;

}

// The hole shot: what you actually watch from the helm. Bow climbs as the
// hull works up to the hump, hangs there while it drags itself over its own
// bow wave, then drops as it climbs out onto plane and levels off.
{
	const list = new BodyList();
	const boat = list.add( null, {
		mass: 82000, float: true,
		size: { x: 3.4, y: 2.4, z: L }, length: L, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.75, beam: 3.4 },
		hover: 0.05, springiness: 0.28, launch: 0.06,
		heightSmoothing: 0.22, rotationSmoothing: 0.28, rotationInfluence: 0.38,
		probeLayout: 'corners',
		topSpeed: 100 * 0.514444, accel: 5.5, brake: 9, turnRate: 0.48, grip: 1.35,
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0; boat.steer = 0; boat.wet = true;
	console.log( '\nfull-throttle hole shot from rest\n' );
	console.log( '     t     kn    Fr   regime   pitch°' );
	for ( let i = 0; i <= 60 * 14; i ++ ) {

		boat.throttle = 1;
		list.step( 1 / 60, { seaLevel: 0, h: 0 } );
		list.stepRipples( 1 / 60, {} );
		if ( i % 30 ) continue;
		const Fr = froudeLength( boat.speed, L );
		console.log(
			`  ${ ( i / 60 ).toFixed( 1 ).padStart( 4 ) }s` +
			`  ${ ( boat.speed / 0.514444 ).toFixed( 0 ).padStart( 4 ) }` +
			`  ${ Fr.toFixed( 2 ) }   ${ wakeRegime( Fr ).padEnd( 6 ) }` +
			`  ${ ( boat.pitch * DEG ).toFixed( 2 ).padStart( 6 ) }`,
		);

	}
}

console.log( '\nsteady-state deck angle on flat water (through OceanBody)\n' );
console.log( '  U m/s    kn    Fr   regime   pitch°' );
for ( const U of [ 1, 2, 4, 5.5, 6, 8, 12, 20, 35, 50 ] ) {

	const b = settle( U );
	const Fr = froudeLength( U, L );
	console.log(
		`  ${ U.toFixed( 1 ).padStart( 5 ) }  ${ ( U / 0.514444 ).toFixed( 0 ).padStart( 4 ) }` +
		`  ${ Fr.toFixed( 2 ) }   ${ wakeRegime( Fr ).padEnd( 6 ) }` +
		`  ${ ( b.pitch * DEG ).toFixed( 2 ).padStart( 6 ) }`,
	);

}
