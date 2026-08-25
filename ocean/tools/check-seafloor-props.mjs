#!/usr/bin/env node
// Rocks / coral on the virtual bed. No GPU.
//
//   node tools/check-seafloor-props.mjs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	FLOOR_PROP_KINDS, FLOOR_PROP_DEFAULTS, ROCK_TINTS, CORAL_TINTS,
	placeFloorProps,
} from '../src/seafloor-props.js';
import { floorDepthAt, floorDepthBounds } from '../src/seafloor.js';
import { PRESETS } from '../src/presets.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const GPU = readFileSync( join( ROOT, 'src/gpu/seafloor-props.js' ), 'utf8' );
const SKI = readFileSync( join( ROOT, 'examples/webgpu-box-ski.html' ), 'utf8' );

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

need( 'six authored kinds: three rocks, three corals',
	FLOOR_PROP_KINDS.filter( ( k ) => k.role === 'rock' ).length === 3
		&& FLOOR_PROP_KINDS.filter( ( k ) => k.role === 'coral' ).length === 3,
	FLOOR_PROP_KINDS.map( ( k ) => k.id ).join( ' ' ) );

for ( const k of FLOOR_PROP_KINDS ) {

	need( `${ k.file } is on disk`,
		existsSync( join( ROOT, 'models', k.file ) ),
		`models/${ k.file }` );
	need( `${ k.id } native height is under a metre (GLB origin on the base)`,
		k.height > 0.2 && k.height < 1.2,
		`${ k.height }` );

}

need( 'rock and coral each have several tints',
	ROCK_TINTS.length >= 4 && CORAL_TINTS.length >= 4,
	`rock ${ ROCK_TINTS.length } coral ${ CORAL_TINTS.length }` );

need( 'no bed means no props',
	placeFloorProps( { floorDepth: 0 } ).length === 0 );

const lagoon = PRESETS[ 'Tropical Lagoon' ];
const bed = floorDepthBounds( lagoon.floorDepthMin, lagoon.floorDepthMax, lagoon.floorDepth );
const a = placeFloorProps( { ...lagoon, seed: 17 } );
const b = placeFloorProps( { ...lagoon, seed: 17 } );
const c = placeFloorProps( { ...lagoon, seed: 91 } );

need( 'Tropical Lagoon plants a garden, not a handful',
	a.length >= 40 && a.length <= FLOOR_PROP_DEFAULTS.count,
	`${ a.length }` );
const noonGarden = placeFloorProps( { ...PRESETS[ 'Tropical Noon' ], seed: 17 } );
need( 'Tropical Noon plants a garden on its 5–100 m bed',
	noonGarden.length >= 20,
	`${ noonGarden.length }` );
need( 'the same seed is the same garden',
	a.length === b.length
		&& a.every( ( p, i ) => p.x === b[ i ].x && p.z === b[ i ].z && p.kind === b[ i ].kind ) );
need( 'a different seed is a different garden',
	c.length > 0 && ( c.length !== a.length || c[ 0 ].x !== a[ 0 ].x || c[ 0 ].kind !== a[ 0 ].kind ) );

{
	const seen = new Set();
	for ( const seed of [ 17, 91, 3, 42, 99 ] ) {

		for ( const p of placeFloorProps( { ...lagoon, seed } ) ) seen.add( p.kind );

	}
	need( 'every authored kind, including coral3, gets planted',
		FLOOR_PROP_KINDS.every( ( k ) => seen.has( k.id ) ),
		[ ...seen ].sort().join( ' ' ) );
}

{
	const rocks = a.filter( ( p ) => p.role === 'rock' );
	const corals = a.filter( ( p ) => p.role === 'coral' );
	need( 'the garden mixes rocks and coral',
		rocks.length > 8 && corals.length > 8,
		`rock ${ rocks.length } coral ${ corals.length }` );
	const rockReef = rocks.reduce( ( s, p ) => s + p.reef, 0 ) / rocks.length;
	const coralReef = corals.reduce( ( s, p ) => s + p.reef, 0 ) / corals.length;
	need( 'coral prefers reef patches, rocks prefer sand',
		coralReef > rockReef,
		`coral ${ coralReef.toFixed( 3 )} rock ${ rockReef.toFixed( 3 ) }` );
}

