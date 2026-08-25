#!/usr/bin/env node
// Gravity-wave numbers + leftover occupancy (src/wake-physics.js).
// Claims from the hull-speed / wave-equation picture:
//   Fr = U/√(gL), leftover c = √(gL/2π), hull speed when U = c,
//   a parked hull writes no dipole, hump writes harder than planing,
//   the following analytic field is still the ship-frame check.
//
//   node tools/check-wake-physics.mjs

import {
	froudeLength, hullSpeed, gravityWavelength, gravityWaveSpeed, wakeRegime,
	wavemakingGain, planingFraction, wakePhysicsAmp, wakePhysicsAt,
	wakePhysicsInfo, 	hullRippleSite, leftoverTileOrigin, rippleDisplaceGain, leftoverChurn, leftoverSurge,
	leftoverSlam, leftoverStationWeight, leftoverWriteSites, leftoverEmitStrength,
	leftoverWriteFootprint, leftoverBowSplashRadius, leftoverBowSplashGain, leftoverJetSplashSpan,
	wakePhysicsGeometryMask, WAKE_PHYS_MASK_AFT1,
	leftoverCutStations, leftoverCapStations, leftoverEmitMax,
	leftoverEmitPoints, leftoverHullDraft,
	LEFTOVER_BANDS, LEFTOVER_TILE, LEFTOVER_HEIGHT_CAP, leftoverSplashHeight,
	LEFTOVER_SPLASH_MIN_SPEED, leftoverBandSite,
	hullRunningTrim, hullTrimFromAccel,
	KELVIN_G, KELVIN_TAN, kelvinTan,
} from '../src/wake-physics.js';
import { RippleField } from '../src/ripple-field.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const L = 12;
const Uhull = hullSpeed( L );
const u = {
	head: [ 0, 0 ],
	fwd: [ 0, - 1 ],
	speed: Uhull,
	length: L,
	beam: 3.2,
	depth: 40,
	amp: 1,
	strength: 1,
};

// fwd = (0, −1): +Z is aft of the bow.
const at = ( along, lat, extra ) =>
	wakePhysicsAt( { x: lat, z: along }, { ...u, ...extra } );

{
	const Fr = froudeLength( Uhull, L );
	const lam = gravityWavelength( Uhull );
	need( 'hull speed is Fr ≈ 1/√(2π) ≈ 0.40',
		Math.abs( Fr - 1 / Math.sqrt( 2 * Math.PI ) ) < 1e-9,
		`Fr ${ Fr.toFixed( 4 ) }` );
	need( 'at hull speed one gravity wavelength fits the waterline',
		Math.abs( lam - L ) < 1e-6,
		`λ ${ lam.toFixed( 3 )}  L ${ L }` );
	need( 'Fr is U / √(g L)',
		Math.abs( froudeLength( 8, 16 ) - 8 / Math.sqrt( KELVIN_G * 16 ) ) < 1e-12 );
}

{
	need( 'slow displacement is plowing', wakeRegime( 0.18 ) === 'plow' );
	need( 'hull / hump speed is the transition', wakeRegime( 0.48 ) === 'hump' );
	need( 'high Fr is planing', wakeRegime( 1.1 ) === 'plane' );
}

{
	const plow = wavemakingGain( 0.16 );
	const hump = wavemakingGain( 0.50 );
	const plane = wavemakingGain( 1.25 );
	need( 'wavemaking peaks at the hump, not at a crawl',
		hump > plow * 1.6,
		`plow ${ plow.toFixed( 3 )}  hump ${ hump.toFixed( 3 )}` );
	need( 'planing relieves straight-line wavemaking',
		plane < hump * 0.45,
		`plane ${ plane.toFixed( 3 )}  hump ${ hump.toFixed( 3 )}` );
	need( 'a ski-scale Fr is mostly on plane',
		planingFraction( 2.4 ) > 0.95,
		`plane ${ planingFraction( 2.4 ).toFixed( 3 )}` );
}

