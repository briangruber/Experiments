// The sea and sky, borrowed from the Abyssal ocean.
//
// The lab's own ocean.js is a single shader: one analytic swell, a sky
// function, and the wake field composited on top. It was built to iterate on
// the WAKE, and it does that well — but the water underneath it is a stand-in,
// and once the wake stopped being the weakest thing in frame the water was.
//
// Abyssal is an FFT sea with a volumetric sky, a real BRDF and an atmosphere
// table. Its classic entry is hand-written WebGL2 with no `import from 'three'`
// anywhere: it borrows the renderer's context, draws with its own programs, and
// hands the context back in the state Three expects. That is why it can be
// vendored whole into a prototype that has its own three build — there is no
// version of Three it can be out of step with.
//
// What is deliberately NOT taken: every one of its wake, foam and ribbon
// systems. Those are the parts this prototype exists to replace, so they are
// switched off at the parameter level (see QUIET below) rather than merely left
// unused — an unused system that still writes into the foam channels is not
// unused. The wake stays ours.
//
// Render order is not stylistic (vendor/abyssal/docs equivalent, threejs.md):
//   renderer.autoClear = false      — else render() wipes the sea
//   water.render(camera)            — first: it writes depth
//   renderer.render(scene, camera)  — boat and terrain, depth-tested against
//                                     the real displaced surface
//   sky.render(camera)              — last: one triangle at the far plane under
//                                     LEQUAL writing no depth, so the cloud
//                                     march only runs where nothing covered it

import { AbyssalWater, AbyssalSky } from '../vendor/abyssal/src/three/index.js';
import { newParams, applyPreset, PRESETS } from '../vendor/abyssal/src/presets.js';
import { get } from './params.js';
import { WaveProbe } from './waveProbe.js';


/**
 * A calm lake at a high sun.
 *
 * Not the prettiest preset on offer — Golden Hour Swell is — but a wake is
 * only legible on water that is not already busy, and under light that is
 * actually reaching it. Calm Lake runs the sun at 38 degrees with 2.2 m/s of
 * wind and 0.48 choppiness, so there is almost no whitecap competing with the
 * foam, and it happens to be what this scene actually is.
 */
export const DEFAULT_PRESET = 'Tropical Lagoon';

/**
 * The presets worth having on a slider, calmest first.
 *
 * All twelve of Abyssal's are available, but most of them are open-ocean
 * weather that buries a wake in its own chop. These are ordered so that
 * turning the knob up means "more sea", which is the only ordering a single
 * slider can honestly express.
 */
export const PRESET_NAMES = [
	'Calm Lake',
	'Sheltered Water',
	'Glassy Dawn',
	'Tropical Lagoon',
	'Deep Blue Afternoon',
	'Tropical Noon',
	'Golden Hour Swell',
	'Trade Winds',
	'Moonlit Passage',
	'North Atlantic Storm',
].filter( ( n ) => n in PRESETS );

/**
 * The water look that suits each weather, as values for the prototype's own
 * sliders. Applied when a scene is picked, through set(), so the panel and
 * the water never disagree -- and everything here remains a starting point
 * the sliders can still move.
 *
 * The two that matter most:
 *  · floor -- metres of sand under the boat. A lagoon is a lagoon because you
 *    can SEE the bottom; deep-water scenes push it away entirely.
 *  · tint -- how far to pull the preset's own scattering toward deep blue.
 *    Near zero for the lagoon, because its authored turquoise IS the look.
 */
