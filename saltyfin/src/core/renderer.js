// The renderer, the render targets, and the quality tiers.
//
// This branch runs three's node renderer. One code path, two backends: WebGPU
// where the browser has it, and the same renderer's WebGL backend where it does
// not. That is not a compatibility shim bolted on the side — it is the same
// node materials compiled to a different language, so the fallback looks
// identical rather than merely similar.
//
// The beauty pass renders into a half-float target so the sun path, the lantern
// and the village windows can go well above 1.0 and still bloom properly;
// core/post.js is what finally tonemaps to the canvas.

import * as THREE from 'three';

// `geometry` is a 0–1 budget every module that generates its own geometry
// scales against — seabed grid density, coral and vegetation instance counts,
// fish and bubbles. It exists because those five modules each used to branch on
// the tier NAME, with a `low ? … : med ? … : high` ladder. When the mobile tier
// was added it matched none of them and fell through to the high branch, so a
// phone was quietly building a 333k-triangle seabed, the full 211k of coral and
// the full 168k of vegetation — 2.18 M triangles a frame across the passes, at
// desktop density, on the one device that could least afford it. A number the
// tier owns cannot fall through; a name ladder in five files always can.
export const TIERS = {
  high: { refractionScale: 0.75, reflectionScale: 0.5, shadows: true, shadowSize: 3072, maxPixelRatio: 2, reflections: true, waterSegments: 320, cloudSteps: 24, geometry: 1.0 },
  med: { refractionScale: 0.55, reflectionScale: 0.38, shadows: true, shadowSize: 2048, maxPixelRatio: 1.5, reflections: true, waterSegments: 224, cloudSteps: 14, geometry: 0.68 },
  low: { refractionScale: 0.42, reflectionScale: 0.30, shadows: false, shadowSize: 512, maxPixelRatio: 1, reflections: false, waterSegments: 144, cloudSteps: 8, geometry: 0.42 },
  // Phones pay for fill rate AND for triangles, and the triangles are the half
  // that a smaller backing store cannot buy back — which is exactly why cutting
  // the render scale to 3/4 on the phone barely moved the frame rate. Keep the
  // reflection and the shadows, since they are most of the look, and spend the
  // budget on 1x pixels and half the geometry instead.
  mobile: { refractionScale: 0.45, reflectionScale: 0.30, shadows: true, shadowSize: 1024, maxPixelRatio: 1, reflections: true, waterSegments: 160, cloudSteps: 8, geometry: 0.5 },
};

/** Does this browser actually have a WebGPU adapter? Cheap and synchronous. */
export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Build the renderer. Async because the node renderer has to request an adapter
 * and a device before anything can compile — every caller must await this.
 */
