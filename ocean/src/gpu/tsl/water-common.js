// The water pass's shared foundation in TSL: the cascade fade weight, the two
// cascade accumulation loops, the wake field sampler, and every uniform more
// than one water module reads.
//
// Ported from three places in the shipping GLSL, all of which the water vertex
// and fragment programs share verbatim today:
//
//   CASCADE_COMMON      src/shaders/water.js:7-25    (uniform block + cascadeWeight)
//   WAKE_SAMPLE_GLSL    src/wake.js:33-75            (uniform block + wakeAt)
//   the vertex cascade loop     WATER_VS:66-84
//   the fragment cascade loop   WATER_FS:355-376
//
// One source, both backends: Three compiles these node graphs to WGSL on WebGPU
// and to GLSL on WebGL2. No wgslFn, no glslFn - a raw-source node compiles for
// exactly one backend and would put the fallback back where it started
// (docs/webgpu-port.md).
//
// The physics is unchanged. Every constant, sign, clamp and magic number below
// is the one that shipped, and the GLSL comments explaining *why* each is what
// it is are carried across with them. Several of these numbers look arbitrary
// and are not, so the comment is load-bearing documentation, not decoration.
//
// Consumers: ./water-brdf.js (PI_W), ./water-detail.js (uWindDir, uPatch,
// uHeightScale, dispTexture), ./water-surface.js (everything else). Nothing in
// this file imports any of them - the dependency order is
// water-common <- {water-brdf, water-detail} <- water-surface, no cycles.
//
// ---------------------------------------------------------------------------
// WHY THE TWO CASCADE LOOPS LIVE HERE AND NOT IN water-surface.js
//
// They are the only readers of uPatch / uFade / uCascadeCount / uDetailScale /
// uHorizScale, and cascadeWeight is their only caller. Keeping the four
// together is what lets water-surface.js import six numbers instead of five
// uniforms and a sampler array.
//
// ---------------------------------------------------------------------------
// EIGHT THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. uWindDir IS NOT cloud-field.js's uWindDirV, AND MUST NEVER BE IMPORTED
//    FROM THERE. They are different physical quantities that happen to share a
//    name in the GLSL:
//
//      cloud-field.js  uWindDirV : vec3 = (cos(wd)*windSpeed, 0, sin(wd)*windSpeed)
//                                  a wind VELOCITY in m/s (src/derive.js:31-34)
//      water           uWindDirV : vec2 = (cos(p.windDir), sin(p.windDir))
//                                  a UNIT DIRECTION (src/water.js:166)
//
//    At the default windSpeed of 11 they differ by a factor of 11. Water uses
//    the vector in three places where unit length is assumed and the magnitude
//    is load-bearing: `dot(slope, uWindDirV)*2.0` in the capillary amplitude
//    (WATER_FS:388), `vec2(dot(p,w), dot(p,q))` as an orthonormal frame in
//    capillarySlope and foamField, and `wind3` as the tangent seed for T.
//    Feeding it a velocity would multiply the capillary windward bias by 11 and
//    rescale the capillary and foam lattices by the wind speed - a silent,
//    preset-dependent wrong image, not a crash.
//
//    Deriving it as `uWindDirV.xz.normalize()` was considered and rejected: it
//    is not bit-identical to the CPU's cos/sin, and it is a 0/0 NaN at
//    windSpeed 0, which is a legal parameter value.
//
//    So the node here is named `uWindDir`, not `uWindDirV`, deliberately: an
//    accidental `import { uWindDirV } from './cloud-field.js'` in a water
//    module is then a visible mistake rather than a plausible-looking one. Both
//    modules' setters read values derive() writes from the same p.windDirDeg, so
//    they cannot drift: setWaterCommonUniforms reads p.windDir (the radian value
//    derive.js writes back into p) and setCloudUniforms reads ctx.windVec3 (which
//    derive.js fills). Neither reads p.windDirDeg directly - derive() is the one
//    place it is consumed, and that is what keeps the two consistent.
//
// 2. BOTH CASCADE LOOPS ARE UNROLLED IN JS, `for (let c = 0; c < CASCADE_CAP; c++)`.
//    That is porting rule 6's "small fixed loops are unrolled in JS when the
//    index only picks compile-time constants": c picks the uniformArray element
//    AND the texture-array layer, and both must be constant. The GLSL's
//    `if (c >= uCascadeCount) break;` becomes `If( int(c).lessThan(uCascadeCount),
//    () => { ...whole body... } )` per unrolled block - value-equivalent,
//    because on the skipped iterations the GLSL body never ran either, so no
//    accumulator is touched. The vertex loop's `if (w <= 0.001) continue;` is a
//    second, nested If around the rest of that block, which is what a continue
//    at the top of a loop body means.
//
// 3. cascadeWeight IS A PLAIN JS FUNCTION AND MUST NOT BECOME AN Fn. Its first
//    argument is a JS integer that indexes a uniformArray; an Fn would turn it
//    into a node and the index would stop being a compile-time constant.
//    sampleCascadeDisp and sampleCascadeSurface are plain JS node-graph
//    builders for the same class of reason - they return five and seven values
//    respectively and no packing fits, so they follow the aerialPerspective
//    precedent (atmosphere.js:440) and hand back an object of .toVar() nodes.
//    That costs nothing: an Fn without a layout is inlined at its call site
//    anyway, so this emits exactly what an Fn would have. It does mean they
//    MUST be called from inside an Fn body - they append to the current TSL
//    stack, so calling one at module scope has nothing to append to.
//
// 4. WHERE .level() GOES IS DECIDED BY THE STAGE, NOT BY TASTE.
//      Vertex stage (sampleCascadeDisp): ALWAYS .level(0). There are no
//        derivatives there, and GLSL ES 3.00's texture() in a vertex shader
//        reads level 0, so the explicit form is exactly equivalent.
//      Fragment stage, uniform control flow, mip chain wanted (uSlope/uFoam in
//        sampleCascadeSurface): implicit, no .level(). The mip chain IS the
//        filtering that matters. uCascadeCount is a uniform, so WGSL's
//        uniformity analysis classifies the enclosing If as uniform control
//        flow and the implicit derivative is legal.
//      wakeAt: ALWAYS .level(0), in BOTH stages. Three reasons, all pointing
//        the same way: (a) the vertex stage has no derivatives; (b) in the
//        fragment stage wakeAt is called from inside `if (uWakeOn > 0.5)` and
//        `if (k > 0.004)`, and k depends on the pixel footprint, so the control
//        flow is NOT uniform and an implicit fetch would be illegal on WGSL;
//        (c) it is value-identical, because src/wake.js builds uWakeTex with
//        filter LINEAR and no mip chain, so an implicit fetch reads level 0
//        anyway.
//
//    IF a WGSL uniformity error ever does appear on the two implicit fetches in
//    sampleCascadeSurface, the fix is to hoist both out of the If and gate all
//    six accumulator terms by `select(int(c).lessThan(uCascadeCount), 1.0, 0.0)`
//    - equivalent, because c never exceeds the four real layers. Do not reach
//    for that first.
//
// 5. swellH IS UNWEIGHTED. The vertex loop accumulates `d.y * uHeightScale`,
//    NOT `dd.y`: the cascade weight w is deliberately absent. Getting this
//    wrong changes the reference height the fragment shader's shadow march
//    compares against, which shows up as swell shadows creeping the wrong way
//    with distance rather than as anything that looks like a bug.
//
// 6. foamT IS ACCUMULATED AND NEVER READ - in the GLSL too (declared
//    water.js:359, written 372, never used again). It is returned anyway. The
//    fidelity of the transcription is the point; "cleaning it up" makes the
//    next diff against the GLSL harder to read for no gain.
//
// 7. THE TWO `||` CHAINS IN wakeAt BECOME THEIR POSITIVE COMPLEMENTS WITH
//    .and(), which is what sky-background.js's cirrusLayer does. TSL has no
//    short-circuiting operator, but neither test here can produce a NaN, so
//    there is nothing for a short-circuit to protect. Both of the GLSL's early
//    `return vec3(0.0)` paths are simply the untouched initial value of the
//    result var.
//
// 8. `.mix()` IS BANNED. There are no blends in this file today, but if one
//    lands here: `mixElement = (t, e1, e2) => mix(e1, e2, t)`, so the RECEIVER
//    IS THE FACTOR and `col.mix(target, alpha)` computes mix(target, alpha,
//    col). Standalone mix(a, b, t) only. Porting rule 1; it is the defect that
//    cost the sky port the most time.