export const SCENE_TUNE = {
	// A clear mountain lake: sand seen through slightly tea-stained water,
	// honest weed, and enough glow that looking down reads green-gold, not black.
	'Calm Lake':           { floor: 6,   caustics: 0.7,  weed: 0.30, tint: 0.55, glow: 1.5, sand: [ 0.72, 0.66, 0.50 ] },
	// A harbour: deeper, weedier, its own grey-green sand.
	'Sheltered Water':     { floor: 8,   caustics: 0.55, weed: 0.35, tint: 0.50, glow: 2.2, sand: [ 0.68, 0.63, 0.47 ] },
	// Dawn mirror. The light is the show; the bottom stays a suggestion.
	'Glassy Dawn':         { floor: 12,  caustics: 0.35, weed: 0.15, tint: 0.60, glow: 2.2 },
	// THE lagoon. Sand a metre or three down, bright as coral rubble, caustics
	// at full song, zero tint -- the preset's authored turquoise IS the look --
	// and the glow well up, because tropical shallows are lit from below.
	'Tropical Lagoon':     { floor: 4.5, caustics: 1.35, weed: 0.45, tint: 0,    glow: 1.0, sand: [ 0.74, 0.66, 0.46 ],
	                         scatter: [ 0.030, 0.26, 0.36 ], scatterAmt: 0.13, absorb: [ 0.34, 0.055, 0.030 ] },
	'Deep Blue Afternoon': { floor: 0,   caustics: 0,    weed: 0,    tint: 0.85, glow: 3.0 },
	// The lagoon's big sibling: a little deeper, a little more weed on the
	// flats, the same overhead blaze.
	'Tropical Noon':       { floor: 5.5, caustics: 1.1,  weed: 0.40, tint: 0.10, glow: 1.1, sand: [ 0.76, 0.68, 0.48 ],
	                         scatter: [ 0.050, 0.30, 0.34 ], scatterAmt: 0.15, absorb: [ 0.30, 0.050, 0.032 ] },
	'Golden Hour Swell':   { floor: 0,   caustics: 0,    weed: 0,    tint: 0.80, glow: 3.6 },
	'Trade Winds':         { floor: 0,   caustics: 0,    weed: 0,    tint: 0.75, glow: 3.0 },
	'Moonlit Passage':     { floor: 0,   caustics: 0,    weed: 0,    tint: 0.90, glow: 2.0 },
	'North Atlantic Storm': { floor: 0,  caustics: 0,    weed: 0,    tint: 0.85, glow: 3.2 },
};

/**
 * Everything in Abyssal that draws its own wake, foam ribbon or whitewater,
 * set to nothing.
 *
 * These are switched off rather than ignored because several of them write
 * into the same foamF / foamR coverage channels the surface shades from, so a
 * system that is merely not driven still tints the water. The names come from
 * vendor/abyssal/src/presets.js; anything added upstream later will simply not
 * appear here, which is why QUIET is asserted against the live parameter set
 * at construction instead of being trusted.
 */
export const QUIET = {
	wakeStrength: 0,          // the analytic Kelvin wake, master
	wakeArm: 0,               // ...its cusp arms
	wakeCentre: 0,            // ...and the churned lane between them
	wakeDepth: 0,
	wakeRelief: 0,            // wake height bending the surface normals
	wakePlume: 0,             // aerated water tinting the column under a wake
	wakeSlick: 0,             // the smooth lane a wake leaves in the wind foam
	wakeFoamDecay: 0,         // the leftover stern-foam ribbon
	wakeFoamWaveCarry: 0,     // leftover waves carrying existing foam along
	wakeFoamRibbonVary: 0,    // the ribbon's own contour / chew / opacity noise
	wakeSuds: 0,              // the breaking film — ours to do, in our own shader
	sdVWake: 0,               // the sea-dragon V
	sdVWakeAmp: 0,
	sdVWakeFoam: 0,
};

// The sun deliberately flows the OTHER way: Abyssal owns it, and the lab
// follows.
//
// The first pass had the lab's ocean.sunElev driving Abyssal's sunElevation,
// and it rendered a nearly black sea. The value is 3 degrees — tuned against
// the lab's own analytic sky function, where a low number is simply a warmer
// gradient and costs nothing. Abyssal has a real atmosphere: at 3 degrees the
// sun is through so much air that almost no light reaches the water, and from
// overhead, with no sky to reflect and no seafloor beneath, the sea is
// genuinely, correctly black.
//
// So the two numbers were never on the same scale, and the direction of the
// mapping was the bug. Abyssal's preset owns the sun now; sunDirection() hands
// it back so the prototype's own directional light, terrain and boat are lit
// by the same sun the sea and sky are.

