// Everything that is UNDER the sea, rendered into its own target so the sea can
// look through itself at it.
//
// WHY THIS EXISTS AT ALL. The ocean is opaque and writes depth, so a submerged
// mesh drawn before it is hidden and one drawn after it is pasted on top. The
// second was tried first, and the report on it was exact: "it feels like the
// monster is just a transparent ghost on the water, it doesn't feel like it is
// IN the water". It was not in the water - it was over it, over the foam, over
// the hull's own wake, at a flat alpha, with none of the things that happen to
// a submerged shape happening to it.
//
// A target fixes all of that at once, because it puts the submerged colour back
// where it physically belongs: into the water's DIFFUSE term, the radiance
// leaving the sea upward. See "what is UNDER the water at this pixel" in
// ./water-surface.js. From there the sea's own maths does the rest - Fresnel
// hides it at grazing angles, foam covers it, glitter sits on it, haze eats it -
// and the lookup is displaced by the surface slope, so chop passing overhead
// wobbles and breaks the shape up the way water does.
//
// It also buys back a REAL DEPTH BUFFER for the submerged pass. Drawn straight
// over the sea there was nothing to sort against, so the creature had to be
// front-faces-only and its fins ghosted through its own body. In here it is an
// ordinary opaque draw.
//
// The target is HALF the HDR target's size on purpose. What it holds is already
// going to be blurred by refraction and buried under a Fresnel term; the sea
// never shows it sharply, and paying full resolution for that is paying for
// something nobody can see. Measured at half, its share of a frame is small
// enough to sit inside the existing governor's headroom.

import * as THREE from 'three/webgpu';

export class TslUnderwater {

	constructor( renderer, { scale = 0.5 } = {} ) {

		this.renderer = renderer;
		this.scale = scale;
		this.target = null;
		this.width = 0;
		this.height = 0;

	}

	/**
	 * Size to the HDR target this will be composited into. Kept as its own call
	 * rather than done lazily in render() because ./water-surface.js binds the
	 * texture ONCE at graph build time (porting rule 11) and a target rebuilt
	 * mid-frame would leave the sea sampling a disposed one.
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
		this.target.texture.name = 'abyssal.underwater';
		// CLAMPED, because the refraction offset walks the lookup off the edge of
		// the screen at the frame's border and a wrapped sample would fetch the
		// creature back in on the opposite side.
		this.target.texture.wrapS = THREE.ClampToEdgeWrapping;
		this.target.texture.wrapT = THREE.ClampToEdgeWrapping;
		this.width = tw; this.height = th;
		return this.target;

	}

	/**
	 * Draw a scene of submerged things. Cleared to TRANSPARENT BLACK, which is
	 * what makes the sea's `mix( water, underwater, alpha )` a no-op everywhere
	 * nothing was drawn - the alpha channel IS the coverage mask, so no second
	 * pass and no stencil is needed to say where the creature is.
	 */
	render( scene, camera ) {

		if ( ! this.target ) return;
		const r = this.renderer;
		const prev = r.getRenderTarget();
		r.setRenderTarget( this.target );
		r.setClearColor( 0x000000, 0 );
		// autoClear is off globally (porting rule 15), so the clear is explicit -
		// and it must include DEPTH, or the second frame's creature is sorted
		// against the first frame's.
		r.clear( true, true, false );
		r.render( scene, camera );
		r.setRenderTarget( prev );

	}

	dispose() {

		if ( this.target ) this.target.dispose();
		this.target = null;

	}

}
