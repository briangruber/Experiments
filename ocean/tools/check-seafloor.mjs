#!/usr/bin/env node
// Virtual seafloor seen through the surface. No GPU.
//
//   node tools/check-seafloor.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	surfaceFloorT, floorReef, floorAlbedo, floorShadow,
	refract3, floorRefractHit, floorSunHit, floorFocus, floorSunGain, floorSunEntry,
	floorLace, floorLaceFade, floorLookSlide,
	floorSurfaceFilm, floorLeaving,
	floorDepthBounds, floorTerrainH, floorDepthAt, floorRayHit,
	FLOOR_CAUSTIC_MIN_PATCH, FLOOR_LACE_NEAR, FLOOR_LACE_FAR,
	FLOOR_LACE_DEPTH_K, FLOOR_LACE_MUL,
} from '../src/seafloor.js';
import { cellular3 } from '../src/foam-lace.js';
import { beerTrans } from '../src/underwater.js';
import { defaults, PRESETS, applyPreset } from '../src/presets.js';
import { WATER_FS } from '../src/shaders/water.js';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const TSL_WATER = readFileSync( join( ROOT, 'src/gpu/tsl/water-surface.js' ), 'utf8' );
const SCHEMA = readFileSync( join( ROOT, 'demo/schema.js' ), 'utf8' );
const TSL_COMMON = readFileSync( join( ROOT, 'src/gpu/tsl/water-common.js' ), 'utf8' );
const CLASSIC_SET = readFileSync( join( ROOT, 'src/water.js' ), 'utf8' );

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

need( 'a missing bed is no hit', ! Number.isFinite( surfaceFloorT( - 1, 0 ) ) );
need( 'looking straight down at 5.2 m hits in 5.2 m',
	Math.abs( surfaceFloorT( - 1, 5.2 ) - 5.2 ) < 1e-9,
	`${ surfaceFloorT( - 1, 5.2 ) }` );
need( 'a 45° look is a longer column',
	surfaceFloorT( - Math.SQRT1_2, 5.2 ) > 7,
	`${ surfaceFloorT( - Math.SQRT1_2, 5.2 ).toFixed( 2 ) }` );
need( 'a glancing look misses the bed',
	! Number.isFinite( surfaceFloorT( - 0.01, 5.2 ) ) );
need( 'looking up misses the bed',
	! Number.isFinite( surfaceFloorT( 0.5, 5.2 ) ) );

const sand = floorReef( 2.0, 3.0 );
const rock = floorReef( 40.0, 90.0 );
need( 'reef stays in 0..1', sand >= 0 && sand <= 1 && rock >= 0 && rock <= 1,
	`sand ${ sand.toFixed( 3 ) } rock ${ rock.toFixed( 3 ) }` );
{
	let near = 0, far = 0;
	for ( let i = 0; i < 24; i ++ ) {

		const x = i * 3.1, z = i * 1.7;
		near += Math.abs( floorReef( x, z ) - floorReef( x + 0.4, z + 0.25 ) );
		far += Math.abs( floorReef( x, z ) - floorReef( x + 55, z - 40 ) );

	}
	need( 'reef is metre-scale patches, not a texel hash',
		near / 24 < 0.05 && far / 24 > 0.06,
		`near ${( near / 24 ).toFixed( 3 )} far ${( far / 24 ).toFixed( 3 ) }` );
}

const a0 = floorAlbedo( 2, 3, 0.85, 1, 0.35 );
need( 'sand stays a warm cream, not navy',
	a0[ 0 ] > a0[ 2 ] && a0[ 1 ] > 0.15,
	`${ a0.map( ( v ) => v.toFixed( 3 ) ) }` );

