// The sea dragon: a swimming body, and what it looks like from above the water.
//
// The model is demo/dragonModel.js - a rigged GLB quantised by tools/glb.mjs,
// head rotated onto -Z like every other craft here. It arrived RIGGED BUT NOT
// ANIMATED: 60 bones, no animation channels at all. So there is nothing to play
// back, and the swim is authored here instead - which for an anguilliform body
// is the better trade anyway. A travelling sine wave down the length is what a
// sea snake, an eel or a leviathan actually does, it costs two trig calls in the
// vertex stage against 60 bone matrices and a skinning pass, and it needs no
// second set of skin weights (this asset has JOINTS_0 AND JOINTS_1 - eight
// influences a vertex, which three's skinning does not carry).
//
// ---------------------------------------------------------------------------
// SEEING IT THROUGH THE WATER.
//
// This pass does NOT draw to the screen. It draws into the submerged target
// (./underwater-driver.js), which the sea then samples while shading itself,
// so what leaves here is the radiance heading UP out of the water and an alpha
// saying how much of it is animal rather than water column.
//
// The first cut drew straight over the sea with the depth test off, and the
// report on it was exact: "it feels like the monster is just a transparent
// ghost on the water, it doesn't feel like it is IN the water". It was not -
// it was over the foam, over the hull's wake, at a flat alpha, with none of the
// things that happen to a submerged shape happening to it. Everything that
// makes it read as submerged now happens in the sea's own shader; this file's
// job is only to say what colour the animal is and how much of it survives the
// climb to the surface.
//
// Two things still live here because they belong to the animal, not the sea:
// Beer-Lambert on the way DOWN (red goes first, so it turns blue as it sounds)
// and the discard above the waterline, which keeps a breaching fragment from
// being composited into water it is no longer under.

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec2, vec3, vec4, uniform, texture, mix, smoothstep, attribute,
	uv, positionLocal, normalLocal, positionWorld, normalWorld, cameraPosition,
	sin, cos, atan, exp, normalize, Discard,
} from 'three/tsl';

