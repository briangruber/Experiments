// The sky LUT bake, in TSL: the 512x256 lat-long table that every other pass
// reads its sky radiance out of, plus the direction<->uv mapping that addresses
// it. Translated from SKY_LUT_FS and SKY_LUT_MAP_GLSL in src/shaders/sky.js.
//
// One source, both backends. Three compiles these node graphs to WGSL on WebGPU
// and to GLSL on WebGL2, which is the whole point (docs/webgpu-port.md). No
// wgslFn, no glslFn - a raw-source node compiles for exactly one backend and
// would put the fallback back where it started.
//
// The physics lives in ./atmosphere.js and is not repeated here. This module is
// the *pass*: pick a direction for this texel, run the scattering integral down
// it once for the sun and once for the moon, write the sum.
//
// ---------------------------------------------------------------------------
// WHY THE MAPPING IS THE LOAD-BEARING PART OF THIS FILE
//
// dirToSkyUv() is not private to the LUT. SKY_LUT_MAP_GLSL is textually pasted
// into src/shaders/water.js (the reflection fetch), all three spray programs in
// src/shaders/spray.js (SPRAY_VS, SPRAY_FS, SPRAY_HAZE_FS), demo/craft.js, and
// it is re-exported from src/index.js as public API. Those consumers only ever
// *read* the table; skyUvToDir() below is what *writes* it. The two are exact
// inverses, and they have to stay exact inverses:
//
//   write: v = 0.5 + 0.5*sign(y)*sqrt(|y|)      (skyUvToDir, inverted)
//   read:  y = sign(2v-1)*(2v-1)^2               (dirToSkyUv, inverted)
//
// Change either one and nothing errors - the LUT is still a smooth gradient and
// the sky still renders. What happens instead is that every consumer reads the
// wrong latitude, so the horizon band lands a few degrees off in the water
// reflection, in the spray ambient and in the craft ambient, all at once and all
// subtly. There is no test that fails loudly for this; the pixel-level
// fingerprint in prototypes/sky-golden.html is what catches it, which is why
// that reference stores every pixel and not just the mean.
//
// And one consumer does not even go through dirToSkyUv: demo/craft.js:126 reads
// `textureLod(uSkyLUT, vec2(0.5, 0.78), 9.0)` for its sky irradiance - a raw uv
// literal. Under this curve v = 0.78 is elevation asin((2*0.78-1)^2) ~= 18.3
// degrees; under a linear-in-y mapping the same literal would be 34 degrees, and
// under a linear-in-angle one, 50. That constant is pinned to this exact curve
// from another file, with nothing linking them but the fact that both are right.
//
// The square-root latitude is the reason the table is only 256 rows tall and
// still resolves a sunset: it packs resolution around y = 0. The middle half of
// the rows (v in [0.25, 0.75]) cover elevations within asin(0.25) = 14.5 degrees
// of the horizon, where all the interesting gradient is; the zenith, which is
// nearly flat, gets the sparse end.
//
// ---------------------------------------------------------------------------
// FOUR THINGS A READER WILL OTHERWISE GET WRONG
//
// 1. skyUvToDir() reconstructs the horizontal radius as sqrt(1 - y*y), i.e. it
//    *assumes the result is a unit vector* and only ever emits unit vectors.
//    dirToSkyUv() does NOT normalize its argument - it reads d.y as a sine
//    directly. Every GLSL call site passes an already-normalized direction and
//    every TSL call site must too. Passing an unnormalized direction does not
//    fail, it silently reads the wrong row.
//
// 2. The GLSL guards the moon term with `&&`. TSL has no short-circuiting
//    boolean operator that this repo's probes have exercised, so the two tests
//    are written as nested `If`s - which is what src/gpu/tsl/atmosphere.js does
//    with planetDist's `||`, for the same reason. Nesting is exactly equivalent
//    here (neither test can produce a NaN, so there is nothing for the
//    short-circuit to protect), and it uses only `If` + a compare, both verified
//    on both backends in prototypes/tsl-mechanics-probe.html.
//
// 3. An `Fn` with no explicit layout is INLINED at each call site rather than
//    emitted as a shader function (see note 2 in ./atmosphere.js). skyScatter is
//    such an Fn, so the two calls below emit two full marches - which is what the
//    GLSL does too, 24 steps for the sun and 12 for the moon. But it also means
//    every multi-use intermediate has to be pinned with `.toVar()` or it is
//    recomputed: `rd` and `ro` feed both marches, and without the `.toVar()` the
//    whole direction reconstruction would be evaluated twice.
//
// 4. TSL does not do GLSL's implicit int->float promotion. The step counts are
//    passed as `int(24)` / `int(12)` because atmosphere.js's skyScatter feeds
//    them straight into `Loop({ end: int(steps) })`.
//
// ---------------------------------------------------------------------------
// USAGE
//
//   material.fragmentNode = skyLutFragment( uv() );
//
// `uv()` must run 0..1 across the full 512x256 table with **v = 0 on the row the
// sampler later reads back at v = 0**. That is the whole requirement, and it is
// not the same as "whatever a fullscreen quad gives you" - the two candidates
// disagree with each other:
//
//   three's QuadMesh (renderers/common/QuadMesh.js) carries uv [0,-1, 0,1, 2,1]
//   against positions [-1,3, -1,-1, 3,-1], so uv.y = 0 lands at NDC TOP.
//   PlaneGeometry(2, 2) gives uv.y = 1 at NDC top - the exact opposite.
//
// Only QuadMesh round-trips, because the read side is not symmetric either:
// TextureNode.setupUV flips v on the GLSL backend when isRenderTargetTexture is
// set and does not flip on WGSL, so on BOTH backends sampling the baked target
// at v = 0 returns the row drawn at NDC top. Bake on a PlaneGeometry quad and the
// table is stored mirrored in v with nothing erroring anywhere.
//
// Use QuadMesh, or drive the uv from screenUV. Do NOT reason from the shipping
// GLSL's FS_VERT (`vUv = a_pos*0.5+0.5`): that is a third convention again, and
// matching it is not the requirement.
//
// A v mirror is not a subtle failure but it is a silent one, and it is not
// confined to below the horizon: zenith reads the nadir row, so the background
// gradient, the water's reflection fetch, all three spray programs and craft.js
// read the sky inverted at once.
//
// The target itself must be RGBA16F (the raw radiance is well outside 8-bit),
// wrap REPEAT in u because azimuth is periodic, CLAMP_TO_EDGE in v because
// latitude is not, and mipped - src/shaders/spray.js reads mip 3 and mip 4 of
// this table as its diffuse irradiance. See src/sky.js for the shipping setup.

