// The sea surface itself in TSL: the displaced radial grid (the vertex stage)
// and the water BRDF that lights it (the fragment stage).
//
// Ported from src/shaders/water.js:
//   WATER_VS         lines 27-128   -> waterPosition() below, minus gl_Position
//   WATER_FS main()  lines 341-788  -> waterFragment() below, minus ABYSSAL_OUT
//
// The three modules under it hold everything that is shared or self-contained:
//   ./water-common.js  the cascade weight, both cascade accumulation loops, the
//                      wake field, and every uniform more than one module reads
//   ./water-brdf.js    sampleSky, the GGX D/V pair, the dielectric Fresnel
//   ./water-detail.js  scintillation, sunVisibility, capillarySlope, foamField
// This file is main(), and nothing imports it.
//
// One source, both backends: no wgslFn, no glslFn. A raw-source node compiles
// for exactly one backend and would put the WebGL2 fallback back where it
// started (docs/webgpu-port.md).
//
// The physics is unchanged. Every constant, sign, clamp and magic number below
// is the one that shipped, and the GLSL comments explaining *why* each is what
// it is are carried across with them. Most of those numbers are the residue of a
// specific defect - a horizontal seam, a molten plateau, a bucket of cream - and
// the comment is the only record of which. They are documentation, not
// decoration.
//
// ---------------------------------------------------------------------------
// WHICH COORDINATE INDEXES WHAT. READ THIS BEFORE CHANGING A FETCH.
//
// There are two horizontal coordinates in play and they differ by metres:
//
//   xz / vFlat.xz   the UNDISPLACED grid point. Where this patch of sea would
//                   be if the water were flat. This is the Lagrangian reference
//                   coordinate the FFT cascades are defined on: the simulation
//                   stores D(x), the displacement OF the point x, so the field
//                   must be looked up at x and never at x + D(x).
//   vWorld.xz       the DISPLACED point. Where the water actually is.
//
// Indexed by the UNDISPLACED coordinate - all of these, deliberately:
//   the displacement cascades          (WATER_VS:73,  sampleCascadeDisp( xz, r ))
//   the slope and foam cascades        (WATER_FS:365, sampleCascadeSurface( vFlat.xz, dist ))
//   the wake field, in BOTH stages     (WATER_VS:115 and WATER_FS:408/428-429)
//   the pixel footprint fwidth()       (WATER_FS:351)
//   the capillary ripples              (WATER_FS:389)
//   the swell shadow march             (WATER_FS:568)
//
// Visual-only detail may respond to the displaced point without moving the
// physical fields it resolves. Scintillation uses it directly; foam starts in
// vFlat and takes only part of the orbital displacement plus a small slope
// shear, so its lace stretches with the water while coverage stays attached to
// the correct Lagrangian patch.
//
// Indexed by the DISPLACED point:
//   scintillation, in the sun lobe     (WATER_FS:653, vWorld.xz)
//   scintillation, in the moon lobe    (WATER_FS:677, vWorld.xz + 71.3)
//
// The scintillation exception is load-bearing and the GLSL says why (water.js:650-652):
// the glitter flashes have to LIVE ON the water and be carried by it. Sampling
// them at the undisplaced grid instead leaves the whole pattern sliding across
// the waves it is supposed to belong to - which reads as a shimmer travelling
// over a still sea, not as sun on water.
//
// The failure in the other direction is quieter and worse: indexing a cascade by
// the displaced point looks completely reasonable, compiles, and produces a sea
// whose crests are displaced by the displacement of somewhere else. At default
// choppiness that is a metre or two of horizontal error, so the surface still
// looks like water - it just no longer matches the height field the fragment
// shader shadows against or the wake the vertex shader lifted.
//
// The two stages MUST agree on this. The vertex stage displaces by
// wakeAt(xz).y; the fragment stage builds the ridge normal from wakeAt(vFlat.xz)
// - the same argument, because vFlat is the undisplaced position the vertex
// stage wrote. Feeding one of them vWorld.xz makes the ridge's shading normal
// belong to a different ridge than the geometry, which is precisely the "decal
// lying on flat water" the GLSL warns about at water.js:399-401.
//
// ---------------------------------------------------------------------------
// SEVEN THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. EVERY BLEND USES THE STANDALONE mix( a, b, t ). There are 20 of them
//    in this file and the method form is wrong in all 20:
//
//      mixElement        = ( t, e1, e2 )    => mix( e1, e2, t )
//      smoothstepElement = ( x, low, high ) => smoothstep( low, high, x )
//
//    So `x.smoothstep(lo, hi)` is GLSL's smoothstep(lo, hi, x) - the object is
//    the VALUE, which is what a reader expects - but `col.mix(target, alpha)` is
//    mix(target, alpha, col): the object is the FACTOR, not the first endpoint.
//    It compiles, it runs, and it blends by the wrong variable. This is porting
//    rule 1 and it is the defect that cost the sky port the most time (a cirrus
//    veil drawn at nearly full strength with an alpha of 0.0008). Do not
//    "simplify" one back to a method call.
//
// 2. `float var` (WATER_FS:436) CANNOT KEEP ITS NAME. `var` is a reserved word
//    in JavaScript. The binding here is `slopeVar`, and it is the filtered slope
//    variance that feeds both alphas and the glitter gate - not to be confused
//    with `vAl`/`vCr`, which are its two Cox-Munk halves.
//
// 3. THE HULL BLOCK'S smoothstep HAS ITS EDGES DESCENDING, ON PURPOSE:
//
//      float press = -g * smoothstep(1.2, -1.6, along);     // edge0 > edge1
//
//    Both GLSL ES and WGSL call edge0 >= edge1 undefined, and both in practice
//    compile it to t = clamp((x-e0)/(e1-e0), 0, 1); t*t*(3-2t), which gives a
//    descending ramp - the water is pressed down UNDER and just AFT of the hull.
//    That is the intent. Preserve the edge ORDER; do NOT "fix" it to
//    smoothstep(-1.6, 1.2, along).oneMinus(), which is algebraically identical
//    for this polynomial but not bit-identical, and which would also hide the
//    hazard from the next reader. Same trap ./cloud-field.js documents in its
//    note 3. If a WebGPU run ever shows the hollow on the wrong side of the
//    hull, this line is the first suspect.
//
// 4. THE VARYINGS ARE varyingProperty NODES, AND BOTH STAGES MUST BE ON THE SAME
//    MATERIAL. varyingProperty(type, name) is three's own mechanism for a value
//    written in the vertex stage and read in the fragment stage (r185 uses it
//    for vBatchColor in Batch.js and vInstanceColor in Instance.js). The six
//    here mirror the GLSL's six `out`s one for one, same names, same types, no
//    packing. waterPosition() ASSIGNS them; waterFragment() READS them. Assign
//    them to positionNode and fragmentNode of ONE NodeMaterial or the fragment
//    stage reads nothing.
//
//    prototypes/tsl-material-probe.html verified the round trip (and a texture
//    fetch in the vertex stage) on both backends, using the value form
//    `varying(vec2(0,0), 'vCarried')`. varyingProperty is the same PropertyNode
//    with varying = true and no placeholder, which is what lets the declaration
//    be a bare type here and the assignment happen inside the Fn.
//
// 5. uViewProj IS GONE, AND positionNode RETURNS A WORLD-SPACE POSITION.
//    Three's own MVP replaces the GLSL's `gl_Position = uViewProj * vec4(pos,1)`.
//    NodeMaterial.setupPosition assigns positionNode into positionLocal and then
//    builds modelViewProjection from it, so THE DRIVER MUST KEEP THE WATER
//    MESH'S matrixWorld AT IDENTITY (matrixAutoUpdate = false, and
//    frustumCulled = false because the grid's bounding box is meaningless). Then
//    modelViewMatrix reduces to the view matrix and gl_Position comes out
//    identical to the GLSL's. Do NOT reach for material.vertexNode with a
//    uViewProj uniform instead: that bypasses Three's camera entirely and breaks
//    coexistence with anything else in the scene.
//
// 6. uSunColor IS ./atmosphere.js's uSunIrradiance. Both are p.sunIrradiance
//    (src/water.js:148 and src/sky.js:40), so there is one uniform, imported.
//    Everywhere the GLSL says uSunColor this file says uSunIrradiance. Likewise
//    uTime/uCamPos are ./cloud-field.js's, uSunDir/uMoonDir/uMoonColor are
//    ./sky-lut.js's, and uSunAngularRadius/uSkyLUT are ./sky-background.js's.
//    Porting rule 7: do not redeclare a uniform another module owns.
//
//    Both vertex stages read uCamPos for the horizon-pinned outermost ring
//    (they used to declare it unused). ABYSSAL_OUT/uOutExposure is the HDR output guard, which
//    is the driver's business and a no-op in value terms - the same call
//    ./sky-background.js made.
//
// 7. sampleSky HERE IS ./water-brdf.js's TWO-ARGUMENT ONE, (rd, alpha), which
//    picks a mip from the lobe width. ./sky-background.js exports a DIFFERENT
//    function of the same name, (rd) at explicit LOD 0. This file imports only
//    skyLutTexture and uSunAngularRadius from sky-background.js; importing its
//    sampleSky would compile and would quietly make every water reflection a
//    perfect mirror.

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, int, vec2, vec3, vec4, uniform, uniformArray, attribute, varyingProperty,
	mix, clamp, smoothstep, select, reflect, dFdx, dFdy, fwidth, atan, acos, max,
	texture, screenUV, step, normalize, exp,
	cameraNear, cameraFar, cameraViewMatrix, perspectiveDepthToViewZ,
} from 'three/tsl';

