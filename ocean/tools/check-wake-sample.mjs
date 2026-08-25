#!/usr/bin/env node
// CPU twin of wakeAt(): the snout stamp must not rule a line, and the
// V must still stand up once the arms have left the track.
//
//   node tools/check-wake-sample.mjs

import { wakeAtCpu, wakeEdgeCpu, wakeStampKind } from '../src/wake-sample.js';
import { physicsRenderDims } from '../src/body-wake.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const u = {
	life: 14,
	armW: 2.6,
	spread: 0.28,
	beam: 2.4,
	arm: 1,
	churn: 0.5,
	depth: 0.79,
	strength: 1.15,
};

const at = ( rec ) => wakeAtCpu( rec, u );
const quiet = ( s ) => Math.abs( s.foam ) < 0.002 && Math.abs( s.h ) < 0.002 && Math.abs( s.z ) < 0.002;

{
	const nose = at( { stir: 1.4, age: 0, lat: 0, rate: 21 } );
	need( 'a brand-new stamp on the track is silent — no ruler through the nose',
		quiet( nose ),
		`foam ${ nose.foam.toFixed( 3 ) } h ${ nose.h.toFixed( 3 ) } z ${ nose.z.toFixed( 3 ) }` );
}

{
	const slab = at( { stir: 1.4, age: 0, lat: 40, rate: 21 } );
	need( 'the same stamp far abeam is silent too — that was the 144 m line',
		quiet( slab ),
		`foam ${ slab.foam.toFixed( 3 ) } h ${ slab.h.toFixed( 3 ) } z ${ slab.z.toFixed( 3 ) }` );
}

{
	const young = at( { stir: 1.4, age: 0.06, lat: 0, rate: 21 } );
	need( 'a few frames later the snout is still quiet',
		quiet( young ),
		`foam ${ young.foam.toFixed( 3 ) } h ${ young.h.toFixed( 3 ) } z ${ young.z.toFixed( 3 ) }` );
}

{
	const age = 0.55;
	const rate = 21;
	const arm = rate * age;
	const crest = at( { stir: 1.4, age, lat: arm, rate } );
	need( 'once the arms have left the track the V has real height',
		crest.h > 0.12,
		`h ${ crest.h.toFixed( 3 ) } at lat ${ arm.toFixed( 1 ) }` );
	const track = at( { stir: 1.4, age, lat: 0, rate } );
	need( 'foam is on the track, not glued to the travelling arm',
		track.foam > 0.05 && track.foam > crest.foam * 1.15,
		`track foam ${ track.foam.toFixed( 3 ) } arm foam ${ crest.foam.toFixed( 3 ) }` );
}

{
	const far = at( { stir: 1.4, age: 0.55, lat: 80, rate: 21 } );
	need( 'far from the arms the sea stays flat',
		Math.abs( far.h ) < 0.01 && far.foam < 0.01,
		`h ${ far.h.toFixed( 3 ) } foam ${ far.foam.toFixed( 3 ) }` );
}

{
	const mid = at( { stir: 1.4, age: 0.7, lat: 0, rate: 21 } );
	need( 'the track is not a gouged groove',
		mid.h >= - 0.02,
		`h ${ mid.h.toFixed( 3 ) }` );
	const early = 0.7;
	const later = 2.2;
	const rate = 21;
	const a0 = at( { stir: 1.4, age: early, lat: rate * early, rate } );
	const a1 = at( { stir: 1.4, age: later, lat: rate * later, rate } );
	need( 'the arms leave the track — a V, not two parallel rails',
		rate * later - rate * early > 20 && a0.h > 0.2 && a1.h > 0.15,
		`early lat ${( rate * early ).toFixed( 1 )} h ${ a0.h.toFixed( 3 )}  later lat ${( rate * later ).toFixed( 1 )} h ${ a1.h.toFixed( 3 )}` );
	const left = at( { stir: 1.4, age: later, lat: 0, rate } );
	need( 'older foam stays on the track after the arms have scanned past',
		left.foam > a1.foam * 1.2 && left.foam > 0.04,
		`track foam ${ left.foam.toFixed( 3 ) } arm foam ${ a1.foam.toFixed( 3 ) }` );
	const slab = at( { stir: 1.4, age: later, lat: 0, rate } );
	need( 'the wedge stays hollow — that filled rectangle was fat arms',
		slab.h < a1.h * 0.35,
		`centre ${ slab.h.toFixed( 3 )} arm ${ a1.h.toFixed( 3 )}` );
	const wing = at( { stir: 1.4, age: 0.35, lat: 18, rate: 21 } );
	need( 'young far-lat wings stay down — those were the triangle spikes',
		Math.abs( wing.h ) < 0.04,
		`h ${ wing.h.toFixed( 3 ) } at lat 18` );
}

