// The water surface.
//
// Geometry is a camera-following radial disc: ring radii grow exponentially so
// the first forty rings sit inside thirty metres — enough real vertices for the
// Gerstner swell to read in silhouette against the sky — while the last rings
// run out past the far plane, which is why the shader clamps gl_Position.z. The
// disc is recentred on the camera every frame, snapped to a quarter metre, so
// nothing swims.
//
// A coarse seabed depth map is baked once from terrain.seabedHeight. The vertex
// shader reads it for two things — flattening the swell as it runs up the reef,
// and scaling each wave component up as the water deepens, which is what makes
// the open sea rougher than the lagoon — and the CPU sampler reproduces the
// GPU's read byte for byte (bilinear the encoded values, then square), so
// sampleHeight agrees with the shader to within the encoding's own
// quantisation and the hull floats on the crest you can see.
//
// LAYER.MAIN only. The surface must never appear in its own refraction or
// reflection.

import * as THREE from 'three';
import { LAYER, setLayers, addLayers } from '../core/layers.js';
import { smoothstep } from '../core/rng.js';
import { waveHeight, waveNormal, waveWeights, WAVE_COUNT } from './waves.js';
import { createWaterMaterial } from './waterMaterial.js';
import { createWake } from './wake.js';
import { createCaustics } from './caustics.js';
import { oceanSettings } from './settings.js';

const WIND = 1.0;
const SNAP = 0.25;                 // metres the disc is allowed to move by
const DISC_RADIUS = 40000;         // well past the far plane; z is clamped
const DISC_FALLOFF = 9.2;          // exponential ring spacing
const DEPTH_TEX = 320;             // seabed map resolution
const DEPTH_HALF = 560;            // metres from the origin it covers
const DEPTH_MAX = 64;              // metres encoded in the sqrt ramp

const _scratchNormal = new THREE.Vector3();
// Two, not one: sampleHeight and sampleNormal are called back to back by
// props.js and boat.js, and sharing a single buffer between them would work
// today only by luck of the call order.
const _wH = new Float32Array(WAVE_COUNT);
const _wN = new Float32Array(WAVE_COUNT);
const _deep = new Float32Array(WAVE_COUNT);

// The layout in CONTRACT.md, used only if the terrain module is not answering.
function fallbackSeabed(x, z) {
  const r = Math.sqrt(x * x + z * z);
  if (r <= 200) return -(1.5 + 5.5 * (r / 200));
  return -(7 + 23 * Math.min(1, (r - 200) / 320));
}

// three culls lights by camera layers, so a light left on LAYER.MAIN alone
// contributes nothing to the refraction or reflection passes and the seabed
// comes back black — which would make the reef unreadable through the surface,
// the one thing the concept art insists on. Opting every light into those two
// passes is idempotent and harmless if main.js ever does it itself.
function lightAllPasses(scene) {
  if (!scene || typeof scene.traverse !== 'function') return;
  scene.traverse((o) => {
    if (o.isLight) addLayers(o, LAYER.UNDERWATER, LAYER.REFLECTED);
  });
}

