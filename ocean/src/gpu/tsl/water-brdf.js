// The water BRDF in TSL — the reflectance layer of the ocean surface shader.
// Ported from WATER_FS lines 177-239 (src/shaders/water.js): the roughness-to-mip
// sky fetch, both GGX normal distributions, both Smith visibility terms, the
// exact unpolarised dielectric Fresnel, and the environment Fresnel that widens
// the cosine by the slope spread.
//
// One source, both backends: no wgslFn, no glslFn. See docs/webgpu-port.md and
// docs/tsl-porting-rules.md.
//
// Everything here is a pure function of its arguments plus ONE uniform
// (uSkyBlur). Nothing in this file reads the surface, the cascades, the lights
// or the wake — that is water-surface.js's job, and every call site lives there.
// ./water-common.js holds the cascade sampling and the constants; ./water-detail.js
// holds the procedural detail fields.
//
// ---------------------------------------------------------------------------
// SIX THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. NAME COLLISION: THERE ARE TWO `sampleSky`s.
//
//    ./sky-background.js exports `sampleSky( rd )` — one argument, always
//    explicit LOD 0, used for the sky *background* pixel and for the cloud
//    march's ambient taps.
//
//    THIS module exports `sampleSky( rd, alpha )` — two arguments, picking a mip
//    from the GGX lobe width. It is the water's reflection fetch and it is a
//    different function with a different job.
//
//    water-surface.js must import `sampleSky` FROM HERE, and must import only
//    `skyLutTexture` from sky-background.js. Importing the wrong one compiles
//    fine and renders the far sea as a boiling mirror instead of a blurred one.
//
//    The two share the TextureNode deliberately: setSkyLut() in sky-background.js
//    points `skyLutTexture` at the baked LUT and both passes then read the same
//    table, which is exactly what the GLSL's single `uniform sampler2D uSkyLUT`
//    does across the two programs.
//
// 2. THIS MODULE DOES NOT DECLARE uWaterIOR, ON PURPOSE.
//
//    fresnelDielectric and envFresnel take the index of refraction as their
//    `eta` parameter, exactly as the GLSL does. The uniform itself lives in
//    water-surface.js, where all four call sites are (water.js:622, 638, 673).
//    Do not add a second copy here — two uniforms with one name is the failure
//    mode porting rule 7 exists to prevent.
//
// 3. fresnelDielectric IS THE ONE NaN HAZARD IN THIS FILE, and the If/Else it
//    is written with is load-bearing rather than stylistic. `sqrt(g2)` with
//    g2 < 0 is a NaN, a NaN comparison is false, and the NaN would then flow
//    through the specular sum into the final colour. So the result var carries
//    the total-internal-reflection value 1.0 and the sqrt lives on the safe
//    branch — the same shape ./atmosphere.js's planetDist uses for exactly the
//    same reason (atmosphere.js:158-191).
//
//    This is precisely the case sky-background.js's note 4 excludes: the
//    "evaluate unconditionally and multiply by zero" trick is only safe where
//    the divisions are already guarded, and here they are not.
//
// 4. D_GGX IS NOT D_GGXAniso WITH ZERO TANGENTIAL COMPONENTS. The GLSL comment
//    at water.js:193-197 is a defect report, not a note, and it is carried
//    across below. Both functions are exported and the two call sites use
//    different ones (the sea uses the aniso pair, the foam the isotropic pair).
//
// 5. V_SmithAniso's ARGUMENT ORDER IS (NoV, NoL, ToV, BoV, ToL, BoL, ax, ay),
//    which is the GLSL's declaration at water.js:209-210 verbatim. Read it as
//    three pairs, NOT as "view terms then light terms":
//
//      NoV, NoL    the two NORMAL dots, view first
//      ToV, BoV    the tangent/bitangent dots for the VIEW direction
//      ToL, BoL    the same two for the LIGHT direction
//      ax, ay      the along- and cross-wind alphas
//
//    So the view and light terms interleave at the front and separate after.
//    Swapping the ToV/BoV pair with the ToL/BoL pair is silent and wrong: the
//    function stays symmetric-looking, and the masking term is subtly off
//    everywhere the view and light directions differ, which is everywhere.
//
// 6. PI IS PI_W, NOT PI_A. WATER_FS declares its own `const float PI =
//    3.14159265` (water.js:177) — three digits SHORTER than ./atmosphere.js's
//    PI_A = 3.14159265359. The port has to reproduce the digits that shipped, so
//    both D functions use PI_W from ./water-common.js. Importing PI_A instead is
//    a last-ulp drift through every specular denominator in the shader, and it
//    is invisible until a pixel diff.
//
// The `max(..., 1e-9)` / `max(..., 1e-6)` denominators in all four D/V functions
// are divide-by-zero guards, not tuning. 1e-9 for both D, 1e-6 for both V, kept
// exactly. (Porting rule 2 — min/max with a scalar second operand breaking
// WebGL2 — does not apply to any of them: every one of these is a FLOAT max with
// a float literal, and the rule is about an INT first operand.)

