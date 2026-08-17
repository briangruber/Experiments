#!/usr/bin/env node
// CPU twin of the simple V behind a surface-running body.
//
//   node tools/check-v-wake.mjs

import {
	vWakeAt, vWakeChurnAt, vWakeTan, vWakeDepthT, V_WAKE_TAN,
	VWakeField, vWakeFieldAt,
} from '../src/v-wake.js';

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
