// The cloud MARCH and LIGHTING in TSL — the consumer of the density field in
// ./cloud-field.js. Ported from the second half of the cloud section of
// SKY_BG_FS in src/shaders/sky.js: the spherical-shell ray setup (shellFar), the
// adaptive raymarch (marchClouds), the cone light-march toward a light source
// (cloudLightOD, LCONE), the multiple-scattering octave series and its analytic
// tail (cloudPhaseEnergy), and powder + silver lining (cloudLight).
//
// One source, both backends: Three compiles these node graphs to WGSL on WebGPU
// and to GLSL on WebGL2, which is the whole point (docs/webgpu-port.md). No
// wgslFn, no glslFn — a raw-source node compiles for exactly one backend and
// would put the fallback back where it started.
//
// This is the most expensive shading in the project. A 48-step march can run 192
// iterations, each one evaluating cloudDensity once for the view ray and up to
// twelve more times for the two light marches (six taps each, sun and moon), and
// each of those is three fbm/billow loops. Everything below that looks like a
// cost guard IS one, and removing it is not a simplification.
//
// The physics is unchanged. Every constant, sign, clamp and magic number is the
// one that shipped, and the GLSL comments explaining *why* each is what it is
// are carried across with them — most of these numbers look arbitrary and are
// not, so the comment is load-bearing documentation, not decoration.
//
// ---------------------------------------------------------------------------
// SEVEN THINGS A READER COMING FROM THE GLSL WILL OTHERWISE GET WRONG
//
// 1. THE MARCH'S `break` IS A GUARD FLAG, NOT A break. The GLSL is
//
//      for (int i=0;i<256;i++){
//        if (i >= maxIter || t > t1 || trans < 0.015) break;
//        ...
//      }
//
//    and it has three exit conditions. The FIRST one is a loop bound, not a
//    break at all, so it becomes `Loop({ end: maxIter })` directly — maxIter is
//    min(steps*4, 256), so the GLSL's hard 256 cap survives as the cap on
//    maxIter rather than as the loop's own bound, and the two are exactly
//    equivalent. The OTHER TWO become a `done` flag: when either fires, `done`
//    is set to 1 and every remaining iteration does nothing but test it.
//
//    What that costs, stated plainly: the GLSL leaves the loop, this spins to
//    maxIter. A ray that saturates at iteration 10 of 192 still pays 182
//    iterations of one integer compare. It is the one place in this file where
//    the port is slower than the source, and on a deck that fills the frame
//    (`trans < 0.015` firing early for most pixels) it is not a rounding error.
//    `Break()` IS exported by three/tsl in r185 and does generate a plain
//    `break` on both backends, but nothing in this repo's probes exercises it
//    (see note 2 in ./noise.js, which made the same call for the octave loops).
//    If a real-browser profile shows this loop dominating, replacing the three
//    `done.assign( int( 1 ) )` sites with `Break()` is the change to make — and
//    it has to be re-verified on both backends, because a `break` inside nested
//    `If`s inside a `Loop` is exactly the shape Three's WebGL codegen is least
//    likely to have been tested against.
//
//    The guard is *value*-equivalent regardless: on a skipped iteration the GLSL
//    body never ran either, so scatter, trans, t, inside, empty, distSum and
//    distW are all untouched.
//
// 2. `continue` DOES NOT TRANSLATE EITHER. The march body has three of them and
//    they encode the mode machine: search (coarse steps), re-entry (back up and
//    switch to fine steps), and integrate. They became one If/Else tree whose
//    branches are mutually exclusive in exactly the way the continues made them.
//    Read the tree as "which of the GLSL's three `continue` paths am I on".
//
// 3. bool AND int LOCALS ARE int FLAGS. The GLSL keeps `bool inside` and
//    `int empty`. A bool var is not something this repo's probes have exercised
//    (./atmosphere.js:329 makes the same point and avoids one), so `inside` and
//    `done` are `int` vars holding 0/1. `empty` is already an int. Compared with
//    `.equal( int( 0 ) )` rather than truthiness, because TSL has no truthiness.
//
// 4. `dt` IS SNAPSHOTTED AT THE TOP OF THE ITERATION, and that matters. The GLSL
//    reads `float dt = inside ? dtF : dtC;` before the body can change `inside`,
//    so the iteration that leaves the cloud (`empty > 4`, which sets
//    `inside = false`) still advances by the FINE step it entered with. Pinning
//    `dt` with `.toVar()` before the tree preserves that; recomputing it at the
//    `t += dt` sites would not, and the deck would step differently on every
//    trailing edge.
//
// 5. THE LIGHT-MARCH CONE IS UNROLLED IN JS, ON PURPOSE. The GLSL indexes a
//    `const vec3 LCONE[5]` with the loop counter. TSL's `array([...])` emits an
//    array *constructor expression* at the use site and indexing that with a
//    runtime index is not something WGSL is guaranteed to accept (./noise.js
//    refused it for the Bayer table for the same reason). The GLSL loop has a
//    constant bound and a compile-time index, so every GLSL compiler unrolls it
//    anyway — a JS `for` emitting five copies produces the same straight-line
//    code. But `t` and `dl` stay TSL float vars and are still accumulated
//    `t += dl; dl *= 1.9` INSIDE the unroll, so the geometric spacing is
//    computed in 32-bit float exactly as the GLSL computes it. Folding those
//    into JS doubles would have been a last-ulp difference in every tap
//    distance, which is invisible but is not the same number.
//
// 6. marchClouds TAKES TWO PARAMETERS THE GLSL DID NOT. The GLSL reads
//    `gl_FragCoord.xy` for the dither and calls `sampleSky(rd)` for the air
//    colour it blends the far deck into. Neither belongs to this module:
//    `sampleSky` needs the LUT sampler, which the background pass owns, and
//    `screenCoordinate` is NOT `gl_FragCoord` — see note 7. So both arrive as
//    parameters, `air` and `fragCoord`, appended after the GLSL's eight. The
//    caller already samples the LUT twice for skyTop/skyLow, so passing a third
//    is the pattern the shipping code was in the middle of anyway. Cost of the
//    move: `air` is fetched even for a pixel with no cloud in it, where the GLSL
//    returned before reaching the fetch. That is one texture tap on a pass that
//    already taps the same texture for its gradient.
//
// 7. `screenCoordinate` IS NOT `gl_FragCoord`. On the WebGL backend Three
//    generates `vec2(gl_FragCoord.x, screenSize.y - gl_FragCoord.y)` for it, to
//    make WebGL follow the WebGPU convention (r185, ScreenNode.generate under
//    `builder.isFlipY()`). Feeding that to the Bayer dither mirrors the phase
//    pattern vertically: statistically the identical dither, visually
//    indistinguishable, and NOT pixel-identical to the shipping GLSL — which
//    matters because prototypes/sky-golden.html fingerprints every pixel. If
//    this pass is being diffed against that reference, pass a y-up fragment
//    coordinate. If it is not, `screenCoordinate` is fine.
//
// Plus the two standing rules from the rest of the port: an `Fn` without an
// explicit layout is INLINED at each call site (r185, ShaderCallNodeInternal),
// so every multi-use intermediate is `.toVar()` or it is recomputed — here that
// is load-bearing, because a recomputed `cloudLight` is a whole extra light
// march; and TSL does no implicit int→float promotion, so every mixed expression
// is explicit (`float( steps )`, `int( 4 )`).