// Running trim. A hull does not hold one attitude at every speed: it sits
// level at displacement, rears up climbing its own bow wave at the hump,
// then settles once it is riding on top of the water instead of through it.
{
	const DEG = 180 / Math.PI;
	const idle = hullRunningTrim( 0.08 ) * DEG;
	const hump = hullRunningTrim( 0.55 ) * DEG;
	const plane = hullRunningTrim( 1.3 ) * DEG;
	const flatOut = hullRunningTrim( 4.5 ) * DEG;
	need( 'a hull at displacement speed sits on its lines',
		idle < 0.2, `trim ${ idle.toFixed( 2 ) }°` );
	need( 'the bow rears up at the hump — plowing, not planing',
		hump > 5 && hump < 11 && hump > plane * 1.8,
		`hump ${ hump.toFixed( 2 ) }°  plane ${ plane.toFixed( 2 ) }°` );
	need( 'climbing onto plane drops the bow back to a few degrees',
		plane > 2 && plane < 5, `trim ${ plane.toFixed( 2 ) }°` );
	need( 'trim keeps easing as speed shortens the wetted length',
		flatOut < plane && flatOut > 0.5,
		`flat out ${ flatOut.toFixed( 2 ) }°  plane ${ plane.toFixed( 2 ) }°` );
	// One smooth curve, not a switch between named regimes. A jump would
	// snap the whole deck as the boat worked up through the hump, so test
	// for continuity rather than steepness: halving the sample spacing has
	// to halve the biggest step. A discontinuity would not shrink at all.
	const worstStep = ( h ) => {

		let worst = 0, prev = hullRunningTrim( 0 );
		for ( let Fr = h; Fr <= 6; Fr += h ) {

			const t = hullRunningTrim( Fr );
			worst = Math.max( worst, Math.abs( t - prev ) );
			prev = t;

		}
		return worst;

	};
	const coarse = worstStep( 0.01 );
	const fine = worstStep( 0.001 );
	need( 'trim sweeps smoothly across every regime boundary — no step to snap the deck',
		fine < coarse * 0.6,
		`Δ0.01 ${ ( coarse * DEG ).toFixed( 3 ) }°  Δ0.001 ${ ( fine * DEG ).toFixed( 3 ) }°` );

	need( 'opening the taps squats the stern and lifts the bow',
		hullTrimFromAccel( 5.5 ) > 0.02 && hullTrimFromAccel( - 5.5 ) < - 0.02,
		`accel ${ hullTrimFromAccel( 5.5 ).toFixed( 3 ) }  brake ${ hullTrimFromAccel( - 5.5 ).toFixed( 3 ) }` );
	need( 'the squat is bounded — full throttle cannot stand the boat on its transom',
		Math.abs( hullTrimFromAccel( 500 ) ) < 0.07,
		`trim ${ hullTrimFromAccel( 500 ).toFixed( 3 ) }` );
}

{
	const bow = at( 0.15, 0 );
	const mid = at( L * 0.50, 0 );
	const stern = at( L * 0.92, 0 );
	need( 'displacement: bow is a crest',
		bow.h > 0.12,
		`bow ${ bow.h.toFixed( 3 ) }` );
	need( 'displacement: midship is a trough — the hole the hull sits in',
		mid.h < - 0.10,
		`mid ${ mid.h.toFixed( 3 ) }` );
	need( 'displacement: stern is a crest again (λ ≈ L)',
		stern.h > 0.08,
		`stern ${ stern.h.toFixed( 3 ) }` );
}

{
	const ahead = at( - 6, 0 );
	need( 'well ahead of the bow the sea stays quiet',
		Math.abs( ahead.h ) < 0.04,
		`h ${ ahead.h.toFixed( 3 ) }` );
}

{
	const parked = at( 20, 0, { speed: 0.2 } );
	need( 'a parked hull writes no gravity-wave wake',
		Math.abs( parked.h ) < 1e-6 );
}

{
	const alo = 36;
	const arm = 1.6 + alo * KELVIN_TAN;
	const onArm = at( alo, arm );
	need( 'the Kelvin arm carries real displacement',
		Math.abs( onArm.h ) > 0.05,
		`h ${ onArm.h.toFixed( 3 ) }` );
	// Diverging crests run at ~0.65 λ_t along the arm. Scan a wavelength
	// so a zero-crossing is not a miss.
	let pos = 0, neg = 0;
	const span = gravityWavelength( Uhull );
	for ( let i = 0; i <= 16; i ++ ) {

		const a = alo + span * i / 16;
		const h = at( a, 1.6 + a * KELVIN_TAN ).h;
		if ( h > 0.02 ) pos ++;
		if ( h < - 0.02 ) neg ++;

	}
	need( 'height changes sign along the arm — a wave, not a tube',
		pos > 0 && neg > 0,
		`crests ${ pos }  troughs ${ neg }` );
}

{
	const mid = at( 40, 0 );
	need( 'the interior has transverse waves — the V is not a hollow groove',
		Math.abs( mid.h ) > 0.02,
		`centreline ${ mid.h.toFixed( 3 ) }` );
}

{
	const alo = 36;
	const arm = 1.6 + alo * KELVIN_TAN;
	const onArm = at( alo, arm );
	const out = at( alo, arm + 16 );
	need( 'outside the wedge the sea is flat',
		Math.abs( out.h ) < Math.abs( onArm.h ) * 0.18,
		`arm ${ onArm.h.toFixed( 3 )}  out ${ out.h.toFixed( 3 )}` );
}

{
	const humpU = { ...u, speed: 0.50 * Math.sqrt( KELVIN_G * L ) };
	const planeU = { ...u, speed: 1.30 * Math.sqrt( KELVIN_G * L ) };
	need( 'hump speed makes a taller wake than planing',
		wakePhysicsAmp( humpU ) > wakePhysicsAmp( planeU ) * 1.6,
		`hump ${ wakePhysicsAmp( humpU ).toFixed( 3 )}  plane ${ wakePhysicsAmp( planeU ).toFixed( 3 )}` );
}