import { Fn, If, atan, clamp, float, int, vec2, vec3, vec4, uniform } from 'three/tsl';

import {
	R_PLANET,
	TAU_A,
	skyScatter,
	uSunIrradiance,
} from './atmosphere.js';

// ---- uniforms ---------------------------------------------------------------
// The four uniforms SKY_LUT_FS declares on top of the shared atmosphere block.
// src/sky.js fills them in updateLUT(); setSkyLutUniforms() below is the mirror
// of that call, so the two paths cannot drift.
//
// The shared eight (uTurbidity, uOzone, uSunIrradiance, uMieG, uAtmoExposure,
// uMultiScatter, uMSFloor, uMSHeight) are NOT redeclared here - they are the
// nodes exported from ./atmosphere.js, set through its setAtmosphereUniforms(),
// exactly as the GLSL shares one ATMOSPHERE_GLSL block between every program.

// Defaults are the shipping defaults from src/presets.js so this module
// evaluates to a sane sky before anything has called setSkyLutUniforms().

export const uSunDir    = /*@__PURE__*/ uniform( 'vec3' );
export const uMoonDir   = /*@__PURE__*/ uniform( 'vec3' );
export const uMoonColor = /*@__PURE__*/ uniform( 'vec3' );
export const uEyeHeight = /*@__PURE__*/ uniform( 1.0 );   // metres above sea level

