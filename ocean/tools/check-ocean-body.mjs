#!/usr/bin/env node
// Drop, contact, float — and a wake:false body must not stamp.
//
//   node tools/check-ocean-body.mjs

import {
	OceanBody, BodyList, SKI, craftBasis, parseSwell, parseWake, parseSpray,
	parsePierce, parseDebug, debugContacts, hullRideHeight, hullPitchFrom,
	hullRollFrom,
	wakeLayers, wakeStampPoint, wakeLifeOf,
	wakeCutPoints, wakeRingPoints, wakeBehindPoint,
	WATER_DENSITY, GRAVITY, WAKE_SURFACE_SLACK, wakeSurfaceSlack,
	immersedFraction, floatEquilibriumY, floatFraction,
	isPhysicsWake, hullSpeed, leftoverWriteSites,
	LEFTOVER_TILE, LEFTOVER_HEIGHT_CAP, LEFTOVER_SPLASH_MIN_SPEED,
	leftoverBubbleHull, leftoverBubbleInHull,
} from '../src/ocean-body.js';
import { wakeAtCpu } from '../src/wake-sample.js';
import { wakeWaveContactsFrom } from '../src/wake-wave.js';
import { pierceCarveAt } from '../src/pierce-carve.js';
import {
	SPRAY_SCREEN_EXTENT, SPRAY_WATERLINE_MIN_HALF, SPRAY_WATERLINE_SMEAR,
	sprayBalancedSourceId, sprayBillboardExtentScale, spraySideSign,
	sprayContactPoints,
} from '../src/body-spray.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const TSL_SPRAY = readFileSync( join( ROOT, 'src/gpu/tsl/spray.js' ), 'utf8' );
const GLSL_SPRAY = readFileSync( join( ROOT, 'src/shaders/spray.js' ), 'utf8' );

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

{
	let paired = true;
	for ( let i = 0; i < 4; i ++ ) {

		paired = paired
			&& sprayBalancedSourceId( i ) === sprayBalancedSourceId( i + 4 )
			&& spraySideSign( i ) === - spraySideSign( i + 4 );

	}
	need( 'straight-run spray births are mirrored port/starboard pairs',
		paired,
		`ids ${ Array.from( { length: 8 }, ( _, i ) => `${ sprayBalancedSourceId( i ) }:${ spraySideSign( i ) }` ).join( ' ' ) }` );
	const dist = 2, radius = 0.3, elong = 8;
	const scale = sprayBillboardExtentScale( dist, radius, elong );
	need( 'a near spray billboard is geometrically capped before it can wall the screen',
		scale * radius * elong <= dist * SPRAY_SCREEN_EXTENT + 1e-9
			&& scale < 0.08,
		`scale ${ scale.toFixed( 4 ) } extent ${ ( scale * radius * elong ).toFixed( 3 ) }` );
}

{
	const frac = immersedFraction( 0, 2, 1 );
	need( 'a box well above the sea is dry', frac === 0, `frac ${ frac }` );
	need( 'a box well under the sea is full', immersedFraction( 0, - 4, 1 ) === 1,
		`frac ${ immersedFraction( 0, - 4, 1 ) }` );
	const half = immersedFraction( 0, 0, 2 );
	need( 'a box centred on the waterline is half in', Math.abs( half - 0.5 ) < 1e-9,
		`frac ${ half }` );
}

{
	const mass = 40, volume = 0.08, height = 0.43;
	const frac = floatFraction( mass, volume );
	need( 'equilibrium is mass over displaced water, not half the box',
		frac > 0.4 && frac < 0.6,
		`frac ${ frac.toFixed( 3 ) } (expect ~${ ( mass / ( WATER_DENSITY * volume ) ).toFixed( 3 ) })` );
	const y = floatEquilibriumY( 0, mass, volume, height );
	need( 'resting centre sits a little above the sea on a light crate',
		y > - 0.05 && y < height * 0.5,
		`y ${ y.toFixed( 3 ) }` );
}

{
	const crate = new OceanBody( null, {
		mass: 40, volume: 0.08, size: { x: 0.43, y: 0.43, z: 0.43 },
		float: true, wake: true, splash: 'impact',
		pos: [ 0, 14, - 8 ],
	} );
	need( 'a crate dropped from the air starts airborne',
		crate.airborne && crate.pos[ 1 ] > 10,
		`air ${ crate.airborne } y ${ crate.pos[ 1 ] }` );

	let sawImpact = false, sawContact = false;
	for ( let i = 0; i < 480; i ++ ) {

		crate.step( 1 / 60, { h: 0, seaLevel: 0 } );
		if ( crate.impact > 0.05 ) sawImpact = true;
		if ( crate.lastSplash?.kind === 'impact' ) sawContact = true;

	}

	const yEq = floatEquilibriumY( 0, crate.mass, crate.volume, crate.size.y );
	need( 'it hits the sea (impact + splash event)',
		sawImpact && sawContact,
		`impact seen ${ sawImpact } splash ${ sawContact } last ${ crate.lastSplash?.impact?.toFixed?.( 2 ) }` );
	need( 'then it floats, not sinks or flies',
		! crate.airborne && crate.wet,
		`air ${ crate.airborne } wet ${ crate.wet } y ${ crate.pos[ 1 ].toFixed( 3 ) }` );
	need( 'and settles near the mass/volume waterline',
		Math.abs( crate.pos[ 1 ] - yEq ) < 0.18 && Math.abs( crate.vel[ 1 ] ) < 0.55,
		`y ${ crate.pos[ 1 ].toFixed( 3 ) } eq ${ yEq.toFixed( 3 ) } vy ${ crate.vel[ 1 ].toFixed( 3 ) }` );
	need( 'gravity is the 9.81 the rest of the sim uses',
		GRAVITY === 9.81, `${ GRAVITY }` );
}

{
	const ghost = new OceanBody( null, {
		mass: 800, volume: 2, size: { x: 2, y: 1, z: 4 },
		float: true, wake: false,
		pos: [ 3, 0.2, 0 ], vel: [ 6, 0, 0 ],
	} );
	ghost.step( 1 / 30, { h: 0 } );
	ghost.wet = true;
	ghost.airborne = false;
	ghost.speed = 6;
	need( 'wake:false never becomes a stamp source, even when wet and moving',
		ghost.asWakeSource() === null,
		`${ ghost.asWakeSource() }` );
}

{
	const hull = new OceanBody( null, {
		mass: 400, volume: 1.2, size: { x: 1.4, y: 0.7, z: 3.2 },
		float: true, wake: { strength: 0.8, beam: 1.1, depth: 0.3 },
		pos: [ 0, 0.1, 0 ], vel: [ 5, 0, 0 ],
	} );
	for ( let i = 0; i < 90; i ++ ) hull.step( 1 / 60, { h: 0 } );
	const src = hull.asWakeSource();
	need( 'a wet moving hull with wake:true stamps',
		src && src.active && src.speed > 1,
		`src ${ !! src } speed ${ src?.speed?.toFixed?.( 2 ) }` );
}

{
	const list = new BodyList();
	const a = list.add( null, { mass: 40, volume: 0.08, float: true, wake: true, pos: [ 0, 14, 0 ] } );
	const b = list.add( null, { mass: 40, volume: 0.08, float: true, wake: false, pos: [ 4, 14, 0 ] } );
	for ( let i = 0; i < 360; i ++ ) list.step( 1 / 60, { seaLevel: 0 } );
	const src = list.wakeSources();
	need( 'BodyList drops both crates and only the wake body stamps',
		a.wet && b.wet && src.length === 1 && src[ 0 ].id === a.id,
		`wet ${ a.wet }/${ b.wet } n ${ src.length } id ${ src[ 0 ]?.id } vs ${ a.id }` );
	list.remove( a );
	need( 'remove drops the body from the list',
		list.length === 1 && list.items[ 0 ] === b,
		`n ${ list.length }` );
	b.wake = false;
	need( 'a live wake = false toggle stops stamping',
		list.wakeSources().length === 0,
		`n ${ list.wakeSources().length }` );
}

{
	const statue = new OceanBody( null, { mass: 10, float: false, wake: false, pos: [ 0, 2, 0 ] } );
	statue.step( 1 / 60, { h: 0 } );
	need( 'float:false is decoration — it does not fall or stamp',
		Math.abs( statue.pos[ 1 ] - 2 ) < 1e-6 && statue.asWakeSource() === null,
		`y ${ statue.pos[ 1 ] }` );
}

{
	const ski = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	need( 'SKI on the water starts riding, not falling',
		! ski.airborne && ski.hover > 0,
		`air ${ ski.airborne } hover ${ ski.hover }` );
	for ( let i = 0; i < 180; i ++ ) ski.step( 1 / 60, { h: 0, seaLevel: 0 } );
	need( 'a box with SKI coefficients sits on the hover spring, not the crate waterline',
		! ski.airborne && Math.abs( ski.pos[ 1 ] - SKI.hover ) < 0.08,
		`y ${ ski.pos[ 1 ].toFixed( 3 ) } hover ${ SKI.hover }` );
}

{
	const light = new OceanBody( null, { ...SKI, mass: 80, pos: [ 0, SKI.hover, 0 ] } );
	const heavy = new OceanBody( null, { ...SKI, mass: 800, pos: [ 0, SKI.hover, 0 ] } );
	for ( let i = 0; i < 180; i ++ ) {

		light.step( 1 / 60, { h: 0 } );
		heavy.step( 1 / 60, { h: 0 } );

	}
	need( 'a heavier SKI box sags the hover spring',
		heavy.pos[ 1 ] < light.pos[ 1 ] - 0.2,
		`light ${ light.pos[ 1 ].toFixed( 3 ) } heavy ${ heavy.pos[ 1 ].toFixed( 3 ) }` );
	const piled = new OceanBody( null, { ...SKI, mass: 1760, pos: [ 0, SKI.hover, 0 ] } );
	need( 'a heavy planing box still rests on the water, not a metre under it',
		piled.planingRest() >= 0.05 && piled.planingRest() <= SKI.hover,
		`rest ${ piled.planingRest().toFixed( 3 ) }` );
}

{
	const sunk = new OceanBody( null, {
		mass: 4000, volume: 1.7, size: SKI.size, float: true, hover: 0,
		pos: [ 0, 2, 0 ],
	} );
	for ( let i = 0; i < 240; i ++ ) sunk.step( 1 / 60, { h: 0 } );
	need( 'hover 0 is hydrostatic: mass above ρV sinks',
		sunk.pos[ 1 ] < 0 && ! sunk.airborne,
		`y ${ sunk.pos[ 1 ].toFixed( 3 ) } air ${ sunk.airborne }` );

	const ski = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	for ( let i = 0; i < 60; i ++ ) ski.step( 1 / 60, { h: 0.8, seaLevel: 0 } );
	ski.hover = 0;
	ski.step( 1 / 60, { h: 0.8, seaLevel: 0 } );
	const sit = floatEquilibriumY( ski.surf, ski.mass, ski.volume, ski.size.y );
	need( 'turning hover off snaps onto the hydrostatic waterline, not the old hover height',
		! ski.airborne && Math.abs( ski.pos[ 1 ] - sit ) < 0.08,
		`y ${ ski.pos[ 1 ].toFixed( 3 ) } sit ${ sit.toFixed( 3 ) } surf ${ ski.surf.toFixed( 3 ) }` );

	const rider = new OceanBody( null, {
		mass: SKI.mass, volume: SKI.volume, size: SKI.size,
		float: true, hover: 0, drag: SKI.drag,
		pos: [ 0, floatEquilibriumY( 1.2, SKI.mass, SKI.volume, SKI.size.y ), 0 ],
	} );
	rider.surf = 1.2;
	rider._primed = true;
	rider.wet = true;
	rider.airborne = false;
	rider._lastSurf = 1.2;
	for ( let i = 1; i <= 90; i ++ ) {

		rider.step( 1 / 60, { h: 1.2 - i * ( 1.8 / 90 ) } );

	}

	const keel = rider.pos[ 1 ] - rider.size.y * 0.5;
	need( 'a floating box rides a dropping swell instead of hanging in the air',
		! rider.airborne && rider.wet && keel < rider.surf + 0.05,
		`y ${ rider.pos[ 1 ].toFixed( 3 ) } surf ${ rider.surf.toFixed( 3 ) } keel ${ keel.toFixed( 3 ) } air ${ rider.airborne }` );

	const raft = new OceanBody( null, {
		...SKI, hover: 0, throttle: null, steer: null,
		pos: [ 0, floatEquilibriumY( 0, SKI.mass, SKI.volume, SKI.size.y ), 0 ],
	} );
	raft._primed = true;
	raft._probePrimed = true;
	raft.surf = 0;
	raft.wet = true;
	raft.airborne = false;
	raft._lastSurf = 0;
	for ( let i = 0; i < 90; i ++ ) raft.step( 1 / 60, { h: [ 0, 1.6, 0, 0 ], seaLevel: 0 } );
	const raftSit = floatEquilibriumY( raft.surf, raft.mass, raft.volume, raft.size.y );
	need( 'a floating SKI does not stand its bow out of a steep swell',
		Math.abs( raft.pitch ) < 0.22,
		`pitch ${ raft.pitch.toFixed( 3 ) }` );
	need( 'and the origin stays on the hydrostatic waterline',
		! raft.airborne && Math.abs( raft.pos[ 1 ] - raftSit ) < 0.08,
		`y ${ raft.pos[ 1 ].toFixed( 3 ) } sit ${ raftSit.toFixed( 3 ) } surf ${ raft.surf.toFixed( 3 ) }` );
}

{
	const ski = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: 0, vel: [ 8, 0, 0 ],
	} );
	for ( let i = 0; i < 180; i ++ ) ski.step( 1 / 60, { h: 0 } );
	need( 'grip bleeds sideways velocity instead of letting a box skate',
		Math.abs( ski.vel[ 0 ] ) < 1.2,
		`vx ${ ski.vel[ 0 ].toFixed( 3 ) }` );
}

{
	const ski = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: 0, vel: [ 0, 0, 0 ],
	} );
	ski.throttle = 1;
	ski.steer = 0;
	for ( let i = 0; i < 180; i ++ ) ski.step( 1 / 60, { h: 0 } );
	need( 'writing throttle on a SKI box builds forward speed',
		ski.speed > 12 && ski.vel[ 2 ] < - 8,
		`speed ${ ski.speed.toFixed( 2 ) } vz ${ ski.vel[ 2 ].toFixed( 2 ) }` );
}