import {
	Fn, If, float, int, vec2, vec3,
	uniform, uniformArray, texture, smoothstep, clamp,
} from 'three/tsl';

import {
  DataTexture, DataArrayTexture, RGBAFormat, FloatType,
  LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, ClampToEdgeWrapping,
} from 'three';

import { R_PLANET } from './atmosphere.js';
import { clamp as clampJS } from '../../math.js';

// ---- constants --------------------------------------------------------------

// WATER_FS's own `const float PI` (src/shaders/water.js:177).
//
// THIS IS NOT atmosphere.js's PI_A. PI_A is 3.14159265359; the water shader
// spells 3.14159265, three digits shorter, and those are the digits that
// shipped. Importing PI_A instead is a silent last-ulp drift through every
// specular denominator in ./water-brdf.js and every irradiance division in
// ./water-surface.js. Every water module uses this one.
export const PI_W = 3.14159265;

// WATER_VS:56, `const float R_EARTH = 6371000.0`. Identical to atmosphere.js's
// R_PLANET, which the water fragment shader already uses under that name (it
// includes ATMOSPHERE_GLSL), so it is imported rather than respelled - one home
// for the number, and the alias keeps the vertex-stage code reading like the
// GLSL it came from.
export const R_EARTH = R_PLANET;

// The GLSL's `for (int c=0;c<4;c++)` bound, in both stages. This is the JS
// unroll bound - see note 2 in the header.
export const CASCADE_CAP = 4;

// ---- uniforms ---------------------------------------------------------------
// Defaults are the shipping defaults from src/presets.js and src/ocean.js, so
// this module evaluates to a sane sea before anything has called
// setWaterCommonUniforms().

