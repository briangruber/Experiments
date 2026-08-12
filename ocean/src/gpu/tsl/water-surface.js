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
//   the procedural foam field          (WATER_FS:469)
//   the bubble relief noise            (WATER_FS:543-544)
//   the swell shadow march             (WATER_FS:568)
//
// Indexed by the DISPLACED point - exactly one thing, in two places:
//   scintillation, in the sun lobe     (WATER_FS:653, vWorld.xz)
//   scintillation, in the moon lobe    (WATER_FS:677, vWorld.xz + 71.3)
//
// That single exception is load-bearing and the GLSL says why (water.js:650-652):
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
//    WATER_VS declares uCamPos and never uses it, so the vertex stage here does
//    not read it either. ABYSSAL_OUT/uOutExposure is the HDR output guard, which
//    is the driver's business and a no-op in value terms - the same call
//    ./sky-background.js made.
//
// 7. sampleSky HERE IS ./water-brdf.js's TWO-ARGUMENT ONE, (rd, alpha), which
//    picks a mip from the lobe width. ./sky-background.js exports a DIFFERENT
//    function of the same name, (rd) at explicit LOD 0. This file imports only
//    skyLutTexture and uSunAngularRadius from sky-background.js; importing its
//    sampleSky would compile and would quietly make every water reflection a
//    perfect mirror.

import {
	Fn, If, float, vec2, vec3, uniform, attribute, varyingProperty,
	mix, clamp, smoothstep, select, reflect, dFdx, dFdy, fwidth,
} from 'three/tsl';

import {
	R_PLANET, TAU_A, uAtmoExposure, uSunIrradiance,
	sunTransmittance, aerialPerspective,
} from './atmosphere.js';

import { uSunDir, uMoonDir, uMoonColor } from './sky-lut.js';
import { skyLutTexture, uSunAngularRadius } from './sky-background.js';
import { uTime, uCamPos } from './cloud-field.js';
import { vnoise } from './noise.js';

import {
	PI_W, R_EARTH, uWindDir, uWakeOn, uWakeExtent,
	sampleCascadeDisp, sampleCascadeSurface, wakeAt,
} from './water-common.js';

import {
	sampleSky, D_GGX, D_GGXAniso, V_SmithGGX, V_SmithAniso,
	fresnelDielectric, envFresnel,
} from './water-brdf.js';

import {
	scintillation, sunVisibility, capillarySlope, foamField, uGlitter,
} from './water-detail.js';

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

export const uFoamAmount = /*@__PURE__*/ uniform( 0.9 );
export const uFoamRoughness = /*@__PURE__*/ uniform( 0.62 );
export const uFoamTint = /*@__PURE__*/ uniform( 0.35 );
export const uFoamDetail = /*@__PURE__*/ uniform( 1.5 );
export const uFoamLift = /*@__PURE__*/ uniform( 0.55 );
export const uFoamSharp = /*@__PURE__*/ uniform( 1.4 );
export const uFoamCrisp = /*@__PURE__*/ uniform( 0.8 );    // resolve coverage against the bubble field up close
export const uFoamOpacity = /*@__PURE__*/ uniform( 0.92 );
export const uFoamFar = /*@__PURE__*/ uniform( 0.55 );     // grazing self-hiding of distant rafts
export const uFoamColor = /*@__PURE__*/ uniform( 'vec3' );

// Set separately from the wake block in src/water.js:169, so these two live here
// rather than in ./water-common.js: they are how the wake is SHADED, not what it
// is. wakeAt() and the twelve uniforms that shape the field are common.
export const uWakeRelief = /*@__PURE__*/ uniform( 1.0 );
export const uWakeSlick = /*@__PURE__*/ uniform( 0.8 );

export const uSpecIntensity = /*@__PURE__*/ uniform( 1.0 );
export const uSpecClamp = /*@__PURE__*/ uniform( 20000.0 );
export const uSpecAA = /*@__PURE__*/ uniform( 1.0 );          // screen-space slope variance folded into the lobe
export const uGrazeFocus = /*@__PURE__*/ uniform( 0.20 );     // how far the reflection lobe narrows at grazing

