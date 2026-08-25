#!/usr/bin/env node
// CPU twin of the simple V behind a surface-running body.
//
//   node tools/check-v-wake.mjs

import {
	vWakeAt, vWakeChurnAt, vWakeTan, vWakeDepthT, V_WAKE_TAN,
	VWakeField, vWakeFieldAt, vWakeWrite,
} from '../src/v-wake.js';
import { OceanBody, BodyList, wakeLeadContact } from '../src/ocean-body.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const U = {
	hx: 0, hz: 0,
	fx: 0, fz: - 1, // heading north (−Z)
	amp: 0.6, len: 100, width: 4,
	tan: V_WAKE_TAN, foam: 0.5,
};

{
	const a = vWakeAt( 0, - 20, U );
	need( 'ahead of the snout is silent — a wake is what is behind you',
		a.h < 0.001 && a.foam < 0.001,
		`h ${ a.h.toFixed( 3 ) }` );
}

{
	const tanA = V_WAKE_TAN;
	const fetch = 40;
	const arm = fetch * tanA;
	const on = vWakeAt( arm, fetch, U );
	const mid = vWakeAt( 0, fetch, U );
	const out = vWakeAt( arm + 18, fetch, U );
	need( 'an arm carries real surface displacement',
		on.h > 0.08,
		`h ${ on.h.toFixed( 3 ) } at lat ${ arm.toFixed( 1 ) }` );
	need( 'the interior between the arms is empty',
		mid.h < on.h * 0.15,
		`arm ${ on.h.toFixed( 3 )}  centre ${ mid.h.toFixed( 3 ) }` );
	need( 'outside the V the sea is flat',
		out.h < 0.02,
		`outside ${ out.h.toFixed( 3 ) }` );
}

{
	const tanA = vWakeTan( 15 );
	need( 'the default angle is the shipped 15° half-angle',
		Math.abs( tanA - V_WAKE_TAN ) < 1e-6,
		`tan ${ tanA.toFixed( 4 ) }` );
}

{
	const tanA = V_WAKE_TAN;
	const near = vWakeAt( 12 * tanA, 12, U );
	const far = vWakeAt( 80 * tanA, 80, U );
	need( 'the arms fade with fetch — not a constant tube',
		far.h < near.h * 0.45 && far.h > 0.001,
		`near ${ near.h.toFixed( 3 ) }  far ${ far.h.toFixed( 3 ) }` );
}

{
	const tanA = V_WAKE_TAN;
	const crest = vWakeAt( 40 * tanA, 40, U );
	const midEdge = vWakeAt( 40 * tanA + 3, 40, U );
	need( 'the face has width — a soft ridge, not a 1-pixel wire',
		midEdge.h > crest.h * 0.15 && midEdge.h < crest.h,
		`crest ${ crest.h.toFixed( 3 ) }  +3 m ${ midEdge.h.toFixed( 3 ) }` );
}

{
	const snout = vWakeAt( 0, 0, U );
	need( 'the vertex is not a spike on the snout',
		snout.h < 0.02,
		`h ${ snout.h.toFixed( 3 ) }` );
}

{
	const off = vWakeAt( 40 * V_WAKE_TAN, 40, { ...U, amp: 0 } );
	need( 'strength 0 is no wake',
		off.h < 1e-6,
		`h ${ off.h }` );
}

{
	const wide = vWakeTan( 32 );
	const narrow = vWakeTan( 18 );
	const fetch = 50;
	const wArm = vWakeAt( fetch * wide, fetch, { ...U, tan: wide } );
	const nAtWide = vWakeAt( fetch * wide, fetch, { ...U, tan: narrow } );
	need( 'a wider angle opens the V, it is not glued to one ray',
		wArm.h > 0.08 && nAtWide.h < wArm.h * 0.25,
		`wide-arm ${ wArm.h.toFixed( 3 ) }  narrow-on-wide-ray ${ nAtWide.h.toFixed( 3 ) }` );
}

{
	const foam = vWakeAt( 40 * V_WAKE_TAN, 40, U );
	need( 'the analytic V carries height only — foam cannot ride its arms',
		foam.h > 0.05 && foam.foam < 0.001,
		`foam ${ foam.foam.toFixed( 3 ) }` );
}

