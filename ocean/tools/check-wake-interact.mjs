#!/usr/bin/env node
// Two sources, one age, two tracks — not a second wake field.
//
//   node tools/check-wake-interact.mjs

import { planWakeFrame, wakeWindowOrigin, isWetWakeSource, sourceStir, wakeFoamChurnK, jetMotionOf } from '../src/wake-interact.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const p = {
	wakeExtent: 320,
	wakeLife: 14,
	wakeArmRate: 1,
	wrTopSpeed: 20,
	wrWakeSpeed: 0.55,
	wrWakeTurn: 0.35,
	wrWakeSlip: 0.25,
};

const src = ( x, z, opts = {} ) => ( {
	active: true,
	airborne: false,
	speed: 8,
	heading: opts.heading ?? 0,
	yawRate: 0,
	slip: 0,
	hullLoad: 0.3,
	impact: 0,
	wake: opts.wake ?? true,
	surfXZ: () => [ x, z ],
	...opts,
} );

{
	const a = src( 0, 0 );
	const b = src( 12, - 4, { heading: 0.4 } );
	const planned = planWakeFrame( 1 / 30, p, [ a, b ], { size: 512, origin: [ 0, 0 ] } );
	need( 'two wet hulls produce two stamps',
		planned.stamps.length === 2,
		`n ${ planned.stamps.length }` );
	need( 'the field ages once — only the first stamp carries dt',
		planned.stamps[ 0 ].dt > 0 && planned.stamps[ 1 ].dt === 0,
		`dt ${ planned.stamps.map( ( s ) => s.dt.toFixed( 4 ) ).join( ', ' ) }` );
	need( 'both tracks are live (stir on each stamp)',
		planned.stamps[ 0 ].stir > 0.05 && planned.stamps[ 1 ].stir > 0.05,
		`stir ${ planned.stamps.map( ( s ) => s.stir.toFixed( 3 ) ).join( ', ' ) }` );
	need( 'the window sits on the centroid, not on either hull',
		planned.follow === 'centroid'
			&& Math.abs( planned.origin[ 0 ] - 6 ) < 2
			&& Math.abs( planned.origin[ 1 ] + 2 ) < 2,
		`follow ${ planned.follow } origin ${ planned.origin.map( ( v ) => v.toFixed( 2 ) ).join( ',' ) }` );
}

{
	const ski = src( 10, 0 );
	const dragon = src( 80, 40, { wake: false } );
	need( 'a wake:false body is not a wet source',
		isWetWakeSource( dragon ) === false && isWetWakeSource( ski ) === true,
		`dragon ${ isWetWakeSource( dragon ) } ski ${ isWetWakeSource( ski ) }` );
	const win = wakeWindowOrigin( [ ski, dragon ], { texel: 320 / 512, prevOrigin: [ 0, 0 ] } );
	need( 'the window follows the wake body, never the no-wake body',
		win.follow === 'centroid' && win.wet.length === 1
			&& Math.abs( win.origin[ 0 ] - 10 ) < 2 && Math.abs( win.origin[ 1 ] ) < 2,
		`follow ${ win.follow } n ${ win.wet.length } origin ${ win.origin.map( ( v ) => v.toFixed( 2 ) ).join( ',' ) }` );
	const planned = planWakeFrame( 1 / 30, p, [ ski, dragon ], { size: 512, origin: [ 0, 0 ] } );
	need( 'the no-wake body does not add a stamp',
		planned.stamps.length === 1,
		`n ${ planned.stamps.length }` );
}

{
	const onlyDragon = src( 80, 40, { wake: false, active: true } );
	const win = wakeWindowOrigin( [ onlyDragon ], {
		camera: [ 2, - 3 ], texel: 1, prevOrigin: [ 10, 10 ], hadWet: true,
	} );
	need( 'after a real track, a no-wake body does not yank the window to itself or the camera',
		win.follow === 'hold' && win.origin[ 0 ] === 10 && win.origin[ 1 ] === 10,
		`follow ${ win.follow } origin ${ win.origin }` );
}

{
	const win = wakeWindowOrigin( [], { camera: [ 15, - 8 ], texel: 1, hadWet: false } );
	need( 'with no track yet the window may follow the camera',
		win.follow === 'camera' && Math.abs( win.origin[ 0 ] - 15 ) < 0.01,
		`follow ${ win.follow } origin ${ win.origin }` );
}

