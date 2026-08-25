#!/usr/bin/env node
// Hull-wake whitewater: coverage comes from breaking waves, not from a
// painted path. No GPU — this is pure maths and finishes in under a second.
//
//   node tools/check-wake-suds.mjs

import {
	SUDS_G, SUDS_BREAK_STEEP, SUDS_BREAK_SPAN, SUDS_TRANSVERSE,
	SUDS_SOFTNESS, SUDS_GRAIN_WEIGHT, SUDS_CELL_WEIGHT, SUDS_WALL, SUDS_COARSEN,
	sudsWavenumber, sudsCrestGate, sudsBreak, sudsBreakField,
	sudsWallWidth, sudsLacePoint, sudsDetail, sudsCrisp, sudsLace,
	sudsOpacity, sudsTroughBias, sudsWashLanes, sudsWash,
} from '../src/wake-suds.js';
import {
	uSudsBreak, uSudsSteep, setWakeSudsUniforms,
} from '../src/gpu/tsl/wake-suds.js';
import { defaults } from '../src/presets.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const TSL_SUDS = readFileSync( join( ROOT, 'src/gpu/tsl/wake-suds.js' ), 'utf8' );
const CPU_SUDS = readFileSync( join( ROOT, 'src/wake-suds.js' ), 'utf8' );
const TSL_WATER = readFileSync( join( ROOT, 'src/gpu/tsl/water-surface.js' ), 'utf8' );
const TSL_DRIVER = readFileSync( join( ROOT, 'src/gpu/tsl/water-driver.js' ), 'utf8' );

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );
const near = ( a, b, eps = 1e-6 ) => Math.abs( a - b ) <= eps;

// ---------------------------------------------------------------- breaking --
//
// The claim that matters: foam is a consequence of the wave, so a wave that
// is not steep enough makes none, however much wake is present.

{
	const k = sudsWavenumber( 8 );
	need( 'a wave below critical steepness makes no foam at all',
		sudsBreak( SUDS_BREAK_STEEP / k * 0.9, k ) === 0,
		`ak = ${ ( SUDS_BREAK_STEEP * 0.9 ).toFixed( 3 ) }` );
	need( 'a wave well past critical is fully broken',
		near( sudsBreak( SUDS_BREAK_STEEP * SUDS_BREAK_SPAN / k, k ), 1, 1e-9 ) );
	need( 'coverage rises monotonically through the break', ( () => {
		let prev = - 1;
		for ( let i = 0; i <= 20; i ++ ) {
			const amp = ( SUDS_BREAK_STEEP * SUDS_BREAK_SPAN * ( i / 20 ) ) / k;
			const c = sudsBreak( amp, k );
			if ( c < prev - 1e-12 ) return false;
			prev = c;
		}
		return true;
	} )() );
}

// Steepness is amplitude TIMES wavenumber, so the pair trades off exactly.
// This is what makes coverage follow the wave field rather than the path:
// nothing here is told a speed, a heading or a Kelvin angle.
{
	const a = sudsBreak( 0.20, 0.60 );
	const b = sudsBreak( 0.40, 0.30 );
	need( 'steepness is amplitude x wavenumber (double one, halve the other)',
		near( a, b ), `${ a.toFixed( 6 ) } vs ${ b.toFixed( 6 ) }` );
}

// A fast hull radiates LONG waves (k = g/U²), which need proportionally more
// amplitude to break — the reason a planing wake froths on its arms while a
// displacement wake at the hump froths across its whole transverse system.
{
	need( 'wavenumber is g/U^2, so a fast hull makes long waves',
		near( sudsWavenumber( 7 ), SUDS_G / 49, 1e-12 )
			&& sudsWavenumber( 14 ) < sudsWavenumber( 7 ) );
	need( 'a parked hull radiates nothing to break', sudsWavenumber( 0 ) === 0 );
	const amp = 0.40;
	need( 'the same crest breaks at slow speed and holds together at speed',
		sudsBreak( amp, sudsWavenumber( 4 ) ) > 0.5
			&& sudsBreak( amp, sudsWavenumber( 12 ) ) === 0,
		`ak ${ ( amp * sudsWavenumber( 4 ) ).toFixed( 3 ) } vs `
			+ `${ ( amp * sudsWavenumber( 12 ) ).toFixed( 3 ) }` );
}

// Foam is shed off the face of a crest. Filling the trough behind it is what
// makes a wake read as a white disk instead of as water breaking.
{
	need( 'the trough stays water', sudsCrestGate( - 1 ) === 0 );
	need( 'the crest breaks', sudsCrestGate( 1 ) === 1 );
	need( 'a trough makes no foam however steep the wave',
		sudsBreak( 10, 1, - 1 ) === 0 );
}

