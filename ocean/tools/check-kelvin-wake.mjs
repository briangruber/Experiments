#!/usr/bin/env node
// CPU twin of the analytic Kelvin wake (src/kelvin-wake.js).
// First-principles claims from Wikipedia's Wake (physics) page:
//   a chevron at arcsin(1/3), feathery oscillating wavelets (not tubes),
//   1/√r decay, high-Fr narrowing, nothing ahead of the source.
//
//   node tools/check-kelvin-wake.mjs

import {
	kelvinWakeAt, kelvinTan, kelvinLambda, KELVIN_TAN, KELVIN_G, KELVIN_REF_M,
} from '../src/kelvin-wake.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const u = {
	head: [ 0, 0 ],
	fwd: [ 0, - 1 ],
	speed: 10,
	length: 60,
	amp: 0.85,
	decay: 140,
	foam: 0.4,
	strength: 1,
};

// fwd = (0, -1): +Z is aft. behind(along, lat) is `along` metres behind the snout.
const behind = ( along, lat ) => kelvinWakeAt( { x: lat, z: along }, u );

{
	const nose = behind( 0.2, 0 );
	need( 'ahead of / on the source is silent — a wake is what is behind you',
		Math.abs( nose.h ) < 0.002 && nose.foam < 0.002,
		`h ${ nose.h.toFixed( 3 ) }` );
}

{
	const tanW = kelvinTan( u.speed, u.length );
	need( 'at cruise Fr the wedge is the classical Kelvin angle',
		Math.abs( tanW - KELVIN_TAN ) < 1e-6,
		`tan ${ tanW.toFixed( 4 )}  Kelvin ${ KELVIN_TAN.toFixed( 4 )}` );
	const Fr = u.speed / Math.sqrt( KELVIN_G * u.length );
	need( 'cruise Fr is below the high-speed pinch',
		Fr < 0.6,
		`Fr ${ Fr.toFixed( 3 ) }` );
}

{
	const alo = 40;
	const arm = alo * KELVIN_TAN;
	const onArm = behind( alo, arm );
	const offOut = behind( alo, arm + 14 );
	const ahead = kelvinWakeAt( { x: 0, z: - 8 }, u );
	need( 'the arm carries real surface displacement',
		Math.abs( onArm.h ) > 0.08,
		`h ${ onArm.h.toFixed( 3 ) } at lat ${ arm.toFixed( 1 ) }` );
	need( 'outside the wedge the sea is flat — evanescent, not a painted stripe',
		Math.abs( offOut.h ) < Math.abs( onArm.h ) * 0.15,
		`arm ${ onArm.h.toFixed( 3 )}  outside ${ offOut.h.toFixed( 3 )}` );
	need( 'in front of the snout stays flat',
		Math.abs( ahead.h ) < 0.002,
		`h ${ ahead.h.toFixed( 3 ) }` );
}

{
	// Diverging wavelength along the arm ≈ 0.65 λ_t, λ_t = 2π U²/g.
	const lambdaT = 2 * Math.PI * u.speed * u.speed / KELVIN_G;
	const lambdaArm = 0.65 * lambdaT;
	const alo = 36;
	const arm = alo * KELVIN_TAN;
	const a = behind( alo, arm );
	const b = behind( alo + lambdaArm * 0.5, ( alo + lambdaArm * 0.5 ) * KELVIN_TAN );
	need( 'height changes sign along the arm — a wave, not a tube',
		a.h * b.h < 0 && Math.abs( a.h ) > 0.04 && Math.abs( b.h ) > 0.04,
		`h(36) ${ a.h.toFixed( 3 )}  h(+½λ) ${ b.h.toFixed( 3 )}` );
}

{
	const mid = behind( 40, 0 );
	need( 'the interior has transverse waves — the wedge is not a hollow groove',
		Math.abs( mid.h ) > 0.01,
		`centreline h ${ mid.h.toFixed( 3 ) }` );
}

{
	// Compare peak |h| over a wavelength, not a point — a zero-crossing
	// at the reference station is not "no decay".
	const peak = ( alo0, span ) => {

		let m = 0;
		for ( let i = 0; i <= 16; i ++ ) {

			const alo = alo0 + span * i / 16;
			m = Math.max( m, Math.abs( behind( alo, alo * KELVIN_TAN ).h ) );

		}
		return m;

	};
	const near = peak( 20, 40 );
	const far = peak( 100, 40 );
	need( 'amplitude dies with distance — 1/√r plus friction, not a constant tube',
		far < near * 0.75 && far > 0.02,
		`peak |h| at 20–60 m ${ near.toFixed( 3 )}  at 100–140 m ${ far.toFixed( 3 )}` );
}

{
	const alo = 40;
	const arm = alo * KELVIN_TAN;
	const crest = behind( alo, arm );
	const offset = behind( alo, arm + 3 );
	need( 'the face has width — dispersion, not a 1-pixel wire',
		Math.abs( offset.h ) > Math.abs( crest.h ) * 0.15,
		`crest ${ crest.h.toFixed( 3 )}  +3 m ${ offset.h.toFixed( 3 )}` );
}