import { Fn, If, Loop, float, int, vec3, vec4, uniform, select, mix, clamp } from 'three/tsl';

import {
  R_PLANET,
  H_RAY,
  PI_A,
  BETA_R,
  BETA_M_EXT,
  uTurbidity,
  miePhase,
  planetDist,
} from './atmosphere.js';

import {
  cloudDensity,
  uCloudAltitude,
  uCloudThickness,
  uCloudCoverage,
  uCloudDensity,
  uCloudMaxDist,
  uCloudFade,
} from './cloud-field.js';

import { remap01, bayer4, hash12 } from './noise.js';

// ---- uniforms ---------------------------------------------------------------
// The march's own uniforms — the step budget, the extinction cross-section and
// the whole lighting model. ./cloud-field.js deliberately does NOT declare these
// (see the note at the bottom of that file): they belong to the march, not to
// the field. Everything the field owns is imported above rather than
// redeclared — two uniform nodes for one value means two uploads and one of them
// will eventually be forgotten.
//
// Defaults are the shipping defaults from src/presets.js, so this module
// evaluates to a sane deck before anything has called setCloudMarchUniforms().

export const uCloudSteps      = /*@__PURE__*/ uniform( 48.0 );    // float, as in the GLSL; cast to int below
export const uCloudExtinction = /*@__PURE__*/ uniform( 0.045 );   // 1/m at full density
export const uCloudMS         = /*@__PURE__*/ uniform( 0.66 );    // per-octave falloff of the MS approximation
export const uCloudPowder     = /*@__PURE__*/ uniform( 0.7 );     // dark-edge term on the shadow side
export const uCloudSilver     = /*@__PURE__*/ uniform( 1.0 );     // backlit rim
export const uCloudAmbient    = /*@__PURE__*/ uniform( 1.0 );     // sky fill weight
export const uCloudAmbFloor   = /*@__PURE__*/ uniform( 0.32 );    // sky fill reaching the shadowed base vs the top
export const uCloudHaze       = /*@__PURE__*/ uniform( 1.0 );     // aerial perspective weight on the deck

// ---- geometry ---------------------------------------------------------------