{
	const k = 0.5, big = 1.0;
	need( 'the transverse system breaks later and weaker than the divergent one',
		near( sudsBreakField( 0, big, k ) / sudsBreakField( big, 0, k ),
			SUDS_TRANSVERSE, 1e-9 ) );
	need( 'the two systems sum, clamped', sudsBreakField( big, big, k ) === 1 );
}

// ---------------------------------------------------------------- the lace --

// The cell function is a ridge — bright ON the contour, dark either side — so
// a detail field it dominates thresholds into nested outlines. That is a
// contour map, not a bubble raft.
{
	need( 'the detail field is grain-dominant, not ridge-dominant',
		SUDS_GRAIN_WEIGHT > SUDS_CELL_WEIGHT,
		`grain ${ SUDS_GRAIN_WEIGHT } vs cells ${ SUDS_CELL_WEIGHT }` );
	need( 'detail stays inside 0..1 for any input',
		sudsDetail( 1, 1 ) === 1 && sudsDetail( 0, 0 ) === 0
			&& sudsDetail( - 5, - 5 ) === 0 );
}

// Coarsening old foam must widen the WALL, never scale the sample position:
// scaling coordinates by a spatially varying quantity warps the noise along
// that quantity's gradient, and the lace snaps onto iso-contours of coverage.
{
	need( 'thinning foam widens the cell walls',
		sudsWallWidth( 0 ) > sudsWallWidth( 1 )
			&& near( sudsWallWidth( 1 ), SUDS_WALL )
			&& near( sudsWallWidth( 0 ), SUDS_WALL + SUDS_COARSEN ) );
	need( 'coarsening 0 leaves the wall alone',
		near( sudsWallWidth( 0, 0 ), SUDS_WALL ) );
	need( 'the sample point does not depend on coverage', ( () => {
		const args = [ [ 12, - 7 ], [ 0.3, - 0.2 ], [ 0.1, 0.4 ],
			{ drift: 1, ring: 1, scale: 0.8 } ];
		const p = sudsLacePoint( ...args );
		// If coverage ever reached this function it would have to arrive as an
		// argument; there is nowhere else for it to come from. So assert on the
		// source: neither the signature nor the body may mention it.
		const src = sudsLacePoint.toString();
		return near( p[ 0 ], sudsLacePoint( ...args )[ 0 ] )
			&& ! /cover|foam/i.test( src );
	} )() );
	need( 'lace offsets are bounded, so the pattern distorts without travelling',
		( () => {
			const at = ( t ) => sudsLacePoint( [ 5, 5 ],
				[ Math.sin( t ) * 0.3, Math.cos( t ) * 0.3 ],
				[ Math.sin( t * 2 ), Math.cos( t * 2 ) ],
				{ drift: 1, ring: 0.5, scale: 1 } );
			let lo = Infinity, hi = - Infinity;
			for ( let t = 0; t < 40; t += 0.1 ) {
				const d = at( t )[ 0 ] - 5;
				lo = Math.min( lo, d ); hi = Math.max( hi, d );
			}
			return hi - lo < 4 && Math.abs( at( 0 )[ 0 ] - at( 39.9 )[ 0 ] ) < 4;
		} )() );
}

// Coverage slides a threshold down through the detail field: dense foam takes
// all of it, thin foam keeps only the walls, and the gap between is the fringe.
{
	need( 'dense foam takes the whole field', sudsLace( 0.5, 1.4 ) === 1 );
	need( 'no foam, no lace', sudsLace( 0.5, 0 ) === 0 );
	need( 'thin foam keeps only the brightest cells',
		sudsLace( 0.95, 0.2 ) > sudsLace( 0.45, 0.2 )
			&& sudsLace( 0.45, 0.2 ) === 0 );
	need( 'softness widens the fringe rather than moving it', ( () => {
		const tight = sudsLace( 0.62, 0.5, 0.05 );
		const soft = sudsLace( 0.62, 0.5, 0.9 );
		return tight === 1 && soft > 0 && soft < 1;
	} )() );
}

// Sub-pixel lace aliases into sparkle, so it has to fade toward flat.
{
	const scale = 0.5;                       // 2 m cells
	need( 'lace is crisp when a cell spans many pixels',
		near( sudsCrisp( 0.05, scale ), 1 ) );
	need( 'lace goes flat once a cell drops under a couple of pixels',
		sudsCrisp( 2.0, scale ) === 0 );
	need( 'the fade is monotonic in pixel footprint', ( () => {
		let prev = 2;
		for ( let px = 0; px < 3; px += 0.05 ) {
			const c = sudsCrisp( px, scale );
			if ( c > prev + 1e-12 ) return false;
			prev = c;
		}
		return true;
	} )() );
}