import {
	R_PLANET, TAU_A, uAtmoExposure, uSunIrradiance,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';

import { uSunDir, uMoonDir, uMoonColor } from './sky-lut.js';
import { skyLutTexture, uSunAngularRadius } from './sky-background.js';
import { uTime, uCamPos } from './cloud-field.js';
import { fbm2, vnoise, vnoise2, cellular3, hash22 } from './noise.js';

import {
	PI_W, R_EARTH, uWindDir, uWakeOn, uWakeExtent, uWakeDepth, uWakeArmW,
	uWakeArm,
	sampleCascadeDisp, sampleCascadeSurface, sampleCascadeSlope, wakeAt, wakeAgeAt,
	foamEnergyAt, uFoamEnergyOn,
} from './water-common.js';
import { kelvinWakeAt, uKelvinOn } from './kelvin-wake.js';
import { vWakeAt, uVWakeOn } from './v-wake.js';
import { wakeWaveAt, uWakeWaveCount } from './wake-wave.js';
import {
	wakePhysicsAt, wakePhysicsContactAt, wakePhysicsGeometryMaskAt, uWakePhysOn,
} from './wake-physics.js';
import {
	rippleAt, rippleVelAt, uRippleOn, uRippleDebug, uRippleVis, uRippleFoam,
	uRippleCrestGate,
} from './ripple-field.js';
import { pierceFieldAt, uPierceOn } from './pierce.js';
import { pierceCutAt } from './pierce-carve.js';
export { uVWakeOn };

import {
	sampleSky, D_GGX, D_GGXAniso, V_SmithGGX, V_SmithAniso,
	fresnelDielectric, envFresnel,
} from './water-brdf.js';

import {
	scintillation, sunVisibility, capillarySlope, foamField, uGlitter, uFoamDrift,
} from './water-detail.js';
import { foamLaceTexture, wakeFoamTexture } from './water-assets.js';
import {
	FLOOR_LACE_NEAR, FLOOR_LACE_FAR, FLOOR_LACE_DEPTH_K, FLOOR_LACE_MUL,
} from '../../seafloor.js';
import {
	FOAM_TEXTURE_CARRY, FOAM_TEXTURE_SHEAR, FOAM_TEXTURE_STRAIN,
	FOAM_LACE_STRETCH_BLOCK,
	WAKE_FOAM_FRESH, WAKE_FOAM_RESIDUE,
	WAKE_FOAM_WASH, WAKE_FOAM_TAIL, WAKE_FOAM_BROKEN,
	WAKE_FOAM_ENERGY_LO, WAKE_FOAM_ENERGY_HI,
	WAKE_FOAM_RIBBON_VARY, WAKE_FOAM_RIBBON_VARY_MAX,
	WAKE_FOAM_RIBBON_WARP0, WAKE_FOAM_RIBBON_WARP1,
} from '../../foam-lace.js';
import { horizonPinAmount, UNDER_WAVE_FADE } from '../../horizon-pin.js';
import { SPLASH_PARCELS, SPLASH_DROPS } from '../../splash-field.js';
import { BODY_STATIONS, SWELL_SITES } from '../../body-displace.js';
import {
	RIPPLE_LAMBDA, RIPPLE_LAMBDA_MIN, RIPPLE_TRAIN, RIPPLE_NEAR,
	RIPPLE_WOBBLE_A, RIPPLE_WOBBLE_B, RIPPLE_WOBBLE_C,
	RIPPLE_BREAK_LOBE, RIPPLE_BREAK_FINE, RIPPLE_BREAK_FLOOR,
	RIPPLE_STACK, RIPPLE_ARC_COS0, RIPPLE_ARC_COS1,
	BOW_STANDOFF, BOW_ALONG, BOW_ACROSS, BOW_AMP_ALONG, BOW_AMP_ACROSS,
	BOW_FOAM_SCALE,
} from '../../cut-ripples.js';
import {
	FLUKE_PRINTS, FLUKE_CAP_KILL, FLUKE_FOAM_KILL, FLUKE_ROUGH_KILL,
	FLUKE_FFT_KILL, FLUKE_SLOPE_KILL,
} from '../../fluke-slicks.js';
import { WAKE_FOAM_STAMPS } from '../../wake-foam.js';

// Focused sunlight on the bed. Twin: floorLace() in seafloor.js / WATER_FS.
// Layouted so the floor If does not inline cellular3 six times.
const floorLaceLayer = /*@__PURE__*/ Fn( ( [ x, z, t, scale, driftX, driftZ, phase ] ) => {

	const u = x.mul( scale ).add( t.mul( driftX ) ).toVar();
	const v = z.mul( scale ).add( t.mul( driftZ ) ).toVar();
	u.assign( u
		.add( v.mul( 1.7 ).add( t.mul( 0.7 ) ).add( phase ).sin().mul( 0.06 ) )
		.add( v.mul( 0.55 ).add( t.mul( 0.21 ) ).add( phase ).sin().mul( 0.04 ) ) );
	v.assign( v
		.add( u.mul( 1.4 ).add( t.mul( 0.55 ) ).add( phase ).cos().mul( 0.06 ) )
		.add( u.mul( 0.48 ).sub( t.mul( 0.17 ) ).add( phase ).cos().mul( 0.04 ) ) );
	const c = cellular3( vec2( u, v ) ).toVar();
	const gap = c.y.sub( c.x );
	const glow = float( 1.0 ).sub( smoothstep( float( 0.02 ), float( 0.22 ), gap ) ).pow( 1.15 );
	const ridge = float( 1.0 ).sub( smoothstep( float( 0.0 ), float( 0.07 ), gap ) ).pow( 2.2 );
	const broken = smoothstep( float( 0.18 ), float( 0.58 ), c.z );
	const flare = float( 1.0 ).sub( smoothstep( float( 0.0 ), float( 0.18 ), c.y ) ).pow( 2.6 )
		.mul( ridge );
	return glow.mul( 0.38 ).add( ridge.mul( 0.55 ) ).mul( broken ).add( flare.mul( 0.85 ) );

} );
floorLaceLayer.setLayout( {
	name: 'abyssal_floorLaceLayer',
	type: 'float',
	inputs: [
		{ name: 'x', type: 'float' },
		{ name: 'z', type: 'float' },
		{ name: 't', type: 'float' },
		{ name: 'scale', type: 'float' },
		{ name: 'driftX', type: 'float' },
		{ name: 'driftZ', type: 'float' },
		{ name: 'phase', type: 'float' },
	],
} );

const floorLaceCore = /*@__PURE__*/ Fn( ( [ x, z, t ] ) => {

	const a = floorLaceLayer( x, z, t, 2.85, 0.11, - 0.07, 0.0 );
	const b = floorLaceLayer( x, z, t, 1.95, - 0.08, 0.10, 2.1 );
	const c = floorLaceLayer( x, z, t, 3.55, 0.04, 0.09, 4.4 );
	const raw = a.mul( 0.52 ).add( b.mul( 0.34 ) ).add( c.mul( 0.22 ) ).min( 1.2 );
	const field = smoothstep( float( 0.04 ), float( 0.28 ), raw );
	const hot = smoothstep( float( 0.22 ), float( 0.74 ), raw ).pow( 1.7 );
	return field.mul( 0.42 ).add( hot.mul( 0.72 ) ).min( 1.0 );

} );
floorLaceCore.setLayout( {
	name: 'abyssal_floorLace',
	type: 'float',
	inputs: [
		{ name: 'x', type: 'float' },
		{ name: 'z', type: 'float' },
		{ name: 't', type: 'float' },
	],
} );

// Sun-facing / focusing swell punches the web. Twin: floorSunGain().
const floorSunGainCore = /*@__PURE__*/ Fn( ( [ sx, sz, sun, depth ] ) => {

	const sl = sun.length().max( 1e-4 );
	const L = sun.div( sl );
	const Ly = L.y.max( 0.0 );
	const Nf = vec3( sx.negate(), 1.0, sz.negate() ).normalize();
	const NoL = Nf.dot( L ).max( 0.0 );
	const along = sx.mul( L.x ).add( sz.mul( L.z ) );
	const focus = clamp(
		float( 1.0 ).div( float( 1.0 ).sub( along.mul( 1.85 ).mul( depth ).mul( 0.55 ) ).max( 0.22 ) ),
		0.25, 2.8,
	);
	const punch = float( 0.42 ).add( focus.mul( 0.48 ) );
	const face = float( 0.40 ).add( NoL.mul( 0.72 ) );
	const height = float( 0.16 ).add( Ly.mul( 0.84 ) );
	return clamp( face.mul( punch ).mul( height ), 0.0, 1.65 );

} );
floorSunGainCore.setLayout( {
	name: 'abyssal_floorSunGain',
	type: 'float',
	inputs: [
		{ name: 'sx', type: 'float' },
		{ name: 'sz', type: 'float' },
		{ name: 'sun', type: 'vec3' },
		{ name: 'depth', type: 'float' },
	],
} );

// ---- the varyings -----------------------------------------------------------
// WATER_VS:49-54 and WATER_FS:138-143, one for one. See note 4 in the header.
//
// Exported because a driver assembling a custom material may want to read them,
// and because naming them here is what guarantees the two stages agree.

export const vWorld = /*@__PURE__*/ varyingProperty( 'vec3', 'vWorld' );

// The UNDISPLACED grid point, with .y = uSeaLevel. See the coordinate note at
// the top: this is what every field in both stages is indexed by, except the two
// scintillation taps.
//
// vFlat.y is written and never read - it is kept a vec3 rather than packed down
// to the vec2 that is actually used, so this file diffs 1:1 against the GLSL.
export const vFlat = /*@__PURE__*/ varyingProperty( 'vec3', 'vFlat' );

export const vDist = /*@__PURE__*/ varyingProperty( 'float', 'vDist' );

// Assigned (disp.y) and never read - in the GLSL too (written WATER_VS:124, no
// reader anywhere in WATER_FS). Assign it anyway: the transcription's fidelity
// is the point, and a varying nothing reads folds to a vertex local.
export const vHeight = /*@__PURE__*/ varyingProperty( 'float', 'vHeight' );

// Local relief - the cascades ABOVE the swell only. Occlusion and subsurface
// glow care about that, not about how high the whole swell lifted this patch.
export const vRelief = /*@__PURE__*/ varyingProperty( 'float', 'vRelief' );

// The two longest cascades' height, UNWEIGHTED by the cascade fade. It is the
// reference height the fragment shader's shadow march compares against, and it
// has to be the unweighted one or the shadows creep with distance
// (./water-common.js note 5).
export const vSwellH = /*@__PURE__*/ varyingProperty( 'float', 'vSwellH' );
export const vSplashH = /*@__PURE__*/ varyingProperty( 'float', 'vSplashH' );

// ---- uniforms ---------------------------------------------------------------
// Only the ones read in main() and nowhere else - the ownership rule the four
// water modules were split on. Defaults are src/presets.js's, so this module
// evaluates to a sane sea before anything has called setWaterSurfaceUniforms().

// WATER_VS's uGridCenter. Set from (ctx.camPos[0], ctx.camPos[2]), exactly
// src/water.js:143. Declared rather than derived from uCamPos.xz on purpose: the
// grid centre is a distinct uniform in the GLSL and a driver may want to snap it
// to a lattice to stop the grid crawling under a moving camera.
export const uGridCenter = /*@__PURE__*/ uniform( 'vec2' );

export const uRMin = /*@__PURE__*/ uniform( 0.35 );
export const uRMax = /*@__PURE__*/ uniform( 42000.0 );
export const uEarthCurve = /*@__PURE__*/ uniform( 1.0 );
export const uSeaLevel = /*@__PURE__*/ uniform( 0.0 );
// 1 = pin the outermost ring to the sightline (closes the horizon coverage
// gap). 0 = leave that ring on the curved sea. Dropped only once the
// geometric horizon (including the high-camera dip) is off the top of the
// frame — src/horizon-pin.js. Dropping it earlier left a black tear.
export const uHorizonPin = /*@__PURE__*/ uniform( 1.0 );

// MESH-DRIVEN DISPLACEMENT, GENERALLY. Two shared slots, not two special
// cases: uHull* is "a body sitting ON the surface" and always presses a
// hollow DOWN (see the press/bow/side split lower down - press is negated,
// bow and side are not, so the water it shoulders aside stands back up around
// the dent rather than the dent just appearing from nowhere); uSwell* is "a
// body swimming UNDER the surface" and always lifts a mound UP. Every current
// vehicle - the ski, the seaplane, the boat - reports into uHull* through the
// single `hull` object three-main.js hands setWaterSurfaceUniforms() each
// frame (demo/three-main.js's `hull.push = params.hullPush` etc.). The sea
// dragon's swim mound is uSwell*. A leap writes the splash field
// (uSplash*) — cavity, discrete-parcel crown, return stamps — instead of heaving that
// mound into a hill. A THIRD kind of body - one more
// submerged mesh, say - reports into uSwell* the exact same way the dragon
// does: this primitive already does not know or care that today's occupant
// happens to be eel-shaped, only that something below the surface wants a
// mound over it (the animated curve/heave lives in uSwellWaves,
// uSwellSweep and uSwellLift, which default to 0 - a rigid body just leaves
// them alone). Only
// one occupant of each kind exists in the demo at a time, so this stays two
// uniform sets rather than an array the shader loops over - the sea dragon
// and one of {ski, plane, boat} is the whole roster this was built for, and a
// true N-body array is a bigger change than the roster has ever asked for.
//
// waterDisplaceEnabled/waterDisplaceAmount (src/presets.js) are the one knob
// that scales BOTH slots together, applied here and in three-main.js's own
// uSwellAmp assignment - see waterDisplaceScale() below.
export function waterDisplaceScale( p ) {

	if ( ( p.waterDisplaceEnabled ?? 1 ) < 0.5 ) return 0;
	return p.waterDisplaceAmount ?? 1;

}

// The craft displaces real water, not just foam: the hull presses a hollow into
// the surface and the water it moves stands up as a bow wave ahead of it and as
// shoulders either side. Geometry, so it catches light and shadow like the sea.
//
// Defaults are NO_HULL (src/water.js:18-23): a hull ten kilometres below the
// sea, with push and plane at zero. Passing that is how you say "no boat".
export const uHullPos = /*@__PURE__*/ uniform( 'vec3' );
export const uHullFwd = /*@__PURE__*/ uniform( 'vec2' );
export const uHullPush = /*@__PURE__*/ uniform( 0.0 );
export const uHullRadius = /*@__PURE__*/ uniform( 2.6 );   // along-hull extent, m
export const uHullBow = /*@__PURE__*/ uniform( 0.9 );      // how much stands back up as bow wave
export const uHullPlane = /*@__PURE__*/ uniform( 0.0 );

/** Twin of hullLift() in shaders/water.js. Signed metres. */
export const hullLift = /*@__PURE__*/ Fn( ( [ xz ] ) => {

	const h = float( 0.0 ).toVar();
	If( uHullPush.greaterThan( 0.0005 ), () => {

		const rel = xz.sub( uHullPos.xz ).toVar();
		const d2 = rel.dot( rel ).toVar();
		const Rh = uHullRadius.max( 0.5 ).toVar();
		If( d2.lessThan( Rh.mul( Rh ).mul( 4.0 ) ), () => {

			const along = rel.dot( uHullFwd ).toVar();
			const lat = rel.dot( vec2( uHullFwd.y.negate(), uHullFwd.x ) ).toVar();
			const g = along.mul( along ).div( Rh.mul( Rh ) )
				.add( lat.mul( lat ).div( Rh.mul( Rh ).mul( 0.30 ) ) )
				.negate().exp().toVar();
			const press = g.negate().mul( smoothstep( float( 1.2 ), float( - 1.6 ), along ) ).toVar();
			const bow = g.mul( smoothstep( float( - 0.1 ), float( 1.3 ), along ) ).mul( uHullBow ).toVar();
			const side = g.mul( smoothstep( float( 0.25 ), float( 1.0 ), lat.abs().div( Rh ) ) )
				.mul( uHullBow ).mul( 0.5 ).toVar();
			h.assign( press.add( bow ).add( side ).mul( uHullPush ).mul( uHullPlane ) );

		} );

	} );
	return h;

} );

export const uScatterColor = /*@__PURE__*/ uniform( 'vec3' );   // volumetric scattering albedo
export const uAbsorption = /*@__PURE__*/ uniform( 'vec3' );     // 1/m per channel
export const uScatterAmount = /*@__PURE__*/ uniform( 0.085 );

export const uSSSStrength = /*@__PURE__*/ uniform( 1.2 );
export const uSSSPower = /*@__PURE__*/ uniform( 4.0 );
export const uSSSHeight = /*@__PURE__*/ uniform( 0.75 );
export const uSSSDepth = /*@__PURE__*/ uniform( 1.0 );
export const uSSSBias = /*@__PURE__*/ uniform( 0.45 );     // how far the exit ray leans up the normal

export const uBaseRoughness = /*@__PURE__*/ uniform( 0.055 );
export const uRoughnessGain = /*@__PURE__*/ uniform( 1.0 );
export const uRoughnessMax = /*@__PURE__*/ uniform( 0.30 );   // alpha ceiling; Cox-Munk mss tops out near 0.06
export const uWindAniso = /*@__PURE__*/ uniform( 1.45 );      // along/cross-wind slope variance ratio
export const uWindSpeed = /*@__PURE__*/ uniform( 11.0 );      // U10, m/s

export const uCapillary = /*@__PURE__*/ uniform( 0.6 );
export const uCapillaryScale = /*@__PURE__*/ uniform( 1.0 );
export const uGust = /*@__PURE__*/ uniform( 0.0 );        // cat's-paw strength
export const uGustScale = /*@__PURE__*/ uniform( 55.0 );  // patch size, m
export const uGustDrift = /*@__PURE__*/ uniform( 0.35 );  // downwind travel, m/s per unit wind

export const uFoamAmount = /*@__PURE__*/ uniform( 0.7 );
export const uFoamRoughness = /*@__PURE__*/ uniform( 0.58 );
export const uFoamTint = /*@__PURE__*/ uniform( 0.16 );
export const uFoamDetail = /*@__PURE__*/ uniform( 1.85 );
export const uFoamLift = /*@__PURE__*/ uniform( 0.72 );
export const uFoamSharp = /*@__PURE__*/ uniform( 2.1 );
export const uFoamCrisp = /*@__PURE__*/ uniform( 0.88 );   // resolve coverage against the lace field up close
export const uFoamOpacity = /*@__PURE__*/ uniform( 0.78 );
export const uFoamFar = /*@__PURE__*/ uniform( 0.62 );     // grazing self-hiding of distant rafts
export const uFoamColor = /*@__PURE__*/ uniform( 'vec3' );
// Original histogram-balanced mask. It resolves physical coverage into
// filaments and bubble holes; it never decides how much foam exists.
export const uFoamTextureAmount = /*@__PURE__*/ uniform( 0.0 );
export const uFoamTextureScale = /*@__PURE__*/ uniform( 9.0 ); // metres per tile
export const uFoamTextureCarry = /*@__PURE__*/ uniform( FOAM_TEXTURE_CARRY );
export const uFoamTextureShear = /*@__PURE__*/ uniform( FOAM_TEXTURE_SHEAR );
export const uFoamTextureStrain = /*@__PURE__*/ uniform( FOAM_TEXTURE_STRAIN );
export const uFoamLaceStretch = /*@__PURE__*/ uniform( 0 );
export const uFoamLaceStretchBlock = /*@__PURE__*/ uniform( FOAM_LACE_STRETCH_BLOCK );
export const uFoamLaceMorph = /*@__PURE__*/ uniform( 0 );
export const uFoamLaceMorphRate = /*@__PURE__*/ uniform( 0 );
export const uWakeFoamRibbonVary = /*@__PURE__*/ uniform( WAKE_FOAM_RIBBON_VARY );
// Twin of wakeFoamRibbonAmount() — recipe foam, not energy. Energy
// saturates at planing; this is the veil → solid look.
export const uFoamRibbon = /*@__PURE__*/ uniform( 1.0 );

// Set separately from the wake block in src/water.js:169, so these two live here
// rather than in ./water-common.js: they are how the wake is SHADED, not what it
// is. wakeAt() and the twelve uniforms that shape the field are common.
export const uWakeRelief = /*@__PURE__*/ uniform( 1.0 );
export const uWakeSlick = /*@__PURE__*/ uniform( 0.8 );
// Entrained air in the water COLUMN, as opposed to white foam on the surface.
// In wake photography most of the wake's area is this and not foam: a pale
// milky turquoise plume you can see straight through, with a comparatively
// small amount of actual white on top. Painting only the white is what makes
// a wake read as a decal laid over untouched sea.
export const uWakePlume = /*@__PURE__*/ uniform( 1.0 );
// Bubbles scatter far more than clear water...
const WAKE_PLUME_GAIN = 6.5;
// ...and they turn the column back before it can absorb, so the effective
// path shortens. Together these are what make aerated water go pale rather
// than simply brighter — the long red-absorbing path is what made it blue.
const WAKE_PLUME_PATH = 0.26;

export const uSpecIntensity = /*@__PURE__*/ uniform( 1.0 );
export const uSpecClamp = /*@__PURE__*/ uniform( 20000.0 );
export const uSpecAA = /*@__PURE__*/ uniform( 1.0 );          // screen-space slope variance folded into the lobe
export const uGrazeFocus = /*@__PURE__*/ uniform( 0.20 );     // how far the reflection lobe narrows at grazing
// The craft's image in the sea. Port of WATER_FS's THE CRAFT IN THE WATER; see
// that note for why a proxy sphere against the reflection ray is the whole
// mechanism. Amount 0 (the default, and what any caller without a craft gets)
// leaves the reflection exactly as it was.
export const uCraftReflPos = /*@__PURE__*/ uniform( 'vec3' );
// A hull's mean albedo: most of them are pale. It only ever multiplies the sky
// the craft is under, so it is a tint and not a colour.
export const uCraftReflTint = /*@__PURE__*/ uniform( /*@__PURE__*/ vec3( 0.72, 0.76, 0.78 ) );
export const uCraftReflSize = /*@__PURE__*/ uniform( 0.0 );
export const uCraftReflAmount = /*@__PURE__*/ uniform( 0.0 );
// The shadow it throws, strength 0..1. Separate from the reflection's amount
// because the two fade for different reasons: the reflection dims as the craft
// climbs away from the water it is mirrored in, while the shadow softens on
// its own through the penumbra and needs no height fade at all.
export const uCraftShadow = /*@__PURE__*/ uniform( 0.0 );

// ---- a body under the surface, lifting it (or pressing a hollow) ---------
//
// Water a hull displaces has to go somewhere, and so does water a swimming body
// displaces. Without this the sea runs straight through the animal as though it
// were not there - the "clipped into it" look. The FIRST version was a
// Gaussian around the spine: one fat blob, honest to a sausage, not to the
// mesh. Nine implicit spheres then read as a ribbed barrel at the waterline.
// Occupancy (src/body-displace.js / src/cut-ripples.js): compact
// Gaussians at waterline cuts, plus fading / traveling rings after the
// mesh leaves. Extruding a ring along the spine drew two rails across
// the whole screen. A rigid body with no sites still uses the analytic
// capsule. uSwellAmp is the artist height in metres.
//
// THE SPINE CURVES. Same travelling sine wave ./creature.js's vertex stage
// bends the mesh into - same wave count, same phase, same head-holds-still
// ramp - plus pitch so a nose-down landing opens at the wet tip, not under
// the flying belly. uSwellPos is always the body ORIGIN; occupancy decides
// which stations are wet. A rigid body leaves the wave uniforms at 0.
export const uSwellPos = /*@__PURE__*/ uniform( 'vec3' );   // world origin (mid-body)
export const uSwellDir = /*@__PURE__*/ uniform( 'vec2' );   // heading, unit, toward the NOSE
export const uSwellLen = /*@__PURE__*/ uniform( 20.0 );     // nose to tail, m
export const uSwellRad = /*@__PURE__*/ uniform( 1.2 );      // Gaussian radius at each waterline cut, m; analytic: body radius
export const uSwellAmp = /*@__PURE__*/ uniform( 0.0 );      // peak lift, m (signed: + bulge, − hollow)
export const uSwellPitch = /*@__PURE__*/ uniform( 0.0 );    // radians; + raises the nose
// The travelling wave. 0 waves / 0 sweep is the old straight capsule exactly -
// sin(-phase)*0 is 0 everywhere - so a caller with a rigid body just leaves
// these at their defaults and pays nothing extra.
export const uSwellWaves = /*@__PURE__*/ uniform( 0.0 );    // body waves along the length
export const uSwellSweep = /*@__PURE__*/ uniform( 0.0 );    // peak lateral sweep, as a fraction of length
export const uSwellLift = /*@__PURE__*/ uniform( 0.0 );     // peak vertical sweep, as a fraction of length
export const uSwellLiftPhase = /*@__PURE__*/ uniform( 0.0 ); // +pi/2 for the helical "Both" mode
export const uSwellPhase = /*@__PURE__*/ uniform( 0.0 );    // radians
// The spray at the waterline. Read in the refraction block below (see "spray
// where it breaks the surface") rather than here - it needs `path`, which is
// a property of the REFRACTION sample, not of the mound.
export const uSwellFoamDepth = /*@__PURE__*/ uniform( 0.0 );     // metres of column that still counts as "breaking"
export const uSwellFoamStrength = /*@__PURE__*/ uniform( 0.0 );  // 0 disables the whole block
// Traveling packets only. xy = world XZ, z = ring radius (0 = birth at
// the cut), w = envelope width. Per-site amp is signed (+ crest, − trough
// first). uSwellAmp is the artist metres. No static meniscus.
// Compile-time index only (spray.js / water-common.js).
export const uSwellSites = /*@__PURE__*/ uniformArray(
	Array.from( { length: SWELL_SITES }, () => new THREE.Vector4( 0, 0, 0, - 1 ) ),
	'vec4',
);
// Packed amp / stretch / heading. Each uniformArray is its own WebGPU
// UBO, and the water fragment stage is already against the 12-buffer
// per-stage cap — do not add another array here without packing it.
export const uSwellSitePack = /*@__PURE__*/ uniformArray(
	Array.from( { length: SWELL_SITES }, () => new THREE.Vector4( 0, 0, 0, 1 ) ),
	'vec4',
);
export const uSwellSiteCount = /*@__PURE__*/ uniform( 0.0 );
// JS mirrors so probes can still read .array[i] as they used to. Not
// bound — the shader reads uSwellSitePack.
export const uSwellSiteAmp = { array: Array.from( { length: SWELL_SITES }, () => 0.0 ) };
export const uSwellSiteDir = {
	array: Array.from( { length: SWELL_SITES }, () => new THREE.Vector2( 0, 1 ) ),
};
export const uSwellSiteStretch = { array: Array.from( { length: SWELL_SITES }, () => 0.0 ) };
export const uSwellSiteArc = /*@__PURE__*/ uniformArray(
	Array.from( { length: SWELL_SITES }, () => new THREE.Vector2( RIPPLE_ARC_COS0, RIPPLE_ARC_COS1 ) ),
	'vec2',
);
export const uSwellRippleStretch = /*@__PURE__*/ uniform( 0.0 );
// Co-moving bow heap: xy = world XZ of the foremost cut, z = metres,
// w = radius. Lives ahead of the cut; expanding packets cannot.
export const uSwellBow = /*@__PURE__*/ uniform( new THREE.Vector4( 0, 0, 0, 8 ) );
export const uSwellBowDir = /*@__PURE__*/ uniform( new THREE.Vector2( 0, 1 ) );
export const uSwellBowSoft = /*@__PURE__*/ uniform( 1.0 );
// One ellipse on the dorsal mass when the body is just under — not a
// spine rail. xy = XZ, z = metres, w = along-radius. Across is uSwellDomeW.
export const uSwellDome = /*@__PURE__*/ uniform( new THREE.Vector4( 0, 0, 0, 8 ) );
export const uSwellDomeDir = /*@__PURE__*/ uniform( new THREE.Vector2( 0, 1 ) );
export const uSwellDomeW = /*@__PURE__*/ uniform( 4.0 );
// Fluke footprints. xy = XZ, z = radius, w = remaining amp.
// Vertex flattens the FFT inside the disc; fragment kills chop / foam.
export const uFlukePrints = /*@__PURE__*/ uniformArray(
	Array.from( { length: FLUKE_PRINTS }, () => new THREE.Vector4( 0, 0, 0, 0 ) ),
	'vec4',
);
export const uFlukeCount = /*@__PURE__*/ uniform( 0.0 );
// Leftover waterline / splash foam. Same packing as fluke prints
// (xy = XZ, z = radius, w = remaining amp) but ADDED to foamMask
// instead of killing it. Ages on its own clock so a jump-out or
// a dive cannot snap the white off the sea.
// Leftover foam is particles now; the unused CPU field still exists
// (check-leftover-foam.mjs) but must not take a UBO slot. Count stays
// so probes can assert it is 0.
export const uLeftoverFoamCount = /*@__PURE__*/ uniform( 0.0 );
// Persistent body trail, A and B interleaved (2 vec4s per stamp) so
// they share one UBO. Even index: centre XZ, edge phase, amp.
// Odd index: unit forward XZ, along radius, across radius.
export const uWakeFoam = /*@__PURE__*/ uniformArray(
	Array.from( { length: WAKE_FOAM_STAMPS * 2 }, ( _, i ) => (
		i % 2 === 0 ? new THREE.Vector4( 0, 0, 0, 0 ) : new THREE.Vector4( 0, 1, 1, 1 )
	) ),
	'vec4',
);
export const uWakeFoamCount = /*@__PURE__*/ uniform( 0.0 );
uSwellDir.value.set( 0.0, 1.0 );

// ---- a leap hitting the sea, not a mound --------------------------------
//
// splashPush used to be added to uSwellAmp, which is a Gaussian hill under
// the body. The next try was one expanding sine ring — a pebble ripple, and
// it read as a cartoon torus on a 60 m animal. The field is an implicit P2G
// of discrete parcels. Energy 0 is a no-op. TAU_A is a JS number — wrap it
// in float() before .div.
//
// Constants live in src/splash-field.js. This is a transcription, not a
// second model — a shared Fn used by both stages failed to compile on the
// headless GL water shader, so the height rides a varying and the fragment
// recovers slope from its screen derivatives (below).
export const uSplashPos = /*@__PURE__*/ uniform( 'vec2' );
export const uSplashDir = /*@__PURE__*/ uniform( 'vec2' );   // heading at the hit
export const uSplashLen = /*@__PURE__*/ uniform( 60.0 );    // body length, metres
export const uSplashAge = /*@__PURE__*/ uniform( 10.0 );     // seconds since the hit
export const uSplashEnergy = /*@__PURE__*/ uniform( 0.0 );   // 0 disables the whole block
uSplashPos.value.set( 0.0, 0.0 );
uSplashDir.value.set( 0.0, 1.0 );

// Height and foam cores are layouted Fns (porting rule 17): the vertex
// evaluates height once and the fragment three times for slope. They take
// only scalars — no uniforms — so the per-backend Fn cache is safe (rule 18).
// Numbers match src/splash-field.js. TAU_A / parcel counts are JS numbers:
// wrap in float() before any node method.
const splashGauss = ( x, w ) => x.mul( x ).div( w.mul( w ) ).negate().exp();
const splashTau = /*@__PURE__*/ float( TAU_A );
const splashNParcels = /*@__PURE__*/ float( SPLASH_PARCELS );
const splashNDrops = /*@__PURE__*/ float( SPLASH_DROPS );

const splashHashN = ( i ) => i.mul( 127.1 ).add( 311.7 ).sin().mul( 43758.5453 ).fract();

const splashWing = ( ang ) =>
	ang.sin().abs().pow( 2.2 ).mul( 0.94 ).add( 0.06 );

const splashParcelN = ( i, n ) => {

	const u = splashHashN( i.add( 0.31 ) );
	const v = splashHashN( i.add( 8.17 ) );
	const w = splashHashN( i.add( 19.4 ) );
	const slot = i.add( 0.5 ).div( n ).mul( splashTau );
	const pAng = slot.add( u.sub( 0.5 ).mul( splashTau.div( n ) ).mul( 0.50 ) );
	const wing = splashWing( pAng );
	const mass = float( 0.28 ).add( wing.mul( 0.72 ) ).mul( float( 0.70 ).add( v.mul( 0.50 ) ) );
	const speed = float( 0.80 ).add( w.mul( 0.40 ) );
	return { ang: pAng, mass, speed, wing };

};

const splashDropletN = ( i ) => {

	const p = splashParcelN( i.mod( splashNParcels ), splashNParcels );
	const u = splashHashN( i.add( 41.2 ) );
	const pAng = p.ang.add( u.sub( 0.5 ).mul( 0.28 ) );
	const mass = p.mass.mul( float( 0.18 ).add( splashHashN( i.add( 3.9 ) ).mul( 0.16 ) ) );
	const speed = p.speed.mul( float( 1.15 ).add( splashHashN( i.add( 7.2 ) ).mul( 0.35 ) ) );
	return { ang: pAng, mass, speed, wing: splashWing( pAng ) };

};

const parcelKernelN = ( r, ang, rP, pAng, wr, wa ) => {

	const dA = atan( ang.sub( pAng ).sin(), ang.sub( pAng ).cos() );
	return splashGauss( r.sub( rP ), wr ).mul( splashGauss( dA.mul( rP ), wa ) );

};

const splashParcelRadiusN = ( rCrown, speed ) =>
	rCrown.mul( float( 0.94 ).add( speed.mul( 0.10 ) ) );

const splashCrownAtN = ( t, r0, Lk ) =>
	r0.add( float( 26.0 ).mul( Lk ).mul( t ).div( float( 1.0 ).add( t.mul( 0.62 ) ) ) );

function splashFrame( xz ) {

	const rel = xz.sub( uSplashPos ).toVar();
	const along = rel.dot( uSplashDir ).toVar();
	const across = rel.dot( vec2( uSplashDir.y.negate(), uSplashDir.x ) ).toVar();
	// A body enters at an angle, so the hole is a slot - but a hard ellipse
	// reads as a stretched cigar, so this stays mild.
	const aspect = clamp( float( 1.0 ).add( uSplashLen.mul( 0.012 ) ), 1.2, 2.2 ).toVar();
	const r = vec2( along.div( aspect ), across ).length().toVar();
	const ang = atan( across, along ).toVar();
	const t = uSplashAge.toVar();
	const E = uSplashEnergy.max( 0.0 ).toVar();
	// splashLengthScale / splashBaseRadius: a 120 m animal opens twice the
	// hole a 30 m one does, and a harder hit opens a bigger one still.
	const Lk = clamp( uSplashLen.div( 60.0 ), 0.3, 3.0 ).pow( 0.6 ).toVar();
	const r0 = float( 3.4 ).add( E.sqrt().mul( 3.6 ) ).mul( Lk ).toVar();
	const rCrown = r0.add( float( 26.0 ).mul( Lk ).mul( t )
		.div( float( 1.0 ).add( t.mul( 0.62 ) ) ) ).toVar();
	return { r, ang, t, E, Lk, r0, rCrown };

}

const splashHeightCore = /*@__PURE__*/ Fn( ( [ r, ang, t, E, Lk, r0, rCrown ] ) => {

	const crownEnv = smoothstep( 0.0, 0.12, t ).mul( t.mul( - 1.30 ).exp() ).toVar();
	const craterEnv = smoothstep( 0.0, 0.05, t ).mul( t.mul( - 1.15 ).exp() ).toVar();

	const slot0 = ang.div( splashTau ).fract().mul( splashNParcels ).add( 0.5 ).floor().mod( splashNParcels );
	const wr = float( 0.16 ).add( t.mul( 0.18 ) ).mul( r0 );
	const wa0 = float( 0.34 ).mul( splashTau.div( splashNParcels ) );
	const crown = float( 0.0 ).toVar();
	const returned = float( 0.0 ).toVar();
	for ( const di of [ - 1, 0, 1 ] ) {

		const i = slot0.add( float( di + SPLASH_PARCELS ) ).mod( splashNParcels );
		const p = splashParcelN( i, splashNParcels );
		const rP = splashParcelRadiusN( rCrown, p.speed );
		const wa = wa0.mul( rP.max( r0.mul( 0.5 ) ) );
		const kern = parcelKernelN( r, ang, rP, p.ang, wr, wa );
		crown.addAssign( E.mul( 2.05 ).mul( Lk ).mul( crownEnv ).mul( p.mass ).mul( kern ) );

		const tLand = float( 0.36 ).add( splashHashN( i.add( 11.0 ) ).mul( 0.22 ) );
		const landEnv = smoothstep( tLand, tLand.add( 0.10 ), t )
			.mul( t.sub( tLand ).max( 0.0 ).mul( - 1.55 ).exp() );
		const rLand = splashParcelRadiusN( splashCrownAtN( tLand, r0, Lk ), p.speed );
		const wLand = float( 0.22 ).add( t.sub( tLand ).max( 0.0 ).mul( 0.28 ) ).mul( r0 );
		returned.addAssign( E.mul( 0.42 ).mul( Lk ).mul( landEnv ).mul( p.mass )
			.mul( parcelKernelN( r, ang, rLand, p.ang, wLand, wa.mul( 1.15 ) ) ) );

	}

	const dropEnv = smoothstep( 0.10, 0.22, t )
		.mul( t.sub( 0.10 ).max( 0.0 ).mul( - 2.0 ).exp() );
	const wrD = float( 0.07 ).add( t.mul( 0.10 ) ).mul( r0 );
	const slotD = ang.div( splashTau ).fract().mul( splashNDrops ).add( 0.5 ).floor().mod( splashNDrops );
	const waD0 = float( 0.32 ).mul( splashTau.div( splashNDrops ) );
	const drops = float( 0.0 ).toVar();
	for ( const di of [ - 1, 0, 1 ] ) {

		const i = slotD.add( float( di + SPLASH_DROPS ) ).mod( splashNDrops );
		const d = splashDropletN( i );
		const rD = rCrown.mul( float( 1.06 ).add( d.speed.mul( 0.38 ) ) );
		const waD = waD0.mul( rD.max( r0.mul( 0.5 ) ) );
		drops.addAssign( E.mul( 0.55 ).mul( Lk ).mul( dropEnv ).mul( d.mass ).mul( d.wing )
			.mul( parcelKernelN( r, ang, rD, d.ang, wrD, waD ) ) );

	}

	const crater = E.mul( Lk ).negate()
		.mul( craterEnv.mul( 0.58 ).add( crownEnv.mul( 0.40 ) ) )
		.mul( splashGauss( r, r0.mul( 0.70 ) ) );

	const jetEnv = smoothstep( 0.20, 0.42, t ).mul( float( 1.0 ).sub( smoothstep( 0.95, 1.75, t ) ) );
	const jet = E.mul( Lk ).mul( jetEnv ).mul(
		splashGauss( r, r0.mul( 0.20 ) ).mul( 0.62 )
			.add( splashGauss( r, r0.mul( 0.62 ) ).mul( 0.55 ) ),
	);

	const jet2Env = smoothstep( 1.5, 1.9, t ).mul( float( 1.0 ).sub( smoothstep( 2.3, 3.2, t ) ) );
	const jet2 = E.mul( 0.45 ).mul( Lk ).mul( jet2Env )
		.mul( splashGauss( r, r0.mul( 0.30 ) ) );

	const kTrain = float( 0.62 ).div( Lk );
	const train = E.mul( 0.34 ).mul( Lk ).mul( t.mul( - 0.30 ).exp() )
		.div( float( 1.0 ).add( r.div( r0 ) ).sqrt() )
		.mul( smoothstep( 0.10, 0.35, t ) )
		.mul( float( 1.0 ).sub( smoothstep( rCrown.mul( 0.80 ), rCrown.mul( 1.10 ), r ) ) )
		.mul( smoothstep( r0.mul( 0.6 ), r0.mul( 1.3 ), r ) )
		.mul( rCrown.sub( r ).mul( kTrain ).sin() );

	return crown.add( drops ).add( returned ).add( crater ).add( jet ).add( jet2 ).add( train );

} );

splashHeightCore.setLayout( {
	name: 'abyssal_splashHeightCore',
	type: 'float',
	inputs: [
		{ name: 'r', type: 'float' },
		{ name: 'ang', type: 'float' },
		{ name: 't', type: 'float' },
		{ name: 'E', type: 'float' },
		{ name: 'Lk', type: 'float' },
		{ name: 'r0', type: 'float' },
		{ name: 'rCrown', type: 'float' },
	],
} );

function splashHeightAt( xz ) {

	const { r, ang, t, E, Lk, r0, rCrown } = splashFrame( xz );
	return splashHeightCore( r, ang, t, E, Lk, r0, rCrown );

}

const splashFoamCore = /*@__PURE__*/ Fn( ( [ r, ang, t, E, r0, rCrown, Lk ] ) => {

	const slot0 = ang.div( splashTau ).fract().mul( splashNParcels ).add( 0.5 ).floor().mod( splashNParcels );
	const wr = float( 0.18 ).add( t.mul( 0.22 ) ).mul( r0 );
	const wa0 = float( 0.55 ).mul( splashTau.div( splashNParcels ) );
	const rim = float( 0.0 ).toVar();
	const landed = float( 0.0 ).toVar();
	for ( const di of [ - 1, 0, 1 ] ) {

		const i = slot0.add( float( di + SPLASH_PARCELS ) ).mod( splashNParcels );
		const p = splashParcelN( i, splashNParcels );
		const rP = splashParcelRadiusN( rCrown, p.speed );
		const wa = wa0.mul( rP.max( r0.mul( 0.5 ) ) );
		rim.addAssign( float( 1.25 ).mul( t.mul( - 0.80 ).exp() ).mul( p.mass )
			.mul( parcelKernelN( r, ang, rP, p.ang, wr, wa ) ) );

		const tLand = float( 0.36 ).add( splashHashN( i.add( 11.0 ) ).mul( 0.22 ) );
		const landEnv = smoothstep( tLand, tLand.add( 0.10 ), t )
			.mul( t.sub( tLand ).max( 0.0 ).mul( - 0.85 ).exp() );
		const rLand = splashParcelRadiusN( splashCrownAtN( tLand, r0, Lk ), p.speed );
		const wLand = float( 0.28 ).add( t.sub( tLand ).max( 0.0 ).mul( 0.40 ) ).mul( r0 );
		landed.addAssign( float( 0.72 ).mul( landEnv ).mul( p.mass )
			.mul( parcelKernelN( r, ang, rLand, p.ang, wLand, wa.mul( 1.20 ) ) ) );

	}

	const dropEnv = smoothstep( 0.10, 0.22, t )
		.mul( t.sub( 0.10 ).max( 0.0 ).mul( - 1.6 ).exp() );
	const wrD = float( 0.10 ).add( t.mul( 0.14 ) ).mul( r0 );
	const slotD = ang.div( splashTau ).fract().mul( splashNDrops ).add( 0.5 ).floor().mod( splashNDrops );
	const waD0 = float( 0.36 ).mul( splashTau.div( splashNDrops ) );
	const dropFoam = float( 0.0 ).toVar();
	for ( const di of [ - 1, 0, 1 ] ) {

		const i = slotD.add( float( di + SPLASH_DROPS ) ).mod( splashNDrops );
		const d = splashDropletN( i );
		const rD = rCrown.mul( float( 1.06 ).add( d.speed.mul( 0.38 ) ) );
		const waD = waD0.mul( rD.max( r0.mul( 0.5 ) ) );
		dropFoam.addAssign( float( 0.55 ).mul( dropEnv ).mul( d.mass ).mul( d.wing )
			.mul( parcelKernelN( r, ang, rD, d.ang, wrD, waD ) ) );

	}

	const streaks = float( 0.68 )
		.add( float( 0.5 ).add( ang.mul( 17.0 ).add( 1.1 ).sin().mul( 0.5 ) ).mul( 0.32 ) )
		.mul( float( 0.82 ).add( r.mul( 2.6 ).div( r0 ).sin().mul( 0.18 ) ) );
	const disk = float( 0.80 ).mul( t.mul( - 0.70 ).exp() )
		.mul( splashGauss( r, r0.mul( float( 0.80 ).add( t.mul( 0.45 ) ) ) ) )
		.mul( streaks );

	const raft = float( 0.32 ).mul( t.mul( - 0.38 ).exp() )
		.mul( splashGauss( r, r0.mul( float( 1.0 ).add( t.mul( 0.85 ) ) ) ) )
		.mul( float( 0.55 ).add( ang.mul( 9.0 ).add( 0.7 ).sin().mul( 0.45 ) ) );

	return clamp( rim.add( landed ).add( dropFoam ).add( disk ).add( raft )
		.mul( E.min( 2.2 ).div( 2.2 ) ), 0.0, 0.96 );

} );

splashFoamCore.setLayout( {
	name: 'abyssal_splashFoamCore',
	type: 'float',
	inputs: [
		{ name: 'r', type: 'float' },
		{ name: 'ang', type: 'float' },
		{ name: 't', type: 'float' },
		{ name: 'E', type: 'float' },
		{ name: 'r0', type: 'float' },
		{ name: 'rCrown', type: 'float' },
		{ name: 'Lk', type: 'float' },
	],
} );

function splashFoamAt( xz ) {

	const { r, ang, t, E, Lk, r0, rCrown } = splashFrame( xz );
	return splashFoamCore( r, ang, t, E, r0, rCrown, Lk );

}

// Occupancy core. Layouted (rule 17): the vertex evaluates height once and
// the fragment three times for slope, and nine stations inlined four times
// would blow WebKit's 8 KB private-space budget. Parameters and literals
// only — no uniform reads — so the per-backend Fn cache is safe (rule 18).
// Numbers match src/body-displace.js. JS numbers (TAU_A, station index,
// BODY_STATIONS - 1) are wrapped in float() before .div: a bare
// TAU_A.div(n) throws while building Fns, and idle uSwellAmp = 0 does
// NOT skip that build.
const bodyDisplaceCore = /*@__PURE__*/ Fn( ( [
	// `half` is a reserved word in GLSL ES — a layout input by that name
	// makes the whole water shader fail to compile on the WebGL2 backend.
	relX, relZ, dirX, dirZ, halfLen, len, rad, pitch,
	waves, sweep, liftAmt, liftPhase, phase, seaRel, amp,
] ) => {

	const k = waves.mul( float( TAU_A ) ).toVar();
	const sp = pitch.sin().toVar();
	const cp = pitch.cos().toVar();
	const perpX = dirZ.negate().toVar();
	const perpZ = dirX.toVar();
	const nM1 = float( BODY_STATIONS - 1 );
	const mound = float( 0.0 ).toVar();
	const cavity = float( 0.0 ).toVar();
	const prevX = float( 0.0 ).toVar();
	const prevY = float( 0.0 ).toVar();
	const prevZ = float( 0.0 ).toVar();
	const prevR = float( 0.5 ).toVar();

	for ( let i = 0; i < BODY_STATIONS; i ++ ) {

		const s = float( i ).div( nM1 );
		const along = halfLen.mul( float( 1.0 ).sub( float( 2.0 ).mul( s ) ) );
		const ph = s.mul( k ).sub( phase );
		const ramp = smoothstep( 0.06, 0.85, s );
		const lateral = ph.sin().mul( sweep ).mul( len ).mul( ramp );
		const heave = ph.add( liftPhase ).sin().mul( liftAmt ).mul( len ).mul( ramp );
		const taper = along.abs().div( halfLen ).smoothstep( 1.0, 0.25 );
		const r = rad.mul( mix( float( 0.55 ), float( 1.0 ), taper ) );
		const stX = dirX.mul( along ).add( perpX.mul( lateral ) );
		const stZ = dirZ.mul( along ).add( perpZ.mul( lateral ) );
		const stY = along.mul( sp ).add( heave.mul( cp ) );
		if ( i > 0 ) {

			const abx = stX.sub( prevX );
			const abz = stZ.sub( prevZ );
			const len2 = abx.mul( abx ).add( abz.mul( abz ) );
			const t = select( len2.greaterThan( 1e-8 ),
				clamp( relX.sub( prevX ).mul( abx ).add( relZ.sub( prevZ ).mul( abz ) ).div( len2 ), 0.0, 1.0 ),
				float( 0.0 ) );
			const qx = prevX.add( abx.mul( t ) );
			const qz = prevZ.add( abz.mul( t ) );
			const across = relX.sub( qx ).mul( relX.sub( qx ) ).add( relZ.sub( qz ).mul( relZ.sub( qz ) ) ).sqrt();
			const y = mix( prevY, stY, t );
			const rr = mix( prevR, r, t ).max( 0.5 );
			const top = y.add( rr );
			const bot = y.sub( rr );
			const pierce = select( top.greaterThan( seaRel ), select( bot.lessThan( seaRel ), float( 1.0 ), float( 0.0 ) ), float( 0.0 ) );
			const near = select( across.lessThan( rr.mul( 2.2 ) ), float( 1.0 ), float( 0.0 ) );
			const falloff = across.mul( across ).div( rr.mul( rr ) ).negate().exp().mul( pierce ).mul( near );
			mound.assign( mound.max( falloff ) );
			cavity.assign( cavity.max( falloff ) );

		}
		prevX.assign( stX );
		prevY.assign( stY );
		prevZ.assign( stZ );
		prevR.assign( r );

	}

	const raw = select( amp.lessThan( 0.0 ), cavity.negate(), mound );
	return raw.mul( amp.abs() );

} );

bodyDisplaceCore.setLayout( {
	name: 'abyssal_bodyDisplaceCore',
	type: 'float',
	inputs: [
		{ name: 'relX', type: 'float' },
		{ name: 'relZ', type: 'float' },
		{ name: 'dirX', type: 'float' },
		{ name: 'dirZ', type: 'float' },
		{ name: 'halfLen', type: 'float' },
		{ name: 'len', type: 'float' },
		{ name: 'rad', type: 'float' },
		{ name: 'pitch', type: 'float' },
		{ name: 'waves', type: 'float' },
		{ name: 'sweep', type: 'float' },
		{ name: 'liftAmt', type: 'float' },
		{ name: 'liftPhase', type: 'float' },
		{ name: 'phase', type: 'float' },
		{ name: 'seaRel', type: 'float' },
		{ name: 'amp', type: 'float' },
	],
} );

// One traveling packet. Layouted so the site loop × four stage evals
// do not inline (rule 17). No uniform reads (rule 18).
// CPU twin: siteHeight() in src/cut-ripples.js. A forward arc, not a
// compass ring: wobble + a stretch frozen at emit + a heading mask
// (live heading would shear waves that have already left).
const swellSiteCore = /*@__PURE__*/ Fn( ( [ px, pz, sx, sz, ringR, width, amp, dirX, dirY, stretch, arc0, arc1 ] ) => {

	const live = select( width.greaterThan( 0.05 ), float( 1.0 ), float( 0.0 ) );
	const dx = px.sub( sx );
	const dz = pz.sub( sz );
	const dirLen = dirX.mul( dirX ).add( dirY.mul( dirY ) ).sqrt().max( 1e-5 );
	const fx = dirX.div( dirLen );
	const fz = dirY.div( dirLen );
	const along = dx.mul( fx ).add( dz.mul( fz ) );
	const across = dx.mul( fz ).negate().add( dz.mul( fx ) );
	const sa = float( 1.0 ).add( stretch );
	const sc = float( 1.0 ).add( stretch.mul( float( 0.35 ) ) );
	const d = along.div( sa ).mul( along.div( sa ) ).add( across.mul( sc ).mul( across.mul( sc ) ) ).sqrt();
	const raw = dx.mul( dx ).add( dz.mul( dz ) ).sqrt();
	const cosH = along.div( raw.max( 1e-5 ) );
	const tArc = smoothstep( arc0, arc1, cosH );
	const arc = select(
		raw.lessThan( 0.15 ),
		float( 1.0 ),
		tArc.mul( tArc ),
	);
	const ang = atan( dz, dx );
	const seed = sx.mul( 127.1 ).add( sz.mul( 311.7 ) ).sin().mul( 43758.5453 ).fract();
	const wobble = ang.mul( 3.0 ).add( seed.mul( float( 6.283185307179586 ) ) ).sin().mul( float( RIPPLE_WOBBLE_A ) )
		.add( ang.mul( 5.0 ).add( seed.mul( 4.1 ) ).sin().mul( float( RIPPLE_WOBBLE_B ) ) )
		.add( ang.mul( 2.0 ).add( seed.mul( 1.7 ) ).sin().mul( float( RIPPLE_WOBBLE_C ) ) );
	const ringEff = ringR.add( wobble.mul( width ) );
	const lobe = float( 0.5 ).add( ang.mul( float( RIPPLE_BREAK_LOBE ) ).add( seed.mul( 5.2 ) ).sin().mul( 0.5 ) );
	const fine = float( 0.55 ).add( ang.mul( float( RIPPLE_BREAK_FINE ) ).add( seed.mul( 2.7 ) ).sin().mul( 0.45 ) );
	const br = float( RIPPLE_BREAK_FLOOR ).add(
		float( 1.0 ).sub( float( RIPPLE_BREAK_FLOOR ) ).mul( lobe ).mul( lobe ).mul( fine ),
	);
	const a = amp.mul( br ).mul( arc );
	const dist = d.sub( ringEff ).abs();
	const w2 = width.mul( width ).max( 1e-4 );
	const near = select( dist.lessThan( width.mul( float( RIPPLE_NEAR ) ) ), float( 1.0 ), float( 0.0 ) );
	const env = dist.mul( dist ).div( w2 ).negate().exp().mul( live ).mul( near );
	const lambda = width.mul( float( RIPPLE_LAMBDA ) ).max( float( RIPPLE_LAMBDA_MIN ) );
	const k = float( 6.283185307179586 ).div( lambda );
	const pkt = env.mul( a ).mul( d.sub( ringEff ).mul( k ).cos() );
	const ring2 = ringEff.sub( lambda ).max( float( 0.0 ) );
	const dist2 = d.sub( ring2 ).abs();
	const near2 = select( dist2.lessThan( width.mul( float( RIPPLE_NEAR ) ) ), float( 1.0 ), float( 0.0 ) );
	const env2 = dist2.mul( dist2 ).div( w2 ).negate().exp().mul( live ).mul( near2 );
	const trainOn = select( ringR.greaterThan( lambda.mul( float( 0.8 ) ) ), float( 1.0 ), float( 0.0 ) );
	const packet2 = env2.mul( a ).mul( float( RIPPLE_TRAIN ) )
		.mul( d.sub( ring2 ).mul( k ).cos() )
		.mul( trainOn );
	return pkt.add( packet2 );

} );

swellSiteCore.setLayout( {
	name: 'abyssal_swellSiteCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'sx', type: 'float' },
		{ name: 'sz', type: 'float' },
		{ name: 'ringR', type: 'float' },
		{ name: 'width', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'dirX', type: 'float' },
		{ name: 'dirY', type: 'float' },
		{ name: 'stretch', type: 'float' },
		{ name: 'arc0', type: 'float' },
		{ name: 'arc1', type: 'float' },
	],
} );

