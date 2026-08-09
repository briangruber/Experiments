// The waterline clip — what `renderer.clippingPlanes` did on the WebGL build.
//
// The reflection pass renders through a camera mirrored in y=0, and the
// refraction pass renders the world the water looks down into. Neither wants
// the whole scene: the reflection wants only what is *above* the waterline, the
// refraction only what is *below* it. LAYER.REFLECTED / LAYER.UNDERWATER sort
// whole objects into the right pass, but they cannot trim one — a dock piling
// runs from the deck to the seabed, an island runs from its summit to the
// seabed, and a 34 m leviathan swimming fifteen metres down is entirely on the
// wrong side of y=0 yet still has to reflect the moment it breaches (ref/05).
//
// Without this, a submerged object's mirror image lands just *above* the
// reflected horizon, which is exactly the band of water pixels where Fresnel
// (F0 = 0.02, waterMaterial.js:541) has driven the reflection term to ~1. So it
// is not a subtle wash — the reflection texture replaces the water colour
// outright, and you get a dark smear on open water nowhere near the object that
// caused it.
//
// Why this is a uniform and not a clipping plane
// ----------------------------------------------
// The node renderer has no `renderer.clippingPlanes`, and `material.clippingPlanes`
// is not a substitute: `clippingContextCacheKey` is one of the 29 components of
// WebGPUBackend.getRenderCacheKey, so turning clipping on for the reflection
// pass and off for the beauty pass gives every material two distinct pipeline
// keys and forces a synchronous `device.createRenderPipeline` per material per
// pass. That is exactly the stall that cost the phone build ~55 pipeline
// creations a frame and dropped it to 11 fps. The same argument rules out
// swapping `side`, `depthWrite`, `transparent`, blending or stencil per pass.
//
// So the clip is a single node hung off `NodeMaterial.maskNode`, and its entire
// behaviour lives in two uniforms:
//
//     keep = (positionWorld.y - uClipHeight) * uClipSign >= 0
//
//     uClipSign =  0   disabled — 0 >= 0 is true, every fragment survives
//     uClipSign = +1   keep worldY >= uClipHeight   (reflection: above water)
//     uClipSign = -1   keep worldY <= uClipHeight   (refraction: below water)
//
// The compiled shader is byte-identical in all four passes; only the contents of
// a uniform buffer change between them. Nothing getRenderCacheKey reads is
// touched, so each material keeps exactly one pipeline.
//
// `maskNode` is the right slot because it is the one node hook the project does
// not already use, and because three applies it as the very first statement of
// main(), ahead of all shading:
//
//     if ( ! ( ( ( v_positionWorld.y - nodeUniform3 ) * nodeUniform4 ) >= 0.0 ) ) { discard; }
//
// Two things it composes with for free:
//   * `positionWorld` is derived from `positionLocal` *after* `positionNode` and
//     after instancing have written it, so the clip sees the leviathan's swum
//     spine and an InstancedMesh's per-instance transform, not the rest pose.
//   * A plain `MeshStandardMaterial` / `MeshBasicMaterial` works too. The node
//     renderer converts those with `NodeLibrary.fromMaterial`, which copies every
//     enumerable property onto the generated node material — `maskNode` included.
//     Most of this project's materials are plain, so that matters.
//
// The one material kind this cannot reach is one that owns `fragmentNode`:
// `NodeMaterial.setup` only calls `setupDiffuseColor` (where maskNode is read)
// when `fragmentNode === null`. Those materials are skipped, and can opt in by
// calling `waterClipDiscard()` inside their own Fn. In practice that exclusion
// is the behaviour we want anyway — sky, clouds and celestial are all
// fragmentNode materials and must never be clipped out of the reflection: the
// sky dome's lower hemisphere alone is ~9% of the reflection target and it is
// the reflection's background, not a leak.

import { uniform, positionWorld, bool, Discard } from 'three/tsl';

/**
 * The two uniforms the whole clip runs on. Shared by every clipped material, so
 * one write per pass reconfigures the entire scene.
 *
 * Exported for the probe harness; prefer `setWaterClip`.
 */
export const clipUniforms = {
  sign: uniform(0),
  height: uniform(0),
};

/**
 * The keep-this-fragment test. One node instance shared by every material — the
 * node graph is immutable and each NodeBuilder caches it per build, so sharing
 * costs nothing and guarantees every material clips against the same plane.
 */
export const waterClipMask = positionWorld.y
  .sub(clipUniforms.height)
  .mul(clipUniforms.sign)
  .greaterThanEqual(0);

// A constant-true mask for the shadow pass — see applyWaterClip. `bool(true)`
// is a ConstNode, so `!true` folds at compile time and the injected discard
// costs nothing.
const shadowMaskAlwaysKeep = bool(true);

