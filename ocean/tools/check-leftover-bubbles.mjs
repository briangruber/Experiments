#!/usr/bin/env node
// Leftover whitewater: splash in the air, foam on leftover after a hit.
//
//   node tools/check-leftover-bubbles.mjs

import {
	LeftoverBubbleField, leftoverBubbleAlpha, parseLeftoverBubbles,
	leftoverBubbleHull, leftoverBubbleInHull, leftoverBubbleBirthXZ,
	leftoverSplashBirthXZ, leftoverBubbleRide, leftoverBubbleDiverge,
	LEFTOVER_BUBBLE_LIFE, LEFTOVER_BUBBLE_PEEL_MAX,
} from '../src/leftover-bubbles.js';
import { RippleField } from '../src/ripple-field.js';

const TEST_DIVERGE = 1.35;
const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

{
	need( 'whitewater is off until asked',
		parseLeftoverBubbles( 0 ) === null
			&& parseLeftoverBubbles( false ) === null
			&& parseLeftoverBubbles( { on: 0 } ) === null );
	need( 'true is the shipped recipe',
		parseLeftoverBubbles( true )?.amount === 1
			&& parseLeftoverBubbles( true )?.splash === 1
			&& parseLeftoverBubbles( true )?.life === LEFTOVER_BUBBLE_LIFE );
	need( 'a number is foam amount on the defaults',
		parseLeftoverBubbles( 0.4 )?.amount === 0.4 );
	need( 'life / size / splash are live knobs',
		parseLeftoverBubbles( { life: 4, size: 0.08, splash: 0.5 } ).life === 4
			&& parseLeftoverBubbles( { size: 0.08 } ).size === 0.08
			&& parseLeftoverBubbles( { splash: 0.5 } ).splash === 0.5 );
	need( 'count is the live pool cap',
		parseLeftoverBubbles( { count: 80 } ).count === 80
			&& parseLeftoverBubbles( { max: 40 } ).count === 40 );
	const pool = new LeftoverBubbleField( { max: 3 } );
	for ( let i = 0; i < 8; i ++ ) pool.spawn( { x: i, y: 0, sea: 0, vx: 0, vz: 0 } );
	need( 'the pool will not exceed max', pool.count === 3, `n ${ pool.count }` );
	pool.setMax( 1 );
	need( 'lowering max drops the extras', pool.count === 1, `n ${ pool.count }` );
}

{
	need( 'a new speck is dark, then bright, then gone',
		leftoverBubbleAlpha( { age: 0, life: 2 } ) < 0.05
			&& leftoverBubbleAlpha( { age: 0.8, life: 2 } ) > 0.7
			&& leftoverBubbleAlpha( { age: 2, life: 2 } ) === 0 );
}

{
	const f = new LeftoverBubbleField();
	const p = f.spawn( {
		kind: 'foam', x: 1, z: - 2, sea: 0, y: 0, life: 2, size: 0.05,
		vx: 0, vz: 0,
	} );
	need( 'foam sits on the sea',
		p && p.kind === 'foam' && Math.abs( p.y ) < 1e-6 && p.floated,
		`y ${ p?.y } kind ${ p?.kind }` );
	for ( let i = 0; i < 20; i ++ ) f.step( 0.1, [], { sea: 0 } );
	need( 'it is gone after its lifetime',
		f.count === 0,
		`n ${ f.count }` );
}

{
	const f = new LeftoverBubbleField();
	const p = f.spawn( {
		kind: 'splash', x: 2, z: 2, sea: 0, y: 0.16, vy: 0, vx: 0, vz: 0, life: 2,
	} );
	need( 'splash starts in the air',
		p && p.kind === 'splash' && p.y > 0,
		`y ${ p?.y }` );
	for ( let i = 0; i < 12; i ++ ) f.step( 0.05, [], { sea: 0 } );
	need( 'splash that hits the sea becomes foam',
		f.count === 1 && f.particles[ 0 ].kind === 'foam' && Math.abs( f.particles[ 0 ].y ) < 1e-4,
		`n ${ f.count } kind ${ f.particles[ 0 ]?.kind } y ${ f.particles[ 0 ]?.y }` );
}

{
	const f = new LeftoverBubbleField();
	f.step( 0.05, [ { x: 0, z: 0, sea: 0, gain: 1, wet: 1, live: true } ], {
		amount: 0, splash: 1, speed: 5, heading: 0, sea: 0,
	} );
	need( 'a moving wet cut births splash above the water',
		f.count > 0 && f.particles.every( ( p ) => p.kind === 'splash' && p.y > - 0.01 ),
		`n ${ f.count }  kinds ${ f.particles.map( ( p ) => p.kind ).join( ',' ) }` );
}