// Co-moving bow. CPU twin: bowHeight() in src/cut-ripples.js.
const swellBowCore = /*@__PURE__*/ Fn( ( [ px, pz, bx, bz, dirX, dirY, amp, rh, soft ] ) => {

	const dirLen = dirX.mul( dirX ).add( dirY.mul( dirY ) ).sqrt().max( 1e-5 );
	const fx = dirX.div( dirLen );
	const fz = dirY.div( dirLen );
	const dx = px.sub( bx );
	const dz = pz.sub( bz );
	const along = dx.mul( fx ).add( dz.mul( fz ) );
	const across = dx.mul( fz ).negate().add( dz.mul( fx ) );
	const standoff = rh.mul( float( BOW_STANDOFF ) );
	// Footprint grows with height. rh alone is capped at ~4 m, so a
	// 16 m heap was a spike and the radial grid drew a line through it.
	// soft (sdBowSoft) spreads that same height so the radial
	// triangles stop reading as facets — same job as sdDomeSoft.
	const s = soft.max( 0.2 );
	const L = rh.mul( float( BOW_ALONG ) )
		.max( amp.abs().mul( float( BOW_AMP_ALONG ) ) )
		.max( 1e-3 )
		.mul( s );
	const W = rh.mul( float( BOW_ACROSS ) )
		.max( amp.abs().mul( float( BOW_AMP_ACROSS ) ) )
		.max( 1e-3 )
		.mul( s );
	const ga = along.sub( standoff ).div( L );
	const gb = across.div( W );
	return amp.mul( ga.mul( ga ).negate().exp() ).mul( gb.mul( gb ).negate().exp() );

} );

swellBowCore.setLayout( {
	name: 'abyssal_swellBowCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'bx', type: 'float' },
		{ name: 'bz', type: 'float' },
		{ name: 'dirX', type: 'float' },
		{ name: 'dirY', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'rh', type: 'float' },
		{ name: 'soft', type: 'float' },
	],
} );

// Dorsal pressure dome. CPU twin: pressureDomeHeight() in fluke-slicks.js.
const swellDomeCore = /*@__PURE__*/ Fn( ( [ px, pz, dx, dz, dirX, dirY, amp, alongR, acrossR ] ) => {

	const dirLen = dirX.mul( dirX ).add( dirY.mul( dirY ) ).sqrt().max( 1e-5 );
	const fx = dirX.div( dirLen );
	const fz = dirY.div( dirLen );
	const rx = px.sub( dx );
	const rz = pz.sub( dz );
	const along = rx.mul( fx ).add( rz.mul( fz ) );
	const across = rx.mul( fz ).negate().add( rz.mul( fx ) );
	const L = alongR.max( 0.5 );
	const W = acrossR.max( 0.5 );
	const ga = along.div( L );
	const gb = across.div( W );
	return amp.mul( ga.mul( ga ).negate().exp() ).mul( gb.mul( gb ).negate().exp() );

} );

swellDomeCore.setLayout( {
	name: 'abyssal_swellDomeCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'dx', type: 'float' },
		{ name: 'dz', type: 'float' },
		{ name: 'dirX', type: 'float' },
		{ name: 'dirY', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'alongR', type: 'float' },
		{ name: 'acrossR', type: 'float' },
	],
} );

// One fluke print. CPU twin: flukePrintMask() in src/fluke-slicks.js.
const flukeSlickCore = /*@__PURE__*/ Fn( ( [ px, pz, sx, sz, radius, amp ] ) => {

	const live = select( amp.greaterThan( 0.002 ).and( radius.greaterThan( 0.2 ) ), float( 1.0 ), float( 0.0 ) );
	const d = px.sub( sx ).mul( px.sub( sx ) ).add( pz.sub( sz ).mul( pz.sub( sz ) ) ).sqrt();
	const r = radius.max( 1e-3 );
	const edge = float( 1.0 ).sub( smoothstep( r.mul( float( 0.52 ) ), r, d ) );
	return edge.mul( amp ).mul( live );

} );

flukeSlickCore.setLayout( {
	name: 'abyssal_flukeSlickCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'sx', type: 'float' },
		{ name: 'sz', type: 'float' },
		{ name: 'radius', type: 'float' },
		{ name: 'amp', type: 'float' },
	],
} );

// Uniform reads stay HERE (rule 18). Shared by vertex flatten and fragment kill.
const flukeSlickAccum = /*@__PURE__*/ Fn( ( [ px, pz ] ) => {

	const acc = float( 0.0 ).toVar();
	If( uFlukeCount.greaterThan( 0.5 ), () => {

		for ( let i = 0; i < FLUKE_PRINTS; i ++ ) {

			const s = uFlukePrints.element( int( i ) );
			acc.assign( acc.max( flukeSlickCore( px, pz, s.x, s.y, s.z, s.w ) ) );

		}

	} );
	return acc.min( float( 1.0 ) );

} );

// One persistent wake-foam patch. CPU twin: wakeFoamMask() in wake-foam.js.
// Scalar layout keeps the uniform-array loop legal on both backends (rule 18).
const wakeFoamCore = /*@__PURE__*/ Fn( ( [ px, pz, cx, cz, phase, amp, fx, fz, alongR, acrossR ] ) => {

	const dl = fx.mul( fx ).add( fz.mul( fz ) ).sqrt().max( 1e-5 );
	const dx = px.sub( cx );
	const dz = pz.sub( cz );
	const dirX = fx.div( dl );
	const dirZ = fz.div( dl );
	const na = dx.mul( dirX ).add( dz.mul( dirZ ) ).div( alongR.max( 0.3 ) );
	const nc = dx.mul( dirZ ).negate().add( dz.mul( dirX ) ).div( acrossR.max( 0.3 ) );
	const q = na.mul( na ).add( nc.mul( nc ) ).sqrt();
	const wobble = clamp(
		float( 1.0 )
			.add( phase.mul( na ).mul( nc ).mul( 0.10 ) )
			.add(
				float( 1.0 ).sub( phase.abs() ).mul( 0.05 )
					.mul( na.mul( na ).sub( nc.mul( nc ) ) ),
			),
		0.75, 1.25,
	);
	// Soft mound. Twin of wakeFoamMask() — a 0.54 plateau was the decal.
	const mound = float( 1.0 ).sub( smoothstep( 0.10, 1.0, q.div( wobble ) ) );
	const h = px.mul( 12.9898 ).add( pz.mul( 78.233 ) ).add( phase ).sin().mul( 43758.5453 );
	const chew = mix( float( 0.62 ), float( 1.0 ), h.sub( h.floor() ) );
	const live = select( amp.greaterThan( 0.002 ), float( 1.0 ), float( 0.0 ) );
	return mound.mul( chew ).mul( amp ).mul( live );

} );

wakeFoamCore.setLayout( {
	name: 'abyssal_wakeFoamCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'cx', type: 'float' },
		{ name: 'cz', type: 'float' },
		{ name: 'phase', type: 'float' },
		{ name: 'amp', type: 'float' },
		{ name: 'fx', type: 'float' },
		{ name: 'fz', type: 'float' },
		{ name: 'alongR', type: 'float' },
		{ name: 'acrossR', type: 'float' },
	],
} );

const wakeFoamAccum = /*@__PURE__*/ Fn( ( [ px, pz ] ) => {

	const acc = float( 0.0 ).toVar();
	If( uWakeFoamCount.greaterThan( 0.5 ), () => {

		for ( let i = 0; i < WAKE_FOAM_STAMPS; i ++ ) {

			const a = uWakeFoam.element( int( i * 2 ) );
			const b = uWakeFoam.element( int( i * 2 + 1 ) );
			If( a.w.greaterThan( 0.002 ), () => {

				acc.assign( acc.max( wakeFoamCore(
					px, pz, a.x, a.y, a.z, a.w,
					b.x, b.y, b.z, b.w,
				) ) );

			} );

		}

	} );
	return acc.min( float( 1.0 ) );

} );

const swellFieldLive = /*@__PURE__*/ Fn( () => {

	return uSwellAmp.abs().greaterThan( 0.0005 )
		.or( uSwellBow.z.abs().greaterThan( 0.02 ) )
		.or( uSwellDome.z.abs().greaterThan( 0.02 ) );

} );

/**
 * Height the body adds at a point on the water plane. Shared by BOTH stages:
 * the vertex stage adds it to the surface, and the fragment stage differentiates
 * it to tilt the shading normal. That second half is not optional - a smooth
 * mound wearing the flat sea's normals is invisible except in silhouette, which
 * is how a lift like this ends up looking like nothing at all.
 *
 * Uniform reads stay HERE, not in the layouted core (rule 18).
 */
export const swellLift = /*@__PURE__*/ Fn( ( [ xz ] ) => {

	const h = float( 0.0 ).toVar();
	If( uSwellSiteCount.greaterThan( 0.5 ), () => {

		const acc = float( 0.0 ).toVar();
		for ( let i = 0; i < SWELL_SITES; i ++ ) {

			const s = uSwellSites.element( int( i ) );
			const pack = uSwellSitePack.element( int( i ) );
			const a = pack.x;
			const d = pack.zw;
			const st = pack.y;
			const arc = uSwellSiteArc.element( int( i ) );
			// Empty slots used to run the full packet (atan, three sines,
			// two Gaussians) and then multiply by live=0. With the dragon
			// on, siteCount is forced ≥ 1 so bow does not fall through to
			// bodyDisplace, and every sea pixel paid 24 dead cores × the
			// slope's three evals. Amp/width are 0 / −1 on a cleared slot.
			If( a.abs().greaterThan( 0.0005 ).and( s.w.greaterThan( 0.05 ) ), () => {

				acc.addAssign( swellSiteCore(
					xz.x, xz.y, s.x, s.y, s.z, s.w, a,
					d.x, d.y, st, arc.x, arc.y,
				) );

			} );

		}
		const stacked = acc.div( float( 1.0 ).add( float( RIPPLE_STACK ).mul( acc.abs() ) ) );
		h.assign( select( uSwellAmp.lessThan( 0.0 ), stacked.negate(), stacked ).mul( uSwellAmp.abs() ) );

	}, () => {

		const rel = xz.sub( uSwellPos.xz );
		const halfLen = uSwellLen.mul( 0.5 ).max( 0.5 );
		const rad = uSwellRad.max( 0.15 );
		const seaRel = uSeaLevel.sub( uSwellPos.y );
		h.assign( bodyDisplaceCore(
			rel.x, rel.z, uSwellDir.x, uSwellDir.y,
			halfLen, uSwellLen, rad, uSwellPitch,
			uSwellWaves, uSwellSweep, uSwellLift, uSwellLiftPhase, uSwellPhase,
			seaRel, uSwellAmp,
		) );

	} );
	If( uSwellBow.z.abs().greaterThan( 0.02 ), () => {

		h.addAssign( swellBowCore(
			xz.x, xz.y, uSwellBow.x, uSwellBow.y,
			uSwellBowDir.x, uSwellBowDir.y, uSwellBow.z, uSwellBow.w,
			uSwellBowSoft,
		) );

	} );
	If( uSwellDome.z.abs().greaterThan( 0.02 ), () => {

		h.addAssign( swellDomeCore(
			xz.x, xz.y, uSwellDome.x, uSwellDome.y,
			uSwellDomeDir.x, uSwellDomeDir.y, uSwellDome.z, uSwellDome.w, uSwellDomeW,
		) );

	} );
	return h;

} );

// Foam on a traveling crest. Birth at the cut (ringR ~ 0) stays water
// so the first heap is not a white disc; foam picks up as it runs.
const swellRippleFoam = /*@__PURE__*/ Fn( ( [ xz ] ) => {

	const f = float( 0.0 ).toVar();
	If( uSwellSiteCount.greaterThan( 0.5 ), () => {

		const acc = float( 0.0 ).toVar();
		for ( let i = 0; i < SWELL_SITES; i ++ ) {

			const s = uSwellSites.element( int( i ) );
			const pack = uSwellSitePack.element( int( i ) );
			const a = pack.x;
			If( a.abs().greaterThan( 0.0005 ).and( s.w.greaterThan( 0.05 ) ), () => {

				const traveling = select( s.z.greaterThan( float( 0.2 ) ), float( 1.0 ), float( 0.0 ) );
				const d = pack.zw;
				const st = pack.y;
				const arc = uSwellSiteArc.element( int( i ) );
				const h = swellSiteCore(
					xz.x, xz.y, s.x, s.y, s.z, s.w, a,
					d.x, d.y, st, arc.x, arc.y,
				);
				acc.addAssign( h.max( float( 0.0 ) ).mul( traveling ) );

			} );

		}
		const stacked = acc.div( float( 1.0 ).add( float( RIPPLE_STACK ).mul( acc ) ) );
		f.assign( stacked.mul( uSwellAmp.abs() ).mul( float( 0.18 ) ).min( float( 0.28 ) ) );

	} );
	If( uSwellBow.z.abs().greaterThan( 0.02 ), () => {

		const bowH = swellBowCore(
			xz.x, xz.y, uSwellBow.x, uSwellBow.y,
			uSwellBowDir.x, uSwellBowDir.y, uSwellBow.z,
			uSwellBow.w.mul( float( BOW_FOAM_SCALE ) ),
			uSwellBowSoft,
		);
		f.addAssign( bowH.max( float( 0.0 ) ).mul( float( 0.10 ) ).min( float( 0.28 ) ) );

	} );
	return f;

} );

// ---- the refraction pass ----------------------------------------------------
//
// What the sea is looking down INTO. A caller renders everything submerged into
// a colour target and a matching depth target (./refraction-driver.js) and hands
// both over here; the fragment stage looks them up in screen space, offset by
// the surface's own slope, and folds the result into the water-leaving radiance.
//
// Ported from `claude/saltyfin-webgpu`, saltyfin/src/water/waterMaterial.js.
// That build keeps its sea opaque and depth-writing exactly as this one does -
// so opacity was never the difference between "you can see a mesh under the
// water" and "you cannot". THIS is the difference: a screen-space colour lookup
// with a DEPTH lookup beside it, because without the depth there is no water
// column, and without a water column there is no extinction, no sense of how far
// down the thing is, and nothing to reject a sample that is actually in front of
// the surface.
//
// uRefractAmount 0 - the default, and what every caller with nothing submerged
// gets - skips the whole block, so the sea is bit-for-bit what it was and the
// golden images do not move.
export const uRefractAmount = /*@__PURE__*/ uniform( 0.0 );
// How hard the surface slope bends the look-through. Rocks/coral use it as a
// screen-space UV bend; the virtual bed (sand + caustics) uses the same knob
// as a world-XZ slide. `params.sdRefract`.
export const uRefractDistort = /*@__PURE__*/ uniform( 0.045 );
// Metres of water along the camera ray that swallow the shape (mean sea to
// the body, not depth-below-surface). The COLOUR of the swallowing is the
// sea's own uAbsorption (red first, which is what makes water blue-green); this
// is only its scale, so a preset's water stays its own colour while the artist
// still has one honest knob in metres.
export const uRefractFade = /*@__PURE__*/ uniform( 11.0 );
// The fudge, and labelled as one. Composited only into the diffuse term the
// animal is physically right and practically invisible: at the angle you ride
// at, Fresnel is around 0.7 and the sea's own mirror eats it. This mixes a
// fraction of the shape into the sea's colour ABOVE the diffuse and BELOW the
// foam, so it reads through the glare while whitecaps and the hull's wake still
// pass over the top of it - which is the half that stops it looking pasted on.
// 0 is the pure physics.
export const uRefractThrough = /*@__PURE__*/ uniform( 0.38 );

// PLACEHOLDERS WITH THE REAL RESOURCES' FILTER STATE (porting rule 11). On WGSL
// the sampling instruction is chosen when the graph is BUILT, from whatever is
// bound at that moment: a DataTexture defaulting to NearestFilter standing in
// for a linearly-filtered half-float target bakes a texel fetch into the shader
// and keeps it forever after, and the refraction comes back blocky on WebGPU and
// smooth on WebGL2 with nothing raising a word.
const refractionTexture = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = new THREE.DataTexture( new Uint8Array( [ 0, 0, 0, 0 ] ), 1, 1 );
	t.minFilter = THREE.LinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
	t.needsUpdate = true;
	return t;

} )() );

// Cleared to the far plane, so an unbound or empty pass reconstructs a column
// that is kilometres long and the composite falls through to the plain sea.
const refractionDepthTexture = /*@__PURE__*/ texture( /*@__PURE__*/ ( () => {

	const t = new THREE.DepthTexture( 1, 1, THREE.FloatType );
	t.minFilter = THREE.NearestFilter;
	t.magFilter = THREE.NearestFilter;
	t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
	t.needsUpdate = true;
	return t;

} )() );

/**
 * Point the sea at the refraction pass's two targets.
 *
 * Both must be the same KIND of resource the graph was built against (porting
 * rule 11) - a linear, non-mipped, clamped RGBA half-float and a nearest,
 * clamped float depth - which is what ./refraction-driver.js allocates.
 *
 * @param {{color: THREE.Texture, depth: THREE.DepthTexture}} t
 */
export function setRefractionTextures( { color, depth } = {} ) {

	if ( color ) refractionTexture.value = color;
	if ( depth ) refractionDepthTexture.value = depth;

}