import { Fn, If, float, vec3, uniform, clamp } from 'three/tsl';

import { PI_W } from './water-common.js';
import { dirToSkyUv } from './sky-lut.js';
import { skyLutTexture } from './sky-background.js';

// ---- uniforms ---------------------------------------------------------------
// The only uniform this module owns. Default is src/presets.js's skyBlur.

export const uSkyBlur = /*@__PURE__*/ uniform( 0.5 );

// ---- the reflection fetch ---------------------------------------------------

// The LUT wraps 2*pi of azimuth into 512 texels, so one texel subtends about
// 0.0123 rad. Matching the GGX lobe width to a mip level is what keeps the far
// sea a smooth blurred mirror instead of either boiling noise or a grey average.
//
//   vec3 sampleSky(vec3 rd, float alpha){
//     float lod = clamp(log2(1.0 + alpha * 81.0 * uSkyBlur), 0.0, 7.0);
//     return textureLod(uSkyLUT, dirToSkyUv(rd), lod).rgb;
//   }
//
// The 0..7 clamp is the LUT's mip chain (512x256 -> 4x2 at level 7) and the 81.0
// is matched to that texel angle; both are pinned to the table's dimensions in
// ./sky-lut.js, not free parameters.
//
// `rd` MUST ALREADY BE NORMALIZED. dirToSkyUv does not normalize its argument —
// it reads d.y as a sine directly (see note 1 in ./sky-lut.js) — so an
// unnormalized direction does not fail, it silently reads the wrong latitude.
// The GLSL call sites pass normalize(R) and reflect(-V, Nfoam) of unit vectors;
// the TSL ones must keep doing so.
//
// .level(lod) is the GLSL's textureLod, and it is also what keeps this legal:
// the sea's call site sits inside no branch but the foam's is inside
// `if (foamMask > 0.003)`, which is not uniform control flow, so an implicit
// derivative there would be illegal on WGSL.
export const sampleSky = /*@__PURE__*/ Fn( ( [ rd, alpha ] ) => {

	const lod = clamp( float( 1.0 ).add( alpha.mul( 81.0 ).mul( uSkyBlur ) ).log2(), 0.0, 7.0 ).toVar();

	return skyLutTexture.sample( dirToSkyUv( rd ) ).level( lod ).rgb;

} );

// ---- normal distributions ---------------------------------------------------

