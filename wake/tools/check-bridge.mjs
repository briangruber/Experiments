#!/usr/bin/env node
// The seam between the prototype's wake field and Abyssal's water.
//
// Every bug this file guards against has already happened once, and each cost
// a fifteen-minute render to find. None of them needs a GPU to catch: they are
// all disagreements between two files about what a number means.
//
//   node tools/check-bridge.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const read = ( p ) => readFileSync( join( ROOT, p ), 'utf8' );

const LAB_OCEAN = read( 'src/ocean.js' );       // the known-good sampler
const FORK = read( 'vendor/abyssal/src/wake.js' );
const BRIDGE = read( 'src/wakeBridge.js' );
const FIELD = read( 'src/wakeField.js' );

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

// ------------------------------------------------------------ the UV frame --
//
// The field is baked through an orthographic camera with up = (0, 0, -1), so
// +Z in the world runs DOWN the texture. Both samplers have to know that. The
// fork did not, and the result was a perfectly good wake drawn mirrored in Z
// about the field centre -- which reads as "the wake is nowhere near the
// boat", not as "the wake is upside down", so it sends you looking for a
// binding bug that is not there.

const flip = ( src ) => /uWake(?:Center|Origin)\s*\)\s*\/\s*uWakeExtent\s*\*\s*vec2\(\s*1\.0\s*,\s*-\s*1\.0\s*\)/.test( src );

need( 'the bake camera still looks down with up = (0, 0, -1)',
	/camera\.up\.set\(\s*0\s*,\s*0\s*,\s*-\s*1\s*\)/.test( FIELD ),
	'if this changes, BOTH samplers below are wrong' );
need( "the lab's own sampler flips V", flip( LAB_OCEAN ) );
need( 'the vendored fork flips V the same way', flip( FORK ) );
need( 'both add the same 0.5 recentring',
	( LAB_OCEAN.match( /\+\s*0\.5;/ ) || [] ).length > 0
		&& /\*\s*vec2\(\s*1\.0\s*,\s*-\s*1\.0\s*\)\s*\+\s*0\.5/.test( FORK ) );

// ---------------------------------------------------------- what is bound --
//
// Origin and extent have to be the field's OWN, or the wake lands at a fixed
// offset from wherever the boat is -- the same symptom as the flip, from a
// different cause.
need( 'the bridge binds the field centre as the origin',
	/uWakeOrigin:\s*new Float32Array\(\s*\[\s*c\.x,\s*c\.y\s*\]/.test( BRIDGE )
		&& /const c = this\.field\.center/.test( BRIDGE ) );
need( 'the bridge binds the field extent',
	/uWakeExtent:\s*Math\.max\(\s*this\.field\.extent/.test( BRIDGE ) );
need( 'the bridge binds the field texture, not a placeholder',
	/uWakeTex:\s*\{\s*target:\s*gl\.TEXTURE_2D,\s*tex\s*\}/.test( BRIDGE ) );

// -------------------------------------------------------- the four channels --
//
// wakeField.js writes RGBA in one place. The fork reads it in another. Nothing
// but this check connects the two.
{
	const out = FIELD.slice( FIELD.indexOf( 'gl_FragColor = vec4(' ) );
	const order = [ 'foam', 'height', 'surfaced', 'bubOut' ];
	const emitted = out.slice( 0, out.indexOf( ');' ) );
	need( 'the field still writes foam, height, surfaced bubbles, density',
		emitted.includes( 'foam * edge' )
			&& emitted.includes( 'height * edge' )
			&& emitted.includes( 'surfaced * edge' ),
		order.join( ' / ' ) );
	need( 'the fork reads R as coverage and G as SIGNED height',
		/float foam = clamp\( ?r\.r/.test( FORK ) && /float h = r\.g/.test( FORK ) );
	// Signed height is why the format matters: half a wake is below the
	// waterline, and an 8-bit target would clamp all of it to zero.
	need( 'the field target is half-float, so negative height survives',
		/type:\s*THREE\.HalfFloatType/.test( FIELD ) );
	need( 'the fork does not clamp height to positive',
		! /float h = max\(\s*r\.g/.test( FORK ) );
}

// --------------------------------------------------------------- the gates --
need( "Abyssal's own energy ribbon stays off through the bridge",
	/uFoamEnergyOn:\s*0/.test( BRIDGE ) );
need( 'the fork no longer reconstructs arms from a record it does not have',
	! /float arm = uWakeWidth0 \+ rate \* age/.test( FORK ),
	'the field arrives already shaped' );

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok  ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