import {
	uSunIrradiance, uAtmoExposure, R_PLANET,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';
import { uSunDir } from './sky-lut.js';
import { skyLutTexture } from './sky-background.js';

const PI_C = 3.14159265;
const TAU_C = 6.28318531;

// ---- the swim ---------------------------------------------------------------

export const uCreatureLen = /*@__PURE__*/ uniform( 20.0 );    // nose to tail, metres
export const uCreaturePhase = /*@__PURE__*/ uniform( 0.0 );   // radians, advanced by the app
export const uCreatureWaves = /*@__PURE__*/ uniform( 1.35 );  // body waves along that length
export const uCreatureAmp = /*@__PURE__*/ uniform( 0.055 );   // peak sweep, as a fraction of length

// The jaw. The mesh was modelled with the mouth OPEN and there is no rig to
// close it, so the mandible is swung shut about its hinge in the vertex stage -
// weight baked by tools/glb.mjs --jaw, hinge in metres on the body's y-z plane.
// Angle 0 leaves the mouth exactly as modelled; positive shuts it.
export const uJawHinge = /*@__PURE__*/ uniform( /*@__PURE__*/ vec2( 0.0, 0.0 ) );
export const uJawAngle = /*@__PURE__*/ uniform( 0.0 );

/**
 * A travelling wave down the body, in the VERTEX stage.
 *
 * At station s (0 at the nose, 1 at the tail tip) the body is pushed sideways
 * by sin( s*waves*2pi - phase ), with the amplitude ramped in from the head. The
 * ramp is the whole difference between a swimming animal and a wobbling tube:
 * a real swimmer's head is nearly steady and the sweep grows toward the tail, so
 * the wave looks like it is PUSHING the animal forward rather than shaking it.
 *
 * The normal is rotated by the same wave's slope. Without that the lighting
 * stays nailed to the straight body while the surface moves under it, which
 * reads as a sticker sliding over the mesh - the same failure the propeller had
 * (see craftVertex in ./craft.js) and the same fix.
 */
export const creatureVertex = /*@__PURE__*/ Fn( () => {

	const p = positionLocal.toVar();
	const half = uCreatureLen.mul( 0.5 ).max( 1e-3 ).toVar();
	// Nose sits at -Z, so this runs 0 at the nose and 1 at the tail.
	const s = p.z.add( half ).div( half.mul( 2.0 ) ).clamp( 0.0, 1.0 ).toVar();

	const k = uCreatureWaves.mul( TAU_C ).toVar();
	const ph = s.mul( k ).sub( uCreaturePhase ).toVar();
	// Ramp: the head holds still, the tail does the work.
	const ramp = smoothstep( 0.06, 0.85, s ).toVar();
	const amp = uCreatureAmp.mul( uCreatureLen ).mul( ramp ).toVar();

	p.x.addAssign( sin( ph ).mul( amp ) );

	// The jaw swings BEFORE the body wave's normal work below and after the
	// lateral push, in the body's own frame: it is a hinge on the skull, so it
	// rides the wave rather than fighting it.
	const jw = attribute( 'jaw', 'float' ).toVar();
	If( jw.mul( uJawAngle ).abs().greaterThan( 1e-5 ), () => {

		const ja = uJawAngle.mul( jw ).toVar();
		const cj = cos( ja ).toVar(), sj = sin( ja ).toVar();
		const dy = p.y.sub( uJawHinge.x ).toVar();
		const dz = p.z.sub( uJawHinge.y ).toVar();
		p.y.assign( uJawHinge.x.add( dy.mul( cj ).sub( dz.mul( sj ) ) ) );
		p.z.assign( uJawHinge.y.add( dy.mul( sj ).add( dz.mul( cj ) ) ) );
		const ny = normalLocal.y.toVar(), nz2 = normalLocal.z.toVar();
		normalLocal.assign( vec3(
			normalLocal.x,
			ny.mul( cj ).sub( nz2.mul( sj ) ),
			ny.mul( sj ).add( nz2.mul( cj ) ),
		) );

	} );

	// d(offset)/dz, with the ramp's own slope folded in, so the normal turns
	// with the surface it belongs to.
	const dRamp = smoothstep( 0.06, 0.85, s.add( 0.02 ) ).sub( ramp ).div( 0.02 ).toVar();
	const slope = cos( ph ).mul( amp ).mul( k ).div( uCreatureLen )
		.add( sin( ph ).mul( uCreatureAmp ).mul( dRamp ) ).toVar();
	const ang = atan( slope ).toVar();
	const ca = cos( ang ).toVar(), sa = sin( ang ).toVar();
	const nx = normalLocal.x.toVar(), nz = normalLocal.z.toVar();
	normalLocal.assign( vec3(
		nx.mul( ca ).add( nz.mul( sa ) ),
		normalLocal.y,
		nz.mul( ca ).sub( nx.mul( sa ) ),
	) );

	return p;

} );

// ---- what it looks like from up here ----------------------------------------

export const uCreatureSeaY = /*@__PURE__*/ uniform( 0.0 );      // mean surface height, m
export const uCreatureFade = /*@__PURE__*/ uniform( 9.0 );      // depth over which it fades out, m
export const uCreatureTint = /*@__PURE__*/ uniform( /*@__PURE__*/ vec3( 0.030, 0.130, 0.180 ) );
export const uCreatureOpacity = /*@__PURE__*/ uniform( 1.0 );
export const uCreatureHasTex = /*@__PURE__*/ uniform( 0.0 );
export const uCreatureAlbedo = /*@__PURE__*/ uniform( /*@__PURE__*/ vec3( 0.10, 0.13, 0.14 ) );

const creatureBaseColor = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = new THREE.DataTexture( new Uint8Array( [ 30, 40, 44, 255 ] ), 1, 1 );
	t.needsUpdate = true;
	return t;

} )() );