{
	const deep = kelvinTan( 10, 60, 80 );
	const shallow = kelvinTan( 10, 60, 12 ); // Fr_h ≈ 0.92
	need( 'shallow water near critical depth opens the wake angle',
		shallow > deep * 1.5,
		`deep ${ deep.toFixed( 4 )}  shallow ${ shallow.toFixed( 4 )}` );
}

{
	const info = wakePhysicsInfo( u );
	need( 'info reports the hull-speed numbers the HUD will print',
		info.regime === 'hump'
		&& Math.abs( info.lambda - L ) < 1e-6
		&& info.amp > 0.2,
		`regime ${ info.regime } λ ${ info.lambda.toFixed( 2 )} A ${ info.amp.toFixed( 3 )}` );
}

{
	need( 'leftover waves travel at hull-speed c',
		Math.abs( gravityWaveSpeed( L ) - Uhull ) < 1e-12 );
	const site = hullRippleSite( {
		pos: [ 3, 0, - 8 ], heading: 0, speed: Uhull,
		length: L, size: { x: 3.2, z: L },
	} );
	need( 'the occupancy site is a hull-shaped stadium in world XZ',
		site && Math.abs( site.x - 3 ) < 1e-9 && Math.abs( site.z + 8 ) < 1e-9
		&& site.half > 4 && site.r > 1 && site.submerged > 0.3,
		`xz ${ site?.x },${ site?.z } half ${ site?.half } r ${ site?.r }` );
	need( 'occupancy sits on the mesh — not a cradle wider than the beam',
		site.half + site.r <= L * 0.52 && site.r <= 3.2 * 0.42 && site.soft < 0.7 && site.tight,
		`half+r ${ ( site.half + site.r ).toFixed( 2 )}  r ${ site.r.toFixed( 2 )}  soft ${ site.soft }` );
	need( 'the site aims with heading — +Z is aft when heading is 0',
		Math.abs( site.ax ) < 1e-9 && Math.abs( site.az + 1 ) < 1e-9,
		`a ${ site.ax },${ site.az }` );
	const tile = leftoverTileOrigin( site, 160, 0.38 );
	need( 'leftover tile origin sits aft of the hull so the V can open',
		tile.z > site.z + 40 && Math.abs( tile.x - site.x ) < 1e-9,
		`tile ${ tile.x.toFixed( 1 ) },${ tile.z.toFixed( 1 ) } hull ${ site.z }` );
	const parked = rippleDisplaceGain( { strength: 1 }, { speed: 0, length: L } );
	const hump = rippleDisplaceGain( { strength: 1 }, {
		speed: 0.50 * Math.sqrt( KELVIN_G * L ), length: L,
	} );
	const plane = rippleDisplaceGain( { strength: 1 }, {
		speed: 1.30 * Math.sqrt( KELVIN_G * L ), length: L,
	} );
	need( 'a parked hull writes no leftover dipole',
		parked < 1e-4, `gain ${ parked }` );
	need( 'a planing hull still writes leftover — speeding up is not silence',
		plane > 0.25 && plane > hump * 0.55,
		`hump ${ hump.toFixed( 3 )}  plane ${ plane.toFixed( 3 )}` );
	const crawl = rippleDisplaceGain( { strength: 1 }, {
		speed: 0.22 * Math.sqrt( KELVIN_G * L ), length: L,
	} );
	need( 'a faster hull writes harder leftover than a crawl',
		hump > crawl * 2.2,
		`crawl ${ crawl.toFixed( 3 )}  hump ${ hump.toFixed( 3 )}` );
	const planeSite = hullRippleSite( {
		pos: [ 0, 0, 0 ], heading: 0,
		speed: 1.30 * Math.sqrt( KELVIN_G * L ),
		length: L, size: { x: 3.2, z: L },
	} );
	need( 'a planing hull still occupies water',
		planeSite.submerged > 0.28,
		`sub ${ planeSite.submerged.toFixed( 3 )}` );
	const field = new RippleField( {
		size: 96, cell: 0.5, speed: 4, damping: 0, sponge: 6,
	} );
	const now = hullRippleSite( {
		pos: [ 0, 0, 0 ], heading: 0, speed: Uhull,
		length: L, size: { x: 3.2, z: L },
	} );
	const onHull = field.occupancyAt( 0, 0, now, 0.45 );
	const abeam = field.occupancyAt( 4.2, 0, now, 0.45 );
	need( 'the occupancy stamp stays on the hull — 4 m abeam is flat',
		abeam < 0.008 && onHull > 0.08,
		`abeam ${ abeam.toFixed( 4 )}  hull ${ onHull.toFixed( 3 )}` );
}

