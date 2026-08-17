#!/usr/bin/env node
// Does Jaw shut angle actually move the mandible, and only the mandible?
//
//   node tools/check-dragon-jaw.mjs
//
// No GPU. The mesh ships jaw-dropped with no clip; sdGape and SeaDragon.gape
// used to be computed and then thrown away. This transcribes the vertex-stage
// hinge (src/creature-jaw.js / src/gpu/tsl/creature.js) onto both baked
// records and checks:
//
//   SHUT      a positive sdGape lifts the chin
//   SLIDER    more radians lifts more; 0 leaves the bind pose
//   SKULL     the upper jaw / crown does not move
//   BODY      verts aft of the mouth corner stay put
//   LIVE      dragon.gape = 1 (modelled-open) releases the shut
//   SERPENT   the reared head has its own hinge; a Current hinge
//             would catch the hanging coils, so this is not optional

import { DRAGON_MESH } from '../demo/dragonModel.js';
import { SERPENT_MESH } from '../demo/serpentModel.js';
import {
	SD_MODEL_CURRENT, SD_MODEL_SERPENT, resolveDragonModel,
} from '../demo/dragon-models.js';
import { jawRotate, jawShutAngle, jawWeight } from '../src/creature-jaw.js';
import { defaults } from '../src/presets.js';

const unb64 = ( s, T ) => {

	const bin = atob( s );
	const u8 = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) u8[ i ] = bin.charCodeAt( i );
	return new T( u8.buffer );

};

let failed = 0;
const check = ( name, cond, detail = '' ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name, detail );
		failed ++;

	}

};

const L = 60;
const decode = ( rec ) => {

	const pos = unb64( rec.pos, Int16Array );
	const s = L / 32000;
	const P = [];
	for ( let i = 0; i < pos.length / 3; i ++ ) {

		P.push( { x: pos[ i * 3 ] * s, y: pos[ i * 3 + 1 ] * s, z: pos[ i * 3 + 2 ] * s } );

	}
	return P;

};

const apply = ( P, gape, hy, hz ) => P.map( ( p ) => jawRotate( p, null, gape, L, hy, hz ).p );

const current = resolveDragonModel( SD_MODEL_CURRENT );
const serpent = resolveDragonModel( SD_MODEL_SERPENT );
check( 'Current hinge is a fraction of length', current.jawHY > 0 && current.jawHY < 0.05 && current.jawHZ < - 0.3,
	`hy=${ current.jawHY } hz=${ current.jawHZ }` );
check( 'Serpent hinge is on the reared head', serpent.jawHY > 0.2 && serpent.jawHY < 0.35 && serpent.jawHZ < - 0.3,
	`hy=${ serpent.jawHY } hz=${ serpent.jawHZ }` );

const Pc = decode( DRAGON_MESH );
const chin0 = Pc.filter( ( p ) => p.z < - 26 ).reduce( ( a, p ) => ( p.y < a.y ? p : a ) );
const skull0 = Pc.filter( ( p ) => p.y > 4 && p.z < - 26 ).reduce( ( a, p ) => ( p.y > a.y ? p : a ) );
const belly0 = Pc.filter( ( p ) => p.z > 0 ).reduce( ( a, p ) => ( p.y < a.y ? p : a ) );

check( 'Current chin is the dropped mandible', chin0.y < - 3 && chin0.z < - 26,
	`(${ chin0.x.toFixed( 2 ) },${ chin0.y.toFixed( 2 ) },${ chin0.z.toFixed( 2 ) })` );
check( 'chin is weighted as mandible', jawWeight( chin0.y, chin0.z, L, current.jawHY, current.jawHZ ) > 0.95,
	jawWeight( chin0.y, chin0.z, L, current.jawHY, current.jawHZ ).toFixed( 3 ) );
check( 'skull is not weighted', jawWeight( skull0.y, skull0.z, L, current.jawHY, current.jawHZ ) < 0.02,
	jawWeight( skull0.y, skull0.z, L, current.jawHY, current.jawHZ ).toFixed( 3 ) );
check( 'belly is not weighted', jawWeight( belly0.y, belly0.z, L, current.jawHY, current.jawHZ ) < 0.02,
	jawWeight( belly0.y, belly0.z, L, current.jawHY, current.jawHZ ).toFixed( 3 ) );