{
	const fetch = 40;
	const tanA = V_WAKE_TAN;
	const on = vWakeAt( fetch * tanA, fetch, { ...U, mid: 1 } );
	const mid = vWakeAt( 0, fetch, { ...U, mid: 1 } );
	const hollow = vWakeAt( 0, fetch, { ...U, mid: 0 } );
	const ahead = vWakeAt( 0, - 20, { ...U, mid: 1 } );
	need( 'a centre ridge fills the hollow when mid is on',
		mid.h > on.h * 0.55 && mid.h < on.h * 1.15,
		`centre ${ mid.h.toFixed( 3 ) }  arm ${ on.h.toFixed( 3 ) }` );
	need( 'mid 0 still leaves the hollow empty',
		hollow.h < on.h * 0.15,
		`hollow ${ hollow.h.toFixed( 3 ) }` );
	need( 'the centre ridge does not write ahead of the snout',
		ahead.h < 0.001,
		`h ${ ahead.h.toFixed( 3 ) }` );
}

{
	need( 'deep is no V',
		vWakeDepthT( 12, false, 9, 7 ) < 0.001,
		`t ${ vWakeDepthT( 12, false, 9, 7 ) }` );
	const mid = vWakeDepthT( 4.5, true, 9, 7 );
	need( 'halfway up to the surface is a lighter V, not full',
		mid > 0.2 && mid < 0.85,
		`t ${ mid.toFixed( 3 ) }` );
	need( 'at the waterline a pierce is full',
		vWakeDepthT( 0, true, 9, 7 ) > 0.99,
		`t ${ vWakeDepthT( 0, true, 9, 7 ) }` );
	need( 'a surface run with the back out is still full',
		vWakeDepthT( - 5.4, true, 9, 7 ) > 0.99,
		`t ${ vWakeDepthT( - 5.4, true, 9, 7 ) }` );
	need( 'a jump-out generates nothing — leftover stamps fade on their own',
		vWakeDepthT( - 8, false, 9, 7 ) < 0.05,
		`t ${ vWakeDepthT( - 8, false, 9, 7 ).toFixed( 3 ) }` );
}

{
	const f = new VWakeField();
	const shape = { ...U, amp: 0.6 };
	f.step( 0.05, { x: 0, z: 0, fx: 0, fz: - 1, amp: 0.6 }, { life: 6, spacing: 8 } );
	const whileOn = vWakeFieldAt( 40 * V_WAKE_TAN, 40, f, shape );
	for ( let i = 0; i < 8; i ++ ) f.step( 0.1, null, { life: 6 } );
	const afterDive = vWakeFieldAt( 40 * V_WAKE_TAN, 40, f, shape );
	need( 'a written V stays on the sea after the body dives',
		f.stamps.length === 1 && afterDive.h > 0.05 && afterDive.h < whileOn.h * 1.02,
		`n ${ f.stamps.length } while ${ whileOn.h.toFixed( 3 ) } after ${ afterDive.h.toFixed( 3 ) }` );
	const tLeft = 6 - f.stamps[ 0 ].age;
	for ( let i = 0; i < 80; i ++ ) f.step( 0.1, null, { life: 6 } );
	const spent = vWakeFieldAt( 40 * V_WAKE_TAN, 40, f, shape );
	need( 'the leftover V dies after its lifetime',
		f.stamps.length === 0 && spent.h < 0.001,
		`n ${ f.stamps.length } h ${ spent.h.toFixed( 3 ) } leftover ${ tLeft.toFixed( 2 ) }s` );
}

{
	const f = new VWakeField();
	f.step( 0.05, { x: 0, z: 0, fx: 0, fz: - 1, amp: 0.6 }, { life: 6, spacing: 8 } );
	f.step( 0.05, { x: 2, z: - 4, fx: 0, fz: - 1, amp: 0.6 }, { life: 6, spacing: 8 } );
	const hop = f.stamps[ 0 ];
	const left = Math.hypot( hop.x, hop.z );
	const remain = Math.hypot( hop.x - 2, hop.z + 4 );
	need( 'a jumped cut slides the vertex, it does not teleport',
		f.stamps.length === 1 && left > 0.4 && remain > 1.5 && remain < 4.4,
		`n ${ f.stamps.length } at ${ hop.x.toFixed( 2 ) },${ hop.z.toFixed( 2 ) } remain ${ remain.toFixed( 2 ) }` );
	for ( let i = 0; i < 24; i ++ ) {

		f.step( 0.05, { x: 2, z: - 4, fx: 0, fz: - 1, amp: 0.6 }, { life: 6, spacing: 8 } );

	}
	need( 'and it arrives at the new cut',
		Math.hypot( f.stamps[ 0 ].x - 2, f.stamps[ 0 ].z + 4 ) < 0.2,
		`at ${ f.stamps[ 0 ].x.toFixed( 2 ) },${ f.stamps[ 0 ].z.toFixed( 2 ) }` );
}