// Far intersection of a ray with a sphere of radius R centred at the origin,
// with `c` the ray origin expressed relative to that centre. Returns -1 for a
// miss.
//
//   float shellFar(vec3 c, vec3 rd, float R){
//     float b = dot(c, rd);
//     float disc = b*b - (dot(c,c) - R*R);
//     if (disc < 0.0) return -1.0;
//     return -b + sqrt(disc);
//   }
//
// The FAR root, always, even when the origin is outside the sphere — that is
// what makes the cloud slab a pair of shells rather than a pair of planes, and
// it is why the deck converges on the horizon instead of shooting off to
// infinity as rd.y goes to zero. The early return becomes a result var so the
// sqrt only runs where disc >= 0 (an unguarded sqrt of a negative is NaN, and
// NaN compares false against everything, so the miss would read as a hit).
//
// Exported because the cirrus layer intersects its own shell with this too.
export const shellFar = /*@__PURE__*/ Fn( ( [ c, rd, R ] ) => {

  const b = c.dot( rd ).toVar();
  const disc = b.mul( b ).sub( c.dot( c ).sub( R.mul( R ) ) ).toVar();

  const t = float( - 1.0 ).toVar();
  If( disc.greaterThanEqual( 0.0 ), () => {

    t.assign( disc.sqrt().sub( b ) );

  } );

  return t;

} );

// ---- the light march --------------------------------------------------------

// Cone taps for the light march. A pencil of samples gives razor-sharp
// self-shadowing that reads as terrain relief; real cloud shadows are blurred
// by the multiple scattering that delivered the light in the first place.
//
// Plain JS arrays, not a TSL array node — see note 5 in the header. The first
// tap is the zero vector (the axis of the cone); it is kept rather than special
// cased because adding an exact zero is exact, so this stays a transcription.
const LCONE = [
  [  0.00,  0.00,  0.00 ], [  0.34,  0.19, - 0.16 ],
  [ - 0.28,  0.09,  0.31 ], [  0.06, - 0.31, - 0.25 ], [ - 0.19, - 0.15,  0.24 ],
];

// Optical depth toward the light. Geometric spacing plus a long tail sample so a
// 3 km cumulus actually shadows its own base.
//
//   float cloudLightOD(vec3 p, float alt, vec3 L){
//     float od = 0.0, t = 0.0, dl = 110.0;
//     for (int i=0;i<5;i++){
//       float tm = t + dl*0.5;
//       vec3 o = L*tm + LCONE[i]*tm*0.34;
//       od += cloudDensity(p + o, alt + o.y, 1.0) * dl;
//       t += dl; dl *= 1.9;
//     }
//     od += cloudDensity(p + L*(t+1000.0), alt + L.y*(t+1000.0), 1.0) * 1800.0;
//     return od * uCloudExtinction;
//   }
//
// Three things here are easy to lose:
//
//   - THE CONE WIDENS WITH DISTANCE. The tap offset is `LCONE[i]*tm*0.34`, so
//     the spread is proportional to how far along the light ray the sample sits.
//     A fixed-width cone would blur the near shadow and leave the far one sharp,
//     which is backwards.
//   - EVERY TAP IS lod = 1.0, SHAPE ONLY. The erosion band is ~150 m of
//     structure and the first tap is already 55 m out with 110 m spacing; there
//     is nothing to gain and a lot of noise to add by resolving detail in a
//     shadow integral. It also halves the cost of the six taps.
//   - THE TAIL SAMPLE IS NOT PART OF THE GEOMETRIC SERIES. One more sample
//     1000 m past the end of the cone, weighted as if it stood for 1800 m of
//     path. Five geometric taps only reach ~2.9 km; a cumulus is taller than
//     that, and without the tail its own base is not in its own shadow.
//
// Note the tail's asymmetry, which is in the GLSL and is preserved: the position
// advances by the full L*(t+1000) but the altitude advances by L.y*(t+1000) —
// consistent, because no cone offset is applied to the tail.
export const cloudLightOD = /*@__PURE__*/ Fn( ( [ p, alt, L ] ) => {

  const od = float( 0.0 ).toVar();
  const t = float( 0.0 ).toVar();
  const dl = float( 110.0 ).toVar();

  // JS-side unroll of `for (int i=0;i<5;i++)` — note 5 in the header. t and dl
  // stay float vars, so the 1.9 geometric growth is accumulated in 32-bit float
  // exactly as the GLSL accumulates it.
  for ( let i = 0; i < 5; i ++ ) {

    const tm = t.add( dl.mul( 0.5 ) ).toVar();
    const o = L.mul( tm ).add( vec3( LCONE[ i ][ 0 ], LCONE[ i ][ 1 ], LCONE[ i ][ 2 ] ).mul( tm ).mul( 0.34 ) ).toVar();
    od.addAssign( cloudDensity( p.add( o ), alt.add( o.y ), float( 1.0 ) ).mul( dl ) );
    t.addAssign( dl );
    dl.mulAssign( 1.9 );

  }

  // The GLSL spells `t+1000.0` twice; pinned once because an Fn without a layout
  // is inlined, so the second spelling would be a second add. Same value.
  const tTail = t.add( 1000.0 ).toVar();
  od.addAssign( cloudDensity( p.add( L.mul( tTail ) ), alt.add( L.y.mul( tTail ) ), float( 1.0 ) ).mul( 1800.0 ) );

  return od.mul( uCloudExtinction );

} );

