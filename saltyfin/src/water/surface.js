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
// shader reads it to flatten the swell as it runs up the reef, and the CPU
// sampler reads the same field, so sampleHeight agrees with the GPU to within a
// couple of centimetres and the hull floats on the crest you can see.
//
// LAYER.MAIN only. The surface must never appear in its own refraction or
// reflection.

import * as THREE from 'three';
import { LAYER, setLayers, addLayers } from '../core/layers.js';
import { smoothstep } from '../core/rng.js';
import { waveHeight, waveNormal } from './waves.js';
import { createWaterMaterial } from './waterMaterial.js';
import { createWake } from './wake.js';
import { createCaustics } from './caustics.js';

const WIND = 1.0;
const SNAP = 0.25;                 // metres the disc is allowed to move by
const DISC_RADIUS = 40000;         // well past the far plane; z is clamped
const DISC_FALLOFF = 9.2;          // exponential ring spacing
const DEPTH_TEX = 320;             // seabed map resolution
const DEPTH_HALF = 560;            // metres from the origin it covers
const DEPTH_MAX = 64;              // metres encoded in the sqrt ramp

const _scratchNormal = new THREE.Vector3();

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

/** Bake the seabed into a float grid plus a sqrt-encoded byte texture. */
function buildDepthMap(terrain, n, half) {
  const depths = new Float32Array(n * n);
  const data = new Uint8Array(n * n * 4);
  const step = (half * 2) / (n - 1);

  let fn = null;
  if (terrain && typeof terrain.seabedHeight === 'function') {
    try {
      const probe = terrain.seabedHeight(0, 0);
      if (typeof probe === 'number' && isFinite(probe)) fn = terrain.seabedHeight;
    } catch (e) { fn = null; }
  }

  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
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
      data[k * 4] = Math.max(0, Math.min(255, Math.round(e * 255)));
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
  return { texture: tex, depths, n, half, step };
}

export function createWater(opts = {}) {
  const { renderer, quality, terrain, scene } = opts;
  const seed = (opts.seed ?? 1) | 0;
  const tier = quality?.tier ?? 'high';

  const segments = quality?.waterSegments ?? 320;
  const sectors = Math.max(48, Math.round(segments * 0.75));
  const rings = Math.max(32, Math.round(segments * 0.50));

  const wakeSize = tier === 'low' ? 128 : 256;
  const wakeWorld = 128;
  const causticSize = tier === 'low' ? 128 : 256;
  const detailSize = tier === 'low' ? 128 : 256;

  // --- seabed map ----------------------------------------------------------
  const depthMap = buildDepthMap(terrain, DEPTH_TEX, DEPTH_HALF);

  // --- pieces --------------------------------------------------------------
  const caustics = createCaustics({
    renderer, size: causticSize, seed, fps: tier === 'low' ? 20 : 30,
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
  // Bilinear on the same field the vertex shader reads, so both sides agree.
  function depthAtCpu(x, z) {
    const n = depthMap.n;
    const fx = (x + depthMap.half) / depthMap.step;
    const fz = (z + depthMap.half) / depthMap.step;
    if (fx <= 0 || fz <= 0 || fx >= n - 1 || fz >= n - 1) return DEPTH_MAX;
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const d = depthMap.depths;
    const a = d[j * n + i], b = d[j * n + i + 1];
    const c = d[(j + 1) * n + i], e = d[(j + 1) * n + i + 1];
    return (a + (b - a) * tx) + ((c + (e - c) * tx) - (a + (b - a) * tx)) * tz;
  }

  function shoreAt(x, z) {
    return 0.10 + 0.90 * smoothstep(0.20, 3.0, depthAtCpu(x, z));
  }

  // --- module surface ------------------------------------------------------
  function setTargets(t) {
    if (!t) return;
    if (t.refraction) u.tRefraction.value = t.refraction.texture ?? t.refraction;
    if (t.refractionDepth) u.tRefractionDepth.value = t.refractionDepth;
    if (t.reflection) u.tReflection.value = t.reflection.texture ?? t.reflection;
    if (t.resolution) u.uResolution.value.set(t.resolution.x, t.resolution.y);
  }

  function applyEnv(env) {
    if (!env) return;
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
  }

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

    /** Surface height at a world point. Same train, same shore damp, as the GPU. */
    sampleHeight(x, z, time) {
      return waveHeight(x, z, time ?? 0, WIND, shoreAt(x, z));
    },

    /** Analytic normal of that same field. */
    sampleNormal(x, z, time, out) {
      return waveNormal(x, z, time ?? 0, out || _scratchNormal, WIND, shoreAt(x, z));
    },

    /** Water depth over the seabed at a world point, in metres. */
    depthAt(x, z) { return depthAtCpu(x, z); },

    /** Stamp the ripple sim — wake, splashes, a breaching leviathan. */
    disturb(x, z, strength = 1, radius = 2.5) {
      wake.disturb(x, z, strength, radius);
    },
  };
}
