// Atmosphere in TSL: the Rayleigh and Mie coefficients, the ozone layer, the
// phase functions, the transmittance integral, the multiple-scattering energy
// series and aerial perspective. One source, compiled to WGSL on WebGPU and to
// GLSL on WebGL2 by Three, so the renderer's backend fallback covers the
// shaders too.
//
// Translated from ATMOSPHERE_GLSL in src/shaders/sky.js. The physics is
// unchanged. Every constant, sign, clamp and magic number below is the one that
// shipped, and the comments explaining *why* each is what it is have been
// carried across with them - several of those constants look arbitrary and are
// not, so the comment is load-bearing documentation, not decoration.
//
// Five things a reader coming from the GLSL has to know, because they are
// exactly the places where a line-by-line reading would mislead:
//
// 1. GLSL `out` parameters do not exist in TSL. `densities()` returned three
//    floats through them; here it returns vec3(dR, dM, dO) and callers read
//    .x/.y/.z. `aerialPerspective()` returned two vec3s the same way, and it is
//    the one function here that is NOT an `Fn` - see its own comment for why.
//
// 2. An `Fn` with no explicit layout is INLINED at each call site rather than
//    emitted as a shader function (three r185, ShaderCallNodeInternal.call:
//    without `layout` it evaluates the JS body straight into the caller's
//    stack). So a node used more than once is *recomputed* unless it is pinned.
//    Every multi-use intermediate below is a `.toVar()` for that reason, not
//    for style - dropping one silently doubles a transmittance march.
//
// 3. The GLSL writes `for (int i=0;i<8;i++){ if (i>=N) break; ... }`. The
//    constant bound is a WebGL-era loop-unrolling workaround and the `break` is
//    there only to fake the dynamic bound it could not write; TSL's `Loop` takes
//    a dynamic end directly, so the workaround is dropped and the break with it.
//    What that also drops is the literal cap the constant bound imposed: 8 for
//    sunTransmittanceN, 64 for skyScatter. Every call site is inside those caps
//    (4 and 8; 24 and 12), so the behaviour is identical - but a caller passing
//    N > 8 would now get N steps where the GLSL gave 8.
//
// 4. GLSL's early `return` has no equivalent inside a node graph. Each one
//    became a result var assigned under If/Else, noted at the site. Where the
//    GLSL relied on `||` short-circuiting to avoid a NaN (planetDist), the two
//    tests are nested instead, because TSL has no short-circuit.
//
// 5. GLSL promotes int to float in mixed expressions and TSL does not, so every
//    `float(i+1)/float(N)` is spelled `float(i.add(1)).div(float(N))` here. The
//    conversions are not noise; without them the loop parameter is integer
//    division and every march collapses onto its first step.

import { Fn, If, Loop, float, int, vec3, uniform } from 'three/tsl';

// ---- uniforms ---------------------------------------------------------------
// The GLSL declares these once per program and src/sky.js fills every one of
// them, for every program that evaluates the atmosphere, from the same params
// object (Sky.atmosphereUniforms). One shared set of uniform nodes is the same
// thing expressed the way TSL expects a uniform reused across materials to be
// authored: set the value once, every material that references the node sees it.
//
// Defaults are the shipping defaults from src/presets.js, so this module
// evaluates to a sane sky before anything has called setAtmosphereUniforms().

export const uTurbidity    = /*@__PURE__*/ uniform( 1.0 );
export const uOzone        = /*@__PURE__*/ uniform( 1.0 );
export const uSunIrradiance = /*@__PURE__*/ uniform( 'vec3' );
export const uMieG         = /*@__PURE__*/ uniform( 0.76 );
export const uAtmoExposure = /*@__PURE__*/ uniform( 1.0 );
export const uMultiScatter = /*@__PURE__*/ uniform( 1.0 );      // gain on the >=2nd order scattering series
export const uMSFloor      = /*@__PURE__*/ uniform( 0.12 );     // isotropic part of the multi-scatter source
export const uMSHeight     = /*@__PURE__*/ uniform( 12000.0 );  // altitude the multi-scatter source is sampled at, m

