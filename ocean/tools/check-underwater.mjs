#!/usr/bin/env node
// Camera-in-the-water optics. No GPU.
//
//   node tools/check-underwater.mjs

import {
  underwaterPath, underwaterFloorT, beerTrans, snellWindow, cameraUnderwater,
  uwCaustic, SNELL_COS_CRIT, UNDER_VIS, UNDER_FLOOR, WATER_IOR,
} from '../src/underwater.js';

const fail = [];
const near = ( a, b, eps, label ) => {

  if ( ! ( Math.abs( a - b ) <= eps ) ) fail.push( `${ label }: ${ a } ≉ ${ b } ±${ eps }` );

};
const above = ( a, b, label ) => {

  if ( ! ( a > b ) ) fail.push( `${ label }: ${ a } is not greater than ${ b }` );

};

near( underwaterPath( 0, 1 ), 0, 1e-9, 'above water is no column' );
near( underwaterPath( 8, 1 ), 8, 1e-6, 'looking straight up is the depth' );
near( underwaterPath( 8, 0.5 ), 16, 1e-6, 'a shallow look-up is a longer column' );
near( underwaterPath( 8, - 1 ), UNDER_FLOOR - 8, 1e-6, 'looking down hits the virtual shelf' );
near( underwaterFloorT( 8, - 1 ), UNDER_FLOOR - 8, 1e-6, 'the shelf distance is depth-to-bed' );
if ( Number.isFinite( underwaterFloorT( 8, - 0.01 ) ) ) {

  fail.push( 'a glancing downward look misses the shelf' );

}
if ( Number.isFinite( underwaterFloorT( UNDER_FLOOR + 4, - 1 ) ) ) {

  fail.push( 'a camera below the shelf does not hit it' );

}
near( underwaterPath( UNDER_FLOOR + 4, - 1 ), UNDER_VIS, 1e-6, 'below the shelf, looking down is the cap' );
above( UNDER_VIS, underwaterPath( 8, 0.25 ), 'a steep look-up is shorter than the cap' );

let causBright = 0, causDark = 0, causSum = 0, causN = 0;
for ( let i = 0; i < 64; i ++ ) {

  for ( let j = 0; j < 64; j ++ ) {

    const c = uwCaustic( i * 1.7 + 4, j * 1.7 + 9, 3.2 );
    causSum += c;
    causN ++;
    if ( c > 1.15 ) causBright ++;
    if ( c < 0.18 ) causDark ++;

  }

}
const causMean = causSum / causN;
above( causDark, causN * 0.45, 'caustic web is mostly dark gaps' );
above( causBright, 12, 'caustic web has bright lace lines' );
above( 0.85, causMean, 'caustic mean stays a web, not a wash' );

const abs = [ 0.3, 0.045, 0.03 ];
const t10 = beerTrans( abs, 10 );
const t30 = beerTrans( abs, 30 );
above( t10[ 2 ], t10[ 0 ], 'red dies first — the column goes blue-green' );
above( t10[ 1 ], t10[ 0 ], 'green outlives red' );
above( t10[ 0 ], t30[ 0 ], 'a longer path swallows more red' );
above( 0.25, t30[ 0 ], 'thirty metres has almost no red left' );

above( SNELL_COS_CRIT, 0.64, 'critical cosine is ~cos(48.6°)' );
above( 0.68, SNELL_COS_CRIT, '…and not a tight vertical cone' );
if ( ! snellWindow( 0.92 ) ) fail.push( 'looking straight up is the window' );
if ( snellWindow( 0.35 ) ) fail.push( 'a grazing underside look is TIR, not the sky' );
if ( ! snellWindow( SNELL_COS_CRIT + 0.02 ) ) fail.push( 'just inside the critical angle is the window' );
if ( snellWindow( SNELL_COS_CRIT - 0.02 ) ) fail.push( 'just outside the critical angle is TIR' );
if ( ! snellWindow( 0.9, WATER_IOR ) ) fail.push( 'default IOR still opens a window' );

if ( cameraUnderwater( { underwater: 1, seaLevel: 0 }, - 4 ) !== true ) {

  fail.push( 'a camera under the sea with the look on is wet' );

}
if ( cameraUnderwater( { underwater: 1, seaLevel: 0 }, 4 ) !== false ) {

  fail.push( 'a camera above the sea is dry' );

}
if ( cameraUnderwater( { underwater: 0, seaLevel: 0 }, - 4 ) !== false ) {

  fail.push( 'the look off leaves a wet camera dry' );

}

if ( fail.length ) {

  console.error( 'FAIL underwater' );
  for ( const f of fail ) console.error( '  ' + f );
  process.exit( 1 );

}
console.log( 'ok  underwater  path / beer / snell / gate' );
