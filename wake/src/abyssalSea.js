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


/**
 * A calm lake at a high sun.
 *
 * Not the prettiest preset on offer — Golden Hour Swell is — but a wake is
 * only legible on water that is not already busy, and under light that is
 * actually reaching it. Calm Lake runs the sun at 38 degrees with 2.2 m/s of
 * wind and 0.48 choppiness, so there is almost no whitecap competing with the
 * foam, and it happens to be what this scene actually is.
 */
export const DEFAULT_PRESET = 'Calm Lake';

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
function fitToLake( p, preset = {} ) {

	const floor = get( 'scene.floor' );
	// Not zero: the floor terms are gated on depth, and 0 reads as "no floor
	// configured" rather than "floor far below".
	p.floorDepth = mix( 400, preset.floorDepth ?? 9, floor );
	p.floorDepthMin = mix( 400, preset.floorDepthMin ?? 3.5, floor );
	p.floorDepthMax = mix( 900, preset.floorDepthMax ?? 16, floor );

	const tint = get( 'scene.waterTint' );
	const c = preset.scatterColor ?? [ 0.055, 0.145, 0.095 ];
	const DEEP = [ 0.014, 0.072, 0.135 ];   // blue-dominant, a little green
	p.scatterColor = [
		mix( c[ 0 ], DEEP[ 0 ], tint ),
		mix( c[ 1 ], DEEP[ 1 ], tint ),
		mix( c[ 2 ], DEEP[ 2 ], tint ),
	];

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
		this.preset = preset;
		this.wake = null;
		fitToLake( this.params, PRESETS[ preset ] );
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
		fitToLake( this.params, PRESETS[ name ] );
		this.water.ocean.buildSpectrum( this.params );
		this.preset = name;
		return true;

	}

	/** Step the wave simulation and the atmosphere. `dt` in seconds. */
	update( dt, camera ) {

		// Live, so the lake-fit sliders take effect next frame like every other
		// knob here.
		fitToLake( this.params, PRESETS[ this.preset ] );
		this.water.update( dt, camera );
		this.sky.update( dt, camera );

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
	render( scene, camera ) {

		this.renderer.clear();
		this.water.render( camera, this.wake ? { wake: this.wake } : {} );
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
