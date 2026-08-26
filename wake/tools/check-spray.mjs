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

// ------------------------------------------------------- turning and lean --
//
// A planing hull banks INTO a turn, and the lean has to come from speed and
// rate together -- a hard turn at a crawl barely leans, the same wheel at
// planing speed lays it over.
{
	const mesh = { rotation: { set( x, y, z ) { this.x = x; this.y = y; this.z = z; } },
		position: { set( x, y, z ) { this.x = x; this.y = y; this.z = z; } } };
	const body = new OceanBody( mesh, { seed: 5 } );
	const at = ( speed, turn ) => {
		body.state.speed = speed; body.state.turn = turn;
		return body.bank();
	};

	need( 'straight running has no lean', at( 20, 0 ) === 0 );
	need( 'a stopped hull does not lean however hard the wheel is over',
		at( 0, 0.6 ) === 0 );
	need( 'lean grows with speed at the same rate of turn',
		Math.abs( at( 20, 0.3 ) ) > Math.abs( at( 5, 0.3 ) ),
		`${ ( at( 5, 0.3 ) * 180 / Math.PI ).toFixed( 2 ) } deg vs `
			+ `${ ( at( 20, 0.3 ) * 180 / Math.PI ).toFixed( 2 ) } deg` );
	need( 'lean grows with rate of turn at the same speed',
		Math.abs( at( 15, 0.5 ) ) > Math.abs( at( 15, 0.1 ) ) );
	need( 'it banks INTO the turn — lean follows the sign of the wheel',
		Math.sign( at( 15, 0.4 ) ) === Math.sign( 0.4 )
			&& Math.sign( at( 15, -0.4 ) ) === Math.sign( -0.4 ) );
	need( 'lean is capped — past a point a hull trips rather than leans further',
		Math.abs( at( 90, 3 ) ) <= get( 'boat.bankMax' ) * Math.PI / 180 + 1e-9,
		`${ ( at( 90, 3 ) * 180 / Math.PI ).toFixed( 1 ) } deg cap `
			+ `${ get( 'boat.bankMax' ) }` );
	need( 'it matches the coordinated-turn relation atan(v.omega/g)', ( () => {
		set( 'boat.bank', 1 ); set( 'boat.bankMax', 89 );
		const v = 12, w = 0.25;
		const ok = Math.abs( at( v, w ) - Math.atan2( v * w, 9.81 ) ) < 1e-9;
		set( 'boat.bankMax', 22 );
		return ok;
	} )() );
}

// The hull turns about a point aft of the stem, not about the stem, or a
// stationary turn sweeps the stern through an arc and walks away from the wake.
{
	const mesh = { rotation: { set() {} },
		position: { set( x, y, z ) { this.x = x; this.y = y; this.z = z; } } };
	const body = new OceanBody( mesh, { seed: 5 } );
	body.state.speed = 0;

	need( 'the bow sits ahead of the simulated pivot',
		Math.abs( body.bowOffset() - get( 'boat.length' ) * get( 'boat.pivot' ) ) < 1e-9,
		`${ body.bowOffset().toFixed( 2 ) } m` );

	// Rotate on the spot and watch the pivot, which must not move.
	const track = [];
	for ( let h = 0; h < Math.PI * 2; h += 0.4 ) {
		body.state.heading = h;
		body.pose();
		// Back out the pivot from the posed bow: it is the fixed point.
		const fwd = body.forward();
		track.push( [ mesh.position.x - fwd.x * body.bowOffset(),
			mesh.position.z - fwd.y * body.bowOffset() ] );
	}
	need( 'a turn on the spot holds the pivot still', ( () => {
		return track.every( ( [ x, z ] ) => Math.abs( x ) < 1e-9 && Math.abs( z ) < 1e-9 );
	} )() );
	need( 'and the bow itself sweeps, which is what a hull does', ( () => {
		let far = 0;
		for ( let h = 0; h < Math.PI * 2; h += 0.4 ) {
			body.state.heading = h; body.pose();
			far = Math.max( far, Math.hypot( mesh.position.x, mesh.position.z ) );
		}
		return far > body.bowOffset() * 0.9;
	} )() );
	need( 'pivot 0 restores the old stem-centred behaviour', ( () => {
		set( 'boat.pivot', 0 );
		body.state.heading = 1.1; body.pose();
		const ok = Math.abs( mesh.position.x ) < 1e-9 && Math.abs( mesh.position.z ) < 1e-9;
		set( 'boat.pivot', 0.32 );
		return ok;
	} )() );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok  ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