// GLSL `uniform float uPatch[4]` - the cascade patch sizes in metres.
// Default = ocean.js DEFAULT_CASCADES. Access ONLY with a compile-time constant
// index: uPatch.element( int( c ) ) where c is a JS number.
export const uPatch = /*@__PURE__*/ uniformArray( [ 3137.0, 397.0, 87.0, 17.3 ], 'float' );

// GLSL `uniform float uFade[4]` - the distance each cascade dies out over.
// Default = clamp(DEFAULT_CASCADES[i]*38, 200, 60000), i.e. what
// fadeDistances() below computes from a default Ocean.
export const uFade = /*@__PURE__*/ uniformArray( [ 60000.0, 15086.0, 3306.0, 657.4 ], 'float' );

// Compared against only, never fed to min/max - porting rule 2 (a scalar second
// operand of min/max on an int builds as float and GLSL ES 3.00 has no
// min(int, float) overload, so it breaks WebGL2 while WebGPU is fine).
export const uCascadeCount = /*@__PURE__*/ uniform( 4, 'int' );

export const uDetailScale = /*@__PURE__*/ uniform( 1.0 );
// Read by sampleCascadeDisp here AND by sunVisibility in ./water-detail.js -
// the shadow march reads the same height field the vertex stage displaced by,
// which is the whole reason this uniform is shared rather than owned by one of
// them (water.js:173).
export const uHeightScale = /*@__PURE__*/ uniform( 1.0 );
export const uHorizScale = /*@__PURE__*/ uniform( 1.0 );

// See note 1 in the header. vec2(cos(p.windDir), sin(p.windDir)), a UNIT
// direction. The default is windDirDeg 42: cos = 0.7431448, sin = 0.6691306.
export const uWindDir = /*@__PURE__*/ uniform( 'vec2' );
uWindDir.value.set( 0.7431448, 0.6691306 );

// ---- wake uniforms ----------------------------------------------------------
// WAKE_SAMPLE_GLSL's block (src/wake.js:34-37), which the vertex and fragment
// stages share so that one displaces the surface by exactly the pattern the
// other lights. Defaults are src/presets.js's, except uWakeOn, which defaults
// to the inert 0 so nothing has to be bound before the first frame.

export const uWakeOrigin = /*@__PURE__*/ uniform( 'vec2' );   // src/wake.js Wake.origin
export const uWakeExtent = /*@__PURE__*/ uniform( 320.0 );    // presets.js wakeExtent
export const uWakeOn = /*@__PURE__*/ uniform( 0.0 );          // 0 = no wake
export const uWakeLife = /*@__PURE__*/ uniform( 14.0 );       // presets.js wakeLife
export const uWakeArmW = /*@__PURE__*/ uniform( 1.5 );        // presets.js wakeWidth
// Fraction of the wake buffer's border feathered out, so the field's square
// world-space edge never reads as a ruled line. presets.js wakeEdgeFade.
export const uWakeEdge = /*@__PURE__*/ uniform( 0.12 );
export const uWakeArm = /*@__PURE__*/ uniform( 1.0 );         // presets.js wakeArm
export const uWakeChurn = /*@__PURE__*/ uniform( 0.5 );       // presets.js wakeCentre
export const uWakeSpread = /*@__PURE__*/ uniform( 0.22 );     // presets.js wakeSpread
export const uWakeBeam = /*@__PURE__*/ uniform( 0.96 );       // max(p.wrBeam, 0.3) * 1.6
export const uWakeDepth = /*@__PURE__*/ uniform( 0.45 );      // presets.js wakeDepth
export const uWakeStrength = /*@__PURE__*/ uniform( 1.15 );   // presets.js wakeStrength

// ---- textures ---------------------------------------------------------------
// Four TextureNodes whose values the driver swaps for the real fields. The
// placeholders keep the graph buildable before an Ocean has run, so a compile
// probe does not need a renderer first - the same arrangement sky-background.js
// uses for the sky LUT.
//
// TextureNode.sample()/depth()/level() each return a CLONE whose value getter
// follows the base node (`referenceNode = this.getBase()`), so assigning
// dispTexture.value after the graph is built updates every fetch derived from
// it. The placeholder must still be the right CLASS and the right TYPE: a
// DataArrayTexture is what makes the sampler come out as sampler2DArray on
// GLSL and texture_2d_array<f32> on WGSL, and FloatType is what makes the
// fetch's node type vec4 rather than ivec4/uvec4.

function arrayPlaceholder() {

	// 1x1x4 RGBA float zeros - one layer per cascade, so the layer index range
	// is legal even before the real fields are bound.
	const t = new DataArrayTexture( new Float32Array( 4 * 4 ), 1, 1, CASCADE_CAP );
	t.format = RGBAFormat;
	t.type = FloatType;

	// THE FILTER STATE IS NOT COSMETIC ON WGSL - IT PICKS THE INSTRUCTION.
	//
	// WGSLNodeBuilder.isUnfilterable (three.webgpu.js:79067) returns true when
	// minFilter AND magFilter are both NearestFilter, and generateTextureLevel
	// then emits `textureLoad(...)` instead of `textureSampleLevel(...)`. That
	// choice is made when the node graph is BUILT, from whatever texture is bound
	// at that moment - not at draw time. DataArrayTexture defaults to
	// NearestFilter on both, so a material built before setCascadeTextures() runs
	// would bake an unfiltered nearest-texel fetch into the shader and keep it
	// after the real, LINEAR, mipped fields are bound.
	//
	// WebGL2 is unaffected - it resolves the sampler per draw - so this is the
	// "compiles on both, wrong image on one" class, and the one it is wrong on is
	// the backend this port is for.
	//
	// So the placeholder carries the real fields' sampling state: src/ocean.js
	// builds disp/slope/foam with LINEAR filtering, REPEAT wrap and mips.
	t.minFilter = LinearMipmapLinearFilter;
	t.magFilter = LinearFilter;
	t.wrapS = t.wrapT = RepeatWrapping;
	t.generateMipmaps = false;   // there is nothing to mip in a 1x1
	t.needsUpdate = true;
	return t;

}