const mix = ( a, b, t ) => a + ( b - a ) * t;

/**
 * Reconcile a preset with the fact that this scene already HAS a lake.
 *
 * Abyssal's presets carry their own procedural seafloor. Calm Lake's is a
 * shallow one -- 9 m, ranging 3.5 to 16 -- under green-dominant scattering
 * water, which is authored exactly right for what it is and reads as a bright
 * green pool the moment our own terrain is also in frame. Two bottoms, one
 * lake, and the green wins.
 *
 * So by default the floor is pushed out of sight and the scattering colour is
 * steered toward deep water, both under live control. scene.floor at 1 and
 * scene.waterTint at 0 restore precisely what the preset asked for.
 */
function fitToLake( p, preset = {}, tune = {} ) {

	// A real lake bottom, in metres, rather than a 0..1 fade of the preset's.
	//
	// Pushing the floor away killed the green, but it also removed the main
	// source of returned light -- a basin with no visible bottom genuinely is
	// dark from overhead at a 38 degree sun, which is why the look-down view
	// went black. A shallow SAND bed is the honest fix: it is what a lake
	// actually has, it lights the water from below, and it is not green.
	const depth = get( 'lake.floorDepth' );
	const on = depth > 0.05;
	p.floorDepth = on ? depth : 400;
	// A bed is not a flat plane: the shallow end catches the light and the
	// deeper end falls away. Kept as a ratio of the nominal depth so one
	// slider moves the whole bottom coherently.
	p.floorDepthMin = on ? depth * 0.45 : 400;
	p.floorDepthMax = on ? depth * 2.30 : 900;
	p.floorCaustic = get( 'lake.caustics' );

	// Sand, and how much weed is laid over it. Upstream's reef pattern assumes
	// a tropical bed; a lake wants far less of it.
	p.bedSand = tune.sand ?? [ 0.80, 0.71, 0.52 ];
	p.bedWeed = [ 0.10, 0.20, 0.17 ];
	p.bedWeedAmount = get( 'lake.weed' );

	// The lace, for the sea as well as the wake. Written every frame from the
	// prototype's own foam controls, so the two surfaces cannot drift apart.
	p.labLace = get( 'foamLook.lace' ) * 0.55;
	p.labSoft = get( 'foamLook.softness' );
	p.labCoarsen = get( 'foamLook.coarsen' );
	p.labDensity = get( 'foamMix.density' );
	p.labGain = get( 'foamMix.wakeGain' );
	p.labSeaLace = get( 'foamMix.seaLace' );
	p.labSeaBreak = get( 'foamMix.seaBreak' );

	const tint = get( 'scene.waterTint' );
	// A scene may commit to its own water colour outright. The preset library
	// authors for open ocean at its own exposure; a pond-sized lagoon needs
	// harder red absorption and a more saturated scatter to read tropical
	// instead of washing out to mint against the bright sand.
	if ( tune.absorb ) p.absorption = tune.absorb;
	const c = tune.scatter ?? preset.scatterColor ?? [ 0.055, 0.145, 0.095 ];
	// Deep water, and NOT darker water. The first version of this used
	// [0.014, 0.072, 0.135], which is a fine deep-ocean hue and dimmer than the
	// preset's green in every channel -- so it fixed the green by turning the
	// light down. Looking straight down that is exactly where it shows: at
	// normal incidence Fresnel reflects about 2% of the sky, so all you see is
	// what the water column scatters back, and dimming that paints the sea
	// black from above while the grazing view stays fine.
	const DEEP = [ 0.048, 0.170, 0.225 ];
	p.scatterColor = [
		mix( c[ 0 ], DEEP[ 0 ], tint ),
		mix( c[ 1 ], DEEP[ 1 ], tint ),
		mix( c[ 2 ], DEEP[ 2 ], tint ),
	];
	// How much light comes back OUT of the column, which is the whole of what
	// a look-down view sees. Calm Lake asks 0.07 -- a dark peat lake -- and at
	// that value an overhead camera gets a black mirror however the colour is
	// tuned. This is the knob that actually answers "why is it black from
	// above", so it is exposed rather than folded into the tint.
	p.scatterAmount = ( tune.scatterAmt ?? preset.scatterAmount ?? 0.07 ) * get( 'scene.waterGlow' );

}

