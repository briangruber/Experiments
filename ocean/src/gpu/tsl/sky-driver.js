// The TSL sky, driven. This is the node-graph counterpart of src/sky.js: it owns
// the LUT render target, bakes it, and draws the background — the same two calls
// (updateLUT, drawBackground) with the same arguments, so a caller can hold
// either one behind the same interface.
//
// Runs on WebGPU and on WebGL2 from this one source. Three compiles the graphs
// in ./atmosphere.js, ./sky-lut.js, ./cloud-field.js, ./cloud-march.js and
// ./sky-background.js to WGSL or to GLSL depending on the backend the renderer
// initialised with.
//
// ---------------------------------------------------------------------------
// WHY THE BAKE USES screenUV, WHICH IS THE ONE DECISION HERE WORTH READING
//
// The LUT has to round-trip: whatever direction the bake writes at a texture
// coordinate, the fetch at that same coordinate has to read back. Two separate
// flips are in play and they are NOT the same flip.
//
//   1. Framebuffer orientation. On WebGL, row 0 of a render target is the
//      BOTTOM (texcoord v = 0). On WebGPU it is the TOP.
//
//   2. The sampler. TextureNode.setupUV (three r185, three.webgpu.js:12676)
//      flips v when `builder.isFlipY()` AND the texture is a render target —
//      and isFlipY() is true for GLSLNodeBuilder, false for WGSLNodeBuilder.
//      So on WebGL, sampling this LUT at v actually reads texcoord 1 - v; on
//      WebGPU it reads v.
//
// screenUV is top-down on BOTH backends (ScreenNode.generate applies its own
// flip precisely to make that true — see the note in ./sky-background.js).
// Trace it through:
//
//   WebGPU  bake writes radiance(s) at texcoord s        (top-down = texcoord)
//           fetch at v reads texcoord v                  -> radiance(v)   OK
//
//   WebGL   bake writes radiance(s) at texcoord 1 - s    (top-down = 1 - texcoord)
//           fetch at v reads texcoord 1 - v              -> radiance(v)   OK
//
// The two flips cancel on WebGL and neither fires on WebGPU. One code path is
// correct on both, which is the entire point of the port.
//
// PlaneGeometry(2,2)'s uv() is the opposite convention (v = 0 at the bottom) and
// would be wrong on BOTH backends — silently, as a sky mirrored about the
// horizon. Measured in prototypes/screenuv-probe.html.

import * as THREE from 'three/webgpu';
import { vec4, screenUV, positionGeometry } from 'three/tsl';

import { setAtmosphereUniforms } from './atmosphere.js';
import { skyLutFragment, setSkyLutUniforms, LUT_W, LUT_H, moonDirOf } from './sky-lut.js';
import { setCloudUniforms } from './cloud-field.js';
import { setCloudMarchUniforms } from './cloud-march.js';
import { skyBackground, setSkyBackgroundUniforms, setSkyLut } from './sky-background.js';

export class TslSky {

	/**
	 * @param {THREE.WebGPURenderer} renderer - already init()ed.
	 * @param {object} [opts]
	 * @param {boolean} [opts.mips=true] - generate LUT mips. The background pass
	 *   fetches level 0 only, but the water pass reads the top mips for diffuse
	 *   irradiance, so the default matches src/sky.js.
	 */
	constructor( renderer, { mips = true } = {} ) {

		this.renderer = renderer;

		// RGBA16F, as src/sky.js. The table holds radiance, which is unbounded
		// above, so it cannot be an 8-bit format; half float is enough because the
		// values are smooth and the disc — the one thing that overflows — is added
		// by the background pass, not stored here.
		this.lut = new THREE.RenderTarget( LUT_W, LUT_H, {
			type: THREE.HalfFloatType,
			format: THREE.RGBAFormat,
			// REPEAT in u so bilinear filtering blends across the azimuth seam at
			// u = 0/1 instead of clamping it to a smeared column; CLAMP in v because
			// there is nothing above the zenith or below the nadir to wrap to.
			wrapS: THREE.RepeatWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			generateMipmaps: mips,
			depthBuffer: false,
		} );
		this.lut.texture.name = 'abyssal.skyLUT';

		setSkyLut( this.lut.texture );

		// Two fullscreen passes. QuadMesh is three's own fullscreen primitive and
		// carries the uv convention the bake note above depends on.
		this.lutMaterial = new THREE.NodeMaterial();
		this.lutMaterial.name = 'abyssal.skyLUT';
		this.lutMaterial.fragmentNode = skyLutFragment( screenUV );
		this.lutMaterial.depthTest = false;
		this.lutMaterial.depthWrite = false;
		this.lutQuad = new THREE.QuadMesh( this.lutMaterial );

		this.bgMaterial = new THREE.NodeMaterial();
		this.bgMaterial.name = 'abyssal.skyBackground';
		this.bgMaterial.fragmentNode = vec4( skyBackground(), 1.0 );
		// The background is drawn after the ocean, depth-tested against it and
		// writing nothing — so the cloud raymarch, which is by far the most
		// expensive thing per pixel, only runs on sky the sea did not already cover.
		this.bgMaterial.depthTest = true;
		this.bgMaterial.depthWrite = false;
		this.bgMaterial.transparent = false;
		this.bgQuad = new THREE.QuadMesh( this.bgMaterial );
		this.depthMode = 'behind';

		// PIN THE QUAD TO THE FAR PLANE, exactly as FS_VERT_FAR does.
		//
		// The GLSL pass writes `gl_Position = vec4(a_pos, 1.0, 1.0)`, so z/w = 1 -
		// the far plane - and with LEQUAL and no depth write it shades only pixels
		// the ocean did not already cover. That is not a detail: the cloud raymarch
		// is the most expensive thing in the frame and this is what keeps it off the
		// half of the screen that is sea.
		//
		// QuadMesh's own OrthographicCamera(-1, 1, 1, -1, 0, 1) puts the geometry at
		// the NEAR plane, so the sky paints straight over the water; nudging the mesh
		// toward the far plane instead just trades one wrong depth for another (both
		// were measured, both were wrong). QuadGeometry's positions are already the
		// NDC fullscreen triangle [-1,3, -1,-1, 3,-1] at z = 0 - the same triangle
		// the project's own Blitter uses - so writing clip space directly reproduces
		// FS_VERT_FAR verbatim and bypasses that camera entirely.
		//
		// z = 0.999999, NOT 1.0 — just inside the far plane rather than exactly on it.
		//
		// FS_VERT_FAR writes z = w, and that worked on every implementation this was
		// developed against. It does not work on Safari's WebGPU: the sea drew and
		// the sky did not, and the app's own band readout came back 0.052 / 0.000 -
		// one band with content, the other EXACTLY zero, which is a pass that never
		// rasterised rather than one that shaded black. WebGPU clips a primitive when
		// z > w and z == w is meant to be inside, but that boundary is exactly where
		// implementations are free to differ, and one of them does.
		//
		// The margin has to sit in a narrow window, so it is worked out rather than
		// guessed. With this project's near = 0.08 and far = 90000, the most distant
		// water (~42 km) lands at a GL depth of about 1 - 1.9e-6. This quad lands at
		// 1 - 5e-7. So:
		//
		//   vs the cleared depth of 1.0   0.9999995 <= 1.0        passes, sky draws
		//   vs the farthest sea           0.9999995 >  0.9999981  fails, sea occludes
		//
		// which is ~16 ULPs below 1.0 and ~23 ULPs above the far sea in a 24-bit
		// buffer - comfortable at both ends. A larger offset would put the sky in
		// FRONT of the distant water and paint over the horizon; a much smaller one
		// would round back to 1.0 and be the bug again.
		this.bgMaterial.vertexNode = vec4( positionGeometry.x, positionGeometry.y, 0.999999, 1.0 );

	}