// The two half-spaces overlap by SEAM metres instead of both cutting at exactly
// y=0. Two reasons, neither of which is "otherwise a pixel is drawn by neither
// pass" — complementary half-spaces at y=0 have no hole in their union:
//
//   1. The water is not at y=0. src/water/waves.js sums six sines whose
//      amplitudes total 0.459 m (measured range -0.456..+0.448, RMS 0.169), so
//      a flat cut is wrong by the wave height at that point. Near shore the
//      `shore` damping in waterMaterial.js:353 pulls the amplitude down to
//      0.046 m, which is why a *small* seam is the right call: it covers the
//      shoreline outright, where a shallow beach slope would turn a vertical
//      error into metres of horizontal band.
//   2. The water shader bends the reflection lookup (`rv = suv + bend * rd`,
//      waterMaterial.js:536-537, ~14 px of wander) and reads a low-res target
//      (240x135 at quality=high). A hard cut gets sampled from the wrong side.
//
// So err toward over-inclusion: over-including shows a hand's width of wetted
// hull or piling, dark against the dark object it belongs to, while
// under-including shows the target's clear colour (env.skyHorizon, bright) as a
// halo detaching an object from its own reflection. 0.12 m also matches the
// bias the WebGL build used — see the comment at boat.js:727.
//
// It does NOT fully fix a floating object in deep water: the boat and the buoys
// ride the wave (props.js:1034, boat.js:805-809), so in a 0.33 m trough the flat
// cut still trims dry topsides off the boat's reflection. Fixing that properly
// means evaluating the wave field in the mask (six sin/cos per fragment on ~55
// materials, plus the depth-map binding for the shore term) and is deliberately
// out of scope here.
const SEAM = 0.12;

/** Clip modes. Pass one of these to `setWaterClip`. */
export const CLIP = {
  /** No clipping. The state every pass that is not reflection/refraction wants. */
  OFF: { sign: 0, height: 0 },
  /** Keep what is above the waterline — the reflection pass. */
  ABOVE: { sign: 1, height: -SEAM },
  /** Keep what is below the waterline — the refraction pass. */
  BELOW: { sign: -1, height: SEAM },
};

/**
 * Point the clip at a plane, or turn it off. Two uniform writes; on WebGPU that
 * is a `device.queue.writeBuffer` on the object uniform group and nothing else.
 * It touches no material property, so no pipeline key moves.
 *
 * Call immediately before `renderer.render(...)` and reset to `CLIP.OFF`
 * immediately after, so nothing downstream inherits a live clip.
 *
 * @param {{sign:number, height:number}} mode one of `CLIP.OFF|ABOVE|BELOW`
 */
export function setWaterClip(mode) {
  clipUniforms.sign.value = mode.sign;
  clipUniforms.height.value = mode.height;
}

// Materials already wired, so a module can call applyWaterClip on overlapping
// subtrees (or twice) without paying for a rebuild it does not need.
const wired = new WeakSet();

/**
 * Wire the waterline clip into every material under `root`.
 *
 * Call it next to the module's `setLayers(...)` line, at BUILD TIME. Attaching
 * a node bumps `material.version`, and doing that to a material the renderer has
 * already compiled forces a synchronous rebuild — measured at 27 blocking
 * `_getRenderPipeline` calls in one burst when called after first render. Every
 * call site in this project runs inside a `create*()` before the first frame, so
 * today it costs nothing; keep it that way.
 *
 * Materials that own a `fragmentNode` are skipped — three ignores `maskNode` on
 * those. If one of them genuinely needs clipping, call `waterClipDiscard()`
 * inside its Fn instead.
 *
 * Note `maskShadowNode`. Three renders the frame's only shadow map lazily,
 * inside the first `renderer.render()` of the frame — which is the *reflection*
 * pass (main.js:530 runs it first), i.e. with CLIP.ABOVE live. Left alone, three
 * falls back to `maskNode` for the shadow depth material
 * (`const t = e.maskShadowNode || e.maskNode`, vendor offset ~442209) and every
 * on-screen shadow would be cast by waterline-clipped geometry. Pinning a
 * constant-true node there opts the shadow pass out, and because it is a
 * ConstNode the emitted `if (!true) discard;` folds away.
 *
 * @param {THREE.Object3D} root subtree to wire
 * @returns {number} how many distinct materials were wired by this call
 */
export function applyWaterClip(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isSprite) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || wired.has(m)) continue;
      wired.add(m);
      // A fragmentNode material replaces the whole fragment stage; maskNode is
      // never read. Leave it alone rather than pretend it is clipped.
      if (m.fragmentNode) continue;
      m.maskNode = waterClipMask;
      m.maskShadowNode = shadowMaskAlwaysKeep;
      m.needsUpdate = true;
      n++;
    }
  });
  return n;
}

/**
 * The same clip for a material that owns its `fragmentNode`. Call inside the Fn,
 * as early as possible:
 *
 *     mat.fragmentNode = Fn(() => {
 *       waterClipDiscard();
 *       ...
 *     })();
 *
 * Nothing in the project needs this yet — sky, clouds, celestial and the water
 * itself all want to stay unclipped — but a hand-written surface that straddles
 * y=0 would.
 */
export function waterClipDiscard() {
  Discard(waterClipMask.not());
}