{
	const full = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: 0, vel: [ 0, 0, 0 ],
	} );
	const part = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: 0, vel: [ 0, 0, 0 ],
	} );
	full.throttle = 1;
	full.steer = 0;
	part.throttle = 0.25;
	part.steer = 0;
	for ( let i = 0; i < 240; i ++ ) {

		full.step( 1 / 60, { h: 0 } );
		part.step( 1 / 60, { h: 0 } );

	}
	need( 'partial throttle cruises below full send',
		part.speed > 6 && part.speed < full.speed - 8,
		`part ${ part.speed.toFixed( 2 ) } full ${ full.speed.toFixed( 2 ) }` );
}

{
	const sit = floatEquilibriumY( 0, SKI.mass, SKI.volume, SKI.size.y );
	const ski = new OceanBody( null, {
		...SKI, hover: 0, pos: [ 0, sit, 0 ], heading: 0, vel: [ 0, 0, 0 ],
	} );
	ski.throttle = 1;
	ski.steer = 0;
	for ( let i = 0; i < 180; i ++ ) ski.step( 1 / 60, { h: 0 } );
	need( 'hover 0 still motors — hover is ride height, not the ignition',
		ski.speed > 12 && ski.vel[ 2 ] < - 8,
		`speed ${ ski.speed.toFixed( 2 ) } vz ${ ski.vel[ 2 ].toFixed( 2 ) } y ${ ski.pos[ 1 ].toFixed( 2 ) }` );
	need( 'a driven hover-0 hull sits on the hydrostatic waterline',
		! ski.airborne && Math.abs( ski.pos[ 1 ] - sit ) < 0.12,
		`y ${ ski.pos[ 1 ].toFixed( 3 ) } sit ${ sit.toFixed( 3 ) }` );
}

{
	const ski = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: Math.PI / 2, vel: [ 28, 0, 0 ],
	} );
	let h = 0;
	let left = false;
	for ( let i = 0; i < 90; i ++ ) {

		h -= 6.5 * ( 1 / 60 );
		ski.step( 1 / 60, { h } );
		if ( ski.airborne ) left = true;

	}
	need( 'a storm-scale drop is ridden instead of launching',
		! left && ! ski.airborne && ski.pos[ 1 ] < 0 && ski.pos[ 1 ] > ski.surf - 0.2,
		`air ${ ski.airborne } y ${ ski.pos[ 1 ].toFixed( 2 ) } surf ${ ski.surf.toFixed( 2 ) }` );
}

{
	const ski = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: Math.PI / 2, vel: [ 28, 0, 0 ],
	} );
	let h = 0;
	let left = false;
	let launchVy = 0;
	for ( let i = 0; i < 50; i ++ ) {

		h += 5.5 * ( 1 / 60 );
		ski.step( 1 / 60, { h } );

	}
	for ( let i = 0; i < 40; i ++ ) {

		h -= 9 * ( 1 / 60 );
		ski.step( 1 / 60, { h } );
		if ( ski.airborne ) {

			left = true;
			launchVy = Math.max( launchVy, ski.vel[ 1 ] );

		}

	}
	need( 'a rising face into a falling crest can still launch',
		left,
		`air ${ ski.airborne } y ${ ski.pos[ 1 ].toFixed( 2 ) } vy ${ ski.vel[ 1 ].toFixed( 2 ) }` );
	need( 'a crest launch cannot exceed the ballistic cap',
		launchVy <= SKI.jumpMax + 1e-6,
		`vy ${ launchVy.toFixed( 2 ) } cap ${ SKI.jumpMax }` );
}

{
	const glued = new OceanBody( null, {
		...SKI, springiness: 0, launch: 0,
		pos: [ 0, SKI.hover, 0 ], heading: Math.PI / 2, vel: [ 28, 0, 0 ],
	} );
	let h = 0;
	let left = false;
	for ( let i = 0; i < 50; i ++ ) {

		h += 5.5 * ( 1 / 60 );
		glued.step( 1 / 60, { h } );

	}
	for ( let i = 0; i < 40; i ++ ) {

		h -= 9 * ( 1 / 60 );
		glued.step( 1 / 60, { h } );
		if ( glued.airborne ) left = true;

	}
	need( 'springiness 0 stays on the face instead of launching',
		! left && ! glued.airborne,
		`air ${ glued.airborne } y ${ glued.pos[ 1 ].toFixed( 2 ) }` );
}

{
	need( 'hull ride height averages the probes so one bow sample cannot yank the box',
		Math.abs( hullRideHeight( [ 0, 4, 0, 0, 0 ] ) - 0.8 ) < 1e-9,
		`${ hullRideHeight( [ 0, 4, 0, 0, 0 ] ) }` );
	need( 'pitch from bow vs stern, not bow vs centre',
		Math.abs( hullPitchFrom( [ 0, 1.2, - 1.2, 0, 0 ], 1.2, 1 ) - Math.atan2( 2.4, 2.4 ) ) < 1e-9,
		`${ hullPitchFrom( [ 0, 1.2, - 1.2, 0, 0 ], 1.2, 1 ) }` );
	need( 'rotationInfluence 0 holds the deck level',
		hullPitchFrom( [ 0, 2, - 2, 0, 0 ], 1.2, 0 ) === 0 );

	const ski = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	const pts = ski.probePoints();
	need( 'a SKI box samples the four AABB corners (physics leftover layout)',
		pts.length === 4 && ski.sampleCount === 4 && ski.probeLayout === 'corners',
		`n ${ pts.length } layout ${ ski.probeLayout }` );
	need( 'the stern corners sit aft of the origin (heading 0 is −Z)',
		pts[ 2 ][ 1 ] > 0 && pts[ 3 ][ 1 ] > 0 && pts[ 0 ][ 1 ] < 0 && pts[ 1 ][ 1 ] < 0,
		`bow z ${ pts[ 0 ][ 1 ].toFixed( 3 ) }/${ pts[ 1 ][ 1 ].toFixed( 3 ) } stern z ${ pts[ 2 ][ 1 ].toFixed( 3 ) }/${ pts[ 3 ][ 1 ].toFixed( 3 ) }` );
	need( 'hull samples stay on the mesh, not past the bow',
		Math.abs( pts[ 0 ][ 1 ] ) <= SKI.size.z * 0.5 + 1e-6,
		`bow |z| ${ Math.abs( pts[ 0 ][ 1 ] ).toFixed( 3 ) } half ${ ( SKI.size.z * 0.5 ).toFixed( 3 ) }` );

	const step = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	step.step( 1 / 60, { h: 2 } );
	need( 'height follow does not overshoot a step change',
		step.pos[ 1 ] < 2 + step.planingRest() + 0.05,
		`y ${ step.pos[ 1 ].toFixed( 3 ) } target ${ ( 2 + step.planingRest() ).toFixed( 3 ) }` );

	const flat = new OceanBody( null, {
		...SKI, rotationInfluence: 0, pos: [ 0, SKI.hover, 0 ],
	} );
	for ( let i = 0; i < 90; i ++ ) flat.step( 1 / 60, { h: [ 0, 2.4, - 2.4, 0, 0 ] } );
	need( 'rotationInfluence 0 ignores a steep face',
		Math.abs( flat.pitch ) < 0.04,
		`pitch ${ flat.pitch.toFixed( 3 ) }` );

	const storm = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: 0, vel: [ 0, 0, - 12 ],
	} );
	storm.throttle = 0.35;
	storm.steer = 0;
	let air = 0, maxPitch = 0, maxErr = 0;
	const A = 3.5, T = 8, dt = 1 / 60;
	for ( let i = 0; i < 480; i ++ ) {

		const t = i * dt;
		const w = ( 2 * Math.PI * t ) / T;
		const mid = A * Math.sin( w );
		const bow = A * Math.sin( w + 0.28 );
		const stern = A * Math.sin( w - 0.28 );
		storm.step( dt, { h: [ mid, bow, stern, mid, mid ] } );
		if ( storm.airborne ) air ++;
		maxPitch = Math.max( maxPitch, Math.abs( storm.pitch ) );
		maxErr = Math.max( maxErr, Math.abs( storm.pos[ 1 ] - ( storm.surf + storm.planingRest() ) ) );

	}
	need( 'a North-Atlantic-scale swell is ridden, not bounced',
		air === 0 && maxPitch < 0.42 && maxErr < 1.4,
		`air ${ air } pitch ${ maxPitch.toFixed( 3 ) } err ${ maxErr.toFixed( 3 ) }` );
}

{
	const ski = new OceanBody( null, {
		...SKI, pos: [ 0, SKI.hover, 0 ], heading: 0, vel: [ 0, 0, - 12 ],
	} );
	ski.throttle = 1;
	ski.steer = 1;
	for ( let i = 0; i < 90; i ++ ) ski.step( 1 / 60, { h: 0 } );
	need( 'positive steer (D) increases heading — a right turn from -Z toward +X',
		ski.heading > 0.15,
		`heading ${ ski.heading.toFixed( 3 ) }` );
}

{
	const z0 = craftBasis( 0 ).forward;
	const zR = craftBasis( Math.PI / 2 ).forward;
	need( 'heading 0 aims the bow down world -Z',
		Math.abs( z0[ 0 ] ) < 1e-9 && Math.abs( z0[ 2 ] + 1 ) < 1e-9,
		`fwd ${ z0.map( ( n ) => n.toFixed( 3 ) ).join( ',' ) }` );
	need( 'heading +π/2 aims the bow down world +X (D, not A)',
		Math.abs( zR[ 0 ] - 1 ) < 1e-9 && Math.abs( zR[ 2 ] ) < 1e-9,
		`fwd ${ zR.map( ( n ) => n.toFixed( 3 ) ).join( ',' ) }` );

	const te = new Float32Array( 16 );
	const mesh = {
		position: { x: 0, y: 0, z: 0, set( x, y, z ) { this.x = x; this.y = y; this.z = z; } },
		scale: { x: 1, y: 1, z: 1 },
		matrix: {
			set( n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44 ) {

				const e = te;
				e[ 0 ] = n11; e[ 4 ] = n12; e[ 8 ] = n13; e[ 12 ] = n14;
				e[ 1 ] = n21; e[ 5 ] = n22; e[ 9 ] = n23; e[ 13 ] = n24;
				e[ 2 ] = n31; e[ 6 ] = n32; e[ 10 ] = n33; e[ 14 ] = n34;
				e[ 3 ] = n41; e[ 7 ] = n42; e[ 11 ] = n43; e[ 15 ] = n44;

			},
		},
	};
	const posed = new OceanBody( mesh, { ...SKI, pos: [ 3, 1, - 2 ], heading: Math.PI / 2 } );
	posed.pitch = 0;
	posed.roll = 0;
	posed.syncMesh();
	// Local -Z (bow) is -column Z of the Three-style matrix.
	const bowX = - te[ 8 ], bowZ = - te[ 10 ];
	need( 'syncMesh aims the mesh bow along the physics heading, not the Euler opposite',
		Math.abs( bowX - 1 ) < 1e-6 && Math.abs( bowZ ) < 1e-6 && mesh.position.x === 3,
		`bow ${ bowX.toFixed( 3 ) },${ bowZ.toFixed( 3 ) }` );
}

