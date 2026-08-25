#!/usr/bin/env node
// Expanding rings from how hard and at what angle the hull hits the water.
// Each centre stays put. The crest is a full circle. Overlapping rings add.
//
//   node tools/check-wake-wave.mjs

import {
	WakeWaveField, wakeWaveAt, wakeWaveFieldAt, wakeWaveSlopeAt,
	wakeWaveContactFrom, wakeWaveContactsFrom,
	wakeWaveImpulse, wakeWaveAmp, wakeWaveWidth, wakeWaveProbeAt,
	wakeWaveGapOf, wakeWaveLifeOf,
	froudeLength, froudeDepth, froudeHumpFactor, froudeShallowResonance,
	WAKE_WAVE_STAMPS, WAKE_WAVE_PROBE_DELAY, WAKE_WAVE_PROBE_FADE,
	WAKE_WAVE_SPACING,
} from '../src/wake-wave.js';
import { BodyList, SKI } from '../src/ocean-body.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const ring = ( extra = {} ) => ( {
	x: 0, z: 0, fx: 0, fz: - 1,
	radius: 6, speed: 5, amp: 1.0, age: 0.4, life: 5, width: 1.4,
	...extra,
} );

{
	const on = wakeWaveAt( 0, 6, ring() );
	need( 'the crest sits on the expanding ring',
		on.h > 0.25,
		`h ${ on.h.toFixed( 3 ) }` );
	const peak = wakeWaveSlopeAt( 0, 6, ring() ).slope;
	const shoulder = wakeWaveSlopeAt( 0, 6 + 1.4 / Math.SQRT2, ring() ).slope;
	need( 'breaking slope lives on the shoulder, not the exact crest',
		shoulder > peak * 2 && shoulder > 0.08,
		`peak ${ peak.toFixed( 3 ) } shoulder ${ shoulder.toFixed( 3 ) }` );
}

{
	const inboard = wakeWaveAt( 0, 0.2, ring() );
	need( 'inside the ring the sea is quiet — not a filled disc',
		Math.abs( inboard.h ) < 0.04,
		`h ${ inboard.h.toFixed( 3 ) }` );
}

{
	const aft = wakeWaveAt( 0, 6, ring() );
	const ahead = wakeWaveAt( 0, - 6, ring() );
	need( 'the crest is a full circle — turning around still hits the wave',
		ahead.h > 0.25 && Math.abs( ahead.h - aft.h ) < 0.02,
		`aft ${ aft.h.toFixed( 3 ) } ahead ${ ahead.h.toFixed( 3 ) }` );
}

{
	const a = ring( { amp: 0.8 } );
	const b = ring( { amp: 0.5 } );
	const ha = wakeWaveAt( 0, 6, a ).h;
	const hb = wakeWaveAt( 0, 6, b ).h;
	const sum = wakeWaveFieldAt( 0, 6, { stamps: [ a, b ] } ).h;
	need( 'overlapping rings add — two waves that meet interact',
		Math.abs( sum - ( ha + hb ) ) < 1e-6 && sum > ha,
		`sum ${ sum.toFixed( 3 ) } vs ${ ( ha + hb ).toFixed( 3 ) }` );
}

{
	const young = ring( { radius: 2, age: 0.2 } );
	const old = ring( { radius: 12, age: 3.2 } );
	need( 'the ring thickens as it spreads',
		wakeWaveWidth( old ) > wakeWaveWidth( young ) + 0.8,
		`${ wakeWaveWidth( young ).toFixed( 2 ) } -> ${ wakeWaveWidth( old ).toFixed( 2 ) }` );
	need( 'amplitude decays as it opens',
		wakeWaveAmp( old ) < wakeWaveAmp( young ) * 0.45,
		`${ wakeWaveAmp( young ).toFixed( 3 ) } -> ${ wakeWaveAmp( old ).toFixed( 3 ) }` );
}

{
	const newborn = ring( { age: WAKE_WAVE_PROBE_DELAY * 0.4 } );
	const cleared = ring( { age: WAKE_WAVE_PROBE_DELAY + WAKE_WAVE_PROBE_FADE + 0.1 } );
	const visible = wakeWaveAt( 0, 6, newborn ).h;
	const selfRead = wakeWaveProbeAt( 0, 6, newborn ).h;
	const oldRead = wakeWaveProbeAt( 0, 6, cleared ).h;
	need( 'a newborn ring renders but cannot relaunch its source hull',
		visible > 0.2 && selfRead < visible * 0.02,
		`visible ${ visible.toFixed( 3 ) } probe ${ selfRead.toFixed( 3 ) }` );
	need( 'a cleared ring becomes real water to the buoyancy probe',
		oldRead > 0.15,
		`probe ${ oldRead.toFixed( 3 ) }` );
}