// presets.js default: sunTint [1,1,1] * sunIntensity 22.
uSunIrradiance.value.set( 22.0, 22.0, 22.0 );

// Mirror of Sky.atmosphereUniforms(p) in src/sky.js - the same params object,
// the same eight values, so the TSL path and the GLSL path cannot drift.
export function setAtmosphereUniforms( p ) {

	uTurbidity.value = p.turbidity;
	uOzone.value = p.ozone;
	uSunIrradiance.value.set( p.sunIrradiance[ 0 ], p.sunIrradiance[ 1 ], p.sunIrradiance[ 2 ] );
	uMieG.value = p.mieG;
	uAtmoExposure.value = p.atmoExposure;
	uMultiScatter.value = p.skyMultiScatter;
	uMSFloor.value = p.skyMSFloor;
	uMSHeight.value = p.skyMSHeight;

}

// ---- constants --------------------------------------------------------------
// Exported as plain JS numbers as well as nodes: the sky, cloud and water
// modules build expressions like `R_PLANET + max(camPos.y, 1.0)` on the CPU
// side, and a JS number folds into the shader as a literal exactly the way the
// GLSL `const float` did.

export const R_PLANET = 6371000.0;
export const R_ATMOS  = 6471000.0;
export const TAU_A    = 6.28318530718;
export const PI_A     = 3.14159265359;
export const BETA_MS  = 3.996e-6;   // Mie scattering
export const BETA_MA  = 4.400e-6;   // Mie absorption
export const H_RAY    = 8000.0;     // Rayleigh scale height, m
export const H_MIE    = 1200.0;     // Mie scale height, m

export const BETA_R = /*@__PURE__*/ vec3( 5.802e-6, 13.558e-6, 33.100e-6 );
export const BETA_O = /*@__PURE__*/ vec3( 0.650e-6, 1.881e-6, 0.085e-6 );

// The GLSL spells these inline as `vec3(BETA_MS+BETA_MA)` (extinction: Mie
// scatters and absorbs) and `vec3(BETA_MS)` (scattering only). Naming them keeps
// the distinction visible, which matters - using the extinction triple where the
// source term wants the scattering one quietly darkens every haze-lit surface.
export const BETA_M_EXT = /*@__PURE__*/ vec3( BETA_MS + BETA_MA, BETA_MS + BETA_MA, BETA_MS + BETA_MA );
export const BETA_M_SCA = /*@__PURE__*/ vec3( BETA_MS, BETA_MS, BETA_MS );

// ---- phase functions --------------------------------------------------------

export const rayleighPhase = /*@__PURE__*/ Fn( ( [ c ] ) => {

	return float( 3.0 ).div( 16.0 * PI_A ).mul( c.mul( c ).add( 1.0 ) );

} );

export const miePhase = /*@__PURE__*/ Fn( ( [ c, g ] ) => {

	const g2 = g.mul( g ).toVar();
	// `g.mul(2.0).mul(c)` rather than `g.mul(c).mul(2.0)`: multiplying by 2 is
	// exact, so this reproduces the GLSL's `2.0*g*c` bit for bit.
	const denom = g2.add( 2.0 ).mul( g2.add( 1.0 ).sub( g.mul( 2.0 ).mul( c ) ).max( 1e-4 ).pow( 1.5 ) );

	return float( 3.0 ).div( 8.0 * PI_A )
		.mul( g2.oneMinus().mul( c.mul( c ).add( 1.0 ) ) )
		.div( denom );

} );

// ---- geometry ---------------------------------------------------------------