{
	need( 'SKI does not turn swell on by default',
		parseSwell( SKI.swell, SKI.size ) === null, `${ SKI.swell }` );
	need( 'swell:true is size-scaled dome + bow + mound',
		( () => {

			const s = parseSwell( true, SKI.size, { length: SKI.length, beam: SKI.beam } );
			return s && s.dome > 0.1 && s.bow > 0.1 && s.mound > 0.05;

		} )() );
	need( 'swell.on 0 is off even when dome is set',
		parseSwell( { on: 0, dome: 1.2, bow: 1 }, SKI.size ) === null );

	const justUnder = new OceanBody( null, {
		...SKI, hover: 0, swell: true,
		pos: [ 0, - 0.04, 0 ], heading: 0,
	} );
	justUnder.surf = 0;
	justUnder._primed = true;
	let live = null;
	for ( let i = 0; i < 40; i ++ ) live = justUnder.swellState( 1 / 60, { seaLevel: 0, scale: 1 } );
	need( 'a just-under body with swell:true writes a dome and a bow heap',
		live && live.dome.amp > 0.05 && live.bow.amp > 0.05,
		`dome ${ live?.dome?.amp?.toFixed?.( 3 ) } bow ${ live?.bow?.amp?.toFixed?.( 3 ) }` );
	const along = ( justUnder.length ?? justUnder.size.z ) * 0.48;
	need( 'the bow heap sits on the nose, not the origin (heading 0 is -Z)',
		live && Math.abs( live.bow.z - ( justUnder.pos[ 2 ] - along ) ) < 0.08 && Math.abs( live.bow.x ) < 1e-6,
		`bow xz ${ live?.bow?.x?.toFixed?.( 3 ) },${ live?.bow?.z?.toFixed?.( 3 ) } expect 0,${ ( - along ).toFixed( 3 ) }` );

	const deep = new OceanBody( null, {
		...SKI, hover: 0, swell: true,
		pos: [ 0, - 24, 0 ],
	} );
	deep.surf = 0;
	deep._primed = true;
	let gone = null;
	for ( let i = 0; i < 40; i ++ ) gone = deep.swellState( 1 / 60, { seaLevel: 0, scale: 1 } );
	need( 'the same look is gone twenty metres under',
		gone == null || ( gone.dome.amp < 0.03 && gone.bow.amp < 0.03 ),
		`dome ${ gone?.dome?.amp?.toFixed?.( 3 ) }` );

	const deepBeast = new OceanBody( null, {
		mass: 4e4, float: false, hull: false,
		size: { x: 8.4, y: 10.8, z: 60 },
		length: 60,
		swell: { on: 1, dome: 2.15, bow: 2.15, mound: 0.15, near: 2.4, fade: 3.2, soft: 1.4, bowSoft: 1.4 },
		pos: [ 0, - 9, 0 ],
	} );
	deepBeast.surf = 0;
	deepBeast._primed = true;
	let quiet = null;
	for ( let i = 0; i < 40; i ++ ) quiet = deepBeast.swellState( 1 / 60, { seaLevel: 0, scale: 1 } );
	need( 'a 60 m body nine metres down does not heave a mountain',
		quiet == null || ( quiet.dome.amp < 0.08 && quiet.bow.amp < 0.08 ),
		`dome ${ quiet?.dome?.amp?.toFixed?.( 3 ) } bow ${ quiet?.bow?.amp?.toFixed?.( 3 ) }` );

	const flown = new OceanBody( null, {
		...SKI, swell: true,
		pos: [ 0, 8, 0 ],
	} );
	flown.surf = 0;
	flown._primed = true;
	let air = null;
	for ( let i = 0; i < 40; i ++ ) air = flown.swellState( 1 / 60, { seaLevel: 0, scale: 1 } );
	need( 'and gone once the body has flown out',
		air == null || ( air.dome.amp < 0.03 && air.bow.amp < 0.03 ),
		`dome ${ air?.dome?.amp?.toFixed?.( 3 ) }` );

	const leap = new OceanBody( null, {
		mass: 4e4, float: false, hull: false,
		size: { x: 8.4, y: 10.8, z: 60 },
		length: 60,
		swell: { on: 1, dome: 6.25, bow: 4, mound: 0.15, near: 2.4, fade: 3.2 },
		pos: [ 0, 1.2, 0 ],
	} );
	leap.surf = 0;
	leap._primed = true;
	leap.airborne = true;
	leap._swellEase = { mound: 0.15, dome: 6.25, bow: 4 };
	const loft = leap.swellState( 1 / 60, { seaLevel: 0, scale: 1 } );
	need( 'a leap does not take the loaf into the air',
		loft == null,
		`dome ${ loft?.dome?.amp?.toFixed?.( 3 ) }` );

	const landing = new OceanBody( null, {
		mass: 4e4, float: false, hull: false,
		size: { x: 8.4, y: 10.8, z: 60 },
		length: 60,
		swell: { on: 1, dome: 6.25, bow: 4, mound: 0.15, near: 2.4, fade: 3.2 },
		pos: [ 0, - 1, 0 ],
	} ).attach( {
		pos: [ 0, - 1, 0 ], heading: 0, speed: 18,
		active: true, jumping: true, jumpPhase: 'water', jumpVy: - 10,
		jumpAirborne: false,
	} );
	landing.surf = 0;
	landing._primed = true;
	landing._swellEase = { mound: 0.15, dome: 6.25, bow: 4 };
	const slap = landing.swellState( 1 / 60, { seaLevel: 0, scale: 1 } );
	need( 'a landing does not raise the swim loaf as a lingering dome',
		slap == null,
		`dome ${ slap?.dome?.amp?.toFixed?.( 3 ) }` );

	const hullAir = new OceanBody( null, { ...SKI, pos: [ 0, 4, 0 ] } );
	hullAir.airborne = true;
	hullAir.wet = false;
	need( 'an airborne hull does not press a mound',
		hullAir.hullState() === null );

	const list = new BodyList();
	const hullOnly = list.add( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	hullOnly.wet = true;
	hullOnly.airborne = false;
	const swimmer = list.add( null, {
		mass: 800, volume: 2, size: { x: 2, y: 1, z: 8 },
		float: true, wake: false, hover: 0, swell: true,
		pos: [ 12, - 0.2, 0 ],
	} );
	swimmer.surf = 0;
	swimmer._primed = true;
	swimmer.airborne = false;
	swimmer.wet = true;
	need( 'primarySwell picks the swell body, not the hull-only ski',
		list.primarySwell( [ 0, 0 ] ) === swimmer && list.primaryHull( [ 0, 0 ] ) === hullOnly,
		`swell ${ list.primarySwell( [ 0, 0 ] )?.id } hull ${ list.primaryHull( [ 0, 0 ] )?.id }` );
	let payload = null;
	for ( let i = 0; i < 40; i ++ ) payload = list.swellState( 1 / 60, { seaLevel: 0, scale: 1 }, [ 0, 0 ] );
	need( 'BodyList.swellState reports the swimmer into the shared slot',
		payload && Math.abs( payload.pos[ 0 ] - 12 ) < 1e-6 && payload.dome.amp > 0.05,
		`x ${ payload?.pos?.[ 0 ] } dome ${ payload?.dome?.amp?.toFixed?.( 3 ) }` );
	swimmer.swell = false;
	let faded = payload;
	for ( let i = 0; i < 80; i ++ ) faded = list.swellState( 1 / 60, { seaLevel: 0, scale: 1 }, [ 0, 0 ] );
	need( 'turning swell off fades the slot instead of popping',
		faded == null || faded.dome.amp < 0.03,
		`dome ${ faded?.dome?.amp?.toFixed?.( 3 ) }` );
}

{
	need( 'SKI wake is on by default (object, not false)',
		parseWake( SKI.wake, SKI.size, { length: SKI.length, beam: SKI.beam } ) !== null,
		`${ SKI.wake }` );
	need( 'SKI hull carves the sea — a hollow and a bow heap, not a marble dent',
		SKI.hull.push > 0.5 && SKI.hull.radius > 1.2 && SKI.hull.bow > 0.7,
		`push ${ SKI.hull.push } r ${ SKI.hull.radius } bow ${ SKI.hull.bow }` );
	need( 'SKI wake is gravity-wave leftover with a foam ribbon',
		SKI.wake.physics === 1 && SKI.wake.foam === 1.1 && SKI.wake.persist === 10.9
			&& SKI.wake.motor === 0.4 && SKI.wake.damp === 1.8 && SKI.wake.emit === 4
			&& SKI.wake.strength === 1.2 && SKI.wake.beam === 0.9 && SKI.wake.cut === 0,
		`physics ${ SKI.wake.physics } foam ${ SKI.wake.foam } motor ${ SKI.wake.motor }` );
	{
		const ski = parseWake( SKI.wake, SKI.size, { length: SKI.length, beam: SKI.beam } );
		const fromMotor = parseWake( { on: 1, motor: 0.4 } );
		const shaped = parseWake( {
			on: 1, motor: 0.4, jet: { width: 0.22, reach: 7, height: 0.3 },
		} );
		const explicit = parseWake( {
			on: 1, jet: { amount: 0.6, width: 0.2, reach: 7, height: 0.3 },
		} );
		const off = parseWake( { on: 1, jet: 0, motor: 0.4 } );
		need( 'wake.jet is the transom tail — motor stays the amount alias',
			ski.jet.on === 1 && ski.jet.amount === 0.4 && ski.motor === 0.4
				&& ski.jet.spray === 0
				&& fromMotor.jet.on === 1 && fromMotor.motor === 0.4
				&& fromMotor.jet.spray === 0
				&& shaped.jet.width === 0.22 && shaped.jet.reach === 7
				&& shaped.motor === 0.4
				&& explicit.jet.amount === 0.6 && explicit.motor === 0.6
				&& off.jet.on === 0 && off.motor === 0 );
		const rooster = parseWake( {
			on: 1, jet: { amount: 0.5, spray: 0.9, spraySpeed: 12, sprayRise: 0.28 },
		} );
		need( 'wake.jet.spray is the airborne rooster — motor does not imply it',
			rooster.jet.spray === 0.9 && rooster.jet.spraySpeed === 12
				&& rooster.jet.sprayRise === 0.28 );
		const sprayOnly = parseWake( { on: 1, jet: { amount: 0, spray: 0.85 } } );
		need( 'jet spray can fly when the foam jet amount is 0',
			sprayOnly.jet.on === 1 && sprayOnly.jet.amount === 0
				&& sprayOnly.jet.spray === 0.85 && sprayOnly.motor === 0 );
	}
	need( 'SKI wake depth remains the authored hydro height',
		SKI.wake.depth === 0.56,
		`depth ${ SKI.wake.depth }` );
	need( 'SKI does not ship leftover bubble splash — spray owns airborne whitewater',
		SKI.wake.bubbles == null );
	need( 'wake beam auto is the mesh width',
		parseWake( { on: 1, beam: 'auto' }, { x: 2, y: 1, z: 3 } ).beam === 2
			&& parseWake( { on: 1, beam: 0.9 }, { x: 2, y: 1, z: 3 } ).beam === 0.9 );
	need( 'wake:true is a size-scaled recipe',
		( () => {

			const w = parseWake( true, SKI.size, { length: SKI.length, beam: SKI.beam } );
			return w && w.strength > 0.4 && w.count === 3;

		} )() );
	need( 'wake.on 0 is off even when strength is set',
		parseWake( { on: 0, strength: 2, start: 1 }, SKI.size ) === null );
	need( 'wake.count 0 is off',
		parseWake( { count: 0, strength: 1 }, SKI.size ) === null );
	need( 'count 1 is boil only, 2 is V only, 3 is V+boil, 4 adds a bow cut',
		wakeLayers( { count: 1 } ).arms === 0 && wakeLayers( { count: 1 } ).trail === 1
		&& wakeLayers( { count: 2 } ).arms === 2 && wakeLayers( { count: 2 } ).trail === 0
		&& wakeLayers( { count: 3 } ).arms === 2 && wakeLayers( { count: 3 } ).trail === 1
		&& wakeLayers( { count: 4 } ).bow > 0 );

	const hull = new OceanBody( null, {
		...SKI,
		wake: { origin: - 1, start: 0.5, end: 4, length: 30, count: 3, bow: 0.4 },
		pos: [ 0, 0.2, 0 ], heading: 0,
	} );
	hull.wet = true;
	hull.airborne = false;
	hull.speed = 10;
	const src = hull.asWakeSource();
	const stern = wakeStampPoint( hull, hull.wakeConfig(), hull.surfXZ() );
	need( 'origin −1 stamps at the stern, not the centre (heading 0 is −Z)',
		src && src.stampB && Math.abs( src.stampB[ 1 ] - stern[ 1 ] ) < 1e-6
		&& src.stampB[ 1 ] > hull.pos[ 2 ] + 0.4,
		`stampB ${ src?.stampB } stern ${ stern } posZ ${ hull.pos[ 2 ] }` );
	const behind = wakeStampPoint( hull, { origin: - 2 }, hull.surfXZ() );
	need( 'origin past −1 sits behind the stern',
		behind[ 1 ] > stern[ 1 ] + 0.4,
		`behind ${ behind[ 1 ].toFixed( 2 )} stern ${ stern[ 1 ].toFixed( 2 ) }` );
	need( 'length in metres becomes a finite life, not the global 14 s',
		src && src.life > 1.5 && src.life < 14,
		`life ${ src?.life }` );
	const dims = hull.wakeRenderDims( { wakeLife: 14 } );
	need( 'a body wake does not write a following Kelvin or a stamp V',
		dims.kelvinOn === 0 && dims.arms === 0 && dims.depth === 0 && dims.width0 === 0,
		`on ${ dims.kelvinOn } arms ${ dims.arms } depth ${ dims.depth } w0 ${ dims.width0 }` );
	need( 'the stamp vertex sits at the stern when origin is −1',
		dims.kelvinHead && Math.abs( dims.kelvinHead[ 1 ] - stern[ 1 ] ) < 1e-6,
		`head ${ dims.kelvinHead } stern ${ stern }` );
	{
		const rec = { stir: 1.2, age: 2.2, lat: 0, rate: 6 };
		const left = wakeAtCpu( rec, {
			life: dims.life, armW: dims.armW, spread: dims.spread, beam: dims.beam,
			arm: dims.arm, churn: dims.churn, depth: dims.depth, strength: dims.strength,
			width0: dims.width0, arms: dims.arms, trail: dims.trail, cut: dims.cut,
		} );
		need( 'the stamp field adds no leftover height',
			Math.abs( left.h ) < 0.002,
			`h ${ left.h.toFixed( 3 ) }` );
		need( 'the foam-only stamp leaves aerated water behind the moving body',
			left.foam > 0.08,
			`foam ${ left.foam.toFixed( 3 ) } arm ${ dims.arm.toFixed( 3 ) } churn ${ dims.churn.toFixed( 3 ) }` );
	}

	const off = new OceanBody( null, {
		...SKI, wake: { on: 0, strength: 2 },
		pos: [ 0, 0.2, 0 ],
	} );
	off.wet = true;
	off.airborne = false;
	off.speed = 8;
	need( 'a live wake.on = 0 toggle stops stamping',
		off.asWakeSource() === null );

	need( 'a 30 m trail at 10 m/s is about 3 s, not 14',
		Math.abs( wakeLifeOf( { length: 30 }, 10, { wakeLife: 14 } ) - 3 ) < 0.2,
		`${ wakeLifeOf( { length: 30 }, 10, { wakeLife: 14 } ) }` );
}

{
	need( 'SKI spray is on by default',
		parseSpray( SKI.spray, SKI.size, { hover: SKI.hover } ) !== null );
	need( 'SKI.spray keeps the hull jet',
		parseSpray( SKI.spray, SKI.size, { hover: SKI.hover } )?.hull === 1 );
	need( 'spray:true sheds at the waterline — hull jet is opt-in',
		( () => {

			const s = parseSpray( true, SKI.size, { hover: SKI.hover } );
			return s && s.hull === 0 && s.sites === 4 && s.amount === 1;

		} )() );
	need( 'a floating body gets waterline spray without asking',
		( () => {

			const b = new OceanBody( null, {
				mass: 80, float: true, size: { x: 1.2, y: 0.6, z: 3 },
			} );
			const s = parseSpray( b.spray, b.size );
			return s && s.hull === 0 && s.amount === 1;

		} )() );
	need( 'a non-float body stays quiet until spray is set',
		new OceanBody( null, { mass: 40, size: { x: 1, y: 1, z: 1 } } ).spray === false );
	need( 'spray.on 0 is off even when amount is set',
		parseSpray( { on: 0, amount: 2, sites: 8 }, SKI.size ) === null );
	need( 'sites clamp to the GPU cap, not past it',
		parseSpray( { sites: 80 }, SKI.size, { hover: 0 } ).sites === 50 );

	const ski = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	ski.throttle = 1;
	ski.steer = 0;
	for ( let i = 0; i < 180; i ++ ) ski.step( 1 / 60, { h: 0, seaLevel: 0 } );
	const wet = ski.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 0.75 } } );
	need( 'a wet moving SKI drives the emitter',
		wet && wet.craftAmount > 0.2 && wet.craftSpeed > 4 && wet.craftPierce === 0,
		`amt ${ wet?.craftAmount } spd ${ wet?.craftSpeed?.toFixed?.( 2 ) } pierce ${ wet?.craftPierce }` );
	need( 'hull craftBeam is half-width so chines birth on the rail, not a beam outboard',
		wet && Math.abs( wet.craftBeam - SKI.size.x * 0.5 ) < 0.05,
		`beam ${ wet?.craftBeam } half ${ ( SKI.size.x * 0.5 ).toFixed( 2 ) }` );
	need( 'hull craftLen is bow-to-centre, so the jet starts at the transom',
		wet && Math.abs( wet.craftLen - ( SKI.length ?? SKI.size.z ) * 0.5 ) < 0.05,
		`craftLen ${ wet?.craftLen } half ${ ( ( SKI.length ?? SKI.size.z ) * 0.5 ).toFixed( 2 ) }` );

	const snap = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	snap.throttle = 1;
	snap.step( 1 / 60, { h: 0, seaLevel: 0 } );
	snap.step( 1 / 60, { h: 0, seaLevel: 0 } );
	need( 'throttle writes measured fwdAccel, not the motor coefficient',
		snap.fwdAccel > 4 && snap.fwdAccel < 40 && snap.accel === SKI.accel,
		`fwd ${ snap.fwdAccel.toFixed( 2 ) } motor ${ snap.accel }` );

	const turning = new OceanBody( null, { ...SKI, pos: [ 0, SKI.hover, 0 ] } );
	turning.throttle = 1;
	turning.steer = 1;
	for ( let i = 0; i < 90; i ++ ) turning.step( 1 / 60, { h: 0, seaLevel: 0 } );
	const carve = turning.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 1 } } );
	need( 'a carve raises load from yaw and slip, not just speed',
		carve && carve.craftLoad > carve.craftSpeed * 0.2 && Math.abs( carve.craftTurn ) > 0.05,
		`load ${ carve?.craftLoad?.toFixed?.( 2 ) } turn ${ carve?.craftTurn?.toFixed?.( 3 ) }` );

	const cuts = new OceanBody( null, {
		mass: 80, volume: 1.2, size: { x: 1.2, y: 1, z: 4 },
		float: true, hover: 0,
		spray: { on: 1, hull: 0, sites: 3, band: 0.2, amount: 1 },
		pos: [ 0, 0, 0 ],
	} );
	cuts.surf = 0;
	cuts._primed = true;
	cuts.wet = true;
	cuts.airborne = false;
	cuts.speed = 8;
	const waterline = cuts.sprayState( 0, { seaLevel: 0, params: { craftSprayAmount: 1 } } );
	need( 'hull 0 sheds from waterline cuts and respects the site cap',
		waterline && waterline.craftPierce === 1
		&& waterline.craftSiteCount >= 1 && waterline.craftSiteCount <= 3
		&& waterline.touching,
		`n ${ waterline?.craftSiteCount } pierce ${ waterline?.craftPierce }` );

	const nBow = 16;
	const bowHalf = new Float32Array( nBow );
	const bowTop = new Float32Array( nBow );
	const bowLow = new Float32Array( nBow );
	for ( let i = 0; i < nBow; i ++ ) {

		const t = ( i + 0.5 ) / nBow;
		bowTop[ i ] = 1.1;
		bowLow[ i ] = - 0.9;
		// Nose at local −Z (minZ): a pointed stem, full beam amidships.
		bowHalf[ i ] = 0.22 + 1.48 * Math.sin( Math.PI * t );

	}
	const yacht = new OceanBody( null, {
		mass: 8200, volume: 13.5, float: true, hover: 0,
		length: 12, beam: 3.4,
		size: { x: 3.4, y: 1.25, z: 12 },
		spray: { on: 1, hull: 0, sites: 8, band: 0.18, amount: 1 },
		pos: [ 0, 0, 0 ],
	} );
	yacht.sprayStations = {
		minZ: - 6, maxZ: 6, top: bowTop, low: bowLow, half: bowHalf,
	};
	yacht.surf = 0;
	yacht._primed = true;
	yacht.wet = true;
	yacht.airborne = false;
	yacht.speed = 20;
	const yachtCuts = sprayContactPoints( yacht, { seaLevel: 0 } );
	const bowCut = yachtCuts.cuts.reduce( ( a, s ) => {

		const along = s.along ?? 0;
		return ! a || along < a.along ? s : a;

	}, null );
	need( 'a pointed yacht stem keeps spray on the waterline, not 0.35×beam outboard',
		bowCut && bowCut.half < 0.45
			&& bowCut.half > SPRAY_WATERLINE_MIN_HALF - 1e-6
			&& Math.abs( bowCut.x ) < 0.5,
		`half ${ bowCut?.half?.toFixed?.( 3 ) } x ${ bowCut?.x?.toFixed?.( 3 ) }` );
	need( 'waterline pierce birth smears centimetres, not 0.22×LOA',
		SPRAY_WATERLINE_SMEAR <= 0.2
			&& TSL_SPRAY.includes( 'SPRAY_WATERLINE_SMEAR' )
			&& GLSL_SPRAY.includes( 'SPRAY_WATERLINE_SMEAR' )
			&& TSL_SPRAY.includes( 'hA.x.sub( 0.5 ) ).mul( float( SPRAY_WATERLINE_SMEAR )' )
			&& ! /org\.assign\(\s*F\.mul\( hA\.x\.sub\( 0\.5 \) \)\.mul\( uCraftLen \)/.test( TSL_SPRAY )
			&& ! /org\s*=\s*F\*\(hA\.x - 0\.5\)\*uCraftLen/.test( GLSL_SPRAY ),
		`smear ${ SPRAY_WATERLINE_SMEAR }` );

	const beast = new OceanBody( null, {
		mass: 4e4, float: false, wake: false,
		spray: { on: 1, hull: 0, sites: 12, amount: 1, band: 0.7 },
		size: { x: 4, y: 6, z: 24 },
		pos: [ 0, - 0.2, 0 ],
	} );
	beast.sprayLook = 'dragon';
	beast.surf = 0;
	beast._primed = true;
	beast.wet = true;
	beast.airborne = false;
	beast.speed = 14;
	const sheet = beast.sprayState( 0, {
		seaLevel: 0, params: { craftSprayAmount: 0.2 },
	} );
	need( 'dragon spray is not taxed by the ski amount slider',
		sheet && sheet.sprayBody === 'dragon' && sheet.craftAmount > 0.9 && sheet.touching,
		`amt ${ sheet?.craftAmount } look ${ sheet?.sprayBody }` );

	const air = new OceanBody( null, { ...SKI, pos: [ 0, 18, 0 ] } );
	air.surf = 0;
	air._primed = true;
	air.airborne = true;
	air.wet = false;
	air.impact = 0;
	air.speed = 22;
	need( 'airborne with no waterline is quiet',
		air.sprayState( 0, { seaLevel: 0 } ) === null );

	const entry = new OceanBody( null, { ...SKI, pos: [ 0, 18, 0 ] } );
	entry.surf = 0;
	entry._primed = true;
	entry.airborne = true;
	entry.wet = false;
	entry.impact = 1;
	need( 'an airborne impact with no waterline does not spray',
		entry.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 1 } } ) === null );

	const land = new OceanBody( null, {
		mass: 4e4, float: false,
		spray: { on: 1, hull: 0, sites: 8, band: 0.35 },
		size: { x: 4, y: 6, z: 24 },
		pos: [ 0, 20, 0 ],
	} );
	land.sprayLook = 'dragon';
	land.surf = 0;
	land._primed = true;
	land.airborne = true;
	land.wet = false;
	land.impact = 1;
	need( 'a dragon landing with no waterline cut does not fire a crown',
		land.sprayState( 1 / 60, { seaLevel: 0, params: { sdSplashLife: 0.65 } } ) === null );
	land.pos[ 1 ] = - 0.2;
	land.airborne = false;
	land.wet = true;
	land.impact = 1;
	const cut = land.sprayState( 1 / 60, { seaLevel: 0, params: { sdSplashLife: 0.65 } } );
	need( 'a cutting dragon is swim spray, not jump plates',
		cut && cut.sprayBody === 'dragon' && ( cut.entryDraw ?? 0 ) === 0
			&& ( cut.craftImpact ?? 0 ) === 0 && cut.touching,
		`body ${ cut?.sprayBody } draw ${ cut?.entryDraw } impact ${ cut?.craftImpact }` );

	const sunk = new OceanBody( null, {
		mass: 200, volume: 0.4, size: { x: 1, y: 1, z: 2 },
		float: true, hover: 0, spray: { hull: 0, sites: 4 },
		pos: [ 0, - 8, 0 ],
	} );
	sunk.surf = 0;
	sunk._primed = true;
	sunk.wet = true;
	sunk.airborne = false;
	sunk.speed = 6;
	need( 'a fully submerged crate does not spray',
		sunk.sprayState( 0, { seaLevel: 0 } ) === null );

	const off = new OceanBody( null, {
		...SKI, spray: { on: 0, amount: 2, sites: 8 },
		pos: [ 0, SKI.hover, 0 ],
	} );
	off.wet = true;
	off.airborne = false;
	off.speed = 12;
	need( 'a live spray.on = 0 toggle parks the emitter',
		off.sprayState( 0, { seaLevel: 0 } ) === null );

	const yachtJet = new OceanBody( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
		wake: {
			on: 1, physics: 1, foam: 0.8,
			jet: { amount: 0.6, spray: 1, height: 0.42, width: 0.16 },
		},
		spray: { on: 0 },
		pos: [ 0, 0.2, 0 ],
	} );
	yachtJet.wet = true;
	yachtJet.airborne = false;
	yachtJet.speed = 18;
	yachtJet.vel[ 2 ] = - 18;
	yachtJet.topSpeed = 51;
	yachtJet.throttle = 0.25;
	const rooster = yachtJet.sprayState( 1 / 60, {
		seaLevel: 0, params: { craftSprayAmount: 0 },
	} );
	need( 'a jet tail throws airborne spray without body.spray or craftSprayAmount',
		rooster && rooster.craftJetOnly === 1 && rooster.craftAmount > 0.15
			&& rooster.craftSheet === 0 && rooster.craftBurst === 0
			&& rooster.craftPierce === 0,
		`amt ${ rooster?.craftAmount?.toFixed?.( 3 ) } only ${ rooster?.craftJetOnly }` );
	yachtJet.wake.jet = { amount: 0, spray: 1, height: 0.42, width: 0.16 };
	const sprayNoFoam = yachtJet.sprayState( 1 / 60, {
		seaLevel: 0, params: { craftSprayAmount: 0 },
	} );
	need( 'airborne jet spray does not need a foam jet amount',
		sprayNoFoam && sprayNoFoam.craftJetOnly === 1 && sprayNoFoam.craftAmount > 0.15,
		`amt ${ sprayNoFoam?.craftAmount?.toFixed?.( 3 ) }` );
	yachtJet.wake.jet = { amount: 0.6, spray: 1, height: 0.42, width: 0.16 };
	yachtJet.fwdAccel = 0;
	yachtJet.yawRate = 0;
	const cruiseJet = yachtJet.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 0 } } );
	yachtJet.fwdAccel = 8;
	const punchJet = yachtJet.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 0 } } );
	yachtJet.fwdAccel = 0;
	yachtJet.yawRate = 0.55;
	const turnJet = yachtJet.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 0 } } );
	need( 'jet spray amount, throw, and rise follow accel — not a fixed recipe',
		punchJet && cruiseJet
			&& punchJet.craftAmount > cruiseJet.craftAmount * 1.12
			&& punchJet.craftJetSpeed >= cruiseJet.craftJetSpeed
			&& punchJet.craftJetRise > cruiseJet.craftJetRise,
		`cruise ${ cruiseJet?.craftAmount?.toFixed?.( 3 ) }/${ cruiseJet?.craftJetSpeed?.toFixed?.( 2 ) } punch ${ punchJet?.craftAmount?.toFixed?.( 3 ) }/${ punchJet?.craftJetSpeed?.toFixed?.( 2 ) }` );
	need( 'a turning hull steers the rooster from yaw, not the helm stick',
		turnJet && Math.abs( turnJet.craftSteer ) > 0.25
			&& Math.abs( cruiseJet?.craftSteer ?? 0 ) < 0.08,
		`cruise steer ${ cruiseJet?.craftSteer?.toFixed?.( 3 ) } turn ${ turnJet?.craftSteer?.toFixed?.( 3 ) }` );
	yachtJet.spray = { on: 1, hull: 0, sites: 6, amount: 1 };
	yachtJet.surf = 0;
	yachtJet._primed = true;
	yachtJet.fwdAccel = 0;
	yachtJet.yawRate = 0;
	const both = yachtJet.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 0.75 } } );
	need( 'waterline cuts and a transom jet can share the emitter',
		both && both.craftPierce === 1 && both.craftJet > 0.15
			&& both.craftSheet === 0 && both.craftBurst === 0
			&& both.craftSiteCount >= 1,
		`pierce ${ both?.craftPierce } jet ${ both?.craftJet } n ${ both?.craftSiteCount }` );
	need( 'stacked jet is pinned to the hull origin, not a waterline cut',
		both && Math.hypot( both.craftPos[ 0 ], both.craftPos[ 2 ] ) < 0.6
			&& both.craftLen >= 5.5,
		`pos ${ both?.craftPos?.map?.( ( v ) => v.toFixed?.( 2 ) ).join?.( ',' ) } len ${ both?.craftLen }` );
	need( 'jet birth ignores waterline sites in classic and TSL',
		GLSL_SPRAY.includes( 'site = uCraftPos' )
			&& TSL_SPRAY.includes( 'site.assign( uCraftPos )' ) );
	yachtJet.spray = { on: 0 };
	yachtJet.wake.jet = { amount: 0.6, spray: 0, height: 0.42 };
	need( 'jet spray 0 parks airborne even when the foam jet is on',
		yachtJet.sprayState( 1 / 60, { seaLevel: 0, params: { craftSprayAmount: 0 } } ) === null );

	const list = new BodyList();
	const hullOnly = list.add( null, { ...SKI, spray: false, pos: [ 0, SKI.hover, 0 ] } );
	hullOnly.wet = true;
	const sprayer = list.add( null, {
		mass: 80, volume: 1, size: { x: 1, y: 1, z: 3 },
		float: true, hover: 0, wake: false,
		spray: { hull: 0, sites: 4, band: 0.25 },
		pos: [ 10, 0, 0 ],
	} );
	sprayer.surf = 0;
	sprayer._primed = true;
	sprayer.wet = true;
	sprayer.airborne = false;
	sprayer.speed = 7;
	need( 'primarySpray picks the spray body, not the hull-only ski',
		list.primarySpray( [ 0, 0 ] ) === sprayer,
		`id ${ list.primarySpray( [ 0, 0 ] )?.id }` );
}