// presets.js defaults: sunElevation 7.5 deg, sunAzimuth 55 deg.
uSunDir.value.set( 0.812146, 0.130526, - 0.568668 );
// presets.js defaults: moonElevation -20 deg, moonAzimuth 240 deg - below the
// horizon, so the default moon is off twice over.
uMoonDir.value.set( - 0.813798, - 0.342020, 0.469846 );
// Zero until set, which switches the moon march off through the same
// dot(uMoonColor, uMoonColor) > 1e-8 test the GLSL uses.
uMoonColor.value.set( 0.0, 0.0, 0.0 );

// Table dimensions, from src/sky.js. Exported because the driver needs them and
// because the mapping's resolution argument only makes sense next to them: 512
// columns is 0.70 degrees of azimuth per texel, and of the 256 rows of
// sqrt-latitude, 128 land inside 14.5 degrees of the horizon.
export const LUT_W = 512;
export const LUT_H = 256;

// Step counts, from SKY_LUT_FS. The moon gets half the sun's budget: it is two
// to three orders of magnitude dimmer, so the quantisation the shorter march
// leaves is below anything the eye or the tonemap can find.
export const LUT_STEPS_SUN  = 24;
export const LUT_STEPS_MOON = 12;

// Direction of the moon from the elevation/azimuth params, in the renderer's
// frame. This is moonDirOf() from src/sky.js and the identical three lines in
// derive() (src/derive.js:26-29) - the same vector by two routes, so either may
// be handed to setSkyLutUniforms(). The -cos(el)*cos(az) on z is the frame's
// convention, not a sign error: azimuth 0 looks down -Z.
export function moonDirOf( p ) {

	const D2R = Math.PI / 180;
	const el = p.moonElevation * D2R, az = p.moonAzimuth * D2R;

	return [ Math.cos( el ) * Math.sin( az ), Math.sin( el ), - Math.cos( el ) * Math.cos( az ) ];

}

// Mirror of the setUniforms() call in Sky.updateLUT (src/sky.js) - the same
// params object, the same four values, the same argument order.
//
// The shared atmosphere block is a separate call by design: setAtmosphereUniforms(p)
// from ./atmosphere.js has to happen too, and it is shared with the background,
// water and spray passes, so it is not this module's to own.
export function setSkyLutUniforms( p, sunDir, eyeHeight, moonDir = moonDirOf( p ) ) {

	uSunDir.value.set( sunDir[ 0 ], sunDir[ 1 ], sunDir[ 2 ] );
	uEyeHeight.value = eyeHeight;
	// Moonlight scatters through the same atmosphere; baking it into the LUT is
	// what keeps a night sky blue-dark and gives the water something to reflect
	// after sunset.
	uMoonDir.value.set( moonDir[ 0 ], moonDir[ 1 ], moonDir[ 2 ] );
	uMoonColor.value.set( p.moonColor[ 0 ], p.moonColor[ 1 ], p.moonColor[ 2 ] );

}

// ---- the mapping ------------------------------------------------------------
// SKY_LUT_MAP_GLSL, verbatim. Read the header before touching either function.
//
// TAU_A is atmosphere.js's 6.28318530718 - the same digits the GLSL spells
// inline here. It is imported rather than retyped so there is one place the
// constant lives.