{
	const mid = wakeEdgeCpu( 0.5, 0.5, 0.22 );
	const wall = wakeEdgeCpu( 0.5, 0.0, 0.22 );
	need( 'the buffer centre is live and the mid-edge is dead',
		mid > 0.95 && wall < 0.001,
		`centre ${ mid.toFixed( 3 ) } wall ${ wall.toFixed( 3 ) }` );
}

{
	// A square fade is constant along a line of constant V (world Z).
	// That constant is the horizontal ruler. A circle must differ.
	const a = wakeEdgeCpu( 0.5, 0.12, 0.22 );
	const b = wakeEdgeCpu( 0.25, 0.12, 0.22 );
	need( 'a line of constant Z is not a constant fade — that was the ruler',
		Math.abs( a - b ) > 0.05,
		`mid ${ a.toFixed( 3 ) } side ${ b.toFixed( 3 ) }` );
}

{
	const age = 0.55;
	const rate = 21;
	const shaped = {
		...u,
		width0: 0.6,
		width1: 4,
		arms: 2,
		trail: 1,
		turb: 0,
	};
	const crest = wakeAtCpu( { stir: 1.4, age, lat: 0.6 + rate * age, rate }, shaped );
	need( 'a start width parks the V off the centreline',
		crest.h > 0.12,
		`h ${ crest.h.toFixed( 3 ) } at lat ${ ( 0.6 + rate * age ).toFixed( 1 ) }` );
	const boilOnly = wakeAtCpu( { stir: 1.4, age, lat: rate * age, rate }, { ...u, arms: 0, trail: 1 } );
	need( 'count 1 (no arms) kills the travelling ridge',
		Math.abs( boilOnly.h ) < 0.02,
		`h ${ boilOnly.h.toFixed( 3 ) }` );
	const vOnly = wakeAtCpu( { stir: 1.4, age, lat: 0, rate }, { ...u, arms: 2, trail: 0 } );
	const both = wakeAtCpu( { stir: 1.4, age, lat: 0, rate }, u );
	need( 'count 2 (V only) drops the centre boil foam',
		vOnly.foam < both.foam * 0.35,
		`v ${ vOnly.foam.toFixed( 3 ) } both ${ both.foam.toFixed( 3 ) }` );
	const calm = wakeAtCpu( { stir: 0.35, age, lat: 0, rate, x: 3, z: - 8 }, { ...u, turb: 0 } );
	const chop = wakeAtCpu( { stir: 0.35, age, lat: 0, rate, x: 3, z: - 8 }, { ...u, turb: 1.2 } );
	need( 'turbulence changes the centre foam without moving the ridge',
		Math.abs( chop.foam - calm.foam ) > 0.01 && Math.abs( chop.h - calm.h ) < 1e-6,
		`calm ${ calm.foam.toFixed( 3 ) } chop ${ chop.foam.toFixed( 3 ) }` );

	const photo = {
		...u, width0: 0.52, width1: 5.4, arms: 2, trail: 1, turb: 0,
		arm: 1.35, churn: 1.2, strength: 1.55, armW: 1.05,
	};
	const pAge = 0.55;
	const pRate = 8;
	const pArm = wakeAtCpu(
		{ stir: 1.2, age: pAge, lat: 0.52 + pRate * pAge, rate: pRate, x: 2, z: - 6 },
		photo,
	);
	const pMid = wakeAtCpu(
		{ stir: 1.2, age: pAge, lat: 0, rate: pRate, x: 2, z: - 6 },
		photo,
	);
	need( 'the photo recipe puts foam on the V arms, not only the centreline',
		pArm.foam > 0.18,
		`arm ${ pArm.foam.toFixed( 3 ) } mid ${ pMid.foam.toFixed( 3 ) }` );
	need( 'and keeps a prop boil down the middle',
		pMid.foam > 0.10,
		`mid ${ pMid.foam.toFixed( 3 ) }` );
	need( 'the photo recipe carves a trough down the middle',
		pMid.h < - 0.08,
		`mid h ${ pMid.h.toFixed( 3 ) }` );
	need( 'and stands a wave mound on the V arms',
		pArm.h > 0.15 && pArm.h > - pMid.h * 0.35,
		`arm h ${ pArm.h.toFixed( 3 ) } mid ${ pMid.h.toFixed( 3 ) }` );

	const flickerU = { ...photo, turb: 1 };
	const flickerA = wakeAtCpu(
		{ stir: 1.2, age: 0.50, lat: 0.52 + 8 * 0.50, rate: 8, x: 2, z: - 6 },
		flickerU,
	);
	const flickerB = wakeAtCpu(
		{ stir: 1.2, age: 0.51, lat: 0.52 + 8 * 0.51, rate: 8, x: 2, z: - 6 },
		flickerU,
	);
	need( 'photo foam does not flicker with age at a fixed world point',
		Math.abs( flickerA.foam - flickerB.foam ) < 0.05,
		`a ${ flickerA.foam.toFixed( 3 ) } b ${ flickerB.foam.toFixed( 3 ) }` );
	const left = wakeAtCpu(
		{ stir: 1.2, age: pAge, lat: +( 0.52 + pRate * pAge ), rate: pRate, x: 2, z: - 6 },
		flickerU,
	);
	const right = wakeAtCpu(
		{ stir: 1.2, age: pAge, lat: -( 0.52 + pRate * pAge ), rate: pRate, x: 2, z: - 6 },
		flickerU,
	);
	need( 'both Kelvin arms carry foam — the V is not a one-sided fleck',
		left.foam > 0.18 && right.foam > 0.18 && Math.abs( left.foam - right.foam ) < 0.04,
		`L ${ left.foam.toFixed( 3 ) } R ${ right.foam.toFixed( 3 ) }` );
}