// ---- the multiple-scattering series -----------------------------------------

// Multiple-scattering octaves: each successive order is dimmer, more isotropic
// and penetrates deeper. This is what makes a thick cloud bright white instead
// of black, and what puts the silver lining on a backlit edge.
//
//   float cloudPhaseEnergy(float od, float mu){
//     float a = 1.0, b = 1.0, g = 1.0;
//     float lum = 0.0;
//     for (int n=0;n<4;n++){
//       float ph = mix(miePhase(mu, 0.80*g), miePhase(mu, -0.42*g), 0.32);
//       lum += a * mix(0.25/PI_A, ph, g*g) * exp(-od * b);
//       a *= uCloudMS; b *= 0.5; g *= 0.5;
//     }
//     lum += a / max(1.0 - uCloudMS, 0.05) * (0.25/PI_A) * exp(-od*0.12);
//     return lum;
//   }
//
// THE THREE RATIOS ARE THE MODEL. Each order scales by a different constant and
// they are not interchangeable:
//
//   a *= uCloudMS   contribution   — how much energy survives into the next order
//   b *= 0.5        extinction     — each order penetrates twice as deep
//   g *= 0.5        eccentricity   — each order is half as directional
//
// Halving `b` is what lets the deep orders come out of an optically thick cloud
// at all; halving `g` is what turns the Mie lobe into a uniform glow. Give them
// the same ratio and a cumulus becomes either a flat card or one big forward
// lobe swung round the sun. This is Andrew Schneider / Fredrik Häggström's
// multiple-scattering approximation and the ratios are the whole of it.
//
// `g*g` as the interpolant between isotropic and phase-shaped is deliberate too:
// it falls off faster than g, so the third and fourth orders are essentially
// pure 1/4pi.
//
// The loop bound is a constant 4 with no break, so it is a plain `Loop` — the
// guard business in the march below does not apply here.
export const cloudPhaseEnergy = /*@__PURE__*/ Fn( ( [ od, mu ] ) => {

  const a = float( 1.0 ).toVar();
  const b = float( 1.0 ).toVar();
  const g = float( 1.0 ).toVar();
  const lum = float( 0.0 ).toVar();

  // 0.25/PI_A — the isotropic phase function, 1/(4pi). Written as the division
  // the GLSL wrote so the shader compiler folds it the same way, in float, and
  // hoisted because it is used twice.
  const ISO = float( 0.25 ).div( PI_A ).toVar();

  Loop( { start: int( 0 ), end: int( 4 ) }, () => {

    // Each order is dimmer, penetrates deeper (lower effective extinction) and
    // has lost most of its directionality: by the third bounce the field inside
    // a cloud is essentially isotropic, which is why a thick cumulus reads as
    // uniformly white rather than as one big Mie lobe swung round the sun.
    //
    // Two lobes, not one: 0.80*g forward and -0.42*g BACKWARD, mixed 0.32 toward
    // the backscatter. The negative g is not a typo — cloud droplets have a real
    // backscatter peak, and dropping it is what makes a deck lit from behind the
    // camera go flat.
    const ph = mix( miePhase( mu, g.mul( 0.80 ) ), miePhase( mu, g.mul( - 0.42 ) ), 0.32 ).toVar();
    lum.addAssign( a.mul( mix( ISO, ph, g.mul( g ) ) ).mul( od.mul( b ).negate().exp() ) );
    a.mulAssign( uCloudMS );
    b.mulAssign( 0.5 );
    g.mulAssign( 0.5 );

  } );

  // THE ANALYTIC TAIL, and it is what stops the shadow side going black.
  //
  // Four orders is nowhere near enough: a cloud droplet's single-scatter albedo
  // is ~1, so nearly all of the light that goes in comes back out and a real
  // sunlit cumulus top sits near albedo*E/pi. Truncating the series without its
  // tail is what leaves clouds several times too dark and makes them read as
  // grey cutouts against a bright sky.
  //
  // `a` leaves the loop holding uCloudMS^4, the contribution the FIFTH order
  // would have had, so `a / (1 - uCloudMS)` is the closed form of the whole
  // remaining geometric series sum_{n>=4} uCloudMS^n. It is spent as pure
  // isotropic (ISO) at a very low effective extinction (0.12), which is the
  // deep-order limit the loop was walking toward: light that has bounced five or
  // more times has no memory of where the sun was and gets almost everywhere
  // inside the cloud. The max(..., 0.05) is a divide-by-zero guard for
  // uCloudMS -> 1, not a tuning constant.
  lum.addAssign( a.div( uCloudMS.oneMinus().max( 0.05 ) ).mul( ISO ).mul( od.mul( 0.12 ).negate().exp() ) );

  return lum;

} );

// ---- radiance leaving a cloud element toward the eye ------------------------