// GLSL uDisp (sampler2DArray).
export const dispTexture = /*@__PURE__*/ texture( /*@__PURE__*/ arrayPlaceholder() );
// GLSL uSlope (sampler2DArray). The REAL one MUST be mipped: sampleCascadeSurface
// reads textureLod(..., 8.0) out of it for the variance the cascade fade threw
// away, and it takes the implicit-LOD fetch for the slope itself.
export const slopeTexture = /*@__PURE__*/ texture( /*@__PURE__*/ arrayPlaceholder() );
// GLSL uFoam (sampler2DArray).
export const foamTexture = /*@__PURE__*/ texture( /*@__PURE__*/ arrayPlaceholder() );

const wakePlaceholder = /*@__PURE__*/ ( () => {

	const t = new DataTexture( new Float32Array( [ 0, 0, 0, 0 ] ), 1, 1, RGBAFormat, FloatType );
	// Same reason as arrayPlaceholder above: the filter state chosen here decides
	// whether WGSL emits textureSampleLevel or textureLoad. src/wake.js builds the
	// real field LINEAR with no mipmaps.
	t.minFilter = LinearFilter;
	t.magFilter = LinearFilter;
	t.wrapS = t.wrapT = ClampToEdgeWrapping;
	t.needsUpdate = true;
	return t;

} )();

// GLSL uWakeTex (sampler2D). No mip chain, matching src/wake.js, which builds
// the real one filter LINEAR with no mipmaps.
export const wakeTexture = /*@__PURE__*/ texture( wakePlaceholder );

// Point the three cascade samplers at an Ocean's real DataArrayTextures. Any
// field left undefined is not touched, so a partial call cannot silently unbind
// the others.
export function setCascadeTextures( { disp, slope, foam } = {} ) {

	if ( disp !== undefined ) dispTexture.value = disp;
	if ( slope !== undefined ) slopeTexture.value = slope;
	if ( foam !== undefined ) foamTexture.value = foam;

}

// Point the wake sampler at Wake.field, or back at the inert 1x1 when there is
// no wake. A sampler has to be bound either way, because it exists in the
// compiled program whatever uWakeOn says (src/water.js:55-72 makes the same
// point about the GLSL path).
export function setWakeTexture( tex ) {

	wakeTexture.value = tex || wakePlaceholder;

}

// ---- cascade weight ---------------------------------------------------------

// A cascade has to die out gradually or its fade prints a horizontal seam
// straight across the sea at the distance it switches off. The old window was
// half an octave wide and ended early enough that the last kilometre before the
// horizon had nothing left but the swell; running it from 0.55f to 1.6f is three
// times wider and reaches past the horizon of any sensible eye height. There is
// no aliasing cost: at that range the band's amplitude is far below one pixel,
// so it contributes nothing to the silhouette and everything to the statistics.
//
//   float cascadeWeight(int c, float dist){
//     float f = uFade[c] * uDetailScale;
//     return 1.0 - smoothstep(f*0.55, f*1.6, dist);
//   }
//
// PLAIN JS FUNCTION, NOT an Fn - see note 3 in the header. `c` is a JS integer
// 0..3 known at build time; `dist` is a float node. Returns a float node.
//
// Like the two loop builders below it must be called from inside an Fn body:
// the GLSL's `float f` is a `.toVar()` here, and a var needs a TSL stack to be
// appended to.
export function cascadeWeight( c, dist ) {

	const f = cascadeArrayElement( uFade, c ).mul( uDetailScale ).toVar();

	return float( 1.0 ).sub( smoothstep( f.mul( 0.55 ), f.mul( 1.6 ), dist ) );

}

// uniformArray.element() builds its index as `uint` unless the index node is
// already an integer type, which would emit `uPatch[ uint( 0.0 ) ]`. Wrapping
// the JS number in int() keeps the generated index a plain integer literal on
// both backends. One helper so the three call sites cannot disagree.
function cascadeArrayElement( arr, c ) {

	return arr.element( int( c ) );

}

// ---- the vertex-stage cascade loop ------------------------------------------

