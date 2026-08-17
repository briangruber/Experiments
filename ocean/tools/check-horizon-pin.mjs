#!/usr/bin/env node
// CPU twin of the last-ring horizon pin gate. The pin stays on while the
// geometric horizon is still in (or just above) the frame, and drops only
// once a downward look has put that horizon off the top. A high camera's
// horizon sits below level; the old forward.y vs half-fov test treated it
// as horizontal and opened a black tear.
//
// applyCameraBasis is the other half of the tear: a fast look used to
// leave the sea on last frame's fwd while the sky unprojected this
// frame's yaw/pitch.

import { horizonPinAmount, horizonDip } from '../src/horizon-pin.js';
import { applyCameraBasis } from '../demo/camera.js';
import { v3 } from '../src/math.js';

let failed = 0;
const check = ( name, cond, detail = '' ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name, detail );
		failed ++;

	} else {

		console.log( 'PASS', name, detail );

	}

};

check( 'missing camFwd keeps the pin (horizon cameras, goldens)', horizonPinAmount( {}, { fov: 38 } ) === 1 );

// Default free-fly: pitch ≈ −2.6°, fov 38°. Horizon is on screen.
const horizonFwd = [ 0, Math.sin( - 0.045 ), - 1 ];
check( 'horizon look keeps the pin', horizonPinAmount( { camFwd: horizonFwd, fov: 38 }, {} ) === 1 );

check( 'a ski-height eye still pins the horizon',
	horizonPinAmount( { camFwd: horizonFwd, camPos: [ 0, 1.42, 0 ], fov: 38 }, {} ) === 1 );

check( 'an eye at the waterline drops the pin',
	horizonPinAmount( { camFwd: horizonFwd, camPos: [ 0, 0, 0 ], fov: 38 }, {} ) === 0 );

check( 'an underwater eye drops the pin',
	horizonPinAmount( { camFwd: horizonFwd, camPos: [ 0, - 2, 0 ], fov: 38 }, {} ) === 0 );

{
	const mid = horizonPinAmount( { camFwd: horizonFwd, camPos: [ 0, 0.4, 0 ], fov: 38 }, {} );
	check( 'a wading fade is partial, not a snap',
		mid > 0.3 && mid < 0.8, `pin ${ mid.toFixed( 3 ) }` );
}

// Swim follow as measured: fwd.y ≈ −0.47 (~28° down), fov 38°. Horizon off-screen.
const downFwd = [ 0, - 0.47, - 0.88 ];
check( 'swim-down look drops the pin', horizonPinAmount( { camFwd: downFwd, fov: 38 }, {} ) === 0 );

// The high-altitude case the old gate got wrong: 2 km up, looking 20° down
// at the sea. Geometric horizon is ~1.4° below level, still on the top edge
// of a 38° fov. Pin must stay, or the last ring sits short of the horizon
// and the LUT's dark below-horizon limb shows as a black tear.
const flyFwd = [ 0, - Math.sin( 20 * Math.PI / 180 ), - Math.cos( 20 * Math.PI / 180 ) ];
const flyCtx = { camFwd: flyFwd, camPos: [ 0, 2000, 0 ], fov: 38 };
const flyDip = horizonDip( flyCtx, {} );
check( 'a 2 km eye has a real horizon dip', flyDip > 0.02 && flyDip < 0.03, `dip ${ flyDip.toFixed( 4 ) } rad` );
check( 'high flight looking at the sea keeps the pin', horizonPinAmount( flyCtx, {} ) === 1 );

// Same height, looking down hard enough that the horizon is gone.
const steepFwd = [ 0, - Math.sin( 35 * Math.PI / 180 ), - Math.cos( 35 * Math.PI / 180 ) ];
check( 'high flight looking well below the horizon drops the pin',
	horizonPinAmount( { camFwd: steepFwd, camPos: [ 0, 2000, 0 ], fov: 38 }, {} ) === 0 );

// Fast pitch across the old 85%-of-half-fov threshold (~16° down at fov 38)
// used to pop the pin while the horizon was still in frame.
const oldThresholdFwd = [ 0, - Math.sin( 16 * Math.PI / 180 ), - Math.cos( 16 * Math.PI / 180 ) ];
check( 'pitching through the old half-fov threshold keeps the pin',
	horizonPinAmount( { camFwd: oldThresholdFwd, camPos: [ 0, 6, 0 ], fov: 38 }, {} ) === 1 );

// Banked look: the view centre is down enough that a centre-only test
// would drop the pin, but a rolled corner still sees the horizon.
{
	const fwd = v3(), right = v3(), up = v3();
	applyCameraBasis( 0, - 0.42, 0.6, fwd, right, up );
	const banked = {
		camFwd: fwd, camRight: right, camUp: up,
		camPos: [ 0, 6, 0 ], fov: 38, aspect: 16 / 9,
	};
	check( 'a banked look that still sees the horizon in a corner keeps the pin',
		horizonPinAmount( banked, {} ) === 1,
		`fwd.y ${ fwd[ 1 ].toFixed( 3 ) }` );
}

// Fast look: yaw/pitch change after the last basis build. Rebuilding
// from the new angles must move fwd, or the sea and sky disagree.
{
	const fwd = v3(), right = v3(), up = v3();
	applyCameraBasis( 0, - 0.045, 0, fwd, right, up );
	const oldY = fwd[ 1 ], oldX = fwd[ 0 ];
	applyCameraBasis( 0.8, - 0.25, 0, fwd, right, up );
	check( 'rebuilding the basis after a fast look updates fwd',
		Math.abs( fwd[ 0 ] - oldX ) > 0.3 && Math.abs( fwd[ 1 ] - oldY ) > 0.1,
		`Δfwd ${ Math.hypot( fwd[ 0 ] - oldX, fwd[ 1 ] - oldY ).toFixed( 3 ) }` );
	const expect = [ Math.cos( - 0.25 ) * Math.sin( 0.8 ), Math.sin( - 0.25 ), - Math.cos( - 0.25 ) * Math.cos( 0.8 ) ];
	const err = Math.hypot( fwd[ 0 ] - expect[ 0 ], fwd[ 1 ] - expect[ 1 ], fwd[ 2 ] - expect[ 2 ] );
	check( 'the rebuilt fwd matches the new yaw/pitch',
		err < 1e-6, `err ${ err.toExponential( 2 ) }` );
}

if ( failed ) {

	console.error( failed + ' horizon-pin checks failed' );
	process.exit( 1 );

}

console.log( 'horizon-pin: ok' );