const shut0 = apply( Pc, 0, current.jawHY, current.jawHZ );
const chinAt0 = shut0[ Pc.indexOf( chin0 ) ];
check( 'gape 0 leaves the bind pose', Math.abs( chinAt0.y - chin0.y ) < 1e-6 && Math.abs( chinAt0.z - chin0.z ) < 1e-6,
	`dy=${ ( chinAt0.y - chin0.y ).toFixed( 4 ) }` );

const rest = defaults.sdGape;
const shutRest = apply( Pc, rest, current.jawHY, current.jawHZ );
const chinRest = shutRest[ Pc.indexOf( chin0 ) ];
const skullRest = shutRest[ Pc.indexOf( skull0 ) ];
const bellyRest = shutRest[ Pc.indexOf( belly0 ) ];
check( 'default sdGape lifts the chin', chinRest.y - chin0.y > 1.2,
	`dy=${ ( chinRest.y - chin0.y ).toFixed( 2 ) } m at ${ rest } rad` );
check( 'default sdGape does not move the skull', Math.hypot( skullRest.y - skull0.y, skullRest.z - skull0.z ) < 1e-4,
	`d=${ Math.hypot( skullRest.y - skull0.y, skullRest.z - skull0.z ).toFixed( 4 ) }` );
check( 'default sdGape does not move the belly', Math.hypot( bellyRest.y - belly0.y, bellyRest.z - belly0.z ) < 1e-4,
	`d=${ Math.hypot( bellyRest.y - belly0.y, bellyRest.z - belly0.z ).toFixed( 4 ) }` );

const shutMore = apply( Pc, 0.8, current.jawHY, current.jawHZ );
const chinMore = shutMore[ Pc.indexOf( chin0 ) ];
check( 'more shut angle lifts more', chinMore.y > chinRest.y + 1.5,
	`0.30 -> ${ chinRest.y.toFixed( 2 ) } vs 0.80 -> ${ chinMore.y.toFixed( 2 ) }` );

check( 'live gape 0 applies the slider', Math.abs( jawShutAngle( 0.30, 0 ) - 0.30 ) < 1e-9 );
check( 'live gape 1 releases to bind pose', Math.abs( jawShutAngle( 0.30, 1 ) ) < 1e-9 );
check( 'live gape 0.5 is half the slider', Math.abs( jawShutAngle( 0.30, 0.5 ) - 0.15 ) < 1e-9 );

const Ps = decode( SERPENT_MESH );
const sChin0 = Ps.filter( ( p ) => p.z < - 24 && p.y > 10 && p.y < 16 )
	.reduce( ( a, p ) => ( p.y < a.y ? p : a ) );
const sCrown0 = Ps.filter( ( p ) => p.z < - 26 && p.y > 22 )
	.reduce( ( a, p ) => ( p.y > a.y ? p : a ) );
const sCoil0 = Ps.filter( ( p ) => p.z > 5 && Math.abs( p.x ) > 4 )
	.reduce( ( a, p ) => ( p.y < a.y ? p : a ) );

const sShut = apply( Ps, rest, serpent.jawHY, serpent.jawHZ );
const sChin = sShut[ Ps.indexOf( sChin0 ) ];
const sCrown = sShut[ Ps.indexOf( sCrown0 ) ];
const sCoil = sShut[ Ps.indexOf( sCoil0 ) ];
check( 'serpent chin lifts', sChin.y - sChin0.y > 0.4,
	`dy=${ ( sChin.y - sChin0.y ).toFixed( 2 ) }` );
check( 'serpent crown stays', Math.hypot( sCrown.y - sCrown0.y, sCrown.z - sCrown0.z ) < 1e-4 );
check( 'serpent hanging coil stays', Math.hypot( sCoil.y - sCoil0.y, sCoil.z - sCoil0.z ) < 1e-4,
	`d=${ Math.hypot( sCoil.y - sCoil0.y, sCoil.z - sCoil0.z ).toFixed( 4 ) }` );

const sHang0 = Ps.filter( ( p ) => p.y < - 4 && p.z < - 21 && p.z > - 24 )
	.reduce( ( a, p ) => ( p.y < a.y ? p : a ) );
check( 'a Current hinge on the serpent would move a hanging coil',
	jawWeight( sHang0.y, sHang0.z, L, current.jawHY, current.jawHZ ) > 0.05,
	`w=${ jawWeight( sHang0.y, sHang0.z, L, current.jawHY, current.jawHZ ).toFixed( 3 ) } at z=${ sHang0.z.toFixed( 2 ) }` );

if ( failed ) {

	console.error( failed + ' dragon-jaw checks failed' );
	process.exit( 1 );

}

console.log( 'dragon-jaw: ok' );
