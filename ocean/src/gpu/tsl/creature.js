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
// The sea is opaque and writes depth (water-driver.js), so anything under it is
// simply gone. Reading the sea's own colour buffer to refract it would mean a
// scene-colour copy, a refraction term in the ocean shader and a redo of the
// golden images that pin it - a lot of machinery for one creature. So the
// dragon is drawn AFTER the sea with the depth test off and blended in, and the
// blend does the work the water would have done: it fades with how deep it is
// and tints toward the water's own colour on the way, which is what a large
// animal a few metres down actually looks like from a boat.
//
// Two consequences, both deliberate:
//
//   - IT IS DRAWN FRONT-FACE ONLY, and that is what makes no depth test
//     survivable. On a closed body the far side's triangles face away and are
//     culled, so the near surface is the only thing drawn and there is nothing
//     to sort. Fins and the open jaw are not closed, and those do ghost
//     slightly over the body - at the alpha this runs at, that reads as murk.
//   - IT MUST NOT BREACH. A fragment above the surface would be drawn over the
//     sky with no depth to stop it, so anything that rises past the waterline is
//     discarded. The behaviour in demo/seadragon.js keeps it under; the discard
//     is the backstop.

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec2, vec3, vec4, uniform, texture, mix, smoothstep,
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

	// ...and the haze, the way the hull and the sea take it.
	const eyeDist = cameraPosition.sub( positionWorld ).length().toVar();
	const { inscatter, transmit } = aerialPerspective(
		vec3( 0.0, cameraPosition.y.max( 1.0 ).add( R_PLANET ), 0.0 ),
		normalize( positionWorld.sub( cameraPosition ) ),
		eyeDist.min( 60000.0 ),
		uSunDir,
	);

	// Alpha: still legible right under the surface, gone by a few fade lengths.
	const alpha = exp( depth.div( uCreatureFade.max( 0.5 ) ).mul( - 0.85 ) )
		.mul( uCreatureOpacity ).clamp( 0.0, 1.0 ).toVar();

	// NOT premultiplied: three's NormalBlending multiplies by alpha itself, and
	// doing it here as well fades the haze twice.
	return vec4( col.mul( transmit ).add( inscatter ), alpha );

} );