{
	const parked = new OceanBody( null, { ...SKI, spray: true } );
	parked.throttle = 0;
	parked.steer = 0;
	const swimmer = new OceanBody( null, {
		mass: 4e4, float: false, wake: true,
		spray: { on: 1, hull: 0, sites: 12 },
		size: { x: 4, y: 6, z: 24 },
	} ).attach( {
		pos: [ 10, - 2, 0 ], heading: 0, speed: 14,
		active: true, jumpAirborne: false,
	} );
	const list = new BodyList();
	list.add( parked );
	list.add( swimmer );
	need( 'a piloted swimmer takes the spray slot from a parked driven ski',
		list.primarySpray( [ 10, 0 ] ) === swimmer,
		`id ${ list.primarySpray( [ 10, 0 ] )?.id }` );
	swimmer.controller.active = false;
	need( 'an idle swimmer leaves spray on the driven ski',
		list.primarySpray( [ 10, 0 ] ) === parked,
		`id ${ list.primarySpray( [ 10, 0 ] )?.id }` );
	swimmer.controller.active = true;
	swimmer.wet = true;
	const src = swimmer.asWakeSource( {} );
	need( 'a piloted swimmer can stamp leftover wake without a surfXZ helper',
		!! src && src.speed === 14 && Array.isArray( src.stampB ),
		`src ${ !! src } speed ${ src?.speed }` );
	swimmer.controller.active = false;
	need( 'an AI escort does not recenter the wake field',
		swimmer.asWakeSource( {} ) === null );
	need( 'an escort that is cutting still writes leftover rings',
		!! swimmer.asWakeSource( {}, { escort: true } )
			&& swimmer.asWakeSource( {}, { escort: true } ).speed === 14 );
	swimmer.controller.active = true;
	swimmer.controller.pos = [ 10, - 14, 0 ];
	swimmer.controller.impact = 0;
	swimmer.impact = 0;
	need( 'a deep piloted swimmer does not stamp leftover foam on the sea',
		swimmer.asWakeSource( {} ) === null
			&& swimmer.surfaceClearance( 0 ) > wakeSurfaceSlack( swimmer ),
		`clear ${ swimmer.surfaceClearance( 0 ).toFixed( 2 ) } slack ${ wakeSurfaceSlack( swimmer ).toFixed( 2 ) }` );
	swimmer.controller.impact = 0.8;
	need( 'a landing still stamps leftover foam from that depth',
		!! swimmer.asWakeSource( {} ) );
	swimmer.controller.impact = 0;
	swimmer.impact = 0;
	swimmer.controller.pos = [ 10, 2, 0 ];
	swimmer.controller.jumpAirborne = true;
	swimmer.controller.airborne = true;
	swimmer.controller.impact = 0.9;
	need( 'an exit leap does not keep stamping wake under the flying body',
		swimmer.asWakeSource( {} ) === null );
	swimmer.controller.jumpAirborne = false;
	swimmer.controller.airborne = false;
	swimmer.controller.impact = 0;
	swimmer.controller.pos = [ 10, - 2, 0 ];
}

