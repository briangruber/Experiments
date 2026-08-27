// Hands the prototype's wake field to Abyssal's water shader.
//
// Abyssal's WaterSurface.render() takes `opts.wake`: anything with a
// uniforms(p, active) method. That is the whole seam — it was built so the
// package's own wake could be swapped out, and it happens to be exactly the
// shape needed to swap OURS in.
//
// The two field textures already agree on format (RGBA half-float) and on the
// idea (one texture, world-space, sampled by position). They disagree on what
// the four channels MEAN, and that disagreement is resolved in the vendored
// wakeAt() rather than here — see vendor/abyssal/src/wake.js, which is forked
// to read this packing:
//
//     R  foam coverage 0..2      (theirs: stir)
//     G  surface height, SIGNED  (theirs: normalised age)
//     B  surfaced bubbles        (theirs: lateral offset)
//     A  bubble density          (theirs: arm growth rate)
//
// Signed height in G is why the half-float format matters and why this could
// not have been an 8-bit texture: half the wake is below the waterline.

import { get } from './params.js';

export class WakeBridge {

	constructor( renderer, field ) {

		this.renderer = renderer;
		this.field = field;
		this._warned = false;

	}

	/**
	 * The prototype's render target as a raw WebGLTexture.
	 *
	 * Abyssal draws with its own programs on the same context, so it binds
	 * textures itself rather than going through three — which means reaching
	 * past three's wrapper to the object it allocated. Guarded: the property is
	 * only populated once three has actually uploaded the target, so on the
	 * very first frame there is legitimately nothing there yet.
	 */
	_glTexture() {

		const props = this.renderer.properties.get( this.field.rt.texture );
		return props?.__webglTexture ?? null;

	}

	/**
	 * Uniforms for one frame. Every uWake* the compiled program declares has to
	 * be present — a missing sampler is not "unused", it is an unbound texture
	 * unit reading whatever was there last.
	 */
	uniforms( p, active ) {

		const gl = this.renderer.getContext();
		const tex = this._glTexture();
		const on = active && tex ? 1 : 0;
		// Diagnostics: whether the seam is actually carrying anything. A wake that
		// silently fails to bind looks identical to a wake that is simply not
		// there, and only one of those is a bug.
		this.lastOn = on;
		this.lastHasTex = !! tex;
		this.lastExtent = this.field.extent;
		this.frames = ( this.frames || 0 ) + 1;

		if ( ! tex && ! this._warned ) {
			// Once, not every frame: this is normal on frame one and a real
			// problem if it persists, and a per-frame warning hides the
			// difference between the two.
			this._warned = true;
			console.info( 'wake field not yet uploaded; sea draws without a wake this frame' );
		}

		const c = this.field.center;
		return {
			uWakeTex: { target: gl.TEXTURE_2D, tex },
			uWakeOrigin: new Float32Array( [ c.x, c.y ] ),
			uWakeExtent: Math.max( this.field.extent, 1 ),
			uWakeOn: on,
			// The prototype's field carries its own decay, shaping and arm
			// geometry already baked in, so every knob Abyssal would use to
			// SHAPE a wake is neutral here. Only the two that scale what we
			// hand it do anything: strength and depth.
			uWakeStrength: 1,
			uWakeDepth: 1,
			uWakeLife: 1e9,          // ours is faded in the field, not clipped by age
			uWakeEdge: 0.22,         // radial feather at the field's rim
			uWakeArmW: 1, uWakeArm: 0, uWakeChurn: 0, uWakeSpread: 1,
			uWakeBeam: 1, uWakeWidth0: 0, uWakeWidth1: 0, uWakeArms: 0,
			uWakeTrail: 0, uWakeTurb: 0, uWakeCut: 0,
			uWakeHead: new Float32Array( [ 0, 0 ] ),
			uWakeFwd: new Float32Array( [ 0, 1 ] ),
			uWakeSpeed: 0,
			uWakeBow: new Float32Array( [ 0, 0, 0, 8 ] ),
			// Abyssal's own leftover-energy ribbon. Off: that is the film this
			// prototype exists to replace.
			uFoamEnergy: { target: gl.TEXTURE_2D, tex },
			uFoamEnergyOn: 0,
			// The submerged half of the wake. B is how much of the cloud has
			// surfaced, A how dense it is -- both already in the field, and
			// unused until now because the fork only returned three channels.
			uBubOn: get( 'bubbles.plume' ),
			uBubBright: get( 'bubbles.brightness' ),
			uBubMilk: get( 'bubbles.milkiness' ),
			uBubDeepTint: get( 'bubbles.deepTint' ),
			uBubCol: ( () => {
				// Green through blue-green: what a bubble cloud scatters back
				// depends on how much water is still above it.
				const bt = get( 'bubbles.tint' );
				return new Float32Array( [ 0.06 + bt * 0.06, 0.40 + bt * 0.07, 0.34 + bt * 0.30 ] );
			} )(),
		};

	}

}