// Anisotropic GGX. The two alphas come from the along-wind and cross-wind slope
// variances, and their inequality is precisely what stretches the glitter path.
//
//   float D_GGXAniso(float NoH, float ToH, float BoH, float ax, float ay){
//     float d = ToH*ToH/(ax*ax) + BoH*BoH/(ay*ay) + NoH*NoH;
//     return 1.0 / max(PI * ax * ay * d * d, 1e-9);
//   }
export const D_GGXAniso = /*@__PURE__*/ Fn( ( [ NoH, ToH, BoH, ax, ay ] ) => {

	const d = ToH.mul( ToH ).div( ax.mul( ax ) )
		.add( BoH.mul( BoH ).div( ay.mul( ay ) ) )
		.add( NoH.mul( NoH ) ).toVar();

	// PI * ax * ay * d * d, left-to-right, the GLSL's own association.
	return float( 1.0 ).div( float( PI_W ).mul( ax ).mul( ay ).mul( d ).mul( d ).max( 1e-9 ) );

} );

// Isotropic GGX. D_GGXAniso cannot stand in for this by passing zero tangential
// components: with ToH = BoH = 0 its denominator collapses to NoH^4, so D grows
// without bound as the half-vector tips toward the horizon instead of falling
// off. That is a five-order-of-magnitude error at grazing incidence, which is
// most of a seascape.
//
//   float D_GGX(float NoH, float a){
//     float a2 = a*a;
//     float d  = NoH*NoH*(a2 - 1.0) + 1.0;
//     return a2 / max(PI * d * d, 1e-9);
//   }
export const D_GGX = /*@__PURE__*/ Fn( ( [ NoH, a ] ) => {

	const a2 = a.mul( a ).toVar();
	const d = NoH.mul( NoH ).mul( a2.sub( 1.0 ) ).add( 1.0 ).toVar();

	return a2.div( float( PI_W ).mul( d ).mul( d ).max( 1e-9 ) );

} );

// ---- visibility (Smith, height-correlated, already divided by 4 NoL NoV) ----

//   float V_SmithGGX(float NoV, float NoL, float a){
//     float a2 = a*a;
//     float lv = NoL * sqrt(NoV*NoV*(1.0 - a2) + a2);
//     float ll = NoV * sqrt(NoL*NoL*(1.0 - a2) + a2);
//     return 0.5 / max(lv + ll, 1e-6);
//   }
//
// Neither sqrt can go negative — a2*(1 - x*x) + x*x is non-negative for any
// a2 >= 0 — so unlike fresnelDielectric there is nothing here to guard.
export const V_SmithGGX = /*@__PURE__*/ Fn( ( [ NoV, NoL, a ] ) => {

	const a2 = a.mul( a ).toVar();
	const lv = NoL.mul( NoV.mul( NoV ).mul( float( 1.0 ).sub( a2 ) ).add( a2 ).sqrt() ).toVar();
	const ll = NoV.mul( NoL.mul( NoL ).mul( float( 1.0 ).sub( a2 ) ).add( a2 ).sqrt() ).toVar();

	return float( 0.5 ).div( lv.add( ll ).max( 1e-6 ) );

} );

//   float V_SmithAniso(float NoV, float NoL, float ToV, float BoV, float ToL, float BoL,
//                      float ax, float ay){
//     float lv = NoL * length(vec3(ax*ToV, ay*BoV, NoV));
//     float ll = NoV * length(vec3(ax*ToL, ay*BoL, NoL));
//     return 0.5 / max(lv + ll, 1e-6);
//   }
//
// ARGUMENT ORDER: all four VIEW terms (NoV, ToV, BoV) before all four LIGHT
// terms (NoL, ToL, BoL) — see note 5 at the top. The GLSL's own declaration
// interleaves NoV, NoL first and then ToV, BoV, ToL, BoL; that order is
// reproduced exactly.
export const V_SmithAniso = /*@__PURE__*/ Fn( ( [ NoV, NoL, ToV, BoV, ToL, BoL, ax, ay ] ) => {

	const lv = NoL.mul( vec3( ax.mul( ToV ), ay.mul( BoV ), NoV ).length() ).toVar();
	const ll = NoV.mul( vec3( ax.mul( ToL ), ay.mul( BoL ), NoL ).length() ).toVar();

	return float( 0.5 ).div( lv.add( ll ).max( 1e-6 ) );

} );