// Maps a direction to LUT uv with extra resolution packed around the horizon.
//
//   vec2 dirToSkyUv(vec3 d){
//     float az = atan(d.z, d.x) / 6.28318530718 + 0.5;
//     float l = clamp(d.y, -1.0, 1.0);
//     float v = 0.5 + 0.5*sign(l)*sqrt(abs(l));
//     return vec2(az, v);
//   }
//
// atan(y, x) is the two-argument form. TSL's `atan` takes 1 or 2 arguments and
// emits `atan(y, x)` on GLSL and `atan2(y, x)` on WGSL (three r185,
// MathNode.js: `if (coordinateSystem === WebGPUCoordinateSystem && method ===
// ATAN && b !== null) method = 'atan2'`), so the branch cut and the sign
// convention are the platform's in both cases and match the GLSL's.
//
// The +0.5 puts the [-PI, PI] range of atan into [0, 1]; the seam at az = 0.5
// +/- 0.5 is why the table wraps REPEAT in u, so bilinear filtering blends
// across it instead of clamping to a smeared column.
export const dirToSkyUv = /*@__PURE__*/ Fn( ( [ d ] ) => {

	const az = atan( d.z, d.x ).div( TAU_A ).add( 0.5 );

	// The clamp is a guard against a direction that is a hair over unit length
	// from accumulated float error. |l| > 1 makes sqrt(|l|) > 1 and pushes v
	// outside [0,1], which walks off the CLAMP_TO_EDGE end of the table and
	// smears the last row across the zenith. It is not a range fit - a correctly
	// normalized direction never reaches the clamp.
	const l = clamp( d.y, - 1.0, 1.0 ).toVar();

	// Written 0.5*sign(l)*sqrt(|l|) + 0.5, the GLSL's own association. Scaling by
	// 0.5 is exact in binary float, so this is bit-identical either way, but the
	// order is kept so a diff against the GLSL reads as a transcription.
	const v = float( 0.5 ).mul( l.sign() ).mul( l.abs().sqrt() ).add( 0.5 );

	return vec2( az, v );

} );

// The exact inverse of dirToSkyUv, and the function the bake below uses to turn
// a texel into a ray.
//
//   vec3 skyUvToDir(vec2 uv){
//     float az = (uv.x - 0.5) * 6.28318530718;
//     float t = uv.y*2.0 - 1.0;
//     float l = sign(t)*t*t;
//     float r = sqrt(max(0.0, 1.0 - l*l));
//     return vec3(cos(az)*r, l, sin(az)*r);
//   }
//
// l = sign(t)*t*t undoes the sqrt: with t = sign(y)*sqrt(|y|) it gives
// sign(y)*|y| = y. The max(0.0, ...) before the sqrt is a domain guard for
// |l| = 1 (straight up or straight down), where 1 - l*l can land at -1e-17.
export const skyUvToDir = /*@__PURE__*/ Fn( ( [ uvIn ] ) => {

	const az = uvIn.x.sub( 0.5 ).mul( TAU_A ).toVar();
	const t = uvIn.y.mul( 2.0 ).sub( 1.0 ).toVar();
	const l = t.sign().mul( t ).mul( t ).toVar();
	const r = float( 1.0 ).sub( l.mul( l ) ).max( 0.0 ).sqrt().toVar();

	return vec3( az.cos().mul( r ), l, az.sin().mul( r ) );

} );

// ---- the bake ---------------------------------------------------------------

