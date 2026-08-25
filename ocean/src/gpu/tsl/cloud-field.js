// The cloud density field in TSL — "how much cloud is at this point", the
// function the march calls. Ported from the cloud section of SKY_BG_FS in
// src/shaders/sky.js: the 2D weather map, the vertical profile, the shape and
// detail noise bands, the anvil term and the detail LOD gate.
//
// One source, both backends: Three compiles these node graphs to WGSL on WebGPU
// and to GLSL on WebGL2, which is the whole point (docs/webgpu-port.md). No
// wgslFn, no glslFn — a raw-source node compiles for exactly one backend and
// would put the fallback back where it started.
//
// NOT in this file: the march itself (marchClouds), the light march
// (cloudLightOD, LCONE), the multiple-scattering series (cloudPhaseEnergy,
// cloudLight) or the shell intersection (shellFar). Those are the consumers of
// this field, not part of it.
//
// The physics is unchanged. Every constant, sign, clamp and threshold below is
// the one that shipped, and the GLSL comments explaining *why* each is what it
// is are carried across with them — several of these numbers look arbitrary and
// are not, so the comment is load-bearing documentation, not decoration.
//
// The structural comment from the GLSL, which is the design of the whole file:
//
//   Density is three separable pieces so that even a coarse march sees the right
//   silhouette: a 2D weather field decides *where* there is cloud at all, a
//   vertical profile gives it a base and a top, and a detail band is folded in
//   only when the step length can actually resolve it. The old version subtracted
//   150 m erosion noise while stepping 3 km, which is exactly how you get
//   salt-and-pepper instead of cloud.
//
// ---------------------------------------------------------------------------
// SIX THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. THE `lod` GATE IS THE POINT, NOT AN OPTIMISATION. `cloudDensity`'s third
//    parameter is 0 = full detail, 1 = shape only, and it does two things: it
//    drops the shape band from 4 octaves to 3, and it scales the erosion band
//    (`det = uCloudDetail * (1 - lod)`) out of existence via the `det > 0.004`
//    test. The march computes it from STEP LENGTH, not from range —
//    `lod = max(remap01(dtF, 45, 260), remap01(t, 18000, 70000))` — because the
//    erosion band is ~150 m of structure and a 300 m step cannot resolve it. A
//    field the coarse search sees differently from the field the fine march
//    integrates is a hole per pixel, so the caller must pass the SAME lod for
//    both modes. Deleting the gate does not "restore detail": it puts back the
//    salt-and-pepper the comment above is about, and it changes the silhouette.
//
// 2. `mix` is used in its FUNCTION form, `mix(a, b, t)`, deliberately. Do not
//    "simplify" it to the method form. In TSL the method chaining is
//    `mixElement = (t, e1, e2) => mix(e1, e2, t)` — THE RECEIVER IS THE
//    INTERPOLANT, so `a.mix(b, t)` means mix(b, t, a), not mix(a, b, t).
//    (three r185, `addMethodChaining('mix', mixElement)`.) `smoothstep` and
//    `clamp` do take the receiver as the value, so those are safe either way;
//    they are written in function form here only to read like the GLSL.
//
// 3. `smoothstep(topB, topA, h)` in heightProfile HAS ITS EDGES THE WRONG WAY
//    ROUND ON PURPOSE. topB > topA always (see the arithmetic in that function),
//    so this is a descending ramp: 1 below topA, 0 above topB. Both GLSL ES and
//    WGSL call edge0 >= edge1 "undefined"/"indeterminate", and both in practice
//    compile to t = clamp((x-e0)/(e1-e0)); t*t*(3-2t), which is what gives the
//    inversion. This is the behaviour that ships today, so it is preserved
//    exactly rather than rewritten. The algebraically identical safe form is
//    `smoothstep(topA, topB, h).oneMinus()` — S(1-t) = 1-S(t) for this
//    polynomial, exactly — but it is not bit-identical in floating point, so it
//    is left as an escape hatch rather than applied. If a WebGPU run shows flat
//    cloud tops, this line is the first suspect.
//
// 4. GLSL's early `return` has no equivalent inside a node graph. cloudDensity
//    has four of them and they became nested `If` guards around a `result` var.
//    They are cost guards as much as value guards — `if (wth.x <= 0.002) return`
//    is what stops a clear-sky pixel evaluating three fbm loops — and nesting
//    preserves both properties. TSL has no short-circuit `||`, so the GLSL's
//    `if (h < 0.0 || h > 1.0) return 0.0` is written as its complement in two
//    nested Ifs.
//
// 5. An `Fn` with no explicit layout is INLINED at each call site rather than
//    emitted as a shader function (three r185, ShaderCallNodeInternal.call:
//    without `layout` it evaluates the JS body straight into the caller's
//    stack). So a node used more than once is *recomputed* unless it is pinned.
//    `drift`, `q`, `wth`, `oct` and `d` are `.toVar()` for that reason, not for
//    style. It also means cloudDensity is textually inlined at all seven of its
//    call sites in the march (once in the view march, six in cloudLightOD).
//    That is what the GLSL compiler does with these too, but if shader compile
//    time becomes a problem the fix is `Fn(fn).setLayout({ name: 'cloudDensity',
//    type: 'float', inputs: [...] })`, which emits a real function — untried
//    here, and not on any path this repo's probes covered.
//
// 6. TSL does not do GLSL's implicit int→float promotion, so every mixed
//    expression is explicit: `oct.sub(int(1))` for the billow's octave count,
//    `int(4)` / `int(2)` for literal octave counts.
//
// Uniforms are `uniform()` nodes, never inlined values, so the field is driven
// from the same params object src/sky.js drives the GLSL from — see
// setCloudUniforms at the bottom, which mirrors Sky.drawBackground's cloud
// subset exactly so the two paths cannot drift.