// A REAL SHADOW, IF THE CALLER HAS ONE TO GIVE.
//
// The water cannot use receiveShadow: three applies shadows inside
// setupLighting(), which only runs for a material with no fragmentNode
// (three.webgpu.js:21294), and this whole shader IS a fragmentNode. So the
// caller builds the shadow itself - `shadow( light )` from three/tsl, which
// returns 1 in the light and 0 in shadow - and hands the node over here, where
// the direct-sun term multiplies by it.
//
// MUST BE CALLED BEFORE THE MATERIAL IS BUILT. The graph is built once and this
// decides which branch goes into it; handing a node over afterwards changes
// nothing, the same way a texture swapped after build cannot change the sampling
// instruction (porting rule 11). Left unset, the water keeps the analytic proxy
// the GLSL reference uses, so nothing that does not ask for this changes.
let craftShadowNode = null;
export function setCraftShadowNode( node ) {

	craftShadowNode = node ?? null;

}

export const uSkyAmbient = /*@__PURE__*/ uniform( 1.0 );
export const uHorizonBend = /*@__PURE__*/ uniform( 0.85 );
export const uInterReflect = /*@__PURE__*/ uniform( 0.6 );
export const uWaveAO = /*@__PURE__*/ uniform( 1.0 );

// Passed as the `eta` argument to fresnelDielectric/envFresnel. ./water-brdf.js
// deliberately has no copy: every function there takes the index of refraction
// as a parameter, exactly as the GLSL does, and all the call sites are here.
export const uWaterIOR = /*@__PURE__*/ uniform( 1.333 );

export const uAerial = /*@__PURE__*/ uniform( 1.0 );

// Virtual bed the surface looks down onto. 0 = deep ocean, no bed.
export const uFloorDepth = /*@__PURE__*/ uniform( 0.0 );
export const uFloorDepthMin = /*@__PURE__*/ uniform( 0.0 );
export const uFloorDepthMax = /*@__PURE__*/ uniform( 0.0 );
export const uFloorTerrainScale = /*@__PURE__*/ uniform( 36.0 );
export const uFloorCaustic = /*@__PURE__*/ uniform( 1.0 );
export const uFloorCausticSize = /*@__PURE__*/ uniform( 1.0 );
export const uShoreFoamAmount = /*@__PURE__*/ uniform( 0.0 );
export const uShoreFoamRange = /*@__PURE__*/ uniform( 3.0 );

// Twin of floorDepthAt() in src/seafloor.js. 1 on the heightfield is
// a sandbar (shallow). Layouted scalars only (rule 18).
const floorTerrainCore = /*@__PURE__*/ Fn( ( [ px, pz, lo, hi, scale ] ) => {

	const s = scale.max( 4.0 );
	const u = px.div( s );
	const v = pz.div( s );
	const bars = u.mul( 1.7 ).add( v.mul( 0.9 ).sin().mul( 0.65 ) ).sin();
	const channels = v.mul( 1.15 ).sub( u.mul( 0.55 ).sin().mul( 0.8 ) ).sin();
	const dunes = u.mul( 2.4 ).sub( v.mul( 1.3 ) ).add( u.mul( 0.7 ).sin().mul( 0.45 ) ).sin();
	const w = clamp(
		bars.mul( 0.48 ).add( channels.mul( 0.34 ) ).add( dunes.mul( 0.18 ) )
			.mul( 0.5 ).add( 0.5 ),
		0.0, 1.0,
	);
	return select( hi.sub( lo ).greaterThan( 0.05 ), mix( hi, lo, w ), hi );

} );

floorTerrainCore.setLayout( {
	name: 'abyssal_floorTerrainCore',
	type: 'float',
	inputs: [
		{ name: 'px', type: 'float' },
		{ name: 'pz', type: 'float' },
		{ name: 'lo', type: 'float' },
		{ name: 'hi', type: 'float' },
		{ name: 'scale', type: 'float' },
	],
} );

// Vector defaults, spelled out because uniform('vecN') starts at zero.
uGridCenter.value.set( 0.0, 0.0 );
uHullPos.value.set( 0.0, - 1e4, 0.0 );          // NO_HULL, src/water.js:19
uHullFwd.value.set( 0.0, 1.0 );                 // NO_HULL
uScatterColor.value.set( 0.048, 0.285, 0.360 );
uAbsorption.value.set( 0.42, 0.075, 0.045 );
uFoamColor.value.set( 0.96, 0.975, 0.995 );

// ---- the vertex stage -------------------------------------------------------

// WATER_VS:58-127, minus gl_Position (see note 5).
//
//   void main(){
//     float r = uRMin * pow(uRMax/uRMin, aRT.x);
//     float a = aRT.y * 6.28318530718;
//     vec2 xz = uGridCenter + vec2(cos(a), sin(a)) * r;
//
//     vec3 pos = vec3(xz.x, uSeaLevel, xz.y);
//     vFlat = pos;
//     ... cascade loop ...
//     vSwellH = swellH;
//     pos += disp;
//     ... hull ...
//     ... wake ...
//     pos.y -= uEarthCurve * (r*r) / (2.0 * R_EARTH);
//     vWorld = pos; vDist = r; vHeight = disp.y; vRelief = relief;
//     gl_Position = uViewProj * vec4(pos, 1.0);
//   }
//
// Takes NO arguments and returns the WORLD-SPACE position:
//
//   material.positionNode = waterPosition();
//
// Assigning all six varyings is a side effect, which is exactly what the GLSL
// does too. The grid is a radial fan: aRT.x is the radial parameter 0..1 mapped
// through an exponential so the rings crowd near the eye, aRT.y the angle.
export const waterPosition = /*@__PURE__*/ Fn( () => {

	// layout(location=0) in vec2 aRT - x: radial parameter 0..1, y: angle 0..1.
	// The driver builds this attribute in src/water.js buildGrid().
	const aRT = attribute( 'aRT', 'vec2' );

	// Exponential ring spacing: constant angular size per ring, so the triangles
	// stay roughly screen-uniform from 0.35 m to 42 km.
	const r = uRMin.mul( uRMax.div( uRMin ).pow( aRT.x ) ).toVar();
	// TAU_A is 6.28318530718 - the same digits the GLSL spells inline.
	const a = aRT.y.mul( TAU_A ).toVar();
	const xz = uGridCenter.add( vec2( a.cos(), a.sin() ).mul( r ) ).toVar();

	const pos = vec3( xz.x, uSeaLevel, xz.y ).toVar();

	// The UNDISPLACED point, before anything below moves it. Every field in both
	// stages is indexed by this - see the coordinate note in the header. `.assign`
	// emits a statement here and now, so the later mutations of `pos` do not
	// reach vFlat, exactly as the GLSL's copy-on-assign does.
	vFlat.assign( pos );

	// The cascade accumulation loop, unrolled in ./water-common.js. Indexed by
	// xz - the undisplaced grid point - because the simulation stores D(x), the
	// displacement OF the point x.
	const { disp, relief, swellH } = sampleCascadeDisp( xz, r );

	vSwellH.assign( swellH );
	pos.addAssign( disp );

	// A fluke print is a calmer disc, not a ripple. Killing capillaries
	// alone vanished under the FFT swell; flatten the cascade inside the
	// footprint so the circle actually reads.
	const flukeV = flukeSlickAccum( xz.x, xz.y );
	If( flukeV.greaterThan( 0.02 ), () => {

		const k = flukeV.mul( float( FLUKE_FFT_KILL ) );
		pos.subAssign( vec3( disp.x.mul( k ), disp.y.mul( k ), disp.z.mul( k ) ) );

	} );

	// ---- a body under the surface lifts it (or, amp < 0, presses a hollow) ---
	If( swellFieldLive(), () => {

		pos.y.addAssign( swellLift( xz ) );

	} );

	// Collar / heap / hollow only. The well is a per-pixel look-through
	// in the fragment (pierceCutAt) — snapping vertices several metres
	// made shark-fin triangles from the side.
	If( uPierceOn.greaterThan( 0.5 ), () => {

		pos.y.addAssign( pierceFieldAt( xz ) );

	} );

	// Height rides a varying; the fragment recovers world slope from
	// screen derivatives of that varying. Do not call splashHeightAt
	// from the fragment — that is the compile failure above.
	vSplashH.assign( 0.0 );
	If( uSplashEnergy.greaterThan( 0.0005 ), () => {

		const h = splashHeightAt( xz ).toVar();
		vSplashH.assign( h );
		pos.y.addAssign( h );

	} );

	// ---- hull ---------------------------------------------------------------
	// EDGES DESCENDING on press, 1.2 then -1.6, ON PURPOSE — see note 3.
	pos.y.addAssign( hullLift( xz ) );

	// ---- wake ---------------------------------------------------------------
	If( uWakeOn.greaterThan( 0.5 ), () => {

		// Far rings are coarse, so a wire ridge pops. A diverging wave
		// thickens with age, so those same triangles can carry height
		// farther aft — fade later than the old 0.16–0.42 cut, which
		// killed the V before it had room to open.
		const wf = float( 1.0 ).sub(
			smoothstep( uWakeExtent.mul( 0.18 ), uWakeExtent.mul( 0.88 ), r ),
		).toVar();

		// Undisplaced again: the fragment stage reads wakeAt(vFlat.xz), so this
		// must be wakeAt(xz) or the ridge's normal belongs to a different ridge
		// than its geometry.
		If( wf.greaterThan( 0.002 ), () => {

			pos.y.addAssign( wakeAt( xz ).y.mul( wf ) );

		} );

	} );

	// Analytic Kelvin V — a following mask. OceanBody vehicles leave this off.
	// Their wave height is the expanding rings below. Leftover stern foam is
	// the hull-sweep energy field, not the ring crests.
	If( uKelvinOn.greaterThan( 0.5 ), () => {

		const wf = float( 1.0 ).sub(
			smoothstep( uWakeExtent.mul( 0.18 ), uWakeExtent.mul( 0.88 ), r ),
		).toVar();
		If( wf.greaterThan( 0.002 ), () => {

			pos.y.addAssign( kelvinWakeAt( xz ).y.mul( wf ) );

		} );

	} );

	// Simple two-arm V behind a surface-running body. Soft ridges,
	// nothing ahead, fades with fetch. Stamps freeze when the body
	// dives and fade on their own life. Not the vehicle stamp field.
	If( uVWakeOn.greaterThan( 0.5 ), () => {

		pos.y.addAssign( vWakeAt( xz.x, xz.y ).x );

	} );

	// Expanding rings left at the stern. No camera-extent fade — a leftover
	// crest has to stay in the water so you can turn around and drive through it.
	If( uWakeWaveCount.greaterThan( 0.5 ), () => {

		pos.y.addAssign( wakeWaveAt( xz ) );

	} );

	// Physics contact is fragment-only close to the hull. Fade geometric
	// displacement in over a broad beam-scaled shoulder so coarse triangles
	// cannot draw a cut; the same wave heights still bend the normal below.
	const wakeGeometryKeep = float( 1.0 ).sub( wakePhysicsGeometryMaskAt( xz ) ).toVar();
	// Gravity-wave experiment: bound hull wave + Kelvin modes.
	If( uWakePhysOn.greaterThan( 0.5 ), () => {

		pos.y.addAssign( wakePhysicsAt( xz ).x.mul( wakeGeometryKeep ) );

	} );

	// Leftover gravity waves. The hull only displaced water; this
	// height already lives in world XZ and keeps travelling.
	If( uRippleOn.greaterThan( 0.001 ), () => {

		pos.y.addAssign( rippleAt( xz ).mul( uRippleVis ).mul( wakeGeometryKeep ) );

	} );

	// Planet curvature drops the far surface away, which is what actually puts
	// the horizon at the right place and hides the end of the grid.
	pos.y.subAssign( uEarthCurve.mul( r.mul( r ) ).div( 2.0 * R_EARTH ) );

	// Crossing the waterline used to punch through a full-height crest
	// (and the last-ring pin followed the eye down), which read as a
	// wave popping on. Above water this is a no-op — a ski at ~1.4 m
	// must keep the chop. Under it, displacement grows in over
	// UNDER_WAVE_FADE metres. Standalone mix (rule 1).
	const under = uSeaLevel.sub( uCamPos.y ).toVar();
	If( under.greaterThan( 0.0 ), () => {

		const amt = smoothstep( float( 0.0 ), float( UNDER_WAVE_FADE ), under );
		pos.y.assign( mix( uSeaLevel, pos.y, amt ) );

	} );

	// THE OUTERMOST RING IS PINNED JUST ABOVE THE SIGHTLINE TANGENT - the fix
	// for the dark dashed line along the horizon at elevated cameras. The full
	// account (and the coverage-gap proof) is in src/shaders/water.js at this
	// same spot; the two sources must stay identical. Blend by the uniform
	// so a wading fade is gradual; horizonPinAmount is already 0 underwater.
	If( aRT.x.greaterThan( 0.9999 ), () => {

		const hEye = uCamPos.y.sub( uSeaLevel ).max( 1.0 ).toVar();
		const dip = hEye.mul( 2.0 ).mul( uEarthCurve.max( 1e-3 ) ).div( R_EARTH ).sqrt().toVar();
		const pinned = uCamPos.y.sub( dip.sub( 2.5e-3 ).max( dip.mul( 0.1 ) ).mul( r ) );
		pos.y.assign( mix( pos.y, pinned, uHorizonPin ) );

	} );

	vWorld.assign( pos );
	vDist.assign( r );
	vHeight.assign( disp.y );
	vRelief.assign( relief );

	// WORLD space. Three's MVP finishes the job - see note 5.
	return pos;

} );

// ---- the fragment stage -----------------------------------------------------