// --------------------------------------------------------------- opacity --
//
// Beer-Lambert, so foam approaches white asymptotically instead of landing on
// a hard cut-out edge. A bare threshold is what makes foam read as a decal.
{
	need( 'no foam is fully transparent', sudsOpacity( 1, 0 ) === 0 );
	need( 'full coverage is not yet opaque, so the fringe has somewhere to go',
		sudsOpacity( 1, 1 ) < 0.7 && sudsOpacity( 1, 3 ) < 1,
		`alpha ${ sudsOpacity( 1, 1 ).toFixed( 3 ) } at coverage 1` );
	need( 'opacity is monotonic in coverage', ( () => {
		let prev = - 1;
		for ( let c = 0; c <= 3; c += 0.05 ) {
			const a = sudsOpacity( 1, c );
			if ( a < prev - 1e-12 ) return false;
			prev = a;
		}
		return true;
	} )() );
	need( 'more lace means more opaque foam',
		sudsOpacity( 1, 0.5, 1, 1 ) > sudsOpacity( 1, 0.5, 1, 0 ) );
	need( 'the curve is smooth through the fringe — no step anywhere', ( () => {
		let last = sudsOpacity( sudsLace( 0.5, 0 ), 0 );
		for ( let c = 0.01; c <= 1.5; c += 0.01 ) {
			const a = sudsOpacity( sudsLace( 0.5, c ), c );
			if ( Math.abs( a - last ) > 0.08 ) return false;
			last = a;
		}
		return true;
	} )() );
}

{
	need( 'bubbles pool in the troughs and thin over the crests',
		sudsTroughBias( 0.5, - 0.3, 0.3, 0.5 ) > 0.5
			&& sudsTroughBias( 0.5, 0.3, 0.3, 0.5 ) < 0.5 );
	need( 'zero bias leaves coverage alone',
		near( sudsTroughBias( 0.5, - 0.3, 0.3, 0 ), 0.5 ) );
}

// -------------------------------------------------------------- prop wash --
//
// The white channels behind a transom are one per screw. They are born
// separate and merge aft, which is the read that says how many are fitted.
{
	need( 'one engine sits on the keel', ( () => {
		const l = sudsWashLanes( 1, 0.8 );
		return l.length === 1 && l[ 0 ] === 0;
	} )() );
	need( 'lanes are symmetric about the keel and honour the spacing', ( () => {
		const l = sudsWashLanes( 4, 0.8 );
		return l.length === 4
			&& near( l[ 0 ], - l[ 3 ] ) && near( l[ 1 ], - l[ 2 ] )
			&& near( l[ 1 ] - l[ 0 ], 0.8 );
	} )() );
	need( 'twins leave two channels at the transom', ( () => {
		const at = ( lat ) => sudsWash( lat, 0, 2, 1.6, { width: 0.4 } );
		return at( - 0.8 ) > 0.9 && at( 0.8 ) > 0.9 && at( 0 ) < 0.6;
	} )() );
	need( 'those channels merge downstream on their own', ( () => {
		const aft = ( a ) => sudsWash( 0, a, 2, 1.6, { width: 0.4, spread: 0.3 } );
		return aft( 0 ) < 0.6 && aft( 40 ) > 0.9;
	} )() );
	need( 'a single screw shows no channel between lanes to merge', ( () => {
		const at = ( lat ) => sudsWash( lat, 0, 1, 1.6, { width: 0.4 } );
		return at( 0 ) > 0.9 && at( 0 ) >= at( 0.4 );
	} )() );
}

