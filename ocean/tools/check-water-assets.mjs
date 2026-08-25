#!/usr/bin/env node
// Original foam / impact assets and the contracts that keep them subordinate
// to simulated coverage and crossing energy.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	FOAM_LACE_PNG_BASE64,
	WAKE_FOAM_PACK_PNG_BASE64,
	SPLASH_ATLAS_PNG_BASE64,
} from '../src/generated-water-assets.js';
import { defaults } from '../src/presets.js';
import { entryAmount } from '../src/splash-field.js';
import { WATER_FS } from '../src/shaders/water.js';
import { SPRAY_FS, SPRAY_SIM_FS } from '../src/shaders/spray.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

function pngInfo( bytes ) {

	const sig = '89504e470d0a1a0a';
	return {
		png: bytes.subarray( 0, 8 ).toString( 'hex' ) === sig,
		width: bytes.readUInt32BE( 16 ),
		height: bytes.readUInt32BE( 20 ),
		bitDepth: bytes[ 24 ],
		colorType: bytes[ 25 ],
	};

}

const foam = await readFile( join( ROOT, 'src/assets/foam-lace.png' ) );
const wakeFoam = await readFile( join( ROOT, 'src/assets/wake-foam-pack.png' ) );
const splash = await readFile( join( ROOT, 'src/assets/splash-atlas.png' ) );
const foamInfo = pngInfo( foam );
const wakeFoamInfo = pngInfo( wakeFoam );
const splashInfo = pngInfo( splash );

need( 'foam lace is a compact 512 square grayscale PNG',
	foamInfo.png && foamInfo.width === 512 && foamInfo.height === 512
		&& foamInfo.bitDepth === 8 && foamInfo.colorType === 0,
	JSON.stringify( foamInfo ) );
need( 'splash atlas is a 4x2 grayscale PNG',
	splashInfo.png && splashInfo.width === 1024 && splashInfo.height === 512
		&& splashInfo.bitDepth === 8 && splashInfo.colorType === 0,
	JSON.stringify( splashInfo ) );
need( 'wake foam is one compact RGBA pack with three independent masks',
	wakeFoamInfo.png && wakeFoamInfo.width === 512 && wakeFoamInfo.height === 512
		&& wakeFoamInfo.bitDepth === 8 && wakeFoamInfo.colorType === 6,
	JSON.stringify( wakeFoamInfo ) );
need( 'embedded foam bytes match the project asset',
	Buffer.from( FOAM_LACE_PNG_BASE64, 'base64' ).equals( foam ) );
need( 'embedded wake foam bytes match the project asset',
	Buffer.from( WAKE_FOAM_PACK_PNG_BASE64, 'base64' ).equals( wakeFoam ) );
need( 'embedded splash bytes match the project asset',
	Buffer.from( SPLASH_ATLAS_PNG_BASE64, 'base64' ).equals( splash ) );

need( 'authored foam is leftover lace — coverage off, texture lace full',
	defaults.foamTextureAmount === 1
		&& defaults.foamAmount === 0
		&& defaults.foamFill === 0
		&& defaults.foamCell === 0.25 );
need( 'open-ocean shoreline foam remains off',
	defaults.shoreFoamAmount === 0 );
need( 'no surface crossing means no impact plate event',
	entryAmount( { craftPierce: 0, craftImpact: 1 } ) === 0
		&& entryAmount( { craftPierce: 1, craftImpact: 0 } ) === 0 );
need( 'a hard crossing produces an impact event',
	entryAmount( { craftPierce: 1, craftImpact: 1 } ) > 0.9 );

need( 'classic water thresholds the asset against depth coverage',
	WATER_FS.includes( 'uFoamLace' )
		&& WATER_FS.includes( 'shoreCov' )
		&& WATER_FS.includes( 'floorTerrainDepth' ) );
need( 'classic leftover wake is a film the lace wrinkles',
	WATER_FS.includes( 'uWakeFoamPack' )
		&& WATER_FS.includes( 'wakePattern' )
		&& WATER_FS.includes( 'wakeWrinkle' )
		&& WATER_FS.includes( 'foamEnergyAt' )
		&& ! WATER_FS.includes( 'wakeAcrossUv' ) );
need( 'classic water covers leftover hull foam from the energy field',
	WATER_FS.includes( 'foamEnergyAt' )
		&& WATER_FS.includes( 'uFoamEnergy' ) );
need( 'classic spray gates the atlas on hull entry',
	SPRAY_FS.includes( 'uSplashAtlas' )
		&& SPRAY_FS.includes( 'vHull * uEntry * uSplashPlateAmount' ) );
need( 'classic hull spray shares birth rolls across mirrored side pairs',
	SPRAY_SIM_FS.includes( 'balancedFid' )
		&& SPRAY_SIM_FS.includes( 'sourceFid' )
		&& SPRAY_SIM_FS.includes( 'fid - sideBand * 4.0' ) );

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