{
	const fetch = 40;
	const tanA = V_WAKE_TAN;
	const mid = vWakeChurnAt( 0, fetch, U );
	const arm = vWakeChurnAt( fetch * tanA, fetch, U );
	const out = vWakeChurnAt( fetch * tanA + 28, fetch, U );
	const ahead = vWakeChurnAt( 0, - 20, U );
	const ridge = vWakeAt( fetch * tanA, fetch, U );
	need( 'churn is a lane down the middle, not a rail on the arms',
		mid > arm * 1.15 && mid > 0.04,
		`mid ${ mid.toFixed( 3 ) } arm ${ arm.toFixed( 3 ) }` );
	need( 'churn does not sit ahead of the snout',
		ahead < 0.001,
		`ahead ${ ahead.toFixed( 3 ) }` );
	need( 'churn dies outside the V',
		out < mid * 0.12,
		`out ${ out.toFixed( 3 ) } mid ${ mid.toFixed( 3 ) }` );
	need( 'the height V still carries no foam of its own',
		ridge.foam < 0.001 && ridge.h > 0.05,
		`foam ${ ridge.foam.toFixed( 3 ) }` );
}

function spikeStations( spikes, n = 16, minZ = - 12, maxZ = 12 ) {

	const top = new Float32Array( n ).fill( - 2 );
	const low = new Float32Array( n ).fill( - 6 );
	const half = new Float32Array( n ).fill( 1.2 );
	const span = maxZ - minZ;
	for ( const s of spikes ) {

		let b = Math.floor( ( s.z - minZ ) / span * n );
		if ( b < 0 ) b = 0; else if ( b >= n ) b = n - 1;
		top[ b ] = s.top;
		if ( s.low != null ) low[ b ] = s.low;

	}
	return { minZ, maxZ, top, low, half };

}

function profiled( stations, opts = {} ) {

	const body = new OceanBody( null, {
		mass: 4e4, float: false, hull: false,
		wake: { on: 1, origin: - 1, foam: 0.5 },
		size: { x: 4, y: 6, z: 24 },
		length: 24,
		pos: opts.pos ?? [ 0, 0, 0 ],
		heading: 0,
	} );
	body.sprayStations = stations;
	body.speed = opts.speed ?? 12;
	if ( opts.attach !== false ) {

		body.attach( {
			pos: opts.pos ?? [ 0, 0, 0 ],
			heading: 0,
			speed: opts.speed ?? 12,
			active: opts.active ?? true,
			jumpAirborne: !! opts.jumpAirborne,
		} );

	}
	return body;

}

const P = {
	sdVWake: 1, sdVWakeAmp: 1.39, sdVWakeWidth: 1.3, sdVWakeLen: 70,
	sdVWakeAngle: 15, sdVWakeMid: 0.83, sdVWakeLife: 8.2, seaLevel: 0,
};

{
	const deep = profiled( spikeStations( [ { z: - 11, top: 2, low: - 4 } ] ), {
		pos: [ 0, - 10, 0 ],
	} );
	need( 'a fully submerged profile does not invent a lead cut',
		wakeLeadContact( deep, { seaLevel: 0 } ) === null );

	const head = profiled( spikeStations( [ { z: - 11, top: 2.4, low: - 4 } ] ) );
	const headCut = wakeLeadContact( head, { seaLevel: 0 } );
	need( 'a nose pierce is the first cut along heading',
		!! headCut && headCut.along < - 8,
		`along ${ headCut?.along }` );

	const spine = profiled( spikeStations( [ { z: 0.5, top: 2.2, low: - 4 } ] ) );
	const spineCut = wakeLeadContact( spine, { seaLevel: 0 } );
	need( 'a spine pierce writes from that spike, not the origin',
		!! spineCut && Math.abs( spineCut.along ) < 3,
		`along ${ spineCut?.along }` );

	const both = profiled( spikeStations( [
		{ z: - 11, top: 2.4, low: - 4 },
		{ z: 0.5, top: 2.2, low: - 4 },
	] ) );
	const first = wakeLeadContact( both, { seaLevel: 0 } );
	need( 'head and spine together still start the V at the head',
		!! first && first.along < - 8,
		`along ${ first?.along }` );
}