// SKY_LUT_FS's main(). Returns the vec4 the pass writes: linear HDR radiance in
// rgb, 1.0 in a.
//
//   void main(){
//     vec3 rd = skyUvToDir(vUv);
//     vec3 ro = vec3(0.0, R_PLANET + max(uEyeHeight, 1.0), 0.0);
//     vec3 col = skyScatter(ro, rd, uSunDir, uSunIrradiance, 24);
//     if (dot(uMoonColor, uMoonColor) > 1e-8 && uMoonDir.y > -0.25){
//       col += skyScatter(ro, rd, uMoonDir, uMoonColor, 12);
//     }
//     fragColor = vec4(col, 1.0);
//   }
//
// `uvIn` is the varying the GLSL called vUv - see USAGE at the top of the file
// for what it has to be.
export const skyLutFragment = /*@__PURE__*/ Fn( ( [ uvIn ] ) => {

	const rd = skyUvToDir( uvIn ).toVar();

	// The eye sits on the +Y axis at planet radius plus its height, and the ray
	// carries the whole direction - so the LUT is a function of direction alone
	// and one bake serves every pixel. max(h, 1.0) keeps the origin strictly
	// inside the atmosphere shell, which atmosDist() assumes.
	//
	// max(uEyeHeight,1.0).add(R_PLANET) rather than R_PLANET.add(...): float
	// addition is commutative exactly, and this way the JS constant folds in as
	// the literal the GLSL `const float` was.
	const ro = vec3( 0.0, uEyeHeight.max( 1.0 ).add( R_PLANET ), 0.0 ).toVar();

	const col = skyScatter( ro, rd, uSunDir, uSunIrradiance, int( LUT_STEPS_SUN ) ).toVar();

	// Moonlight is the same integral with a much dimmer, cooler source. It is
	// what keeps a night sky deep blue instead of pure black, and it is what the
	// water reflects, so it belongs in the LUT rather than the background pass.
	//
	// GLSL: `if (dot(uMoonColor, uMoonColor) > 1e-8 && uMoonDir.y > -0.25)`.
	// Nested rather than `&&` - see note 2 at the top of the file. The order of
	// the two tests is preserved even though nesting makes it irrelevant, so the
	// intent stays legible: the first is "is there a moon at all", the second is
	// "is it high enough for its light to reach this air" - -0.25 rather than 0
	// because a moon just below the horizon still lights the sky above it.
	If( uMoonColor.dot( uMoonColor ).greaterThan( 1e-8 ), () => {

		If( uMoonDir.y.greaterThan( - 0.25 ), () => {

			col.addAssign( skyScatter( ro, rd, uMoonDir, uMoonColor, int( LUT_STEPS_MOON ) ) );

		} );

	} );

	// No output guard here, deliberately: SKY_LUT_FS does not apply
	// HDR_OUTPUT_GUARD or any tonemap. The table stores raw linear radiance
	// because everything downstream - reflections, spray irradiance, the
	// background gradient - needs to scale and mix it before any display
	// transform touches it.
	return vec4( col, 1.0 );

} );


// THE LAYOUT RULE, LEARNED THE EXPENSIVE WAY: only PURE functions may carry a
// layout - parameters and literals only, no uniform and no texture reads.
// builder.buildFunctionNode caches the generated code per backend PER Fn, not
// per program (three.webgpu.js:52904). A layouted body that references a
// uniform bakes the FIRST program's binding name into the cached code; every
// later pipeline reuses it against its own, different bind layout. Measured:
// the sky LUT built first, the background pass reused densities()/extinctionAt()
// with the LUT's bindings, and every pixel came out wrong on WGSL (100%/16000)
// while GLSL misread 5% and failed to compile in dual-renderer pages. A pure
// function's code references nothing outside itself, so the cache is safe.
// ---- WGSL function layouts --------------------------------------------------
// setLayout() makes three compile a TSL Fn as a REAL shader function instead of
// inlining its body at every call site. This is not an optimisation nicety here,
// it is what lets the sky exist on iOS at all:
//
//   Three's WGSL builder declares every inlined node variable at MODULE scope as
//   var<private>, and WebKit enforces a hard 8192-byte budget on the private
//   address space. Fully inlined, the background pass emitted 1,891 private vars
//   (~17.5 KB) - the light-cone unroll alone inlines the cloud density evaluator
//   ten times - and WebKit refused the pipeline:
//
//     "The combined byte size of all variables in the private address space
//      exceeds 8192 bytes"      (captured from an iPhone by the app's own panel)
//
//   As real functions, locals live in FUNCTION address space, outside that
//   budget, and each helper has one body instead of N inlined copies. Chromium
//   imposes no such limit, which is why nothing here ever caught it.
//
// Layout names carry the abyssal prefix so they cannot collide with three's own
// layouted helpers in the same shader module.

dirToSkyUv.setLayout( { name: 'abyssal_dirToSkyUv', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );
skyUvToDir.setLayout( { name: 'abyssal_skyUvToDir', type: 'vec3', inputs: [ { name: 'uvIn', type: 'vec2' } ] } );