{
	const f = new LeftoverBubbleField();
	f.step( 0.2, [ { x: 0, z: 0, sea: 0, gain: 1, wet: 1, live: true } ], {
		amount: 0, splash: 0, speed: 8, heading: 0, sea: 0,
	} );
	need( 'amount 0 and splash 0 births nothing', f.count === 0 );
	f.step( 0.2, [ { x: 0, z: 0, sea: 0, gain: 1, wet: 1, live: true } ], {
		amount: 1, splash: 1, speed: 0, heading: 0, sea: 0,
	} );
	need( 'a parked hull births nothing', f.count === 0 );
}

{
	const f = new LeftoverBubbleField();
	f.spawn( { kind: 'foam', x: 0, z: 0, sea: 0, y: 0, life: 3, vx: 0, vz: 0 } );
	for ( let i = 0; i < 6; i ++ ) f.step( 0.05, [], { sea: 0, leftoverAt: () => 0.2 } );
	need( 'a leftover crest is the sea the foam sits on',
		Math.abs( f.particles[ 0 ].y - 0.2 ) < 1e-4,
		`y ${ f.particles[ 0 ]?.y }` );
}

{
	const hull = leftoverBubbleHull( {
		pos: [ 0, 0, 0 ], heading: 0, size: { x: 3.4, y: 1.2, z: 12 },
	} );
	need( 'the deck footprint is inside the hull',
		leftoverBubbleInHull( 0, 0, hull )
			&& leftoverBubbleInHull( 1.2, 4, hull ) );
	need( 'water behind the transom is outside the hull',
		! leftoverBubbleInHull( 0, 7.2, hull ),
		`stern z 7.2 in=${ leftoverBubbleInHull( 0, 7.2, hull ) }` );
	const foamXZ = leftoverBubbleBirthXZ( hull, () => 0.5 );
	need( 'a foam birth sits behind the transom, not on the deck',
		foamXZ.z > hull.halfL && ! leftoverBubbleInHull( foamXZ.x, foamXZ.z, hull ),
		`xz ${ foamXZ.x.toFixed( 2 ) },${ foamXZ.z.toFixed( 2 ) }` );
	const splashXZ = leftoverSplashBirthXZ( hull, () => 0.1 );
	need( 'a splash birth is off the deck',
		! leftoverBubbleInHull( splashXZ.x, splashXZ.z, hull ),
		`xz ${ splashXZ.x.toFixed( 2 ) },${ splashXZ.z.toFixed( 2 ) } zone ${ splashXZ.zone }` );
	const sternSplash = leftoverSplashBirthXZ( hull, () => 0.7 );
	need( 'leftover specks use bow/stern churn, not two persistent chine rows',
		splashXZ.zone === 'bow' && sternSplash.zone === 'stern',
		`zones ${ splashXZ.zone }/${ sternSplash.zone }` );
	const f = new LeftoverBubbleField();
	for ( let i = 0; i < 12; i ++ ) {

		f.step( 0.05, [ { x: 0, z: 0, sea: 0, gain: 1, wet: 1, live: true } ], {
			amount: 1, splash: 1, speed: 6, heading: 0, sea: 0, hull,
		} );

	}
	need( 'a moving hull never births a speck on the deck',
		f.count > 0 && f.particles.every( ( p ) => ! leftoverBubbleInHull( p.x, p.z, hull ) ),
		`n ${ f.count }  onDeck ${ f.particles.filter( ( p ) => leftoverBubbleInHull( p.x, p.z, hull ) ).length }` );
}