{
	const kiss = profiled( spikeStations( [ { z: - 11, top: 0.25, low: - 4 } ] ) );
	const through = profiled( spikeStations( [ { z: - 11, top: 2.8, low: - 4 } ] ) );
	const a = vWakeWrite( kiss, P, { seaLevel: 0 } );
	const b = vWakeWrite( through, P, { seaLevel: 0 } );
	need( 'a deeper pierce writes a stronger, wider V than a kiss',
		!! a?.contact && !! b?.contact
			&& b.contact.amp > a.contact.amp * 1.4
			&& b.width > a.width * 1.25,
		`kiss amp ${ a?.contact?.amp?.toFixed( 3 ) } w ${ a?.width?.toFixed( 2 ) } through amp ${ b?.contact?.amp?.toFixed( 3 ) } w ${ b?.width?.toFixed( 2 ) }` );

	kiss.speed = 0;
	kiss.controller.speed = 0;
	const parked = vWakeWrite( kiss, P, { seaLevel: 0 } );
	need( 'heading speed 0 does not start a new V',
		!! parked && parked.contact === null );

	const leap = profiled( spikeStations( [ { z: - 11, top: 2.4, low: - 4 } ] ), {
		jumpAirborne: true,
	} );
	need( 'a leap does not write a V under the flying body',
		vWakeWrite( leap, P, { seaLevel: 0 } ) === null );

	const idle = profiled( spikeStations( [ { z: - 11, top: 2.4, low: - 4 } ] ), {
		active: false,
	} );
	need( 'an escort that is still cutting writes a V',
		!! vWakeWrite( idle, P, { seaLevel: 0 } )?.contact );
}

{
	// The mesh carries its own V so two animals in one sea are not
	// forced to share the sd* sliders.
	const stations = spikeStations( [ { z: - 11, top: 2.8, low: - 4 } ] );
	const plain = profiled( stations );
	const mine = profiled( stations );
	mine.wake = {
		on: 1, origin: - 1, foam: 0,
		v: 1, vAmp: 2.78, vLen: 150, vWidth: 4, vAngle: 30,
		vMid: 0.2, vLife: 12, vChurn: 0,
	};
	const base = vWakeWrite( plain, P, { seaLevel: 0 } );
	const own = vWakeWrite( mine, P, { seaLevel: 0 } );
	need( 'the recipe height, length, arm width, angle and life win over sd*',
		own.contact.amp > base.contact.amp * 1.9
			&& own.len > base.len * 2
			&& own.width > base.width * 2.9
			&& Math.abs( own.tan - vWakeTan( 30 ) ) < 1e-9
			&& own.mid === 0.2 && own.life === 12,
		`amp ${ own.contact.amp.toFixed( 3 ) } len ${ own.len.toFixed( 1 ) } w ${ own.width.toFixed( 2 ) }` );
	need( 'churn 0 on the mesh is a wake of displaced water only',
		own.churn === 0 && base.churn === 1
			&& vWakeChurnAt( 0, 40, { ...U, ...own, hx: 0, hz: 0, amp: own.contact.amp } ) === 0
			&& vWakeAt( 0, 40, { ...U, ...own, hx: 0, hz: 0, amp: own.contact.amp } ).h > 0.01,
		`churn ${ own.churn }` );

	const off = profiled( stations );
	off.wake = { on: 1, origin: - 1, foam: 0, v: 0 };
	need( 'v 0 on the mesh refuses the chevron even with sdVWake up',
		vWakeWrite( off, P, { seaLevel: 0 } ) === null );
}

{
	const list = new BodyList();
	const body = profiled( spikeStations( [ { z: - 11, top: 2.4, low: - 4 } ] ) );
	list.add( body );
	list.stepVWake( 0.05, P );
	need( 'BodyList writes the chevron from a piloted pierce',
		list.vWake.stamps.length === 1 && list.vWake.stamps[ 0 ].amp > 0.05,
		`n ${ list.vWake.stamps.length } amp ${ list.vWake.stamps[ 0 ]?.amp }` );
	body.controller.active = false;
	for ( let i = 0; i < 4; i ++ ) list.stepVWake( 0.05, P );
	need( 'turning the helm off still writes while the escort is cutting',
		list.vWake.stamps.length === 1 && list.vWake.stamps[ 0 ].amp > 0.05,
		`n ${ list.vWake.stamps.length } amp ${ list.vWake.stamps[ 0 ]?.amp }` );
	body.controller.jumpAirborne = true;
	const aged = list.vWake.stamps[ 0 ].age;
	for ( let i = 0; i < 4; i ++ ) list.stepVWake( 0.05, P );
	need( 'a leap stops new stamps and leaves leftover fade',
		list.vWake.stamps.length === 1 && list.vWake.stamps[ 0 ].age > aged,
		`n ${ list.vWake.stamps.length } age ${ list.vWake.stamps[ 0 ]?.age }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'PASS' : 'FAIL' }  ${ r.name }` );
	if ( r.detail ) console.log( `        ${ r.detail }` );

}

if ( failed.length ) {

	console.log( `\n${ failed.length } FAILED` );
	process.exit( 1 );

}

console.log( '\nALL PASS' );