{
	const field = new WakeWaveField();
	field.step( 0.05, {
		x: 0, z: 1.6, fx: 0, fz: - 1, amp: 0.8, speed: 8,
	} );
	need( 'a wet moving stern deposits a ring',
		field.stamps.length === 1 && field.live,
		`n ${ field.stamps.length }` );
	const first = field.stamps[ 0 ];
	const x0 = first.x, z0 = first.z, r0 = first.radius;
	for ( let i = 1; i <= 12; i ++ ) {

		field.step( 0.05, {
			x: 0, z: 1.6 - i * 3, fx: 0, fz: - 1, amp: 0.8, speed: 8,
		} );

	}
	need( 'the first centre stays in the water — it does not chase the hull',
		Math.abs( first.x - x0 ) < 1e-6 && Math.abs( first.z - z0 ) < 1e-6,
		`c ${ first.x.toFixed( 2 ) },${ first.z.toFixed( 2 ) }` );
	need( 'the first radius grows',
		first.radius > r0 + 1.5,
		`r ${ r0.toFixed( 2 ) } -> ${ first.radius.toFixed( 2 ) }` );
	need( 'a moving wet hull keeps laying new rings',
		field.stamps.length >= 5,
		`n ${ field.stamps.length }` );
}

{
	const field = new WakeWaveField();
	const slam = {
		x: 0, z: 0, fx: 0, fz: - 1, amp: 0.9, speed: 5,
		impact: 0.8, force: true, id: 17, impactSeq: 3,
	};
	for ( let i = 0; i < 8; i ++ ) {

		field.step( 0.05, { ...slam, z: - i * 0.1 } );

	}
	need( 'one decaying impact produces one forced ring, not a sixteen-wave mountain',
		field.stamps.length === 1,
		`n ${ field.stamps.length }` );
	field.step( 0.05, { ...slam, impactSeq: 4 } );
	need( 'a later landing can produce a new forced ring',
		field.stamps.length === 2,
		`n ${ field.stamps.length }` );
}

{
	const field = new WakeWaveField();
	field.step( 0.05, { x: 0, z: 0, fx: 0, fz: - 1, amp: 0.01, speed: 8 } );
	need( 'a whisper of energy does not write a wave', field.stamps.length === 0 );
}

