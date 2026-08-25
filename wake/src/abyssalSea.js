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
import { newParams } from '../vendor/abyssal/src/presets.js';


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

export class AbyssalSea {

	constructor( renderer, { preset = 'Golden Hour Swell' } = {} ) {

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
		this.sky = new AbyssalSky( renderer, { params: this.params } );
		this.water = new AbyssalWater( renderer, { params: this.params, sky: this.sky } );

	}

	/** Step the wave simulation and the atmosphere. `dt` in seconds. */
	update( dt, camera ) {

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
	 * Draw a whole frame: sea, then the caller's scene, then sky. Sequencing it
	 * here rather than leaving three calls to the caller is the point — the
	 * order is a correctness requirement, not a preference, and every way of
	 * getting it wrong fails silently (a wiped sea, a piling cut off in a
	 * straight line, or the cloud march running full-screen behind geometry).
	 */
	render( scene, camera ) {

		this.renderer.clear();
		this.water.render( camera );
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