// WATER_FS main(), src/shaders/water.js:341-788, minus the ABYSSAL_OUT wrapper.
// Returns the vec3 of linear HDR radiance:
//
//   material.fragmentNode = vec4( waterFragment(), 1.0 );
//
// The sections are in the GLSL's order, each headed by the line range it came
// from, so a diff against water.js reads straight down.
export const waterFragment = /*@__PURE__*/ Fn( () => {

	// ---- 1. view vector and pixel footprint (342-352) ------------------------
	const toEye = uCamPos.sub( vWorld ).toVar();
	const eyeDist = toEye.length().max( 1e-4 ).toVar();
	const V = toEye.div( eyeDist ).toVar();
	const dist = vDist.toVar();

	// World metres covered by this pixel on the sea plane. Everything that has to
	// stop being resolved - capillaries, foam streaks, glitter facets - is gated
	// on this rather than on distance, because a grazing pixel a hundred metres
	// out already covers more sea than a nadir pixel a kilometre out.
	//
	// fwidth of the UNDISPLACED coordinate: the footprint wanted is the one on
	// the reference plane the fields are indexed on, not on the deformed surface.
	const fpv = fwidth( vFlat.xz ).toVar();
	const foot = fpv.x.max( fpv.y ).max( 1e-5 ).toVar();

	// Shark-fin cut: occupancy opens the surface film so you look
	// into the ocean (refraction / darker column), not a painted
	// ribbon and not a vertex pit.
	const cut = pierceCutAt( vFlat.xz ).toVar();

	// ---- wind gusts: the cat's paws -----------------------------------------
	// The full account is in src/shaders/water.js at this same spot; the two
	// sources must stay identical. Short version: gusts arrive in patches tens
	// of metres across and roughen their own patch of water into a matte
	// cat's-paw while the lull beside it stays a mirror, and on sheltered water
	// that mottling IS the surface texture. Scales the short-wave energy - the
	// FFT slope of every cascade shorter than swell (the ripple a look-down
	// sees), the capillary layer here, and the slope variance below, which is
	// what carries the patches past the near field.
	//
	// GLSL gates this on `uGust > 0`. The TSL port ran the 3-octave fbm on
	// every sea pixel and then mixed with a zero-width range (gust is 0 in
	// every shipping preset except one). Same picture, a lot less heat.
	//
	// Evaluated BEFORE the cascade loop so short-band slope can ride the
	// same field. Swell stays even (cascadeGustWeight).
	const gust = float( 1.0 ).toVar();
	If( uGust.greaterThan( 0.0 ), () => {

		const gustQ = vFlat.xz.sub( uWindDir.mul( uTime.mul( uGustDrift ) ) )
			.div( uGustScale.max( 4.0 ) ).toVar();
		// Two scales: wind-streak slicks, then smaller cat's paws on top.
		const large = smoothstep( 0.32, 0.70, fbm2( gustQ, int( 3 ) ) ).toVar();
		const small = smoothstep(
			0.38, 0.76,
			fbm2( gustQ.mul( 3.1 ).add( vec2( 17.2, - 8.4 ) ), int( 2 ) ),
		).toVar();
		const gustN = mix( large, small, 0.34 ).toVar();
		// Standalone mix (rule 1).
		gust.assign( mix( float( 1.0 ).sub( uGust.mul( 0.85 ) ), float( 1.0 ).add( uGust.mul( 1.6 ) ), gustN ) );

	} );

	// ---- 2. surface normal + microfacet statistics from the cascades (354-376)
	// slope, msq, foamF and foamR are MUTATED below (the capillary layer and the
	// wake slick), which is why ./water-common.js hands them back as .toVar()s.
	// foamT is accumulated and never read - in the GLSL too (declared 359,
	// written 372, no reader). Kept for the 1:1 diff.
	const { slope, msq, lost, foamF, foamR } = sampleCascadeSurface( vFlat.xz, dist, gust );

	// ---- 3. sub-cascade capillary detail, near field only (378-390) ----------
	//
	//   float capFade = uCapillary > 0.0
	//     ? 1.0 / (1.0 + (dist*dist) / (900.0 * uCapillaryScale * uCapillaryScale))
	//     : 0.0;
	//
	// GLSL's ternary only evaluates the taken branch; TSL's select() evaluates
	// both and picks. That is safe here BECAUSE select picks a value rather than
	// multiplying by a mask: with uCapillaryScale = 0 the untaken branch is
	// inf (or NaN at dist = 0) and select discards it, where a mask multiply
	// would propagate the NaN. The taken branch is unchanged in every case.
	const capFade = select(
		uCapillary.greaterThan( 0.0 ),
		float( 1.0 ).div(
			float( 1.0 ).add(
				dist.mul( dist ).div( float( 900.0 ).mul( uCapillaryScale ).mul( uCapillaryScale ) ),
			),
		),
		float( 0.0 ),
	).toVar();

	// Crests a few centimetres apart cannot survive a pixel that spans tens of
	// them; point-sampling them anyway is pure aliasing.
	capFade.mulAssign( float( 1.0 ).sub( smoothstep( 0.06, 0.34, foot ) ) );

	// Fluke footprints: flatten chop, foam, and the FFT slope inside the
	// disc. CPU twin: flukeSlick() in src/fluke-slicks.js.
	const fluke = flukeSlickAccum( vFlat.x, vFlat.z ).toVar();
	capFade.mulAssign( float( 1.0 ).sub( fluke.mul( float( FLUKE_CAP_KILL ) ) ) );
	foamF.mulAssign( float( 1.0 ).sub( fluke.mul( float( FLUKE_FOAM_KILL ) ) ) );
	foamR.mulAssign( float( 1.0 ).sub( fluke.mul( float( FLUKE_FOAM_KILL ) ) ) );
	msq.mulAssign( float( 1.0 ).sub( fluke.mul( float( FLUKE_ROUGH_KILL ) ) ) );
	slope.mulAssign( float( 1.0 ).sub( fluke.mul( float( FLUKE_SLOPE_KILL ) ) ) );

	If( capFade.greaterThan( 0.01 ), () => {

		const amp = uCapillary.mul( 0.16 ).mul( capFade )
			.mul( clamp( uWindSpeed.div( 9.0 ), 0.15, 2.0 ) ).mul( gust ).toVar();
		// They pile up on the face turned into the wind. uWindDir is the UNIT
		// direction (./water-common.js note 1) - the magnitude is load-bearing
		// here, and feeding it cloud-field's wind velocity would multiply this
		// bias by the wind speed.
		amp.mulAssign( clamp( float( 0.45 ).add( slope.dot( uWindDir ).mul( 2.0 ) ), 0.0, 1.8 ) );
		slope.addAssign( capillarySlope( vFlat.xz, uTime, amp ) );

	} );

	// ---- 4. craft wake (392-433) --------------------------------------------
	// A Kelvin wedge is not a smear down the middle of the path: it is two cusp
	// arms leaving the hull at a fixed half-angle with churned, aerated water
	// between them, and once the hull has gone the arms keep travelling outward.
	// All of that lives in the world-space field wake.js maintains, so here it is
	// a fetch rather than a loop over the last few seconds of path.
	//
	// It has to be read BEFORE the normal is built: the wake deforms the surface
	// for real (the vertex shader displaced by the same field), and a ridge whose
	// shading normal does not know it is a ridge reads as a decal on flat water.
	const wake = float( 0.0 ).toVar();
	// Reconstructed Kelvin 3-stripe from the stamp record. Not the
	// filled energy ribbon — that one is uFoamRibbon.
	const wakeRecon = float( 0.0 ).toVar();

	If( uWakeOn.greaterThan( 0.5 ), () => {

		// Once a pixel is wider than the pattern there is nothing left to resolve
		// and point-sampling it is pure aliasing, exactly as for the foam sim.
		const k = float( 1.0 ).sub( smoothstep( 1.2, 6.0, foot ) ).toVar();
		// Look-down is several metres per pixel. The tight fade above
		// erased the rails exactly when you are trying to judge the
		// corridor. Keep a longer fade for the reconstructed 3-stripe.
		const reconK = float( 1.0 ).sub( smoothstep( 8.0, 28.0, foot ) ).toVar();

		If( reconK.greaterThan( 0.004 ), () => {

			const wk = wakeAt( vFlat.xz ).toVar();
			wakeRecon.assign( wk.x.mul( reconK ) );

			If( k.greaterThan( 0.004 ), () => {

				wake.assign( wk.x.mul( k ) );

				// A wake leaves a slick. Churned water has lost the short ripples and
				// the wind foam that were riding on it, and that smooth lane is most of
				// why a boat's path stays legible on a broken sea long after the white
				// water behind it has gone. Without it the wake is just more foam
				// among foam.
				const slick = clamp( wk.z.mul( k ).mul( uWakeSlick ), 0.0, 1.0 ).toVar();
				foamF.mulAssign( float( 1.0 ).sub( slick ) );
				foamR.mulAssign( float( 1.0 ).sub( slick ) );
				msq.mulAssign( float( 1.0 ).sub( slick.mul( 0.6 ) ) );

				// The ridge is real geometry - the vertex shader displaced by wk.y - so
				// it needs a normal that knows it is a ridge, or it reads as a decal
				// lying on flat water. Central differences at half a metre, which is
				// inside the arm width and wide enough not to be lost in the record's
				// own quantisation. Four extra fetches for the gradient, so only where
				// there is actually a wake to shade. Gating on the DISTURBANCE rather
				// than on the buffer bounds skips this for every water pixel that
				// merely happens to be inside the leftover tile, which is most of them.
				//
				// GLSL used to gate on wk.z (the slick BETWEEN the arms). The
				// arms themselves have almost no churn, so the ridge never got
				// a normal and read as foam stuck on flat water. Gate on the
				// height or the foam — that is the wave. A nested .and(.or())
				// here failed to compile and left a blank blue frame.
				// Only the lifted crest. Lighting every foam/slick texel
				// showed the wake buffer as a grid of lines.
				If( uWakeRelief.greaterThan( 0.0 ).and( wk.y.abs().greaterThan( 0.07 ) ), () => {

					// Step with the arm width, not a 1.2 m cliff. A ski-scale
					// mound is ~1 m across; the old max(depth*0.45, 1.2) sampled
					// past both faces and the ridge never got a normal.
					const e = uWakeArmW.mul( 0.40 ).max( 0.28 ).min( 0.9 ).toVar();
					const hx = wakeAt( vFlat.xz.add( vec2( e, 0.0 ) ) ).y
						.sub( wakeAt( vFlat.xz.sub( vec2( e, 0.0 ) ) ).y ).toVar();
					const hz = wakeAt( vFlat.xz.add( vec2( 0.0, e ) ) ).y
						.sub( wakeAt( vFlat.xz.sub( vec2( 0.0, e ) ) ).y ).toVar();

					slope.addAssign( vec2( hx, hz ).div( e.mul( 2.0 ) ).mul( uWakeRelief ).mul( k ) );

				} );

			} );

		} );

	} );

	// Leftover is the energy field. Mixing 22% of the stamp back in
	// printed the record window — a rectangle of lace around the hull,
	// obvious on a glassy look-down. Unbound energy still uses the stamp.
	// Twin of wakeFoamRibbonVary() / wakeFoamRibbonWarp() — fill, holes,
	// and a world-XZ wobble of the leftover *foam* sample. Amount 0 is
	// the old solid stencil. Leftover height stays on vFlat.xz.
	const ribbonK = clamp( uWakeFoamRibbonVary, 0.0, WAKE_FOAM_RIBBON_VARY_MAX ).toVar();
	const nFill = vnoise2( vFlat.xz.mul( 0.038 ) ).toVar();
	const nOpac = vnoise2( vFlat.xz.mul( 0.027 ).add( vec2( 13.7, - 8.2 ) ) ).toVar();
	const nFeat = vnoise2( vFlat.xz.mul( 0.021 ).add( vec2( 5.4, 19.1 ) ) ).toVar();
	const nHole = vnoise2( vFlat.xz.mul( 0.064 ).add( vec2( - 11.6, 4.8 ) ) ).toVar();
	const nStr = vnoise2( vFlat.xz.mul( 0.019 ).add( vec2( 2.3, - 15.6 ) ) ).toVar();
	const nAni = vnoise2( vFlat.xz.mul( 0.033 ).add( vec2( - 7.1, 9.4 ) ) ).toVar();
	const nPatch = vnoise2( vFlat.xz.mul( 0.028 ).add( vec2( 21.4, - 9.6 ) ) ).toVar();
	const nChew = vnoise2( vFlat.xz.mul( 0.09 ).add( vec2( - 4.2, 15.8 ) ) ).toVar();
	const nFine = vnoise2( vFlat.xz.mul( 0.21 ).add( vec2( 6.6, - 2.4 ) ) ).toVar();
	const nBreak = vnoise2( vFlat.xz.mul( 0.016 ).add( vec2( 3.3, 7.7 ) ) ).toVar();
	const nIsland = vnoise2( vFlat.xz.mul( 0.042 ).add( vec2( 17.2, - 6.4 ) ) ).toVar();
	const foamWarp = vec2(
		vnoise2( vFlat.xz.mul( 0.042 ) ).sub( 0.5 ).mul( WAKE_FOAM_RIBBON_WARP0 )
			.add( vnoise2( vFlat.xz.mul( 0.11 ) ).sub( 0.5 ).mul( WAKE_FOAM_RIBBON_WARP1 ) ),
		vnoise2( vFlat.xz.mul( 0.039 ).add( vec2( 8.7, - 3.1 ) ) ).sub( 0.5 ).mul( WAKE_FOAM_RIBBON_WARP0 )
			.add( vnoise2( vFlat.xz.mul( 0.10 ).add( vec2( - 6.4, 12.2 ) ) ).sub( 0.5 ).mul( WAKE_FOAM_RIBBON_WARP1 ) ),
	).mul( ribbonK ).toVar();
	const ribbonFill = mix( float( 1.0 ), mix( float( 0.18 ), float( 1.04 ), nFill ), ribbonK ).toVar();
	const ribbonOpac = mix( float( 1.0 ), mix( float( 0.28 ), float( 1.0 ), nOpac ), ribbonK ).toVar();
	const ribbonHole = mix(
		float( 1.0 ),
		mix( float( 0.04 ), float( 1.0 ), nHole.smoothstep( 0.10, 0.66 ) ),
		ribbonK,
	).toVar();
	{
		const energyK = float( 1.0 ).sub( smoothstep( 8.0, 28.0, foot ) ).toVar();
		If( energyK.greaterThan( 0.004 ), () => {

			If( uFoamEnergyOn.greaterThan( 0.5 ), () => {

				const energy = foamEnergyAt( vFlat.xz ).mul( energyK ).toVar();
				// Twin of foamEnergyCrestGate(). MULTIPLICATIVE — it only takes
				// white off water that is not cresting, so it can never draw a
				// V or punch a ring. That is why it has its own uniform now
				// instead of riding on the additive uRippleFoam paint.
				const crestGate = float( 1.0 ).toVar();
				If( uRippleOn.greaterThan( 0.001 ).and( uRippleCrestGate.greaterThan( 0.001 ) ), () => {

					const rh = rippleAt( vFlat.xz ).toVar();
					const vel = rippleVelAt( vFlat.xz ).abs().toVar();
					const ripples = vel.smoothstep( 0.03, 0.22 ).toVar();
					const live = max( rh.abs(), ripples.mul( 0.22 ) )
						.smoothstep( 0.012, 0.10 ).toVar();
					const crest = rh.smoothstep( - 0.08, 0.20 ).toVar();
					const peak = crest.mul( crest ).toVar();
					const wave = peak.add( ripples.mul( float( 1.0 ).sub( peak ) ).mul( 0.55 ) )
						.min( 1.0 ).toVar();
					const dense = energy.smoothstep( 0.22, 0.85 ).toVar();
					const troughFloor = float( 0.10 ).add( dense.mul( 0.16 ) ).toVar();
					const thinFade = energy.smoothstep( 0.025, 0.18 ).max( dense.mul( 0.80 ) ).toVar();
					const gated = troughFloor.add( wave.mul( float( 1.0 ).sub( troughFloor ) ) )
						.mul( thinFade ).toVar();
					// Scale by the knob so it fades in rather than snapping to
					// the full trough wipe the instant it is switched on.
					crestGate.assign( mix(
						float( 1.0 ), gated, live.mul( uRippleCrestGate.min( 1.0 ) ),
					) );

				} );
				// Tear the Kelvin / Mach silhouette — a clean iso-energy
				// contour (or a craft-spray cone rim) reads as a drawn V.
				const edgeN = hash22( vFlat.xz.mul( 0.078 ) ).x
					.mul( 0.42 )
					.add( hash22( vFlat.xz.mul( 0.17 ).add( vec2( 4.2, - 1.7 ) ) ).y.mul( 0.33 ) )
					.add( hash22( vFlat.xz.mul( 0.41 ).add( vec2( - 2.4, 5.1 ) ) ).x.mul( 0.25 ) )
					.mul( 2.0 ).sub( 1.0 )
					.mul( mix( float( 1.0 ), float( 1.55 ), ribbonK ) )
					.toVar();
				const edgeLo = float( WAKE_FOAM_ENERGY_LO ).add( edgeN.mul( mix( 0.11, 0.20, ribbonK ) ) ).toVar();
				const edgeHi = float( WAKE_FOAM_ENERGY_HI ).add( edgeN.mul( mix( 0.16, 0.24, ribbonK ) ) ).toVar();
				const ragged = energy.smoothstep( edgeLo, edgeHi ).toVar();
				const core = energy.smoothstep( 0.62, 1.15 ).toVar();
				// Twin of wakeFoamEnergyLook() — thin sailing-line film is
				// sea; only dense rails read as whitewater.
				const look = energy.smoothstep(
					float( WAKE_FOAM_ENERGY_LO ), float( WAKE_FOAM_ENERGY_HI ),
				).toVar();
				// `wake` may already hold the record's reconstructed wedge —
				// the part that opens with distance astern. Energy is the
				// hull's own near film. Take the brighter of the two; an
				// assign here erased the arms wherever the film reached.
				const film = look.mul( crestGate ).mul( mix( ragged, float( 1.0 ), core ) ).toVar();
				// The energy film is the foam you actually see. The 3-stripe
				// corridor lived only on the stamp-record shading path, so a
				// solid beam-wide ribbon hid every rail and every hole.
				If( uWakeOn.greaterThan( 0.5 ), () => {

					const rec = wakeAgeAt( vFlat.xz ).toVar();
					If( rec.x.greaterThanEqual( 0.0 ), () => {

						film.mulAssign( rec.y );

					} );

				} );
				wake.assign( max( wake, film ) );

			}, () => {

				wake.mulAssign( energyK );

			} );

		} );

	}

	// Analytic Kelvin V. Same `wake` accumulator the stamp field
	// composites through. Vehicles keep uKelvinOn off.
	If( uKelvinOn.greaterThan( 0.5 ), () => {

		const k = float( 1.0 ).sub( smoothstep( 1.2, 6.0, foot ) ).toVar();
		If( k.greaterThan( 0.004 ), () => {

			const wk = kelvinWakeAt( vFlat.xz ).toVar();
			wake.addAssign( wk.x.mul( k ) );
			const slick = clamp( wk.z.mul( k ).mul( uWakeSlick ), 0.0, 1.0 ).toVar();
			foamF.mulAssign( float( 1.0 ).sub( slick ) );
			foamR.mulAssign( float( 1.0 ).sub( slick ) );
			msq.mulAssign( float( 1.0 ).sub( slick.mul( 0.6 ) ) );
			If( uWakeRelief.greaterThan( 0.0 ), () => {

				const e = float( 0.45 );
				const h0 = wk.y;
				const hx = kelvinWakeAt( vFlat.xz.add( vec2( e, 0.0 ) ) ).y.sub( h0 ).div( e );
				const hz = kelvinWakeAt( vFlat.xz.add( vec2( 0.0, e ) ) ).y.sub( h0 ).div( e );
				slope.addAssign( vec2( hx, hz ).mul( uWakeRelief ).mul( k ) );

			} );

		} );

	} );

	If( uVWakeOn.greaterThan( 0.5 ), () => {

		const k = float( 1.0 ).sub( smoothstep( 1.2, 6.0, foot ) ).toVar();
		If( k.greaterThan( 0.004 ), () => {

			const vw = vWakeAt( vFlat.x, vFlat.z ).toVar();
			// Height stays on the arms. .y is the churned lane between
			// them. Breaking foam also sits on the steep ridges so a
			// top-down look still reads as a wake, not a glitter field.
			wake.addAssign( vw.y.mul( k ) );
			wake.addAssign( vw.x.abs().mul( k ).mul( 0.55 ).min( 1.0 ) );
			const vSlick = clamp( vw.y.mul( k ).mul( uWakeSlick ).mul( 0.7 ), 0.0, 1.0 ).toVar();
			foamF.mulAssign( float( 1.0 ).sub( vSlick ) );
			foamR.mulAssign( float( 1.0 ).sub( vSlick ) );
			msq.mulAssign( float( 1.0 ).sub( vSlick.mul( 0.45 ) ) );
			If( uWakeRelief.greaterThan( 0.0 ).and( vw.x.abs().greaterThan( 0.002 ) ), () => {

				const e = float( 0.45 );
				const h0 = vw.x;
				const hx = vWakeAt( vFlat.x.add( e ), vFlat.z ).x.sub( h0 ).div( e );
				const hz = vWakeAt( vFlat.x, vFlat.z.add( e ) ).x.sub( h0 ).div( e );
				slope.addAssign( vec2( hx, hz ).mul( uWakeRelief ).mul( k ) );

			} );

		} );

	} );

	// Lace UVs must not see ring slope — shear/strain on expanding crests
	// turned leftover film into topographic swirls (clearer with texture
	// lace off, when fd is the procedural field at those warped coords).
	const foamUvSlope = vec2( slope.x, slope.y ).toVar();

	// Rings stay as water: slope for lighting, never leftover foam.
	// Painting h+ onto `wake` printed expanding white circles that popped
	// a metre aft of the transom.
	If( uWakeWaveCount.greaterThan( 0.5 ).and( uWakeRelief.greaterThan( 0.0 ) ), () => {

		const k = float( 1.0 ).sub( smoothstep( 1.2, 6.0, foot ) ).toVar();
		If( k.greaterThan( 0.004 ), () => {

			const h0 = wakeWaveAt( vFlat.xz ).toVar();
			If( h0.abs().greaterThan( 0.002 ), () => {

				const e = float( 0.40 );
				const hx = wakeWaveAt( vFlat.xz.add( vec2( e, 0.0 ) ) ).sub( h0 ).div( e );
				const hz = wakeWaveAt( vFlat.xz.add( vec2( 0.0, e ) ) ).sub( h0 ).div( e );
				slope.addAssign( vec2( hx, hz ).mul( uWakeRelief ).mul( k ) );

			} );

		} );

	} );

	If( uWakePhysOn.greaterThan( 0.5 ), () => {

		const k = float( 1.0 ).sub( smoothstep( 2.4, 14.0, foot ) ).toVar();
		If( k.greaterThan( 0.004 ), () => {

			const wp = wakePhysicsAt( vFlat.xz ).toVar();
			wake.addAssign( wp.y.mul( k ) );
			If( uWakeRelief.greaterThan( 0.0 ).and( wp.x.abs().greaterThan( 0.01 ) ), () => {

				const e = float( 0.55 );
				const h0 = wp.x;
				const hx = wakePhysicsAt( vFlat.xz.add( vec2( e, 0.0 ) ) ).x.sub( h0 ).div( e );
				const hz = wakePhysicsAt( vFlat.xz.add( vec2( 0.0, e ) ) ).x.sub( h0 ).div( e );
				slope.addAssign( vec2( hx, hz ).mul( uWakeRelief ).mul( k ) );

			} );

		} );

	} );

	If( uRippleOn.greaterThan( 0.001 ), () => {

		const hRaw = rippleAt( vFlat.xz ).toVar();
		const contact = wakePhysicsContactAt( vFlat.xz ).toVar();
		If( hRaw.abs().greaterThan( 0.002 ).or( contact.greaterThan( 0.002 ) ), () => {

			const e = float( 0.55 );
			const sampleX = vFlat.xz.add( vec2( e, 0.0 ) ).toVar();
			const sampleZ = vFlat.xz.add( vec2( 0.0, e ) ).toVar();
			const hx = rippleAt( sampleX ).sub( hRaw ).div( e ).toVar();
			const hz = rippleAt( sampleZ ).sub( hRaw ).div( e ).toVar();
			const steep = vec2( hx, hz ).length();
			// Twin of leftoverChurn() — crest break + steep face.
			// Troughs stay water so leftover does not fill as a white disk.
			const churn = max( hRaw, 0.0 ).smoothstep( 0.008, 0.10 ).mul( 0.72 )
				.add( steep.smoothstep( 0.045, 0.26 ).mul( 0.40 ) )
				.min( 0.90 ).toVar();
			// Mean leftoverChurn() stays above. Ribbon vary then samples
			// leftover at a wobble (foam only) and chews the crest into
			// patches. Twin: wakeFoamRibbonWarp() / wakeFoamRibbonBreak().
			If( ribbonK.greaterThan( 0.001 ), () => {

				const hFoam = rippleAt( vFlat.xz.add( foamWarp ) ).toVar();
				// Peak-only: leftover crests are wide plateaus, so a 10 cm
				// threshold fills the whole Mach arm as a rectangle.
				const crestLo = mix( float( 0.05 ), float( 0.18 ), nFill ).toVar();
				const crestHi = mix( float( 0.18 ), float( 0.68 ), nFeat ).toVar();
				const weak = float( 1.0 ).sub( max( hFoam, 0.0 ).smoothstep( 0.03, 0.18 ) ).toVar();
				const dying = float( 1.0 ).sub( max( hFoam, 0.0 ).smoothstep( 0.012, 0.08 ) ).toVar();
				const chew = nChew.mul( 0.65 ).add( nFine.mul( 0.35 ) ).toVar();
				const islandK = mix(
					float( 1.0 ),
					nIsland.smoothstep( mix( 0.36, 0.18, weak ), 0.64 ),
					ribbonK,
				).toVar();
				const breakK = mix( float( 1.0 ), nBreak.smoothstep( 0.34, 0.62 ), ribbonK ).toVar();
				const chewK = mix( float( 1.0 ), chew.smoothstep( 0.08, 0.58 ), ribbonK ).toVar();
				const patchK = mix( float( 1.0 ), nPatch.smoothstep( 0.08, 0.62 ), ribbonK ).toVar();
				const frayK = mix( float( 1.0 ), chew.smoothstep( 0.22, 0.78 ), ribbonK.mul( dying ) ).toVar();
				// Height at the wobble only. Adding unwarped leftover
				// slope here redrew the Mach crest as a ruled rail.
				const churnVar = max( hFoam, 0.0 ).smoothstep( crestLo, crestHi ).mul( 0.90 )
					.mul( ribbonFill ).mul( ribbonHole )
					.mul( islandK ).mul( breakK ).mul( chewK ).mul( patchK ).mul( frayK )
					.min( 0.90 ).toVar();
				churn.assign( mix( churn, churnVar, ribbonK ) );

			} );
			If( uRippleFoam.greaterThan( 0.001 ), () => {

				// Leftover crest foam starts off the hull. On the mesh the
				// energy ribbon hugs the transom; leftover height from the
				// last heading would otherwise paint a detached white mass
				// beside the stern in a turn.
				const offHull = float( 1.0 ).sub(
					wakePhysicsGeometryMaskAt( vFlat.xz ).mul( 0.85 ),
				).toVar();
				// Ribbon vary keeps leftover foam under the clamp so
				// islands stay holes instead of saturating back to a ray.
				const foamGain = mix(
					uRippleFoam.min( 2.4 ),
					uRippleFoam.min( 0.78 ),
					ribbonK,
				).toVar();
				wake.addAssign( churn.mul( foamGain ).mul( offHull ) );

			} );
			If( uWakeRelief.greaterThan( 0.0 ), () => {

				const geometryKeep = float( 1.0 ).sub(
					wakePhysicsGeometryMaskAt( vFlat.xz ),
				).toVar();
				const waveNormalKeep = mix( 0.08, 1.0, geometryKeep ).toVar();
				slope.addAssign(
					vec2( hx, hz ).mul( uWakeRelief ).mul( uRippleVis )
						.mul( 1.55 ).mul( waveNormalKeep ),
				);
				// The source no longer opens the vertex mesh. Its footprint
				// survives here as bounded normal/refraction disturbance, so
				// water still bends and roughens around the hull without a
				// faceted geometric moat.
				const contactK = smoothstep( 0.015, 0.42, contact ).toVar();
				const q = vFlat.xz.mul( 4.6 ).add(
					vec2( uTime.mul( 2.1 ), uTime.mul( - 1.7 ) ),
				).toVar();
				const ruffle = vec2(
					q.x.add( q.y.mul( 0.47 ) ).sin(),
					q.y.sub( q.x.mul( 0.39 ) ).sin(),
				).mul( contactK ).mul( 0.018 ).toVar();
				slope.addAssign( ruffle );
				msq.addAssign( contactK.mul( 0.010 ) );

			} );

		} );

	} );

	// Same channels, same lace, same foamCoord stretch as whitecaps.
	foamF.addAssign( wake.mul( WAKE_FOAM_FRESH ) );
	foamR.addAssign( wake.mul( WAKE_FOAM_RESIDUE ) );

	If( uHullPush.greaterThan( 0.0005 ), () => {

		const h0 = hullLift( vFlat.xz ).toVar();
		If( h0.abs().greaterThan( 0.008 ), () => {

			const e = uHullRadius.mul( 0.18 ).max( 0.22 ).toVar();
			const hx = hullLift( vFlat.xz.add( vec2( e, 0.0 ) ) ).sub( h0 ).div( e );
			const hz = hullLift( vFlat.xz.add( vec2( 0.0, e ) ) ).sub( h0 ).div( e );
			slope.addAssign( vec2( hx, hz ) );

		} );

	} );

	// ---- 5. normal, filtered slope variance, Cox-Munk split (435-465) --------
	// The body's mound goes into the SLOPE as well as the height. Lifting the
	// surface is only half of it: a mound with the flat sea's normals painted
	// over it is invisible except in silhouette, and being able to SEE the water
	// bulge is the whole point. Finite-differenced on the analytic function
	// rather than dFdx over a moved vertex, which on a radial grid is a quad the
	// size of a bus in the far field.
	If( swellFieldLive(), () => {

		// Tight step so a 2–3 m ripple packet keeps its slope. uSwellRad
		// is the meniscus width; using a quarter of that washed the ring
		// into the same slope as the surrounding chop.
		const e = float( 0.22 );
		const h0 = swellLift( vFlat.xz ).toVar();
		// Far from the body the lift is 0 and so is the slope. The two
		// extra evals were 48 more empty-site cores on every sea pixel.
		If( h0.abs().greaterThan( 0.002 ), () => {

			const hx = swellLift( vFlat.xz.add( vec2( e, 0.0 ) ) ).sub( h0 ).div( e ).toVar();
			const hz = swellLift( vFlat.xz.add( vec2( 0.0, e ) ) ).sub( h0 ).div( e ).toVar();
			slope.addAssign( vec2( hx, hz ) );

		} );

	} );

	If( uPierceOn.greaterThan( 0.5 ), () => {

		const e = float( 0.18 );
		const h0 = pierceFieldAt( vFlat.xz ).toVar();
		If( h0.abs().greaterThan( 0.002 ), () => {

			const hx = pierceFieldAt( vFlat.xz.add( vec2( e, 0.0 ) ) ).sub( h0 ).div( e );
			const hz = pierceFieldAt( vFlat.xz.add( vec2( 0.0, e ) ) ).sub( h0 ).div( e );
			slope.addAssign( vec2( hx, hz ) );

		} );

	} );

	If( uSplashEnergy.greaterThan( 0.0005 ), () => {

		// ANALYTIC SLOPE, not screen derivatives of vSplashH.
		//
		// The derivative version cost nothing, and it looked it: a varying is
		// interpolated LINEARLY across a triangle, so its screen derivative is
		// constant over the whole triangle, and the radial grid's cells are
		// metres across out where a leap lands. Every cell came out a flat plate
		// wearing one normal, and the crater read as a heap of pale rectangular
		// slabs - the facets were the mesh, not the water.
		//
		// So the field is evaluated three times here (h, and one step in x and
		// z) and differenced in world space. That is smooth however coarse the
		// mesh is - only the silhouette is left to the tessellation. The step is
		// sub-metre so the crown's fingers survive it.
		//
		// The header's "do not call splashHeightAt from the fragment" was about
		// a shared Fn of both stages, which is what failed to compile; these are
		// JS builders that inline into whichever stage uses them, exactly like
		// splashFoamAt does below.
		const eS = 0.6;
		const h0 = splashHeightAt( vFlat.xz ).toVar();
		const hEx = splashHeightAt( vFlat.xz.add( vec2( eS, 0.0 ) ) ).toVar();
		const hEz = splashHeightAt( vFlat.xz.add( vec2( 0.0, eS ) ) ).toVar();
		slope.addAssign( vec2( hEx.sub( h0 ).div( eS ), hEz.sub( h0 ).div( eS ) ) );

	} );

	slope.mulAssign( float( 1.0 ).sub( cut.mul( 0.85 ) ) );
	const N = vec3( slope.x.negate(), 1.0, slope.y.negate() ).normalize().toVar();

	// Looking down, a roughness-only gust is a milky sheet — a cloud on
	// the water. Chase-cam mottling still uses gust. The nadir read is
	// the short-cascade slope (slicks flatten, paws chop).
	const lookDown = smoothstep( float( 0.50 ), float( 0.80 ), V.y ).toVar();
	const roughGust = mix( gust, float( 1.0 ), lookDown ).toVar();

	// GLSL: `float var = ...`. `var` is a JavaScript reserved word - note 2.
	const slopeVar = msq.sub( slope.dot( slope ) ).max( 0.0 ).add( lost ).mul( roughGust ).toVar();

	// The cascade mip chain filters each band over its own texels. It cannot know
	// about the pixel that straddles a crest, about the projection stretching that
	// pixel along the view ray at grazing, or about the procedural capillary layer
	// added above - and everything it misses reappears as sub-pixel highlights
	// with hard edges. The second moment of the slope across the pixel is exactly
	// that missing variance. Folding it into the lobe widens the NDF rather than
	// blurring the image, so the mean specular level is preserved while the
	// highlights stop aliasing. (Derivatives are per 2x2 quad, hence the quarter.)
	const dsx = dFdx( slope ).toVar();
	const dsy = dFdy( slope ).toVar();
	slopeVar.addAssign(
		float( 0.25 ).mul( uSpecAA.max( 0.0 ) ).mul( dsx.dot( dsx ).add( dsy.dot( dsy ) ) ),
	);

	// Cox-Munk: the sea's slope distribution is wider along the wind than across
	// it. Splitting the filtered variance on that ratio is what gives the glitter
	// path its elongated, wind-aligned shape instead of a round blob.
	const an = uWindAniso.max( 0.05 ).toVar();
	const vAl = slopeVar.mul( an ).div( float( 1.0 ).add( an ) ).toVar();
	const vCr = slopeVar.div( float( 1.0 ).add( an ) ).toVar();
	// Gust scales the unresolved micro-surface variance too - see the note in
	// src/shaders/water.js; on calm water this is the term that carries the
	// mottling at all.
	const b2 = uBaseRoughness.mul( uBaseRoughness ).mul( roughGust ).toVar();
	// alpha^2 = 2*sigma^2 is the Beckmann->GGX slope-variance identity. Capping it
	// matters: a real sea tops out near mss 0.09 even in a hurricane, so alpha can
	// never legitimately reach 1 and turn the distant water Lambertian-white.
	const aAl = clamp( b2.add( vAl.mul( 2.0 ).mul( uRoughnessGain ) ).sqrt(), 1e-3, uRoughnessMax ).toVar();
	const aCr = clamp( b2.add( vCr.mul( 2.0 ).mul( uRoughnessGain ) ).sqrt(), 1e-3, uRoughnessMax ).toVar();
	const alpha = aAl.mul( aCr ).sqrt().toVar();

	const wind3 = vec3( uWindDir.x, 0.0, uWindDir.y ).toVar();
	const T = wind3.sub( N.mul( N.dot( wind3 ) ) ).normalize().toVar();
	const B = N.cross( T ).toVar();

	// ---- 6. foam mask (467-528) ---------------------------------------------
	// foamField packs the GLSL's `out float thick` into .y - the same
	// translation ./sky-background.js's cirrusLayer used for its `out float dist`.
	// .x is the streak field; .y is optical thickness. Do not
	// overwrite .y with the old 25 cm / 6 cm vnoise — that is the sand look.
	// vFlat keeps the coverage on its water parcel. A partial horizontal
	// displacement makes neighbouring details separate/compress with the FFT
	// orbit. Wake-ring slope stays out of these UVs — it printed concentric
	// swirls in the leftover film. CPU twin: foamTextureCoord().
	const foamStrain = foamUvSlope.length().toVar();
	const foamCoord = vFlat.xz
		.add( vWorld.xz.sub( vFlat.xz ).mul( uFoamTextureCarry ) )
		.add( foamUvSlope.mul( foamStrain.mul( uFoamTextureStrain ).add( uFoamTextureShear ) ) ).toVar();
	const foamStretched = foamCoord.toVar();
	If( foamStrain.greaterThan( 0.02 ).and( uFoamLaceStretch.greaterThan( 0.0 ) ), () => {

		const B = uFoamLaceStretchBlock.max( 1.0 );
		const pivot = vFlat.xz.div( B ).floor().mul( B ).add( B.mul( 0.5 ) ).toVar();
		const r = foamCoord.sub( pivot ).toVar();
		const t = foamUvSlope.div( foamStrain.max( 1e-4 ) ).toVar();
		const k = foamStrain.mul( uFoamLaceStretch ).add( 1.0 ).toVar();
		const along = r.dot( t ).div( k ).toVar();
		const across = r.x.mul( t.y.negate() ).add( r.y.mul( t.x ) )
			.mul( float( 1.0 ).div( k ).sqrt() ).toVar();
		foamStretched.assign(
			pivot.add( t.mul( along ) ).add( vec2( t.y.negate(), t.x ).mul( across ) ),
		);

	} );
	const texK = clamp( uFoamTextureAmount, 0.0, 1.0 ).toVar();
	const fdv = vec2( 0.5, 0.5 ).toVar();
	// Texture lace 1 is the foam image. The procedural web is a look-down
	// fill-rate hog and is unused there — skip it.
	If( texK.lessThan( 0.995 ), () => {

		fdv.assign( foamField( foamStretched, uTime, foot, uFoamDetail ) );

	} );
	// The generated mask is histogram-balanced: thresholding it at 1-coverage
	// keeps the simulated areal fraction while replacing synthetic cell edges
	// with real bubble holes. Face stretch elongates cells; the breathe
	// rearranges holes. Twin: foamLaceStretchPoint() / foamLaceMorph().
	const laceScale = uFoamTextureScale.max( 1.0 ).toVar();
	const laceWarp = vec2(
		vnoise2( foamStretched.mul( 0.019 ) ),
		vnoise2( foamStretched.mul( 0.014 ).add( vec2( 23.7, 41.3 ) ) ),
	).sub( 0.5 ).mul( 0.22 ).toVar();
	If( uFoamLaceMorph.greaterThan( 0.0 ), () => {

		const morphT = uTime.mul( uFoamLaceMorphRate ).toVar();
		laceWarp.addAssign( vec2(
			vnoise( vec3( foamStretched.mul( 0.031 ), morphT ) ).sub( 0.5 ),
			vnoise( vec3( foamStretched.mul( 0.027 ).add( vec2( 19.1, 7.4 ) ), morphT.add( 1.7 ) ) ).sub( 0.5 ),
		).mul( uFoamLaceMorph.div( laceScale ) ) );
		laceWarp.addAssign( vec2(
			vnoise( vec3( foamStretched.mul( 0.013 ), morphT.mul( 0.45 ).add( 4.2 ) ) ).sub( 0.5 ),
			vnoise( vec3( foamStretched.mul( 0.011 ).add( vec2( 31.0, 13.0 ) ), morphT.mul( 0.45 ).add( 6.8 ) ) ).sub( 0.5 ),
		).mul( uFoamLaceMorph.mul( 0.65 ).div( laceScale ) ) );

	} );
	const laceUv = foamStretched
		.sub( uWindDir.mul( uTime ).mul( uFoamDrift.max( 0.0 ) ) )
		.div( laceScale ).add( laceWarp ).toVar();
	// Same two-tap detile as the wake pack below. This is the sample that
	// actually covers the wake sheet, so its repeat was the visible one.
	// The blend weight is a smoothstep, not raw noise, so most of the area
	// is wholly one tap or the other and the mask keeps its contrast.
	const laceUvB = vec2(
		laceUv.x.mul( 0.383 ).add( laceUv.y.mul( 0.924 ) ),
		laceUv.y.mul( 0.383 ).sub( laceUv.x.mul( 0.924 ) ),
	).mul( 1.531 ).add( vec2( 0.291, 0.733 ) ).toVar();
	const laceBlend = smoothstep(
		0.28, 0.72,
		vnoise2( vFlat.xz.mul( 0.0093 ).add( vec2( 17.4, - 31.8 ) ) ),
	).toVar();
	const lace = mix(
		foamLaceTexture.sample( laceUv ).r,
		foamLaceTexture.sample( laceUvB ).r,
		laceBlend,
	).toVar();
	// Once a pixel is wider than a clump there is nothing left to resolve and
	// both procedural and image detail must collapse onto the simulated mean.
	const clumpRes = float( 1.0 ).sub( smoothstep( 0.12, 2.2, foot ) ).toVar();
	// Texture lace is the foam image. Do not mix the procedural web back
	// in at distance — that was swirly lines under the image. Far field
	// collapses to the mean.
	const fdNear = mix( fdv.x, lace, texK ).toVar();
	const fd = mix( float( 0.5 ), fdNear, clumpRes ).toVar();
	const bubbles = mix( fdv.y, lace, texK ).toVar();

	// Two optically different materials share this footprint and they must not be
	// shaded as one. Fresh crest foam is an optically thick bubble raft that hides
	// the water completely; the dissipated residue it decays into is a veil a few
	// bubbles deep that the sea shows straight through. In steady state the
	// residue covers several times the area of the breakers feeding it, so
	// treating the sim's *total* coverage as opaque whitewater is precisely what
	// turns a force 10 sea into a bucket of cream.
	//
	// These are areal fractions, so the noise only decides WHERE inside the
	// footprint each one lands; its shaping factor is centred on one and can never
	// inflate the coverage the sim computed.
	// Wind fold only. Leftover wake is composited as a film after the lace
	// resolve — putting a thin trail through this gate made it pulsate.
	const covF = clamp( foamF.sub( wake.mul( WAKE_FOAM_FRESH ) ).mul( uFoamAmount ), 0.0, 1.0 ).toVar();
	const covR = clamp( foamR.sub( wake.mul( WAKE_FOAM_RESIDUE ) ).mul( uFoamAmount ), 0.0, 1.0 ).toVar();
	// Harder Jacobian gate (src/foam-lace.js jacobianGate). A leak of fold
	// used to sprinkle the lace across calm water. Fold 0 is empty.
	const gateF = smoothstep( 0.02, 0.12, covF ).toVar();
	const gateR = smoothstep( 0.02, 0.12, covR ).toVar();
	// Past the resolvable range `clumpRes` above collapses contrast onto the
	// mean, or the far field turns into per-pixel confetti.
	// A film with brighter clumps, not a threshold that zeros cell interiors
	// (that was close-up grain / wireframe). foamSharp still widens the
	// range; the floor keeps covered water looking like foam.
	const sharpK = uFoamSharp.max( 0.05 ).min( 2.4 ).sub( 0.05 ).div( 2.35 ).toVar();
	const shape = mix(
		mix( float( 0.52 ), float( 0.16 ), sharpK ),
		mix( float( 1.12 ), float( 1.48 ), sharpK ),
		smoothstep( 0.10, 0.82, fd ),
	).toVar();
	const shapeR = mix(
		mix( float( 0.48 ), float( 0.18 ), sharpK ),
		mix( float( 1.08 ), float( 1.36 ), sharpK ),
		smoothstep( 0.14, 0.86, fd ),
	).toVar();
	// Multiplying a blurry coverage by a detail field keeps the blur: the sim's
	// foam lives at 1.5 m per texel, so close up the raft was a magnified smudge
	// with texture painted over it. Resolving the coverage *against* the detail
	// field instead - foam wherever the field exceeds 1 - coverage - puts the edge
	// at the bubble scale where it belongs, and because the threshold moves with
	// the coverage the area it selects still tracks what the sim computed.
	// Only worth doing while a pixel is narrower than a clump; past that there is
	// nothing to resolve and the multiplicative mean is the honest answer.
	const crisp = clumpRes.mul( clamp( uFoamCrisp, 0.0, 1.0 ) ).mul( 0.90 ).toVar();
	const eF = 0.22, eR = 0.34;

	// Four standalone mixes in these two statements. Porting rule 1.
	// The crisp resolve is `fd > 1 - coverage`, with a soft edge of width e.
	// Centred on that threshold the edge still has a tail when coverage is 0
	// (smoothstep(1-e, 1+e, fd) lights the top of the noise field), which is
	// the white specks that survived Foam amount / Coverage at 0. Gate the
	// crisp branch by coverage so a zeroed slider is actually empty.
	const maskF = mix(
		clamp( covF.mul( mix( float( 1.0 ), shape, clumpRes ) ), 0.0, 1.0 ),
		smoothstep( float( 1.0 ).sub( covF ).sub( eF ), float( 1.0 ).sub( covF ).add( eF ), fd )
			.mul( smoothstep( 0.0, eF, covF ) ),
		crisp,
	).mul( gateF ).toVar();
	const maskR = mix(
		clamp( covR.mul( mix( float( 1.0 ), shapeR, clumpRes ) ), 0.0, 1.0 ),
		smoothstep( float( 1.0 ).sub( covR ).sub( eR ), float( 1.0 ).sub( covR ).add( eR ), fd )
			.mul( smoothstep( 0.0, eR, covR ) ),
		crisp,
	).mul( gateR ).toVar();
	const foamMask = clamp( maskF.add( maskR.mul( float( 1.0 ).sub( maskF ) ) ), 0.0, 1.0 ).toVar();

	// What fraction of the covered area is dense crest foam rather than raft. It
	// drives albedo, opacity and forward scattering below, so it is the single
	// number that separates whitewater from a blue-white film. Taken BEFORE the
	// distance term, which scales both channels equally - that order is the point.
	const fresh = clamp( maskF.div( foamMask.max( 1e-4 ) ), 0.0, 1.0 ).toVar();

	// Wake-only anti-tile. One RGB fetch carries coarse cells, fine lace,
	// and sparse breakup. A rotated irrational-scale frame keeps it from
	// sharing the wind-lace repeat. Energy doubles as age: dense at the
	// transom, cellular mid-trail, sparse as it fades.
	// Raw energy, before any grading. Only used to decide whether there is
	// anything here at all and to fetch the record.
	const wakeRaw = clamp( wake, 0.0, 1.0 ).toVar();
	// Real record age, not the coverage proxy. Foam that is thin because it
	// is OLD and foam that is thin because it has only just started used to
	// shade identically — that is why the trail read as one flat material.
	const wakeAgeN = float( 0.0 ).toVar();
	const wakeAgeOn = float( 0.0 ).toVar();
	// Across-track zone: prop wash, open water, thin arm crests. 1 = unshaped.
	const wakeZone = float( 1.0 ).toVar();
	const wakeLat = float( 0.0 ).toVar();
	const wakeVDist = float( 0.0 ).toVar();
	If( uWakeOn.greaterThan( 0.5 ), () => {

		const rec = wakeAgeAt( vFlat.xz ).toVar();
		// x < 0 is "no record". Treating a miss as a hit pinned path UVs
		// at (0,0) across the whole energy film.
		If( rec.x.greaterThanEqual( 0.0 ), () => {

			wakeAgeN.assign( rec.x );
			wakeZone.assign( rec.y );
			wakeLat.assign( rec.z );
			wakeVDist.assign( rec.w );
			wakeAgeOn.assign( 1.0 );

		} );

	} );
	// Twin of wakeFoamFreshness(). No record (energy-only film) falls back
	// to coverage, which is exactly the old behaviour.
	const wakeFresh = mix(
		wakeRaw, float( 1.0 ).sub( wakeAgeN ), wakeAgeOn,
	).toVar();
	// Twin of wakeFoamGrade(). The field saturates a second after the hull
	// passes, so compositing the clamp directly painted the whole trail at
	// one flat coverage — an even white sheet whose only visible variation
	// was the foam image repeating. Grade it: aerated wash at the transom,
	// a broken band with water showing through, then filaments.
	const wakeWash = wakeFresh.smoothstep( WAKE_FOAM_WASH, 0.97 ).toVar();
	const wakeBroken = wakeFresh.smoothstep( 0.04, WAKE_FOAM_WASH ).toVar();
	const wakeGrade = clamp(
		float( WAKE_FOAM_TAIL )
			.add( wakeBroken.mul( WAKE_FOAM_BROKEN ) )
			.add( wakeWash.mul( 1 - WAKE_FOAM_TAIL - WAKE_FOAM_BROKEN ) )
			.mul( wakeRaw.smoothstep( 0.0, 0.35 ) )
			.mul( wakeZone ),
		0.0, 1.0,
	).toVar();
	const wakeFilm = wakeGrade.mul( uFoamRibbon.max( 0.0 ) ).toVar();
	// The corridor is the record zone itself (center wash + two rails),
	// not a multiplier on the energy film. Ribbon 0, jet 0, spray 0
	// must still show those three lines.
	const wakeCorridor = wakeAgeOn
		.mul( wakeZone )
		.mul( float( 1.0 ).sub( wakeAgeN.smoothstep( 0.62, 1.0 ) ) )
		.mul( 0.92 ).toVar();
	const wakeSheet = clamp(
		max( wakeCorridor, wakeFilm ),
		0.0, 1.0,
	).toVar();
	const wakePattern = float( 1.0 ).toVar();
	If( wakeSheet.greaterThan( 0.003 ).and( texK.greaterThan( 0.001 ) ), () => {

		// Fallback world-space UV:
		const stretchU = mix( float( 1.0 ), mix( float( 0.48 ), float( 1.72 ), nStr ), ribbonK ).toVar();
		const stretchV = stretchU.mul(
			mix( float( 1.0 ), mix( float( 0.52 ), float( 1.62 ), nAni ), ribbonK ),
		).toVar();
		const detileWarp = vec2(
			vnoise2( vFlat.xz.mul( 0.0071 ) ).sub( 0.5 ),
			vnoise2( vFlat.xz.mul( 0.0071 ).add( vec2( 9.3, - 4.1 ) ) ).sub( 0.5 ),
		).mul( 0.90 ).toVar();
		const laceUvVar = vec2(
			laceUv.x.mul( stretchU ).add( nStr.sub( 0.5 ).mul( 0.55 ).mul( ribbonK ) ),
			laceUv.y.mul( stretchV ).add( nAni.sub( 0.5 ).mul( 0.42 ).mul( ribbonK ) ),
		).add( detileWarp ).toVar();
		const wakePackWorldUv = vec2(
			laceUvVar.x.mul( 0.754 ).sub( laceUvVar.y.mul( 0.657 ) ),
			laceUvVar.x.mul( 0.657 ).add( laceUvVar.y.mul( 0.754 ) ),
		).mul( 0.73 ).add( vec2( 0.173, 0.419 ) ).toVar();
		const wakePackWorldUvB = vec2(
			wakePackWorldUv.x.mul( 0.431 ).add( wakePackWorldUv.y.mul( 0.902 ) ),
			wakePackWorldUv.y.mul( 0.431 ).sub( wakePackWorldUv.x.mul( 0.902 ) ),
		).mul( 1.673 ).add( vec2( 0.617, 0.244 ) ).toVar();

		// Path-aligned curvilinear coordinates:
		// U across the track (lat), V along the sailing track (vDist).
		// Textures naturally flow, bend and stretch with every turn the boat made.
		const pathU = wakeLat.mul( 0.28 ).toVar();
		const pathV = wakeVDist.mul( 0.12 ).toVar();

		const pathUv1 = vec2(
			pathU.add( pathV.mul( 2.2 ).sin().mul( 0.06 ) ),
			pathV.add( nStr.sub( 0.5 ).mul( 0.35 ).mul( ribbonK ) ),
		).toVar();
		const pathUv2 = vec2(
			pathU.mul( 1.37 ).add( pathV.mul( 0.31 ) ).add( 0.43 ),
			pathV.mul( 1.63 ).sub( pathU.mul( 0.29 ) ).add( 0.19 ),
		).toVar();

		const packUvA = select( wakeAgeOn.greaterThan( 0.5 ), pathUv1, wakePackWorldUv );
		const packUvB = select( wakeAgeOn.greaterThan( 0.5 ), pathUv2, wakePackWorldUvB );

		const tileMix = smoothstep(
			0.26, 0.74,
			vnoise2( vFlat.xz.mul( 0.0135 ).add( vec2( - 23.7, 41.2 ) ) ),
		).toVar();
		const wakePack = mix(
			wakeFoamTexture.sample( packUvA ).rgb,
			wakeFoamTexture.sample( packUvB ).rgb,
			tileMix,
		).toVar();
		const wakeCells = clamp(
			max( wakePack.r.mul( 0.90 ), wakePack.g.mul( 0.72 ) ), 0.0, 1.0,
		).toVar();
		const wakeOld = clamp(
			wakePack.g.mul( wakePack.b.smoothstep( 0.15, 0.75 ) ).mul( 1.25 ).add( 0.04 ), 0.0, 1.0,
		).toVar();
		const wakeDense = clamp(
			max( wakePack.r, wakePack.g ).mul( 0.45 ).add( 0.65 ), 0.0, 1.0,
		).toVar();
		wakePattern.assign( mix(
			wakeOld, wakeCells, wakeFresh.smoothstep( 0.08, 0.34 ),
		) );
		wakePattern.assign( mix(
			wakePattern, wakeDense, wakeFresh.smoothstep( 0.52, 0.95 ),
		) );

	} );
	const sheetSoft = mix(
		wakeSheet,
		wakeSheet.smoothstep(
			mix( float( 0.004 ), float( 0.20 ), nFeat ),
			mix( float( 0.12 ), float( 0.70 ), nFeat ),
		),
		ribbonK,
	).toVar();
	const lookChew = nChew.mul( 0.65 ).add( nFine.mul( 0.35 ) ).toVar();
	const lookDying = float( 1.0 ).sub( wakeSheet.smoothstep( 0.012, 0.08 ) ).toVar();
	const lookBreak = mix( float( 1.0 ), nIsland.smoothstep( 0.36, 0.64 ), ribbonK )
		.mul( mix( float( 1.0 ), nBreak.smoothstep( 0.34, 0.62 ), ribbonK ) )
		.mul( mix( float( 1.0 ), lookChew.smoothstep( 0.08, 0.58 ), ribbonK ) )
		.mul( mix( float( 1.0 ), nPatch.smoothstep( 0.08, 0.62 ), ribbonK ) )
		.mul( mix( float( 1.0 ), lookChew.smoothstep( 0.22, 0.78 ), ribbonK.mul( lookDying ) ) )
		.toVar();
	// Opacity removers MULTIPLY. Stacking an age fade and a trough wipe on
	// top of fill/hole/opac/break drove the product to near zero except
	// where every term happened to align, which read as foam blinking
	// between solid white and nothing. Age changes the PATTERN, not the
	// opacity; the trough wipe is applied once, in crestGate.
	const ribbonVary = ribbonFill.mul( ribbonHole ).mul( ribbonOpac ).mul( lookBreak ).toVar();
	const wakeWrinkle = sheetSoft.mul(
		mix( float( 1.0 ), wakePattern, texK ),
	).mul( ribbonVary ).toVar();
	const wakeLook = wakeWrinkle;
	foamMask.assign( clamp( foamMask.add( wakeLook.mul( float( 1.0 ).sub( foamMask ) ) ), 0.0, 1.0 ) );
	// Bubble albedo tracks freshness too: new suds are bright and opaque,
	// an aged streak is a thin grey film that lets the water through.
	fresh.assign( mix(
		fresh,
		mix( float( 0.16 ), float( 0.86 ), wakeFresh.smoothstep( 0.06, 0.78 ) ),
		wakeLook,
	) );

	// At a kilometre you are looking at the side of a raft that lies in and just
	// behind the crests, and the crest in front hides most of it. That is a real
	// geometric loss on top of the areal averaging, and it is what stops the
	// grazing band just under the horizon painting itself solid.
	foamMask.mulAssign(
		float( 1.0 ).sub( clamp( uFoamFar, 0.0, 1.0 ).mul( smoothstep( 0.5, 9.0, foot ) ) ),
	);

	// Terrain-aware shore break. The bed height decides WHERE a wave can shoal;
	// the FFT crest decides WHEN it is actively washing that contour. The image
	// mask only resolves the resulting areal fraction into lace. It cannot paint
	// foam in deep water and Foam amount remains the global off switch.
	If( uShoreFoamAmount.greaterThan( 0.001 )
		.and( uFloorDepth.max( uFloorDepthMax ).greaterThan( 0.1 ) ), () => {

		const rawLo = select(
			uFloorDepthMin.greaterThan( 0.1 ),
			uFloorDepthMin,
			uFloorDepth.max( uFloorDepthMax ),
		).toVar();
		const rawHi = select(
			uFloorDepthMax.greaterThan( 0.1 ),
			uFloorDepthMax,
			uFloorDepth.max( uFloorDepthMin ),
		).toVar();
		const lo = rawLo.min( rawHi ).toVar();
		const hi = rawLo.max( rawHi ).toVar();
		const bedDepth = floorTerrainCore(
			vFlat.x, vFlat.z, lo, hi, uFloorTerrainScale,
		).toVar();
		const column = bedDepth.add( vWorld.y.sub( uSeaLevel ) ).max( 0.02 ).toVar();
		const breakDepth = uShoreFoamRange.max( 0.25 ).toVar();
		const breakWidth = breakDepth.mul( 0.16 ).max( 0.35 ).toVar();
		const breakOffset = column.sub( breakDepth ).div( breakWidth ).toVar();
		// A contour, not a shallow-water fill. Filling every depth below a
		// threshold covered the whole lagoon with a static lace blanket from
		// above; a breaker occupies a narrow depth band and then runs onward.
		const shallow = breakOffset.mul( breakOffset ).negate().exp().toVar();
		const crest = smoothstep( - 0.12, 0.38, vRelief ).toVar();
		// Foam amount is the global off/ramp, not a second tiny multiplier.
		// Lagoon whitecap gain is intentionally low (0.12); multiplying by it
		// directly made a full-strength shore control visually disappear.
		const foamMaster = smoothstep( 0.0, 0.12, uFoamAmount ).toVar();
		const shoreCov = clamp(
			shallow
				.mul( mix( float( 0.12 ), float( 1.0 ), crest ) )
				.mul( uShoreFoamAmount )
				.mul( foamMaster ),
			0.0, 0.72,
		).toVar();
		const shoreLace = smoothstep(
			float( 1.0 ).sub( shoreCov ).sub( 0.13 ),
			float( 1.0 ).sub( shoreCov ).add( 0.13 ),
			lace,
		).mul( smoothstep( 0.0, 0.13, shoreCov ) ).toVar();
		const shoreMask = mix( shoreCov, shoreLace, clumpRes ).toVar();

		bubbles.assign( bubbles.max( shoreMask.mul( 0.58 ) ) );
		fresh.assign( mix( fresh, float( 0.62 ), shoreMask ) );
		foamMask.assign( foamMask.add(
			shoreMask.mul( float( 1.0 ).sub( foamMask ) ),
		) );

	} );

	// Wake foam is not wind foam, and running it through the machinery above is
	// what made forty metres of churned water indistinguishable from the sea it
	// was churned out of: the clump noise that breaks whitecaps into a field of
	// separate caps is exactly the wrong shaping for a coherent band with an edge.
	// So it composites over the top, only lightly textured, and it is fresh - a
	// hull aerates water far more thoroughly than a collapsing crest does.
	If( swellFieldLive(), () => {

		const rf = swellRippleFoam( vFlat.xz ).mul( uFoamAmount )
			.mul( mix( float( 0.72 ), float( 1.0 ), fd ) ).toVar();
		If( rf.greaterThan( 0.02 ), () => {

			// Bow foam wants the same brilliant aeration as a hull wake
			// (0.9), not the duller 0.58 crest raft — that is the Jaws
			// pile at the snout. Packet foam stays a bit quieter.
			const hot = mix( float( 0.58 ), float( 0.92 ),
				smoothstep( float( 0.12 ), float( 0.45 ), rf ) );
			fresh.assign( mix( fresh, hot, rf ) );
			foamMask.assign( foamMask.add( rf.mul( float( 1.0 ).sub( foamMask ) ) ) );

		} );

	} );

	// Foam the swimming body actually left in the water. Coverage centres
	// are world-space stamps. fd mottles the film; it never decides where
	// the trail is and it does not stencil a web into it.
	If( uWakeFoamCount.greaterThan( 0.5 ), () => {

		const trailCov = clamp(
			wakeFoamAccum( vFlat.x, vFlat.z ).mul( uFoamAmount ), 0.0, 1.0,
		).toVar();
		If( trailCov.greaterThan( 0.004 ), () => {

			const film = mix(
				float( 0.62 ), float( 0.92 ), smoothstep( 0.00, 1.00, fd ),
			).toVar();
			const trailMask = trailCov.mul( film ).mul( 0.90 ).toVar();
			const trailThick = trailCov.mul( mix(
				float( 0.28 ), float( 0.56 ), smoothstep( 0.00, 1.00, fd ),
			) ).toVar();
			bubbles.assign( bubbles.max( trailThick ) );
			const trailFresh = mix(
				float( 0.10 ), float( 0.42 ), smoothstep( 0.20, 0.78, trailCov ),
			).toVar();
			fresh.assign( mix( fresh, trailFresh, trailMask ) );
			foamMask.assign( foamMask.add( trailMask.mul( float( 1.0 ).sub( foamMask ) ) ) );

		} );

	} );

	// A water entry is not wind foam either, and it went in through the wind
	// path: the coverage landed here but the SHADING kept coming from the
	// whitecap clump noise (`bubbles`, at foamBreakScale metres), so a 40 m
	// crater came out crawling with metre-wide worms - the frame read as a sand
	// dune, which is exactly the failure the wake note above describes. The
	// coverage is kept and the clump texture is flattened out of it, below,
	// once section 7 has finished writing `bubbles`.
	// uFoamAmount gates it like every other foam path (see the breach veil's
	// note lower down - this block was the one that had missed the memo).
	const splashCov = float( 0.0 ).toVar();
	If( uSplashEnergy.greaterThan( 0.0005 ), () => {

		splashCov.assign( splashFoamAt( vFlat.xz ).mul( uFoamAmount ) );
		fresh.assign( mix( fresh, float( 0.86 ), splashCov ) );
		foamMask.assign( foamMask.add( splashCov.mul( float( 1.0 ).sub( foamMask ) ) ) );

	} );

	// Covered water is an emulsion. Optical thickness used to follow only
	// lace cores, so a filled mask still rendered as grit / wire.
	bubbles.assign( bubbles.max(
		mix( float( 0.16 ), float( 0.72 ), fresh )
			.mul( smoothstep( 0.01, 0.22, foamMask ) ),
	) );

	// Leftover waterline foam used to be its own UBO. That slot went to
	// persistent wake foam (12-buffer WebGPU cap). The demo never writes
	// it — uLeftoverFoamCount stays 0 and probes assert that.

	// ---- 7. foam normal (530-558) -------------------------------------------
	const Nfoam = N.toVar();

	If( foamMask.greaterThan( 0.003 ), () => {

		// Thickness stays foamField.y. The old 25 cm / 6 cm vnoise gradient is
		// what read as sand (and, on a 40 m splash, as worms). A matte foam
		// film follows the displaced wave; it does not wear its own bump map.
		//
		// ...except inside a water entry, where the water is churned through
		// rather than drained into a lace. A 40 m crater wearing the wind web
		// would remagnify the same worms the previous relief did. Saturating
		// EARLY is the point: a quarter of a unit of coverage is already
		// thoroughly aerated water. So in churn the thickness goes uniform
		// and the normal stays the wave's, not a lace-edge slope.
		const churn = smoothstep( 0.02, 0.12, splashCov ).toVar();
		bubbles.assign( mix( bubbles, float( 0.90 ), churn ) );

		// Wind foam still rides FFT ripples. Leftover is a film — wearing
		// wake-ring normals lit the expanding crests as white swirls.
		Nfoam.assign( mix(
			N, vec3( 0.0, 1.0, 0.0 ),
			foamMask.mul( mix( float( 0.03 ), float( 0.10 ), fresh ) )
				.add( wakeLook.mul( 0.78 ) ),
		).normalize() );

	} );

	const NoV = clamp( N.dot( V ), 1e-4, 1.0 ).toVar();

	// ---- 8. lights (560-586) ------------------------------------------------
	// uSunColor in the GLSL IS uSunIrradiance here - note 6.
	const sunTr = sunTransmittance(
		vec3( 0.0, float( R_PLANET ).add( uCamPos.y.max( 1.0 ) ), 0.0 ), uSunDir,
	).toVar();
	const sunRad = uSunIrradiance.mul( sunTr ).mul( uAtmoExposure ).toVar();
	sunRad.mulAssign( smoothstep( - 0.09, 0.02, uSunDir.y ) );
	// Every direct-sun term below sees the shadowed irradiance; only the sky
	// ambient reaches into a swell's lee. Marched at the UNDISPLACED point,
	// against the unweighted swell height the vertex stage accumulated.
	sunRad.mulAssign( sunVisibility( vFlat.xz, vSwellH, dist ) );

	// THE CRAFT'S SHADOW, landing on sunRad so every direct-sun term dims together
	// while the sky ambient still reaches in - which is what a shadow on water
	// looks like, and the reason this is not a darkening of the final colour.
	//
	// WHAT CASTS IT depends on what the caller gave us. With a shadow node handed
	// in (setCraftShadowNode, and see the note there) this is three's own shadow
	// map: the hull's real silhouette, wings and floats and all. Without one it
	// falls back to the proxy sphere WATER_FS still uses - a soft round blob,
	// which is exactly what it was reported as.
	if ( craftShadowNode !== null ) {

		// GATED, and not only to honour the dial. A soft-filtered shadow lookup is
		// several texture fetches per pixel, and without this branch the whole
		// ocean would pay them on every frame of a session where nobody ever rode
		// anything. uCraftShadow is 0 whenever no hull is out (demo/three-main.js
		// sets it from the active vehicle), so the fetches only happen when there
		// is something to cast.
		If( uCraftShadow.greaterThan( 0.001 ), () => {

			// 1 in the light, 0 in shadow; uCraftShadow stays the strength dial.
			sunRad.mulAssign( mix( float( 1.0 ), craftShadowNode, uCraftShadow ) );

		} );

	} else {

		If( uCraftShadow.greaterThan( 0.001 ), () => {

			const toS = uCraftReflPos.sub( vWorld ).toVar();
			const along = toS.dot( uSunDir ).toVar();
			If( along.greaterThan( 0.0 ), () => {

				const perp = toS.sub( uSunDir.mul( along ) ).length().toVar();
				// The penumbra grows at the sun's own angular radius with the
				// distance the light travelled past the craft, so altitude softens
				// the shadow by itself and no second height fade is needed.
				const pen = uCraftReflSize.add( along.mul( uSunAngularRadius.max( 1e-4 ) ).mul( 2.0 ) ).toVar();
				const sh = float( 1.0 ).sub( smoothstep( uCraftReflSize.mul( 0.45 ), pen, perp ) ).toVar();
				sunRad.mulAssign( float( 1.0 ).sub( sh.mul( uCraftShadow ) ) );

			} );

		} );

	}

	const L = uSunDir;
	const NoL = N.dot( L ).max( 0.0 ).toVar();

	// The top of the LUT's mip chain is the average sky radiance; multiplying by
	// pi turns it into the diffuse irradiance arriving at the surface.
	//
	// The (0.5, 0.78) literal is PINNED to dirToSkyUv's sqrt-latitude curve (see
	// ./sky-lut.js's header): 0.78 is an elevation of about 18.3 degrees under
	// that curve and 34 or 50 degrees under any other. Do not "tidy" it into a
	// direction lookup - it would silently sample a different part of the sky.
	const skyAvg = skyLutTexture.sample( vec2( 0.5, 0.78 ) ).level( 9.0 ).rgb.toVar();
	const skyIrr = skyAvg.mul( PI_W ).mul( uSkyAmbient ).toVar();

	// Wave-scale occlusion: a trough between two short waves sees a fraction of
	// the sky a crest does. Driven by RELIEF, not absolute height, so a swell
	// crest is not permanently brighter than a swell trough.
	const rn = vRelief.div( vRelief.abs().add( 0.55 ) ).toVar();   // -1..1
	// Once crest and trough share a pixel their occlusion has already been
	// averaged into the mean radiance; keeping it would darken the far sea below
	// the sky it is mirroring, which is the other half of the horizon step.
	const aoRes = float( 1.0 ).sub( smoothstep( 1.5, 12.0, foot ) ).toVar();
	const ao = float( 1.0 ).sub(
		uWaveAO.mul( 0.42 ).mul( aoRes ).mul( float( 0.5 ).sub( float( 0.5 ).mul( rn ) ) ),
	).toVar();

	// ---- 9. environment reflection (588-622) --------------------------------
	const body0 = uScatterColor.mul( skyIrr ).mul( uScatterAmount.div( PI_W ) ).toVar();

	// TSL's reflect(I, N) is GLSL's, argument order verified (MathNode.REFLECT
	// emits reflect(I,N) on GLSL and WGSL's reflect(e1,e2), which is the same
	// I - 2*dot(N,I)*N).
	const R = reflect( V.negate(), N ).toVar();
	// How far the ray dives under. THE .toVar() IS LOAD-BEARING, not a habit:
	// `under` is read at the inter-reflection blend forty lines below, by which
	// point R has been folded and clamped. An expression without a var is inlined
	// at its USE site, so it would read the post-fold R.y - where R.y is >= 0 by
	// construction and `under` is therefore always 0, silently deleting the whole
	// inter-reflection term. The GLSL reads R.y here because that is where the
	// statement is; the var is what reproduces that.
	const under = clamp( R.y.negate().mul( 4.0 ), 0.0, 1.0 ).toVar();

	// A reflection ray that dives below the horizon has not left the sea, it has
	// hit the back of the next wave - so fold it back up and sample the sky that
	// face is itself reflecting. The old hard clamp to y=0 collapsed every
	// grazing fragment onto a single LUT row, which is precisely why the far
	// water rendered as one flat bar of the brightest horizon texel. Folding
	// keeps the slope-to-slope variation alive right up to the horizon line.
	// Standalone mix.
	R.assign( vec3( R.x, mix( R.y, R.y.abs(), uHorizonBend ), R.z ).normalize() );

	// The LUT is a full sphere, so a little below horizontal is real data, not a
	// clamp - it is the darker sky/sea limb a downward ray actually sees. How far
	// below is set by the slope spread: a mirror-calm dawn cannot see under its
	// own horizon at all, and letting it do so is what pulls the last kilometre of
	// water away from the sky it is supposed to be mirroring.
	R.y.assign( R.y.max( alpha.mul( - 0.35 ) ) );

	// At grazing incidence the GGX lobe smears along the horizon but stays narrow
	// across it. An isotropic mip blur cannot represent that, and blurring the
	// bright horizon band into the darker sky above it is exactly what made the
	// far sea read darker than the sky it mirrors. Narrowing the effective alpha
	// toward grazing is the cheap stand-in for the anisotropic lookup.
	// Standalone mix.
	const grazeNarrow = mix( clamp( uGrazeFocus, 0.02, 1.0 ), float( 1.0 ), NoV.sqrt() ).toVar();

	// ./water-brdf.js's TWO-argument sampleSky - note 7. It requires a unit rd,
	// because dirToSkyUv does not normalize (sky-lut.js note 1).
	const skyRefl = sampleSky( R.normalize(), alpha.mul( grazeNarrow ) ).toVar();

	// THE CRAFT IN THE WATER - WATER_FS carries the full note. R is already this
	// fragment's direction in the mirror, so if R points at the craft, the craft
	// is what it reflects; the wobble comes from the wave normal for free.
	// Standalone mix (porting rule 1).
	If( uCraftReflAmount.greaterThan( 0.001 ), () => {

		const toC = uCraftReflPos.sub( vWorld ).toVar();
		const dC = toC.length().max( 1e-3 ).toVar();
		const cosA = R.normalize().dot( toC.div( dC ) ).toVar();
		const angR = atan( uCraftReflSize.div( dC ) ).toVar();
		const blur = angR.mul( 0.35 ).add( alpha.mul( 0.9 ) ).toVar();
		const hit = float( 1.0 ).sub(
			smoothstep( angR.mul( 0.55 ), angR.add( blur ), acos( cosA.clamp( - 1.0, 1.0 ) ) ) ).toVar();
		// The craft's OWN radiance, not a tint on the sky behind it - WATER_FS
		// carries the note. Multiplying the sky by the hull's colour can only
		// darken it, which is why a pale aircraft over bright water read as a
		// 25% dimming: measurable, invisible, and reported as no reflection.
		const craftRad = uCraftReflTint
			.mul( skyIrr.add( sunRad.mul( uSunDir.y.max( 0.0 ) ).mul( 0.6 ) ) )
			.div( PI_W ).toVar();
		skyRefl.assign( mix( skyRefl, craftRad, hit.mul( uCraftReflAmount ) ) );

	} );

	// A ray that dove under the horizon really hit the next wave face. Feeding it
	// the neighbouring water's own radiance is the inter-reflection term, and it
	// is what gives troughs their deep colour instead of a flipped sky.
	// Standalone mix.
	skyRefl.assign( mix(
		skyRefl,
		body0.mul( 6.0 ).add( skyRefl.mul( 0.25 ) ),
		uInterReflect.mul( under ),
	) );

	// A trough does not only see less sky diffusely, it reflects less of it: part
	// of its reflection cone is blocked by the wave in front. At low sun the
	// reflection is nearly the whole image, so without this the sea flattens into
	// a uniform sheet no matter how much crest-to-trough relief there really is.
	// Standalone mix.
	skyRefl.mulAssign( mix( float( 1.0 ), ao, 0.8 ) );

	const Fenv = envFresnel( NoV, alpha, uWaterIOR ).toVar();

	// ---- 10. sun specular, disc light with an anisotropic lobe (624-663) -----
	const sR = uSunAngularRadius.max( 1e-4 ).toVar();
	// Widen the lobe by the sun's angular radius, then put the energy back: a
	// disc light is a convolution, and without the `energy` factor the whole
	// highlight simply gets dimmer as the disc gets bigger.
	const axS = clamp( aAl.add( sR.mul( 0.5 ) ), 1e-4, 1.0 ).toVar();
	const ayS = clamp( aCr.add( sR.mul( 0.5 ) ), 1e-4, 1.0 ).toVar();
	const energy = aAl.mul( aCr ).div( axS.mul( ayS ) ).toVar();

	const H = L.add( V ).normalize().toVar();
	const NoH = clamp( N.dot( H ), 0.0, 1.0 ).toVar();
	const VoH = clamp( V.dot( H ), 0.0, 1.0 ).toVar();
	const Dg = D_GGXAniso( NoH, T.dot( H ), B.dot( H ), axS, ayS ).toVar();
	// Argument order is (NoV, NoL, ToV, BoV, ToL, BoL, ax, ay) - VIEW terms
	// before LIGHT terms. Swapping the pairs is silent and wrong.
	const Vg = V_SmithAniso( NoV, NoL, T.dot( V ), B.dot( V ), T.dot( L ), B.dot( L ), axS, ayS ).toVar();
	// Fresnel on the direct highlight was missing before: without it the sea's sun
	// reflection is uniformly blown out instead of being faint underfoot and
	// blazing toward the horizon, which is the entire shape of a glitter path.
	const Fs = vec3( fresnelDielectric( VoH, uWaterIOR ) ).toVar();

	// A perfect mirror returns the sun's own radiance, E/(pi*sR^2). Nothing on a
	// water surface can be brighter than that, so it is the only defensible
	// ceiling.
	const mirrorCeil = float( 1.0 ).div( float( PI_W ).mul( sR ).mul( sR ) ).toVar();
	const raw = Dg.mul( Vg ).mul( energy ).toVar();

	If( uGlitter.greaterThan( 0.0 ), () => {

		// Break the lobe up wherever there is genuine sub-pixel slope variance. The
		// ramp is wide so the transition never prints its own boundary across the
		// water, which a tight gate on var demonstrably does.
		const amt = smoothstep( 0.0004, 0.018, slopeVar ).toVar();
		// SAMPLED AT THE DISPLACED SURFACE POINT, not the undisplaced grid: the
		// flashes have to live on the water and be carried by it, otherwise the
		// whole pattern slides across the waves it is supposed to belong to. This
		// is the one exception to the coordinate rule at the top of the file.
		// Standalone mix.
		raw.mulAssign( mix( float( 1.0 ), scintillation( vWorld.xz, foot ), amt ) );

	} );

	// min() gives every facet above the limit exactly the same radiance, which is
	// what printed a molten plateau with a geometric edge where a glitter path
	// should have statistical wings that fade over many degrees. A reciprocal knee
	// is strictly monotonic: it never flattens, it approaches the mirror ceiling
	// asymptotically, and it leaves post's bloom a gradient to shape instead of an
	// already-flat slab.
	const ceilv = uSpecClamp.min( mirrorCeil ).max( 1.0 ).toVar();
	const lobe = raw.div( float( 1.0 ).add( raw.div( ceilv ) ) ).toVar();
	const sunSpec = sunRad.mul( Fs ).mul( lobe ).mul( NoL ).mul( uSpecIntensity ).toVar();

	// ---- 11. moon specular (666-685) ----------------------------------------
	// Moon acts as a dim second sun so night presets keep a specular path.
	const moonSpec = vec3( 0.0 ).toVar();

	{

		const Hm = uMoonDir.add( V ).normalize().toVar();
		const NoHm = clamp( N.dot( Hm ), 0.0, 1.0 ).toVar();
		const NoLm = N.dot( uMoonDir ).max( 0.0 ).toVar();
		const Dm = D_GGXAniso( NoHm, T.dot( Hm ), B.dot( Hm ), axS, ayS ).toVar();
		const Vm = V_SmithAniso(
			NoV, NoLm, T.dot( V ), B.dot( V ), T.dot( uMoonDir ), B.dot( uMoonDir ), axS, ayS,
		).toVar();
		const Fm = vec3( fresnelDielectric( clamp( V.dot( Hm ), 0.0, 1.0 ), uWaterIOR ) ).toVar();
		const rawM = Dm.mul( Vm ).mul( energy ).toVar();

		If( uGlitter.greaterThan( 0.0 ), () => {

			const amtM = smoothstep( 0.0004, 0.018, slopeVar ).toVar();
			// Displaced point again, offset so the moon path does not flash in
			// lockstep with the sun's. Standalone mix.
			rawM.mulAssign( mix( float( 1.0 ), scintillation( vWorld.xz.add( 71.3 ), foot ), amtM ) );

		} );

		// uSpecIntensity applies here too. Without it the only way to strengthen a
		// moon path was to raise moonIntensity, which also feeds the atmosphere LUT
		// and so lifts the whole sky - you got a brighter night rather than a
		// brighter path, which is the opposite of what a moonlit scene wants.
		moonSpec.assign(
			uMoonColor.mul( Fm )
				.mul( rawM.div( float( 1.0 ).add( rawM.div( ceilv ) ) ) )
				.mul( NoLm )
				.mul( smoothstep( - 0.05, 0.1, uMoonDir.y ) )
				.mul( uSpecIntensity ),
		);

	}

	// ---- 12. subsurface / body colour (687-730) -----------------------------
	const Edown = sunRad.mul( uSunDir.y.max( 0.0 ) ).add( skyIrr ).toVar();

	// Water-leaving radiance is a small fraction of what goes in - a couple of
	// percent - which is exactly why the sea reads as a mirror at grazing angles.
	// The more steeply you look in, the deeper the column you are looking through,
	// so the near field is the saturated dark blue and the far field is not.
	// Standalone mix.
	const pathLen = mix( float( 0.8 ), float( 4.2 ), NoV ).toVar();
	const body = uScatterColor.mul( Edown ).mul( uScatterAmount.div( PI_W ) )
		.mul( uAbsorption.mul( pathLen ).negate().exp() ).mul( ao ).toVar();

	// Aerated water. Note this uses wakeRaw — the flat, saturated footprint of
	// the whole disturbed area. That field was never useless; it was being
	// asked to be foam coverage, which is why the trail came out as an even
	// white sheet. It is the right shape for the BUBBLE PLUME, which really
	// does cover the whole track at roughly full strength. The white on top
	// is the graded, zoned part.
	If( uWakePlume.greaterThan( 0.002 ).and( wakeRaw.greaterThan( 0.002 ) ), () => {

		const plume = clamp( wakeRaw.mul( uWakePlume ), 0.0, 1.0 ).toVar();
		const milky = uScatterColor.mul( Edown )
			.mul( uScatterAmount.mul( WAKE_PLUME_GAIN ).div( PI_W ) )
			.mul( uAbsorption.mul( pathLen.mul( WAKE_PLUME_PATH ) ).negate().exp() )
			.mul( ao ).toVar();
		body.assign( mix( body, milky, plume ) );

	} );

	// Light that entered the far side of a wave, scattered forward inside it and
	// left toward the eye. Only a thin, steep, backlit crest survives the trip,
	// which is exactly where a real sea glows green at golden hour.
	const steep = clamp( float( 1.0 ).sub( N.y ), 0.0, 1.0 ).toVar();
	// Only the upper half of a wave is thin enough to be lit through. The old
	// ramp kept a 0.45 pedestal everywhere, so troughs glowed as hard as crests
	// and the effect read as paint on the water rather than light inside it.
	const crest = smoothstep( float( - 0.20 ), float( 0.70 ), rn.mul( uSSSHeight.max( 0.01 ) ) ).toVar();
	// Light crossing the crest travels along -L inside the water and refracts on
	// the way out, which bends the exit ray *away* from the outward normal by
	// roughly (n-1) times its tilt. So the lobe is centred a little to the far
	// side of -L, and only on a face that is genuinely turned away from the sun -
	// scaling the bias by how backlit the face is keeps a front-lit swell from
	// picking up a glow it has no business having.
	const away = clamp( N.dot( L ).negate(), 0.0, 1.0 ).toVar();
	const Hs = L.add( N.mul( uSSSBias.max( 0.0 ) ).mul( away ) ).normalize().toVar();
	const back = clamp( V.dot( Hs.negate() ), 0.0, 1.0 ).pow( uSSSPower ).toVar();
	// Optical thickness of the face: a steep crest is thin, a flat back is not.
	// Standalone mix.
	const thick = mix( float( 2.2 ), float( 0.18 ), clamp( steep.mul( 4.0 ), 0.0, 1.0 ) )
		.mul( uSSSDepth.max( 0.01 ) ).toVar();
	const trans = uAbsorption.mul( thick ).mul( 3.0 ).negate().exp().toVar();
	// Only a face turned away from the sun can be lit through from behind at all,
	// and the glow has to arrive with the crest rather than switch on across a
	// whole flank, so the ramp is smooth in the same quantity the bias uses.
	const lit = smoothstep( 0.05, 0.45, away ).toVar();
	// The old gate wanted 1-N.y past 0.3 - a 17 degree face - before the glow even
	// started, which is steeper than most of a real wind sea ever gets, so the
	// effect was invisible everywhere except on the handful of breaking crests.
	// A wide ramp on purpose: a hard steepness gate cuts the glow off along a
	// contour of the wave and prints the shape of the threshold rather than the
	// shape of the crest.
	const sss = uScatterColor.mul( sunRad ).mul( trans ).mul( back ).mul( lit )
		.mul( uSSSStrength ).mul( crest )
		.mul( smoothstep( 0.02, 0.30, steep ) ).mul( 0.30 ).toVar();

	const diffuse = body.add( sss ).toVar();

	// Virtual seafloor. FFT `depth` is dispersion; this is a bed the
	// look-down ray can hit — sand, reef, FFT-slope caustics. Twin: src/seafloor.js.
	// Runs BEFORE mesh refraction so a hull still sits on the bed.
	If( uFloorDepth.max( uFloorDepthMax ).greaterThan( 0.1 ), () => {

		// Air → water. A straight -V is a dry photo of the bed; the
		// surface is the refraction. Twin: src/seafloor.js floorRefractHit
		// / floorRayHit. Lighting N + capillaries is LOD-0 grit —
		// the same mip as the caustic Jacobian.
		const sMip = sampleCascadeSlope( vFlat.xz, dist ).toVar();
		const Nfloor = vec3( sMip.x.negate(), 1.0, sMip.y.negate() ).normalize().toVar();
		const eta = float( 1.0 ).div( uWaterIOR.max( 1.01 ) ).toVar();
		const I = V.negate().toVar();
		const dI = Nfloor.dot( I ).toVar();
		const kI = float( 1.0 ).sub( eta.mul( eta ).mul( float( 1.0 ).sub( dI.mul( dI ) ) ) ).toVar();
		const RD = I.mul( eta ).sub( Nfloor.mul( eta.mul( dI ).add( kI.max( 0.0 ).sqrt() ) ) ).toVar();
		If( kI.lessThan( 0.0 ), () => {

			RD.assign( I );

		} );
		If( RD.y.greaterThan( - 0.02 ), () => {

			RD.assign( I );

		} );
		If( RD.y.lessThan( - 0.02 ), () => {

			const rawLo = select( uFloorDepthMin.greaterThan( 0.1 ), uFloorDepthMin, uFloorDepth.max( uFloorDepthMax ) );
			const rawHi = select( uFloorDepthMax.greaterThan( 0.1 ), uFloorDepthMax, uFloorDepth.max( uFloorDepthMin ) );
			const lo = rawLo.min( rawHi );
			const hi = rawLo.max( rawHi );
			const tHit = lo.add( hi ).mul( 0.5 ).div( RD.y.negate().max( 0.02 ) ).toVar();
			const hx = vWorld.x.toVar();
			const hz = vWorld.z.toVar();
			const localD = hi.toVar();
			for ( let i = 0; i < 3; i ++ ) {

				hx.assign( vWorld.x.add( RD.x.mul( tHit ) ) );
				hz.assign( vWorld.z.add( RD.z.mul( tHit ) ) );
				localD.assign( floorTerrainCore( hx, hz, lo, hi, uFloorTerrainScale ) );
				tHit.assign( vWorld.y.sub( uSeaLevel.sub( localD ) ).div( RD.y.negate().max( 0.02 ) ) );

			}
			If( tHit.greaterThan( 0.05 ).and( tHit.lessThan( 90.0 ) ), () => {

				hx.assign( vWorld.x.add( RD.x.mul( tHit ) ) );
				hz.assign( vWorld.z.add( RD.z.mul( tHit ) ) );
				localD.assign( floorTerrainCore( hx, hz, lo, hi, uFloorTerrainScale ) );
				// Same warp as the rocks: lighting slope × sdRefract,
				// not the mipped look-down N. Twin: floorLookSlide().
				const lookGate = clamp( localD.mul( 0.7 ), 0.0, 1.0 )
					.div( float( 1.0 ).add( dist.mul( 0.045 ) ) );
				const lookW = uRefractDistort.mul( lookGate ).mul( localD );
				hx.addAssign( slope.x.mul( lookW ) );
				hz.addAssign( slope.y.mul( lookW ) );
				localD.assign( floorTerrainCore( hx, hz, lo, hi, uFloorTerrainScale ) );
				const ru = hx.mul( 0.021 );
				const rv = hz.mul( 0.017 );
				const n = float( 0.5 ).add( float( 0.5 ).mul(
					ru.mul( 1.4 ).add( rv.mul( 0.8 ).sin().mul( 0.7 ) ).sin(),
				) );
				const n2 = float( 0.5 ).add( float( 0.5 ).mul(
					rv.mul( 1.1 ).sub( ru.mul( 0.6 ).sin().mul( 0.55 ) ).sin(),
				) );
				const reef = smoothstep( float( 0.48 ), float( 0.72 ), n )
					.mul( n2.mul( 0.6 ).add( 0.4 ) ).toVar();
				const bed = mix( vec3( 0.78, 0.68, 0.48 ), vec3( 0.16, 0.22, 0.18 ), reef ).toVar();
				// Focused sunlight on the sand: small broken
				// sheets at the sun-entry. Twin: seafloor.js floorLace.
				const sySun = uSunDir.y.max( 0.18 );
				const pSun = vec2(
					hx.add( uSunDir.x.div( sySun ).mul( localD ) ),
					hz.add( uSunDir.z.div( sySun ).mul( localD ) ),
				).toVar();
				const laceScale = uFloorCausticSize.max( 0.15 );
				const web = floorLaceCore( pSun.x.div( laceScale ), pSun.y.div( laceScale ), uTime ).toVar();
				const sunK = floorSunGainCore( slope.x, slope.y, uSunDir, localD ).toVar();
				const lace = web.mul( sunK )
					.mul( float( 1.0 ).sub( reef.mul( 0.45 ) ) )
					.mul( uFloorCaustic )
					.mul( localD.mul( FLOOR_LACE_DEPTH_K ).negate().exp() )
					.mul( smoothstep( float( FLOOR_LACE_FAR ), float( FLOOR_LACE_NEAR ), dist ) )
					.toVar();
				const mul = lace.mul( FLOOR_LACE_MUL ).add( 1.0 );
				const peak = lace.pow( 2.2 );
				const floorLit = bed.mul( 0.46 ).mul( mul )
					.add( bed.mul( peak ).mul( 0.20 ).mul( vec3( 1.06, 1.00, 0.88 ) ) )
					.mul( Edown ).div( PI_W )
					.toVar();
				If( uHullPush.greaterThan( 0.0005 ), () => {

					const sy = uSunDir.y.max( 0.08 );
					const shx = uHullPos.x.add( uSunDir.x.div( sy ).mul( localD ) );
					const shz = uHullPos.z.add( uSunDir.z.div( sy ).mul( localD ) );
					const q = vec2( hx.sub( shx ), hz.sub( shz ) ).length()
						.div( uHullRadius.max( 0.8 ) );
					floorLit.mulAssign( float( 1.0 ).sub( q.mul( q ).negate().exp().mul( 0.55 ) ) );

				} );
				const floorTrans = exp( uAbsorption.mul( tHit ).negate() ).toVar();
				// UNDER the interface — do not replace the water. Specular
				// and Fenv stay the surface; the bed is what you see through it.
				diffuse.addAssign( floorLit.mul( floorTrans ) );
				const film = clamp( sMip.length().mul( 3.5 ), 0.0, 1.0 )
					.mul( smoothstep( float( 0.35 ), float( 0.95 ), NoV ) )
					.mul( 0.16 ).toVar();
				Fenv.assign( Fenv.add( vec3( 1.0 ).sub( Fenv ).mul( film ) ) );

			} );

		} );

	} );

	// ---- what is UNDER the water at this pixel ------------------------------
	//
	// The refraction pass (./refraction-driver.js) has already drawn everything
	// submerged into a colour target and a matching depth target. This is where
	// the sea looks through itself at it - and the placement is the whole
	// difference between a thing IN the water and a decal ON it. It goes into
	// the DIFFUSE term, the radiance leaving the sea upward, and nowhere else,
	// so everything downstream then happens TO it, for free and correctly:
	//
	//   * (1 - Fenv) scales it, so at a grazing angle it vanishes behind the
	//     mirror the way a real submerged shape does;
	//   * foam covers it, so the sea's own whitecaps and the hull's wake pass
	//     OVER it instead of under - which is what made it read as a sticker;
	//   * the sun glitter sits on top of it;
	//   * aerial perspective hazes it with the rest of the sea.
	//
	// Held outside the branch so the "shows through the glare" term at the
	// composite can reuse the sample rather than taking it a second time.
	const refrCol = vec3( 0.0 ).toVar();
	const refrCov = float( 0.0 ).toVar();

	If( uRefractAmount.greaterThan( 0.001 ), () => {

		// The ray this pixel of sea is seen along, and how far it leans off the
		// camera's forward axis. The depth buffer measures along FORWARD and every
		// length here is along the RAY, so one divide reconciles the two. Written
		// as -RD.z in view space rather than by pulling a column out of the view
		// matrix, because the camera looks down -Z there.
		const RD = V.negate().toVar();
		const cosA = cameraViewMatrix.mul( vec4( RD, 0.0 ) ).z.negate().max( 1e-3 ).toVar();

		const suv = screenUV.toVar();
		const bed0 = perspectiveDepthToViewZ(
			refractionDepthTexture.sample( suv ), cameraNear, cameraFar,
		).negate().div( cosA ).toVar();

		// SCREEN-SPACE OFFSETS COME FROM HOW FAR THE NORMAL HAS BEEN BENT AWAY
		// FROM FLAT, not from the normal itself. The latter is a constant slide of
		// the whole image with no wobble in it at all - it slews the lookup
		// wholesale as you turn your head and never ripples, which is the tell
		// that gives a fake refraction away.
		const bend = cameraViewMatrix.mul( vec4( N, 0.0 ) ).xy
			.sub( cameraViewMatrix.mul( vec4( 0.0, 1.0, 0.0, 0.0 ) ).xy ).toVar();
		// Gated by how much water there actually is to bend the look through, and
		// flattened with distance: the same metre of lateral displacement is fewer
		// pixels the further off it is, and a fixed offset makes the far field boil.
		const distort = uRefractDistort
			.mul( clamp( bed0.sub( eyeDist ).max( 0.0 ).mul( 0.7 ), 0.0, 1.0 ) )
			.div( float( 1.0 ).add( dist.mul( 0.045 ) ) ).toVar();
		// screenUV.y = 0 is the TOP on both backends (porting rule 3) while view
		// space +Y is up, so the vertical half of the offset is negated. The
		// lookup itself needs no flip: sampling a render-target texture flips v on
		// WebGL and not on WebGPU, which cancels against the framebuffer's own row
		// order (rule 4) - and a DepthTexture takes the same flip, so the colour
		// and the depth stay in step. The bounds are vec2s rather than scalars
		// because clamp is built from the same MathNode path as the min/max whose
		// scalar second operand fails to compile on WebGL2 alone (rule 2).
		const ruv = clamp(
			suv.add( vec2( bend.x, bend.y.negate() ).mul( distort ) ),
			vec2( 0.002 ), vec2( 0.998 ),
		).toVar();
		const bed1 = perspectiveDepthToViewZ(
			refractionDepthTexture.sample( ruv ), cameraNear, cameraFar,
		).negate().div( cosA ).toVar();

		// If the offset sample sits IN FRONT of the surface, it is something above
		// the water leaking in - a breached fin that the waterline seam let into
		// this pass, which is exactly the case the seam is deliberately generous
		// about. Fall back to the straight sample.
		const ok = step( eyeDist, bed1 ).toVar();
		const fuv = mix( suv, ruv, ok ).toVar();
		const bedDist = mix( bed0, bed1, ok ).toVar();

		const samp = refractionTexture.sample( fuv ).toVar();

		// THE WATER COLUMN along the camera ray, not the body's depth under
		// the local surface. eyeDist is the displaced vertex (waves + the swell
		// mound), so subtracting it collapsed this to "how far under the hump"
		// - a side view through thirty metres of sea then read the same as
		// looking straight down at a body three metres under. tEnter is where
		// this pixel's ray meets MEAN sea level; everything past that is wet.
		// Camera already in the water: the whole camera-to-body run is wet.
		const tEnter = uCamPos.y.sub( uSeaLevel ).div( V.y.max( 1e-3 ) ).max( 0.0 ).toVar();
		const path = bedDist.sub( tEnter ).max( 0.0 ).toVar();
		// Extinction on the way up. The COLOUR is the sea's own uAbsorption, so
		// red goes first and the shape turns blue-green as it sounds exactly like
		// the water around it; uRefractFade is only its SCALE, in metres, so the
		// preset keeps its own water and the artist keeps one honest knob.
		const kAbs = uAbsorption.div( uAbsorption.dot( vec3( 1.0 / 3.0 ) ).max( 1e-4 ) )
			.div( uRefractFade.max( 0.5 ) ).toVar();
		const trans = exp( kAbs.mul( path ).negate() ).toVar();
		// The body replaces the part of the deep column it blocks, and the metres
		// of water above it still scatter. At the surface trans -> 1 and you see
		// the animal; far down trans -> 0 and you see the sea, with no step in
		// between. Standalone mix, per channel (porting rule 1).
		const seen = mix( diffuse, samp.rgb, trans ).toVar();

		// THE GUARD GOES AROUND THE WHOLE MIX. Washing the ocean white was a NaN
		// arriving from the target, and guarding the WEIGHT alone is not enough:
		// mix(a, b, 0) is a*(1-0) + b*0, and a NaN in b survives being multiplied
		// by zero. select() picks one of its arms, so a NaN in the arm not taken
		// cannot travel. Comparisons against NaN are false, so anything the target
		// holds that is not a sane 0..1 coverage leaves the sea exactly as it was.
		const cov = samp.a.mul( uRefractAmount ).toVar();
		const sane = cov.greaterThan( 0.0 ).and( cov.lessThan( 1.0001 ) )
			.and( samp.r.lessThan( 1e6 ) ).and( samp.g.lessThan( 1e6 ) )
			.and( samp.b.lessThan( 1e6 ) ).and( path.lessThan( 1e7 ) ).toVar();
		refrCov.assign( select( sane, cov.min( 1.0 ), float( 0.0 ) ) );
		refrCol.assign( select( sane, seen, diffuse ) );
		diffuse.assign( mix( diffuse, refrCol, refrCov ) );

		// ---- spray where it breaks the surface -------------------------------
		//
		// `path` is already the real distance from THIS fragment of sea down to
		// the body, along the ray - the same quantity the extinction above uses.
		// Ramping a foam contribution up as it shrinks toward 0 puts the spray
		// exactly on the body's own silhouette (fins and all - this reads the
		// refraction pass's actual depth, not the swell mound's capsule
		// approximation), tracing the true breach line rather than a shape
		// guessed from the animal's position and length.
		//
		// FED INTO THE SEA'S OWN foamMask, not shaded by hand. foamMask already
		// drives a whole tuned system - the lace albedo, the cyan underglow,
		// the Beer-Lambert opacity that keeps a fresh crest opaque and a
		// dissipated one a veil - and reusing it is what
		// keeps the spray looking like the sea's own foam instead of a decal
		// with a different idea of what foam is. Guarded the same way the
		// refraction sample above is: the select's arms, not a multiply, are
		// what a NaN in `path` cannot cross.
		const near = select(
			sane, smoothstep( uSwellFoamDepth, 0.0, path ).mul( refrCov ), float( 0.0 ),
		).toVar();
		// uFoamAmount is the master for every foam path, including the breach
		// veil. Without it, Sea Dragon → Spray kept painting bubble specks on
		// the water after Foam amount was already 0.
		foamMask.assign( clamp(
			foamMask.add( near.mul( uSwellFoamStrength ).mul( uFoamAmount ) ),
			0.0, 1.0,
		) );

	} );

	// Open the film where the rod cuts: no raft, almost no sky mirror.
	foamMask.mulAssign( float( 1.0 ).sub( cut.mul( 0.72 ) ) );
	Fenv.mulAssign( float( 1.0 ).sub( cut.mul( 0.78 ) ) );

	// ---- 13. composite water (732-737) --------------------------------------
	// A foam-covered facet is not a mirror, so it cannot carry the water's
	// glitter. Leaving the specular under the raft is what made whitecaps read as
	// glowing embers with sparkles inside them.
	const col = diffuse.mul( vec3( 1.0 ).sub( Fenv ) )
		.add( skyRefl.mul( Fenv ) )
		.add( sunSpec.add( moonSpec ).mul( float( 1.0 ).sub(
			foamMask.mul( mix( float( 0.38 ), float( 0.90 ), fresh ) ),
		) ) )
		.toVar();

	// ---- what shows THROUGH the glare ---------------------------------------
	//
	// The fudge, and it is labelled as one. Composited into the diffuse term
	// alone the animal is physically right and practically invisible: at the
	// angle you ride at, Fenv is around 0.7, and the measured shift across the
	// whole creature was 9 levels out of 255. So a fraction of the shape is mixed
	// into the sea's colour here - ABOVE the Fresnel that hides it and BELOW the
	// foam, which still passes over the top of it, because foam passing over the
	// animal is the half that stops it reading as pasted on.
	//
	// uRefractThrough 0 is the pure physics.
	If( refrCov.mul( uRefractThrough ).greaterThan( 0.001 ), () => {

		col.assign( mix( col, refrCol, refrCov.mul( uRefractThrough ).min( 1.0 ) ) );

	} );

	// The cut is a shark-fin slit: look into the ocean (the refraction
	// pass when a body is there, a darker column when it is not). Not
	// an opaque overlay — that painted a gray ribbon on the sea.
	If( cut.greaterThan( 0.002 ), () => {

		const opened = mix(
			col.mul( vec3( 0.70, 0.88, 0.92 ) ),
			refrCol,
			refrCov,
		);
		col.assign( mix( col, opened, cut.mul( 0.72 ) ) );

	} );

	// Hull film only feeds the foam mask / foamLit path above. Do not paint
	// a second "tea" colour under sparse coverage — that read as green
	// emissive ribbons that ignored the ocean preset and scene lighting.

	// ---- 14. foam shading (739-777) -----------------------------------------
	If( foamMask.greaterThan( 0.003 ), () => {

		const fNoL = Nfoam.dot( L ).max( 0.0 ).toVar();
		const fNoV = clamp( Nfoam.dot( V ), 1e-4, 1.0 ).toVar();
		const thick = bubbles.toVar();

		// White only where the lace is optically thick. Filaments stay a
		// grey-white veil so the navy shows through; clump cores reach the
		// measured whitecap range (0.6–0.8). Building it as albedo × irradiance
		// is what bounds it — the raft can never out-emit the sunlight falling
		// on it. A painted disc is what you get if this ignores `thick`.
		const albedo = clamp(
			float( 0.70 ).add( float( 0.26 ).mul( thick ) )
				.add( float( 0.08 ).mul( uFoamLift ).mul( fresh ).mul( thick ) ),
			0.62, 0.97,
		).toVar();

		// A BREACH IS A VOLUME, NOT A SURFACE, and shading it as a surface is why
		// the mound came out looking like wet sand: a hard cosine over a noisy
		// normal is *literally* how you shade sand, and the reference footage's
		// churn is a glowing white mass whose lit side and shadow side differ far
		// less than any Lambertian sheet's do. Metres of aerated water scatter
		// light through themselves many times, so:
		//   - the sun's cosine WRAPS (the standard cheap stand-in for multiple
		//     scattering); the far side is lit by light that went in the near side
		//   - it sees the whole sky, not a trough's fraction of it
		//   - its albedo runs to the top of the measured foam range, because this
		//     is the thickest, freshest whitewater in the scene
		//   - it has no wet-film sheen: that is a property of a bubble surface,
		//     and there is no coherent surface left here
		// Everything outside a water entry is untouched - thickK is zero there.
		const thickK = smoothstep( 0.05, 0.45, splashCov ).toVar();
		// Mild wrap on all foam (a bubble cloud is a volume); strong wrap on
		// splash. Do not feed splash coverage through the wind lace.
		const wrap = mix( float( 0.48 ), float( 0.85 ), thickK ).toVar();
		const fNoLw = Nfoam.dot( L ).add( wrap ).div( float( 1.0 ).add( wrap ) ).max( 0.0 ).toVar();
		albedo.assign( mix( albedo, float( 0.90 ), thickK ) );

		const Efoam = skyIrr.mul( mix( ao, float( 1.0 ), thickK ) )
			.add( sunRad.mul( fNoLw ) )
			.add( sunRad.mul( 0.28 ).mul( float( 0.55 ).add( float( 0.45 ).mul( thick ) ) ) ).toVar();
		const foamLit = uFoamColor.mul( albedo ).mul( Efoam ).mul( float( 1.0 ).div( PI_W ) ).toVar();

		// Bubble rafts scatter hard forward: a raft lights up when the sun is
		// behind it. That is transmitted light, so it is bounded by what was not
		// reflected, and a thin dissipated veil transmits far more than a dense
		// fresh crest.
		const fwd = clamp( V.dot( L.negate() ), 0.0, 1.0 ).pow( 2.5 ).toVar();
		foamLit.addAssign(
			uFoamColor.mul( sunRad ).mul( fwd ).mul( float( 1.0 ).sub( albedo ) )
				.mul( float( 0.5 ).div( PI_W ) )
				.mul( float( 1.0 ).sub( float( 0.55 ).mul( fresh ) ) ),
		);

		// Matte foam vs glossy water. A wet-film GGX on a noisy normal is how
		// the old path shaded sand; keep a whisper on thin films only, none
		// on splash volumes or optically thick clumps. D_GGX is the ISOTROPIC
		// one and D_GGXAniso cannot stand in for it - see ./water-brdf.js.
		const fa = clamp( uFoamRoughness.mul( uFoamRoughness ), 0.004, 1.0 ).toVar();
		const Hf = L.add( V ).normalize().toVar();
		const fD = D_GGX( clamp( Nfoam.dot( Hf ), 0.0, 1.0 ), fa ).toVar();
		const fV = V_SmithGGX( fNoV, fNoL, fa ).toVar();
		const sheen = float( 0.018 ).mul( float( 1.0 ).sub( thickK ) )
			.mul( float( 1.0 ).sub( thick.mul( 0.75 ) ) ).toVar();
		foamLit.addAssign( sunRad.mul( fD.mul( fV ).min( mirrorCeil ) ).mul( fNoL ).mul( sheen ) );

		// Sky reflected off the raft keeps it tied to the light of the scene.
		foamLit.addAssign( sampleSky( reflect( V.negate(), Nfoam ), float( 0.9 ) ).mul( 0.04 ) );

		// Sub-surface bubble cloud: the cyan underglow in the reference photo.
		// Slightly larger footprint than the white (sqrt dilates), only under
		// thick patches — thin filaments must not glow. Never stains the white
		// core. foamTint is the gain on this scatter, not a dye on the foam
		// albedo — dyeing the white is what turned golden-hour rafts tan.
		const halo = foamMask.sqrt().toVar();
		const glowW = halo.mul( smoothstep( 0.06, 0.40, thick ) )
			.mul( float( 0.50 ).add( float( 0.50 ).mul( float( 1.0 ).sub( fresh.mul( 0.35 ) ) ) ) )
			.mul( float( 1.0 ).sub( thickK ) ).toVar();
		const cyan = uScatterColor.mul( skyIrr.mul( 0.55 ).add( sunRad.mul( 0.30 ) ) )
			.mul( float( 1.0 ).div( PI_W ) )
			.mul( glowW )
			.mul( float( 0.55 ).add( float( 2.8 ).mul( uFoamTint ) ) ).toVar();

		// Aged foam has thinned into a veil a handful of bubbles deep, so the sea
		// shows straight through it: a Beer-Lambert opacity in the raft's own
		// thickness, not a paint layer. Only the dense clump is optically thick.
		const tau = float( 0.22 ).add( float( 4.6 ).mul( thick ).mul( float( 0.40 ).add( float( 0.60 ).mul( fresh ) ) ) ).toVar();
		const opFloor = mix( float( 0.10 ), float( 0.38 ), fresh ).toVar();
		const opacity = clamp(
			uFoamOpacity.mul( float( 1.0 ).sub( tau.negate().exp() ) )
				.mul( opFloor.add( float( 1.0 ).sub( opFloor ).mul( thick ) ) ), 0.0, 1.0,
		).toVar();

		// Aged foam (the trail) is allowed to sit in the sea's colour. Fresh
		// crests can still lift a little. A hard 1.12 floor was the white
		// sticker.
		foamLit.assign( max( foamLit, col.mul( mix( float( 0.88 ), float( 1.12 ), fresh ) ) ) );

		// TWO NESTED STANDALONE mixes. Porting rule 1. Aged coverage never
		// fully replaces the water — that is what made leftover foam a stencil.
		const under = col.add( cyan ).toVar();
		const cover = foamMask.mul( mix( float( 0.38 ), float( 0.88 ), fresh ) ).toVar();
		col.assign( mix( col, mix( under, foamLit, opacity ), cover ) );

	} );

	// ---- 15. aerial perspective (779-785) -----------------------------------
	// Atmosphere haze is air. Under the sea the column pass + the
	// underside branch below own the look.
	If( uAerial.greaterThan( 0.0 ).and( uCamPos.y.greaterThanEqual( uSeaLevel ) ), () => {

		// aerialPerspective is atmosphere.js's PLAIN JS node-graph builder, not an
		// Fn: the GLSL hands back two vec3s through `out` parameters, so it returns
		// both and is destructured. It must be called from inside an Fn body, which
		// this is.
		const ro = vec3( 0.0, float( R_PLANET ).add( uCamPos.y.max( 1.0 ) ), 0.0 ).toVar();
		const { inscatter, transmit } = aerialPerspective(
			ro, vWorld.sub( uCamPos ).normalize(), eyeDist.min( 60000.0 ), uSunDir,
		);

		// Standalone mix.
		col.assign( col.mul( mix( vec3( 1.0 ), transmit, uAerial ) ).add( inscatter.mul( uAerial ) ) );

	} );

	// ---- 16. underside (camera in the water) --------------------------------
	// The above-water BRDF is a no-op here: from below the sheet is an
	// interface. Snell's window (cos i > cos 48.6°) shows the refracted
	// sky; outside it is TIR into the deep, with the same caustic flicker
	// the column pass uses. Gated so an above-water golden is untouched.
	If( uCamPos.y.lessThan( uSeaLevel ), () => {

		const I = V.negate().toVar();
		const cosi = clamp( N.dot( I ), 0.0, 1.0 ).toVar();
		const eta = uWaterIOR.max( 1.01 ).toVar();
		// cos(asin(1/n)) = sqrt(1 - 1/n²). No asin — TSL's trig on a
		// derived float compiled and then discarded the window.
		const invN = float( 1.0 ).div( eta ).toVar();
		const crit = float( 1.0 ).sub( invN.mul( invN ) ).max( 0.0 ).sqrt().toVar();
		const win = smoothstep( crit.sub( 0.08 ), crit.add( 0.04 ), cosi ).toVar();
		const k = float( 1.0 ).sub( eta.mul( eta ).mul( float( 1.0 ).sub( cosi.mul( cosi ) ) ) ).toVar();
		const refr = I.mul( eta ).add( N.mul( eta.mul( cosi ).sub( k.max( 0.0 ).sqrt() ) ) ).normalize().toVar();
		const sky = sampleSky( refr, mix( float( 0.14 ), float( 0.30 ), float( 1.0 ).sub( win ) ) ).toVar();
		const ph = uTime.mul( 1.65 ).toVar();
		const caus = vFlat.x.mul( 0.38 ).add( ph ).sin()
			.mul( vFlat.z.mul( 0.31 ).sub( ph.mul( 1.15 ) ).sin() )
			.mul( 0.5 ).add( 0.5 ).pow( 3.0 ).mul( 1.6 ).toVar();
		const deep = uScatterColor.mul( 0.36 ).add( sky.mul( 0.08 ) )
			.mul( float( 1.0 ).add( caus.mul( 0.22 ) ) ).toVar();
		const lit = sky.mul( float( 1.55 ).add( caus.mul( 0.55 ) ) ).toVar();
		col.assign( mix( deep, lit, win ) );
		// Foam clinging to the underside — wind foam plus a few aerated clumps.
		const cling = smoothstep( float( 0.60 ), float( 0.88 ),
			vnoise2( vec2( vFlat.x.mul( 0.07 ).add( uTime.mul( 0.11 ) ), vFlat.z.mul( 0.07 ) ) ),
		).mul( 0.38 ).toVar();
		const foamUw = foamMask.mul( mix( float( 0.28 ), float( 0.86 ), fresh ) )
			.max( cling ).toVar();
		const foamCol = mix(
			vec3( 0.70, 0.84, 0.93 ),
			vec3( 0.94, 0.97, 1.0 ),
			fresh.max( cling ),
		).mul( sky.mul( 0.32 ).add( 0.55 ) ).toVar();
		col.assign( mix( col, foamCol, foamUw ) );

	} );

	// Leftover-wave debug: paint honest height so a thin fast cone
	// is readable on glassy water. Does not write the field.
	If( uRippleDebug.greaterThan( 0.5 ).and( uRippleOn.greaterThan( 0.001 ) ), () => {

		const h = rippleAt( vFlat.xz ).toVar();
		const k = smoothstep( 0.001, 0.05, h.abs() ).toVar();
		If( k.greaterThan( 0.01 ), () => {

			const tint = mix(
				vec3( 0.08, 0.42, 0.62 ),
				vec3( 1.0, 0.42, 0.10 ),
				smoothstep( - 0.12, 0.12, h ),
			);
			col.assign( mix( col, tint, k.mul( 0.78 ) ) );

		} );

	} );

	// ---- 17. out ------------------------------------------------------------
	// The GLSL's ABYSSAL_OUT() wrapper is the HDR output guard, which is the
	// driver's business and a no-op in value terms - the same call
	// ./sky-background.js made.
	return col;

} );

