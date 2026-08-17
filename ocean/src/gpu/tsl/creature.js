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
// The jaw is the same story: the bind pose is fully dropped, the mandible
// ends at the mouth corner, and sdGape / SeaDragon.gape used to be computed
// and then thrown away. creatureVertex hinges those verts around that
// corner (CPU twin: src/creature-jaw.js) before the body wave runs.
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
	sin, cos, atan, exp, normalize, frontFacing, reflect, clamp,
} from 'three/tsl';

import {
	uSunIrradiance, uAtmoExposure, R_PLANET,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';
import { uSunDir } from './sky-lut.js';
import { skyLutTexture } from './sky-background.js';
import { waterClipDiscard } from './water-clip.js';
import { uwCaustic } from './underwater.js';

const PI_C = 3.14159265;
const TAU_C = 6.28318531;

// ---- the swim ---------------------------------------------------------------

export const uCreatureLen = /*@__PURE__*/ uniform( 20.0 );    // nose to tail, metres
export const uCreaturePhase = /*@__PURE__*/ uniform( 0.0 );   // radians, advanced by the app
export const uCreatureWaves = /*@__PURE__*/ uniform( 1.35 );  // body waves along that length
export const uCreatureAmp = /*@__PURE__*/ uniform( 0.055 );   // peak sweep, as a fraction of length
// 1 applies the wave on that axis. Sideways is the anguilliform default;
// lift is a whale/dolphin heave. Both at once phase-shifts the heave a
// quarter turn so the body corkscrews instead of flopping on a diagonal.
export const uCreatureSide = /*@__PURE__*/ uniform( 1.0 );
export const uCreatureLift = /*@__PURE__*/ uniform( 0.0 );
// Head and anterior spine turn flex, in radians. When turning left/right,
// the head and neck bend smoothly into the turn like a real shark/whale
// rather than revolving like a rigid rod.
export const uCreatureTurn = /*@__PURE__*/ uniform( 0.0 );
// Radians the mandible swings up from the modelled-open rest. 0 is the
// dropped bind pose; the slider (sdGape) and SeaDragon.gape multiply into
// this in the app. Hinge is a fraction of length so a 20 m animal and a
// 60 m one close about the same mouth-corner, not the same metre offset.
export const uCreatureGape = /*@__PURE__*/ uniform( 0.0 );
export const uCreatureJawHY = /*@__PURE__*/ uniform( 0.0142 );
export const uCreatureJawHZ = /*@__PURE__*/ uniform( - 0.373 );

/**
 * A travelling wave down the body, in the VERTEX stage.
 *
 * At station s (0 at the nose, 1 at the tail tip) the body is pushed by
 * sin( s*waves*2pi - phase ), sideways and/or up depending on uCreatureSide
 * and uCreatureLift, with the amplitude ramped in from the head. The
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

	// Mandible, BEFORE the swim wave so the (nearly still) head carries a
	// closing jaw rather than a jaw that sloshes with the tail. The mesh
	// has no clip and the mandible ends at the mouth corner — there is no
	// bone aft of it — so this is a geometric hinge, not skinning. CPU
	// twin: src/creature-jaw.js. Rule 1: no chained .mix().
	const hy = uCreatureJawHY.mul( uCreatureLen ).toVar();
	const hz = uCreatureJawHZ.mul( uCreatureLen ).toVar();
	const along = p.z.sub( hz ).toVar();
	const below = hy.sub( p.y ).toVar();
	const wZ = float( 1.0 ).sub(
		smoothstep( uCreatureLen.mul( - 0.02 ), uCreatureLen.mul( 0.015 ), along ),
	).toVar();
	const wY = smoothstep( float( 0.0 ), uCreatureLen.mul( 0.02 ), below ).toVar();
	const jawW = wZ.mul( wY ).toVar();
	const jawAng = uCreatureGape.mul( jawW ).toVar();
	const cJ = cos( jawAng ).toVar(), sJ = sin( jawAng ).toVar();
	const dyJ = p.y.sub( hy ).toVar();
	const dzJ = p.z.sub( hz ).toVar();
	p.y.assign( hy.add( dyJ.mul( cJ ).sub( dzJ.mul( sJ ) ) ) );
	p.z.assign( hz.add( dyJ.mul( sJ ).add( dzJ.mul( cJ ) ) ) );
	const ny0 = normalLocal.y.toVar(), nzJ = normalLocal.z.toVar();
	normalLocal.assign( vec3(
		normalLocal.x,
		ny0.mul( cJ ).sub( nzJ.mul( sJ ) ),
		ny0.mul( sJ ).add( nzJ.mul( cJ ) ),
	) );

	// Head & anterior spine steering into turns.
	// When a shark, whale, or sea creature steers, the rostrum and neck arch smoothly
	// into the turn direction. s runs 0 at the nose to 1 at the tail.
	// We curve the front half (s < 0.50) with a smooth cubic falloff toward mid-body (s = 0.50),
	// rotating vertices and normals around Y.
	const wTurn = float( 1.0 ).sub( smoothstep( 0.04, 0.50, s ) ).toVar();
	const turnAng = uCreatureTurn.mul( wTurn ).toVar();
	const cT = cos( turnAng ).toVar(), sT = sin( turnAng ).toVar();
	const dxT = p.x.toVar(), dzT = p.z.toVar();
	p.x.assign( dxT.mul( cT ).sub( dzT.mul( sT ) ) );
	p.z.assign( dxT.mul( sT ).add( dzT.mul( cT ) ) );

	const nx00 = normalLocal.x.toVar(), nz00 = normalLocal.z.toVar();
	normalLocal.assign( vec3(
		nx00.mul( cT ).sub( nz00.mul( sT ) ),
		normalLocal.y,
		nx00.mul( sT ).add( nz00.mul( cT ) ),
	) );

	const k = uCreatureWaves.mul( TAU_C ).toVar();
	const ph = s.mul( k ).sub( uCreaturePhase ).toVar();
	// Ramp: the head holds still, the tail does the work.
	const ramp = smoothstep( 0.06, 0.85, s ).toVar();
	const amp = uCreatureAmp.mul( uCreatureLen ).mul( ramp ).toVar();
	const ampX = amp.mul( uCreatureSide ).toVar();
	const ampY = amp.mul( uCreatureLift ).toVar();
	// Quarter-turn only when both axes are live, so "Both" is a helix
	// rather than a single diagonal flop.
	const phY = ph.add( uCreatureSide.mul( uCreatureLift ).mul( 1.5707963 ) ).toVar();

	p.x.addAssign( sin( ph ).mul( ampX ) );
	p.y.addAssign( sin( phY ).mul( ampY ) );

	// d(offset)/dz, with the ramp's own slope folded in, so the normal turns
	// with the surface it belongs to.
	const dRamp = smoothstep( 0.06, 0.85, s.add( 0.02 ) ).sub( ramp ).div( 0.02 ).toVar();
	const slopeX = cos( ph ).mul( ampX ).mul( k ).div( uCreatureLen )
		.add( sin( ph ).mul( uCreatureAmp ).mul( uCreatureSide ).mul( dRamp ) ).toVar();
	const slopeY = cos( phY ).mul( ampY ).mul( k ).div( uCreatureLen )
		.add( sin( phY ).mul( uCreatureAmp ).mul( uCreatureLift ).mul( dRamp ) ).toVar();

	const angX = atan( slopeX ).toVar();
	const cX = cos( angX ).toVar(), sX = sin( angX ).toVar();
	const nx = normalLocal.x.toVar(), nz0 = normalLocal.z.toVar();
	const n1 = vec3(
		nx.mul( cX ).add( nz0.mul( sX ) ),
		normalLocal.y,
		nz0.mul( cX ).sub( nx.mul( sX ) ),
	).toVar();

	const angY = atan( slopeY ).toVar();
	const cY = cos( angY ).toVar(), sY = sin( angY ).toVar();
	normalLocal.assign( vec3(
		n1.x,
		n1.y.mul( cY ).add( n1.z.mul( sY ) ),
		n1.z.mul( cY ).sub( n1.y.mul( sY ) ),
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

	// Underwater wave-refraction caustics dancing on the submerged body.
	// Same lace web the column pass projects on the shelf.
	const causticWave = uwCaustic(
		positionWorld.x.add( uSunDir.x.mul( depth.mul( 0.25 ) ) ),
		positionWorld.z.add( uSunDir.z.mul( depth.mul( 0.25 ) ) ),
		uCreaturePhase.mul( 0.45 ),
	).toVar();
	const causticFade = exp( depth.mul( - 0.20 ) ).mul( smoothstep( 0.0, 0.3, NoL ) ).toVar();
	const causticLight = sunRad.mul( NoL ).mul( causticWave ).mul( causticFade ).mul( 0.42 ).toVar();

	const lit = albedo.mul(
		sunRad.mul( NoL ).mul( 0.55 ).add( causticLight ).add( skyIrr.mul( domeVis ) ),
	).div( PI_C ).mul( down ).toVar();

	// A hint of the water's own colour on the body - scattered in along the
	// camera ray, not the vertical depth. Sunlight still falls from above
	// (`down`); this is only the last-metre stain, and the sea still owns the
	// real column (uRefractFade). Side views through a long stretch of sea
	// pick up more of the stain than looking straight down at the same depth.
	const toFrag = positionWorld.sub( cameraPosition ).toVar();
	const eyeRun = toFrag.length().max( 1e-4 ).toVar();
	const tAir = cameraPosition.y.sub( uCreatureSeaY )
		.div( toFrag.y.negate().div( eyeRun ).max( 1e-3 ) ).max( 0.0 ).toVar();
	const waterToEye = eyeRun.sub( tAir ).max( 0.0 ).toVar();
	const col = mix( lit, uCreatureTint.mul( skyIrr ).div( PI_C ),
		float( 1.0 ).sub( exp( waterToEye.mul( - 0.08 ) ) ).mul( 0.45 ) ).toVar();

	// The haze, the way the hull and the sea take it - but ONLY in the beauty
	// pass. In the refraction pass the sea hazes the finished pixel, this body
	// included, and applying it here as well would haze it twice.
	If( uCreatureAerial.greaterThan( 0.001 ), () => {

		// Breached wet-skin specular reflection (Fresnel + sharp highlight)
		const V = normalize( cameraPosition.sub( positionWorld ) ).toVar();
		const H = normalize( uSunDir.add( V ) ).toVar();
		const NoH = N.dot( H ).max( 0.0 ).toVar();
		const VoH = V.dot( H ).max( 0.0 ).toVar();
		const f0 = float( 0.028 );
		const fFresnel = f0.add( float( 1.0 ).sub( f0 ).mul( float( 1.0 ).sub( VoH ).clamp( 0.0, 1.0 ).pow( 5.0 ) ) ).toVar();
		const wetSunSpec = NoH.pow( 42.0 ).mul( fFresnel ).mul( sunRad ).mul( NoL ).mul( 1.2 ).toVar();
		const R = reflect( V.negate(), N ).toVar();
		const skyTap = skyLutTexture.sample( vec2( 0.5, R.y.mul( 0.5 ).add( 0.5 ).clamp( 0.01, 0.99 ) ) ).level( 5.0 ).rgb.toVar();
		const wetSkySpec = skyTap.mul( fFresnel ).mul( 0.45 ).toVar();
		col.addAssign( wetSunSpec.add( wetSkySpec ) );

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
