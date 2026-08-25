// The waterline split, as a UNIFORM rather than a clipping plane.
//
// The refraction pass (./refraction-driver.js) renders the world the sea looks
// down into, and it wants only what is UNDER the water; the beauty pass draws
// the same objects again over the sea and wants only what is ABOVE it. Sorting
// whole objects into passes cannot do that on its own - a twenty-metre animal
// swimming three metres down with its dorsal fin through the surface is on both
// sides of the waterline at once, which is precisely the case
// docs/sea-dragon-handoff.md calls "fins cannot break the surface".
//
// WHY THIS IS A UNIFORM AND NOT `material.clippingPlanes`
// ------------------------------------------------------
// This is ported wholesale from the reference implementation on
// `claude/saltyfin-webgpu` (saltyfin/src/water/clip.js), including its argument,
// because the argument is the load-bearing part:
//
//   `clippingContextCacheKey` is one of the components of
//   WebGPUBackend.getRenderCacheKey. Turning clipping on for one pass and off
//   for another therefore gives every material two distinct pipeline keys and
//   forces a synchronous `device.createRenderPipeline` per material per pass.
//   Measured there at ~55 pipeline creations a frame and 11 fps on a phone.
//
// The same argument rules out swapping `side`, `depthWrite`, `transparent`,
// blending or stencil per pass - and this repo has already paid that bill once
// from the other direction (demo/three-app.js: a new device, new pipelines and
// new targets for every one of ~90 passes a frame).
//
// So the whole behaviour lives in two uniforms:
//
//     keep = ( positionWorld.y - uClipHeight ) * uClipSign >= 0
//
//     sign =  0   disabled - 0 >= 0 is true, every fragment survives
//     sign = +1   keep worldY >= height   (the beauty pass: above water)
//     sign = -1   keep worldY <= height   (the refraction pass: below water)
//
// The compiled shader is byte-identical in every pass; only the contents of a
// uniform buffer change between them, and nothing getRenderCacheKey reads is
// touched, so each material keeps exactly one pipeline.
//
// TWO WAYS IN, because three only reads `maskNode` on a material that does NOT
// own a `fragmentNode` (NodeMaterial.setup calls setupDiffuseColor, where the
// mask is read, only when fragmentNode === null):
//
//   applyWaterClip( root )   for ordinary materials - including plain
//                            MeshStandardMaterial, which the node renderer
//                            converts with NodeLibrary.fromMaterial, copying
//                            every enumerable property (maskNode included).
//   waterClipDiscard()       called at the top of an Fn, for the hand-written
//                            materials this project is mostly made of.
//
// Abyssal's own sky, clouds and post are all fragmentNode materials and must
// never be clipped, so that exclusion is the behaviour we want anyway.

import { uniform, positionWorld, bool, Discard } from 'three/tsl';

/**
 * The two uniforms the whole clip runs on. Shared by every clipped material, so
 * one write per pass reconfigures the entire scene.
 *
 * Exported for probes; prefer `setWaterClip`.
 */
export const clipUniforms = {
	sign: /*@__PURE__*/ uniform( 0 ),
	height: /*@__PURE__*/ uniform( 0 ),
};

/**
 * The keep-this-fragment test. ONE node instance shared by every material - the
 * node graph is immutable and each NodeBuilder caches it per build, so sharing
 * costs nothing and guarantees every material clips against the same plane.
 *
 * `positionWorld` is derived from `positionLocal` AFTER `positionNode` has
 * written it, so the clip sees the creature's swum spine rather than its rest
 * pose. That is not incidental here: the body wave in ./creature.js moves a
 * fragment by metres.
 */
export const waterClipMask = /*@__PURE__*/ positionWorld.y
	.sub( clipUniforms.height )
	.mul( clipUniforms.sign )
	.greaterThanEqual( 0 );

// A constant-true mask for the shadow pass. `bool(true)` is a ConstNode, so the
// emitted `if ( ! true ) discard;` folds away at compile time.
const shadowMaskAlwaysKeep = /*@__PURE__*/ bool( true );