{
	const beast = new OceanBody( null, {
		mass: 4e4, float: false,
		wake: { on: 1, origin: - 1, foam: 0.72, kelvin: 1, strength: 0.85 },
		size: { x: 8.4, y: 10.8, z: 60 },
		length: 60,
	} ).attach( {
		pos: [ 0, - 9, 0 ], heading: 0, speed: 18,
		active: true, jumpAirborne: false,
	} );
	need( 'a 60 m animal just under the sea still stamps leftover foam',
		!! beast.asWakeSource( {} )
			&& beast.surfaceClearance( 0 ) < wakeSurfaceSlack( beast )
			&& beast.surfaceClearance( 0 ) > WAKE_SURFACE_SLACK,
		`clear ${ beast.surfaceClearance( 0 ).toFixed( 2 ) } slack ${ wakeSurfaceSlack( beast ).toFixed( 2 ) }` );
	beast.controller.pos = [ 0, - 22, 0 ];
	need( 'the same animal well under does not stamp a V on the sea above',
		beast.asWakeSource( {} ) === null );

	// Trading foam for displaced water: the source still exists and still
	// drives rings, but every white-water lane is off.
	beast.controller.pos = [ 0, - 9, 0 ];
	beast.wake = {
		on: 1, origin: - 1, foam: 0, kelvin: 0, strength: 0.85,
		depth: 0.52, wave: 1.6, waveWidth: 3, waveLife: 9,
	};
	const dry = beast.asWakeSource( {} );
	const dims = beast.wakeRenderDims( {} );
	need( 'foam 0 leaves nothing for the leftover ribbon to deposit',
		!! dry && dry.foam === 0
			&& dims.arm === 0 && dims.churn === 0 && dims.trail === 0
			&& dims.kelvinOn === 0,
		`foam ${ dry?.foam } arm ${ dims.arm } trail ${ dims.trail }` );
	need( 'and the water is still deformed at the cuts',
		wakeWaveContactsFrom( dry ).some( ( c ) => c.amp > 0.05 && c.life === 9 ),
		`n ${ wakeWaveContactsFrom( dry ).length }` );
}

{
	const n = 16;
	const top = new Float32Array( n );
	const low = new Float32Array( n );
	const half = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) {

		const t = i / ( n - 1 );
		top[ i ] = ( t < 0.32 || t > 0.68 ) ? 4.2 : 0.15;
		low[ i ] = - 2;
		half[ i ] = 1.4;

	}
	const stations = { minZ: - 12, maxZ: 12, top, low, half };
	const monster = new OceanBody( null, {
		mass: 4e4, float: false, hull: false,
		wake: { on: 1, origin: - 0.55, foam: 0.5, depth: 0.38, strength: 0.85 },
		spray: { on: 1, hull: 0, sites: 12, band: 0.35 },
		size: { x: 4, y: 6, z: 24 },
		pos: [ 0, - 1, 0 ], heading: 0,
	} ).attach( {
		pos: [ 0, - 1, 0 ], heading: 0, speed: 18,
		active: true, jumpAirborne: false, impact: 0,
	} );
	monster.sprayStations = stations;
	monster.surf = 0;
	monster._primed = true;
	monster.wet = true;
	const cuts = wakeCutPoints( monster, { seaLevel: 0 } );
	need( 'a two-hump pierce writes more than one spray-wake cut',
		cuts.length >= 2,
		`n ${ cuts.length }` );
	const src = monster.asWakeSource( { seaLevel: 0 } );
	const mid = wakeStampPoint( monster, monster.wakeConfig(), monster.surfXZ() );
	const rings = src?.stampRings ?? [];
	const firstBehind = rings[ 0 ]
		? wakeBehindPoint( rings[ 0 ][ 0 ], rings[ 0 ][ 1 ], monster.heading, 0.9 )
		: null;
	need( 'leftover foam trails behind the spray runs, not the origin',
		!! src && ( src.stampPoints?.length ?? 0 ) >= 2
			&& src.foamBeam <= 2.2
			&& firstBehind
			&& Math.hypot( src.stampPoints[ 0 ][ 0 ] - firstBehind[ 0 ],
				src.stampPoints[ 0 ][ 1 ] - firstBehind[ 1 ] ) < 0.05,
		`pts ${ JSON.stringify( src?.stampPoints ) } rings ${ JSON.stringify( rings ) } beam ${ src?.foamBeam }` );
	need( 'rings are born at those cuts, not only at the stern recipe',
		!! src && rings.length >= 2,
		`rings ${ JSON.stringify( rings ) }` );
	need( 'stampB is the first spray-run trail, heading 0 is −Z',
		!! src && firstBehind
			&& Math.hypot( src.stampB[ 0 ] - firstBehind[ 0 ],
				src.stampB[ 1 ] - firstBehind[ 1 ] ) < 0.05,
		`stampB ${ src?.stampB } behind ${ firstBehind } origin ${ mid }` );
	need( 'wakeRingPoints keeps distant runs and drops a stacked neighbour',
		wakeRingPoints( [
			{ x: 0, z: - 8 }, { x: 0.2, z: - 7.6 }, { x: 0, z: 8 },
		] ).length === 2 );
	monster.controller.pos = [ 0, - 18, 0 ];
	monster.pos[ 1 ] = - 18;
	need( 'a deep profiled body writes no wake when nothing cuts the sea',
		monster.asWakeSource( { seaLevel: 0 } ) === null
			&& wakeCutPoints( monster, { seaLevel: 0 } ).length === 0 );
	monster.controller.pos = [ 0, 6, 0 ];
	monster.pos[ 1 ] = 6;
	monster.controller.impact = 0;
	monster.impact = 0;
	const dryCuts = wakeCutPoints( monster, { seaLevel: 0 } );
	const surfaced = monster.asWakeSource( { seaLevel: 0 } );
	const origin = wakeStampPoint( monster, monster.wakeConfig(), monster.surfXZ() );
	need( 'a surfaced profiled body still stamps leftover foam at the origin',
		dryCuts.length === 0 && !! surfaced
			&& Math.abs( surfaced.stampB[ 1 ] - origin[ 1 ] ) < 0.05,
		`cuts ${ dryCuts.length } stampB ${ surfaced?.stampB } origin ${ origin }` );
	const ski = new OceanBody( null, {
		...SKI,
		wake: { on: 1, physics: 0, origin: - 1, foam: 0.9, strength: 1.2, beam: 0.9 },
		pos: [ 0, 0.2, 0 ], heading: 0,
	} );
	ski.wet = true;
	ski.airborne = false;
	ski.speed = 10;
	const skiSrc = ski.asWakeSource();
	need( 'a classic hull without sprayStations still stamps the stern recipe',
		!! skiSrc && ! skiSrc.stampPoints
			&& Math.abs( skiSrc.stampB[ 1 ] - wakeStampPoint( ski, ski.wakeConfig(), ski.surfXZ() )[ 1 ] ) < 1e-6 );
	need( 'SKI physics wake leaves rings to spray and writes foam energy instead',
		isPhysicsWake( parseWake( SKI.wake, SKI.size ) )
			&& new OceanBody( null, { ...SKI, pos: [ 0, 0.2, 0 ] } ).asWakeSource() === null );
	const kBody = new OceanBody( null, {
		wake: { on: 1, kelvin: 1, strength: 0.85, foam: 0.9, origin: - 0.55 },
		size: { x: 8, y: 10, z: 60 }, length: 60, pos: [ 0, 0, 0 ],
	} );
	const kd = kBody.wakeRenderDims( {} );
	need( 'an opt-in kelvin recipe writes a following V',
		kd.kelvinOn === 1 && kd.kelvinAmp > 0.2 && ski.wakeRenderDims( {} ).kelvinOn === 0,
		`on ${ kd.kelvinOn } amp ${ kd.kelvinAmp } ski ${ ski.wakeRenderDims( {} ).kelvinOn }` );
}

{
	const controller = {
		pos: [ 0, SKI.hover, 0 ], impact: 0, airborne: false,
		speed: 0, yawRate: 0, active: true,
	};
	const body = new OceanBody( null, { ...SKI } ).attach( controller );
	controller.impact = 0.8;
	body.pullFromController();
	const first = body._impactSeq;
	body.pullFromController();
	controller.impact = 0;
	body.pullFromController();
	controller.impact = 0.7;
	body.pullFromController();
	need( 'controller impact sequences advance once per landing edge',
		first === 1 && body._impactSeq === 2,
		`first ${ first } second ${ body._impactSeq }` );
	const swimmer = {
		pos: [ 3, - 4, 8 ], heading: 0.4, pitch: - 0.22, roll: 0.18,
		speed: 12, yawRate: 0.1, jumpAirborne: false, active: false,
	};
	const swimBody = new OceanBody( null, {
		mass: 4e4, float: false, wake: false, swell: true, size: { x: 4, y: 6, z: 24 },
	} ).attach( swimmer );
	need( 'an attached swimmer copies pitch and roll onto the mesh body',
		Math.abs( swimBody.pitch + 0.22 ) < 1e-9 && Math.abs( swimBody.roll - 0.18 ) < 1e-9
			&& swimBody.wet === true,
		`pitch ${ swimBody.pitch } roll ${ swimBody.roll } wet ${ swimBody.wet }` );
	swimmer.jumpAirborne = true;
	swimBody.pullFromController();
	need( 'an airborne leap is not wet', swimBody.wet === false );
}

{
	need( 'debug is off unless asked',
		parseDebug( undefined ) === null && debugContacts( new OceanBody( null, { ...SKI } ) ) === null );
	need( 'debug:true is both spray and buoyancy',
		parseDebug( true )?.spray && parseDebug( true )?.buoyancy );
	need( 'debug.on 0 is off even when spray is set',
		parseDebug( { on: 0, spray: 1 } ) === null );
	need( 'debug can hide spray and keep buoyancy',
		parseDebug( { spray: 0, buoyancy: 1 } )?.buoyancy
		&& ! parseDebug( { spray: 0, buoyancy: 1 } )?.spray );
	need( 'debug:true does not turn leftover emit points on',
		parseDebug( true )?.emit === false );
	need( 'debug.emit is leftover occupancy points',
		parseDebug( { emit: 1, spray: 0, buoyancy: 0, pierce: 0 } )?.emit );

	const sitY = floatEquilibriumY( 0, SKI.mass, SKI.volume, SKI.size.y );
	const raft = new OceanBody( null, {
		...SKI, hover: 0, debug: true,
		spray: { on: 1, hull: 0, sites: 4, band: 0.25, amount: 1 },
		pos: [ 0, sitY, 0 ],
	} );
	raft.surf = 0;
	raft._primed = true;
	raft._probePrimed = true;
	raft.wet = true;
	raft.airborne = false;
	raft.samples.h = [ 0.2, 0.2, - 0.05, - 0.05 ];
	const pack = raft.debugContacts( { seaLevel: 0 } );
	const bowPort = pack?.buoyancy?.find( ( p ) => p.role === 'bow-port' );
	const bowStbd = pack?.buoyancy?.find( ( p ) => p.role === 'bow-starboard' );
	const sternPort = pack?.buoyancy?.find( ( p ) => p.role === 'stern-port' );
	need( 'a debug SKI shows the four corner buoyancy probes',
		pack && pack.buoyancy.length === 4,
		`n ${ pack?.buoyancy?.length }` );
	need( 'the stern probes sit aft of the origin',
		sternPort && sternPort.z > 0,
		`stern z ${ sternPort?.z }` );
	need( 'the bow probes are ahead of the origin (heading 0 is −Z)',
		bowPort && bowPort.z < 0 && bowStbd && bowStbd.z < 0,
		`bow z ${ bowPort?.z?.toFixed?.( 3 ) } / ${ bowStbd?.z?.toFixed?.( 3 ) }` );
	need( 'buoyancy markers sit on the sampled surface, not the box origin',
		bowPort && Math.abs( bowPort.y - 0.2 ) < 1e-9,
		`bow y ${ bowPort?.y }` );
	need( 'and waterline spray cuts sit on the sea',
		pack && pack.spray.length >= 1 && pack.spray.every( ( s ) => Math.abs( s.y ) < 0.05 ),
		`n ${ pack?.spray?.length } y ${ pack?.spray?.[ 0 ]?.y }` );

	const jet = new OceanBody( null, {
		...SKI, debug: true, spray: { on: 1, hull: 1, sites: 4 },
		pos: [ 3, SKI.hover, - 2 ],
	} );
	jet.surf = 0.4;
	jet._primed = true;
	const hull = jet.debugContacts()?.spray?.find( ( s ) => s.role === 'hull' );
	need( 'hull-jet debug sits at the craft, on the sampled sea',
		hull && Math.abs( hull.x - 3 ) < 0.02 && Math.abs( hull.z + 2 ) < 0.02 && Math.abs( hull.y - 0.4 ) < 1e-9,
		`hull ${ hull?.x?.toFixed?.( 2 ) },${ hull?.y?.toFixed?.( 2 ) },${ hull?.z?.toFixed?.( 2 ) }` );

	const crate = new OceanBody( null, {
		mass: 40, volume: 0.08, size: { x: 0.5, y: 0.5, z: 0.5 },
		float: true, samples: 1, debug: { spray: 0, buoyancy: 1 },
		pos: [ 0, 0.2, 0 ],
	} );
	need( 'a one-sample crate still has a centre buoyancy marker',
		crate.debugContacts()?.buoyancy?.length === 1
		&& crate.debugContacts()?.buoyancy?.[ 0 ]?.role === 'center'
		&& ( crate.debugContacts()?.spray?.length ?? 0 ) === 0,
		`n ${ crate.debugContacts()?.buoyancy?.length }` );
}