// Scattered radiance leaving a cloud element toward the eye for one light.
// Factored out because a cloud lit only by the sun is a black cutout the moment
// the sun sets, and a moonlit deck with a glitter path on the water underneath
// it plainly has lit tops.
//
//   vec3 cloudLight(vec3 p, float alt, vec3 L, vec3 col, float mu){
//     if (dot(col, col) < 1e-10) return vec3(0.0);
//     ...
//   }
//
// THAT EARLY RETURN IS THE MOST VALUABLE COST GUARD IN THE FILE. It is what
// stops a daytime frame paying for a six-tap light march toward a moon whose
// colour is zero — 36 cloudDensity evaluations per march step saved, on a march
// that can be 192 steps long. Translated as an `If` around the whole body (not a
// mask applied afterwards) precisely so the march is skipped, not multiplied by
// zero.
export const cloudLight = /*@__PURE__*/ Fn( ( [ p, alt, L, col, mu ] ) => {

  const result = vec3( 0.0 ).toVar();

  If( col.dot( col ).greaterThanEqual( 1e-10 ), () => {

    const od = cloudLightOD( p, alt, L ).toVar();
    const lum = cloudPhaseEnergy( od, mu ).toVar();

    // Powder: near the lit surface a single scattering event is unlikely, so
    // edges facing away from the light go dark. Only applies backlit-ish —
    // that is the (0.5 - 0.5*mu) factor, which is 0 looking straight at the
    // light and 1 looking straight away from it.
    const powder = od.mul( 2.6 ).negate().exp().oneMinus().toVar();
    lum.mulAssign( mix( float( 1.0 ), powder, uCloudPowder.mul( float( 0.5 ).sub( mu.mul( 0.5 ) ) ) ) );

    // Silver lining: the thin rim of a backlit cloud transmits forward-scattered
    // light almost unattenuated. Gated on a *short* light path so it lands on the
    // rim rather than washing the whole disc — that is the exp(-od*1.6), and the
    // pow(mu, 6) is what keeps it within a few degrees of the light. Added, not
    // multiplied: it is transmitted light, not a modulation of the scattered
    // field, so it survives where lum is already near zero.
    lum.addAssign( uCloudSilver.mul( mu.max( 0.0 ).pow( 6.0 ) ).mul( od.mul( 1.6 ).negate().exp() ).mul( 0.5 ) );

    result.assign( col.mul( lum ) );

  } );

  return result;

} );

// ---- the march --------------------------------------------------------------

