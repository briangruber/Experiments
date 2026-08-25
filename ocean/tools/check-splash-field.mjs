#!/usr/bin/env node
// CPU twin of the leap splash in water-surface.js, checked against humpback
// breach footage (youtu.be/5hBfdI_2MO8) rather than against the rigid-body
// water-entry textbook - see the note at the top of src/splash-field.js for why
// those two disagree. A landing must:
//
//   * open a hole and throw its curtain BROADSIDE, port and starboard, not as a
//     ring of equal height all round
//   * grow that curtain in over a frame or two, with a ragged feathered edge
//   * heave the middle up as the cavity closes, WITHOUT firing a needle spout
//     taller than the curtain (that was the most artificial thing in the first
//     version, and it is not in the footage)
//   * be dense white where it is churning, but never a flat plate of paint
//   * run a wave train outward and leave a long mound elongated along the body
//   * scale with the hit: a fixed radius makes a leviathan land like a pebble
//   * raise the curtain as discrete sheets (not a smooth gaussian ridge), keep
//     cavity volume in the same order as thrown volume, stamp fallen parcels
//     back onto the sea, and throw secondary droplets ahead of the lip

import {
	splashCoords, splashCrownRadius, splashBaseRadius,
	splashHeight, splashFoam, splashParcel, splashParcelRadius,
} from '../src/splash-field.js';

let failed = 0;
const check = ( name, cond ) => {

	if ( ! cond ) {

		console.error( 'FAIL', name );
		failed ++;

	}

};

const E = 2.4;
const dirx = 0, dirz = - 1;
const L = 60;
const aspect = Math.min( Math.max( 1 + L * 0.012, 1.2 ), 2.2 );
const at = ( x, z, t ) => {

	const { r, ang } = splashCoords( x, z, 0, 0, dirx, dirz, L );
	return { h: splashHeight( r, ang, t, E, L ), foam: splashFoam( r, ang, t, E, L ), r, ang };

};
const atS = ( r, ang, t ) => splashHeight( r, ang, t, E, L );
// World point whose elliptical radius is `re` at azimuth `ang`
// (dir = (0,-1): along = -z, across = x).
const world = ( re, ang ) => [ re * Math.sin( ang ), - re * aspect * Math.cos( ang ) ];
const rC = t => splashCrownRadius( t, E, L );
const atRim = ( t, ang = 0 ) => at( ...world( rC( t ), ang ), t );
const r0 = splashBaseRadius( E, L );

// --- the hit -------------------------------------------------------------
// t=0.06: hole open, curtain up broadside, foam already dense.
const BEAM = Math.PI * 0.5;      // straight out to starboard
const BOW = 0;                   // dead ahead along the body
const early = at( 0, 0, 0.06 );
check( 'early centre is a crater (negative)', early.h < - 0.4 );
check( 'early curtain is up', atRim( 0.06, BEAM ).h > 0.4 );
check( 'foam in the hole as well as on the curtain',
	early.foam > 0.25 && atRim( 0.06, BEAM ).foam > 0.3 );

// THE SIGNATURE. A whale throws its water sideways; the first version threw an
// even ring, and no amount of tuning the rest fixed how wrong that read.
let bAvg = 0, nAvg = 0, fAvg = 0;
for ( let i = 0; i < 24; i ++ ) {

	const a = ( i / 24 - 0.5 ) * 0.5;             // a fan around each direction
	bAvg += atRim( 0.12, BEAM + a ).h; nAvg += atRim( 0.12, BOW + a ).h; nAvg;
	fAvg += atRim( 0.12, BEAM + a ).foam;

}
bAvg /= 24; nAvg /= 24; fAvg /= 24;
check( 'the curtain is thrown BROADSIDE, not all round', bAvg > nAvg * 2.0 );
check( 'and it is white where it is thrown', fAvg > 0.4 );

// The curtain must rise out of nothing. Full height at t=0 pops.
check( 'curtain grows in over the first frames',
	atRim( 0.004, BEAM ).h < atRim( 0.12, BEAM ).h * 0.4 );