{
	const list = new BodyList();
	const beast = list.add( null, {
		mass: 4e4, float: false, swell: true, wake: false,
		size: { x: 4, y: 6, z: 60 }, length: 60,
		pos: [ 0, 0, 0 ],
	} );
	beast.sprayLook = 'dragon';
	beast.sprayStations = {
		minZ: - 30, maxZ: 30,
		top: new Float32Array( 8 ).fill( 2 ),
		low: new Float32Array( 8 ).fill( - 2 ),
		half: new Float32Array( 8 ).fill( 1.2 ),
	};
	beast.attach( {
		pos: [ 0, 0, 0 ], heading: 0, speed: 14, phase: 0,
		active: true, jumpAirborne: false, pitch: 0,
	} );
	list.swellState( 0.05, { seaLevel: 0, params: { sdFluke: 2, sdFlukeSize: 8.9 } } );
	beast.controller.phase = 1.6;
	const slick = list.swellState( 0.05, { seaLevel: 0, params: { sdFluke: 2, sdFlukeSize: 8.9 } } );
	need( 'BodyList drops a fluke print on a tail stroke',
		( slick?.flukes?.length ?? 0 ) >= 1,
		`n ${ slick?.flukes?.length }` );
}

{
	need( 'pierce:true is a circular pole at the middle top',
		( () => {

			const c = parsePierce( true, { x: 4, y: 6, z: 24 }, { length: 24 } );
			return c && c.half == null && c.along === 0 && c.up === 1
				&& c.r > 0.2 && c.gain === 1 && c.life > 0;

		} )() );
	need( 'pierce.on 0 is off even when radius is set',
		parsePierce( { on: 0, r: 2, gain: 3 }, { x: 2, y: 2, z: 4 } ) === null );
	need( 'a number is gain on the pole defaults',
		Math.abs( parsePierce( 2, { x: 2, y: 2, z: 4 } ).gain - 2 ) < 1e-9 );

	const pole = new OceanBody( null, {
		mass: 4e4, float: false, wake: false,
		size: { x: 4, y: 6, z: 24 }, length: 24,
		pierce: true,
		pos: [ 10, 0, 20 ],
	} );
	const top = pole.piercePoint();
	need( 'the default point sits on the AABB roof, mid-length',
		top && Math.abs( top.x - 10 ) < 1e-9 && Math.abs( top.z - 20 ) < 1e-9
		&& Math.abs( top.y - 3 ) < 1e-9,
		`p ${ top?.x },${ top?.y },${ top?.z }` );

	const high = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 }, pierce: true, pos: [ 0, 8, 0 ],
	} );
	need( 'a rod well above the sea does not cut',
		high.pierceSite( { seaLevel: 0 } ) === null );

	const wet = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 }, length: 24,
		pierce: { on: 1, r: 0.4, gain: 1, height: 2 },
		pos: [ 0, - 3.05, 0 ], heading: 0, speed: 6,
	} );
	wet.vel[ 0 ] = 0;
	wet.vel[ 2 ] = - 6;
	const site = wet.pierceSite( { seaLevel: 0 } );
	need( 'a rod at the waterline opens a circular well down to the base',
		site && site.half === 0 && Math.abs( site.r - 0.4 ) < 1e-9
		&& site.well > 0.04 && site.well < 0.08
		&& Math.abs( site.x ) < 1e-6 && Math.abs( site.z ) < 1e-6,
		`half ${ site?.half } r ${ site?.r } well ${ site?.well }` );
	need( 'the pole carries the body heading as travel',
		site && Math.abs( site.vz + 6 ) < 1e-6,
		`vz ${ site?.vz }` );

	const short = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 },
		pierce: { on: 1, height: 1 },
		pos: [ 0, - 12, 0 ],
	} );
	need( 'a rod that does not reach the sea does not cut',
		short.pierceSite( { seaLevel: 0 } ) === null );

	const long = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 },
		pierce: { on: 1, height: 12 },
		pos: [ 0, - 12, 0 ],
	} );
	const shaft = long.pierceSite( { seaLevel: 0 } );
	need( 'a taller rod punches a well equal to how far the base sits under',
		shaft && Math.abs( shaft.well - 9 ) < 1e-6 && shaft.height === 12,
		`well ${ shaft?.well } height ${ shaft?.height }` );

	const list = new BodyList();
	const ski = list.add( null, { ...SKI, pos: [ 0, 0.3, 0 ] } );
	const beast = list.add( null, {
		mass: 4e4, float: false, wake: false,
		size: { x: 4, y: 6, z: 24 }, pierce: true, pos: [ 0, - 2.9, 0 ],
	} );
	need( 'BodyList hands the pierce slot to the mesh that asked for it',
		list.primaryPierce() === beast && list.pierceState( { seaLevel: 0 } )?.half === 0
		&& ski.pierceConfig() === null );

	const shown = new OceanBody( null, {
		size: { x: 2, y: 2, z: 4 }, pierce: true, pos: [ 0, 0, 0 ],
	} );
	const pack = shown.debugContacts();
	need( 'a live pierce hides the pole marker unless marker is on',
		! pack?.pierce?.length,
		`n ${ pack?.pierce?.length }` );

	const shownPole = new OceanBody( null, {
		size: { x: 2, y: 2, z: 4 },
		pierce: { on: 1, marker: 1 },
		pos: [ 0, 0, 0 ],
	} );
	const shownPack = shownPole.debugContacts();
	need( 'marker 1 draws the amber pole without debug:true',
		shownPack?.pierce?.length === 1 && shownPack.pierce[ 0 ].role === 'pole'
		&& Math.abs( shownPack.pierce[ 0 ].y - 1 ) < 1e-9
		&& shownPack.pierce[ 0 ].height > 0,
		`n ${ shownPack?.pierce?.length } y ${ shownPack?.pierce?.[ 0 ]?.y } h ${ shownPack?.pierce?.[ 0 ]?.height }` );

	const ghost = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 }, length: 24,
		pierce: { on: 1, r: 0.4, height: 12, marker: 0 },
		pos: [ 0, - 12, 0 ],
	} );
	need( 'marker 0 hides the amber pole without turning the cut off',
		( ! ghost.debugContacts()?.pierce?.length )
		&& ghost.pierceSite( { seaLevel: 0 } )?.well > 1,
		`n ${ ghost.debugContacts()?.pierce?.length } well ${ ghost.pierceSite( { seaLevel: 0 } )?.well }` );

	const trail = new BodyList();
	const cutter = trail.add( null, {
		size: { x: 4, y: 6, z: 24 },
		pierce: { on: 1, height: 12, life: 4, r: 0.4 },
		pos: [ 0, - 12, 0 ], speed: 8,
	} );
	cutter.speed = 8;
	trail.stepPierceCarve( 0.05, { seaLevel: 0 } );
	for ( let i = 0; i < 24; i ++ ) {

		cutter.pos[ 2 ] -= 0.6;
		trail.stepPierceCarve( 0.05, { seaLevel: 0 } );

	}
	need( 'a moving rod lays a leftover trench BodyList can age',
		trail.carve.stamps.length >= 2
		&& pierceCarveAt( 0, - 6, trail.carve ).h < - 0.4,
		`n ${ trail.carve.stamps.length } h ${ pierceCarveAt( 0, - 6, trail.carve ).h.toFixed( 3 ) }` );
	const n = trail.carve.stamps.length;
	cutter.pierce = false;
	trail.stepPierceCarve( 0.05, { seaLevel: 0 } );
	need( 'turning pierce off leaves the trench to fade',
		trail.carve.stamps.length === n
		&& pierceCarveAt( 0, - 6, trail.carve ).h < - 0.2,
		`n ${ trail.carve.stamps.length } was ${ n }` );

	const ridge = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 }, length: 24,
		pierce: { on: 1, r: 0.35, life: 4 },
		pos: [ 0, 0, 0 ], heading: 0, speed: 8,
	} );
	ridge.sprayStations = {
		minZ: - 12, maxZ: 12,
		top: new Float32Array( 8 ).fill( 2 ),
		low: new Float32Array( 8 ).fill( - 2 ),
		half: new Float32Array( 8 ).fill( 0.8 ),
	};
	ridge.surf = 0;
	ridge._primed = true;
	const slit = ridge.pierceSite( { seaLevel: 0 } );
	need( 'a profiled mesh cuts along the waterline, not as a dorsal pole',
		slit && slit.half > 4 && slit.well < 1 && slit.well > 0.1
		&& Math.abs( slit.x ) < 0.2 && Math.abs( slit.z ) < 0.2,
		`half ${ slit?.half } well ${ slit?.well } xz ${ slit?.x },${ slit?.z }` );
	need( 'the leftover trail follows the aft of that cut',
		Number.isFinite( slit?.tx ) && Number.isFinite( slit?.tz )
		&& Math.abs( slit.tz ) > 2,
		`tz ${ slit?.tz }` );
	const sunk = new OceanBody( null, {
		size: { x: 4, y: 6, z: 24 },
		pierce: { on: 1, r: 0.35 },
		pos: [ 0, - 20, 0 ],
	} );
	sunk.sprayStations = ridge.sprayStations;
	need( 'a fully submerged profile does not invent a pole cut',
		sunk.pierceSite( { seaLevel: 0 } ) === null );
}

{
	const boat = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1, beam: 3.2, foam: 0.8, wave: 2, v: 1 },
		hull: { push: 0.16, radius: 2.1, bow: 0.2 },
		pierce: { on: 1, r: 0.4, life: 6 },
	} );
	boat.heading = 0;
	boat.speed = hullSpeed( 12 );
	boat.vel[ 2 ] = - boat.speed;
	boat.airborne = false;
	boat.wet = true;
	const cfg = boat.wakeConfig();
	const dims = boat.wakeRenderDims( { floorDepth: 40 } );
	need( 'wake.physics is the gravity-wave experiment',
		isPhysicsWake( cfg ) && dims.physicsOn === 1 && dims.physicsAmp > 0.2,
		`on ${ dims.physicsOn } A ${ dims.physicsAmp?.toFixed?.( 3 ) }` );
	need( 'physics mode does not stamp leftover foam or rings',
		boat.asWakeSource( {} ) === null );
	need( 'physics leftover foam is the energy film when wake.foam is on',
		boat.asFoamSource( {} ) && boat.asFoamSource( {} ).foamBeam > 3,
		`foam ${ boat.asFoamSource( {} )?.foamBeam }` );
	boat.lag[ 0 ] = 1.25;
	boat.lag[ 1 ] = - 0.80;
	const shiftedFoam = boat.asFoamSource( {} );
	const shiftedSurf = boat.surfXZ();
	const expectedBowZ = shiftedSurf[ 1 ] - boat.length * 0.48;
	need( 'foam stamps use the undisplaced hull coordinate in steep waves',
		Math.abs( shiftedFoam.stampB[ 0 ] - shiftedSurf[ 0 ] ) < 1e-6
			&& Math.abs( shiftedFoam.stampB[ 1 ] - expectedBowZ ) < 1e-6,
		`stamp ${ shiftedFoam?.stampB } surf ${ shiftedSurf }` );
	const shiftedCuts = leftoverWriteSites( boat, { xz: shiftedSurf } );
	need( 'leftover waterline cuts use that same reference frame',
		shiftedCuts.length > 0
			&& shiftedCuts.every( ( s ) => Math.abs( s.x - boat.pos[ 0 ] ) > 0.2 ),
		`first ${ shiftedCuts[ 0 ]?.x?.toFixed?.( 2 ) } lag ${ boat.lag[ 0 ].toFixed( 2 ) }` );
	boat.lag[ 0 ] = 0;
	boat.lag[ 1 ] = 0;
	const dryFoam = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, foam: 0 },
		pos: [ 0, 0, 0 ],
	} );
	dryFoam.speed = hullSpeed( 12 );
	dryFoam.wet = true;
	need( 'foam 0 on a physics hull still writes no energy film',
		dryFoam.asFoamSource( {} ) === null );
	const jetOnly = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, foam: 0, motor: 0.5 },
		pos: [ 0, 0, 0 ],
	} );
	jetOnly.speed = hullSpeed( 12 );
	jetOnly.wet = true;
	need( 'a jet tail still writes the energy film when the ribbon is off',
		jetOnly.asFoamSource( {} ) !== null
			&& jetOnly.wakeConfig().motor === 0.5
			&& jetOnly.wakeConfig().jet.on === 1 );
	const list = new BodyList();
	list.items.push( boat );
	need( 'physics mode refuses the occupancy cut',
		list.pierceState( { seaLevel: 0 } ) === null );
	need( 'physics mode replaces the analytic vertex hollow with contact shading',
		boat.hullState()?.push === 0,
		`push ${ boat.hullState()?.push }` );
	need( 'the shared slot still uploads the gravity-wave dims',
		list.physicsWakeDims( { floorDepth: 40 } )?.physicsOn === 1 );
}

