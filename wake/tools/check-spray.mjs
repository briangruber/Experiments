#!/usr/bin/env node
// Spray and the body that throws it. No GPU — this is ballistics and emission
// bookkeeping, and it runs in well under a second.
//
//   node tools/check-spray.mjs

import { SprayCore as Spray } from '../src/sprayCore.js';
import { OceanBody } from '../src/oceanBody.js';
import { attitude } from '../src/attitude.js';
import { set, get } from '../src/params.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );
const near = ( a, b, eps ) => Math.abs( a - b ) <= eps;

const flat = () => 0;

/** Run a body at a fixed speed for `secs`, stepping at `dt`. */
function run( { speed = 12, secs = 2, dt = 1 / 60, spray = new Spray( 4000 ) } = {} ) {

	const mesh = { rotation: { set() {} }, position: { set() {} } };
	const body = new OceanBody( mesh, { spray, seed: 3 } );
	body.state.speed = speed;
	let landed = 0;
	for ( let t = 0; t < secs; t += dt ) {
		body.step( dt, flat );
		spray.step( dt, flat );
		landed += spray.landings.length / 3;
	}
	return { body, spray, landed };

}

// ------------------------------------------------------------- it is ballistic --
//
// The claim that separates spray from a fading sheet: every droplet comes down.
{
	const { spray, landed } = run( { speed: 14, secs: 4 } );
	need( 'droplets are thrown', spray.n > 0 || landed > 0 );
	need( 'and they come down again — spray lands, it does not fade out',
		landed > 0, `${ landed } landings` );

	// Nothing may sit above the water forever: a droplet with a life is not the
	// same claim as a droplet that falls.
	const s2 = new Spray( 500 );
	const mesh = { rotation: { set() {} }, position: { set() {} } };
	const b = new OceanBody( mesh, { spray: s2, seed: 9 } );
	b.state.speed = 16;
	b.step( 1 / 60, flat );
	s2.step( 1 / 60, flat );
	const born = s2.n;
	for ( let t = 0; t < 8; t += 1 / 60 ) s2.step( 1 / 60, flat );
	need( 'the air clears — every droplet from one burst is gone within 8s',
		born > 0 && s2.n === 0, `${ born } born, ${ s2.n } left` );
}

// A landing is a report, not a deletion: the wake field turns it into foam.
{
	const { spray } = run( { speed: 14, secs: 1.5 } );
	need( 'landings report a position and a strength',
		spray.landings.length % 3 === 0 );
	if ( spray.landings.length >= 3 ) {
		const strength = spray.landings[ 2 ];
		need( 'landing strength is a sane 0..1', strength > 0 && strength <= 1,
			strength.toFixed( 3 ) );
	} else {
		need( 'landing strength is a sane 0..1', false, 'no landings to inspect' );
	}
}

// Speed does the work. There is no separate "throw harder" knob being turned:
// a wake weeps at 4 m/s and throws a curtain at 20 because the sheet velocity
// IS the hull speed.
{
	const slow = run( { speed: 5, secs: 2 } );
	const fast = run( { speed: 18, secs: 2 } );
	const reach = ( r ) => {
		let m = 0;
		for ( let i = 0; i < r.spray.n; i ++ ) m = Math.max( m, Math.abs( r.spray.p.vx[ i ] ) );
		return m;
	};
	need( 'a faster hull throws water harder', reach( fast ) > reach( slow ) * 1.5,
		`${ reach( slow ).toFixed( 2 ) } vs ${ reach( fast ).toFixed( 2 ) } m/s` );
	need( 'a faster hull throws more of it', fast.landed > slow.landed,
		`${ slow.landed } vs ${ fast.landed } landings` );
}

// Below a walking pace a hull parts water rather than throwing it.
{
	const still = run( { speed: 0, secs: 2 } );
	need( 'a stopped hull throws nothing', still.spray.n === 0 && still.landed === 0 );
	const crawl = run( { speed: get( 'spray.minSpeed' ) * 0.5, secs: 2 } );
	need( 'nor does a crawl below the throw threshold', crawl.spray.n === 0 );
}