// WATER_VS:66-84.
//
//   vec3 disp = vec3(0.0);
//   float relief = 0.0;
//   float swellH = 0.0;
//   for (int c=0;c<4;c++){
//     if (c >= uCascadeCount) break;
//     float w = cascadeWeight(c, r);
//     if (w <= 0.001) continue;
//     vec4 d = texture(uDisp, vec3(xz / uPatch[c], float(c)));
//     vec3 dd = vec3(d.x*uHorizScale, d.y*uHeightScale, d.z*uHorizScale) * w;
//     disp += dd;
//     // Cascade 0 is the swell; everything above it is the local relief riding on
//     // top of it. Occlusion and subsurface glow care about that relief, not about
//     // how high the whole swell has lifted this patch of sea.
//     if (c > 0) relief += dd.y;
//     // The two longest cascades are the only ones that cast a shadow wider than
//     // a pixel; the fragment shader marches exactly this height field.
//     if (c < 2) swellH += d.y * uHeightScale;
//   }
//
// PLAIN JS NODE-GRAPH BUILDER, NOT an Fn. Call it from inside an Fn body:
//
//   const { disp, relief, swellH } = sampleCascadeDisp( xz, r );
//
// xz is the UNDISPLACED grid point (vec2 node), r the radial distance (float
// node). Returns disp as a vec3 .toVar() and relief/swellH as float .toVar()s,
// all three still mutable by the caller.
export function sampleCascadeDisp( xz, r ) {

	// Pinned because an Fn without a layout is inlined at its call site, so a
	// node used more than once is recomputed unless it is a var (atmosphere.js
	// note 2). xz and r are each read four times below.
	const xzV = xz.toVar();
	const rV = r.toVar();

	const disp = vec3( 0.0 ).toVar();
	const relief = float( 0.0 ).toVar();
	const swellH = float( 0.0 ).toVar();

	for ( let c = 0; c < CASCADE_CAP; c ++ ) {

		// GLSL: `if (c >= uCascadeCount) break;`
		If( int( c ).lessThan( uCascadeCount ), () => {

			const w = cascadeWeight( c, rV ).toVar();

			// GLSL: `if (w <= 0.001) continue;` - a continue at the top of the
			// body is an If around the rest of it.
			If( w.greaterThan( 0.001 ), () => {

				// Vertex stage, so .level(0) - see note 4 in the header. It is
				// exactly what GLSL ES 3.00's texture() does here.
				const d = dispTexture
					.sample( xzV.div( cascadeArrayElement( uPatch, c ) ) )
					.depth( int( c ) )
					.level( 0 )
					.toVar();

				const dd = vec3(
					d.x.mul( uHorizScale ),
					d.y.mul( uHeightScale ),
					d.z.mul( uHorizScale ),
				).mul( w ).toVar();

				disp.addAssign( dd );

				// GLSL: `if (c > 0)` - c is a JS number, so this is a JS if and
				// the block simply is not emitted for c = 0.
				//
				// Cascade 0 is the swell; everything above it is the local relief
				// riding on top of it. Occlusion and subsurface glow care about
				// that relief, not about how high the whole swell has lifted this
				// patch of sea.
				if ( c > 0 ) relief.addAssign( dd.y );

				// GLSL: `if (c < 2)`, again a JS if.
				//
				// The two longest cascades are the only ones that cast a shadow
				// wider than a pixel; the fragment shader marches exactly this
				// height field.
				//
				// NOTE d.y, NOT dd.y - swellH is UNWEIGHTED by w. See note 5.
				if ( c < 2 ) swellH.addAssign( d.y.mul( uHeightScale ) );

			} );

		} );

	}

	return { disp, relief, swellH };

}

// ---- the fragment-stage cascade loop ----------------------------------------