{
	const trail = {
		...u, width0: 0.5, arms: 2, trail: 0, arm: 0.2,
		cut: 0.75, depth: 0.55, strength: 1,
	};
	const cut = wakeAtCpu( { stir: 1.2, age: 2.0, lat: 0, rate: 8 }, trail );
	const later = wakeAtCpu( { stir: 1.2, age: 3.5, lat: 0, rate: 8 }, trail );
	const arm = wakeAtCpu(
		{ stir: 1.2, age: 2.0, lat: 0.5 + 8 * 2.0, rate: 8 },
		trail,
	);
	need( 'a stamp left behind still carves the water',
		cut.h < - 0.06, `h ${ cut.h.toFixed( 3 ) }` );
	need( 'that cut is still there later — it does not follow the hull',
		later.h < - 0.03, `h ${ later.h.toFixed( 3 ) }` );
	need( 'the V arms stand at the aged lat, not glued to the hull',
		arm.h > 0.08, `h ${ arm.h.toFixed( 3 ) } at lat ${( 0.5 + 16 ).toFixed( 1 )}` );
}

{
	const reach = 144;
	need( 'abeam of the snout, near the track, the mound resets',
		wakeStampKind( { alo: - 3, lat: 2, reach, empty: false, closer: true } ) === 'near' );
	need( 'far-lat empty water is first-touched — that is the V seed',
		wakeStampKind( { alo: - 3, lat: 40, reach, empty: true, closer: false } ) === 'far' );
	need( 'far-lat that already has a record is left to age — that is the V opening',
		wakeStampKind( { alo: - 3, lat: 40, reach, empty: false, closer: false } ) === null );
	need( 'ahead of the hull is not stamped',
		wakeStampKind( { alo: 3, lat: 2, reach, empty: true, closer: true } ) === null );
	need( 'a 7.5 m corridor is not the whole write — 20 m off the track still seeds',
		wakeStampKind( { alo: - 3, lat: 20, reach, empty: true, closer: false } ) === 'far' );
}