{
	const boat = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4, foam: 0, bubbles: 1 },
		pos: [ 0, 0, 0 ],
	} );
	boat.heading = 0;
	boat.speed = hullSpeed( 12 );
	boat.vel[ 2 ] = - boat.speed;
	boat.airborne = false;
	boat.wet = true;
	const list = new BodyList();
	list.add( boat );
	for ( let i = 0; i < 8; i ++ ) list.stepBubbles( 0.05, { seaLevel: 0 } );
	need( 'a physics hull with wake.bubbles births leftover specks',
		list.bubbles.count > 0,
		`n ${ list.bubbles.count }` );
	need( 'those specks stay off the deck',
		list.bubbles.live().every( ( p ) => {

			const hx = leftoverBubbleHull( boat );
			return ! leftoverBubbleInHull( p.x, p.z, hx );

		} ),
		`onDeck ${ list.bubbles.live().filter( ( p ) => leftoverBubbleInHull( p.x, p.z, leftoverBubbleHull( boat ) ) ).length }` );
	need( 'splash is in the air and foam sits on the sea',
		list.bubbles.live().every( ( p ) => p.kind === 'splash' ? p.y > - 0.02 : p.y > - 0.2 ),
		`kinds ${ list.bubbles.live().map( ( p ) => `${ p.kind }@${ p.y.toFixed( 2 ) }` ).slice( 0, 4 ) }` );
	const parked = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, foam: 0, bubbles: 1 },
		pos: [ 20, 0, 0 ],
	} );
	parked.speed = 0;
	parked.wet = true;
	const idle = new BodyList();
	idle.add( parked );
	idle.stepBubbles( 0.05, { seaLevel: 0 } );
	need( 'a parked hull with wake.bubbles still births nothing',
		idle.bubbles.count === 0 );
}

{
	const boat = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
		pierce: { on: 0 },
		pos: [ 0, 0, 0 ],
	} );
	boat.heading = 0;
	boat.speed = hullSpeed( 12 );
	boat.vel[ 2 ] = - boat.speed;
	boat.airborne = false;
	boat.wet = true;
	const list = new BodyList();
	list.items.push( boat );
	const dt = 1 / 60;
	const mark = [ 0, 0 ];
	for ( let i = 0; i < 240; i ++ ) {

		boat.pos[ 2 ] -= boat.speed * dt;
		list.stepRipples( dt, { floorDepth: 40 } );

	}
	let passed = 0;
	for ( let z = - 4; z <= 4; z += 1 ) {

		passed = Math.max( passed, Math.abs( list.ripples.sampleAt( mark[ 0 ], mark[ 1 ] + z ) ) );

	}
	const still = list.ripples.energy();
	need( 'a physics hull leaves leftover height at a world point it already passed',
		passed > 0.02 && still > 0.05,
		`h@origin ${ passed.toFixed( 3 )}  E ${ still.toFixed( 3 )}` );
	let sourcePeak = { source: 0, raw: 0, surface: 0 };
	for ( let x = - 2; x <= 2; x += 0.5 ) {

		for ( let z = - 6; z <= 6; z += 1 ) {

			const wx = boat.pos[ 0 ] + x;
			const wz = boat.pos[ 2 ] + z;
			const source = list.ripples.sampleSourceAt( wx, wz );
			if ( source > sourcePeak.source ) sourcePeak = {
				source,
				raw: list.ripples.sampleAt( wx, wz ),
				surface: list.ripples.sampleSurfaceAt( wx, wz ),
			};

		}

	}
	need( 'the live source keeps generating waves but is not rendered as a hull hole',
		sourcePeak.source > 0.2
			&& sourcePeak.surface > sourcePeak.raw + sourcePeak.source * 0.99
			&& sourcePeak.surface > - 0.4,
		`raw ${ sourcePeak.raw.toFixed( 3 )} source ${ sourcePeak.source.toFixed( 3 )} visible ${ sourcePeak.surface.toFixed( 3 )}` );
	const hullZ = boat.pos[ 2 ];
	need( 'that leftover is not a V glued to the mesh — origin is well astern',
		hullZ < - 14,
		`hull z ${ hullZ.toFixed( 2 )}` );

	const parked = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
		pos: [ 80, 0, 80 ],
	} );
	parked.heading = 0;
	parked.speed = 0;
	parked.vel[ 2 ] = 0;
	parked.airborne = false;
	parked.wet = true;
	const idle = new BodyList();
	idle.items.push( parked );
	for ( let i = 0; i < 30; i ++ ) idle.stepRipples( dt, { floorDepth: 40 } );
	need( 'a parked physics hull writes no leftover waves',
		idle.ripples.energy() < 1e-6,
		`E ${ idle.ripples.energy() }` );

}

{
	const crawl = new BodyList();
	const boat = crawl.add( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.75, beam: 3.4, foam: 0.82, motor: 0.4 },
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0;
	boat.speed = 0.62;
	boat.vel[ 2 ] = - 0.62;
	boat.wet = true;
	boat.airborne = false;
	boat.topSpeed = 51;
	for ( let i = 0; i < 180; i ++ ) crawl.stepRipples( 1 / 60, { seaLevel: 0 } );
	need( 'a 1.2 kn crawl does not keep pumping leftover boil',
		0.62 < LEFTOVER_SPLASH_MIN_SPEED
			&& crawl.ripples.peak().height < 0.35,
		`peak ${ crawl.ripples.peak().height.toFixed( 3 ) }` );

	const idleTab = new BodyList();
	const jet = idleTab.add( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.75, beam: 3.4, foam: 0.82, motor: 0.4 },
		pos: [ 0, 0.2, 0 ],
	} );
	jet.heading = 0;
	jet.speed = 18;
	jet.vel[ 2 ] = - 18;
	jet.wet = true;
	jet.airborne = false;
	jet.topSpeed = 51;
	for ( let i = 0; i < 240; i ++ ) idleTab.stepRipples( 0.1, { seaLevel: 0 } );
	need( 'leftover height stays on the water even if boil keeps firing',
		idleTab.ripples.peak().height <= LEFTOVER_HEIGHT_CAP + 1e-6
			&& idleTab.ripples.h.every( Number.isFinite ),
		`peak ${ idleTab.ripples.peak().height.toFixed( 3 ) }` );

	const silent = new BodyList();
	const parkedJet = silent.add( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.75, beam: 3.4, foam: 0.82, motor: 0.4, emit: 0 },
		pos: [ 0, 0.2, 0 ],
	} );
	parkedJet.heading = 0;
	parkedJet.speed = 18;
	parkedJet.vel[ 2 ] = - 18;
	parkedJet.wet = true;
	parkedJet.airborne = false;
	parkedJet.topSpeed = 51;
	for ( let i = 0; i < 45; i ++ ) silent.stepRipples( 1 / 60, { seaLevel: 0 } );
	need( 'emit 0 writes no leftover, including bow/motor boil',
		silent.ripples.energy() < 1e-5,
		`E ${ silent.ripples.energy() }` );

	const leftoverAfterPark = ( damp ) => {

		const list = new BodyList();
		const boat = list.add( null, {
			mass: 8200, float: true,
			size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
			wake: { on: 1, physics: 1, strength: 1, beam: 3.4, foam: 0, motor: 0, damp },
			pos: [ 0, 0.2, 0 ],
		} );
		boat.heading = 0;
		boat.speed = 12;
		boat.vel[ 2 ] = - 12;
		boat.wet = true;
		boat.airborne = false;
		const dt = 1 / 60;
		for ( let i = 0; i < 60; i ++ ) {

			boat.pos[ 2 ] -= boat.speed * dt;
			list.stepRipples( dt, { seaLevel: 0 } );

		}
		boat.speed = 0;
		boat.vel[ 2 ] = 0;
		for ( let i = 0; i < 50; i ++ ) list.stepRipples( dt, { seaLevel: 0 } );
		return list.ripples.energy();

	};
	const shortLife = leftoverAfterPark( 0.3 );
	const longLife = leftoverAfterPark( 1.8 );
	need( 'wave life 0.3 dies leftover before the default 1.8 persist',
		shortLife < longLife * 0.65,
		`0.3 ${ shortLife.toFixed( 2 )}  1.8 ${ longLife.toFixed( 2 )}` );

}

{
	const list = new BodyList();
	const boat = list.add( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.35, beam: 3.4, foam: 1.1, motor: 0 },
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0;
	boat.speed = 12;
	boat.vel[ 2 ] = - 12;
	boat.wet = true;
	boat.airborne = false;
	for ( let i = 0; i < 45; i ++ ) list.stepRipples( 1 / 60, { seaLevel: 0 } );
	const bowH = Math.abs( list.ripples.sampleAt( boat.pos[ 0 ], boat.pos[ 2 ] - 6 ) );
	const midH = Math.abs( list.ripples.sampleAt( boat.pos[ 0 ], boat.pos[ 2 ] ) );
	const quiet = new BodyList();
	const dry = quiet.add( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12, beam: 3.4,
		wake: { on: 1, physics: 1, strength: 0.35, beam: 3.4, foam: 0, motor: 0 },
		pos: [ 0, 0.2, 0 ],
	} );
	dry.heading = 0;
	dry.speed = 12;
	dry.vel[ 2 ] = - 12;
	dry.wet = true;
	dry.airborne = false;
	for ( let i = 0; i < 45; i ++ ) quiet.stepRipples( 1 / 60, { seaLevel: 0 } );
	const dryBow = Math.abs( quiet.ripples.sampleAt( dry.pos[ 0 ], dry.pos[ 2 ] - 6 ) );
	need( 'foam ribbon drives a bow-entry height boil like the motor jet',
		bowH > midH * 0.45 && bowH > dryBow + 0.03,
		`bow ${ bowH.toFixed( 3 ) } mid ${ midH.toFixed( 3 ) } dry ${ dryBow.toFixed( 3 ) }` );
}