{
	const cfg = { depth: 0.55, strength: 1 };
	const ski = {
		stampB: [ 0, 1.6 ], airborne: false, heading: 0, wakeCfg: cfg,
		speed: 12, pitch: 0, roll: 0, impact: 0, vy: 0, surfVel: 0,
	};
	const cruise = wakeWaveImpulse( ski );
	const knife = wakeWaveImpulse( { ...ski, pitch: - 0.55 } );
	const plant = wakeWaveImpulse( { ...ski, pitch: 0.45 } );
	const slam = wakeWaveImpulse( {
		...ski, speed: 0, impact: 0.8, vy: - 9,
	} );
	const rest = wakeWaveImpulse( { ...ski, speed: 0 } );
	const crawl = wakeWaveImpulse( { ...ski, speed: 0.4 } );
	const edge = wakeWaveImpulse( { ...ski, roll: Math.PI * 0.5 } );
	need( 'a fast flat hull writes a wave',
		cruise && cruise.amp > 0.2,
		`amp ${ cruise?.amp?.toFixed( 3 ) }` );
	need( 'a bow-down cut is quieter than a flat run',
		knife && cruise && knife.amp < cruise.amp * 0.85,
		`cut ${ knife?.amp?.toFixed( 3 ) } flat ${ cruise?.amp?.toFixed( 3 ) }` );
	need( 'a stern plant is louder than a flat run',
		plant && cruise && plant.amp > cruise.amp * 1.05,
		`plant ${ plant?.amp?.toFixed( 3 ) } flat ${ cruise?.amp?.toFixed( 3 ) }` );
	need( 'a hard slam is louder than cruising',
		slam && cruise && slam.amp > cruise.amp,
		`slam ${ slam?.amp?.toFixed( 3 ) } cruise ${ cruise?.amp?.toFixed( 3 ) }` );
	need( 'a parked hull writes nothing', rest === null );
	need( 'a crawl writes nothing', crawl === null );
	need( 'an edge-on knife is quieter than a belly-flat run',
		edge && cruise && edge.amp < cruise.amp * 0.7,
		`edge ${ edge?.amp?.toFixed( 3 ) } flat ${ cruise?.amp?.toFixed( 3 ) }` );
	need( 'airborne with no slam writes nothing',
		wakeWaveImpulse( { ...ski, airborne: true, impact: 0 } ) === null );
	need( 'a slam still writes while the hull is coming down',
		wakeWaveImpulse( { ...ski, airborne: true, impact: 0.6, speed: 2 } )?.amp > 0.15 );
	const monsterHit = wakeWaveImpulse( {
		...ski, speed: 40, impact: 4.2, vy: - 16, wakeCfg: { depth: 0.38, strength: 0.85 },
	} );
	need( 'a leviathan slap is a ring, not a two-metre hill',
		monsterHit && monsterHit.amp < 0.56 && monsterHit.radius > 2,
		`amp ${ monsterHit?.amp?.toFixed( 3 ) } r ${ monsterHit?.radius?.toFixed( 2 ) }` );
	const crown = wakeWaveAt( 0, 0, {
		x: 0, z: 0, radius: monsterHit.radius, amp: monsterHit.amp,
		width: monsterHit.width, age: 0.05, life: 5,
	} );
	const lip = wakeWaveAt( 0, monsterHit.radius, {
		x: 0, z: 0, radius: monsterHit.radius, amp: monsterHit.amp,
		width: monsterHit.width, age: 0.05, life: 5,
	} );
	need( 'the landing ring is hollow in the middle',
		lip.h > crown.h * 3,
		`centre ${ crown.h.toFixed( 3 ) } lip ${ lip.h.toFixed( 3 ) }` );

	// Video physics tests:
	// 1. Froude number length scaling and hump speed transition (Fr ~ 0.5)
	const L_boat = 10; // 10 m boat (e.g. cottage country / Whitestone lake boat from video)
	const humpSpeed = 0.5 * Math.sqrt( 9.81 * L_boat ); // ~4.95 m/s (~11 mph)
	const idleSpeed = 1.0; // ~2.2 mph (displacement crawl below hull speed)
	const boatCfg = { depth: 0.55, strength: 1 };
	const boatBase = {
		stampB: [ 0, 5 ], airborne: false, heading: 0, length: L_boat, wakeCfg: boatCfg,
		pitch: 0, roll: 0, impact: 0, vy: 0, surfVel: 0,
	};
	const boatIdle = wakeWaveImpulse( { ...boatBase, speed: idleSpeed } );
	const boatHump = wakeWaveImpulse( { ...boatBase, speed: humpSpeed, pitch: 0.25 } ); // semi-displacement hump squat
	const boatPlane = wakeWaveImpulse( { ...boatBase, speed: humpSpeed * 2.5, pitch: 0.05 } ); // on plane

	need( 'displacement crawl below hull speed makes very small wake',
		boatIdle === null || boatIdle.amp < 0.08,
		`idle amp ${ boatIdle?.amp?.toFixed( 3 ) ?? 0 }` );
	need( 'transition to hump mode creates high wake energy',
		boatHump && boatHump.amp > 0.15,
		`hump amp ${ boatHump?.amp?.toFixed( 3 ) }` );
	need( 'planing reduces straight-line wavemaking relative to hump squat',
		boatPlane && boatHump && ( boatPlane.amp / ( boatPlane.drive || 1 ) ) < ( boatHump.amp / ( boatHump.drive || 1 ) ) * 1.5,
		`plane drive ${ boatPlane?.drive?.toFixed( 3 ) } hump drive ${ boatHump?.drive?.toFixed( 3 ) }` );

	// 2. Personal watercraft (PWCs): light straight line wake vs large waves in sharp turns / circles
	const pwcStraight = wakeWaveImpulse( { ...ski, speed: 18, yawRate: 0, slip: 0, hullLoad: 2 } );
	const pwcCarve = wakeWaveImpulse( { ...ski, speed: 18, yawRate: 1.4, slip: 0.6, hullLoad: 28, roll: 0.4 } );
	need( 'PWCs turning quickly in circles generate sizable wave energy over straight line',
		pwcCarve && pwcStraight && pwcCarve.amp > pwcStraight.amp * 1.25,
		`carve amp ${ pwcCarve?.amp?.toFixed( 3 ) } straight amp ${ pwcStraight?.amp?.toFixed( 3 ) }` );

	// 3. Shallow water resonance (Fr_h -> 1.0)
	const deepWater = wakeWaveImpulse( { ...ski, speed: 7, waterDepth: 40 } );
	const criticalShallow = wakeWaveImpulse( { ...ski, speed: 7, waterDepth: 5.0 } ); // Fr_h = 7 / sqrt(9.81 * 5) = 1.0
	need( 'shallow water near critical depth Fr_h ~ 1 magnifies wake height',
		criticalShallow && deepWater && criticalShallow.amp > deepWater.amp * 1.3,
		`shallow amp ${ criticalShallow?.amp?.toFixed( 3 ) } deep amp ${ deepWater?.amp?.toFixed( 3 ) }` );
}