// ---- uniform plumbing -------------------------------------------------------

// NO_HULL, src/water.js:18-23. A hull that is nowhere near the water: the
// shader's hull terms all scale by uHullPush and uHullPlane, and the position is
// far enough below the sea that nothing can reach it. Passing null for `hull` is
// how you say "no boat".
const NO_HULL = {
	pos: [ 0, - 1e4, 0 ],
	fwd: [ 0, 1 ],
	push: 0,
	plane: 0,
};

// Mirror of the uniform block in WaterSurface.render (src/water.js:137-180),
// restricted to what this module owns. ./water-common.js, ./water-brdf.js and
// ./water-detail.js each have their own setter and a driver calls all four -
// exactly as the GLSL shares one uniform block per concern across the programs.
//
//   p     the parameter set (see src/presets.js `defaults`)
//   ctx   { camPos, viewProj, sunDir, moonDir, time }
//   hull  { pos, fwd, push, plane } or null/undefined for NO_HULL
export function setWaterSurfaceUniforms( p, ctx, hull ) {

	// src/water.js:143 - the grid follows the camera in the horizontal plane.
	if ( ctx?.camPos ) uGridCenter.value.set( ctx.camPos[ 0 ], ctx.camPos[ 2 ] );

	uRMin.value = p.rMin;
	uRMax.value = p.rMax;
	uEarthCurve.value = p.earthCurve;
	uSeaLevel.value = p.seaLevel;
	uHorizonPin.value = horizonPinAmount( ctx, p );

	// The craft's image in the sea. Read off ctx, which every driver already
	// fills; a caller with no craft leaves amount 0 and the branch never runs.
	if ( ctx?.craftReflPos ) {

		uCraftReflPos.value.set( ctx.craftReflPos[ 0 ], ctx.craftReflPos[ 1 ], ctx.craftReflPos[ 2 ] );

	}

	uCraftReflSize.value = ctx?.craftReflSize ?? 0;
	uCraftReflAmount.value = ctx?.craftReflAmount ?? 0;
	uCraftShadow.value = ctx?.craftShadow ?? 0;

	const h = hull || NO_HULL;
	uHullPos.value.set( h.pos[ 0 ], h.pos[ 1 ], h.pos[ 2 ] );
	uHullFwd.value.set( h.fwd[ 0 ], h.fwd[ 1 ] );
	uHullPush.value = h.push * waterDisplaceScale( p );
	uHullPlane.value = h.plane;
	uHullRadius.value = h.radius ?? p.hullRadius;
	uHullBow.value = h.bow ?? p.hullBow;

	uScatterColor.value.set( p.scatterColor[ 0 ], p.scatterColor[ 1 ], p.scatterColor[ 2 ] );
	uAbsorption.value.set( p.absorption[ 0 ], p.absorption[ 1 ], p.absorption[ 2 ] );
	uScatterAmount.value = p.scatterAmount;

	uSSSStrength.value = p.sssStrength;
	uSSSPower.value = p.sssPower;
	uSSSHeight.value = p.sssHeight;
	uSSSDepth.value = p.sssDepth;
	uSSSBias.value = p.sssBias;

	uBaseRoughness.value = p.baseRoughness;
	uRoughnessGain.value = p.roughnessGain;
	uRoughnessMax.value = p.roughnessMax;
	uWindAniso.value = p.windAniso;
	uWindSpeed.value = p.windSpeed;

	uCapillary.value = p.capillary;
	uCapillaryScale.value = p.capillaryScale;
	uGust.value = p.gust ?? 0;
	uGustScale.value = p.gustScale ?? 55;
	uGustDrift.value = p.gustDrift ?? 0.35;

	uFoamAmount.value = p.foamAmount;
	uFoamRoughness.value = p.foamRoughness;
	uFoamTint.value = p.foamTint;
	uFoamDetail.value = p.foamDetail;
	uFoamLift.value = p.foamLift;
	uFoamSharp.value = p.foamSharp;
	uFoamCrisp.value = p.foamCrisp;
	uFoamOpacity.value = p.foamOpacity;
	uFoamFar.value = p.foamFar;
	uFoamColor.value.set( p.foamColor[ 0 ], p.foamColor[ 1 ], p.foamColor[ 2 ] );
	uFoamTextureAmount.value = p.foamTextureAmount ?? 0;
	uFoamTextureScale.value = p.foamTextureScale ?? 9;
	uFoamTextureCarry.value = p.foamTextureCarry ?? FOAM_TEXTURE_CARRY;
	uFoamTextureShear.value = p.foamTextureShear ?? FOAM_TEXTURE_SHEAR;
	uFoamTextureStrain.value = p.foamTextureStrain ?? FOAM_TEXTURE_STRAIN;
	uFoamLaceStretch.value = p.foamLaceStretch ?? 0;
	uFoamLaceStretchBlock.value = p.foamLaceStretchBlock ?? FOAM_LACE_STRETCH_BLOCK;
	uFoamLaceMorph.value = p.foamLaceMorph ?? 0;
	uFoamLaceMorphRate.value = p.foamLaceMorphRate ?? 0;
	uWakeFoamRibbonVary.value = p.wakeFoamRibbonVary ?? WAKE_FOAM_RIBBON_VARY;

	uWakeRelief.value = p.wakeRelief;
	uWakeSlick.value = p.wakeSlick;
	uWakePlume.value = p.wakePlume ?? 1.0;

	uSpecIntensity.value = p.specIntensity;
	uSpecClamp.value = p.specClamp;
	uSpecAA.value = p.specAA;
	uGrazeFocus.value = p.grazeFocus;

	uSkyAmbient.value = p.skyAmbient;
	uHorizonBend.value = p.horizonBend;
	uInterReflect.value = p.interReflect;
	uWaveAO.value = p.waveAO;
	uWaterIOR.value = p.waterIOR;
	uAerial.value = p.aerial;
	uFloorDepth.value = p.floorDepth ?? 0;
	uFloorDepthMin.value = p.floorDepthMin ?? 0;
	uFloorDepthMax.value = p.floorDepthMax ?? 0;
	uFloorTerrainScale.value = p.floorTerrainScale ?? 36;
	uFloorCaustic.value = p.floorCaustic ?? 1;
	uFloorCausticSize.value = p.floorCausticSize ?? 1;
	uRefractDistort.value = p.sdRefract ?? 0.43;
	uShoreFoamAmount.value = p.shoreFoamAmount ?? 0;
	uShoreFoamRange.value = p.shoreFoamRange ?? 3;

}