// ---- Fresnel ----------------------------------------------------------------

// Exact unpolarised dielectric Fresnel. Schlick agrees at normal incidence but
// drifts a few percent through 50-80 degrees, and that band is most of the sea's
// visible area at any camera height a human would use, so it is worth the sqrt.
//
//   float fresnelDielectric(float c, float eta){
//     float g2 = eta*eta - 1.0 + c*c;
//     if (g2 <= 0.0) return 1.0;
//     float g = sqrt(g2);
//     float a = (g - c) / (g + c);
//     float b = (c*(g + c) - 1.0) / (c*(g - c) + 1.0);
//     return clamp(0.5*a*a*(1.0 + b*b), 0.0, 1.0);
//   }
//
// g2 <= 0 is total internal reflection, where the exact answer is 1.0. The early
// return becomes a result var and the sqrt goes on the Else branch — see note 3
// at the top of the file. This is the one place in the four water modules where
// the branch is protecting a value, not just saving work.
export const fresnelDielectric = /*@__PURE__*/ Fn( ( [ c, eta ] ) => {

	const g2 = eta.mul( eta ).sub( 1.0 ).add( c.mul( c ) ).toVar();

	const r = float( 1.0 ).toVar();
	If( g2.lessThanEqual( 0.0 ), () => {

		r.assign( 1.0 );

	} ).Else( () => {

		const g = g2.sqrt().toVar();
		const a = g.sub( c ).div( g.add( c ) ).toVar();
		const b = c.mul( g.add( c ) ).sub( 1.0 ).div( c.mul( g.sub( c ) ).add( 1.0 ) ).toVar();

		r.assign( clamp( float( 0.5 ).mul( a ).mul( a ).mul( float( 1.0 ).add( b.mul( b ) ) ), 0.0, 1.0 ) );

	} );

	return r;

} );

// Environment Fresnel. The usual split-sum fits (and the max(1-rough, f0) fudge)
// both collapse toward f0 at grazing on a rough surface, but a wind-blown sea is
// emphatically near-mirror at 85 degrees - that is the entire reason the far
// water reads as sky rather than as haze. The one real correction is that the
// facets you can still see at grazing are the ones tilted toward you, so the
// mean incidence is shallower than the macroscopic angle by roughly the slope
// spread. Widening the cosine by alpha^2 says exactly that, and it is why a
// glassy dawn mirrors the horizon while a storm sea stays grey there.
//
//   vec3 envFresnel(float NoV, float alpha, float eta){
//     float c = clamp(NoV + 0.5*alpha*alpha*(1.0 - NoV), 0.0, 1.0);
//     return vec3(fresnelDielectric(c, eta));
//   }
//
// The return is a splat of a scalar. `vec3( floatNode )` builds a ConvertNode
// that NodeBuilder.format emits as `vec3( x )` on GLSL and `vec3<f32>( x )` on
// WGSL — one evaluation, splatted, on both backends (three r185,
// NodeBuilder.js:3419-3428). It is not three separate calls.
export const envFresnel = /*@__PURE__*/ Fn( ( [ NoV, alpha, eta ] ) => {

	const c = clamp(
		NoV.add( float( 0.5 ).mul( alpha ).mul( alpha ).mul( float( 1.0 ).sub( NoV ) ) ),
		0.0, 1.0,
	).toVar();

	return vec3( fresnelDielectric( c, eta ) );

} );

// ---- uniform plumbing -------------------------------------------------------

// Mirror of the uniform block in WaterSurface.render (src/water.js:137-180),
// restricted to what this module owns — which is one value. The driver calls
// this alongside setWaterCommonUniforms, setWaterDetailUniforms and
// setWaterSurfaceUniforms, exactly as the GLSL shares one uniform block per
// concern across its programs.
export function setWaterBrdfUniforms( p ) {

	uSkyBlur.value = p.skyBlur;

}
