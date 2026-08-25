// Is the high-speed fore/aft stutter physics, or frame ordering?
//
// Replicates the webgpu-wake-physics bench hull and drives it flat out,
// logging along-track advance per frame. Constant dt isolates the sim;
// jittered dt then shows what the camera sees when it is placed from a
// position the body has not reached yet.
//
//   node tools/probe-hull-stutter.mjs

import { BodyList } from '../src/ocean-body.js';

const KN = 0.514444;

function bench() {

	const list = new BodyList();
	const boat = list.add( null, {
		mass: 82000, float: true,
		size: { x: 3.4, y: 2.4, z: 12 },
		length: 12, beam: 3.4,
		wake: {
			on: 1, physics: 1, strength: 0.75, beam: 3.4,
			foam: 1.1, wave: 0, v: 0, kelvin: 0, cut: 0,
			emit: 4, damp: 1.8, motor: 0.4,
		},
		hover: 0.05, springiness: 0.28, launch: 0.06,
		heightSmoothing: 0.22, rotationSmoothing: 0.28, rotationInfluence: 0.38,
		probeLayout: 'corners',
		topSpeed: 100 * KN, accel: 5.5, brake: 9, turnRate: 0.48, grip: 1.35,
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0;
	boat.steer = 0;
	boat.throttle = 1;
	boat.wet = true;
	boat.airborne = false;
	boat.vel[ 2 ] = - 40;
	boat.speed = 40;
	return { list, boat };

}

/** Along-track advance per frame, in metres. */
function run( dts, label ) {

	const { list, boat } = bench();
	const adv = [];
	for ( let i = 0; i < dts.length; i ++ ) {

		const dt = dts[ i ];
		const z0 = boat.pos[ 2 ];
		boat.throttle = 1;
		list.step( dt, { seaLevel: 0 } );
		list.stepRipples( dt, {} );
		// Heading is 0 (−Z forward), so along-track advance is −Δz.
		adv.push( { d: - ( boat.pos[ 2 ] - z0 ), dt, u: boat.speed } );

	}
	const tail = adv.slice( -240 );
	const perSec = tail.map( ( a ) => a.d / a.dt );
	const lo = Math.min( ...perSec ), hi = Math.max( ...perSec );
	const back = tail.filter( ( a ) => a.d < 0 ).length;
	let worstJerk = 0;
	for ( let i = 1; i < tail.length; i ++ ) {

		worstJerk = Math.max( worstJerk, Math.abs( tail[ i ].d - tail[ i - 1 ].d ) );

	}
	console.log(
		`${ label.padEnd( 26 ) } u ${ tail[ tail.length - 1 ].u.toFixed( 1 ) } m/s` +
		`  along-track ${ lo.toFixed( 2 ) }..${ hi.toFixed( 2 ) } m/s` +
		`  reversals ${ back }` +
		`  worst frame-to-frame Δ ${ worstJerk.toFixed( 3 ) } m`,
	);
	return { list, boat, adv };

}

const N = 900;
run( Array.from( { length: N }, () => 1 / 60 ), 'steady 60 Hz' );

// Real WebGPU frame times are not a metronome.
let seed = 7;
const rnd = () => ( seed = ( seed * 1103515245 + 12345 ) % 2147483648 ) / 2147483648;
const jitter = Array.from( { length: N }, () => ( rnd() < 0.12 ? 1 / 30 : 1 / 60 ) * ( 0.8 + rnd() * 0.5 ) );
const { adv } = run( jitter, 'jittered frame times' );

// What the camera actually shows: it is placed from pos(t) but the mesh is
// drawn at pos(t + dt), so the hull sits `vel * dt` ahead of frame centre.
const tail = adv.slice( -240 );
const offs = tail.map( ( a ) => a.u * a.dt );
const oLo = Math.min( ...offs ), oHi = Math.max( ...offs );
let swing = 0;
for ( let i = 1; i < tail.length; i ++ ) swing = Math.max( swing, Math.abs( offs[ i ] - offs[ i - 1 ] ) );
console.log(
	`\ncamera-relative offset (vel × dt)  ${ oLo.toFixed( 2 ) }..${ oHi.toFixed( 2 ) } m` +
	`  worst frame-to-frame swing ${ swing.toFixed( 2 ) } m`,
);