{
	const flying = src( 0, 0, { airborne: true, impact: 0, speed: 14 } );
	need( 'an airborne hull with no impact does not stamp',
		isWetWakeSource( flying ) === false,
		`${ isWetWakeSource( flying ) }` );
	need( 'its stir is zero so a jump leaves a gap',
		sourceStir( flying, p ) === 0,
		`stir ${ sourceStir( flying, p ) }` );
	const leapWin = wakeWindowOrigin( [ flying ], {
		camera: [ 99, 99 ], texel: 1, prevOrigin: [ 10, 10 ], hadWet: true,
	} );
	need( 'an airborne hull still keeps the foam window on itself mid-jump',
		leapWin.follow === 'hold' && leapWin.wet.length === 0
			&& Math.abs( leapWin.origin[ 0 ] ) < 0.01 && Math.abs( leapWin.origin[ 1 ] ) < 0.01,
		`follow ${ leapWin.follow } origin ${ leapWin.origin } wet ${ leapWin.wet.length }` );
}

{
	const parked = sourceStir( src( 0, 0, { speed: 0, hullLoad: 0 } ), p );
	const cruise = sourceStir( src( 0, 0, { speed: 8, hullLoad: 0 } ), p );
	const carve = sourceStir( src( 0, 0, {
		speed: 8, yawRate: 0.9, slip: 0.7, hullLoad: 4,
	} ), p );
	const slam = sourceStir( src( 0, 0, { speed: 8, impact: 0.8 } ), p );
	need( 'stern foam follows motion dynamics: parked is dry, cruise < carve / impact',
		parked === 0 && cruise > 0.1 && carve > cruise + 0.3 && slam > cruise + 0.3,
		`park ${ parked.toFixed( 3 ) } cruise ${ cruise.toFixed( 3 ) } carve ${ carve.toFixed( 3 ) } slam ${ slam.toFixed( 3 ) }` );
	const crawl = sourceStir( src( 0, 0, { speed: 1.2, hullLoad: 0 } ), p );
	need( 'a crawl still lays leftover foam',
		crawl > 0.15 && crawl < cruise,
		`crawl ${ crawl.toFixed( 3 ) } cruise ${ cruise.toFixed( 3 ) }` );
	need( 'foam churn stays dry when parked',
		wakeFoamChurnK( 0 ) === 0 && wakeFoamChurnK( 0.2 ) === 0 );
	need( 'foam churn fills with speed toward a ceiling',
		wakeFoamChurnK( 3, 14 ) > 0.05
			&& wakeFoamChurnK( 3, 14 ) < wakeFoamChurnK( 10, 14 )
			&& wakeFoamChurnK( 20, 14 ) > 0.95,
		`slow ${ wakeFoamChurnK( 3, 14 ).toFixed( 3 ) } mid ${ wakeFoamChurnK( 10, 14 ).toFixed( 3 ) }` );
	const slowStamp = planWakeFrame( 1 / 30, p, [
		src( 0, 0, { speed: 2, topSpeed: 14, wakeCfg: { foam: 1, motor: 1.2 } } ),
	], { size: 512, origin: [ 0, 0 ] } ).stamps[ 0 ];
	const fastStamp = planWakeFrame( 1 / 30, p, [
		src( 0, 0, { speed: 14, topSpeed: 14, wakeCfg: { foam: 1, motor: 1.2 } } ),
	], { size: 512, origin: [ 0, 0 ] } ).stamps[ 0 ];
	need( 'foam ribbon and motor are maxes filled by speed on the stamp',
		slowStamp.gain < fastStamp.gain * 0.55
			&& slowStamp.motor < fastStamp.motor * 0.55
			&& fastStamp.gain > 1.4
			&& Math.abs( fastStamp.motor - 1.2 ) < 0.05,
		`slow g/m ${ slowStamp.gain.toFixed( 3 ) }/${ slowStamp.motor.toFixed( 3 ) } fast ${ fastStamp.gain.toFixed( 3 ) }/${ fastStamp.motor.toFixed( 3 ) }` );
	const jetStamp = planWakeFrame( 1 / 30, p, [
		src( 0, 0, {
			speed: 14, topSpeed: 14,
			wakeCfg: { foam: 1, motor: 0.4, jet: { amount: 0.4, width: 0.28, reach: 7 } },
		} ),
	], { size: 512, origin: [ 0, 0 ] } ).stamps[ 0 ];
	need( 'jet width and reach ride the stamp',
		jetStamp.jetWidth === 0.28 && jetStamp.jetReach === 7
			&& Math.abs( jetStamp.motor - 0.4 ) < 0.05,
		`w ${ jetStamp.jetWidth } reach ${ jetStamp.jetReach } m ${ jetStamp.motor?.toFixed?.( 3 ) }` );
	const jetCruise = jetMotionOf( { speed: 14, topSpeed: 14 } );
	const punch = jetMotionOf( { speed: 14, topSpeed: 14, fwdAccel: 6 } );
	const brake = jetMotionOf( { speed: 14, topSpeed: 14, fwdAccel: - 8 } );
	const jetCarve = jetMotionOf( { speed: 14, topSpeed: 14, yawRate: 0.7, length: 12 } );
	need( 'jet motion matches churn on a steady cruise, then punch / turn raise it',
		Math.abs( jetCruise.work - jetCruise.churnK ) < 1e-6
			&& punch.work > jetCruise.work * 1.15
			&& brake.work < jetCruise.work * 0.85
			&& jetCarve.work > jetCruise.work
			&& Math.abs( jetCruise.steer ) < 0.05
			&& Math.abs( jetCarve.steer ) > 0.35,
		`cruise ${ jetCruise.work.toFixed( 3 ) } punch ${ punch.work.toFixed( 3 ) } brake ${ brake.work.toFixed( 3 ) } carve ${ jetCarve.work.toFixed( 3 ) }` );
	need( 'a parked hull has no jet motion',
		jetMotionOf( { speed: 0, topSpeed: 14 } ).work === 0 );
}