	/**
	 * How the background pass relates to the sea.
	 *
	 *   'behind'  (default) depth-tested just inside the far plane and drawn AFTER
	 *             the sea, so the cloud raymarch - the most expensive thing in the
	 *             frame - never runs on a pixel the sea already covered.
	 *
	 *   'first'   depth test off, drawn BEFORE the sea. Unconditionally correct on
	 *             every implementation, and pays for the whole sky on every pixel.
	 *
	 * 'behind' relies on a clip-space z that sits inside the far plane, and one
	 * WebGPU implementation was found that rasterises nothing there at all. The app
	 * watches its own output and switches to 'first' if the sky goes missing, so a
	 * platform that cannot do the fast path still gets a sky.
	 */
	setDepthMode( mode ) {

		this.depthMode = mode;
		this.bgMaterial.depthTest = mode !== 'first';
		this.bgMaterial.needsUpdate = true;

	}

	/**
	 * Re-bake the LUT. Mirrors Sky.updateLUT(p, sunDir, eyeHeight).
	 *
	 * @param {object} p - the params object.
	 * @param {ArrayLike<number>} sunDir - unit vector, renderer frame.
	 * @param {number} eyeHeight - metres above sea level.
	 * @param {ArrayLike<number>} [moonDir] - defaults to moonDirOf(p).
	 */
	updateLUT( p, sunDir, eyeHeight, moonDir = moonDirOf( p ) ) {

		setAtmosphereUniforms( p );
		setSkyLutUniforms( p, sunDir, eyeHeight, moonDir );

		const prev = this.renderer.getRenderTarget();
		this.renderer.setRenderTarget( this.lut );
		this.lutQuad.render( this.renderer );
		this.renderer.setRenderTarget( prev );

	}

	/**
	 * Draw the background into whatever target is currently bound. Mirrors
	 * Sky.drawBackground(p, ctx).
	 *
	 * @param {object} p - the params object.
	 * @param {object} ctx - { camPos, invViewProj, sunDir, moonDir, windVec3, time }.
	 */
	drawBackground( p, ctx ) {

		// Every block that owns uniforms gets its setter called, in the same order
		// src/sky.js assembles them. The atmosphere block is shared with the LUT
		// bake and re-set here because the background is drawn with parameters that
		// may have changed since the last bake.
		setAtmosphereUniforms( p );
		setCloudUniforms( p, ctx );
		setCloudMarchUniforms( p );
		setSkyBackgroundUniforms( p, ctx );

		// The sun and moon directions the background uses are the LUT block's, so
		// that a caller who moves the sun without re-baking still gets a consistent
		// disc position. Same vectors, one home.
		setSkyLutUniforms( p, ctx.sunDir, Math.max( ctx.camPos[ 1 ], 1 ),
			ctx.moonDir ?? moonDirOf( p ) );

		this.bgQuad.render( this.renderer );

	}

	dispose() {

		this.lut.dispose();
		this.lutMaterial.dispose();
		this.bgMaterial.dispose();

	}

}