import { Fn, If, float, int, vec2, vec3, uniform, select, mix, clamp, smoothstep } from 'three/tsl';
import { fbm2, fbm3, billow, remap01, spread01 } from './noise.js';

// ---- uniforms ---------------------------------------------------------------
// Defaults are the shipping defaults from src/presets.js, so this module
// evaluates to a sane deck before anything has called setCloudUniforms().
//
// uTime, uCamPos and uWindDirV are shared with the rest of the sky pass (the
// cirrus veil, the star field, the march's distance fade). Import them from
// here rather than declaring a second uniform node for the same value — two
// nodes means two uploads and one of them will eventually be forgotten.

export const uTime     = /*@__PURE__*/ uniform( 0.0 );
export const uCamPos   = /*@__PURE__*/ uniform( 'vec3' );
export const uWindDirV = /*@__PURE__*/ uniform( 'vec3' );   // wind VELOCITY, m/s, y = 0

export const uCloudCoverage  = /*@__PURE__*/ uniform( 0.46 );
export const uCloudDensity   = /*@__PURE__*/ uniform( 1.0 );
export const uCloudAltitude  = /*@__PURE__*/ uniform( 1500.0 );   // cloud base, m
export const uCloudThickness = /*@__PURE__*/ uniform( 2200.0 );   // slab depth, m
export const uCloudSpeed     = /*@__PURE__*/ uniform( 1.0 );
export const uCloudDetail    = /*@__PURE__*/ uniform( 0.6 );      // erosion band strength
export const uCloudScale     = /*@__PURE__*/ uniform( 16000.0 );  // weather-map cluster size, m
export const uCloudShape     = /*@__PURE__*/ uniform( 1300.0 );   // base billow size, m
export const uCloudAnvil     = /*@__PURE__*/ uniform( 0.0 );      // flattens and spreads the tops
export const uCloudMaxDist   = /*@__PURE__*/ uniform( 55000.0 );  // march cutoff, m (params: cloudDistance)
export const uCloudFade      = /*@__PURE__*/ uniform( 0.55 );     // fraction of the range where the deck starts to go

// presets.js defaults: windSpeed 11 m/s at windDirDeg 42, resolved by
// derive.js into (cos, 0, sin) * speed.
uWindDirV.value.set( Math.cos( 42.0 * Math.PI / 180.0 ) * 11.0, 0.0, Math.sin( 42.0 * Math.PI / 180.0 ) * 11.0 );

// ---- drift ------------------------------------------------------------------

// vec2 cloudDrift(){ return uWindDirV.xz * uTime * uCloudSpeed; }
// The whole field translates with the wind. Note this is a horizontal offset in
// METRES applied before any division by a feature scale, so the deck moves at
// the same ground speed whatever uCloudScale or uCloudShape are set to.
export const cloudDrift = /*@__PURE__*/ Fn( () => {

  return uWindDirV.xz.mul( uTime ).mul( uCloudSpeed );

} );