// Distance to the outer atmosphere shell (assumes the origin is inside it).
export const atmosDist = /*@__PURE__*/ Fn( ( [ ro, rd ] ) => {

	const b = ro.dot( rd ).toVar();
	const c = ro.dot( ro ).sub( R_ATMOS * R_ATMOS ).toVar();
	const d = b.mul( b ).sub( c ).toVar();

	// GLSL: `if (d < 0.0) return 0.0;` then `return -b + sqrt(d);`. The early
	// return becomes a result var so the sqrt is only reached where d >= 0.
	const t = float( 0.0 ).toVar();
	If( d.lessThan( 0.0 ), () => {

		t.assign( 0.0 );

	} ).Else( () => {

		t.assign( d.sqrt().sub( b ) );

	} );

	return t;

} );

export const planetDist = /*@__PURE__*/ Fn( ( [ ro, rd ] ) => {

	const b = ro.dot( rd ).toVar();
	const c = ro.dot( ro ).sub( R_PLANET * R_PLANET ).toVar();
	const d = b.mul( b ).sub( c ).toVar();

	// GLSL: `if (d < 0.0 || (-b - sqrt(d)) < 0.0) return -1.0;`. That `||`
	// short-circuits, and it has to: sqrt() of a negative d is NaN, and a NaN
	// compared against 0.0 is false, so an unguarded version would report a hit
	// on every ray that misses the planet. TSL has no short-circuit, so the two
	// tests are nested and the sqrt lives on the branch where d >= 0.
	const t = float( - 1.0 ).toVar();
	If( d.lessThan( 0.0 ), () => {

		t.assign( - 1.0 );

	} ).Else( () => {

		const tNear = b.negate().sub( d.sqrt() ).toVar();
		If( tNear.lessThan( 0.0 ), () => {

			t.assign( - 1.0 );

		} ).Else( () => {

			t.assign( tNear );

		} );

	} );

	return t;

} );

// ---- medium -----------------------------------------------------------------

// Returns vec3(dR, dM, dO) - the GLSL passed these back through three `out`
// parameters, which TSL has no equivalent for.
export const densities = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const h = p.length().sub( R_PLANET ).max( 0.0 ).toVar();
	const dR = h.negate().div( H_RAY ).exp();
	const dM = h.negate().div( H_MIE ).exp().mul( uTurbidity );
	// Ozone is a layer, not an exponential: a triangular profile peaking at
	// 25 km and vanishing 15 km either side of it.
	const dO = h.sub( 25000.0 ).abs().div( 15000.0 ).oneMinus().max( 0.0 ).mul( uOzone );

	return vec3( dR, dM, dO );

} );

export const extinctionAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const d = densities( p ).toVar();

	return BETA_R.mul( d.x ).add( BETA_M_EXT.mul( d.y ) ).add( BETA_O.mul( d.z ) );

} );

// Air density falls off exponentially, so a uniform march over a path that can
// be a thousand kilometres long puts its very first sample above the bulk of
// the atmosphere. Cubing the parameter clusters samples where the mass is and
// makes the grazing-ray integral converge with a handful of steps - without it
// the horizon is quantised into a hard band and sunsets never redden.
export const pathT = /*@__PURE__*/ Fn( ( [ tMax, u ] ) => {

	return tMax.mul( u ).mul( u ).mul( u );

} );

// ---- transmittance ----------------------------------------------------------