// ------------------------------------------------------------ shader twin --
//
// A changed digit in src/wake-suds.js is a changed image in the TSL film.
// These are the numbers and the rules that must not drift between them.
{
	need( 'the TSL twin carries the same break criterion',
		TSL_SUDS.includes( 'SUDS_BREAK_STEEP' )
			&& TSL_SUDS.includes( 'SUDS_BREAK_SPAN' )
			&& TSL_SUDS.includes( 'SUDS_TRANSVERSE' ) );
	need( 'the TSL twin imports the constants rather than restating them',
		/from '\.\.\/\.\.\/wake-suds\.js'/.test( TSL_SUDS ) );
	need( 'the TSL twin thresholds the same grain-dominant field',
		TSL_SUDS.includes( 'SUDS_GRAIN_WEIGHT' )
			&& TSL_SUDS.includes( 'SUDS_CELL_WEIGHT' ) );
	need( 'the TSL twin composites Beer-Lambert, not a threshold',
		/1\.0\s*\)?\s*\.sub\(.*\.negate\(\)\.exp\(\)|sub\(\s*t\.negate\(\)\.exp\(\)/s
			.test( TSL_SUDS ) || TSL_SUDS.includes( '.negate().exp()' ) );
	need( 'the TSL twin does not scale the sample point by coverage',
		! /lacePoint[\s\S]{0,400}?\bcover\b/.test( TSL_SUDS ) );
	need( 'the TSL twin fades sub-pixel lace toward flat',
		TSL_SUDS.includes( 'sudsCrisp' ) || TSL_SUDS.includes( 'crisp' ) );

	// A layout whose input count disagrees with the Fn's own parameter list
	// compiles to a function called with the wrong arity, and nothing catches
	// it until a shader compile on a real backend -- which is exactly the
	// failure a no-GPU check cannot see. Count both sides from the source.
	need( 'every TSL layout matches its function signature', ( () => {
		const params = new Map();
		for ( const m of TSL_SUDS.matchAll(
			/export const (\w+) = \/\*@__PURE__\*\/ Fn\(\s*\(?\s*\[([^\]]*)\]/g ) ) {
			params.set( m[ 1 ], m[ 2 ].split( ',' ).map( ( x ) => x.trim() ).filter( Boolean ).length );
		}
		if ( params.size < 10 ) return false;          // the scrape itself broke
		const bad = [];
		for ( const m of TSL_SUDS.matchAll(
			/(\w+)\.setLayout\(\s*\{[\s\S]*?inputs:\s*\[([\s\S]*?)\]\s*\}\s*\)/g ) ) {
			const declared = ( m[ 2 ].match( /(?:\bF\(|name:)/g ) || [] ).length;
			if ( params.get( m[ 1 ] ) !== declared ) bad.push( `${ m[ 1 ] } ${ params.get( m[ 1 ] ) }!=${ declared }` );
		}
		return bad.length === 0;
	} )() );

	need( 'every pure helper carries a layout (WebKit private-space budget)',
		( () => {
			const declared = new Set(
				[ ...TSL_SUDS.matchAll( /(\w+)\.setLayout\(/g ) ].map( ( m ) => m[ 1 ] ) );
			const defined = [ ...TSL_SUDS.matchAll( /export const (\w+) = \/\*@__PURE__\*\/ Fn\(/g ) ]
				.map( ( m ) => m[ 1 ] );
			return defined.length > 0 && defined.every( ( n ) => declared.has( n ) );
		} )() );
}

// ----------------------------------------------------------------- wiring --
//
// A film nothing calls is a file, not a change. These assert the path from
// the parameter to the pixel actually exists.
{
	need( 'the water shader imports the film rather than restating it',
		/import \{[^}]*sudsBreak[^}]*\} from '\.\/wake-suds\.js'/.test( TSL_WATER ) );
	need( 'the water shader crossfades the painted churn to breaking coverage',
		TSL_WATER.includes( 'mix( churn, broke, uSudsBreak )' ) );
	need( 'breaking reads the leftover slope, which IS ak',
		/sudsBreak\( steep, float\( 1\.0 \), phase, uSudsSteep \)/.test( TSL_WATER ) );
	need( 'height stands in for the phase the leftover tile does not carry',
		TSL_WATER.includes( 'hRaw.div( uSudsCrest )' ) );
	need( 'the driver writes the uniforms every frame',
		TSL_DRIVER.includes( 'setWakeSudsUniforms( p )' )
			&& /import \{ setWakeSudsUniforms \} from '\.\/wake-suds\.js'/.test( TSL_DRIVER ) );
	need( 'this module owns its uniforms and nobody else declares them',
		( () => {
			for ( const u of [ 'uSudsBreak', 'uSudsSteep', 'uSudsCrest' ] ) {
				if ( ! new RegExp( `export const ${ u } = ` ).test( TSL_SUDS ) ) return false;
				if ( new RegExp( `const ${ u } = .*uniform\\(` ).test( TSL_WATER ) ) return false;
			}
			return true;
		} )() );
	need( 'the parameters exist and default to leaving the old film alone',
		defaults.wakeSudsBreak === 0
			&& defaults.wakeSudsSteep === SUDS_BREAK_STEEP
			&& Number.isFinite( defaults.wakeSudsCrest ),
		`break ${ defaults.wakeSudsBreak }, steep ${ defaults.wakeSudsSteep }` );
	need( 'the setter clamps the crossfade and falls back to the authored numbers',
		( () => {
			setWakeSudsUniforms( { wakeSudsBreak: 5 } );
			if ( uSudsBreak.value !== 1 || uSudsSteep.value !== SUDS_BREAK_STEEP ) return false;
			setWakeSudsUniforms( {} );
			return uSudsBreak.value === 0 && uSudsSteep.value === SUDS_BREAK_STEEP;
		} )() );
}

for ( const r of results ) {

	console.log( `${ r.ok ? 'ok  ' : 'FAIL' } ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n${ results.length - failed.length } ok${ failed.length ? `, ${ failed.length } failed` : '' }\n` );
if ( failed.length ) process.exit( 1 );