// ---- the 2D weather field ---------------------------------------------------

// x = coverage 0..1, y = cloud type (0 flat stratus .. 1 towering cumulus).
//
// GLSL returned a vec2 and so does this; the two components are unrelated
// fields sharing one lookup, not a vector quantity.
export const cloudWeather = /*@__PURE__*/ Fn( ( [ xz ] ) => {

  const w = xz.add( cloudDrift() ).div( uCloudScale.max( 200.0 ) ).toVar();
  const c = spread01( fbm2( w, int( 4 ) ) ).toVar();
  // Cloud type has to vary on roughly the cluster scale, otherwise every cloud
  // in frame is the same height and the deck reads as one extruded pancake.
  // (The 1.3 rescale and the 41.3 offset are what decorrelate it from coverage
  // while keeping it on the same order of size.)
  const t = spread01( fbm2( w.mul( 1.3 ).add( 41.3 ), int( 3 ) ) ).toVar();
  // Coverage knob slides the threshold across the whole noise range so 0 is a
  // clear sky and 1 is solid overcast, with a soft edge either way.
  const thr = float( 1.04 ).sub( uCloudCoverage.mul( 1.12 ) ).toVar();
  const cov = remap01( c, thr, thr.add( 0.34 ) ).toVar();
  // The march has a finite range and cutting it off geometrically draws a ruled
  // line across the sky - the cloud-base shell crossing runs past the limit at a
  // definite elevation, which is exactly what makes a horizon deck present the
  // flat bottom edge that reads as a distant coastline. Taper the *coverage*
  // instead: clusters shrink and drop out one at a time, so the band breaks into
  // separate cells and dissolves into haze the way real distant cumulus does.
  // It only thins the field - it must not clear it, or an overcast deck opens a
  // bright hole on the horizon, which is a worse lie than the wall.
  //
  // Hence the 0.45 ceiling on the taper: at the far limit coverage is scaled by
  // 0.55, never by 0. That number is the "must not clear it" clause; the march's
  // own hazeTr fade is what finishes the job.
  const dxz = xz.sub( uCamPos.xz ).length().toVar();
  const far = uCloudMaxDist.max( 4000.0 ).toVar();
  cov.mulAssign( remap01( dxz, far.mul( uCloudFade ), far ).mul( 0.45 ).oneMinus() );

  return vec2( cov, t );

} );

// ---- the vertical profile ---------------------------------------------------

// h is the normalised height through the slab (0 at the base, 1 at the top),
// type is cloudWeather().y.
export const heightProfile = /*@__PURE__*/ Fn( ( [ h, type ] ) => {

  // Condensation level is sharp, so cumulus bases are nearly flat - but not
  // razor sharp, or the deck terminates on a ruled plane.
  const base = smoothstep( 0.0, mix( 0.06, 0.16, type ), h ).toVar();
  // topB must stay inside the slab: clipping it at h = 1 shears every tall
  // cloud off along the same plane and the deck reads as an extruded sheet.
  const topA = mix( 0.13, 0.55, type ).toVar();
  const topB = mix( 0.32, 0.98, type ).toVar();
  // Anvil flattens the top and spreads it - the difference between a fair
  // weather cumulus and a squall line.
  topB.assign( mix( topB, topB.mul( 0.62 ), uCloudAnvil ) );
  // DESCENDING smoothstep - edge0 > edge1 deliberately. See note 3 in the
  // header before touching this line. topB > topA for every (type, anvil) in
  // range: worst case type=0, anvil=1 gives topB = 0.32*0.62 = 0.198 against
  // topA = 0.13, and type=1, anvil=1 gives 0.98*0.62 = 0.6076 against 0.55.
  const top = smoothstep( topB, topA, h ).toVar();

  return base.mul( top );

} );

// ---- density ----------------------------------------------------------------