// N is a step count, and it is a parameter because the two callers want
// different ones: the main sun ray takes 8 (via sunTransmittance below) and the
// multiple-scattering tap in msSource takes 4, which is half the cost for a term
// that is already a stand-in. `int(4)` / `int(8)` is the form to prefer; a bare
// JS number also works (TSL makes it a float node and the `int(N)` below casts
// it), and both were checked to give bit-identical output to the GLSL.
export const sunTransmittanceN = /*@__PURE__*/ Fn( ( [ p, sunDir, N ] ) => {

	const tr = vec3( 0.0 ).toVar();

	// GLSL: `if (planetDist(p, sunDir) > 0.0) return vec3(0.0);` - the ground is
	// between this point and the sun, so nothing gets through. The early return
	// becomes an If/Else around the whole march, which also keeps the GLSL's
	// property that the march is skipped entirely rather than masked afterwards.
	If( planetDist( p, sunDir ).greaterThan( 0.0 ), () => {

		tr.assign( vec3( 0.0 ) );

	} ).Else( () => {

		const d = atmosDist( p, sunDir ).toVar();
		const od = vec3( 0.0 ).toVar();
		const tPrev = float( 0.0 ).toVar();

		// GLSL: `for (i<8) { if (i>=N) break; ... }` - see note 3 at the top.
		Loop( { start: int( 0 ), end: int( N ) }, ( { i } ) => {

			const tNext = pathT( d, float( i.add( 1 ) ).div( float( N ) ) ).toVar();
			const dt = tNext.sub( tPrev ).toVar();
			od.addAssign( extinctionAt( p.add( sunDir.mul( tPrev.add( dt.mul( 0.5 ) ) ) ) ).mul( dt ) );
			tPrev.assign( tNext );

		} );

		tr.assign( od.negate().exp() );

	} );

	return tr;

} );

export const sunTransmittance = /*@__PURE__*/ Fn( ( [ p, sunDir ] ) => {

	return sunTransmittanceN( p, sunDir, int( 8 ) );

} );

// ---- multiple scattering ----------------------------------------------------

// Source term for the >=2nd scattering orders. Those photons did not travel
// along this point's own sun ray: they arrive from the whole neighbourhood, and
// near the ground most of that neighbourhood is the thinner, brighter air
// *above*. One extra transmittance tap a couple of scale heights up stands in
// for that. It matters twice over: a constant floor is achromatic, which is
// precisely what paints a milky grey band across a golden-hour horizon, and it
// never switches off, which leaves a daylight-blue glow on the horizon hours
// after sunset. Lifting the sample makes both behave - the hue follows the
// transmitted sunlight, and the term dies as the terminator climbs past uMSHeight.
export const msSource = /*@__PURE__*/ Fn( ( [ p, lightDir, tr ] ) => {

	const trHi = sunTransmittanceN( p.add( p.normalize().mul( uMSHeight ) ), lightDir, int( 4 ) );

	return tr.mul( 0.275 ).add( trHi.mul( float( 0.275 ).add( uMSFloor ) ) );

} );

// Fraction of light that gets re-scattered on a typical low path, per channel.
// Used to size the multiple-scattering series: blue is scattered ~5x more than
// red, so a grey multi-scatter constant is exactly what makes a sky look milky.
//
// The per-channel part is the whole point and it is easy to lose in
// translation: tau, k and the 1/(1-0.82k) series sum are all vec3, never float.
// Collapsing any of them to a scalar - or to a luminance - is what turns a
// sunset into a grey wash.
export const msGain = /*@__PURE__*/ Fn( () => {

	const tau = BETA_R.add( BETA_M_SCA.mul( uTurbidity ).mul( 0.6 ) ).mul( H_RAY ).mul( 2.2 ).toVar();
	const k = tau.negate().exp().oneMinus().toVar();

	// uMultiScatter * k / (1 - 0.82k): the geometric sum of the higher orders,
	// with 0.82 standing in for how much of each order feeds the next. Per
	// channel, so blue converges to a larger value than red - which is the
	// energy series doing its job.
	return k.mul( uMultiScatter ).div( k.mul( 0.82 ).oneMinus() );

} );

// ---- the scattering integral ------------------------------------------------