// vec4 marchClouds(vec3 ro, vec3 rd, vec3 sunDir, vec3 sunColor,
//                  vec3 moonDir, vec3 moonColor, vec3 skyTop, vec3 skyLow)
//
// Returns premultiplied radiance in rgb and coverage in a; the caller composites
// `col = col*(1 - cl.a) + cl.rgb`.
//
// ro        camera world position, metres, y = height above sea level
// rd        normalised view direction
// sunDir    normalised
// sunColor  sun irradiance through the atmosphere at the camera, already scaled
//           by uAtmoExposure (the GLSL's `sunCol`)
// moonDir   normalised
// moonColor the moon's equivalent, zero when there is no moon — which is what
//           switches the second light march off, see cloudLight
// skyTop    sampleSky(vec3(0,1,0)) — the zenith, the ambient reaching cloud tops
// skyLow    sampleSky(normalize(vec3(rd.x, 0.12, rd.z))) — the near-horizon sky
//           in THIS direction, the ambient reaching cloud bases
// air       sampleSky(rd) — the background gradient in this direction, what the
//           far deck dissolves into. NOT in the GLSL signature; see note 6 in
//           the header. Must be the explicit-LOD-0 fetch (the LUT is mipped and
//           an implicit fetch crosses mip levels partway up the sky and lays
//           down horizontal seams), and must NOT be the dithered variant the
//           background gradient itself uses.
// fragCoord gl_FragCoord.xy, for the ordered dither. NOT in the GLSL signature;
//           see notes 6 and 7 — `screenCoordinate` is y-flipped relative to this
//           on the WebGL backend.
export const marchClouds = /*@__PURE__*/ Fn( ( [ ro, rd, sunDir, sunColor, moonDir, moonColor, skyTop, skyLow, air, fragCoord ] ) => {

  // The GLSL's five early returns all produce vec4(0.0); this var carries that,
  // and every guard below is the complement of one of them. They are cost guards
  // as much as value guards — the first pair is what stops a clear-sky frame
  // touching any of this — so they are nested rather than flattened into a mask.
  const result = vec4( 0.0 ).toVar();

  // GLSL: if (uCloudCoverage <= 0.002 || uCloudDensity <= 0.001) return vec4(0.0);
  // Written as its complement in two nested Ifs — TSL has no short-circuiting
  // `||`, and ./cloud-field.js and ./sky-lut.js make the same move for the same
  // reason.
  If( uCloudCoverage.greaterThan( 0.002 ), () => {

    If( uCloudDensity.greaterThan( 0.001 ), () => {

      // The camera, re-expressed relative to the planet centre. Everything in
      // this function that touches a shell works in this frame; `p` and `ro`
      // stay in world space because that is the frame cloudDensity's weather map
      // is defined in. max(ro.y, 0.5) keeps the origin strictly inside the
      // cloud-base shell for a camera at sea level.
      const c = vec3( 0.0, ro.y.max( 0.5 ).add( R_PLANET ), 0.0 ).toVar();

      // GLSL: if (planetDist(c, rd) > 0.0) return vec4(0.0);  - looking at the
      // sea, so there is no sky path to march.
      If( planetDist( c, rd ).lessThanEqual( 0.0 ), () => {

        const lo = uCloudAltitude.toVar();
        const hi = uCloudAltitude.add( uCloudThickness ).toVar();

        // Spherical shells, not planes: the deck then genuinely converges on the
        // horizon instead of shooting off to infinity as rd.y goes to zero.
        //
        // GLSL: float t0 = ro.y < lo ? shellFar(c, rd, R_PLANET + lo) : 0.0;
        // Written as an If over a var initialised to 0.0 rather than a select(),
        // so shellFar is not evaluated at all for a camera above the cloud base.
        const t0 = float( 0.0 ).toVar();
        If( ro.y.lessThan( lo ), () => {

          t0.assign( shellFar( c, rd, lo.add( R_PLANET ) ) );

        } );

        const t1 = shellFar( c, rd, hi.add( R_PLANET ) ).toVar();

        // GLSL: if (t1 <= 0.0) return vec4(0.0);  - the slab's outer shell is
        // behind the ray, i.e. this direction never reaches the deck.
        If( t1.greaterThan( 0.0 ), () => {

          t0.assign( t0.max( 0.0 ) );
          const far = uCloudMaxDist.max( 4000.0 ).toVar();
          t1.assign( t1.min( far ) );

          // GLSL: if (t1 <= t0) return vec4(0.0);  - the range limit cut the
          // whole span away.
          If( t1.greaterThan( t0 ), () => {

            const steps = int( uCloudSteps ).toVar();
            const span = t1.sub( t0 ).toVar();

            // The coarse step is a search step: if it strides past a whole cumulus the
            // hit becomes jitter-dependent and the deck stipples. Cap it well under the
            // billow scale and let the iteration budget - not the step length - bound the
            // range.
            const dtC = clamp( span.div( float( steps ) ), 35.0, 300.0 ).toVar();
            const dtF = clamp( dtC.mul( 0.30 ), 15.0, 90.0 ).toVar();
            const lodStep = remap01( dtF, 45.0, 260.0 ).toVar();

            // GLSL: int maxIter = min(steps*4, 256);  - here it is the Loop's
            // bound rather than a break condition, which is exactly equivalent
            // and one fewer thing for the guard to test. See note 1.
            // NOT steps.mul(int(4)).min(int(256)). three r185's MathNode.generate
            // has a WebGL-only special case that forces a SCALAR second operand of
            // min/max to be built as 'float' - it exists so vec3.min(0.5) works in
            // GLSL - and with two ints it emits `min((x * 4), 256.0)` into an int
            // variable. GLSL ES 3.00 has no min(int, float) overload, so the whole
            // background pass fails to compile and the sky draws nothing. WGSL is
            // unaffected, so this breaks exactly one backend.
            //
            // Doing the clamp in float and converting back sidesteps the special
            // case entirely, and 256 is exactly representable so nothing rounds.
            const maxIter = int( float( steps ).mul( 4.0 ).min( 256.0 ) ).toVar();

            // An ordered 4x4 dither, not a white-noise hash and not interleaved-gradient
            // noise: the hash clumps into salt-and-pepper and IGN's frequency is far
            // higher in x than in y, which combs a still frame into vertical stripes.
            // The hash term only fills in *within* a Bayer bucket - 16 discrete phases
            // leave a whole scanline sampling the same t values, which is what draws the
            // horizontal streaks across a thin deck.
            //
            // 0.0625 is 1/16, i.e. exactly one Bayer bucket wide, which is what
            // makes the two terms tile the unit interval without overlapping.
            const ign = bayer4( fragCoord ).add( hash12( fragCoord ).mul( 0.0625 ) ).fract().toVar();
            const t = t0.add( dtC.mul( ign ) ).toVar();

            const scatter = vec3( 0.0 ).toVar();
            const trans = float( 1.0 ).toVar();
            const mu = rd.dot( sunDir ).toVar();
            const muM = rd.dot( moonDir ).toVar();
            // GLSL `bool inside` and `int empty`; int flags here, see note 3.
            const inside = int( 0 ).toVar();
            const empty = int( 0 ).toVar();
            const distSum = float( 0.0 ).toVar();
            const distW = float( 0.0 ).toVar();

            // The break guard. See note 1 in the header: once this is 1 the
            // remaining iterations run to maxIter doing nothing, which is
            // value-identical to the GLSL's `break` and slower than it.
            const done = int( 0 ).toVar();

            Loop( { start: int( 0 ), end: maxIter }, () => {

              If( done.equal( int( 0 ) ), () => {

                // The two remaining clauses of the GLSL's
                // `if (i >= maxIter || t > t1 || trans < 0.015) break;`.
                // Tested in the GLSL's order, before anything is read.
                If( t.greaterThan( t1 ), () => {

                  done.assign( int( 1 ) );

                } );
                If( trans.lessThan( 0.015 ), () => {

                  done.assign( int( 1 ) );

                } );

                If( done.equal( int( 0 ) ), () => {

                  // Snapshotted before the tree can change `inside`. See note 4.
                  const dt = select( inside.equal( int( 1 ) ), dtF, dtC ).toVar();
                  const p = ro.add( rd.mul( t ) ).toVar();
                  const alt = c.add( rd.mul( t ) ).length().sub( R_PLANET ).toVar();

                  // LOD must depend only on the ray, never on which mode the march is in:
                  // if the coarse search tests a different density field from the one the
                  // fine march integrates, it steps over cloud the fine pass would have found
                  // and the miss is decided by the dither offset - which is a hole per pixel.
                  // The distance term must not outrun the projected size of the detail band:
                  // at 25 km a 400 m wisp is still ~20 px across, and dropping it there is
                  // what left far cloud as featureless dough. Step length, not range, is the
                  // thing that actually forces the LOD down.
                  //
                  // Note it uses lodStep (from dtF, the FINE step) in both modes,
                  // which is the "depend only on the ray" clause made concrete.
                  const lod = lodStep.max( remap01( t, 18000.0, 70000.0 ) ).toVar();
                  const d = cloudDensity( p, alt, lod ).toVar();

                  // --- GLSL's `if (!inside)` block, both of its continues ---
                  If( inside.equal( int( 0 ) ), () => {

                    If( d.greaterThan( 0.0 ), () => {

                      // Back up one coarse step and re-enter with fine steps so the leading
                      // edge is not chopped off at coarse resolution. The offset has to be
                      // dithered as well: an undithered fine lattice quantises every
                      // silhouette to one fine step and draws a comb across the cloud.
                      //
                      // No accumulation on this iteration - the GLSL `continue`s,
                      // and the backed-up t is re-tested from the top next time.
                      inside.assign( int( 1 ) );
                      empty.assign( int( 0 ) );
                      t.assign( t.sub( dtC ).add( dtF.mul( ign ) ).max( t0 ) );

                    } ).Else( () => {

                      t.addAssign( dt );

                    } );

                  } ).Else( () => {

                    // --- GLSL's `if (d <= 0.0)` block ---
                    If( d.lessThanEqual( 0.0 ), () => {

                      // Five consecutive empty fine samples before dropping back
                      // to the coarse search: a cumulus is full of small gaps and
                      // leaving on the first one re-pays the re-entry cost over
                      // and over through the body of the same cloud.
                      empty.addAssign( int( 1 ) );
                      If( empty.greaterThan( int( 4 ) ), () => {

                        inside.assign( int( 0 ) );
                        empty.assign( int( 0 ) );

                      } );
                      // Advances by the FINE step even on the iteration that
                      // leaves - see note 4.
                      t.addAssign( dt );

                    } ).Else( () => {

                      // --- the integrate path ---
                      empty.assign( int( 0 ) );

                      const sigma = d.mul( uCloudExtinction ).toVar();
                      const hRel = clamp( alt.sub( lo ).div( uCloudThickness.max( 1.0 ) ), 0.0, 1.0 ).toVar();

                      // Two full light marches, exactly as the GLSL - an Fn
                      // without a layout is inlined, so this is two marches in
                      // the emitted code as well. The moon one collapses to
                      // nothing when moonColor is zero, inside cloudLight.
                      const direct = cloudLight( p, alt, sunDir, sunColor, mu )
                        .add( cloudLight( p, alt, moonDir, moonColor, muM ) ).toVar();

                      // An optically thin element sitting in a roughly isotropic radiance field
                      // re-emits that field: in the thin limit the source function IS the sky
                      // radiance, which is why a wisp of cirrus is invisible against blue sky.
                      // The old 0.45*0.28 floor made every thin edge *darker* than the sky behind
                      // it - hence dark streaks across the deck and shadow sides that went brown
                      // instead of blue-grey.
                      const ao = mix( uCloudAmbFloor, float( 1.0 ), hRel ).toVar();
                      const amb = mix( skyLow, skyTop, hRel ).mul( uCloudAmbient ).mul( ao ).toVar();
                      const lightIn = direct.add( amb ).toVar();

                      const tr = sigma.mul( dt ).negate().exp().toVar();
                      // The GLSL spells (1.0 - tr) three times; pinned once.
                      const oneMinusTr = tr.oneMinus().toVar();

                      // Order matters: all three accumulators read `trans` BEFORE
                      // it is attenuated, and distSum reads the CURRENT t before
                      // it is advanced. distSum/distW is a transmittance-weighted
                      // mean depth - the distance the haze below is applied at,
                      // which is why it is weighted by what the eye actually sees
                      // rather than by geometry.
                      scatter.addAssign( trans.mul( lightIn ).mul( oneMinusTr ) );
                      distSum.addAssign( t.mul( trans ).mul( oneMinusTr ) );
                      distW.addAssign( trans.mul( oneMinusTr ) );
                      trans.mulAssign( tr );
                      t.addAssign( dt );

                    } );

                  } );

                } );

              } );

            } );

            // The march bails early rather than at trans = 0; renormalise so a saturated
            // cloud really does reach alpha 1. A leftover 0.4% is not a rounding detail:
            // a star is two orders of magnitude brighter than a moonlit cloud, so 0.4%
            // of it is still plainly visible *through* a 3 km cumulus.
            //
            // 0.985 is 1 - 0.015, the `trans < 0.015` bail threshold above. The
            // two constants are a pair: change the bail and this has to follow.
            const alpha = clamp( trans.oneMinus().div( 0.985 ), 0.0, 1.0 ).toVar();

            // GLSL: if (alpha <= 0.001) return vec4(0.0);
            If( alpha.greaterThan( 0.001 ), () => {

              // GLSL: float dist = distW > 1e-5 ? distSum/distW : t0;
              // If/Else rather than select(): select's operands are both
              // evaluated in the generated code, and distSum/distW with distW at
              // zero is a NaN that would then propagate through hazeTr into the
              // frame. The guard has to be a branch.
              const dist = float( 0.0 ).toVar();
              If( distW.greaterThan( 1e-5 ), () => {

                dist.assign( distSum.div( distW ) );

              } ).Else( () => {

                dist.assign( t0 );

              } );

              // Haze the deck with distance so far clouds sit behind the same air the water
              // does, instead of staying crisp all the way to the horizon. Mie dominates at
              // cloud level and it is what actually washes a distant deck out into the sky,
              // so it gets its own weight rather than riding on turbidity alone.
              //
              // meanD is the air density at the deck's own altitude (35% of the
              // way up the slab), so the optical depth is that density times the
              // path rather than a sea-level path - a cloud at 1.5 km is above a
              // sixth of the atmosphere's mass already.
              const meanD = uCloudAltitude.add( uCloudThickness.mul( 0.35 ) ).negate().div( H_RAY ).exp().toVar();
              const hazeTr = BETA_R.add( BETA_M_EXT.mul( uTurbidity ) )
                .mul( meanD ).mul( dist ).mul( uCloudHaze ).negate().exp().toVar();

              // The march has a hard range limit, and the elevation at which the cloud-base
              // shell crossing runs past it is a *line* across the sky. Fading alpha there
              // would punch a bright hole in an overcast deck; driving the deck fully into
              // the air colour instead makes the truncation literally invisible, because
              // what is left is the same sky the background pass already drew.
              hazeTr.mulAssign( remap01( dist, far.mul( uCloudFade ), far ).oneMinus() );

              result.assign( vec4( scatter.mul( hazeTr ).add( air.mul( hazeTr.oneMinus() ).mul( alpha ) ), alpha ) );

            } );

          } );

        } );

      } );

    } );

  } );

  return result;

} );