// WATER_FS:355-376. Note there is NO `w <= 0.001 continue` in this one, only
// the cascade-count guard - the fragment stage accumulates every live cascade's
// statistics however small its weight, because `lost` is precisely about the
// bands whose weight has fallen away.
//
//   vec2  slope = vec2(0.0);
//   float msq   = 0.0;     // mean square slope inside the pixel footprint
//   float lost  = 0.0;     // variance removed by cascade fade-out
//   float foamT = 0.0;     // total coverage
//   float foamF = 0.0;     // dense crest foam, seconds old
//   float foamR = 0.0;     // dissipated raft, the thin veil it decays into
//
//   for (int c=0;c<4;c++){
//     if (c >= uCascadeCount) break;
//     float w = cascadeWeight(c, dist);
//     vec3 uvc = vec3(vFlat.xz / uPatch[c], float(c));
//     vec4 sl = texture(uSlope, uvc);
//     vec4 fo = texture(uFoam, uvc);
//     slope += sl.xy * w;
//     msq   += sl.w * w * w;
//     // What the fade threw away still roughens the surface statistically.
//     float full = textureLod(uSlope, uvc, 8.0).w;
//     lost += max(full * (1.0 - w*w), 0.0);
//     foamT += fo.x * w;
//     foamF += fo.y * w;
//     foamR += fo.z * w;
//   }
//
// PLAIN JS NODE-GRAPH BUILDER, NOT an Fn. Call it from inside an Fn body:
//
//   const { slope, msq, lost, foamT, foamF, foamR } = sampleCascadeSurface( vFlat.xz, dist );
//
// slope comes back as a vec2 .toVar() and the other five as float .toVar()s.
// water-surface.js MUTATES slope, msq, foamF and foamR afterwards (the wake
// slick and the capillary layer), which is why they have to be vars and not
// expressions. foamT is never read - see note 6.
export function sampleCascadeSurface( xz, dist ) {

	const xzV = xz.toVar();
	const distV = dist.toVar();

	const slope = vec2( 0.0 ).toVar();
	const msq = float( 0.0 ).toVar();     // mean square slope inside the pixel footprint
	const lost = float( 0.0 ).toVar();    // variance removed by cascade fade-out
	const foamT = float( 0.0 ).toVar();   // total coverage
	const foamF = float( 0.0 ).toVar();   // dense crest foam, seconds old
	const foamR = float( 0.0 ).toVar();   // dissipated raft, the thin veil it decays into

	for ( let c = 0; c < CASCADE_CAP; c ++ ) {

		// GLSL: `if (c >= uCascadeCount) break;`. uCascadeCount is a uniform, so
		// this is uniform control flow and the two implicit-LOD fetches inside
		// are legal on WGSL - see note 4 in the header for the fallback if that
		// ever stops being true.
		If( int( c ).lessThan( uCascadeCount ), () => {

			const w = cascadeWeight( c, distV ).toVar();

			// The GLSL packs the layer into a vec3 uv; TSL takes it as .depth().
			const uv = xzV.div( cascadeArrayElement( uPatch, c ) ).toVar();

			// IMPLICIT LOD, no .level(): the mip chain is the filtering that
			// matters here, and it is what makes the far sea a smooth statistic
			// rather than a boil.
			const sl = slopeTexture.sample( uv ).depth( int( c ) ).toVar();
			const fo = foamTexture.sample( uv ).depth( int( c ) ).toVar();

			slope.addAssign( sl.xy.mul( w ) );
			msq.addAssign( sl.w.mul( w ).mul( w ) );

			// What the fade threw away still roughens the surface statistically.
			const full = slopeTexture.sample( uv ).depth( int( c ) ).level( 8.0 ).w.toVar();
			lost.addAssign( full.mul( float( 1.0 ).sub( w.mul( w ) ) ).max( 0.0 ) );

			foamT.addAssign( fo.x.mul( w ) );
			foamF.addAssign( fo.y.mul( w ) );
			foamR.addAssign( fo.z.mul( w ) );

		} );

	}

	return { slope, msq, lost, foamT, foamF, foamR };

}

// ---- the wake field ---------------------------------------------------------