// THE TWO HALF-SPACES OVERLAP, they do not meet at the waterline.
//
// Not because complementary half-spaces would leave a hole - they would not -
// but because the waterline is not a plane. This sea's surface is the sum of
// four FFT cascades plus a swell train: `swellAmount` alone is a significant
// height, so a flat cut at mean sea level is wrong by whatever the wave is
// doing at that point, which is metres in the presets this ships with.
//
// Err toward OVER-inclusion on both sides. Over-including puts a hand's width
// of already-wet flank into the pass it does not belong to, where the depth
// test and the refraction's own "is this sample in front of the surface?"
// rejection (./water-surface.js) throw most of it away again. UNDER-including
// takes a bite out of the animal at the waterline, in the one place a viewer is
// looking. So the refraction keeps everything below seaLevel + seam and the
// beauty pass keeps everything above seaLevel - seam.
//
// Evaluating the real cascades in the mask would fix it properly and is
// deliberately out of scope: it means the displacement sampler, its four array
// texture reads and its mip chain, in the vertex stage of every clipped
// material in the scene.
export const WATER_CLIP_SEAM = 1.2;

/**
 * Clip modes. `seam` is added to the sea level in the direction that
 * over-includes; see the comment above.
 */
export const CLIP = {
	/** No clipping - the state every pass that is neither of the two wants. */
	OFF: { sign: 0, seam: 0 },
	/** Keep what is above the waterline - the beauty pass. */
	ABOVE: { sign: 1, seam: - 1 },
	/** Keep what is below the waterline - the refraction pass. */
	BELOW: { sign: - 1, seam: 1 },
};

/**
 * Point the clip at a plane, or turn it off. Two uniform writes; on WebGPU that
 * is a `device.queue.writeBuffer` on one uniform group and nothing else. It
 * touches no material property, so no pipeline key moves.
 *
 * Call it immediately before `renderer.render(...)` and reset to `CLIP.OFF`
 * immediately after, so nothing downstream inherits a live clip.
 *
 * @param {{sign:number, seam:number}} mode one of `CLIP.OFF|ABOVE|BELOW`
 * @param {number} [seaLevel] the mean surface, world Y (params.seaLevel).
 * @param {number} [seam] metres of overlap; default WATER_CLIP_SEAM. A caller
 *   that knows its sea state should scale this with it - the demo uses the
 *   swell's significant height.
 */
export function setWaterClip( mode, seaLevel = 0, seam = WATER_CLIP_SEAM ) {

	clipUniforms.sign.value = mode.sign;
	clipUniforms.height.value = seaLevel + mode.seam * seam;

}

// Materials already wired, so a caller can apply this to overlapping subtrees
// (or twice) without paying for a rebuild it does not need.
const wired = new WeakSet();

/**
 * Wire the waterline clip into every material under `root`.
 *
 * AT BUILD TIME. Attaching a node bumps `material.version`, and doing that to a
 * material the renderer has already compiled forces a synchronous rebuild -
 * measured on the reference implementation at 27 blocking `_getRenderPipeline`
 * calls in one burst when it was called after the first render. Call it next to
 * whatever adds the object to the scene, before the first frame.
 *
 * Materials that own a `fragmentNode` are skipped, because three never reads
 * `maskNode` on those; they opt in with `waterClipDiscard()` instead.
 *
 * `maskShadowNode` is pinned constant-true so the shadow map is not cast by
 * waterline-clipped geometry: three renders the frame's shadow map lazily,
 * inside whichever `renderer.render()` comes first, and left alone it falls
 * back to `maskNode` for the shadow depth material.
 *
 * @param {THREE.Object3D} root subtree to wire
 * @returns {number} how many distinct materials this call wired
 */
export function applyWaterClip( root ) {

	let n = 0;
	root.traverse( ( o ) => {

		if ( ! o.isMesh && ! o.isInstancedMesh && ! o.isPoints && ! o.isSprite ) return;
		const mats = Array.isArray( o.material ) ? o.material : [ o.material ];
		for ( const m of mats ) {

			if ( ! m || wired.has( m ) ) continue;
			wired.add( m );
			if ( m.fragmentNode ) continue;
			m.maskNode = waterClipMask;
			m.maskShadowNode = shadowMaskAlwaysKeep;
			m.needsUpdate = true;
			n ++;

		}

	} );
	return n;

}

/**
 * The same clip for a material that owns its `fragmentNode`. Call it as the
 * first statement of the Fn:
 *
 *     mat.fragmentNode = Fn( () => {
 *       waterClipDiscard();
 *       ...
 *     } )();
 *
 * Discarding first is not only tidy - it is what keeps the clipped-away half of
 * the animal from paying for the sky LUT reads below it.
 */
export function waterClipDiscard() {

	Discard( waterClipMask.not() );

}