/**
 * One occupant of the just-under slot (OceanBody.swellState, or the
 * sea-dragon path in the ride demo). Null / empty clears so a toggle
 * off does not leave last frame's loaf on the sea. Packets stay empty
 * — bow and dome carry their own metres.
 */
export function applySwellUniforms( s ) {

	const bow = s?.bow;
	const dome = s?.dome;
	const live = s && (
		Math.abs( s.amp ) > 0.0005
		|| Math.abs( bow?.amp ) > 0.02
		|| Math.abs( dome?.amp ) > 0.02
	);
	uSwellSiteCount.value = 0;
	uSwellWaves.value = 0;
	uSwellSweep.value = 0;
	uSwellLift.value = 0;
	uSwellLiftPhase.value = 0;
	uSwellPhase.value = 0;
	if ( ! live ) {

		uSwellAmp.value = 0;
		uSwellBow.value.set( 0, 0, 0, 8 );
		uSwellDome.value.set( 0, 0, 0, 8 );

	} else {

		uSwellPos.value.set( s.pos[ 0 ], s.pos[ 1 ], s.pos[ 2 ] );
		uSwellDir.value.set( s.dir[ 0 ], s.dir[ 1 ] );
		uSwellLen.value = s.len;
		uSwellRad.value = s.rad;
		uSwellAmp.value = s.amp;
		uSwellPitch.value = s.pitch ?? 0;
		uSwellBow.value.set( bow?.x ?? 0, bow?.z ?? 0, bow?.amp ?? 0, bow?.rh ?? 8 );
		uSwellBowDir.value.set( s.dir[ 0 ], s.dir[ 1 ] );
		uSwellBowSoft.value = bow?.soft ?? 1;
		uSwellDome.value.set( dome?.x ?? 0, dome?.z ?? 0, dome?.amp ?? 0, dome?.along ?? 8 );
		uSwellDomeDir.value.set( s.dir[ 0 ], s.dir[ 1 ] );
		uSwellDomeW.value = dome?.across ?? 4;

	}

	// Tail prints live on their own clock. A released loaf must not
	// snap the glassy discs off the sea.
	const prints = s?.flukes ?? [];
	uFlukeCount.value = prints.length;
	for ( let i = 0; i < FLUKE_PRINTS; i ++ ) {

		const p = prints[ i ];
		if ( p ) uFlukePrints.array[ i ].set( p.x, p.z, p.radius, p.amp );
		else uFlukePrints.array[ i ].set( 0, 0, 0, 0 );

	}

}