/** Point the material at the decoded atlas (or leave the flat fallback). */
export function setCreatureTexture( tex ) {

	if ( ! tex ) return false;
	creatureBaseColor.value = tex;
	uCreatureHasTex.value = 1;
	return true;

}

/**
 * Underwater shading: a lambertian body under water that eats the light, faded
 * into the sea by depth.
 *
 * The light itself is the same attenuated sun and the same LUT hemisphere the
 * sea and the hull use, so the animal goes red at sunset and out at night with
 * everything else - then both are put through Beer-Lambert on the way DOWN to
 * it, because a body six metres under is lit by what got that far, not by the
 * sky. The alpha is the same law applied to the way back UP, which is why the
 * shape sharpens as it rises and dissolves as it sounds.
 */
export const creatureFragment = /*@__PURE__*/ Fn( () => {

	// Depth below the mean surface. THE MEAN, not the displaced surface: the
	// waves move it by a metre or two either way, this fades over nine, and
	// sampling the real cascades per fragment would cost more than the whole
	// creature does.
	const depth = uCreatureSeaY.sub( positionWorld.y ).toVar();

	// The backstop for having no depth test: anything that surfaces would
	// otherwise be painted over the sky.
	Discard( depth.lessThan( 0.0 ) );

	const N = normalize( normalWorld ).toVar();
	const albedo = mix( uCreatureAlbedo, creatureBaseColor.sample( uv() ).rgb, uCreatureHasTex ).toVar();

	const ro = vec3( 0.0, float( R_PLANET ).add( 1.0 ), 0.0 ).toVar();
	const sunRad = uSunIrradiance
		.mul( sunTransmittance( ro, uSunDir ) )
		.mul( uAtmoExposure )
		.mul( smoothstep( - 0.09, 0.02, uSunDir.y ) ).toVar();
	const skyIrr = skyLutTexture.sample( vec2( 0.5, 0.78 ) ).level( 9.0 ).rgb.mul( PI_C ).toVar();

	// Water swallows red first: the deeper the body, the bluer the light on it.
	// One coefficient per channel, applied over the depth the light descended.
	const kExt = vec3( 0.115, 0.048, 0.032 ).toVar();
	const down = exp( kExt.mul( depth ).negate() ).toVar();

	const NoL = N.dot( uSunDir ).max( 0.0 ).toVar();
	const domeVis = float( 0.55 ).add( N.y.mul( 0.45 ) ).toVar();
	const lit = albedo.mul(
		sunRad.mul( NoL ).mul( 0.55 ).add( skyIrr.mul( domeVis ) ),
	).div( PI_C ).mul( down ).toVar();

	// The way back up: what the sea puts BETWEEN the animal and the eye. The
	// body dissolves into the water's own colour rather than simply going
	// transparent, so at depth it reads as a shape in the water instead of a
	// ghost over it.
	const veil = float( 1.0 ).sub( exp( depth.div( uCreatureFade.max( 0.5 ) ).negate() ) ).toVar();
	const col = mix( lit, uCreatureTint.mul( skyIrr ).div( PI_C ), veil ).toVar();

	// NO AERIAL PERSPECTIVE HERE. What this pass produces is the radiance leaving
	// the animal UPWARD, which ./water-surface.js folds into the sea's own
	// water-leaving radiance - and the sea then hazes the result with everything
	// else. Applying it here as well hazed the creature twice, which at any
	// distance washed it out to nothing.
	//
	// Alpha is COVERAGE: how much of what leaves this patch of sea is animal
	// rather than water column. Still legible right under the surface, gone by a
	// few fade lengths - which is why it sharpens as it rises.
	const alpha = exp( depth.div( uCreatureFade.max( 0.5 ) ).mul( - 0.85 ) )
		.mul( uCreatureOpacity ).clamp( 0.0, 1.0 ).toVar();

	return vec4( col, alpha );

} );