// ---- driving it -------------------------------------------------------------

// Mirror of the march's slice of Sky.drawBackground's uniform block in
// src/sky.js - the same params object, so the TSL path and the GLSL path cannot
// drift. Three names differ between the params object and the shader and all
// three are easy to get wrong:
//
//   uCloudSteps     is NOT p.cloudSteps - it is the adaptive product, floored at
//                   8. p.cloudStepScale is the frame-rate governor's multiplier
//                   and defaults to 1; the `?? 1` is src/sky.js's, kept because
//                   a host application may hand over a params object without it.
//   uCloudMS        is p.cloudMultiScatter
//   uCloudAmbFloor  is p.cloudAmbientFloor
//
// The field's own uniforms are NOT set here: call setCloudUniforms(p, ctx) from
// ./cloud-field.js and setAtmosphereUniforms(p) from ./atmosphere.js as well.
// Three calls, because the three uniform sets have three different owners and
// two of them are shared with the water and spray passes.
export function setCloudMarchUniforms( p ) {

  uCloudSteps.value = Math.max( 8, Math.round( p.cloudSteps * ( p.cloudStepScale ?? 1 ) ) );
  uCloudExtinction.value = p.cloudExtinction;
  uCloudMS.value = p.cloudMultiScatter;
  uCloudPowder.value = p.cloudPowder;
  uCloudSilver.value = p.cloudSilver;
  uCloudAmbient.value = p.cloudAmbient;
  uCloudAmbFloor.value = p.cloudAmbientFloor;
  uCloudHaze.value = p.cloudHaze;

}