export class AbyssalSea {

	constructor( renderer, { preset = DEFAULT_PRESET } = {} ) {

		// One shared parameter set, so the sea and the sky agree about the sun,
		// the wind and the air, and the atmosphere table is built once.
		this.params = newParams( preset );
		Object.assign( this.params, QUIET );

		// Trusting the list above would mean a silently re-enabled ribbon the
		// day one of these keys is renamed upstream. Every key must actually
		// exist in the parameter set it is quieting.
		const unknown = Object.keys( QUIET ).filter( ( k ) => ! ( k in this.params ) );
		if ( unknown.length ) {
			throw new Error( `AbyssalSea: no such parameter to quieten: ${ unknown.join( ', ' ) }. `
				+ 'The vendored ocean has renamed it, and its wake system may be live.' );
		}

		renderer.autoClear = false;
		this.renderer = renderer;
		this.probe = null;          // built lazily: needs the adopted gl context
		this.preset = preset;
		this.wake = null;
		fitToLake( this.params, PRESETS[ preset ], SCENE_TUNE[ preset ] );
		this.sky = new AbyssalSky( renderer, { params: this.params } );
		this.water = new AbyssalWater( renderer, { params: this.params, sky: this.sky } );

	}

	/**
	 * Switch weather. The spectrum has to be rebuilt — a preset is mostly wind
	 * and fetch, and those are baked into the FFT's initial spectrum rather than
	 * read per frame, so without this the sliders move and the sea does not.
	 *
	 * QUIET is re-applied afterwards: a preset carries its own wake and foam
	 * numbers, and loading one would otherwise switch Abyssal's ribbon back on
	 * underneath ours.
	 */
	setPreset( name ) {

		if ( ! ( name in PRESETS ) || name === this.preset ) return false;
		applyPreset( this.params, name );
		Object.assign( this.params, QUIET );
		fitToLake( this.params, PRESETS[ name ], SCENE_TUNE[ name ] );
		this.water.ocean.buildSpectrum( this.params );
		this.preset = name;
		return true;

	}

	/** Step the wave simulation and the atmosphere. `dt` in seconds. */
	update( dt, camera ) {

		// Live, so the lake-fit sliders take effect next frame like every other
		// knob here.
		fitToLake( this.params, PRESETS[ this.preset ], SCENE_TUNE[ this.preset ] );
		this.water.update( dt, camera );
		this.sky.update( dt, camera );

	}