{
	const field = new WakeWaveField();
	field.step( 0.05, { x: 0, z: 1.6, fx: 0, fz: - 1, amp: 0.8, speed: 8 } );
	const born = field.stamps[ 0 ].radius;
	for ( let i = 0; i < 40; i ++ ) field.step( 0.05, null );
	need( 'after a stop leftover rings keep opening',
		field.stamps[ 0 ] && field.stamps[ 0 ].radius > born + 5,
		`r ${ field.stamps[ 0 ]?.radius?.toFixed( 2 ) }` );
	need( 'a stopped hull does not lay a new ring',
		field.stamps.length === 1,
		`n ${ field.stamps.length }` );
}

{
	const field = new WakeWaveField();
	for ( let i = 0; i < 24; i ++ ) {

		field.step( 0.05, {
			x: 0, z: - i * 4, fx: 0, fz: - 1, amp: 0.8, speed: 10,
		} );

	}
	need( 'the field stays at the shader stamp cap',
		field.stamps.length === WAKE_WAVE_STAMPS,
		`n ${ field.stamps.length }` );
}

{
	const list = new BodyList();
	const ski = list.add( null, { ...SKI, pos: [ 0, 0.2, 0 ], heading: 0 } );
	ski.wet = true;
	ski.airborne = false;
	ski.speed = 12;
	const dummy = { update() {} };
	for ( let i = 0; i < 10; i ++ ) {

		ski.pos[ 2 ] -= 12 * 0.05;
		list.stampWake( dummy, 0.05, {} );

	}
	need( 'BodyList keeps writing rings while the ski is wet and moving',
		list.waves.stamps.length >= 2,
		`n ${ list.waves.stamps.length }` );
	ski.airborne = true;
	ski.wet = false;
	const nAir = list.waves.stamps.length;
	for ( let i = 0; i < 8; i ++ ) {

		ski.pos[ 2 ] -= 12 * 0.05;
		list.stampWake( dummy, 0.05, {} );

	}
	need( 'airborne writes no new rings — only leftover ones age',
		list.waves.stamps.length === nAir,
		`n ${ list.waves.stamps.length } was ${ nAir }` );
	const c = wakeWaveContactFrom( {
		stampB: [ 0, 1.6 ], airborne: false, speed: 12,
		heading: 0, pitch: 0, wakeCfg: { depth: 0.55, strength: 1 },
		id: 23, impactSeq: 4,
	} );
	need( 'a wet contact is born at the stern, heading −Z',
		c && c.fz < - 0.9 && c.z > 0.4 && c.amp > 0.2
			&& c.id === 23 && c.impactSeq === 4,
		`c ${ JSON.stringify( c && { z: c.z, fz: c.fz, amp: + c.amp.toFixed( 3 ) } ) }` );
	need( 'an airborne contact is refused',
		wakeWaveContactFrom( { stampB: [ 0, 1.6 ], airborne: true, speed: 12, wakeCfg: { depth: 0.55 } } ) === null );
	const many = wakeWaveContactsFrom( {
		stampRings: [ [ - 4, 2 ], [ 4, 2 ], [ 0, 10 ] ],
		airborne: false, speed: 16, heading: 0,
		wakeCfg: { depth: 0.55, strength: 1 },
		id: 7,
	} );
	need( 'pierce rings are one contact per waterline cut',
		many.length === 3
			&& many[ 0 ].x === - 4 && many[ 2 ].z === 10
			&& many[ 0 ].lane !== many[ 1 ].lane,
		`n ${ many.length }` );
	const one = wakeWaveContactFrom( {
		stampB: [ 0, 2 ], airborne: false, speed: 16, heading: 0,
		wakeCfg: { depth: 0.55, strength: 1 },
	} );
	need( 'several cuts share the hit instead of stacking full-height rings',
		one && many[ 0 ] && many[ 0 ].amp < one.amp * 0.7,
		`amp ${ many[ 0 ]?.amp?.toFixed( 3 ) } one ${ one?.amp?.toFixed( 3 ) }` );
	const split = new WakeWaveField();
	split.step( 0.05, many, { spacing: 2.6 } );
	need( 'distant cuts drop rings in the same frame',
		split.stamps.length === 3,
		`n ${ split.stamps.length }` );
	const land = wakeWaveContactsFrom( {
		stampB: [ 0, 2 ],
		stampRings: [ [ - 8, 0 ], [ 0, 2 ], [ 8, 0 ] ],
		airborne: false, speed: 20, heading: 0, impact: 2.4,
		wakeCfg: { depth: 0.38, strength: 0.85 },
		id: 9, impactSeq: 1,
	} );
	need( 'a landing writes one crown at the hit, not a dome per pierce',
		land.length === 1 && land[ 0 ].z === 2 && land[ 0 ].force,
		`n ${ land.length }` );
	// A mesh that trades foam for displaced water drives the rings from
	// its own recipe: taller, fatter, longer-lived, spaced by its length.
	const beast = {
		stampRings: [ [ 0, 4 ], [ 0, 20 ] ],
		airborne: false, speed: 18, heading: 0, length: 60,
		wakeCfg: {
			depth: 0.52, strength: 0.85, foam: 0,
			wave: 1.6, waveWidth: 3, waveLife: 9, waveGap: 0,
		},
		id: 'sd',
	};
	const plain = { ...beast, wakeCfg: { ...beast.wakeCfg, wave: 1, waveWidth: 1 } };
	const loud = wakeWaveContactsFrom( beast );
	const quiet = wakeWaveContactsFrom( plain );
	need( 'wave gain scales the height of the ring at each cut',
		Math.abs( loud[ 0 ].amp / quiet[ 0 ].amp - 1.6 ) < 1e-6,
		`ratio ${ ( loud[ 0 ].amp / quiet[ 0 ].amp ).toFixed( 3 ) }` );
	need( 'thickness fattens the crest so a long animal is not a wire',
		Math.abs( loud[ 0 ].width / quiet[ 0 ].width - 3 ) < 1e-6,
		`ratio ${ ( loud[ 0 ].width / quiet[ 0 ].width ).toFixed( 3 ) }` );
	need( 'an unset gap follows the body length, not the 2.6 m ski default',
		Math.abs( wakeWaveGapOf( beast.wakeCfg, 60 ) - 7.2 ) < 1e-6
			&& wakeWaveGapOf( beast.wakeCfg, 2 ) === WAKE_WAVE_SPACING,
		`gap ${ wakeWaveGapOf( beast.wakeCfg, 60 ).toFixed( 2 ) }` );
	need( 'a set gap wins over the auto one',
		wakeWaveGapOf( { waveGap: 18 }, 60 ) === 18 );
	need( 'the recipe life rides on the contact',
		loud[ 0 ].life === 9 && wakeWaveLifeOf( {} ) === 0 );
	{
		const mixed = new WakeWaveField();
		mixed.step( 0.05, loud );
		need( 'a recipe life outlives the five-second field default',
			mixed.stamps.length === 2 && mixed.stamps[ 0 ].life === 9,
			`life ${ mixed.stamps[ 0 ]?.life }` );
		// 12 m of travel is past the 2.6 m default but inside this
		// animal's 7.2 m gap, so it must not spawn a second time.
		const moved = wakeWaveContactsFrom( {
			...beast,
			stampRings: [ [ 0, - 1 ], [ 0, 15 ] ],
		} );
		mixed.step( 0.05, moved );
		need( 'the recipe gap thins the trail instead of the 2.6 m ski spacing',
			mixed.stamps.length === 2,
			`n ${ mixed.stamps.length }` );
		mixed.step( 0.05, wakeWaveContactsFrom( {
			...beast,
			stampRings: [ [ 0, - 9 ], [ 0, 7 ] ],
		} ) );
		need( 'travel past the gap does write the next ring',
			mixed.stamps.length === 4,
			`n ${ mixed.stamps.length }` );
	}
	const newest = list.waves.wave;
	const h = wakeWaveFieldAt( newest.x, newest.z + newest.radius, list.waves );
	need( 'the field sample hits a live ring',
		h.h > 0.02,
		`h ${ h.h.toFixed( 3 ) }` );
	const first = list.waves.stamps[ 0 ];
	const through = wakeWaveFieldAt( first.x, first.z - first.radius, list.waves );
	need( 'a leftover ring is still there on the heading you left — drive through it',
		through.h > 0.02,
		`h ${ through.h.toFixed( 3 ) }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok' : 'FAIL' }  ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}

console.log( `${ results.length - failed.length }/${ results.length } ok` );
if ( failed.length ) process.exit( 1 );
