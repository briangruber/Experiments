// The refraction pass: what is UNDER the sea, rendered into its own target,
// with its own depth buffer, so the sea can look through itself at it.
//
// WHY THIS EXISTS. Abyssal's ocean is opaque and writes depth, and it computes
// everything about the water analytically - it never reads what is behind it.
// So a submerged mesh drawn before the sea is hidden and one drawn after it is
// pasted on top. Both were shipped and both were reported as exactly what they
// were: "it feels like the monster is just a transparent ghost on the water, it
// doesn't feel like it is IN the water", and then "I see its teeth through its
// body". docs/sea-dragon-handoff.md is the account.
//
// The fix is not an invention. `claude/saltyfin-webgpu` already renders meshes
// and a leviathan under water, seen through the surface with refraction and
// depth, on this same three.js node renderer, and it does it with a colour
// target and a MATCHING DEPTH TARGET sampled at a screen-space offset. This is
// that pass, ported (saltyfin/src/water/waterMaterial.js, src/main.js).
//
// Two things the depth attachment buys, and they are the two open faults in the
// handoff:
//
//   1. THE SUBMERGED PASS SORTS ITSELF. Drawn straight over the sea there was
//      nothing to sort against, so the animal had to be front-faces-only, and a
//      head with an open jaw is not a closed convex body: the far row of teeth
//      is front-facing, so it drew, and the last triangle in index order won.
//      In here it is an ordinary opaque double-sided draw.
//   2. THE SEA KNOWS HOW FAR DOWN IT IS. The depth reconstructs the length of
//      the water column between the surface and the body, which is what drives
//      the Beer-Lambert extinction in ./water-surface.js. The old blend faded
//      the animal by ITS OWN depth below mean sea level, which is a different
//      quantity and is wrong the moment you look at it from anywhere but
//      straight down.
//
// The target is HALF the HDR target's size on purpose. What it holds is going
// to be displaced by the surface slope and then buried under a Fresnel term;
// the sea never shows it sharply, and paying full resolution for something
// nobody can see is the kind of cost the frame-rate governor then has to find
// somewhere else.

import * as THREE from 'three/webgpu';

import { CLIP, setWaterClip } from './water-clip.js';

export class TslRefraction {

	/**
	 * @param {THREE.WebGPURenderer} renderer - already init()ed.
	 * @param {object} [opts]
	 * @param {number} [opts.scale] - fraction of the HDR target's size.
	 */
	constructor( renderer, { scale = 0.5 } = {} ) {

		this.renderer = renderer;
		this.scale = scale;
		this.target = null;
		this.width = 0;
		this.height = 0;

	}

	/**
	 * Size to the HDR target this will be composited into.
	 *
	 * Its own call rather than something done lazily inside render(), because
	 * ./water-surface.js binds these textures ONCE at graph build time (porting
	 * rule 11) and a target rebuilt mid-frame would leave the sea sampling a
	 * disposed one.
	 *
	 * @returns {THREE.RenderTarget} carrying `.texture` and `.depthTexture`.
	 */
	resize( w, h ) {

		const tw = Math.max( 8, Math.round( w * this.scale ) );
		const th = Math.max( 8, Math.round( h * this.scale ) );
		if ( this.target && tw === this.width && th === this.height ) return this.target;

		if ( this.target ) this.target.dispose();
		this.target = new THREE.RenderTarget( tw, th, {
			type: THREE.HalfFloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			depthBuffer: true,
			generateMipmaps: false,
		} );
		this.target.texture.name = 'abyssal.refraction';
		// CLAMPED, because the refraction offset walks the lookup off the edge of
		// the screen at the frame's border and a wrapped sample would fetch the
		// creature back in on the opposite side.
		this.target.texture.wrapS = THREE.ClampToEdgeWrapping;
		this.target.texture.wrapT = THREE.ClampToEdgeWrapping;

		// THE DEPTH IS AN EXPLICIT TEXTURE, not three's invented depth buffer,
		// because the sea reads it. Float, nearest, clamped: a depth sample is a
		// texel fetch by nature, and interpolating between the animal's depth and
		// the far plane across its silhouette invents a water column that is
		// neither.
		this.target.depthTexture = new THREE.DepthTexture( tw, th, THREE.FloatType );
		this.target.depthTexture.name = 'abyssal.refractionDepth';
		this.target.depthTexture.minFilter = THREE.NearestFilter;
		this.target.depthTexture.magFilter = THREE.NearestFilter;
		this.target.depthTexture.wrapS = THREE.ClampToEdgeWrapping;
		this.target.depthTexture.wrapT = THREE.ClampToEdgeWrapping;

		this.width = tw; this.height = th;
		return this.target;

	}

	/**
	 * Draw the submerged half of a scene.
	 *
	 * Cleared to TRANSPARENT BLACK and to the far plane. The alpha channel IS the
	 * coverage mask - it is what makes the sea's mix a no-op everywhere nothing
	 * was drawn, with no second pass and no stencil - and the cleared depth is
	 * what tells the sea "nothing under this pixel", because the reconstructed
	 * column then comes out at the far plane and the composite falls through.
	 *
	 * NOT BLENDED, by contract with the caller's material. Blending premultiplies
	 * the colour by alpha and the sea multiplies by that same alpha again, so the
	 * animal would come out darkened by the square of its own coverage. RGB is
	 * radiance, ALPHA is coverage.
	 *
	 * @param {THREE.Scene} scene things that are (mostly) under the water.
	 * @param {THREE.Camera} camera the frame's camera, unchanged - the sea looks
	 *   the lookup up in screen space, so the two passes must agree on it.
	 * @param {number} [seaLevel] mean surface height, for the waterline clip.
	 * @param {number} [seam] metres of overlap at the waterline.
	 */
	render( scene, camera, seaLevel = 0, seam = undefined ) {

		if ( ! this.target ) return false;
		const r = this.renderer;
		const prev = r.getRenderTarget();
		r.setRenderTarget( this.target );
		r.setClearColor( 0x000000, 0 );
		// autoClear is off globally (porting rule 15), so the clear is explicit -
		// and it MUST include depth, or the second frame's animal is sorted against
		// the first frame's.
		r.clear( true, true, false );
		// Keep only what is under the water. Anything above it belongs to the
		// beauty pass, where it has the sky behind it and a depth test against the
		// sea to sort it. Reset unconditionally after: nothing downstream wants a
		// live clip, and a clip left on is invisible until it eats something.
		setWaterClip( CLIP.BELOW, seaLevel, seam );
		r.render( scene, camera );
		setWaterClip( CLIP.OFF, seaLevel, seam );
		r.setRenderTarget( prev );
		return true;

	}

	/**
	 * Clear it and draw nothing. For the frames with nothing submerged, so the
	 * target is ALWAYS a freshly cleared buffer rather than whatever was in it
	 * last: the sea samples it every frame the lookup is switched on, and a stale
	 * or never-written half-float target is exactly the NaN that once washed the
	 * whole ocean white. Cheap - a clear of a quarter-resolution buffer.
	 */
	clear() {

		if ( ! this.target ) return;
		const r = this.renderer;
		const prev = r.getRenderTarget();
		r.setRenderTarget( this.target );
		r.setClearColor( 0x000000, 0 );
		r.clear( true, true, false );
		r.setRenderTarget( prev );

	}

	dispose() {

		if ( this.target ) {

			this.target.depthTexture?.dispose();
			this.target.dispose();

		}

		this.target = null;

	}

}