{
	need( 'flat leftover writes no churn', leftoverChurn( 0 ) === 0 );
	need( 'a 5 cm leftover crest already breaks into visible foam',
		leftoverChurn( 0.05 ) > 0.18,
		`churn ${ leftoverChurn( 0.05 ).toFixed( 3 )}` );
	need( 'a taller crest churns harder',
		leftoverChurn( 0.20 ) > leftoverChurn( 0.05 ) );
	need( 'a leftover trough stays water — foam lives on the crests',
		leftoverChurn( - 0.20 ) === 0,
		`trough ${ leftoverChurn( - 0.20 ).toFixed( 3 )}` );
	need( 'a steep face adds churn on a low crest',
		leftoverChurn( 0.02, 0.28 ) > leftoverChurn( 0.02, 0 ) * 1.8 );
	need( 'a leftover face from astern shoves the hull forward',
		leftoverSurge( [ 0, - 0.22, 0.22, 0, 0 ], 5, 1.5 ).along > 0.15 );
	need( 'a leftover face at the bow brakes',
		leftoverSurge( [ 0, 0.22, - 0.22, 0, 0 ], 5, 1.5 ).along < - 0.15 );
	need( 'the bow writes leftover harder than midship — not a uniform tube',
		leftoverStationWeight( 1 ) > leftoverStationWeight( 0 ) * 3,
		`bow ${ leftoverStationWeight( 1 ).toFixed( 2 )}  mid ${ leftoverStationWeight( 0 ).toFixed( 2 )}` );
	need( 'a landing slams harder than a level cruise',
		leftoverSlam( { impact: 0.7 } ) > leftoverSlam( { speed: 8 } ) + 0.8 );
	const body = {
		speed: Uhull, length: L, size: { x: 3.2, y: 1.4, z: L },
		pos: [ 0, 0, 0 ], heading: 0, pitch: 0, roll: 0, surf: 0,
		wake: { strength: 1, physics: 1 },
	};
	const sites = leftoverWriteSites( body );
	const cuts = leftoverCutStations( body );
	const bow = sites.find( ( s ) => s.role === 'bow' );
	const mid = sites.find( ( s ) => s.role === 'port' && Math.abs( s.along ) < 0.2 );
	need( 'leftover writes one blob per waterline cut, not three centerline blobs',
		sites.length === cuts.length && sites.length >= 8,
		`n ${ sites.length }` );
	const bowFoot = leftoverWriteFootprint( hullRippleSite( body ), bow );
	const midFoot = leftoverWriteFootprint( hullRippleSite( body ), mid );
	need( 'the bow leftover heap spans several leftover cells — not a one-cell pyramid',
		bowFoot && ! bowFoot.tight && bowFoot.r >= LEFTOVER_TILE.cell * 1.3
		&& leftoverBowSplashRadius( 3.4 ) >= LEFTOVER_TILE.cell * 1.6
		&& leftoverBowSplashRadius( 3.4 ) < 2.2,
		`r ${ bowFoot?.r?.toFixed?.( 2 )}  splash ${ leftoverBowSplashRadius( 3.4 ).toFixed( 2 ) }` );
	need( 'planing eases the bow leftover heap — a fast hull is not a 1.45 m hill',
		leftoverBowSplashGain( 0.82, 1, 1, 0.35 ) > leftoverBowSplashGain( 0.82, 1, 1, 1.4 ) * 2
		&& leftoverBowSplashGain( 0.82, 1, 1, 1.4 ) < 0.08,
		`disp ${ leftoverBowSplashGain( 0.82, 1, 1, 0.35 ).toFixed( 3 )}  plane ${ leftoverBowSplashGain( 0.82, 1, 1, 1.4 ).toFixed( 3 ) }` );
	need( 'side leftover writes stay tight on the chines',
		midFoot && midFoot.tight && midFoot.r < bowFoot.r * 0.7,
		`mid r ${ midFoot?.r?.toFixed?.( 2 )}  bow r ${ bowFoot?.r?.toFixed?.( 2 ) }` );
	{
		const heap = new RippleField( {
			size: 96, cell: LEFTOVER_TILE.cell, speed: 4, damping: 0, sponge: 6,
		} );
		heap.splash( 0, 0, leftoverBowSplashRadius( 3.4, heap.cell ), 1 );
		const peak = heap.sampleAt( 0, 0 );
		const ring = heap.sampleAt( heap.cell, 0 );
		need( 'a bow leftover splash still has height one cell out — the sea mesh can round it',
			peak > 0.4 && ring > peak * 0.35,
			`peak ${ peak.toFixed( 3 )}  ring ${ ring.toFixed( 3 ) }` );
	}
	need( 'write sites put more leftover at the bow than amidships',
		bow && mid && bow.gain > mid.gain * 2.4,
		`bow ${ bow?.gain?.toFixed?.( 3 )}  mid ${ mid?.gain?.toFixed?.( 3 )}` );
	need( 'a slamming bow writes harder leftover than a level one',
		leftoverEmitStrength( { ...body, impact: 0.8 }, 1 )
			> leftoverEmitStrength( body, 1 ) * 1.15 );
	need( 'emit strength is dark when parked',
		leftoverEmitStrength( { ...body, speed: 0 }, 1 ) === 0 );
	const side = ( pts, role ) => pts.filter( ( p ) => p.role === role )
		.reduce( ( s, p ) => s + p.strength, 0 );
	const level = leftoverEmitPoints( body );
	const stbdHeel = leftoverEmitPoints( { ...body, roll: - 0.32 } );
	const portHeel = leftoverEmitPoints( { ...body, roll: 0.32 } );
	need( 'a starboard heel writes leftover on the low (starboard) chine',
		side( stbdHeel, 'starboard' ) > side( stbdHeel, 'port' ) * 1.6,
		`stbd ${ side( stbdHeel, 'starboard' ).toFixed( 2 )}  port ${ side( stbdHeel, 'port' ).toFixed( 2 )}` );
	need( 'a port heel writes leftover on the low (port) chine',
		side( portHeel, 'port' ) > side( portHeel, 'starboard' ) * 1.6,
		`port ${ side( portHeel, 'port' ).toFixed( 2 )}  stbd ${ side( portHeel, 'starboard' ).toFixed( 2 )}` );
	need( 'a level hull writes port and starboard about the same',
		Math.abs( side( level, 'port' ) - side( level, 'starboard' ) ) < 0.08,
		`port ${ side( level, 'port' ).toFixed( 2 )}  stbd ${ side( level, 'starboard' ).toFixed( 2 )}` );
	const bowLevel = leftoverEmitPoints( body ).find( ( p ) => p.role === 'bow' );
	const sternLevel = leftoverEmitPoints( body ).find( ( p ) => p.role === 'stern' );
	const bowDown = leftoverEmitPoints( { ...body, pitch: - 0.22 } );
	const bowD = bowDown.find( ( p ) => p.role === 'bow' );
	const sternD = bowDown.find( ( p ) => p.role === 'stern' );
	need( 'bow-down pitch loads the entry harder than a level hull',
		bowLevel && sternLevel && bowD && sternD
			&& bowD.strength >= bowLevel.strength * 0.95
			&& sternD.strength < sternLevel.strength * 0.55,
		`level bow/stern ${ bowLevel?.strength?.toFixed?.( 2 )}/${ sternLevel?.strength?.toFixed?.( 2 )}  down ${ bowD?.strength?.toFixed?.( 2 )}/${ sternD?.strength?.toFixed?.( 2 )}` );
	const face = leftoverEmitPoints( {
		...body,
		probeLayout: 'corners',
		samples: { h: [ - 0.18, 0.42, - 0.18, 0.42 ] },
	} );
	need( 'a high starboard sea wets the starboard cut',
		side( face, 'starboard' ) > side( face, 'port' ) * 1.35,
		`stbd ${ side( face, 'starboard' ).toFixed( 2 )}  port ${ side( face, 'port' ).toFixed( 2 )}` );
	need( 'a hull held clear of the sea writes no leftover cuts',
		leftoverWriteSites( { ...body, pos: [ 0, 4, 0 ], airborne: true, impact: 0 } )
			.every( ( s ) => s.gain === 0 ) );
	const deep = leftoverWriteSites( body ).find( ( s ) => s.role === 'bow' );
	const kiss = leftoverWriteSites( {
		...body, pos: [ 0, 0.62, 0 ], surf: 0,
	} ).find( ( s ) => s.role === 'bow' );
	need( 'a deeper cut writes taller leftover than a hull that is barely wetting',
		deep && kiss && deep.gain > kiss.gain * 1.8
		&& deep.submerged > kiss.submerged + 0.20,
		`deep ${ deep?.gain?.toFixed?.( 3 )}/${ deep?.submerged?.toFixed?.( 2 )}  kiss ${ kiss?.gain?.toFixed?.( 3 )}/${ kiss?.submerged?.toFixed?.( 2 )}` );
	need( 'posed draft is keel vs the sea, not a Fr fraction',
		leftoverHullDraft( { pos: [ 0, 0, 0 ], size: { y: 1.4 }, surf: 0 } ) > 0.6
		&& leftoverHullDraft( { pos: [ 0, 2, 0 ], size: { y: 1.4 }, surf: 0 } ) < 0.05 );
	const skiBeam = leftoverEmitPoints( {
		...body, beam: 1.1, size: { x: 3.4, y: 1.4, z: L },
	} );
	const edge = Math.max( ...skiBeam.map( ( p ) => Math.abs( p.x ) ) );
	need( 'waterline cuts follow the mesh beam, not a leftover SKI beam',
		edge > 1.5 && edge < 1.8,
		`max |x| ${ edge.toFixed( 2 )}  (SKI.beam is 1.1, box is 3.4)` );
	const dropping = leftoverEmitPoints( { ...body, roll: 0, rollRate: - 1.4 } );
	need( 'a chine rolling into the sea writes harder than the lifting side',
		side( dropping, 'starboard' ) > side( dropping, 'port' ) * 1.15,
		`stbd ${ side( dropping, 'starboard' ).toFixed( 2 )}  port ${ side( dropping, 'port' ).toFixed( 2 )}` );
	need( 'emit cap is off until asked — the full waterline still writes',
		leftoverEmitMax( body.wake ) == null && leftoverCutStations( body ).length >= 8 );
	need( 'emit 0 writes no leftover',
		leftoverEmitMax( { emit: 0 } ) === 0
			&& leftoverCutStations( { ...body, wake: { ...body.wake, emit: 0 } } ).length === 0
			&& leftoverCapStations( leftoverCutStations( body ), 0 ).length === 0 );
	need( 'emit 1 is one leftover write, not a hidden floor of 4',
		leftoverCutStations( { ...body, wake: { ...body.wake, emit: 1 } } ).length === 1,
		`n ${ leftoverCutStations( { ...body, wake: { ...body.wake, emit: 1 } } ).length }` );
	need( 'debug overlay emit: 1 does not cap leftover writes',
		leftoverCutStations( body, { emit: 1 } ).length >= 8 );
	const capped = leftoverCutStations( { ...body, wake: { ...body.wake, emit: 8 } } );
	need( 'emit cap thins leftover writes and keeps bow and stern',
		capped.length === 8
			&& capped.some( ( c ) => c.role === 'bow' )
			&& capped.some( ( c ) => c.role === 'stern' ),
		`n ${ capped.length }  roles ${ [ ...new Set( capped.map( ( c ) => c.role ) ) ] }` );
	need( 'leftoverCapStations never invents cuts',
		leftoverCapStations( leftoverCutStations( body ), 6 ).length === 6 );
}