// Emission is a RATE. A per-frame count doubles the spray on a 120 Hz display,
// which is the classic way a particle effect becomes a frame-rate meter.
{
	const a = run( { speed: 12, secs: 2, dt: 1 / 30 } );
	const b = run( { speed: 12, secs: 2, dt: 1 / 120 } );
	const ratio = b.landed / Math.max( a.landed, 1 );
	need( 'emission is per second, not per frame (30 vs 120 fps agree)',
		near( ratio, 1, 0.25 ), `ratio ${ ratio.toFixed( 3 ) }` );
}

// The pool is fixed. A particle system that grows under load stalls the frame
// exactly when the boat is most worth looking at.
{
	const spray = new Spray( 200 );
	set( 'spray.rate', 160 );
	const r = run( { speed: 30, secs: 3, spray } );
	need( 'the pool never exceeds its cap', r.spray.n <= 200, `${ r.spray.n }/200` );
	need( 'recycling keeps the cursor inside the pool',
		r.spray.cursor >= 0 && r.spray.cursor < 200 );
	set( 'spray.rate', 26 );
}

// ------------------------------------------------------- born on the cut --
//
// Spray belongs to the hull, so it has to leave from where the hull is actually
// turning water aside — and that point walks AFT as the boat gets onto the
// plane and its wetted length shortens.
{
	const mesh = { rotation: { set() {} }, position: { set() {} } };
	const body = new OceanBody( mesh, { seed: 1 } );

	body.state.speed = 1; body.att = attitude( 1 );
	const slow = Math.min( ...body.cuts( 4 ).map( ( c ) => c.along ) );
	body.state.speed = 30; body.att = attitude( 30 );
	const fast = Math.min( ...body.cuts( 4 ).map( ( c ) => c.along ) );

	need( 'the release point walks aft as the hull planes', fast > slow,
		`${ slow.toFixed( 2 ) } m -> ${ fast.toFixed( 2 ) } m aft of the bow` );
	need( 'and it agrees with the trim model, not a second guess at it',
		near( fast, Math.min( attitude( 30 ).wetStart, get( 'boat.length' ) * 0.8 ), 1e-9 ) );

	need( 'cuts are mirrored port and starboard', ( () => {
		const c = body.cuts( 3 );
		if ( c.length !== 6 ) return false;
		for ( let i = 0; i < c.length; i += 2 ) {
			if ( ! near( c[ i ].lat, - c[ i + 1 ].lat, 1e-9 ) ) return false;
			if ( ! near( c[ i ].along, c[ i + 1 ].along, 1e-9 ) ) return false;
		}
		return true;
	} )() );
	need( 'no cut sits outside the hull', ( () => {
		const half = get( 'boat.beam' ) * 0.5 + 1e-9;
		return body.cuts( 6 ).every( ( c ) => Math.abs( c.lat ) <= half
			&& c.along >= 0 && c.along <= get( 'boat.length' ) );
	} )() );
	need( 'the entry is finer than amidships', ( () => {
		body.state.speed = 0; body.att = attitude( 0 );
		const c = body.cuts( 5 ).filter( ( x ) => x.side > 0 );
		return Math.abs( c[ 0 ].lat ) < Math.abs( c[ c.length - 1 ].lat );
	} )() );
}

// A body is deterministic: two with the same seed throw the same water, or a
// capture cannot be reproduced and no A/B of anything else is trustworthy.
{
	const one = run( { speed: 12, secs: 1, spray: new Spray( 2000 ) } );
	const two = run( { speed: 12, secs: 1, spray: new Spray( 2000 ) } );
	need( 'the same seed throws the same water', ( () => {
		if ( one.spray.n !== two.spray.n ) return false;
		for ( let i = 0; i < one.spray.n; i ++ ) {
			if ( ! near( one.spray.p.x[ i ], two.spray.p.x[ i ], 1e-9 ) ) return false;
		}
		return true;
	} )(), `${ one.spray.n } droplets` );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok  ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