{
	need( 'flat leftover does not shove foam',
		leftoverBubbleRide( 0, 0, 0, 4 ).vx === 0
			&& leftoverBubbleRide( 0, 0, 0, 4 ).vz === 0 );
	const plusZ = leftoverBubbleRide( 0, - 0.2, 0.4, 4 );
	need( 'a leftover face traveling +Z carries foam +Z',
		plusZ.vz > 1 && Math.abs( plusZ.vx ) < 0.05,
		`v ${ plusZ.vx.toFixed( 2 ) },${ plusZ.vz.toFixed( 2 ) }` );
	const plusX = leftoverBubbleRide( - 0.2, 0, 0.4, 4 );
	need( 'a leftover face traveling +X carries foam +X',
		plusX.vx > 1 && Math.abs( plusX.vz ) < 0.05,
		`v ${ plusX.vx.toFixed( 2 ) },${ plusX.vz.toFixed( 2 ) }` );

	const hull = leftoverBubbleHull( {
		pos: [ 0, 0, 0 ], heading: 0, size: { x: 3.4, y: 1.2, z: 12 },
	} );
	const peel = leftoverBubbleDiverge( 0.5, 8, {
		hull, openSpeed: 10, waveSpeed: 12, diverge: TEST_DIVERGE,
	} );
	need( 'floating foam has no sideways hull-frame kick by default',
		leftoverBubbleDiverge( 0.5, 8, {
			hull, openSpeed: 10, waveSpeed: 12,
		} ).vx === 0 );
	need( 'Kelvin diverge peels floating foam onto the divergent arms',
		peel.vx > 0.8 && Math.abs( peel.vz ) < 0.05,
		`peel ${ peel.vx.toFixed( 2 ) },${ peel.vz.toFixed( 2 ) }` );
	need( 'Kelvin diverge stays quiet ahead of the bow',
		leftoverBubbleDiverge( 0.5, - 8, {
			hull, openSpeed: 10, waveSpeed: 12, diverge: TEST_DIVERGE,
		} ).vx === 0 );
	// tanθ × U is metres per second of sideways drift at planing speed.
	// Uncapped it threw every speck clear of the topsides in about a
	// second, leaving two rails of foam with open water against the hull.
	{
		const fast = leftoverBubbleDiverge( 1.0, 10, {
			hull, openSpeed: 50, waveSpeed: 4.3, diverge: TEST_DIVERGE,
		} );
		need( 'the peel is bounded at planing speed — foam stays with the hull',
			Math.abs( fast.vx ) <= LEFTOVER_BUBBLE_PEEL_MAX + 1e-9,
			`v ${ fast.vx.toFixed( 2 )} m/s  cap ${ LEFTOVER_BUBBLE_PEEL_MAX }` );
		const at = ( lat ) => leftoverBubbleDiverge( lat, 10, {
			hull, openSpeed: 50, waveSpeed: 4.3, diverge: TEST_DIVERGE,
		} ).vx;
		need( 'the peel crosses the sailing line smoothly — no blown-open lane',
			Math.abs( at( 0.02 ) - at( - 0.02 ) ) < 0.3 && Math.abs( at( 0 ) ) < 0.3,
			`jump ${ Math.abs( at( 0.02 ) - at( - 0.02 ) ).toFixed( 3 )}` );
		need( 'a speck the hull has long left behind stops being steered',
			leftoverBubbleDiverge( 1.0, 900, {
				hull, openSpeed: 50, waveSpeed: 4.3, diverge: TEST_DIVERGE,
			} ).vx === 0 );
		need( 'the birth-frame helper is radial, not an infinite strip abeam',
			leftoverBubbleDiverge( 100, 8, {
				hull, openSpeed: 50, waveSpeed: 4.3, diverge: TEST_DIVERGE,
			} ).vx === 0 );
	}

	const trail = new LeftoverBubbleField();
	trail.spawn( {
		kind: 'foam', x: 0.2, z: 7.5, sea: 0, y: 0, life: 4, size: 0.05,
		vx: 0, vz: 0,
	} );
	const x0 = trail.particles[ 0 ].x;
	const z0 = trail.particles[ 0 ].z;
	for ( let i = 0; i < 30; i ++ ) {

		const turningHull = {
			...hull,
			heading: i / 29 * Math.PI,
		};
		turningHull.hx = Math.sin( turningHull.heading );
		turningHull.hz = - Math.cos( turningHull.heading );
		turningHull.rx = Math.cos( turningHull.heading );
		turningHull.rz = Math.sin( turningHull.heading );
		trail.step( 0.05, [], {
			sea: 0, hull: turningHull, openSpeed: 12, waveSpeed: 14,
			diverge: TEST_DIVERGE,
		} );

	}
	need( 'turning the live hull cannot steer foam that already settled',
		Math.hypot( trail.particles[ 0 ].x - x0, trail.particles[ 0 ].z - z0 ) < 1e-9,
		`moved ${ Math.hypot( trail.particles[ 0 ].x - x0, trail.particles[ 0 ].z - z0 ).toFixed( 4 ) } m` );
}

{
	const field = new RippleField( { size: 64, cell: 0.5, speed: 3, damping: 0.02, sponge: 8 } );
	field.splash( 0, 0, 1.2, 0.35 );
	for ( let i = 0; i < 24; i ++ ) field.step( 1 / 60 );
	const foam = new LeftoverBubbleField();
	foam.spawn( {
		kind: 'foam', x: 1.1, z: 0, y: 0, sea: 0, vx: 0, vz: 0, life: 4, size: 0.05,
	} );
	const r0 = Math.hypot( foam.particles[ 0 ].x, foam.particles[ 0 ].z );
	for ( let i = 0; i < 60; i ++ ) {

		field.step( 1 / 60 );
		foam.step( 1 / 60, [], {
			sea: 0,
			leftoverAt: ( x, z ) => field.sampleAt( x, z ),
			leftoverRide: ( x, z ) => {

				const sl = field.sampleSlopeAt( x, z );
				return leftoverBubbleRide( sl.x, sl.z, field.sampleVelAt( x, z ), field.speed );

			},
		} );

	}
	const r1 = Math.hypot( foam.particles[ 0 ].x, foam.particles[ 0 ].z );
	need( 'foam on a leftover ring spreads out with the wave',
		r1 > r0 + 0.6,
		`r ${ r0.toFixed( 2 ) } → ${ r1.toFixed( 2 ) }` );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