{
	let sum = 0, peak = 0, flips = 0, occ = 0;
	let prev = floorLace( 0, 0, 0.4 );
	for ( let i = 0; i < 80; i ++ ) {

		const x = i * 0.35, z = i * 0.22;
		const v = floorLace( x, z, 0.4 );
		sum += v;
		peak = Math.max( peak, v );
		if ( ( v > 0.25 ) !== ( prev > 0.25 ) ) flips ++;
		prev = v;
		const c = cellular3( x * 2.85, z * 2.85 );
		occ += Math.max( 0, 1 - c.F1 );

	}
	need( 'the foci are sparse, not a filled sheet of outlines',
		sum / 80 < 0.35 && peak > 0.25,
		`mean ${( sum / 80 ).toFixed( 3 )} peak ${ peak.toFixed( 3 ) }` );
	need( 'the foci turn over on a few tens of centimetres, not a 20 m swell',
		flips >= 6, `flips ${ flips }` );
	need( 'the foci are not occupied (1−F1) discs',
		occ / 80 > ( sum / 80 ) * 1.5,
		`occ ${( occ / 80 ).toFixed( 3 )} lace ${( sum / 80 ).toFixed( 3 ) }` );
}

{
	let d = 0;
	for ( let i = 0; i < 40; i ++ ) {

		const x = i * 0.8, z = i * 0.3;
		d += Math.abs( floorLace( x, z, 0.2 ) - floorLace( x, z, 1.6 ) );

	}
	need( 'the foci dance over time, they do not slide as a stamp',
		d > 0.08, `Δ ${ d.toFixed( 3 ) }` );
}

{
	let near = 0, far = 0, grid = 0;
	for ( let i = 0; i < 24; i ++ ) {

		const x = i * 2.1, z = i * 1.4;
		const v = floorLace( x, z, 0.5 );
		near += Math.abs( v - floorLace( x + 0.03, z + 0.02, 0.5 ) );
		far += Math.abs( v - floorLace( x + 2.4, z - 1.8, 0.5 ) );
		const lattice = Math.abs( Math.sin( x * 2.2 ) ) * Math.abs( Math.sin( z * 2.2 ) );
		grid += Math.abs( v - lattice );

	}
	need( 'cells are tens of centimetres, not a texel hash and not 4 m polygons',
		near / 24 < 0.40 && far / 24 > 0.04,
		`near ${( near / 24 ).toFixed( 3 )} far ${( far / 24 ).toFixed( 3 ) }` );
	{
		const a = floorLace( 2.0, 1.4, 0.5, 1 );
		const b = floorLace( 2.35, 1.62, 0.5, 1 );
		const c = floorLace( 2.0, 1.4, 0.5, 2.2 );
		const d = floorLace( 2.35, 1.62, 0.5, 2.2 );
		need( 'a bigger caustic size stretches the same web',
			Math.abs( a - b ) > Math.abs( c - d ) * 1.15
				&& WATER_FS.includes( 'uFloorCausticSize' )
				&& TSL_WATER.includes( 'uFloorCausticSize' )
				&& TSL_WATER.includes( 'uFloorCausticSize.value = p.floorCausticSize' ),
			`Δ1 ${ Math.abs( a - b ).toFixed( 3 )} Δ2 ${ Math.abs( c - d ).toFixed( 3 ) }` );
	}
	need( 'the foci are not an intersecting-sine lattice',
		grid / 24 > 0.08,
		`Δ lattice ${( grid / 24 ).toFixed( 3 ) }` );
}

{
	need( 'nearby the sunlight web is full',
		floorLaceFade( 8 ) > 0.99 && floorLaceFade( FLOOR_LACE_NEAR ) > 0.99,
		`${ floorLaceFade( 8 ).toFixed( 3 ) }` );
	need( 'the web is gone past the alias band',
		floorLaceFade( FLOOR_LACE_FAR ) < 0.01 && floorLaceFade( 200 ) < 0.01,
		`${ floorLaceFade( 200 ).toFixed( 3 ) }` );
	const mid = ( FLOOR_LACE_NEAR + FLOOR_LACE_FAR ) * 0.5;
	need( 'the fade is a ramp, not a hard clip',
		floorLaceFade( mid ) > 0.2 && floorLaceFade( mid ) < 0.8,
		`mid ${ floorLaceFade( mid ).toFixed( 3 )} @ ${ mid }` );
	need( 'the fade does not kill the ski neighbourhood',
		FLOOR_LACE_NEAR >= 12 && FLOOR_LACE_NEAR < 28
			&& FLOOR_LACE_FAR > FLOOR_LACE_NEAR + 28
			&& FLOOR_LACE_FAR < 80,
		`${ FLOOR_LACE_NEAR }..${ FLOOR_LACE_FAR }` );
}