	/**
	 * The sun as a LIGHT, not just a direction.
	 *
	 * Handing back only the direction was not enough, and the boats are what
	 * showed it: at a 4 degree golden-hour sun, N.L is near zero on every
	 * upward-facing surface, so a hull was lit almost entirely by the
	 * prototype's flat blue-grey AmbientLight and came out looking like white
	 * plastic. The texture was fine the whole time -- rendered unlit it is a
	 * warm brown at full saturation -- it simply had almost no directional
	 * light to show it.
	 *
	 * So the colour and the strength come from the same atmosphere the sea
	 * uses: a low sun is dim and red because its light has crossed far more air,
	 * and the sky's own contribution rises to fill in as it sets. Both fall out
	 * of the elevation rather than being dialled in per preset.
	 */
	sunLight() {

		const d = this.sunDirection();
		if ( ! d ) return null;
		const el = Math.max( d[ 1 ], 0 );                 // sin(elevation)

		// Air mass along the sight line to the sun, capped for the horizon
		// case where the true expression runs away.
		const air = 1 / Math.max( el, 0.05 );
		// Rayleigh takes the short wavelengths out first, which is why a low
		// sun is red. Coefficients in the usual ratio, scaled so a sun
		// overhead is very nearly white.
		const ext = ( k ) => Math.exp( - k * ( air - 1 ) * 0.09 );
		const p = this.params;
		const base = p.sunColor ?? [ 1, 1, 1 ];
		const colour = [ base[ 0 ] * ext( 1.0 ), base[ 1 ] * ext( 2.1 ), base[ 2 ] * ext( 4.4 ) ];

		// Extinction ONLY -- deliberately not multiplied by the elevation.
		//
		// A DirectionalLight's intensity is the irradiance PERPENDICULAR to the
		// beam; the cosine of the angle a surface makes with it falls out of
		// N.L during shading. Multiplying by sin(elevation) here applies that
		// cosine a second time, which put a 4 degree sun at 0.7% of noon
		// instead of about 9% and left the hull lit by ambient alone -- the
		// very fault this method exists to fix.
		const strength = ext( 2.1 );

		// What the sky puts in. It does not vanish with the sun -- at dusk it
		// is most of the light there is -- so it is floored, and tinted toward
		// the blue it actually is rather than toward the sun's own colour.
		const sky = 0.22 + 0.55 * Math.pow( Math.max( el, 0 ), 0.5 );

		return { colour, strength, sky };

	}

	/**
	 * Unit vector toward the sun, so everything the prototype draws itself is
	 * lit by the same one the sea and sky use. Returns null before the first
	 * update, which is the caller's cue to keep its own.
	 */
	sunDirection() {

		const d = this.water?.sunDirection;
		return d && d.length === 3 ? d : null;

	}

	/**
	 * Sample the sea's real height at four world XZ points — the hull's
	 * contact corners — via an async GPU readback (see waveProbe.js). Reads
	 * come back a frame late and smoothed; heights land in this.probe.h as
	 * [bow, stern, portish, starboardish] in the order the points were given.
	 *
	 * This is what buoyancy runs on. The surface only exists on the GPU, so
	 * without it a hull can only ever sit at y = 0 while the swell it is
	 * supposedly riding moves underneath it.
	 */
	probeWaves( points, dt ) {

		if ( ! this.probe ) this.probe = new WaveProbe( this.water.gl );
		this.probe.update( this.params, this.water.ocean, points, dt );
		return this.probe.h;

	}

	/**
	 * Hand the prototype's wake field to the water. Until this is set the sea
	 * draws with no wake at all, which is correct but not useful.
	 */
	setWake( bridge ) {

		this.wake = bridge;

	}

	/**
	 * Draw a whole frame: sea, then the caller's scene, then sky. Sequencing it
	 * here rather than leaving three calls to the caller is the point — the
	 * order is a correctness requirement, not a preference, and every way of
	 * getting it wrong fails silently (a wiped sea, a piling cut off in a
	 * straight line, or the cloud march running full-screen behind geometry).
	 */
	render( scene, camera, extra = {} ) {

		this.renderer.clear();
		this.water.render( camera,
			{ ...( this.wake ? { wake: this.wake } : {} ), ...extra } );
		this.renderer.render( scene, camera );
		this.sky.render( camera );

	}

	/** Wave height at a world point, for anything that has to float. */
	heightAt( x, z ) {

		return this.water.heightAt ? this.water.heightAt( x, z ) : 0;

	}

	dispose() {

		this.water?.dispose?.();
		this.sky?.dispose?.();

	}

}
