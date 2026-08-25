#!/usr/bin/env node
// Duty-cycle frame cap. No GPU: the live ceiling, the skip period, and the
// "held by the cap" mark that stops adaptive quality from dropping the picture
// when we intentionally run at 30 on battery against a targetFps of 60.
//
//   node tools/check-fps-cap.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveFpsCap, fpsCappedOut, shouldSkipFrame } from '../src/fps-cap.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const ABYSSAL = readFileSync( join( ROOT, 'src/gpu/abyssal.js' ), 'utf8' );
const RIDE = readFileSync( join( ROOT, 'demo/three-main.js' ), 'utf8' );

let failed = 0;
const check = ( name, cond, detail = '' ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name, detail );
		failed ++;

	} else {

		console.log( 'PASS', name, detail );

	}

};

const P = { fpsCap: 60, fpsCapIdle: 10, fpsCapBattery: 30 };

check( '0 is uncapped even unfocused and unplugged',
	liveFpsCap( { ...P, fpsCap: 0 }, { focused: false, charging: false } ) === 0 );

check( 'focused + plugged uses fpsCap',
	liveFpsCap( P, { focused: true, charging: true } ) === 60 );

check( 'idle takes the tighter ceiling',
	liveFpsCap( P, { focused: false, charging: true } ) === 10 );

check( 'battery takes the tighter ceiling',
	liveFpsCap( P, { focused: true, charging: false } ) === 30 );

check( 'idle + battery uses the tighter of the two',
	liveFpsCap( P, { focused: false, charging: false } ) === 10 );

check( 'a lower fpsCap is not raised by the battery knob',
	liveFpsCap( { ...P, fpsCap: 24 }, { focused: true, charging: false } ) === 24 );

check( 'battery 0 leaves the plugged-in cap',
	liveFpsCap( { ...P, fpsCapBattery: 0 }, { focused: true, charging: false } ) === 60 );

// Skip: a 60-on-60 refresh must present, not land the wrong side of vsync.
check( 'uncapped never skips', shouldSkipFrame( 1000, 1000, 0 ) === false );
check( 'first present after a long gap is kept',
	shouldSkipFrame( 1000, 0, 60 ) === false );
check( 'a 120 Hz tick under a 60 cap is skipped',
	shouldSkipFrame( 1008.3, 1000, 60 ) === true );
check( 'the next 60 Hz slot is presented',
	shouldSkipFrame( 1016.7, 1000, 60 ) === false );
check( 'a cap equal to the refresh is not halved',
	shouldSkipFrame( 1000 + 1000 / 60, 1000, 60 ) === false );

// Adaptive quality keys off targetFps. A 30 fps battery hold against a
// target of 60 looks "too slow" unless the live cap marks it held.
const batteryCap = liveFpsCap( P, { focused: true, charging: false } );
const wouldDrop = ( fps, target ) => fps < target * 0.9;
check( '30 fps vs target 60 would look slow', wouldDrop( 30, 60 ) === true );
check( 'but the live battery cap marks 30 as held',
	fpsCappedOut( 30, batteryCap ) === true );
check( 'a real miss under the live cap is not marked held',
	fpsCappedOut( 20, batteryCap ) === false );
check( 'uncapped never claims to be holding',
	fpsCappedOut( 120, 0 ) === false );

check( 'createAbyssal skips at the live cap — not the display refresh',
	ABYSSAL.includes( 'shouldSkipFrame' )
		&& ABYSSAL.includes( 'lastPresent' )
		&& ABYSSAL.includes( 'liveCap()' ) );
check( 'the ride demo skips at the live cap',
	RIDE.includes( 'shouldSkipFrame' ) && RIDE.includes( 'shouldSkip(' ) );
check( 'GPU timestamps do not pile while a resolve is in flight',
	ABYSSAL.includes( 'function armGpuTimers' )
		&& ABYSSAL.includes( 'gpuResolveBusy' )
		&& RIDE.includes( 'function armGpuTimers' ) );

if ( failed ) {

	console.error( `\n${ failed } check(s) failed` );
	process.exit( 1 );

}

console.log( '\nall fps-cap checks passed' );