// A sine ring is the same height all the way around. Fingers must break that,
// and the notches must be deep — a 5% wobble still reads as a torus.
const rimHeights = [];
for ( let i = 0; i < 64; i ++ ) rimHeights.push( atRim( 0.12, i / 64 * Math.PI * 2 ).h );
const hi = Math.max( ...rimHeights ), lo = Math.min( ...rimHeights );
check( 'curtain height varies with azimuth (not a torus)', hi - lo > 0.05 );
check( 'curtain feathers into fingers, deep notches', lo < hi * 0.45 );

// --- the middle ----------------------------------------------------------
check( 'nothing comes up at the instant of the hit', at( 0, 0, 0.02 ).h < 0 );
const surge = at( 0, 0, 0.6 ).h;
check( 'the closing cavity heaves the middle up', surge > 0.15 );
// NOT a needle. The body is still filling the hole, and a spout taller than the
// curtain is the one thing in the reference footage that never happens.
check( 'the middle does not out-throw the curtain', surge < hi );
check( 'a second, smaller heave follows the first',
	at( 0, 0, 2.0 ).h > at( 0, 0, 1.6 ).h && at( 0, 0, 2.0 ).h < surge );
check( 'centre is quiet once the splash is spent', Math.abs( at( 0, 0, 4.5 ).h ) < 0.2 );

// --- the aftermath: waves running out -----------------------------------
let trainPeak = 0;
for ( let r = r0; r < rC( 1.5 ); r += 0.5 )
	trainPeak = Math.max( trainPeak, Math.abs( at( ...world( r, 0.3 ), 1.5 ).h ) );
check( 'a wave train is still running outward a second later', trainPeak > 0.1 );
check( 'nothing moves ahead of the front',
	Math.abs( at( ...world( rC( 1.5 ) * 1.6, 0.3 ), 1.5 ).h ) < 0.02 );
// The disturbance must actually travel, not just pulse in place.
const edge = t => {

	let e = 0;
	for ( let r = 0; r < rC( t ) * 1.6; r += 0.5 )
		if ( Math.abs( at( ...world( r, 0.3 ), t ).h ) > 0.05 ) e = r;
	return e;

};
check( 'the disturbance travels outward over time', edge( 1.5 ) > edge( 0.4 ) * 1.4 );

// --- scale: the hole is the size of the hit -----------------------------
check( 'a harder hit opens a bigger hole',
	splashBaseRadius( 4.0, L ) > splashBaseRadius( 1.0, L ) * 1.3 );
check( 'a longer body opens a bigger hole',
	splashBaseRadius( E, 120 ) > splashBaseRadius( E, 30 ) * 1.4 );
check( 'crown keeps expanding but decelerates',
	rC( 1 ) > rC( 0.25 ) && ( rC( 2 ) - rC( 1 ) ) < ( rC( 1 ) - rC( 0 ) ) );

// Ellipse: a point far along the body axis is closer in splash-space than the
// same metric distance off the beam, so the cavity is a slot not a disc.
const along = splashCoords( 0, - 12, 0, 0, dirx, dirz, L );
const across = splashCoords( 12, 0, 0, 0, dirx, dirz, L );
check( 'cavity is elongated along the body', along.r < across.r * 0.85 );

// --- foam: dense whitewater, but never a flat plate ---------------------
// Both halves matter and they pull against each other. The footage is nearly
// opaque white where it is churning, so a timid mask is wrong; but a mask that
// is FLAT is what makes CG water look like poured paint, and here it also feeds
// the near-field bubble relief a huge even area to magnify into a sand texture
// (measured with prototypes/splash-look.html?detail=0).
const scan = [];
for ( let r = 0; r < rC( 0.3 ) * 1.4; r += 0.5 ) scan.push( at( ...world( r, 0.9 ), 0.3 ).foam );
const peak = Math.max( ...scan ), mean = scan.reduce( ( a, b ) => a + b, 0 ) / scan.length;
check( 'the churn is dense white, like the footage', peak > 0.6 );
check( 'but not one flat plate of it',
	peak - Math.min( ...scan ) > mean * 0.5 );