export async function createRenderer({
  canvas, tier = 'high', pixelRatio, forceWebGL = false, trackTimestamp = false,
} = {}) {
  // WebGPU is opt-in, not the default: measured on an iPhone it runs at 7 fps
  // where the WebGL backend is playable. What that 7 fps is made of is still
  // open — the badge's `cpu` figure only ever wrapped the encode, and on this
  // renderer render() returns as soon as the commands are written, so a low
  // number there proved the encode was cheap and nothing more. core/profile.js
  // exists to answer it properly on the device, since there is no WebGPU in
  // the headless browser this is developed against. Until it has, the WebGL
  // backend ships and the badge (or ?webgpu=1) opts a session into WebGPU. The
  // choice survives in storage because an artifact URL cannot carry a query.
  let stored = null;
  try { stored = localStorage.getItem('saltyfin-backend'); } catch { /* sandboxed */ }
  let urlOptIn = false;
  try { urlOptIn = new URLSearchParams(location.search).get('webgpu') === '1'; } catch { /* no window */ }
  const wantGPU = hasWebGPU() && !forceWebGL && (stored === 'webgpu' || (urlOptIn && stored !== 'webgl'));

  // three's WebGPU backend builds its timestamp query set the moment
  // trackTimestamp is set, with no check that the adapter actually has
  // timestamp-query — and an invalid query set poisons every render pass that
  // references it. So ask the adapter first. Requesting one here is cheap and
  // the backend requests its own regardless.
  let timestamps = false;
  if (trackTimestamp && wantGPU) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' });
      timestamps = !!adapter?.features?.has('timestamp-query');
    } catch { timestamps = false; }
  }

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,          // we resolve in post; MSAA on an HDR target is expensive
    alpha: false,
    forceWebGL: !wantGPU,
    // Real GPU timing, off by default: it writes a timestamp either side of
    // every pass, which is cheap but not free, and it only exists at all if the
    // adapter exposes timestamp-query. three asks for every feature the adapter
    // has, so this flag is the whole opt-in.
    trackTimestamp: timestamps,
  });

  await renderer.init();

  renderer.setClearColor(0x000000, 1);
  // Linear, NOT sRGB. core/post.js encodes to sRGB itself, at the end of the
  // composite, and the WebGL build got away with declaring the output sRGB
  // because a RawShaderMaterial bypasses three's output-encoding injection. A
  // NodeMaterial does not, so leaving this as sRGB encodes the frame twice and
  // the whole scene comes back two to three stops bright and washed toward grey.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;   // post does it
  renderer.shadowMap.enabled = TIERS[tier].shadows;
  // Soft shadows on desktop — the node path filters in the graph, so the
  // comparison-sampler smearing that forced BasicShadowMap on the WebGL build
  // does not apply. On the phone tiers, match the WebGL build's single hard
  // tap: nine filtered taps across every lit pixel is real money on mobile,
  // and a fair A/B against the other artifact needs the same shadow cost.
  renderer.shadowMap.type = (tier === 'mobile' || tier === 'low')
    ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
  renderer.autoClear = false;

  const quality = { tier, ...TIERS[tier] };
  quality.pixelRatio = Math.min(pixelRatio ?? window.devicePixelRatio ?? 1, quality.maxPixelRatio);
  quality.backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl';
  quality.timestamps = timestamps;
  // If the phone is GPU-bound on the WGSL water shader, fewer pixels is the
  // one lever that helps immediately: render the whole frame at 3/4 scale and
  // let the browser stretch the canvas to CSS size. The HUD is DOM, so it
  // stays crisp. Harmless if the real cost turns out to be CPU encode time —
  // the badge's cpu readout is what tells those two apart.
  quality.renderScale = (quality.backend === 'webgpu' && (tier === 'mobile' || tier === 'low')) ? 0.75 : 1;

  const size = new THREE.Vector2(1, 1);

  const makeTarget = (w, h, opts = {}) => {
    const t = new THREE.RenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: opts.depth !== false,
      colorSpace: THREE.NoColorSpace,
      ...opts,
    });
    // Every depth-buffered target built here shares ONE of three's
    // RenderContexts, because three hashes a context on the COLOUR signature
    // alone — `textures.length:format:type:samples:depthBuffer:stencilBuffer`.
    // The depth attachment is not in that key, but WebGPU's pipeline cache key
    // *is* built partly from the context's depth-stencil format. So a target
    // that leaves three to invent its own depth buffer (depth24plus) standing
    // next to targets carrying an explicit FloatType one (depth32float) makes
    // the shared context's format flip from pass to pass, and since the
    // render-object chain key is [object, material, context, lightsNode] — no
    // camera, no target — the same render object re-keys twice a frame and
    // every one of its pipelines is compiled again. That cost is invisible on
    // the WebGL backend, whose getRenderCacheKey() returns "" and whose
    // needsRenderUpdate() returns false, which is exactly why this read as a
    // WebGPU problem. Attaching depth here, once, keeps the three in step.
    if (t.depthBuffer) {
      t.depthTexture = new THREE.DepthTexture(t.width, t.height, THREE.FloatType);
      t.depthTexture.minFilter = THREE.NearestFilter;
      t.depthTexture.magFilter = THREE.NearestFilter;
    }
    t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };

  // Beauty pass. Its depth texture is what post and the water read scene depth
  // from; makeTarget attached it.
  const scene = makeTarget(2, 2);

  // What the water sees looking down: seabed, coral, monster.
  const refraction = makeTarget(2, 2);

  // What the water sees looking up: sky, islands, village, boat. Nothing samples
  // this one's depth — it just has to match its siblings' format.
  const reflection = makeTarget(2, 2);

  const targets = { scene, refraction, reflection };

  function setSize(w, h) {
    const pr = quality.pixelRatio * quality.renderScale;
    size.set(w, h);
    const bw = Math.max(2, Math.round(w * pr));
    const bh = Math.max(2, Math.round(h * pr));
    renderer.setPixelRatio(1);           // we manage resolution ourselves
    renderer.setSize(bw, bh, false);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    scene.setSize(bw, bh);
    refraction.setSize(Math.round(bw * quality.refractionScale), Math.round(bh * quality.refractionScale));
    reflection.setSize(Math.round(bw * quality.reflectionScale), Math.round(bh * quality.reflectionScale));
    return { width: bw, height: bh, cssWidth: w, cssHeight: h };
  }

  function dispose() {
    scene.dispose(); refraction.dispose(); reflection.dispose();
    renderer.dispose();
  }

  return { renderer, quality, targets, setSize, size, dispose, makeTarget };
}