{
	const a = src( - 6, 2 );
	const b = src( 6, 2 );
	const planned = planWakeFrame( 1 / 30, p, [ a, b ], { size: 512, origin: [ 0, 0 ] } );
	const nearA = planned.stamps.filter( ( s ) => Math.hypot( s.b[ 0 ] + 6, s.b[ 1 ] - 2 ) < 0.2 );
	const nearB = planned.stamps.filter( ( s ) => Math.hypot( s.b[ 0 ] - 6, s.b[ 1 ] - 2 ) < 0.2 );
	need( 'each hull keeps its own track in the same plan (two sites, one field)',
		nearA.length === 1 && nearB.length === 1,
		`A ${ nearA.length } B ${ nearB.length }` );
}

{
	const short = src( 0, 0, { life: 4, wakeArmRate: 2, stampB: [ 0, 1.2 ] } );
	const planned = planWakeFrame( 1 / 30, p, [ short ], { size: 512, origin: [ 0, 0 ] } );
	need( 'a source can lay a shorter life than the global wakeLife',
		planned.stamps[ 0 ].life === 4,
		`life ${ planned.stamps[ 0 ]?.life }` );
	need( 'and its own arm rate (wider / tighter V)',
		planned.stamps[ 0 ].rate > 0.3536 * 8 * 1.5,
		`rate ${ planned.stamps[ 0 ]?.rate?.toFixed?.( 3 ) }` );
	need( 'stampB is the station that is written, not surfXZ',
		planned.stamps[ 0 ].b[ 1 ] === 1.2,
		`b ${ planned.stamps[ 0 ]?.b }` );
}

{
	const sticky = src( 0, 0, { wakeCfg: { persist: 2.5, foam: 0.2, beam: 1.2 } } );
	const planned = planWakeFrame( 1 / 30, p, [ sticky ], { size: 512, origin: [ 0, 0 ] } );
	need( 'a body persist rides on the stamp for the shared foam field',
		planned.stamps[ 0 ].persist === 2.5,
		`persist ${ planned.stamps[ 0 ]?.persist }` );
}

{
	const yawing = src( 0, 0, { yawRate: 0.55 } );
	const planned = planWakeFrame( 1 / 30, p, [ yawing ], { size: 512, origin: [ 0, 0 ] } );
	need( 'a yawing hull carries yawRate on the foam stamp',
		planned.stamps[ 0 ].yawRate === 0.55,
		`yaw ${ planned.stamps[ 0 ]?.yawRate }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name}${ r.detail ? ` — ${ r.detail }` : '' }` );

}

if ( failed.length ) {

	console.error( `\n${ failed.length } failed` );
	process.exit( 1 );

}

console.log( `\n${ results.length } ok` );