{
	let sit = true, poke = true, clear = true, yaw = 0, scales = new Set(), tints = new Set();
	let minD = Infinity;
	for ( let i = 0; i < a.length; i ++ ) {

		const p = a[ i ];
		const depth = floorDepthAt( p.x, p.z, bed.min, bed.max, lagoon.floorTerrainScale );
		const expectY = ( lagoon.seaLevel ?? 0 ) - depth - FLOOR_PROP_DEFAULTS.sink * p.scale;
		if ( Math.abs( p.y - expectY ) > 0.02 ) sit = false;
		const kind = FLOOR_PROP_KINDS.find( ( k ) => k.id === p.kind );
		if ( kind.height * p.scale > p.depth + FLOOR_PROP_DEFAULTS.emerge + 0.05 ) poke = false;
		if ( Math.hypot( p.x, p.z ) < FLOOR_PROP_DEFAULTS.clear - 0.05 ) clear = false;
		yaw += p.yaw;
		scales.add( p.scale.toFixed( 2 ) );
		tints.add( `${ p.kind }:${ p.tintI }` );
		for ( let j = i + 1; j < a.length; j ++ ) {

			minD = Math.min( minD, Math.hypot( p.x - a[ j ].x, p.z - a[ j ].z ) );

		}

	}
	need( 'every prop sits on the heightfield, not at sea level',
		sit, sit ? '' : 'a y missed the bed' );
	need( 'nothing pokes through the surface past the emerge allowance', poke );
	need( 'the ski neighbourhood stays empty', clear );
	need( 'yaws are not a lined-up regiment',
		( yaw / a.length ) > 0.4 && ( yaw / a.length ) < 6,
		`mean yaw ${( yaw / a.length ).toFixed( 2 ) }` );
	need( 'sizes vary', scales.size >= 8, `${ scales.size } scales` );
	need( 'tints vary', tints.size >= 6, `${ tints.size } batches` );
	need( 'props are spaced, not stacked',
		minD > 1.6, `min ${ minD.toFixed( 2 ) }` );
}

{
	let near = 0, far = 0;
	for ( const p of a ) {

		const r = Math.hypot( p.x, p.z );
		if ( r < 40 ) near ++;
		if ( r > 70 ) far ++;

	}
	need( 'the scatter is a garden around the ski, not a far ring',
		near > 8 && far > 8,
		`near ${ near } far ${ far }` );
}

need( 'the GPU path instances, it does not clone a GLB per rock',
	GPU.includes( 'new THREE.InstancedMesh' )
		&& GPU.includes( 'createOceanLitMaterial' )
		&& ! GPU.includes( 'bodies.add' ) );
need( 'the ski demo plants the garden on Tropical Noon',
	SKI.includes( 'loadFloorPropAssets' )
		&& SKI.includes( 'plantSeafloorProps' )
		&& SKI.includes( 'floorProps.sync' )
		&& SKI.includes( "preset: 'Tropical Noon'" ) );
need( 'the ski panel scales the mesh and lets the wake sit behind the stern',
	SKI.includes( 'id="p-scale"' )
		&& /id="p-wakeOrigin"[^>]*min="-3"/.test( SKI ) );
need( 'the dragon has the same kind of mesh panel as the ski',
	SKI.includes( 'id="props-dragon"' )
		&& SKI.includes( 'id="d-scale"' )
		&& SKI.includes( 'id="d-length"' )
		&& SKI.includes( 'id="d-fat"' )
		&& SKI.includes( 'uCreaturePaint' )
		&& SKI.includes( "setPropsTab('dragon')" ) );
need( 'the ski demo swims the sea dragon as an OceanBody',
	SKI.includes( 'SeaDragon' )
		&& SKI.includes( 'createCreatureMaterial' )
		&& SKI.includes( 'dragonBody' )
		&& SKI.includes( "keepGroups: ['Sea Dragon']" ) );
need( 'the ski demo lets you take the helm of the sea dragon',
	SKI.includes( 'KeyM' )
		&& SKI.includes( 'loafSpeed' )
		&& SKI.includes( 'toggleSwim' )
		&& SKI.includes( 'dragon.active' )
		&& SKI.includes( 'id="btn-swim"' ) );
need( 'the ski demo starts in swim mode',
	SKI.includes( 'setSwimming(true)' ) );
need( 'the ski demo starts with the chrome hidden',
	SKI.includes( 'class="ui-hidden"' )
		&& SKI.includes( 'setUiHidden(true)' )
		&& SKI.includes( 'id="keys"' )
		&& SKI.includes( 'id="btn-scene"' ) );
need( 'the piloted dragon writes waterline spray and leftover wake',
	SKI.includes( 'sprayFromParams' )
		&& SKI.includes( 'wakeFromParams' )
		&& SKI.includes( "sprayLook = 'dragon'" ) );
need( 'dragon spray look knobs live on the mesh panel',
	SKI.includes( 'id="d-spraySize"' )
		&& SKI.includes( 'id="d-sprayLife"' )
		&& SKI.includes( 'id="d-sprayOpacity"' )
		&& SKI.includes( 'sprayStations' )
		&& SKI.includes( 'buildBreachProfile' ) );
need( 'dragon swell reach uses dome-near, not camera-ray fade',
	SKI.includes( 'fade: Math.max((p.sdDomeNear' )
		&& ! /fade:\s*p\.sdFade/.test( SKI ) );
need( 'an exit splash is not treated as a landing hit',
	SKI.includes( "splashKind === 'land'" )
		&& SKI.includes( 'dragon.impact' ) );

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok' : 'FAIL' }  ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
if ( failed.length ) {

	console.error( `\n${ failed.length } failed` );
	process.exit( 1 );

}
console.log( `\n${ results.length } ok` );