export const uSkyAmbient = /*@__PURE__*/ uniform( 1.0 );
export const uHorizonBend = /*@__PURE__*/ uniform( 0.85 );
export const uInterReflect = /*@__PURE__*/ uniform( 0.6 );
export const uWaveAO = /*@__PURE__*/ uniform( 1.0 );

// Passed as the `eta` argument to fresnelDielectric/envFresnel. ./water-brdf.js
// deliberately has no copy: every function there takes the index of refraction
// as a parameter, exactly as the GLSL does, and all the call sites are here.
export const uWaterIOR = /*@__PURE__*/ uniform( 1.333 );

export const uAerial = /*@__PURE__*/ uniform( 1.0 );

// Vector defaults, spelled out because uniform('vecN') starts at zero.
uGridCenter.value.set( 0.0, 0.0 );
uHullPos.value.set( 0.0, - 1e4, 0.0 );          // NO_HULL, src/water.js:19
uHullFwd.value.set( 0.0, 1.0 );                 // NO_HULL
uScatterColor.value.set( 0.048, 0.285, 0.360 );
uAbsorption.value.set( 0.42, 0.075, 0.045 );
uFoamColor.value.set( 0.94, 0.965, 0.99 );

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

	// ---- hull ---------------------------------------------------------------
	If( uHullPush.greaterThan( 0.0005 ), () => {

		const rel = xz.sub( uHullPos.xz ).toVar();
		const d2 = rel.dot( rel ).toVar();
		// GLSL: `float R = max(uHullRadius, 0.5)`. Renamed Rh only because `R` is
		// the reflection vector in the fragment stage and the two are easy to
		// confuse when reading them side by side.
		const Rh = uHullRadius.max( 0.5 ).toVar();

		If( d2.lessThan( Rh.mul( Rh ).mul( 4.0 ) ), () => {

			const along = rel.dot( uHullFwd ).toVar();
			const lat = rel.dot( vec2( uHullFwd.y.negate(), uHullFwd.x ) ).toVar();

			// Anisotropic footprint: a hull is long and narrow, so the hollow it
			// makes is too. Squashing across the beam (the 0.30) is what keeps
			// this from reading as a round dent following the craft.
			const g = along.mul( along ).div( Rh.mul( Rh ) )
				.add( lat.mul( lat ).div( Rh.mul( Rh ).mul( 0.30 ) ) )
				.negate().exp().toVar();

			// Pressed down under and just aft of the hull...
			//
			// EDGES DESCENDING, 1.2 then -1.6, ON PURPOSE - see note 3 in the
			// header. Do not reorder them and do not rewrite this as
			// smoothstep(-1.6, 1.2, along).oneMinus().
			const press = g.negate().mul( smoothstep( float( 1.2 ), float( - 1.6 ), along ) ).toVar();

			// ...and the displaced water has to go somewhere: up at the bow and
			// out to the sides, which is the shoulder the wake arms grow out of.
			const bow = g.mul( smoothstep( float( - 0.1 ), float( 1.3 ), along ) ).mul( uHullBow ).toVar();
			const side = g.mul( smoothstep( float( 0.25 ), float( 1.0 ), lat.abs().div( Rh ) ) )
				.mul( uHullBow ).mul( 0.5 ).toVar();

			pos.y.addAssign( press.add( bow ).add( side ).mul( uHullPush ).mul( uHullPlane ) );

		} );

	} );

	// ---- wake ---------------------------------------------------------------
	If( uWakeOn.greaterThan( 0.5 ), () => {

		// The radial grid's rings stretch to metres wide long before the field
		// runs out, and a metre-wide ridge sampled by a six-metre triangle only
		// crawls and pops. So the geometry is faded out well inside the buffer and
		// the far half of the wake lives on as foam alone, which the fragment
		// shader can resolve at any distance.
		const wf = float( 1.0 ).sub(
			smoothstep( uWakeExtent.mul( 0.16 ), uWakeExtent.mul( 0.42 ), r ),
		).toVar();

		// Undisplaced again: the fragment stage reads wakeAt(vFlat.xz), so this
		// must be wakeAt(xz) or the ridge's normal belongs to a different ridge
		// than its geometry.
		If( wf.greaterThan( 0.002 ), () => {

			pos.y.addAssign( wakeAt( xz ).y.mul( wf ) );

		} );

	} );

	// Planet curvature drops the far surface away, which is what actually puts
	// the horizon at the right place and hides the end of the grid.
	pos.y.subAssign( uEarthCurve.mul( r.mul( r ) ).div( 2.0 * R_EARTH ) );

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

	// ---- 2. surface normal + microfacet statistics from the cascades (354-376)
	// slope, msq, foamF and foamR are MUTATED below (the capillary layer and the
	// wake slick), which is why ./water-common.js hands them back as .toVar()s.
	// foamT is accumulated and never read - in the GLSL too (declared 359,
	// written 372, no reader). Kept for the 1:1 diff.
	const { slope, msq, lost, foamF, foamR } = sampleCascadeSurface( vFlat.xz, dist );

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

	If( capFade.greaterThan( 0.01 ), () => {

		const amp = uCapillary.mul( 0.16 ).mul( capFade )
			.mul( clamp( uWindSpeed.div( 9.0 ), 0.15, 2.0 ) ).toVar();
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

	If( uWakeOn.greaterThan( 0.5 ), () => {

		// Once a pixel is wider than the pattern there is nothing left to resolve
		// and point-sampling it is pure aliasing, exactly as for the foam sim.
		const k = float( 1.0 ).sub( smoothstep( 1.2, 6.0, foot ) ).toVar();

		If( k.greaterThan( 0.004 ), () => {

			const wk = wakeAt( vFlat.xz ).toVar();
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
			// merely happens to be inside a 320 m square, which is most of them.
			//
			// GLSL: `if (uWakeRelief > 0.0 && wk.z > 0.02)`. TSL has no
			// short-circuit, so the && is .and(); neither test can produce a NaN,
			// so there is nothing for a short-circuit to have protected.
			If( uWakeRelief.greaterThan( 0.0 ).and( wk.z.greaterThan( 0.02 ) ), () => {

				// GLSL: `const float e = 0.5`. Left as a JS number here, unlike the
				// 0.09 in section 7: 0.5 and 2.0*0.5 are exactly representable, so
				// folding them on the CPU is bit-identical to folding them in the
				// shader.
				const e = 0.5;
				const hx = wakeAt( vFlat.xz.add( vec2( e, 0.0 ) ) ).y
					.sub( wakeAt( vFlat.xz.sub( vec2( e, 0.0 ) ) ).y ).toVar();
				const hz = wakeAt( vFlat.xz.add( vec2( 0.0, e ) ) ).y
					.sub( wakeAt( vFlat.xz.sub( vec2( 0.0, e ) ) ).y ).toVar();

				slope.addAssign( vec2( hx, hz ).div( 2.0 * e ).mul( uWakeRelief ).mul( k ) );

			} );

		} );

	} );

	// ---- 5. normal, filtered slope variance, Cox-Munk split (435-465) --------
	const N = vec3( slope.x.negate(), 1.0, slope.y.negate() ).normalize().toVar();

	// GLSL: `float var = ...`. `var` is a JavaScript reserved word - note 2.
	const slopeVar = msq.sub( slope.dot( slope ) ).max( 0.0 ).add( lost ).toVar();

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
	const b2 = uBaseRoughness.mul( uBaseRoughness ).toVar();
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
	// foamField packs the GLSL's `out float bubbles` into .y - the same
	// translation ./sky-background.js's cirrusLayer used for its `out float dist`.
	const fdv = foamField( vFlat.xz, uTime, foot ).toVar();
	const fd = fdv.x;
	// A var, not a plain read: section 7 OVERWRITES this with the finer bubble
	// field, exactly as the GLSL does at water.js:552.
	const bubbles = fdv.y.toVar();

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
	const covF = clamp( foamF.mul( uFoamAmount ), 0.0, 1.0 ).toVar();
	const covR = clamp( foamR.mul( uFoamAmount ), 0.0, 1.0 ).toVar();
	// Once the pixel is wider than a clump there is nothing left to resolve and
	// the contrast has to collapse onto the mean, or the far field turns into
	// per-pixel confetti.
	const clumpRes = float( 1.0 ).sub( smoothstep( 0.4, 5.0, foot ) ).toVar();
	const shape = clamp(
		float( 1.0 ).add( fd.sub( 0.5 ).mul( 2.6 ).mul( uFoamSharp.max( 0.05 ) ) ), 0.0, 3.2,
	).toVar();
	// The raft is what is left after the crest that made it has moved on, so it
	// sits where the field was high a moment ago: a shifted, softer version of the
	// same clumps, which is what draws the streaks out behind the whitecaps.
	const shapeR = clamp(
		float( 1.0 ).add( fd.sub( 0.62 ).mul( 1.7 ).mul( uFoamSharp.max( 0.05 ) ) ), 0.0, 2.4,
	).toVar();
	// Multiplying a blurry coverage by a detail field keeps the blur: the sim's
	// foam lives at 1.5 m per texel, so close up the raft was a magnified smudge
	// with texture painted over it. Resolving the coverage *against* the detail
	// field instead - foam wherever the field exceeds 1 - coverage - puts the edge
	// at the bubble scale where it belongs, and because the threshold moves with
	// the coverage the area it selects still tracks what the sim computed.
	// Only worth doing while a pixel is narrower than a clump; past that there is
	// nothing to resolve and the multiplicative mean is the honest answer.
	const crisp = clumpRes.mul( clamp( uFoamCrisp, 0.0, 1.0 ) ).toVar();
	const eF = 0.11, eR = 0.20;

	// Four standalone mixes in these two statements. Porting rule 1.
	const maskF = mix(
		clamp( covF.mul( mix( float( 1.0 ), shape, clumpRes ) ), 0.0, 1.0 ),
		smoothstep( float( 1.0 ).sub( covF ).sub( eF ), float( 1.0 ).sub( covF ).add( eF ), fd ),
		crisp,
	).toVar();
	const maskR = mix(
		clamp( covR.mul( mix( float( 1.0 ), shapeR, clumpRes ) ), 0.0, 1.0 ),
		smoothstep( float( 1.0 ).sub( covR ).sub( eR ), float( 1.0 ).sub( covR ).add( eR ), fd ),
		crisp,
	).toVar();
	const foamMask = clamp( maskF.add( maskR.mul( float( 1.0 ).sub( maskF ) ) ), 0.0, 1.0 ).toVar();

	// What fraction of the covered area is dense crest foam rather than raft. It
	// drives albedo, opacity and forward scattering below, so it is the single
	// number that separates whitewater from a blue-white film. Taken BEFORE the
	// distance term, which scales both channels equally - that order is the point.
	const fresh = clamp( maskF.div( foamMask.max( 1e-4 ) ), 0.0, 1.0 ).toVar();

	// At a kilometre you are looking at the side of a raft that lies in and just
	// behind the crests, and the crest in front hides most of it. That is a real
	// geometric loss on top of the areal averaging, and it is what stops the
	// grazing band just under the horizon painting itself solid.
	foamMask.mulAssign(
		float( 1.0 ).sub( clamp( uFoamFar, 0.0, 1.0 ).mul( smoothstep( 0.5, 9.0, foot ) ) ),
	);

	// Wake foam is not wind foam, and running it through the machinery above is
	// what made forty metres of churned water indistinguishable from the sea it
	// was churned out of: the clump noise that breaks whitecaps into a field of
	// separate caps is exactly the wrong shaping for a coherent band with an edge.
	// So it composites over the top, only lightly textured, and it is fresh - a
	// hull aerates water far more thoroughly than a collapsing crest does.
	If( wake.greaterThan( 0.002 ), () => {

		const wakeMask = clamp(
			wake.mul( float( 0.80 ).add( float( 0.40 ).mul( fd.sub( 0.5 ) ) ) ), 0.0, 1.0,
		).toVar();
		fresh.assign( mix( fresh, float( 0.9 ), wakeMask ) );
		foamMask.assign( foamMask.add( wakeMask.mul( float( 1.0 ).sub( foamMask ) ) ) );

	} );

	// ---- 7. foam normal (530-558) -------------------------------------------
	const Nfoam = N.toVar();

	If( foamMask.greaterThan( 0.003 ), () => {

		// Bubble relief from a cheap analytic gradient, and a slight lift so the
		// raft sits proud of the water rather than being painted onto it.
		// Two scales of bubble: clumps of raft a hand's width across, and the
		// individual bubble caps inside them. One scale alone reads as a noise
		// texture rather than as whitewater.
		// Each band dies as its cells drop under the pixel footprint, and it dies
		// toward its own mean rather than to zero, so a distant raft becomes a flat
		// patch of the right brightness instead of a field of aliasing sparks.
		const cf = float( 1.0 ).sub( smoothstep( 0.14, 0.85, foot ) ).toVar();    // 25 cm clumps
		const bf = float( 1.0 ).sub( smoothstep( 0.035, 0.20, foot ) ).toVar();   // 6 cm bubble caps
		// A REAL float var, not a JS number, and the products below are left as
		// shader expressions rather than folded here. `e * 17.0` folded in JS
		// doubles and then narrowed to float lands one ulp away from what the GLSL
		// computes from `float e = 0.09` (1.52999997 vs 1.53000009): the shader
		// multiplies a float by 17, JS multiplies a double. `e * 4.0` happens to
		// agree because scaling by a power of two is exact, but there is no reason
		// to rely on that per constant. Emitting `e * 17.0` gives the compiler the
		// identical expression the GLSL gave it.
		const e = float( 0.09 ).toVar();
		const bp = vec3( vFlat.xz.mul( 4.0 ), uTime.mul( 0.45 ) ).toVar();
		const bq = vec3( vFlat.xz.mul( 17.0 ), uTime.mul( 1.1 ) ).toVar();
		// Keeps the mean at 0.75, so a distant raft goes flat at the right
		// brightness instead of sparkling.
		const base = float( 0.5 ).mul( float( 1.0 ).sub( cf ) )
			.add( float( 0.25 ).mul( float( 1.0 ).sub( bf ) ) ).toVar();

		const b0 = vnoise( bp ).mul( cf )
			.add( float( 0.5 ).mul( vnoise( bq ) ).mul( bf ) ).add( base ).toVar();
		const bx = vnoise( bp.add( vec3( e.mul( 4.0 ), 0.0, 0.0 ) ) ).mul( cf )
			.add( float( 0.5 ).mul( vnoise( bq.add( vec3( e.mul( 17.0 ), 0.0, 0.0 ) ) ) ).mul( bf ) )
			.add( base ).toVar();
		const bz = vnoise( bp.add( vec3( 0.0, e.mul( 4.0 ), 0.0 ) ) ).mul( cf )
			.add( float( 0.5 ).mul( vnoise( bq.add( vec3( 0.0, e.mul( 17.0 ), 0.0 ) ) ) ).mul( bf ) )
			.add( base ).toVar();
		const bg = vec2( bx.sub( b0 ), bz.sub( b0 ) ).div( e ).toVar();

		// Replace the coarse mask-shaping noise with this finer field: from here on
		// the bubble term is shading structure, not coverage modulation.
		bubbles.assign( clamp( b0.mul( 0.75 ), 0.0, 1.2 ) );

		const relief = uFoamDetail.mul( float( 0.3 ).add( float( 0.9 ).mul( fresh ) ) )
			.mul( float( 1.0 ).div( float( 1.0 ).add( dist.mul( 0.02 ) ) ) ).toVar();

		Nfoam.assign( vec3(
			slope.x.negate().sub( bg.x.mul( relief ) ),
			1.0,
			slope.y.negate().sub( bg.y.mul( relief ) ),
		).normalize() );

		// A raft sits proud of the water, so it is a little flatter than the wave
		// it rides - but only a little, or it stops reading as part of the wave at
		// all. Standalone mix.
		Nfoam.assign( mix( Nfoam, vec3( 0.0, 1.0, 0.0 ), foamMask.mul( 0.12 ) ).normalize() );

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

	// ---- 13. composite water (732-737) --------------------------------------
	// A foam-covered facet is not a mirror, so it cannot carry the water's
	// glitter. Leaving the specular under the raft is what made whitecaps read as
	// glowing embers with sparkles inside them.
	const col = diffuse.mul( vec3( 1.0 ).sub( Fenv ) )
		.add( skyRefl.mul( Fenv ) )
		.add( sunSpec.add( moonSpec ).mul( float( 1.0 ).sub( foamMask.mul( 0.9 ) ) ) )
		.toVar();

	// ---- 14. foam shading (739-777) -----------------------------------------
	If( foamMask.greaterThan( 0.003 ), () => {

		const fNoL = Nfoam.dot( L ).max( 0.0 ).toVar();
		const fNoV = clamp( Nfoam.dot( V ), 1e-4, 1.0 ).toVar();

		// Whitewater is an optically thick bubble raft: a near-Lambertian
		// dielectric. Measured whitecap reflectance is far lower than the eye
		// assumes - a fresh breaking crest is around 0.6-0.8, and the thin
		// dissipated raft that covers most of the sea is nearer 0.3, which is why a
		// photographed streak is grey where a painted one is white. Building it as
		// albedo x irradiance is what bounds it; the raft can never out-emit the
		// sunlight falling on it.
		const albedo = clamp(
			float( 0.28 ).add( float( 0.44 ).mul( fresh ) )
				.add( float( 0.10 ).mul( uFoamLift ).mul( fresh ) ), 0.0, 0.82,
		).toVar();
		albedo.mulAssign( float( 0.72 ).add( float( 0.50 ).mul( bubbles ) ) );
		albedo.assign( albedo.min( 0.86 ) );

		const Efoam = skyIrr.mul( ao ).add( sunRad.mul( fNoL ) ).toVar();
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

		// Wet-sheen highlight off the bubble film, bounded by the same mirror
		// ceiling the water's own specular uses. D_GGX is the ISOTROPIC one and
		// D_GGXAniso cannot stand in for it - see ./water-brdf.js.
		const fa = clamp( uFoamRoughness.mul( uFoamRoughness ), 0.004, 1.0 ).toVar();
		const Hf = L.add( V ).normalize().toVar();
		const fD = D_GGX( clamp( Nfoam.dot( Hf ), 0.0, 1.0 ), fa ).toVar();
		const fV = V_SmithGGX( fNoV, fNoL, fa ).toVar();
		foamLit.addAssign( sunRad.mul( fD.mul( fV ).min( mirrorCeil ) ).mul( fNoL ).mul( 0.06 ) );

		// Sky reflected off the raft keeps it tied to the light of the scene.
		foamLit.addAssign( sampleSky( reflect( V.negate(), Nfoam ), float( 0.9 ) ).mul( 0.05 ) );

		// Standalone mix, twice, nested.
		foamLit.assign( mix(
			foamLit,
			foamLit.mul( mix( vec3( 1.0 ), uScatterColor.mul( 3.0 ), 0.5 ) ),
			uFoamTint,
		) );

		// Aged foam has thinned into a veil a handful of bubbles deep, so the sea
		// shows straight through it: a Beer-Lambert opacity in the raft's own
		// thickness, not a paint layer. Only the fresh crest is optically thick.
		const tau = float( 0.35 ).add( float( 5.0 ).mul( fresh ) ).toVar();
		const opacity = clamp(
			uFoamOpacity.mul( float( 1.0 ).sub( tau.negate().exp() ) )
				.mul( float( 0.55 ).add( float( 0.7 ).mul( bubbles ) ) ), 0.0, 1.0,
		).toVar();

		// TWO NESTED STANDALONE mixes. This is precisely the shape that cost the
		// sky port its worst defect - `col.mix(foamLit, opacity)` compiles and
		// blends by col. Porting rule 1.
		col.assign( mix( col, mix( col, foamLit, opacity ), foamMask ) );

	} );

	// ---- 15. aerial perspective (779-785) -----------------------------------
	If( uAerial.greaterThan( 0.0 ), () => {

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

	// ---- 16. out ------------------------------------------------------------
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

	const h = hull || NO_HULL;
	uHullPos.value.set( h.pos[ 0 ], h.pos[ 1 ], h.pos[ 2 ] );
	uHullFwd.value.set( h.fwd[ 0 ], h.fwd[ 1 ] );
	uHullPush.value = h.push;
	uHullPlane.value = h.plane;
	uHullRadius.value = p.hullRadius;
	uHullBow.value = p.hullBow;

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

	uWakeRelief.value = p.wakeRelief;
	uWakeSlick.value = p.wakeSlick;

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

}