// Single scattering plus an energy-series multiple-scatter term.
//
// `steps` is a parameter: the LUT pass marches 24 for the sun and 12 for the
// moon. Pass it as an int node.
export const skyScatter = /*@__PURE__*/ Fn( ( [ ro, rd, lightDir, irradiance, steps ] ) => {

	const tMax = atmosDist( ro, rd ).toVar();
	const tGround = planetDist( ro, rd ).toVar();

	// GLSL keeps a `bool hitGround` and reuses it below. A bool var is not
	// something this repo's probes have exercised, and the test is a single
	// compare against a var that is already materialised, so it is simply
	// repeated at the second site instead.
	If( tGround.greaterThan( 0.0 ), () => {

		tMax.assign( tGround );

	} );

	// GLSL: `if (tMax <= 0.0) return vec3(0.0);` - the ray never enters the
	// atmosphere. Becomes a result var guarded by the complementary test.
	const result = vec3( 0.0 ).toVar();
	If( tMax.greaterThan( 0.0 ), () => {

		const cosT = rd.dot( lightDir ).toVar();
		const pR = rayleighPhase( cosT ).toVar();
		const pM = miePhase( cosT, uMieG ).toVar();

		const sumR = vec3( 0.0 ).toVar();
		const sumM = vec3( 0.0 ).toVar();
		const sumMS = vec3( 0.0 ).toVar();
		const od = vec3( 0.0 ).toVar();
		const tPrev = float( 0.0 ).toVar();

		// GLSL: `for (i<64) { if (i>=steps) break; ... }` - see note 3 at the top.
		Loop( { start: int( 0 ), end: int( steps ) }, ( { i } ) => {

			const tNext = pathT( tMax, float( i.add( 1 ) ).div( float( steps ) ) ).toVar();
			const dt = tNext.sub( tPrev ).toVar();
			const p = ro.add( rd.mul( tPrev.add( dt.mul( 0.5 ) ) ) ).toVar();
			tPrev.assign( tNext );

			const dens = densities( p ).toVar();
			const ext = BETA_R.mul( dens.x ).add( BETA_M_EXT.mul( dens.y ) ).add( BETA_O.mul( dens.z ) ).toVar();
			// Midpoint transmittance: the steps are long, so evaluating at the segment
			// start over-counts the near end badly.
			const trans = od.add( ext.mul( dt ).mul( 0.5 ) ).negate().exp().toVar();
			od.addAssign( ext.mul( dt ) );

			const tr = sunTransmittance( p, lightDir ).toVar();
			const sca = BETA_R.mul( dens.x ).toVar();
			const scaM = BETA_M_SCA.mul( dens.y ).toVar();

			sumR.addAssign( trans.mul( tr ).mul( sca ).mul( dt ) );
			sumM.addAssign( trans.mul( tr ).mul( scaM ).mul( dt ) );
			// Higher orders lose the phase function but keep the colour of the light
			// that fed them, which is the whole point of msSource().
			sumMS.addAssign( trans.mul( sca.add( scaM ) ).mul( dt ).mul( msSource( p, lightDir, tr ) ) );

		} );

		const col = sumR.mul( pR ).add( sumM.mul( pM ) ).mul( irradiance ).toVar();
		col.addAssign( sumMS.mul( irradiance ).mul( msGain() ).div( 4.0 * PI_A ) );

		If( tGround.greaterThan( 0.0 ), () => {

			// Sea reading below the horizon comes from the water pass, but the LUT still
			// needs something sane for downward reflection lookups: the ocean is a dark
			// Lambertian sheet lit by whatever made it down here.
			const gTr = sunTransmittance( ro.add( rd.mul( tGround ) ), lightDir ).toVar();
			col.addAssign( gTr.mul( irradiance ).mul( lightDir.y.max( 0.0 ) ).mul( 0.055 ).mul( od.negate().exp() ).div( PI_A ) );

		} );

		result.assign( col.mul( uAtmoExposure ) );

	} );

	return result;

} );

export const skyRadianceRaw = /*@__PURE__*/ Fn( ( [ ro, rd, sunDir, steps ] ) => {

	return skyScatter( ro, rd, sunDir, uSunIrradiance, steps );

} );

// ---- aerial perspective -----------------------------------------------------

