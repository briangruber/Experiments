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
// This material is drawn TWICE a frame, by the same pipeline, with two uniforms
// telling it which half of the world it is in:
//
//   the refraction pass   everything below the waterline, into
//                         ./refraction-driver.js's own colour+depth target,
//                         which ./water-surface.js then looks through the sea
//                         at. RGB is the radiance leaving the body; ALPHA is
//                         coverage. The water column, its extinction and the
//                         haze are the SEA's job from there - so nothing here
//                         may apply them, or they are applied twice.
//   the beauty pass       everything above the waterline, straight into the HDR
//                         frame after the sea, depth-tested against it. This is
//                         how a fin breaks the surface: the sea has written
//                         depth, the fin is nearer, so it draws, and the body it
//                         is attached to is behind the sea and does not.
//
// The waterline split is a uniform, not a clipping plane or a material swap -
// ./water-clip.js has the whole argument, and it is a performance argument.
//
// WHAT THIS REPLACES, so nobody re-derives it. The animal used to be drawn once,
// after the sea, with NO DEPTH TEST, because the sea is opaque and had already
// written a nearer depth over it. That cost two bugs which were the same bug:
// its far teeth drew through its own skull (front-face culling sorts a closed
// convex body, and a head with an open jaw is not one), and it could never
// breach (anything above the waterline had to be discarded or it would paint
// over the sky). With a depth buffer of its own it is an ordinary opaque
// double-sided mesh and both go away. docs/sea-dragon-handoff.md is the history.

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec2, vec3, vec4, uniform, texture, mix, smoothstep, select,
	uv, positionLocal, normalLocal, positionWorld, normalWorld, cameraPosition,
	sin, cos, atan, exp, normalize, frontFacing,
} from 'three/tsl';

import {
	uSunIrradiance, uAtmoExposure, R_PLANET,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';
import { uSunDir } from './sky-lut.js';
import { skyLutTexture } from './sky-background.js';
import { waterClipDiscard } from './water-clip.js';

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
export const uCreatureTint = /*@__PURE__*/ uniform( /*@__PURE__*/ vec3( 0.030, 0.130, 0.180 ) );
export const uCreatureHasTex = /*@__PURE__*/ uniform( 0.0 );
// 1 in the beauty pass, 0 in the refraction pass. The sea hazes its own pixel
// with aerial perspective while it composites the lookup in, so a body that
// arrived already hazed would be hazed twice; above the water there is nothing
// else to do it and it must be applied here. One uniform, so both passes share
// a pipeline (see ./water-clip.js on why that matters).
export const uCreatureAerial = /*@__PURE__*/ uniform( 1.0 );
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
 * A lambertian body that eats the light it is lit by.
 *
 * The light is the same attenuated sun and the same LUT hemisphere the sea and
 * the hull use, so the animal goes red at sunset and out at night with
 * everything else - then both are put through Beer-Lambert on the way DOWN to
 * it, because a body six metres under is lit by what got that far, not by the
 * sky.
 *
 * WHAT IS DELIBERATELY NOT HERE: the way back UP. This used to fade the body
 * toward the water's colour by its own depth below mean sea level, which is the
 * wrong quantity - it is only right looking straight down, and at the angle you
 * ride at a body three metres under is thirty metres of water away. That fade
 * now lives in the sea, over the real column reconstructed from the refraction
 * pass's depth buffer (./water-surface.js). Doing it in both places would apply
 * it twice.
 */
export const creatureFragment = /*@__PURE__*/ Fn( () => {

	// THE WATERLINE, decided by whichever pass is drawing. Below it in the
	// refraction pass, above it in the beauty pass, everything in neither. First
	// statement in the function, so the clipped-away half does not pay for the
	// sky LUT reads below.
	waterClipDiscard();

	// Depth below the mean surface. THE MEAN, not the displaced surface: the
	// waves move it by a metre or two either way, the light falls off over
	// several, and sampling the real cascades per fragment would cost more than
	// the whole creature does. Clamped at 0 so a breached fin is lit by the whole
	// sun rather than by exp() of a negative depth, which is a fin brighter than
	// the sky.
	const depth = uCreatureSeaY.sub( positionWorld.y ).max( 0.0 ).toVar();

	// A DOUBLE-SIDED DRAW needs the back faces' normals turned round, or the
	// inside of the open jaw and the thin fins - the two places this mesh is not
	// a closed surface, and the two the old draw got wrong - are shaded as though
	// they faced away from what is actually in front of them.
	const N = select( frontFacing, normalize( normalWorld ), normalize( normalWorld ).negate() ).toVar();
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

	// A hint of the water's own colour on the body itself - the light that
	// scattered into the last metre or so of the path rather than the whole
	// column, which the sea now owns. Kept small on purpose: turn this up and it
	// starts doing the sea's job again, badly, from a quantity that does not know
	// where the eye is.
	const col = mix( lit, uCreatureTint.mul( skyIrr ).div( PI_C ),
		float( 1.0 ).sub( exp( depth.mul( - 0.08 ) ) ).mul( 0.45 ) ).toVar();

	// The haze, the way the hull and the sea take it - but ONLY in the beauty
	// pass. In the refraction pass the sea hazes the finished pixel, this body
	// included, and applying it here as well would haze it twice.
	If( uCreatureAerial.greaterThan( 0.001 ), () => {

		const eyeDist = cameraPosition.sub( positionWorld ).length().toVar();
		const { inscatter, transmit } = aerialPerspective(
			vec3( 0.0, cameraPosition.y.max( 1.0 ).add( R_PLANET ), 0.0 ),
			normalize( positionWorld.sub( cameraPosition ) ),
			eyeDist.min( 60000.0 ),
			uSunDir,
		);
		col.assign( col.mul( transmit ).add( inscatter ) );

	} );

	// ALPHA IS COVERAGE, nothing else. It is 1 wherever the animal is and 0
	// wherever it is not, and the sea mixes its lookup by exactly that; how
	// STRONGLY the shape reads is uRefractAmount, on the other side. Alpha used
	// to carry the depth fade, and that is why you could see the teeth through
	// the back of the skull: a blended draw with no depth buffer lets every
	// triangle show through every other. It also has to stay 1 because the sea
	// multiplies by this alpha - writing a faded value here and mixing by it
	// there would darken the body by the square of its own visibility.
	return vec4( col, 1.0 );

} );
