#!/usr/bin/env node
// Both sea-monster assets resolve, sdModel enumerates them, and each baked
// mesh has its nose on -Z with a sane length axis. No GPU: the swim, spray
// and swell stay on the SeaDragon capsule regardless of which record draws.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults } from '../src/presets.js';
import { SCHEMA } from '../demo/schema.js';
import { HINTS } from '../demo/param-hints.js';
import {
	SD_MODEL_CURRENT, SD_MODEL_SERPENT, SD_MODEL_OPTIONS,
	DRAGON_MODELS, resolveDragonModel,
} from '../demo/dragon-models.js';

let failed = 0;
const check = ( name, cond, detail = '' ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name, detail );
		failed ++;

	}

};

const unb64 = ( s, T ) => {

	const bin = atob( s );
	const u8 = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) u8[ i ] = bin.charCodeAt( i );
	return new T( u8.buffer );

};

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const src = ( spec ) => join( ROOT, spec.source );
check( 'current source exists', existsSync( src( DRAGON_MODELS[ SD_MODEL_CURRENT ] ) ), src( DRAGON_MODELS[ SD_MODEL_CURRENT ] ) );
check( 'serpent glb exists', existsSync( src( DRAGON_MODELS[ SD_MODEL_SERPENT ] ) ), src( DRAGON_MODELS[ SD_MODEL_SERPENT ] ) );
check( 'baked serpent module exists', existsSync( join( ROOT, 'demo/serpentModel.js' ) ) );

check( 'default stays Current', defaults.sdModel === SD_MODEL_CURRENT, String( defaults.sdModel ) );
check( 'resolve Current', resolveDragonModel( 'Current' ).id === 'current' );
check( 'resolve Sea serpent', resolveDragonModel( 'Sea serpent' ).id === 'serpent' );
check( 'resolve leftover 0', resolveDragonModel( 0 ).id === 'current' );
check( 'resolve leftover 1', resolveDragonModel( 1 ).id === 'serpent' );

const item = SCHEMA.flatMap( ( g ) => g.items ).find( ( it ) => it.key === 'sdModel' );
check( 'schema exposes sdModel', !! item );
check( 'schema options match catalog', JSON.stringify( item?.options ) === JSON.stringify( SD_MODEL_OPTIONS ), JSON.stringify( item?.options ) );
check( 'tooltip is a real sentence', ( HINTS.sdModel || '' ).trim().length >= 12, HINTS.sdModel );

const L = 60;
for ( const label of SD_MODEL_OPTIONS ) {

	const spec = resolveDragonModel( label );
	const rec = spec.record;
	check( `${ label } has a record`, !! rec?.pos && rec.verts > 100, String( rec?.verts ) );
	if ( ! rec?.pos ) continue;

	const pos = unb64( rec.pos, Int16Array );
	const s = L / 32000;
	let zMin = Infinity, zMax = - Infinity, yMin = Infinity, yMax = - Infinity;
	let nose = 0, tail = 0;
	const n = pos.length / 3;
	for ( let i = 0; i < n; i ++ ) {

		const y = pos[ i * 3 + 1 ] * s;
		const z = pos[ i * 3 + 2 ] * s;
		if ( z < zMin ) zMin = z;
		if ( z > zMax ) zMax = z;
		if ( y < yMin ) yMin = y;
		if ( y > yMax ) yMax = y;
		if ( z < 0 ) nose ++;
		else tail ++;

	}
	const zLen = zMax - zMin;
	check( `${ label } length axis is Z at sdLength`, Math.abs( zLen - L ) < 0.05, zLen.toFixed( 3 ) );
	check( `${ label } nose sits on -Z`, zMin < - L * 0.45 && nose > tail * 0.8,
		`zMin=${ zMin.toFixed( 2 ) } nose=${ nose } tail=${ tail }` );
	check( `${ label } is centred on Y`, Math.abs( yMin + yMax ) < 0.05, ( ( yMin + yMax ) / 2 ).toFixed( 3 ) );
	check( `${ label } yaw/lift remaps are numbers`, Number.isFinite( spec.yaw ) && Number.isFinite( spec.lift ) );
	check( `${ label } has a mouth-corner hinge`, Number.isFinite( spec.jawHY ) && Number.isFinite( spec.jawHZ )
		&& spec.jawHY > 0 && spec.jawHZ < - 0.2,
		`hy=${ spec.jawHY } hz=${ spec.jawHZ }` );
	check( `${ label } has a mouth-corner hinge`, Number.isFinite( spec.jawHY ) && Number.isFinite( spec.jawHZ )
		&& spec.jawHY > 0 && spec.jawHZ < - 0.2,
		`hy=${ spec.jawHY } hz=${ spec.jawHZ }` );

}

if ( failed ) {

	console.error( failed + ' dragon-model checks failed' );
	process.exit( 1 );

}

console.log( 'dragon-models: ok' );