{
	const fast = { ...u, speed: 40 };
	const tanFast = kelvinTan( fast.speed, fast.length );
	need( 'a ski keeps the textbook 19.47° V at planing speed',
		Math.abs( kelvinTan( 44, 2.4 ) - KELVIN_TAN ) < 1e-9,
		`tan ${ kelvinTan( 44, 2.4 ).toFixed( 4 ) }` );
	need( 'high Fr pinches the V inside the classical Kelvin angle',
		tanFast < KELVIN_TAN * 0.85,
		`tan ${ tanFast.toFixed( 4 )}  Kelvin ${ KELVIN_TAN.toFixed( 4 )}` );
	const alo = 80;
	const peakAt = ( tan ) => {

		let m = 0;
		for ( let i = 0; i <= 12; i ++ ) {

			const a = alo + 30 * i / 12;
			m = Math.max( m, Math.abs( kelvinWakeAt( { x: a * tan, z: a }, fast ).h ) );

		}
		return m;

	};
	const classical = peakAt( KELVIN_TAN );
	const pinched = peakAt( tanFast );
	need( 'at speed the energy sits on the narrower arm, not the old 19.47° ray',
		pinched > classical * 1.2,
		`narrow ${ pinched.toFixed( 3 )}  classical-ray ${ classical.toFixed( 3 )}` );
}

{
	const alo = 40;
	const arm = behind( alo, alo * KELVIN_TAN );
	const mid = behind( alo, 0 );
	need( 'foam lives on the arms, not as a filled rectangle down the track',
		arm.foam > mid.foam + 0.02 || ( arm.foam > 0.02 && mid.foam < arm.foam * 0.6 ),
		`arm foam ${ arm.foam.toFixed( 3 )}  centre ${ mid.foam.toFixed( 3 )}` );
}

{
	const off = kelvinWakeAt( { x: 0, z: 40 }, { ...u, strength: 0 } );
	need( 'strength 0 is no wake',
		Math.abs( off.h ) < 1e-6 && off.foam < 1e-6 );
	const parked = kelvinWakeAt( { x: 0, z: 40 }, { ...u, speed: 0.2 } );
	need( 'a parked body writes no gravity-wave V',
		Math.abs( parked.h ) < 1e-6 );
}

{
	const maxFoam = ( width, extra ) => {

		let m = 0;
		for ( let alo = 16; alo <= 48; alo += 2 ) {

			const lat = extra + alo * KELVIN_TAN;
			m = Math.max( m, kelvinWakeAt( { x: lat, z: alo }, { ...u, width } ).foam );

		}
		return m;

	};
	const pinOnPin = maxFoam( 0, 0 );
	const pinOnBeam = maxFoam( 0, 8 );
	const beamOnPin = maxFoam( 16, 0 );
	const beamOnBeam = maxFoam( 16, 8 );
	need( 'a starting width opens the V from a beam, not a pin',
		beamOnBeam > beamOnPin * 1.25 && pinOnPin > pinOnBeam,
		`width 0: pin ${ pinOnPin.toFixed( 3 )} beam-ray ${ pinOnBeam.toFixed( 3 )}  width 16: pin-ray ${ beamOnPin.toFixed( 3 )} beam ${ beamOnBeam.toFixed( 3 )}` );
}

{
	const phys = 2 * Math.PI * u.speed * u.speed / KELVIN_G;
	need( 'a ship keeps the physical gravity-wave length',
		Math.abs( kelvinLambda( u.speed, 60 ) - phys ) < 1e-9,
		`λ ${ kelvinLambda( u.speed, 60 ).toFixed( 2 ) }` );
	need( 'a ski-scale body does not draw a 64 m swell',
		kelvinLambda( 10, 3 ) < 20 && kelvinLambda( 10, 3 ) > 8,
		`λ ${ kelvinLambda( 10, 3 ).toFixed( 2 ) }` );
}

{
	const small = { ...u, length: 3, cut: 0, width: 1.2 };
	const lam = kelvinLambda( small.speed, small.length );
	const tanW = kelvinTan( small.speed, small.length );
	const beam = 0.6;
	const a = kelvinWakeAt( { x: beam + 14 * tanW, z: 14 }, small );
	const b = kelvinWakeAt( { x: beam + ( 14 + lam * 0.45 ) * tanW, z: 14 + lam * 0.45 }, small );
	need( 'ski-scale arms still change sign — wavelets, not a tube',
		a.h * b.h < 0 && Math.abs( a.h ) > 0.02 && Math.abs( b.h ) > 0.02,
		`h(14) ${ a.h.toFixed( 3 )}  h(+0.45λ) ${ b.h.toFixed( 3 )}` );
}

{
	const cutU = { ...u, cut: 0.8, width: 2 };
	const mid = kelvinWakeAt( { x: 0, z: 40 }, cutU );
	const arm = kelvinWakeAt( { x: 40 * KELVIN_TAN, z: 40 }, cutU );
	need( 'a cut on the centerline is a trough',
		mid.h < - 0.05,
		`centre ${ mid.h.toFixed( 3 ) }` );
	need( 'the arms still carry a wave when the middle is cut',
		Math.abs( arm.h ) > 0.05,
		`arm ${ arm.h.toFixed( 3 ) }` );
}

{
	const deepTan = kelvinTan( 10, 60 );
	const shallowTan = kelvinTan( 10, 60, 12 ); // Fr_h = 10 / sqrt(9.81 * 12) = 0.922
	need( 'shallow water near critical depth opens the wake angle',
		shallowTan > deepTan * 1.5,
		`deep ${ deepTan.toFixed( 4 ) } shallow ${ shallowTan.toFixed( 4 ) }` );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}

const allOk = results.every( ( r ) => r.ok );
console.log( `\n${ allOk ? 'ALL PASS' : 'SOME FAILED' }` );
process.exit( allOk ? 0 : 1 );
