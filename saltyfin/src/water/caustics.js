// The caustic net.
//
// A small tiling texture rendered once every couple of frames. Three layers of
// a *tiling* worley — the cell coordinates wrap at an integer period and the
// feature points orbit in place instead of the domain scrolling, so the pattern
// writhes the way real caustics do while staying perfectly seamless. The bright
// filament is the cell boundary (d2 - d1 near zero), sharpened with a power
// curve; the per-channel ridge widths give the warm/cool fringe that sunlight
// through a wavelet actually has.
//
// The water shader projects this onto the refracted seabed in world XZ.
//
// Ported from GLSL to TSL. The field itself — `causticField` below — is one
// node graph shared by both of the ways it can be evaluated:
//
//   fragment  a QuadMesh into a RenderTarget. The reference implementation,
//             and what every WebGL-backed run uses.
//   compute   the same graph run once per texel, storing straight into a
//             StorageTexture. This is pure per-texel work with no rasterising
//             in it, so on a WebGPU backend there is no reason to pretend it
//             is a triangle.
//
// Both write the same numbers; the compute path is selected at build time and
// nothing outside this file can tell which one ran.

import * as THREE from 'three';
import {
  Fn, uniform, uv, vec2, vec3, vec4, float, uint, uvec2,
  min, max, clamp, pow, dot, smoothstep, fract, floor, sin, mod,
  length, instanceIndex, textureStore,
} from 'three/tsl';

const TAU = 6.283185307179586;

/** hash22 from core/glsl.js, node for node. */
const hash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

// Feature point of a cell, orbiting rather than translating: the tiling stays
// exact for any t.
const cellPoint = (cell, t) => {
  const h = hash22(cell).toVar();
  return vec2(0.5).add(sin(h.mul(TAU).add(t.mul(h.x.mul(0.95).add(0.72)))).mul(0.44));
};

// Worley whose lattice wraps at "period", so uv*period tiles over [0,1].
// The 3x3 neighbourhood is unrolled in JS — we are generating the graph, so a
// fixed count costs nothing to write out and saves the loop.
const worleyTile = (p, period, t, seed) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const per = vec2(period);
  const d1 = float(8).toVar();
  const d2 = float(8).toVar();
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const g = vec2(x, y);
      const cell = mod(i.add(g).add(per), per).add(seed);
      const d = length(g.add(cellPoint(cell, t)).sub(f)).toVar();
      d2.assign(min(d2, max(d, d1)));
      d1.assign(min(d1, d));
    }
  }
  return vec2(d1, d2);
};

// The filament, with a slightly different width per channel — red spills
// widest, so the outside of every strand goes warm and the core stays white.
const ridgeRGB = (p, period, t, seed) => {
  const w = worleyTile(p, period, t, seed).toVar();
  const e = w.y.sub(w.x);
  return smoothstep(vec3(0.0), vec3(0.345, 0.296, 0.252), vec3(e)).oneMinus();
};

/**
 * The whole texture, as a function of a [0,1] tile coordinate. Both the
 * fragment pass and the compute kernel call this and nothing else.
 */
const causticField = (p, t, seed) => {
  const s = ridgeRGB(p.mul(5.0), 5.0, t.mul(0.55), seed)
    .add(ridgeRGB(p.mul(9.0), 9.0, t.mul(0.82), seed.add(17.0)).mul(0.74))
    .add(ridgeRGB(p.mul(17.0), 17.0, t.mul(1.14), seed.add(53.0)).mul(0.46))
    .toVar();

  // Sharpen the sum into filaments rather than a blurry mesh.
  s.assign(pow(clamp(s.mul(0.56), 0, 1), vec3(2.4)).mul(3.4));

  // A slow, large-scale swell in brightness so the net breathes.
  const m = worleyTile(p.mul(3.0), 3.0, t.mul(0.26), seed.add(91.0)).toVar();
  s.mulAssign(smoothstep(0.10, 0.62, m.y.sub(m.x)).mul(0.80).add(0.40));

  // Stored at 0.4 scale: the byte target keeps ~2.5 units of headroom.
  return clamp(s, 0, 1).mul(0.4);
};

/**
 * @param {object} opts
 * @param {THREE.Renderer} opts.renderer
 * @param {number} [opts.size]     texture edge, power of two
 * @param {number} [opts.fps]      how often it is allowed to re-render
 * @param {number} [opts.seed]
 */
export function createCaustics({ renderer, size = 256, fps = 30, seed = 1 } = {}) {
  const useCompute = renderer?.backend?.isWebGPUBackend === true;

  const uTime = uniform(0.0);
  const uSeed = uniform((seed % 97) * 0.37);

  const maxAniso = renderer?.capabilities?.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
  const aniso = Math.min(4, maxAniso || 1);

  // The sampling side is identical either way: a seamless, mipmapped, tiling
  // texture. Only where the texels come from changes.
  const dressTexture = (tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = aniso;
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  };

  let outTexture;
  let target = null;
  let storage = null;
  let quad = null;
  let material = null;
  let computeNode = null;

  if (useCompute) {
    // --- compute path ------------------------------------------------------
    storage = new THREE.StorageTexture(size, size);
    storage.type = THREE.UnsignedByteType;
    storage.format = THREE.RGBAFormat;
    dressTexture(storage);
    outTexture = storage;

    computeNode = Fn(() => {
      const px = instanceIndex.mod(uint(size));
      const py = instanceIndex.div(uint(size));
      // Texel centres, so the field matches the fragment path exactly.
      const p = vec2(float(px), float(py)).add(0.5).div(float(size));
      textureStore(storage, uvec2(px, py), vec4(causticField(p, uTime, uSeed), 1.0));
    })().compute(size * size);
  } else {
    // --- fragment path (the reference) -------------------------------------
    target = new THREE.RenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    dressTexture(target.texture);
    outTexture = target.texture;

    material = new THREE.NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;
    material.fragmentNode = Fn(() => vec4(causticField(uv(), uTime, uSeed), 1.0))();

    quad = new THREE.QuadMesh(material);
  }

  const interval = 1 / Math.max(1, fps);
  let last = -1e9;

  function draw(time) {
    uTime.value = time;
    if (useCompute) {
      renderer.computeAsync(computeNode);
      return;
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  // Fill it once so the first frame never samples an uninitialised texture.
  draw(0);

  return {
    texture: outTexture,
    size,
    backend: useCompute ? 'compute' : 'fragment',
    update(time) {
      if (time - last < interval) return;
      last = time;
      draw(time);
    },
    dispose() {
      if (target) target.dispose();
      if (storage) storage.dispose();
      if (material) material.dispose();
    },
  };
}
