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

export const TIERS = {
  high: { refractionScale: 0.75, reflectionScale: 0.5, shadows: true, shadowSize: 3072, maxPixelRatio: 2, reflections: true, waterSegments: 320, cloudSteps: 24 },
  med: { refractionScale: 0.55, reflectionScale: 0.38, shadows: true, shadowSize: 2048, maxPixelRatio: 1.5, reflections: true, waterSegments: 224, cloudSteps: 14 },
  low: { refractionScale: 0.42, reflectionScale: 0.30, shadows: false, shadowSize: 512, maxPixelRatio: 1, reflections: false, waterSegments: 144, cloudSteps: 8 },
  // Phones are fill-rate bound, not triangle bound: three full-screen passes at
  // a 3x device pixel ratio is what kills them, not the geometry. So keep the
  // reflection and the shadows — they are most of the look — and spend the
  // budget by capping the backing store to 1x instead.
  mobile: { refractionScale: 0.45, reflectionScale: 0.30, shadows: true, shadowSize: 1024, maxPixelRatio: 1, reflections: true, waterSegments: 160, cloudSteps: 8 },
};

/** Does this browser actually have a WebGPU adapter? Cheap and synchronous. */
export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Build the renderer. Async because the node renderer has to request an adapter
 * and a device before anything can compile — every caller must await this.
 */
export async function createRenderer({ canvas, tier = 'high', pixelRatio, forceWebGL = false } = {}) {
  // The fps badge toggles this and reloads — an artifact URL cannot carry a
  // query string, so the backend A/B has to survive in storage.
  let stored = null;
  try { stored = localStorage.getItem('saltyfin-backend'); } catch { /* sandboxed */ }
  const wantGPU = hasWebGPU() && !forceWebGL && stored !== 'webgl';

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,          // we resolve in post; MSAA on an HDR target is expensive
    alpha: false,
    forceWebGL: !wantGPU,
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
    t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };

  // Beauty pass, with a depth texture so post and the water can read scene depth.
  const scene = makeTarget(2, 2);
  scene.depthTexture = new THREE.DepthTexture(2, 2, THREE.FloatType);
  scene.depthTexture.minFilter = THREE.NearestFilter;
  scene.depthTexture.magFilter = THREE.NearestFilter;

  // What the water sees looking down: seabed, coral, monster.
  const refraction = makeTarget(2, 2);
  refraction.depthTexture = new THREE.DepthTexture(2, 2, THREE.FloatType);
  refraction.depthTexture.minFilter = THREE.NearestFilter;
  refraction.depthTexture.magFilter = THREE.NearestFilter;

  // What the water sees looking up: sky, islands, village, boat.
  const reflection = makeTarget(2, 2);

  const targets = { scene, refraction, reflection };

  function setSize(w, h) {
    const pr = quality.pixelRatio;
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