// Analytic aerial perspective for surface shading at distance d.
//
// This is the one function in this file that is NOT an `Fn`, and the reason is
// its signature. The GLSL hands back two vec3s through `out` parameters:
//
//   void aerialPerspective(vec3 ro, vec3 rd, float d, vec3 sunDir,
//                          out vec3 inscatter, out vec3 transmit);
//
// TSL has no `out` parameter, and a node passed into an `Fn` is a value, not a
// reference - assigning to it inside would write a copy. The alternatives were
// to run the march twice, once per output, which is not a small cost (six steps,
// each carrying an 8-step sun transmittance and msSource's own 4-step tap, which
// makes this the most expensive function in the file), or to return a TSL
// `struct`, which exists in three r185 but is not among the mechanics this
// repo's probes verified on the WebGL2 backend.
//
// So it is a plain JS node-graph builder returning both. That costs nothing: an
// `Fn` without a layout is inlined at its call site anyway (see note 2 at the
// top), so this emits exactly what an Fn would have.
//
//   const { inscatter, transmit } = aerialPerspective( ro, rd, d, sunDir );
//   col.assign( col.mul( vec3( 1.0 ).mix( transmit, uAerial ) ).add( inscatter.mul( uAerial ) ) );
//
// It must be called from inside an Fn body during the build - it appends to the
// current TSL stack, so calling it at module scope has nothing to append to.
//
// Note that it reads uSunIrradiance directly rather than taking irradiance as a
// parameter, unlike skyScatter. That is what the GLSL does, and it is right: the
// water pass wants sunlight through the haze, never moonlight.
export function aerialPerspective( ro, rd, d, sunDir ) {

	const N = 6;   // GLSL: `const int N = 6`

	const od = vec3( 0.0 ).toVar();
	const sum = vec3( 0.0 ).toVar();
	const sumMS = vec3( 0.0 ).toVar();

	const cosT = rd.dot( sunDir ).toVar();
	const pR = rayleighPhase( cosT ).toVar();
	const pM = miePhase( cosT, uMieG ).toVar();
	const tPrev = float( 0.0 ).toVar();

	Loop( { start: int( 0 ), end: int( N ) }, ( { i } ) => {

		// Same cube-law spacing: near the camera the haze builds fastest.
		//
		// (The exponent is 1.6, not pathT's 3, and that is what shipped - a
		// surface at 60 km does not need the grazing-ray clustering a
		// thousand-kilometre sky ray does, and the softer curve keeps the six
		// steps spread across the visible range instead of piling them onto the
		// camera. Left exactly as it was; the comment above it is the GLSL's.)
		const tNext = float( d ).mul( float( i.add( 1 ) ).div( float( N ) ).pow( 1.6 ) ).toVar();
		const dt = tNext.sub( tPrev ).toVar();
		const p = ro.add( rd.mul( tPrev.add( dt.mul( 0.5 ) ) ) ).toVar();
		tPrev.assign( tNext );

		const dens = densities( p ).toVar();
		const ext = BETA_R.mul( dens.x ).add( BETA_M_EXT.mul( dens.y ) ).add( BETA_O.mul( dens.z ) ).toVar();
		const tr = od.add( ext.mul( dt ).mul( 0.5 ) ).negate().exp().toVar();
		od.addAssign( ext.mul( dt ) );

		const st = sunTransmittance( p, sunDir ).toVar();
		const sca = BETA_R.mul( dens.x ).toVar();
		const scaM = BETA_M_SCA.mul( dens.y ).toVar();

		sum.addAssign( tr.mul( st ).mul( sca.mul( pR ).add( scaM.mul( pM ) ) ).mul( dt ) );
		sumMS.addAssign( tr.mul( sca.add( scaM ) ).mul( dt ).mul( msSource( p, sunDir, st ) ) );

	} );

	const inscatter = sum.add( sumMS.mul( msGain() ).div( 4.0 * PI_A ) )
		.mul( uSunIrradiance ).mul( uAtmoExposure ).toVar();
	const transmit = od.negate().exp().toVar();

	return { inscatter, transmit };

}