// src/wake.js:41-74, verbatim in structure and in every constant.
//
// x: foam coverage 0..1   y: surface height, metres (signed)   z: how disturbed
// this water is at all, which is what kills the sea's own ripples inside a track
//
//   vec3 wakeAt(vec2 p){
//     vec2 uv = (p - uWakeOrigin) / uWakeExtent + 0.5;
//     if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return vec3(0.0);
//     vec4 r = texture(uWakeTex, uv);
//     float stir = r.r, age = r.g, lat = r.b, rate = r.a;
//     if (stir < 0.002 || age >= uWakeLife) return vec3(0.0);
//     // Don't let the wake end on a straight line ruled across the sea where the
//     // buffer runs out.
//     vec2 ed = min(uv, 1.0 - uv);
//     float fade = max(1.0 - age / uWakeLife, 0.0) * smoothstep(0.0, 0.03, min(ed.x, ed.y));
//
//     // The cusp arms stand where they have got to: a ridge at |lat| = rate * age,
//     // not a falloff from the centreline. That single fact is the whole difference
//     // between a Kelvin wedge and a widening smear down the middle of the path.
//     float arm = rate * age;
//     float w   = uWakeArmW * (1.0 + uWakeSpread * age);
//     float q   = (abs(lat) - arm) / max(w, 0.05);
//     float ridge = exp(-q * q);
//     // Between them, entrained air: broad, soft, and much shorter lived than the
//     // arms, because it is bubbles rather than a surface wave.
//     float cq = lat / max(uWakeBeam * (1.0 + 0.55 * age), 0.15);
//     float churnRaw = exp(-cq * cq);
//     float churn = churnRaw * max(1.0 - age / (uWakeLife * 0.5), 0.0);
//
//     float foam = (ridge * uWakeArm + churn * uWakeChurn) * stir * fade;
//     float h    = (ridge * uWakeArm * 0.55 - churn * uWakeChurn * 0.9) * stir * fade * uWakeDepth;
//     // The slick is the churned lane between the arms, and only that: it outlives
//     // the bubbles that made it, which is why a wake stays legible as a smooth dark
//     // path after the white water has gone. Deliberately not including the arms -
//     // suppressing the sea's foam along them would take the white off the one part
//     // of a wake that is supposed to be white.
//     return vec3(clamp(foam * uWakeStrength, 0.0, 1.0), h,
//                 clamp(churnRaw * stir * fade, 0.0, 1.0));
//   }
//
// Both early returns are the untouched zero vector of the result var. The two
// `||` chains are their positive complements with .and() - see note 7.
export const wakeAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const outv = vec3( 0.0 ).toVar();

	const uv = p.sub( uWakeOrigin ).div( uWakeExtent ).add( 0.5 ).toVar();

	// GLSL: if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return vec3(0.0);
	If( uv.x.greaterThan( 0.0 )
		.and( uv.x.lessThan( 1.0 ) )
		.and( uv.y.greaterThan( 0.0 ) )
		.and( uv.y.lessThan( 1.0 ) ), () => {

		// .level(0) unconditionally, in both stages - note 4. Value-identical:
		// the real uWakeTex has no mip chain.
		const r = wakeTexture.sample( uv ).level( 0 ).toVar();
		const stir = r.r.toVar();
		const age = r.g.toVar();
		const lat = r.b.toVar();
		const rate = r.a.toVar();

		// GLSL: if (stir < 0.002 || age >= uWakeLife) return vec3(0.0);
		If( stir.greaterThanEqual( 0.002 ).and( age.lessThan( uWakeLife ) ), () => {

			// Don't let the wake end on a straight line ruled across the sea
			// where the buffer runs out. The feather was a hardcoded 0.03 of
			// the buffer, and that is not enough to hide the wall: the field
			// is an axis-aligned square in WORLD space, so its far edge is a
			// line of constant Z and reads on screen as a dead-straight
			// horizontal cut - reported as "a weird hard horizontal line
			// where the wake begins". 0.03 of a 320 m buffer is under 10 m,
			// and at the grazing angle you actually view a wake from those
			// metres compress into a few pixels. Worse, a fast source reaches
			// the wall long before its trail has aged out: at 50 m/s the edge
			// arrives 6.4 s in, where the age term alone is still at 54%, so
			// the cut happens at over half strength. uWakeEdge (wakeEdgeFade)
			// widens it and makes it tunable per sea.
			const ed = uv.min( vec2( 1.0 ).sub( uv ) ).toVar();
			const fade = float( 1.0 ).sub( age.div( uWakeLife ) ).max( 0.0 )
				.mul( smoothstep( 0.0, uWakeEdge.max( 0.005 ), ed.x.min( ed.y ) ) ).toVar();

			// The cusp arms stand where they have got to: a RIDGE AT
			// |lat| = rate * age, not a falloff from the centreline. That single
			// fact is the whole difference between a Kelvin wedge and a widening
			// smear down the middle of the path.
			const arm = rate.mul( age ).toVar();
			const w = uWakeArmW.mul( float( 1.0 ).add( uWakeSpread.mul( age ) ) ).toVar();
			const q = lat.abs().sub( arm ).div( w.max( 0.05 ) ).toVar();
			const ridge = q.mul( q ).negate().exp().toVar();

			// Between them, entrained air: broad, soft, and much shorter lived
			// than the arms, because it is bubbles rather than a surface wave.
			const cq = lat.div( uWakeBeam.mul( float( 1.0 ).add( age.mul( 0.55 ) ) ).max( 0.15 ) ).toVar();
			const churnRaw = cq.mul( cq ).negate().exp().toVar();
			const churn = churnRaw.mul(
				float( 1.0 ).sub( age.div( uWakeLife.mul( 0.5 ) ) ).max( 0.0 ),
			).toVar();

			const foam = ridge.mul( uWakeArm ).add( churn.mul( uWakeChurn ) )
				.mul( stir ).mul( fade ).toVar();
			const h = ridge.mul( uWakeArm ).mul( 0.55 )
				.sub( churn.mul( uWakeChurn ).mul( 0.9 ) )
				.mul( stir ).mul( fade ).mul( uWakeDepth ).toVar();

			// The slick is the churned lane between the arms, and only that: it
			// outlives the bubbles that made it, which is why a wake stays
			// legible as a smooth dark path after the white water has gone.
			// Deliberately not including the arms - suppressing the sea's foam
			// along them would take the white off the one part of a wake that is
			// supposed to be white. (So .z uses churnRaw, NOT churn: no age
			// decay, and no ridge term.)
			outv.assign( vec3(
				clamp( foam.mul( uWakeStrength ), 0.0, 1.0 ),
				h,
				clamp( churnRaw.mul( stir ).mul( fade ), 0.0, 1.0 ),
			) );

		} );

	} );

	return outv;

} );

// ---- uniform plumbing -------------------------------------------------------

// Mirror of WaterSurface.fadeDistances (src/water.js:47-50):
//
//   for (let i = 0; i < 4; i++) this._vFade[i] = clamp((ocean.L[i] ?? 1) * 38, 200, 60000);
//
// A cascade stops contributing once its texels are far smaller than a pixel,
// which is also where its energy becomes pure roughness. Returns a length-4
// plain JS array; src/math.js's clamp is imported rather than respelled so the
// two paths cannot drift.
export function fadeDistances( ocean ) {

	const out = [ 0, 0, 0, 0 ];

	for ( let i = 0; i < CASCADE_CAP; i ++ ) {

		out[ i ] = clampJS( ( ocean.L[ i ] ?? 1 ) * 38, 200, 60000 );

	}

	return out;

}