// A stain, not a raft, by then - but still there, which is the point.
check( 'a stain is still on the water seconds later', at( 0, 0, 4.0 ).foam > 0.02 );
check( 'and it is gone by the end of the window', at( 0, 0, 8.0 ).foam < 0.02 );
// The mound the splash leaves runs along the animal, not around it: at the SAME
// distance in metres, a point off the bow is still inside the white and a point
// off the beam is outside it.
const late = 2.5, dOut = 1.25 * rC( late );
check( 'the aftermath is elongated along the body',
	at( 0, - dOut, late ).foam > at( dOut, 0, late ).foam * 1.5 );

// Old field: one expanding sine ring. At the curtain radius the new field is a
// ridge (gaussian), not an oscillation that goes negative on both sides.
const oldRing = ( r, t ) => {

	const ring = t * 8.5 + 4;
	const dr = r - ring;
	return Math.exp( - 0.085 * dr * dr ) * ( Math.sin( 0.9 * dr ) + 0.4 * Math.sin( 1.55 * dr ) );

};
check( 'old formula oscillates through the ring (the cartoon)', oldRing( ( 0.4 * 8.5 + 4 ) + 4.0, 0.4 ) < 0 );
check( 'the curtain stays a wall, not a sine', atRim( 0.4, BEAM ).h > 0 );

// --- discrete parcels (Splash-style P2G), not a smooth gaussian ridge -----
// A sine-notched torus is still a ridge: height never drops to a hole
// between fingers. The new field is a sum of narrow sheets, so a sample
// halfway between two beam-side parcels is a real gap.
const p3 = splashParcel( 3 ), p4 = splashParcel( 4 );
const midAng = splashAngMid( p3.ang, p4.ang );
// Splash-space, not world(): splashCoords' ellipse remaps azimuth, so a
// world point built at p.ang is not sampled at p.ang. The parcels live in
// the field's own (r, ang).
const peakH = Math.max( atS( rC( 0.12 ), p3.ang, 0.12 ), atS( rC( 0.12 ), p4.ang, 0.12 ) );
const gapH = atS( rC( 0.12 ), midAng, 0.12 );
check( 'crown is discrete sheets, not a smooth ridge', gapH < peakH * 0.55 );

// Volume conservation: the hole the body + thrown water leave should be
// the same order as the water standing in the curtain. A painted crater
// that ignores the crown is how a splash reads as a dent with a halo.
const vol = ( t, sign ) => {

	let s = 0;
	for ( let i = 0; i < 48; i ++ ) {

		const a = ( i / 48 ) * Math.PI * 2;
		for ( let re = 0; re < rC( t ) * 1.35; re += 0.8 ) {

			const h = at( ...world( re, a ), t ).h;
			if ( sign < 0 ? h < 0 : h > 0 ) s += Math.abs( h ) * re;

		}

	}
	return s;

};
const hole = vol( 0.12, - 1 ), thrown = vol( 0.12, 1 );
check( 'cavity volume tracks thrown volume',
	hole > thrown * 0.25 && hole < thrown * 2.8 );

// Return stamps: after a sheet's flight time the same azimuth gets a
// small positive mound AND foam, further out than the original hole.
const tBack = 0.62;
const rLand = splashParcelRadius( rC( 0.40 ), p3.speed );
const backH = atS( rLand, p3.ang, tBack );
const backFoam = splashFoam( rLand, p3.ang, tBack, E, L );
check( 'fallen parcels stamp height back onto the sea', backH > 0.02 );
check( 'and they stamp foam where they land', backFoam > 0.05 );

// Lip-break droplets live AHEAD of the crown, not on the rim.
let dropPeak = 0;
for ( let re = rC( 0.20 ) * 1.15; re < rC( 0.20 ) * 1.7; re += 0.6 ) {

	for ( let i = 0; i < 16; i ++ )
		dropPeak = Math.max( dropPeak, at( ...world( re, i / 16 * Math.PI * 2 ), 0.20 ).h );

}
check( 'secondary droplets break ahead of the crown lip', dropPeak > 0.02 );

function splashAngMid( a, b ) {

	const x = Math.cos( a ) + Math.cos( b );
	const y = Math.sin( a ) + Math.sin( b );
	return Math.atan2( y, x );

}

if ( failed ) {

	console.error( failed + ' splash-field checks failed' );
	process.exit( 1 );

}

console.log( 'splash-field: ok' );