{
	const w = LEFTOVER_BANDS.reduce( ( s, b ) => s + b.w, 0 );
	need( 'leftover bands are a spectrum, not one wavelength — weights sum to 1',
		Math.abs( w - 1 ) < 1e-9 && LEFTOVER_BANDS[ 0 ].k < 1
		&& LEFTOVER_BANDS[ 2 ].k > 1.4,
		`w ${ w.toFixed( 3 )}  k ${ LEFTOVER_BANDS.map( ( b ) => b.k ).join( '/' ) }` );
	need( 'leftover tile is 320 m without a 384² CPU field',
		LEFTOVER_TILE.size === 256
			&& Math.abs( LEFTOVER_TILE.size * LEFTOVER_TILE.cell - 320 ) < 1e-9
			&& LEFTOVER_HEIGHT_CAP > 0.8 && LEFTOVER_HEIGHT_CAP < 2
			&& LEFTOVER_SPLASH_MIN_SPEED > 1,
		`${ LEFTOVER_TILE.size }² × ${ LEFTOVER_TILE.cell } m  cap ${ LEFTOVER_HEIGHT_CAP }` );
	need( 'leftover bow/motor boil is a 60 Hz rate, not a per-frame fountain',
		Math.abs( leftoverSplashHeight( 0.2, 1 / 60 ) - 0.2 ) < 1e-9
			&& Math.abs( leftoverSplashHeight( 0.2, 1 / 30 ) - 0.4 ) < 1e-9
			&& leftoverSplashHeight( 0.2, 0 ) === 0
			&& leftoverSplashHeight( 0, 1 / 60 ) === 0 );
	const a = leftoverBandSite( {
		x: 4, z: - 2, ax: 0, az: - 1, half: 5, r: 1.4, submerged: 0.5,
	}, 0 );
	const b = leftoverBandSite( {
		x: 4, z: - 2, ax: 0, az: - 1, half: 5, r: 1.4, submerged: 0.5,
	}, 2 );
	need( 'band sites stay hull-shaped but are not identical stamps',
		a && b && a.half > 3 && b.half > 3 && Math.abs( a.half - b.half ) > 0.02,
		`half ${ a?.half?.toFixed?.( 3 )} vs ${ b?.half?.toFixed?.( 3 )}` );
	const short = new RippleField( { size: 96, cell: 0.5, speed: 2.2, damping: 0.04, sponge: 8 } );
	const long = new RippleField( { size: 96, cell: 0.5, speed: 5.6, damping: 0.04, sponge: 8 } );
	short.splash( 0, 0, 0.8, 0.35 );
	long.splash( 0, 0, 0.8, 0.35 );
	for ( let i = 0; i < 90; i ++ ) {

		short.step( 1 / 60 );
		long.step( 1 / 60 );

	}
	let shortR = 0, longR = 0, shortP = 0, longP = 0;
	for ( let r = 1; r < 18; r += 0.5 ) {

		const hs = Math.abs( short.sampleAt( r, 0 ) );
		const hl = Math.abs( long.sampleAt( r, 0 ) );
		if ( hs > shortP ) { shortP = hs; shortR = r; }
		if ( hl > longP ) { longP = hl; longR = r; }

	}
	need( 'long leftover outruns short leftover — that is dispersion, not random λ',
		longR > shortR + 1.5,
		`short peak @ ${ shortR.toFixed( 1 )} m  long @ ${ longR.toFixed( 1 )} m` );
}