{
	need( 'look-down still skips the short chop cascade',
		FLOOR_CAUSTIC_MIN_PATCH >= 30 && FLOOR_CAUSTIC_MIN_PATCH < 80
			&& WATER_FS.includes( 'if (uPatch[c] < 40.0) continue' )
			&& TSL_COMMON.includes( 'FLOOR_CAUSTIC_MIN_PATCH' ),
		`${ FLOOR_CAUSTIC_MIN_PATCH }` );
	need( 'both water shaders focus sunlight on the bed at the sun-entry',
		WATER_FS.includes( 'float floorLace' )
			&& WATER_FS.includes( 'floorLace(pSun.x / laceScale, pSun.y / laceScale, uTime)' )
			&& WATER_FS.includes( 'c.y - c.x' )
			&& TSL_WATER.includes( 'floorLaceCore' )
			&& TSL_WATER.includes( 'c.y.sub( c.x )' )
			&& TSL_WATER.includes( 'floorLaceCore( pSun.x.div( laceScale ), pSun.y.div( laceScale ), uTime )' ) );
	need( 'three small moving sheets, not one 1 m wireframe and not a dotted octave',
		WATER_FS.includes( '2.85, 0.11, -0.07, 0.0' )
			&& WATER_FS.includes( '1.95, -0.08, 0.10, 2.1' )
			&& WATER_FS.includes( '3.55, 0.04, 0.09, 4.4' )
			&& TSL_WATER.includes( '2.85, 0.11, - 0.07, 0.0' )
			&& TSL_WATER.includes( '1.95, - 0.08, 0.10, 2.1' )
			&& ! WATER_FS.includes( '1.73 + 8.1' )
			&& ! TSL_WATER.includes( '1.73 ).add( 8.1 )' ) );
	need( 'the ridges break instead of closing into polygons',
		WATER_FS.includes( 'smoothstep(0.18, 0.58, c.z)' )
			&& TSL_WATER.includes( 'smoothstep( float( 0.18 ), float( 0.58 ), c.z )' ) );
	need( 'the bed uses the same look-through warp as the rocks',
		WATER_FS.includes( 'uRefractDistort * lookGate * localD' )
			&& WATER_FS.includes( 'hx += slope.x * lookW' )
			&& TSL_WATER.includes( 'uRefractDistort.mul( lookGate ).mul( localD )' )
			&& TSL_WATER.includes( 'slope.x.mul( lookW )' )
			&& TSL_WATER.includes( 'uRefractDistort.value = p.sdRefract' )
			&& CLASSIC_SET.includes( 'uRefractDistort: p.sdRefract' )
			&& ! WATER_FS.includes( 'cascadeCausticAt' )
			&& ! TSL_WATER.includes( 'sampleCascadeCaustic' )
			&& ! TSL_COMMON.includes( 'sampleCascadeCaustic' ) );
	{
		const near = floorLookSlide( 0.45, 0.20, 0.43, 5.2, 12 );
		const far = floorLookSlide( 0.45, 0.20, 0.43, 5.2, 90 );
		const off = floorLookSlide( 0.45, 0.20, 0, 5.2, 12 );
		need( 'a sloped facet slides the bed; a flat or zero knob does not',
			Math.hypot( ...near ) > 0.35 && Math.hypot( ...off ) < 1e-6
				&& Math.hypot( ...floorLookSlide( 0, 0, 0.43, 5.2, 12 ) ) < 1e-6,
			`near ${ Math.hypot( ...near ).toFixed( 2 ) }` );
		need( 'the look-through warp dies with distance, like the rocks',
			Math.hypot( ...far ) < Math.hypot( ...near ) * 0.45,
			`near ${ Math.hypot( ...near ).toFixed( 2 )} far ${ Math.hypot( ...far ).toFixed( 2 ) }` );
	}
	need( 'the live bed is not the dive caustic and not occupancy discs',
		! WATER_FS.includes( 'uwCaustic' )
			&& ! TSL_WATER.includes( 'uwCaustic' )
			&& ! WATER_FS.includes( '1.0 - c0.x' )
			&& ! TSL_WATER.includes( 'float( 1.0 ).sub( c0.x )' ) );
	need( 'sunlight multiplies the sand, it is not added white',
		WATER_FS.includes( '1.0 + lace * 0.45' )
			&& TSL_WATER.includes( 'lace.mul( FLOOR_LACE_MUL ).add( 1.0 )' )
			&& ! WATER_FS.includes( 'vec3(1.25, 1.18, 1.02)' )
			&& ! TSL_WATER.includes( 'vec3( 1.25, 1.18, 1.02 )' )
			&& FLOOR_LACE_MUL > 0.3 && FLOOR_LACE_MUL < 0.6 );
	need( 'the column fades the foci with depth',
		WATER_FS.includes( 'exp(-localD * 0.15)' )
			&& TSL_WATER.includes( 'FLOOR_LACE_DEPTH_K' )
			&& FLOOR_LACE_DEPTH_K > 0.1 && FLOOR_LACE_DEPTH_K < 0.25 );
	need( 'both shaders fade the web with view distance',
		WATER_FS.includes( `smoothstep(${ FLOOR_LACE_FAR.toFixed( 1 ) }, ${ FLOOR_LACE_NEAR.toFixed( 1 ) }, dist)` )
			&& TSL_WATER.includes( 'FLOOR_LACE_FAR' )
			&& TSL_WATER.includes( 'FLOOR_LACE_NEAR' )
			&& TSL_WATER.includes( 'smoothstep( float( FLOOR_LACE_FAR ), float( FLOOR_LACE_NEAR ), dist )' ) );
	need( 'look-down refraction uses the mipped slope, not lighting N',
		WATER_FS.includes( 'vec3 Nfloor = normalize(vec3(-sMip.x, 1.0, -sMip.y))' )
			&& WATER_FS.includes( 'dot(Nfloor, I)' )
			&& TSL_WATER.includes( 'const Nfloor = vec3( sMip.x.negate()' )
			&& TSL_WATER.includes( 'Nfloor.dot( I )' ) );
	need( 'the sky film reads the mipped slope, not LOD-0 capillaries',
		WATER_FS.includes( 'length(sMip) * 3.5' )
			&& TSL_WATER.includes( 'sMip.length().mul( 3.5 )' )
			&& ! WATER_FS.includes( 'length(slope) * 3.5' )
			&& ! TSL_WATER.includes( 'slope.length().mul( 3.5 )' ) );
	need( 'neither water shader hashes world XZ for sand / reef',
		! /fract\(\s*sin\(\s*hx\s*\*\s*0\.021/.test( WATER_FS )
			&& ! TSL_WATER.includes( 'hx.mul( 0.021 ).add( hz.mul( 0.017 ) ).sin().mul( 43758' ) );
	need( 'the heightfield has no texel hash',
		! WATER_FS.includes( 'fract(sin(u * 12.9898 + v * 78.233)' )
			&& ! TSL_WATER.includes( 'u.mul( 12.9898 ).add( v.mul( 78.233 ) ).sin().mul( 43758' ) );
	need( 'film grain is off by default',
		defaults.grain === 0, `${ defaults.grain }` );
	need( 'no preset turns film grain back on',
		Object.values( PRESETS ).every( ( p ) => ( p.grain ?? 0 ) === 0 ),
		Object.entries( PRESETS ).filter( ( [ , p ] ) => ( p.grain ?? 0 ) > 0 )
			.map( ( [ n, p ] ) => `${ n }:${ p.grain }` ).join( ' ' ) );
}

const sh = floorShadow( 0, 0, { x: 0, z: 0, push: 1, radius: 2 }, 5.2, [ 0, 1, 0 ] );
need( 'noon sun puts the hull shadow under the craft',
	sh > 0.5, `shadow ${ sh.toFixed( 3 ) }` );
const far = floorShadow( 40, 40, { x: 0, z: 0, push: 1, radius: 2 }, 5.2, [ 0, 1, 0 ] );
need( 'the shadow dies away from the hull',
	far < 0.05, `far ${ far.toFixed( 3 ) }` );
need( 'no hull means no shadow',
	floorShadow( 0, 0, { push: 0 }, 5.2, [ 0, 1, 0 ] ) === 0 );

const lagoon = PRESETS[ 'Tropical Lagoon' ];
const abs = lagoon.absorption;
const t5 = beerTrans( abs, 5.2, 1 );
const t20 = beerTrans( abs, 20, 1 );
need( 'five metres of lagoon water still shows the bed',
	t5[ 1 ] > 0.7 && t5[ 0 ] > 0.35,
	`t5 ${ t5.map( ( v ) => v.toFixed( 3 ) ) }` );
need( 'a long look-down still goes teal (red dies first)',
	t20[ 2 ] > t20[ 0 ],
	`t20 ${ t20.map( ( v ) => v.toFixed( 3 ) ) }` );
need( 'Tropical Lagoon scatter is sky-cyan, not a lime dye',
	lagoon.scatterColor[ 2 ] > lagoon.scatterColor[ 1 ]
		&& lagoon.scatterColor[ 1 ] > lagoon.scatterColor[ 0 ]
		&& lagoon.scatterColor[ 1 ] < 0.40,
	`${ lagoon.scatterColor }` );
need( 'Tropical Lagoon glitter and capillaries stay below the speckle band',
	lagoon.glitter < 0.4 && lagoon.capillary < 0.85,
	`g ${ lagoon.glitter } cap ${ lagoon.capillary }` );
need( 'Tropical Lagoon has wind-patch mottling — not the same chop everywhere',
	lagoon.gust >= 0.35 && lagoon.gust <= 0.6 && lagoon.gustScale >= 28 && lagoon.gustScale <= 60,
	`gust ${ lagoon.gust } scale ${ lagoon.gustScale }` );
need( 'Tropical Lagoon caustics read through a shallow column',
	lagoon.floorCaustic >= 1 && lagoon.floorCaustic < 2,
	`${ lagoon.floorCaustic }` );

need( 'open-ocean defaults have no bed',
	( defaults.floorDepth ?? 0 ) === 0, `${ defaults.floorDepth }` );
need( 'Tropical Lagoon is a shallow bed',
	PRESETS[ 'Tropical Lagoon' ]?.floorDepth > 4
	&& PRESETS[ 'Tropical Lagoon' ]?.floorDepth < 10,
	`${ PRESETS[ 'Tropical Lagoon' ]?.floorDepth }` );
need( 'applying Tropical Lagoon writes the bed',
	applyPreset( {}, 'Tropical Lagoon' ).floorDepth === 5.2 );

{
	const lake = PRESETS[ 'Calm Lake' ];
	need( 'Calm Lake is a named scene', !! lake );
	need( 'Calm Lake is light air over a short fetch — ripple, not swell',
		lake.windSpeed < 3 && lake.fetch <= 8 && lake.swellAmount < 0.08,
		`U10 ${ lake.windSpeed } fetch ${ lake.fetch } swell ${ lake.swellAmount }` );
	need( 'Calm Lake writes no wind foam',
		lake.foamAmount === 0 );
	need( 'Calm Lake scatter is freshwater olive, not ocean cyan',
		lake.scatterColor[ 1 ] > lake.scatterColor[ 2 ],
		`scatter ${ lake.scatterColor }` );
	need( 'Calm Lake has a mud/sand shelf',
		lake.floorDepth > 6 && lake.floorDepth < 14,
		`${ lake.floorDepth }` );
	need( 'applying Calm Lake writes the lake',
		applyPreset( {}, 'Calm Lake' ).floorDepth === 9
			&& applyPreset( {}, 'Calm Lake' ).swellAmount === 0.02 );
}
need( 'the seafloor sliders reach 100 m',
	SCHEMA.includes( "S('floorDepthMin', 'Seafloor min depth (m)', 0, 100, 0.1)" )
		&& SCHEMA.includes( "S('floorDepthMax', 'Seafloor max depth (m)', 0, 100, 0.1)" )
		&& SCHEMA.includes( "S('floorDepth', 'Seafloor depth (m)', 0, 100, 0.1)" ) );
need( 'Tropical Noon is a 5–100 m bed with stronger caustics',
	PRESETS[ 'Tropical Noon' ]?.floorDepthMin === 5
		&& PRESETS[ 'Tropical Noon' ]?.floorDepthMax === 100
		&& PRESETS[ 'Tropical Noon' ]?.floorCaustic > 1.8,
	`min ${ PRESETS[ 'Tropical Noon' ]?.floorDepthMin } max ${ PRESETS[ 'Tropical Noon' ]?.floorDepthMax } caustic ${ PRESETS[ 'Tropical Noon' ]?.floorCaustic }` );
need( 'applying Tropical Noon writes that deep bed',
	applyPreset( { floorDepth: 5.2 }, 'Tropical Noon' ).floorDepthMin === 5
		&& applyPreset( { floorDepth: 5.2 }, 'Tropical Noon' ).floorDepthMax === 100 );

{
	need( 'a lone floorDepth is a flat shelf',
		floorDepthBounds( 0, 0, 5.2 ).min === 5.2
			&& floorDepthBounds( 0, 0, 5.2 ).max === 5.2
			&& floorDepthBounds( 0, 0, 5.2 ).live,
		`${ JSON.stringify( floorDepthBounds( 0, 0, 5.2 ) ) }` );
	need( 'no depth is no bed', ! floorDepthBounds( 0, 0, 0 ).live );
	need( 'min/max swap into a range',
		floorDepthBounds( 8, 3, 0 ).min === 3 && floorDepthBounds( 8, 3, 0 ).max === 8 );
	need( 'a flat range is the same depth everywhere',
		Math.abs( floorDepthAt( 0, 0, 5.2, 5.2 ) - 5.2 ) < 1e-9
			&& Math.abs( floorDepthAt( 40, - 18, 5.2, 5.2 ) - 5.2 ) < 1e-9 );
	let lo = Infinity, hi = - Infinity, inside = true;
	for ( let i = 0; i < 80; i ++ ) {

		const d = floorDepthAt( i * 7.3, i * - 4.1, 2.6, 8.4, 42 );
		lo = Math.min( lo, d );
		hi = Math.max( hi, d );
		if ( d < 2.6 - 1e-6 || d > 8.4 + 1e-6 ) inside = false;

	}
	need( 'terrain stays inside min/max',
		inside, `${ lo.toFixed( 3 ) }..${ hi.toFixed( 3 ) }` );
	need( 'a live range is not a flat shelf',
		hi - lo > 2.4,
		`span ${ ( hi - lo ).toFixed( 2 ) } (${ lo.toFixed( 2 ) }..${ hi.toFixed( 2 ) })` );
	need( 'the heightfield is 0..1 and not a constant',
		floorTerrainH( 0, 0 ) >= 0 && floorTerrainH( 0, 0 ) <= 1
			&& Math.abs( floorTerrainH( 0, 0 ) - floorTerrainH( 80, - 40 ) ) > 0.05 );
	const hit = floorRayHit( 0, 0, 0, [ 0, - 1, 0 ], 2.6, 8.4, 42 );
	need( 'a nadir ray hits the local bed, not a single shelf',
		hit && Math.abs( hit.depth - floorDepthAt( hit.x, hit.z, 2.6, 8.4, 42 ) ) < 0.05,
		`d ${ hit?.depth?.toFixed( 3 ) }` );
	need( 'Tropical Lagoon has a min/max bed, not one shelf',
		lagoon.floorDepthMin > 0.25 && lagoon.floorDepthMax > lagoon.floorDepthMin + 2,
		`min ${ lagoon.floorDepthMin } max ${ lagoon.floorDepthMax }` );
	need( 'Tropical Lagoon exposes sandbars shallow enough to break',
		lagoon.floorDepthMin < lagoon.shoreFoamRange
			&& lagoon.shoreFoamAmount > 0
			&& lagoon.foamTextureAmount > 0,
		`min ${ lagoon.floorDepthMin } range ${ lagoon.shoreFoamRange } shore ${ lagoon.shoreFoamAmount }` );
	const noon = applyPreset( { floorDepthMin: 2.6, floorDepthMax: 8.4 }, 'Tropical Noon' );
	need( 'Tropical Noon keeps a 5–100 m terrain range',
		noon.floorDepthMin === 5 && noon.floorDepthMax === 100,
		`min ${ noon.floorDepthMin } max ${ noon.floorDepthMax }` );
}

{
	const Idown = [ 0, - 1, 0 ];
	const Nflat = [ 0, 1, 0 ];
	const r0 = refract3( Idown, Nflat, 1 / 1.333 );
	need( 'a nadir ray through a flat facet still points down',
		Math.abs( r0[ 0 ] ) < 1e-6 && r0[ 1 ] < - 0.99,
		`${ r0.map( ( v ) => v.toFixed( 3 ) ) }` );
	const h0 = floorRefractHit( 0, 0, Idown, Nflat, 5.2 );
	need( 'a flat look-down hits under the facet',
		Math.hypot( h0[ 0 ], h0[ 1 ] ) < 1e-5,
		`${ h0.map( ( v ) => v.toFixed( 3 ) ) }` );
	const len = Math.hypot( - 0.35, 1 );
	const Ntilt = [ - 0.35 / len, 1 / len, 0 ];
	const h1 = floorRefractHit( 0, 0, Idown, Ntilt, 5.2 );
	need( 'a tilted facet moves the look-down hit — that is the surface',
		Math.abs( h1[ 0 ] ) > 0.15,
		`dx ${ h1[ 0 ].toFixed( 3 ) }` );
	const sun = [ 0.28, 0.92, 0.27 ];
	const sl = Math.hypot( ...sun );
	const S = [ sun[ 0 ] / sl, sun[ 1 ] / sl, sun[ 2 ] / sl ];
	const s0 = floorSunHit( 0, 0, S, Nflat, 5.2 );
	const s1 = floorSunHit( 0, 0, S, Ntilt, 5.2 );
	need( 'sun caustics move when the surface tilts',
		Math.hypot( s1[ 0 ] - s0[ 0 ], s1[ 1 ] - s0[ 1 ] ) > 0.12,
		`flat ${ s0.map( ( v ) => v.toFixed( 2 ) ) } tilt ${ s1.map( ( v ) => v.toFixed( 2 ) ) }` );
	{
		const noon = [ 0.28, 0.92, 0.27 ];
		const dusk = [ 0.82, 0.18, 0.54 ];
		const flatN = floorSunGain( 0, 0, noon, 5.2 );
		const faceN = floorSunGain( 0.32, 0.08, noon, 5.2 );
		const leeN = floorSunGain( - 0.32, - 0.08, noon, 5.2 );
		const flatD = floorSunGain( 0, 0, dusk, 5.2 );
		need( 'a sun-facing facet punches the web; the lee stays quieter',
			faceN > flatN * 1.12 && faceN > leeN * 1.25,
			`face ${ faceN.toFixed( 2 )} flat ${ flatN.toFixed( 2 )} lee ${ leeN.toFixed( 2 ) }` );
		need( 'a low sun dims the whole web, it is not a flat stamp',
			flatD < flatN * 0.45 && flatD > 0.05,
			`noon ${ flatN.toFixed( 2 )} dusk ${ flatD.toFixed( 2 ) }` );
		need( 'both water shaders take that gain from the sun, not a noise envelope',
			WATER_FS.includes( 'float floorSunGain' )
				&& WATER_FS.includes( 'floorSunGain(slope, uSunDir, localD)' )
				&& TSL_WATER.includes( 'floorSunGainCore' )
				&& TSL_WATER.includes( 'floorSunGainCore( slope.x, slope.y, uSunDir, localD )' )
				&& ! WATER_FS.includes( 'sunH * 0.55 + 0.40' )
				&& ! TSL_WATER.includes( 'sunH.mul( 0.55 ).add( 0.40 )' ) );
	}
	need( 'a converging facet brightens the old 1D focus twin',
		floorFocus( - 0.08, 5.2 ) > 1.15,
		`${ floorFocus( - 0.08, 5.2 ).toFixed( 3 ) }` );
	need( 'a spreading facet dims the old 1D focus twin',
		floorFocus( 0.12, 5.2 ) < 0.95,
		`${ floorFocus( 0.12, 5.2 ).toFixed( 3 ) }` );
	const entry = floorSunEntry( 0, 0, S, 5.2 );
	need( 'the sun-entry sits up-sun of the bed hit, not on it',
		Math.hypot( entry[ 0 ], entry[ 1 ] ) > 0.8,
		`${ entry.map( ( v ) => v.toFixed( 2 ) ) }` );
	const lit = floorAlbedo( 0, 0, 0.85, 1, 0.8 );
	const dim = floorAlbedo( 0, 0, 0.85, 1, 0.05 );
	need( 'a brighter web lights the sand',
		lit[ 0 ] > dim[ 0 ] + 0.04,
		`lit ${ lit[ 0 ].toFixed( 3 )} dim ${ dim[ 0 ].toFixed( 3 ) }` );
}

{
	need( 'looking sideways keeps the usual Fresnel — no extra film',
		floorSurfaceFilm( 0.4, 0.22 ) < 0.01,
		`${ floorSurfaceFilm( 0.4, 0.22 ).toFixed( 3 ) }` );
	need( 'looking down on a ripple puts a sky film on the surface',
		floorSurfaceFilm( 0.22, 0.95 ) > 0.08,
		`${ floorSurfaceFilm( 0.22, 0.95 ).toFixed( 3 ) }` );
	need( 'a flat nadir stays a window, not a mirror',
		floorSurfaceFilm( 0, 1 ) < 0.01,
		`${ floorSurfaceFilm( 0, 1 ).toFixed( 3 ) }` );
	const leave = floorLeaving( [ 0.78, 0.68, 0.48 ], 0.4, 1 );
	need( 'the bed is Lambert (E/π), not an HDR slab that eats the sea',
		leave[ 0 ] > 0.05 && leave[ 0 ] < 0.45,
		`${ leave.map( ( v ) => v.toFixed( 3 ) ) }` );
	const leaveDim = floorLeaving( [ 0.78, 0.68, 0.48 ], 0, 1 );
	const leaveHot = floorLeaving( [ 0.78, 0.68, 0.48 ], 1, 1 );
	need( 'a hotter focus is still sand-coloured, not added white',
		leaveHot[ 0 ] > leaveDim[ 0 ] + 0.04
			&& Math.abs(
				leaveHot[ 0 ] / Math.max( leaveHot[ 2 ], 1e-4 )
				- leaveDim[ 0 ] / Math.max( leaveDim[ 2 ], 1e-4 ),
			) < 0.25,
		`dim ${ leaveDim.map( ( v ) => v.toFixed( 3 ) )} hot ${ leaveHot.map( ( v ) => v.toFixed( 3 ) ) }` );
}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok' : 'FAIL' }  ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
if ( failed.length ) {

	console.error( `\n${ failed.length } failed` );
	process.exit( 1 );

}
console.log( `\n${ results.length } ok` );