{
	const list = new BodyList();
	const boat = list.add( null, {
		mass: 8200, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0;
	boat.speed = hullSpeed( 12 );
	boat.vel[ 2 ] = - boat.speed;
	boat.wet = true;
	boat.airborne = false;
	const dt = 1 / 60;
	for ( let i = 0; i < 240; i ++ ) {

		boat.pos[ 2 ] -= boat.speed * dt;
		list.stepRipples( dt, { floorDepth: 40 } );

	}
	const hullZ = boat.pos[ 2 ];
	boat.heading = Math.PI * 0.5;
	boat.speed = hullSpeed( 12 );
	boat.vel[ 0 ] = boat.speed;
	boat.vel[ 2 ] = 0;
	const trackAt = ( field ) => {

		let h = 0;
		for ( let x = - 3; x <= 3; x += 1 ) {

			for ( let z = hullZ + 6; z <= hullZ + 14; z += 1 ) {

				h = Math.max( h, Math.abs( field.sampleAt( x, z ) ) );

			}

		}
		return h;

	};
	const oldTrack = trackAt( list.ripples );
	for ( let i = 0; i < 90; i ++ ) {

		boat.pos[ 0 ] += boat.speed * dt;
		list.stepRipples( dt, { floorDepth: 40 } );

	}
	const afterTurn = trackAt( list.ripples );
	need( 'turning leaves the old track in world XZ — leftover does not rotate with the mesh',
		afterTurn > 0.008,
		`old-track ${ oldTrack.toFixed( 3 )} → ${ afterTurn.toFixed( 3 )}` );
}

{
	const drive = ( speed, frames ) => {

		const boat = new OceanBody( null, {
			mass: 8000, float: true,
			size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
			wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
			pos: [ 0, 0, 0 ],
		} );
		boat.heading = 0;
		boat.speed = speed;
		boat.vel[ 2 ] = - speed;
		boat.airborne = false;
		boat.wet = true;
		const list = new BodyList();
		list.items.push( boat );
		const dt = 1 / 60;
		for ( let i = 0; i < frames; i ++ ) {

			boat.pos[ 2 ] -= speed * dt;
			list.stepRipples( dt, { floorDepth: 40 } );

		}
		const xz = boat.surfXZ();
		let peak = 0;
		for ( let a = 6; a <= 28; a += 2 ) {

			peak = Math.max( peak, Math.abs( list.ripples.sampleAt( xz[ 0 ], xz[ 1 ] + a ) ) );

		}
		return { peak, energy: list.ripples.energy(), body: boat, list };

	};
	const hull = drive( hullSpeed( 12 ), 180 );
	const plane = drive( 1.15 * Math.sqrt( 9.81 * 12 ), 180 );
	need( 'a fast hull leaves leftover astern, not only a slowing one',
		plane.peak > 0.08,
		`hull E ${ hull.energy.toFixed( 1 )} peak ${ hull.peak.toFixed( 3 )}  `
		+ `plane E ${ plane.energy.toFixed( 1 )} peak ${ plane.peak.toFixed( 3 )}` );
	need( 'a planing physics hull still owns the leftover slot',
		plane.list.physicsWakeBody( { floorDepth: 40 } ) === plane.body );
	need( 'leftover debug look is off until asked',
		new BodyList().rippleDebug === 0 && new BodyList().rippleVis === 1 );
	need( 'physics leftover is the 256² / 320 m tile, not 384²',
		new BodyList().ripples.size === LEFTOVER_TILE.size
			&& new BodyList().rippleBands.length === 3
			&& new BodyList().ripples.heightCap === LEFTOVER_HEIGHT_CAP,
		`${ new BodyList().ripples.size }² cap ${ new BodyList().ripples.heightCap }` );
}

{
	const list = new BodyList();
	const boat = list.add( null, {
		mass: 8000, float: true, hover: 0,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
		pos: [ 0, 0, 0 ],
	} );
	boat.wet = true;
	boat.airborne = false;
	const y0 = boat.pos[ 1 ];
	const stamp = ( amp ) => {

		const f = list.ripples;
		f.h.fill( 0 );
		const reach = 8 / f.cell;
		for ( let z = 0; z < f.size; z ++ ) {

			for ( let x = 0; x < f.size; x ++ ) {

				if ( Math.hypot( x - f.mid, z - f.mid ) <= reach ) f.h[ z * f.size + x ] = amp;

			}

		}

	};
	stamp( 0.70 );
	for ( let i = 0; i < 36; i ++ ) list.step( 1 / 60, { seaLevel: 0 } );
	need( 'a leftover crest is real water — the hull heaves with it',
		boat.surf > 0.40 && boat.pos[ 1 ] > y0 + 0.35,
		`surf ${ boat.surf.toFixed( 3 )}  y ${ boat.pos[ 1 ].toFixed( 3 )}  from ${ y0.toFixed( 3 )}` );
	const yCrest = boat.pos[ 1 ];
	stamp( - 0.70 );
	for ( let i = 0; i < 36; i ++ ) list.step( 1 / 60, { seaLevel: 0 } );
	need( 'a leftover trough drops the hull',
		boat.pos[ 1 ] < yCrest - 0.40,
		`crest ${ yCrest.toFixed( 3 )}  trough ${ boat.pos[ 1 ].toFixed( 3 )}` );
}

{
	const boat = new OceanBody( null, {
		mass: 8000, float: true,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
		debug: { emit: 1, spray: 0, buoyancy: 0 },
		pos: [ 0, 0, 0 ],
	} );
	boat.heading = 0;
	boat.speed = 0;
	const parked = boat.debugContacts( { seaLevel: 0 } );
	need( 'emit debug draws the waterline cuts on a physics hull',
		( parked?.emit?.length ?? 0 ) >= 8,
		`n ${ parked?.emit?.length }` );
	need( 'a parked hull marks emit points as not live',
		parked.emit.every( ( p ) => p.live === false && p.strength === 0 ) );
	const bow = parked.emit.find( ( p ) => p.role === 'bow' );
	const stern = parked.emit.find( ( p ) => p.role === 'stern' );
	need( 'emit bow sits ahead of the origin (heading 0 is −Z)',
		bow && stern && bow.z < 0 && stern.z > 0,
		`bow z ${ bow?.z?.toFixed?.( 2 )}  stern z ${ stern?.z?.toFixed?.( 2 )}` );
	need( 'emit points stay on the hull, not out in a wide cradle',
		parked.emit.every( ( p ) => Math.abs( p.x ) < 2.2 && Math.abs( p.z ) < 7 ),
		`max |x| ${ Math.max( ...parked.emit.map( ( p ) => Math.abs( p.x ) ) ).toFixed( 2 )}` );
	const skiLeft = new OceanBody( null, {
		...{ beam: 1.1, length: 12 },
		size: { x: 3.4, y: 1.4, z: 12 },
		wake: { on: 1, physics: 1, strength: 1 },
		debug: { emit: 1 },
		pos: [ 0, 0, 0 ],
		speed: hullSpeed( 12 ),
	} );
	skiLeft.speed = hullSpeed( 12 );
	const skiEmit = skiLeft.debugContacts( { seaLevel: 0 } )?.emit ?? [];
	need( 'a leftover SKI beam does not pull emit off the box edges',
		Math.max( ...skiEmit.map( ( p ) => Math.abs( p.x ) ) ) > 1.5,
		`max |x| ${ Math.max( 0, ...skiEmit.map( ( p ) => Math.abs( p.x ) ) ).toFixed( 2 )}` );
	boat.speed = hullSpeed( 12 );
	const live = boat.debugContacts( { seaLevel: 0 } );
	need( 'a moving hull marks emit points live — those are the writes',
		live.emit.some( ( p ) => p.live ),
		`live ${ live.emit.filter( ( p ) => p.live ).length }` );
	const bowLive = live.emit.find( ( p ) => p.role === 'bow' );
	const midLive = live.emit.find( ( p ) => p.role === 'port' && Math.abs( p.along ) < 0.2 );
	need( 'the bow emit is hotter than midship — leftover is not one green tube',
		bowLive && midLive && bowLive.strength > midLive.strength * 2,
		`bow ${ bowLive?.strength?.toFixed?.( 2 )}  mid ${ midLive?.strength?.toFixed?.( 2 )}` );
	boat.roll = - 0.32;
	const heeled = boat.debugContacts( { seaLevel: 0 } );
	const stbd = heeled.emit.filter( ( p ) => p.role === 'starboard' )
		.reduce( ( s, p ) => s + p.strength, 0 );
	const port = heeled.emit.filter( ( p ) => p.role === 'port' )
		.reduce( ( s, p ) => s + p.strength, 0 );
	need( 'a rolled hull writes leftover on the low chine, not both sides equally',
		stbd > port * 1.6,
		`stbd ${ stbd.toFixed( 2 )}  port ${ port.toFixed( 2 )}` );
	need( 'emit debug and leftover writes share the same cut count',
		heeled.emit.length === leftoverWriteSites( boat ).length,
		`emit ${ heeled.emit.length }  write ${ leftoverWriteSites( boat ).length }` );
	const quiet = new OceanBody( null, {
		wake: { on: 1, physics: 1 }, size: { x: 3.4, y: 1, z: 12 }, length: 12,
		pos: [ 0, 0, 0 ],
	} );
	need( 'emit debug is off until asked',
		! quiet.debugContacts()?.emit?.length );
	need( 'the list emit flag shows occupancy without body.debug',
		( debugContacts( quiet, { emit: 1, seaLevel: 0 } )?.emit?.length ?? 0 ) >= 8 );
	need( 'the list buoyancy flag shows hull probes without body.debug',
		debugContacts( quiet, { buoyancy: 1, seaLevel: 0 } )?.buoyancy?.length >= 4,
		`n ${ debugContacts( quiet, { buoyancy: 1, seaLevel: 0 } )?.buoyancy?.length }` );
}

{
	const box = new OceanBody( null, {
		mass: 8000, float: true, hover: 0.05,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1 },
		probeLayout: 'corners',
		rotationInfluence: 1,
		pos: [ 0, 0.2, 0 ],
	} );
	box.heading = 0;
	const pts = box.probePoints();
	const names = [ 'bow-port', 'bow-starboard', 'stern-port', 'stern-starboard' ];
	need( 'a physics hull rides the AABB corners, not mid-edge stations',
		box.probeLayout === 'corners' && pts.length === 4,
		`n ${ pts.length }  layout ${ box.probeLayout }` );
	need( 'bow corners sit ahead of the origin (heading 0 is −Z)',
		pts[ 0 ][ 1 ] < - 5.4 && pts[ 1 ][ 1 ] < - 5.4,
		`bow z ${ pts[ 0 ][ 1 ].toFixed( 2 )} / ${ pts[ 1 ][ 1 ].toFixed( 2 )}` );
	need( 'stern corners sit aft of the origin',
		pts[ 2 ][ 1 ] > 5.4 && pts[ 3 ][ 1 ] > 5.4,
		`stern z ${ pts[ 2 ][ 1 ].toFixed( 2 )} / ${ pts[ 3 ][ 1 ].toFixed( 2 )}` );
	need( 'port / starboard corners sit on the beam',
		pts[ 0 ][ 0 ] < - 1.5 && pts[ 1 ][ 0 ] > 1.5
		&& pts[ 2 ][ 0 ] < - 1.5 && pts[ 3 ][ 0 ] > 1.5,
		`x ${ pts.map( ( p ) => p[ 0 ].toFixed( 2 ) ).join( ' ' )}` );
	need( 'corner pitch is bow-pair vs stern-pair',
		hullPitchFrom( [ 0.4, 0.4, - 0.4, - 0.4 ], 6, 1, 'corners' ) > 0.06
		&& hullPitchFrom( [ 0.4, 0.4, - 0.4, - 0.4 ], 6, 1, 'corners' )
			> hullPitchFrom( [ 0, 0, 0, 0 ], 6, 1, 'corners' ) + 0.05 );
	need( 'corner roll is starboard-pair vs port-pair',
		hullRollFrom( [ - 0.3, 0.3, - 0.3, 0.3 ], 1.7, 1, 'corners' ) > 0.08 );
	const pack = debugContacts( box, { buoyancy: 1, seaLevel: 0 } );
	need( 'buoyancy debug names the four AABB corners',
		pack?.buoyancy?.map( ( p ) => p.role ).join( ',' ) === names.join( ',' ),
		`${ pack?.buoyancy?.map( ( p ) => p.role ) }` );
}

{
	const list = new BodyList();
	const boat = list.add( null, {
		mass: 8000, float: true, hover: 0.05,
		size: { x: 3.4, y: 1.4, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.2, beam: 3.4 },
		rotationInfluence: 0.85, heightSmoothing: 0.07,
		accel: 5, topSpeed: 16,
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0;
	boat.throttle = 0;
	boat.steer = 0;
	boat.vel[ 2 ] = - 2.2;
	boat.speed = 2.2;
	boat.wet = true;
	boat.airborne = false;
	const f = list.ripples;
	f.h.fill( 0 );
	for ( let z = 0; z < f.size; z ++ ) {

		const wz = ( z - f.mid ) * f.cell;
		const h = wz * 0.10;
		for ( let x = 0; x < f.size; x ++ ) f.h[ z * f.size + x ] = h;

	}
	const u0 = boat.speed;
	for ( let i = 0; i < 24; i ++ ) list.step( 1 / 60, { seaLevel: 0 } );
	need( 'a leftover face from astern moves the hull — speed is not glued',
		boat.speed > u0 + 0.12,
		`u ${ u0.toFixed( 2 )} → ${ boat.speed.toFixed( 2 )}` );
	need( 'leftover slope pitches the deck instead of leaving it level',
		Math.abs( boat.pitch ) > 0.04,
		`pitch ${ boat.pitch.toFixed( 3 )}` );
}

{
	const list = new BodyList();
	const boat = list.add( null, {
		mass: 8200, float: true, hover: 0.05,
		size: { x: 3.4, y: 1.25, z: 12 }, length: 12,
		wake: { on: 1, physics: 1, strength: 1.4, beam: 3.4 },
		heightSmoothing: 0.07, rotationSmoothing: 0.10, rotationInfluence: 0.85,
		accel: 5.5, topSpeed: 16, probeLayout: 'corners',
		pos: [ 0, 0.2, 0 ],
	} );
	boat.heading = 0;
	boat.throttle = 1;
	boat.steer = 0;
	boat.wet = true;
	boat.airborne = false;
	const U = hullSpeed( 12 );
	boat.vel[ 2 ] = - U;
	boat.speed = U;
	for ( let i = 0; i < 150; i ++ ) {

		list.step( 1 / 60, { seaLevel: 0 } );
		list.stepRipples( 1 / 60, {} );

	}
	let mark = null;
	for ( let a = 6; a <= 22; a ++ ) {

		const x = boat.pos[ 0 ], z = boat.pos[ 2 ] + a;
		const h = list.ripples.sampleAt( x, z );
		if ( ! mark || Math.abs( h ) > Math.abs( mark.h ) ) mark = { x, z, h };

	}
	need( 'a run leaves leftover astern to hit later',
		mark && Math.abs( mark.h ) > 0.08,
		`h ${ mark?.h?.toFixed?.( 3 )}  @ ${ mark?.z?.toFixed?.( 1 )}` );
	boat.heading = Math.PI;
	boat.vel[ 0 ] = 0;
	boat.vel[ 2 ] = U;
	boat.speed = U;
	let best = { d: 1e9, surf: 0, pitch: 0, peakSurf: 0, peakPitch: 0 };
	for ( let i = 0; i < 280; i ++ ) {

		list.step( 1 / 60, { seaLevel: 0 } );
		list.stepRipples( 1 / 60, {} );
		const d = Math.hypot( boat.pos[ 0 ] - mark.x, boat.pos[ 2 ] - mark.z );
		if ( d < 14 ) {

			best.peakSurf = Math.max( best.peakSurf, Math.abs( boat.surf ) );
			best.peakPitch = Math.max( best.peakPitch, Math.abs( boat.pitch ) );

		}
		if ( d < best.d ) best = {
			...best, d, surf: boat.surf, pitch: boat.pitch, y: boat.pos[ 1 ],
		};

	}
	need( 'running into leftover heaves or pitches the hull',
		best.d < 4 && ( best.peakSurf > 0.10 || best.peakPitch > 0.05 ),
		`d ${ best.d.toFixed( 2 )}  peak surf ${ best.peakSurf.toFixed( 3 )}  peak pitch ${ best.peakPitch.toFixed( 3 )}  leftover ${ mark.h.toFixed( 3 )}` );
}

// Running trim through the body. Flat water, so the only thing that can
// tilt the deck is the hull's own attitude against the water.
{
	const DEG = 180 / Math.PI;
	const hold = ( u, opts = {} ) => {

		const list = new BodyList();
		const boat = list.add( null, {
			mass: 82000, float: true, hover: 0.05,
			size: { x: 3.4, y: 2.4, z: 12 }, length: 12, beam: 3.4,
			wake: { on: 1, physics: 1, strength: 0.75, beam: 3.4 },
			heightSmoothing: 0.22, rotationSmoothing: 0.28, rotationInfluence: 0.38,
			accel: 5.5, topSpeed: 60, probeLayout: 'corners',
			pos: [ 0, 0.2, 0 ], ...opts,
		} );
		boat.heading = 0; boat.steer = 0; boat.wet = true;
		for ( let i = 0; i < 600; i ++ ) {

			// Pin the speed so this is steady-state trim, not the extra
			// bow-up a hull carries while it is still accelerating.
			boat.throttle = 0;
			boat.vel[ 0 ] = 0; boat.vel[ 2 ] = - u; boat.speed = u;
			list.step( 1 / 60, { seaLevel: 0, h: 0 } );

		}
		return boat.pitch * DEG;

	};
	const idle = hold( 0.4 );
	const humpDeck = hold( 6 );     // Fr 0.55
	const planeDeck = hold( 14 );   // Fr 1.29
	const fastDeck = hold( 45 );    // Fr 4.15
	need( 'tied-up-slow, the deck is flat to the water',
		Math.abs( idle ) < 0.5, `pitch ${ idle.toFixed( 2 ) }°` );
	need( 'plowing over the hump stands the bow up',
		humpDeck > 5, `pitch ${ humpDeck.toFixed( 2 ) }°` );
	need( 'getting onto plane brings the bow back down',
		planeDeck > 1.5 && planeDeck < humpDeck * 0.65,
		`hump ${ humpDeck.toFixed( 2 ) }°  plane ${ planeDeck.toFixed( 2 ) }°` );
	need( 'flat out the hull runs nearly level, riding on top of the water',
		fastDeck > 0.5 && fastDeck < planeDeck,
		`plane ${ planeDeck.toFixed( 2 ) }°  flat out ${ fastDeck.toFixed( 2 ) }°` );
	need( 'trim 0 restores a deck that only ever follows the wave',
		Math.abs( hold( 6, { trim: 0 } ) ) < 0.2,
		`pitch ${ hold( 6, { trim: 0 } ).toFixed( 2 ) }°` );
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