{
	need( 'leftover stays hidden under the hull',
		wakePhysicsGeometryMask( 6, 0, 12, 3.4 ) > 0.95 );
	need( 'leftover starts within a metre of the transom',
		wakePhysicsGeometryMask( 12.5, 0, 12, 3.4 ) < 0.70
			&& wakePhysicsGeometryMask( 12 + WAKE_PHYS_MASK_AFT1 + 0.05, 0, 12, 3.4 ) < 0.02,
		`0.5 m ${ wakePhysicsGeometryMask( 12.5, 0, 12, 3.4 ).toFixed( 3 ) }` );
	need( 'a beam-wide cap still hides leftover under the chines',
		wakePhysicsGeometryMask( 6, 0.4, 12, 3.4 ) > 0.95 );
	need( 'the old 3.7 m stern hole is gone',
		wakePhysicsGeometryMask( 13.2, 0, 12, 3.4 ) < 0.02 );
}

{
	const fs = await import( 'node:fs' );
	const water = fs.readFileSync( new URL( '../src/gpu/tsl/water-surface.js', import.meta.url ), 'utf8' );
	const facade = fs.readFileSync( new URL( '../src/gpu/abyssal.js', import.meta.url ), 'utf8' );
	const tsl = fs.readFileSync( new URL( '../src/gpu/tsl/wake-physics.js', import.meta.url ), 'utf8' );
	const bench = fs.readFileSync( new URL( '../examples/webgpu-wake-physics.html', import.meta.url ), 'utf8' );
	const driver = fs.readFileSync( new URL( '../src/gpu/tsl/water-driver.js', import.meta.url ), 'utf8' );
	need( 'TSL leftover churn is crest foam, not a trough slab',
		water.includes( 'smoothstep( 0.008, 0.10 ).mul( 0.72 )' )
			&& water.includes( 'uRippleFoam.greaterThan( 0.001 )' )
			&& ! water.includes( 'smoothstep( 0.020, 0.14 ).mul( 0.10 )' ) );
	need( 'leftover crest foam fades on the live hull so a turn does not detach the stern',
		water.includes( 'wakePhysicsGeometryMaskAt( vFlat.xz ).mul( 0.85 )' ) );
	need( 'leftover crest foam is wave influence times the foam ribbon',
		facade.includes( 'physicsWakeBody' )
			&& facade.includes( 'params.wakeFoamWaveCarry' )
			&& facade.includes( 'foamAmt' ) );
	need( 'leftover crest look can stay off while wave carry still moves the film',
		facade.includes( 'wakeFoamCrestLook' )
			&& facade.includes( 'crestLook === undefined' ) );
	need( 'foam ribbon look uses recipe foam after the energy field saturates',
		facade.includes( 'waterOpts.foamRibbon' )
			&& driver.includes( 'uFoamRibbon.value' )
			&& water.includes( 'uFoamRibbon' ) );
	need( 'the wake bench foams the mesh waterline, not a beam-wide box',
		bench.includes( 'breachProfileFromObject' )
			&& bench.includes( 'sprayStations' )
			&& bench.includes( 'scaleBreachProfile' ) );
	need( 'TSL geometry mask lets leftover start at the transom',
		tsl.includes( 'WAKE_PHYS_MASK_AFT0' )
			&& tsl.includes( 'along.lessThanEqual( L )' ) );
	need( 'the FPS chip opens the shared perf overlay',
		bench.includes( 'installPerfDebug' )
			&& bench.includes( "fpsEl.addEventListener('click', togglePerf)" )
			&& bench.includes( "e.code === 'KeyP'" ) );
	need( 'the wake bench starts cheaper than a riding frame — leftover does not need 48 cloud steps',
		bench.includes( 'cloudSteps: 12' )
			&& bench.includes( 'gridRadial: 240' )
			&& bench.includes( 'dprCap: 1.35' ) );
	need( 'the wake bench isolates hull foam plus waterline spray and an optional transom jet — leftover waves may carry the film, leftover crests stay water',
		bench.includes( 'p-bub-amt' )
			&& bench.includes( 'p-foam-carry' )
			&& bench.includes( 'p-spray-amt' )
			&& bench.includes( 'p-spray-sites' )
			&& bench.includes( 'p-spray-band' )
			&& bench.includes( 'p-spray-size' )
			&& bench.includes( 'p-spray-spread' )
			&& bench.includes( 'p-spray-life' )
			&& bench.includes( 'spraySize' )
			&& bench.includes( 'craftSpraySpread' )
			&& bench.includes( 'p-jet-amt' )
			&& bench.includes( 'p-jet-w' )
			&& bench.includes( 'p-jet-reach' )
			&& bench.includes( 'p-jet-h' )
			&& bench.includes( 'p-jet-spray' )
			&& bench.includes( 'p-jet-spd' )
			&& bench.includes( 'p-jet-rise' )
			&& bench.includes( 'p-jet-ang' )
			&& bench.includes( 'jetAmt: 0.40' )
			&& bench.includes( 'motor: state.jetAmt' )
			&& bench.includes( 'wakeFoamCrestLook: 0' )
			// Both crest paths off. They are separate uniforms now, but
			// every one of these is an opacity REMOVER and they multiply,
			// so the bench turns on one at a time.
			&& bench.includes( 'const CREST_GATE = 0' )
			&& bench.includes( 'wakeFoamCrestGate: CREST_GATE' )
			&& bench.includes( 'wakeFoamCrestGate = CREST_GATE' )
			&& bench.includes( 'wakeFoamWaveCarry: 1.25' )
			// Ribbon vary 0 is the solid stencil that made the trail read as
			// a hard contrail. The bench re-forced it per frame, so it also
			// has to be the shared constant in the update, not a literal.
			&& bench.includes( 'const RIBBON_VARY = 0.45' )
			&& bench.includes( 'wakeFoamRibbonVary: RIBBON_VARY' )
			&& bench.includes( 'wakeFoamRibbonVary = RIBBON_VARY' )
			&& ! /wakeFoamRibbonVary\s*[:=]\s*0/.test( bench )
			&& bench.includes( 'spray: true' )
			&& bench.includes( 'hull: 0' )
			&& bench.includes( 'boat.spray.hull = 0' )
			&& bench.includes( "bubbles: { on: 0, amount: 0, splash: 0 }" )
			&& ! bench.includes( 'p-ribbon-vary' )
			&& ! bench.includes( 'p-foam-wave' )
			&& ! bench.includes( 'p-bub-splash' )
			&& bench.includes( 'title="How hard the hull writes the surface foam film' )
			&& bench.includes( 'pinned to the live transom' )
			&& bench.includes( 'Airborne rooster from the live transom' )
			&& water.includes( 'uWakeFoamRibbonVary' )
			&& water.includes( 'uRippleFoam.greaterThan( 0.001 )' )
			&& water.includes( 'crestGate' ) );
	need( 'the wake bench can show the displaced sea mesh as wireframe',
		bench.includes( 'btn-wire' )
			&& bench.includes( "e.code === 'KeyF'" )
			&& bench.includes( 'abyssal.water?.setWireframe' )
			&& bench.includes( 'MeshBasicMaterial' )
			&& bench.includes( 'abyssal.perf.sky = !wireOn' ) );
	need( 'wireframe sea is filled unlit with screen-space edges, not GPU lines',
		driver.includes( "name = 'abyssal.water.wire'" )
			&& driver.includes( 'fwidth' )
			&& driver.includes( 'vAbyssalWireRT' )
			&& driver.includes( 'setWireframe( on )' )
			&& ! driver.includes( 'this._wireMaterial.wireframe = true' )
			&& ! driver.includes( 'this.material.wireframe' ) );
	need( 'the wake bench skips a hung WebGPU adapter in the editor preview',
		bench.includes( 'navigator.gpu' )
			&& bench.includes( 'requestAdapter' )
			&& bench.includes( '/Electron/i' )
			&& bench.includes( "return 'webgl'" ) );
	need( 'motor leftover boil is a streak along the track, not a raindrop ring',
		leftoverJetSplashSpan( 3.4, 0.16, 0 ).along
			> leftoverJetSplashSpan( 3.4, 0.16, 0 ).across * 2
			&& fs.readFileSync( new URL( '../src/ocean-body.js', import.meta.url ), 'utf8' )
				.includes( 'splashAlong' )
			&& fs.readFileSync( new URL( '../src/ocean-body.js', import.meta.url ), 'utf8' )
				.includes( 'leftoverJetSplashSpan' ) );
	need( 'bow leftover splash uses the rounded heap radius, not a 0.2 m spout',
		fs.readFileSync( new URL( '../src/ocean-body.js', import.meta.url ), 'utf8' )
			.includes( 'leftoverBowSplashRadius( beam, band.cell )' )
			&& fs.readFileSync( new URL( '../src/ocean-body.js', import.meta.url ), 'utf8' )
				.includes( 'leftoverBowSplashGain' )
			&& ! fs.readFileSync( new URL( '../src/ocean-body.js', import.meta.url ), 'utf8' )
				.includes( 'beam * 0.36' ) );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}

const allOk = results.every( ( r ) => r.ok );
console.log( `\n${ allOk ? 'ALL PASS' : 'SOME FAILED' }` );
process.exit( allOk ? 0 : 1 );