// float cloudDensity(vec3 p, float alt, float lod)
//
// p   world position (metres; only .x and .z are read - .y is NOT the altitude
//     the profile uses, which is why alt is a separate parameter: the march
//     works in a spherical shell and passes the true radial altitude).
// alt altitude above the sea, m.
// lod 0 = full detail, 1 = shape only. See note 1 in the header — this is the
//     step-length gate, and it is deliberate.
export const cloudDensity = /*@__PURE__*/ Fn( ( [ p, alt, lod ] ) => {

  // GLSL's four early returns all produce 0.0; this var carries that, and every
  // guard below is the complement of one of them. See note 4 in the header.
  const result = float( 0.0 ).toVar();

  const h0 = alt.sub( uCloudAltitude ).div( uCloudThickness.max( 1.0 ) ).toVar();

  // A little wind shear leans the column downwind and stops the weather map
  // reading as a pure vertical extrusion. It has to stay small: a large linear
  // shear sweeps every coverage edge through height and flutes the cloud.
  //
  // The vec2(1e-3, 0.0) is a normalize() guard for a dead calm, not a tuning
  // constant - without it a zero wind vector gives NaN and the whole deck
  // vanishes. clamp(h0, 0, 1.2) lets the lean continue a little past the slab
  // top, which is what the anvil sits on.
  const shear = uWindDirV.xz.add( vec2( 1e-3, 0.0 ) ).normalize()
    .mul( clamp( h0, 0.0, 1.2 ) ).mul( uCloudThickness ).mul( 0.13 ).toVar();

  const wth = cloudWeather( p.xz.add( shear ) ).toVar();

  // GLSL: if (wth.x <= 0.002) return 0.0;
  If( wth.x.greaterThan( 0.002 ), () => {

    // A common condensation level is real, but a *perfectly* common one draws a
    // ruled line across the sky, so let each cluster sit a little high or low.
    const h = h0.sub( wth.y.sub( 0.5 ).mul( 0.34 ) ).toVar();

    // GLSL: if (h < 0.0 || h > 1.0) return 0.0;  - written as its complement,
    // 0 <= h <= 1, in two nested Ifs because TSL has no short-circuiting `||`
    // and this repo's probes have not exercised `.or()` / `.not()`.
    If( h.greaterThanEqual( 0.0 ), () => {

      If( h.lessThanEqual( 1.0 ), () => {

        const prof = heightProfile( h, wth.y ).toVar();

        // GLSL: if (prof <= 0.002) return 0.0;
        If( prof.greaterThan( 0.002 ), () => {

          // Billow size tracks cloud type: a flat stratus deck is finely mottled, a
          // towering cumulus is built from far larger lobes. One global billow size
          // gives every cloud in frame the same grain, which is a texture, not weather.
          const S = uCloudShape.max( 50.0 ).mul( mix( 0.72, 1.30, wth.y ) ).toVar();

          // GLSL calls cloudDrift() twice here; pinned once because an Fn without
          // a layout is inlined (note 5). Same value, half the arithmetic.
          const drift = cloudDrift().toVar();

          // GLSL:
          //   vec3 q = vec3(p.x + cloudDrift().x, alt, p.z + cloudDrift().y) / S;
          //   q.y += uTime * uCloudSpeed * 0.0022;   // slow internal churn
          //
          // THE CHURN IS ADDED AFTER THE DIVIDE, so it is in q-space units, not
          // metres - it does not scale with uCloudShape. Written as a vec3 add
          // rather than a swizzle assignment (the repo avoids those, see
          // noise.js); adding 0.0 to x and z is exact, so this is bit-identical.
          const q = vec3( p.x.add( drift.x ), alt, p.z.add( drift.y ) ).div( S )
            .add( vec3( 0.0, uTime.mul( uCloudSpeed ).mul( 0.0022 ), 0.0 ) ).toVar();

          // int oct = lod < 0.5 ? 4 : 3;
          const oct = select( lod.lessThan( 0.5 ), int( 4 ), int( 3 ) ).toVar();

          // Perlin fbm is the connective tissue; the billow supplies the rounded
          // cumuliform lumps. Weighted toward the fbm on purpose - a billow-dominated
          // field puts a hard ridged relief on the first-hit surface and the deck reads
          // as a mountain range. And no hard contrast curve here: a steep density
          // gradient in world space is exactly what turns a volume into an isosurface.
          const shape = spread01(
            mix( fbm3( q, oct ), billow( q.mul( 1.27 ).add( 5.1 ), oct.sub( int( 1 ) ) ), 0.34 ),
          ).toVar();

          // Nubis-style remap: the threshold rides on coverage*profile, so density
          // decays smoothly to zero at cluster edges and at the base and top rather
          // than terminating on a contour. The extra falloff makes the decay quadratic
          // where the cloud is thin - that is what lets a silhouette fray - but it has
          // to saturate well before full coverage or an overcast deck goes translucent.
          const covp = wth.x.mul( prof ).toVar();
          const d = remap01( shape, covp.oneMinus(), 1.0 ).mul( smoothstep( 0.0, 0.55, covp ) ).toVar();

          // GLSL: if (d <= 0.0) return 0.0;  - d is already clamped to [0,1] by
          // remap01, so this can only be the ==0 case. It is a cost guard: it is
          // what stops a sub-threshold sample paying for the erosion billow.
          If( d.greaterThan( 0.0 ), () => {

            // THE DETAIL GATE. det falls to 0 as the caller's step length grows,
            // and the 0.004 test switches the band off entirely rather than
            // fading it to something the march samples once and aliases. Note 1.
            const det = uCloudDetail.mul( lod.oneMinus() ).toVar();

            If( det.greaterThan( 0.004 ), () => {

              const hi = spread01( billow( q.mul( 3.3 ).add( 13.7 ), int( 2 ) ) ).toVar();
              // Wispy shredding at the base, billowed cauliflower toward the top.
              const m = mix( hi.oneMinus(), hi, clamp( h.mul( 2.4 ), 0.0, 1.0 ) ).toVar();
              // remap01 is self-limiting: it bites hardest where d is already small, so
              // the erosion nibbles the edge instead of drilling holes through the body.
              // Applied as a multiplier rather than a replacement so the interior keeps
              // the density the coverage remap gave it and only the rim thins out.
              //
              // d appears on both sides: `d = d * remap01(d, ...)`. Both GLSL and
              // WGSL evaluate the whole right-hand side before assigning, so the
              // remap sees the pre-erosion d, which is what the GLSL does.
              d.mulAssign( remap01( d, m.mul( det ).mul( 0.5 ), 1.0 ) );

            } );

            result.assign( d.mul( uCloudDensity ) );

          } );

        } );

      } );

    } );

  } );

  return result;

} );