/** Radial disc, axis aligned, exponential ring spacing, centre-fanned. */
function buildDiscGeometry(rings, sectors, radius, falloff) {
  const vertCount = (rings + 1) * sectors;
  const pos = new Float32Array(vertCount * 3);
  const denom = Math.exp(falloff) - 1;

  let p = 0;
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const r = radius * (Math.exp(falloff * t) - 1) / denom;
    for (let si = 0; si < sectors; si++) {
      const a = (si / sectors) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }

  const idxCount = rings * sectors * 6;
  const idx = vertCount > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
  let k = 0;
  for (let ri = 0; ri < rings; ri++) {
    const a0 = ri * sectors;
    const a1 = (ri + 1) * sectors;
    for (let si = 0; si < sectors; si++) {
      const sn = (si + 1) % sectors;
      // Wound so the front face looks up: the shader's gl_FrontFacing test is
      // what switches between the surface and the view from underneath.
      const i0 = a0 + si, i1 = a0 + sn, i2 = a1 + sn, i3 = a1 + si;
      idx[k++] = i0; idx[k++] = i2; idx[k++] = i3;
      idx[k++] = i0; idx[k++] = i1; idx[k++] = i2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius);
  return geo;
}

/**
 * Bake the seabed into a sqrt-encoded byte texture plus the same values as
 * floats, so the CPU sampler can reproduce the GPU's read exactly.
 *
 * Sample points are TEXEL CENTRES: x = -half + (i + 0.5) * (2*half/n). The
 * bake used to step (2*half)/(n-1) from edge to edge, which put every baked
 * value 1.75 m away from where the sampler thinks it lives — a systematic half
 * texel of skew between the boat's depth and the shader's. That was worth up
 * to 0.4 m of disagreement in depth and 0.126 of shore before the depth ramp;
 * with the ramp multiplying amplitude, the same error would scale with it.
 */
function buildDepthMap(terrain, n, half) {
  const depths = new Float32Array(n * n);
  const enc = new Float32Array(n * n);       // exactly what the sampler reads back
  const data = new Uint8Array(n * n * 4);
  const step = (half * 2) / n;

  let fn = null;
  if (terrain && typeof terrain.seabedHeight === 'function') {
    try {
      const probe = terrain.seabedHeight(0, 0);
      if (typeof probe === 'number' && isFinite(probe)) fn = terrain.seabedHeight;
    } catch (e) { fn = null; }
  }

  for (let j = 0; j < n; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * step;
      let h;
      if (fn) {
        h = fn(x, z);
        if (typeof h !== 'number' || !isFinite(h)) h = fallbackSeabed(x, z);
      } else {
        h = fallbackSeabed(x, z);
      }
      const d = h < 0 ? -h : 0;
      const k = j * n + i;
      depths[k] = d;
      const e = Math.sqrt(Math.min(d, DEPTH_MAX) / DEPTH_MAX);
      const byte = Math.max(0, Math.min(255, Math.round(e * 255)));
      enc[k] = byte / 255;
      data[k * 4] = byte;
      data[k * 4 + 1] = 0;
      data[k * 4 + 2] = 0;
      data[k * 4 + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { texture: tex, depths, enc, n, half, step };
}

export function createWater(opts = {}) {
  const { renderer, quality, terrain, scene } = opts;
  const seed = (opts.seed ?? 1) | 0;

  const segments = quality?.waterSegments ?? 320;
  const sectors = Math.max(48, Math.round(segments * 0.75));
  const rings = Math.max(32, Math.round(segments * 0.50));

  // Off the tier's budget rather than its name: a phone was getting the
  // desktop 256² simulation textures because 'mobile' matched neither branch.
  const lean = (quality?.geometry ?? 1) < 0.6;
  const wakeSize = lean ? 128 : 256;
  const wakeWorld = 128;
  const causticSize = lean ? 128 : 256;
  const detailSize = lean ? 128 : 256;

  // --- seabed map ----------------------------------------------------------
  const depthMap = buildDepthMap(terrain, DEPTH_TEX, DEPTH_HALF);

  // --- pieces --------------------------------------------------------------
  const caustics = createCaustics({
    renderer, size: causticSize, seed, fps: lean ? 20 : 30,
  });
  const wake = createWake({ renderer, size: wakeSize, worldSize: wakeWorld });

  const built = createWaterMaterial({
    renderer, seed, quality,
    depthTexture: depthMap.texture,
    depthExtent: DEPTH_HALF * 2,
    depthMax: DEPTH_MAX,
    wakeSize, wakeWorld, detailSize,
  });
  const material = built.material;
  const u = built.uniforms;
  u.tCaustic.value = caustics.texture;
  u.tWake.value = wake.texture;

  const geometry = buildDiscGeometry(rings, sectors, DISC_RADIUS, DISC_FALLOFF);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = true;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.renderOrder = 1;
  mesh.name = 'water';

  const group = new THREE.Group();
  group.name = 'water';
  group.add(mesh);
  setLayers(group, LAYER.MAIN);

  // --- CPU side of the shore damp -----------------------------------------
  // The GPU does: bilinear the sqrt-ENCODED bytes, square, scale by DEPTH_MAX,
  // and force DEPTH_MAX outside the map. Doing the same arithmetic in the same
  // order here is what makes sampleHeight agree with the vertex shader; the old
  // version bilineared the raw float depths instead, and squaring a filtered
  // encode is not the same thing as filtering squared values — worst measured
  // disagreement 0.399 m of depth, 0.126 of shore. That mattered little while
  // the train was flat; it scales with the depth ramp's amplitude gain.
  function depthAtCpu(x, z) {
    const n = depthMap.n, half = depthMap.half;
    // The shader's own outside test, on the unclamped uv: |uv - 0.5| * 2 >= 1.
    if (x <= -half || x >= half || z <= -half || z >= half) return DEPTH_MAX;
    // Texel coordinates, the sampler's convention: texel i is centred at
    // (i + 0.5) / n in uv, so uv * n - 0.5 lands on the grid the bake wrote.
    let fx = ((x + half) / (half * 2)) * n - 0.5;
    let fz = ((z + half) / (half * 2)) * n - 0.5;
    // Clamp-to-edge, exactly as the texture's wrap mode does.
    if (fx < 0) fx = 0; else if (fx > n - 1) fx = n - 1;
    if (fz < 0) fz = 0; else if (fz > n - 1) fz = n - 1;
    let i = fx | 0, j = fz | 0;
    if (i > n - 2) i = n - 2;
    if (j > n - 2) j = n - 2;
    const tx = fx - i, tz = fz - j;
    const d = depthMap.enc;
    const a = d[j * n + i], b = d[j * n + i + 1];
    const c = d[(j + 1) * n + i], e = d[(j + 1) * n + i + 1];
    const top = a + (b - a) * tx;
    const bot = c + (e - c) * tx;
    const s = top + (bot - top) * tz;
    return s * s * DEPTH_MAX;
  }

  /**
   * The six per-wave amplitude weights at a point — the shore damp and the
   * depth ramp, in that order, exactly as the vertex stage builds them. The
   * deep-water multipliers and the master gain are read back out of the
   * uniforms rather than off the table, so a soak.mjs sweep moves the water the
   * boat floats on at the same time as the water it can see.
   */
  function weightsAt(x, z, out) {
    const d = depthAtCpu(x, z);
    const a = u.uSwellDeepA.value, b = u.uSwellDeepB.value;
    _deep[0] = a.x; _deep[1] = a.y; _deep[2] = a.z;
    _deep[3] = b.x; _deep[4] = b.y; _deep[5] = b.z;
    return waveWeights(d, 0.10 + 0.90 * smoothstep(0.20, 3.0, d),
      out, u.uSwellGain.value, _deep);
  }

  // --- module surface ------------------------------------------------------
  function setTargets(t) {
    if (!t) return;
    if (t.refraction) u.tRefraction.value = t.refraction.texture ?? t.refraction;
    if (t.refractionDepth) u.tRefractionDepth.value = t.refractionDepth;
    if (t.reflection) u.tReflection.value = t.reflection.texture ?? t.reflection;
    if (t.resolution) u.uResolution.value.set(t.resolution.x, t.resolution.y);
  }

  // The last environment handed in, kept so a settings change can replay it.
  let lastEnv = null;

  function applyEnv(env) {
    env = env || lastEnv;
    // No preset yet — apply the player's settings alone, so anything declared
    // `set` (which owns its uniform outright) is live before the first tick.
    if (!env) { oceanSettings.apply(u); return; }
    lastEnv = env;
    u.uAbsorb.value.copy(env.waterAbsorption);
    u.uScatter.value.copy(env.waterScatter);
    u.uShallow.value.copy(env.waterShallow);
    u.uMid.value.copy(env.waterMid);
    u.uDeep.value.copy(env.waterDeep);

    u.uFogColor.value.copy(env.fogColor);
    u.uFogNear.value = env.fogNear;
    u.uFogFar.value = env.fogFar;
    u.uSkyZenith.value.copy(env.skyZenith);
    u.uSkyHorizon.value.copy(env.skyHorizon);
    u.uHorizonGlow.value = env.horizonGlow;

    u.uKeyDir.value.copy(env.keyDir);
    u.uKeyColor.value.copy(env.keyColor);
    u.uKeyIntensity.value = env.keyIntensity;
    u.uAmbient.value.copy(env.ambientSky);
    u.uAmbIntensity.value = env.ambientIntensity;
    u.uDayFactor.value = env.dayFactor;

    u.uSpecular.value = env.specularStrength;
    u.uRoughness.value = Math.max(0.02, env.roughness);
    u.uGlitter.value = env.glitterStrength;
    u.uGlitterSize.value = Math.max(0.2, env.glitterSize);
    u.uGlitterColor.value.copy(env.sunGlitterColor);
    u.uReflStrength.value = env.reflectionStrength;
    u.uCaustic.value = env.causticStrength;
    u.uFoamTint.value.copy(env.foamTint);
    u.uFoamBright.value = env.foamBrightness;

    // Last, and only here. Everything above is the time of day writing its
    // preset over the top of whatever was in the uniform; the player's settings
    // have to land after that or a sunset would silently undo them. Several of
    // them multiply what the lines above just wrote, which is why this is a
    // re-application rather than a one-time init — see water/settings.js.
    oceanSettings.apply(u);
  }

  // Moving a slider must take effect on the frame it is moved, and applyEnv
  // only runs when the clock's version changes — which, with the clock paused,
  // is never. Re-running the whole thing is the cheapest correct answer: it is
  // thirty uniform writes and it keeps one code path for "how the water is
  // configured" instead of two that can drift apart.
  const unsubscribe = oceanSettings.subscribe(() => applyEnv(null));
  applyEnv(null);

  let litPasses = false;

  function update(ctx) {
    if (!litPasses) { litPasses = true; lightAllPasses(ctx.scene || scene); }
    const t = ctx.time;
    u.uTime.value = t;
    u.uNear.value = ctx.camera.near;
    u.uFar.value = ctx.camera.far;

    caustics.update(t);
    wake.update(ctx);
    u.tWake.value = wake.texture;
    u.uWakeCenter.value.copy(wake.center);

    const cx = Math.round(ctx.camera.position.x / SNAP) * SNAP;
    const cz = Math.round(ctx.camera.position.z / SNAP) * SNAP;
    mesh.position.set(cx, 0, cz);
  }

  function dispose() {
    unsubscribe();
    geometry.dispose();
    built.dispose();
    wake.dispose();
    caustics.dispose();
    depthMap.texture.dispose();
    group.clear();
  }

  return {
    group,
    material,
    uniforms: u,
    wake,
    caustics,
    update,
    applyEnv,
    dispose,
    setTargets,

    /** Surface height at a world point. Same train, same weights, as the GPU. */
    sampleHeight(x, z, time) {
      return waveHeight(x, z, time ?? 0, WIND, weightsAt(x, z, _wH));
    },

    /** Analytic normal of that same field. */
    sampleNormal(x, z, time, out) {
      return waveNormal(x, z, time ?? 0, out || _scratchNormal, WIND, weightsAt(x, z, _wN));
    },

    /** Water depth over the seabed at a world point, in metres. */
    depthAt(x, z) { return depthAtCpu(x, z); },

    /** Stamp the ripple sim — wake, splashes, a breaching leviathan. */
    disturb(x, z, strength = 1, radius = 2.5) {
      wake.disturb(x, z, strength, radius);
    },
  };
}