// The physics wake's spreading foam wedge, rebuilt from the record rather
// than advected. wake.js documents why: an arm leaves the track at ~0.35 U,
// about a ninth of a texel per frame, and semi-Lagrangian advection at that
// step is nearly all numerical diffusion.
{
	const speed = 12;
	const cfg = { foam: 0.82, beam: 3.4, physics: 1 };
	const dims = physicsRenderDims( cfg, { speed, length: 12, wet: true }, { wakeExtent: 320 } );
	const pu = { ...dims, armW: dims.armW, bowAmp: 0 };
	const peak = ( age ) => {
		let best = 0, bestLat = 0;
		for ( let lat = 0; lat <= 60; lat += 0.05 ) {

			const f = wakeAtCpu( { stir: 1.2, age, lat, rate: dims.armRate }, pu ).foam;
			if ( f > best ) { best = f; bestLat = lat; }

		}
		return { foam: best, lat: bestLat };
	};

	need( 'a physics wake reconstructs arms at all — this was hardcoded arms: 0',
		dims.arms > 0.5 && dims.arm > 0.001,
		`arms ${ dims.arms } arm ${ dims.arm.toFixed( 2 ) }` );
	need( 'the arm leaves the track at the Kelvin rate, ~0.354 U',
		Math.abs( dims.armRate - 0.3536 * speed ) < 0.01,
		`rate ${ dims.armRate.toFixed( 2 ) } m/s at U ${ speed }` );

	const near = peak( 1.0 );
	const mid = peak( 5.0 );
	const far = peak( 10.0 );
	need( 'the wedge OPENS with age — a wake that never widens reads as a contrail',
		mid.lat > near.lat + 1.0 && far.lat > mid.lat + 1.0,
		`peak lat ${ near.lat.toFixed( 1 ) } -> ${ mid.lat.toFixed( 1 ) } -> ${ far.lat.toFixed( 1 ) } m` );
	need( 'the arm stands where rate*age puts it, within a ridge width',
		Math.abs( far.lat - ( dims.width0 + dims.armRate * 10 ) ) < dims.armW * 2.2,
		`peak ${ far.lat.toFixed( 1 ) } want ${ ( dims.width0 + dims.armRate * 10 ).toFixed( 1 ) }` );
	need( 'the arms carry FOAM, not only height — width0 puts it in photo mode',
		far.foam > 0.05 && dims.width0 > 0.05,
		`foam ${ far.foam.toFixed( 3 ) } width0 ${ dims.width0.toFixed( 2 ) }` );
	need( 'height still belongs to the leftover ripple field, not the record',
		dims.depth === 0 && dims.trail === 0 );
	need( 'the interior boil widens toward the arms — a filled apron, not a lane',
		dims.width1 > dims.width0 * 2,
		`width0 ${ dims.width0.toFixed( 2 ) } width1 ${ dims.width1.toFixed( 2 ) }` );
	// "Foam carry" is the sideways-reach knob. It has to open the analytic
	// wedge too, or turning it up only smears film along leftover faces
	// while the arms stay pinned at the physical 19.47deg.
	{
		const body = { speed, length: 12, wet: true };
		const wide = physicsRenderDims( cfg, body, { wakeExtent: 320, wakeFoamWaveCarry: 10 } );
		need( 'foam carry opens the Kelvin wedge — the arms leave the track faster',
			wide.armRate > dims.armRate * 2.5 && wide.width1 > dims.width1 * 2,
			`rate ${ dims.armRate.toFixed( 2 ) } -> ${ wide.armRate.toFixed( 2 ) }`
				+ ` width ${ dims.width1.toFixed( 1 ) } -> ${ wide.width1.toFixed( 1 ) }` );
		need( 'the stock carry still lands on the physical 19.47deg cusp',
			Math.abs( dims.armRate / speed - 0.3536 ) < 1e-3,
			`tan ${ ( dims.armRate / speed ).toFixed( 4 ) }` );
	}
	need( 'the wedge dies inside the record window instead of reaching the horizon',
		wakeAtCpu( { stir: 1.2, age: dims.life + 0.1, lat: 20, rate: dims.armRate }, pu ).foam === 0
			&& dims.life * speed < 320,
		`life ${ dims.life.toFixed( 1 ) } s = ${ ( dims.life * speed ).toFixed( 0 ) } m at U ${ speed }` );
	// The whole point of reconstruction over advection: the wedge is a
	// function of the RECORD (age, lat, rate) only, so swinging the live
	// heading cannot sweep a stencil across foam that is already down.
	{
		const rec = { stir: 1.2, age: 6, lat: dims.width0 + dims.armRate * 6, rate: dims.armRate };
		const north = wakeAtCpu( rec, { ...pu, fwdX: 0, fwdZ: 1 } ).foam;
		const east = wakeAtCpu( rec, { ...pu, fwdX: 1, fwdZ: 0 } ).foam;
		need( 'the wedge ignores the live heading — a turn cannot rotate it',
			north === east && north > 0.01,
			`north ${ north.toFixed( 4 ) } east ${ east.toFixed( 4 ) }` );
	}
	need( 'the reconstruction never returns NaN — strength must reach the CPU twin',
		Number.isFinite( far.foam ) && Number.isFinite( near.foam ),
		`near ${ near.foam } far ${ far.foam }` );
}

// Analytic Kelvin gravity-wave V: tools/check-kelvin-wake.mjs.

for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}

const allOk = results.every( ( r ) => r.ok );
console.log( `\n${ allOk ? 'ALL PASS' : 'SOME FAILED' }` );
process.exit( allOk ? 0 : 1 );