// ---- driving it -------------------------------------------------------------

// Mirror of the cloud subset of Sky.drawBackground's uniform block in
// src/sky.js - the same params object and the same ctx, so the TSL path and the
// GLSL path cannot drift. Two names differ between the params object and the
// shader and both are easy to get wrong: uCloudMaxDist is p.cloudDistance, and
// uWindDirV is a wind VELOCITY (ctx.windVec3, m/s) rather than a unit direction,
// which is what makes cloudDrift() a metres-per-second translation.
//
// Not set here: uCloudSteps, uCloudExtinction and everything in the lighting
// model. Those belong to the march, not to the field.
export function setCloudUniforms( p, ctx ) {

  uTime.value = ctx.time;
  uCamPos.value.set( ctx.camPos[ 0 ], ctx.camPos[ 1 ], ctx.camPos[ 2 ] );
  uWindDirV.value.set( ctx.windVec3[ 0 ], ctx.windVec3[ 1 ], ctx.windVec3[ 2 ] );

  uCloudCoverage.value = p.cloudCoverage;
  uCloudDensity.value = p.cloudDensity;
  uCloudAltitude.value = p.cloudAltitude;
  uCloudThickness.value = p.cloudThickness;
  uCloudSpeed.value = p.cloudSpeed;
  uCloudDetail.value = p.cloudDetail;
  uCloudScale.value = p.cloudScale;
  uCloudShape.value = p.cloudShape;
  uCloudAnvil.value = p.cloudAnvil;
  uCloudMaxDist.value = p.cloudDistance;
  uCloudFade.value = p.cloudFade;

}


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

// IMPURE, NOT LAYOUTED (reads uniforms - see the layout rule above)
// cloudWeather.setLayout( { name: 'abyssal_cloudWeather', type: 'vec2', inputs: [ { name: 'xz', type: 'vec2' } ] } );
// IMPURE, NOT LAYOUTED (reads uniforms - see the layout rule above)
// heightProfile.setLayout( { name: 'abyssal_heightProfile', type: 'float', inputs: [ { name: 'h', type: 'float' }, { name: 'type', type: 'float' } ] } );
// IMPURE, NOT LAYOUTED (reads uniforms - see the layout rule above)
// cloudDensity.setLayout( { name: 'abyssal_cloudDensity', type: 'float', inputs: [ { name: 'p', type: 'vec3' }, { name: 'alt', type: 'float' }, { name: 'lod', type: 'float' } ] } );