// Mirror of the uniform block in WaterSurface.render (src/water.js:137-180),
// restricted to what this module owns. ./water-brdf.js, ./water-detail.js and
// ./water-surface.js each have their own setter and a driver calls all four -
// exactly as the GLSL shares one uniform block per concern across the programs.
//
//   p      the parameter set (see src/presets.js `defaults`)
//   ctx    { camPos, viewProj, sunDir, moonDir, time } - unused here, taken so
//          every water setter has the same shape
//   ocean  an Ocean whose update() has already run this frame, or null to leave
//          the cascade description alone
//   wake   the object Wake.uniforms(p, active) returns, or null/undefined for no
//          wake - in which case uWakeOn is forced to 0 and the other eleven are
//          left exactly as they were
//
// UniformArrayNode has updateType RENDER, so writing .array in place is enough:
// its update() copies the JS array into the padded buffer every render. There
// is no needsUpdate to set.
export function setWaterCommonUniforms( p, ctx, ocean, wake ) {

	if ( ocean ) {

		const patch = ocean.patchSizes;   // getter: allocates, so read it once
		const fade = fadeDistances( ocean );

		for ( let i = 0; i < CASCADE_CAP; i ++ ) {

			// `?? 1` for the same reason fadeDistances() has it: patchSizes is
			// length cascadeCount, not necessarily CASCADE_CAP, and
			// UniformArrayNode.update copies undefined into a Float32Array as NaN.
			// The `c < uCascadeCount` guard means that slot is never sampled, so
			// this is a latent trap rather than a live bug - but a NaN written into
			// a uniform buffer is not something to leave lying in the frame.
			uPatch.array[ i ] = patch[ i ] ?? 1;
			uFade.array[ i ] = fade[ i ];

		}

		uCascadeCount.value = ocean.cascadeCount;

		// Bind the three cascade samplers this module owns. src/water.js:139-141
		// sets uDisp/uSlope/uFoam in the same uniform block as uPatch/uFade/
		// uCascadeCount, and this function is that block's mirror - leaving the
		// samplers out meant a driver could call every documented setter and still
		// get a correct cascade DESCRIPTION pointed at 1x1 zero textures, which
		// renders as a dead-flat foamless plane rather than as an error.
		//
		// Only adopt real three Textures: an Ocean backed by raw GL (the shipping
		// WebGL2 simulation) has none, and that driver binds through
		// setCascadeTextures() itself.
		setCascadeTextures( {
			disp: ocean.disp?.isTexture ? ocean.disp : undefined,
			slope: ocean.slope?.isTexture ? ocean.slope : undefined,
			foam: ocean.foamTex?.isTexture ? ocean.foamTex : undefined,
		} );

	}

	uDetailScale.value = p.detailScale;
	uHeightScale.value = p.heightScale;
	uHorizScale.value = p.horizScale;

	// vec2(cos(p.windDir), sin(p.windDir)) - a UNIT direction, exactly
	// src/water.js:166. See note 1 in the header; this is NOT the wind velocity
	// cloud-field.js's uWindDirV carries.
	uWindDir.value.set( Math.cos( p.windDir ), Math.sin( p.windDir ) );

	if ( wake ) {

		// Wake.uniforms() hands back uWakeTex as whatever texture object the wake
		// simulation produced. In the GLSL path that is a raw WebGL handle from
		// src/gl.js, which a TextureNode cannot take.
		//
		// This used to be a silent `if (isTexture) bind`, which for the object
		// src/wake.js:252 actually returns never fired - `field` is a gl.js
		// texture record with no .isTexture - while uWakeOn below was still set
		// to 1. The sampler stayed on the inert 1x1 zero placeholder, wakeAt()'s
		// `stir < 0.002` guard returned zero for every point, and the craft left
		// no wake at all with nothing anywhere saying so.
		//
		// So: adopt a real three Texture, accept an explicit null (a driver that
		// binds through setWakeTexture itself), and REFUSE anything else rather
		// than pretend. A wake that is switched on must have a field behind it.
		if ( wake.uWakeTex === undefined || wake.uWakeTex === null ) {

			// nothing handed over - the driver owns the binding

		} else if ( wake.uWakeTex.isTexture ) {

			wakeTexture.value = wake.uWakeTex;

		} else if ( wake.uWakeOn ) {

			throw new Error(
				'setWaterCommonUniforms: wake.uWakeTex is not a THREE.Texture (got ' +
				( wake.uWakeTex.constructor?.name ?? typeof wake.uWakeTex ) + ') but uWakeOn is ' +
				wake.uWakeOn + '. The TSL path cannot sample a raw GL texture - bind a ' +
				'THREE.Texture with setWakeTexture() before enabling the wake.',
			);

		}

		uWakeOrigin.value.set( wake.uWakeOrigin[ 0 ], wake.uWakeOrigin[ 1 ] );
		uWakeExtent.value = wake.uWakeExtent;
		uWakeOn.value = wake.uWakeOn;
		uWakeLife.value = wake.uWakeLife;
		uWakeArmW.value = wake.uWakeArmW;
		uWakeEdge.value = wake.uWakeEdge;
		uWakeArm.value = wake.uWakeArm;
		uWakeChurn.value = wake.uWakeChurn;
		uWakeSpread.value = wake.uWakeSpread;
		uWakeBeam.value = wake.uWakeBeam;
		uWakeDepth.value = wake.uWakeDepth;
		uWakeStrength.value = wake.uWakeStrength;

	} else {

		uWakeOn.value = 0.0;

	}

}
