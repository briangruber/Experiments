// The surface shader.
//
// A NodeMaterial with a hand-written `vertexNode` and `fragmentNode` — the same
// algorithm, the same constants and the same tuning as the GLSL original, built
// as TSL graphs instead of shader source. It does its own lighting and its own
// distance fade, so it needs neither of three's.
//
// What happens per pixel, in order:
//   normal      shared Gerstner train + three drifting layers of a tiling
//               gradient map + the boat's ripple field, flattened with distance
//   refraction  screen-space, offset by the view-space normal, rejected when
//               the offset lands on something nearer than the surface
//   column      the seabed's world position reconstructed from the refraction
//               depth buffer -> a real water-column length for Beer-Lambert and
//               a real world XZ to project the caustics onto
//   reflection  the mirrored-camera target, U-flipped, blended by Schlick
//   light path  a specular lobe toward the key plus a world-anchored stochastic
//               glitter that twinkles as the wave passes under it
//   foam        shore (thin column), crest (Gerstner Jacobian), wake
//
// Every colour is env's. The only things this file chooses are how much of each.
//
// Two structural notes on the port:
//
//   * the old shader returned early for `!gl_FrontFacing`. Here both sides of
//     the surface are evaluated and `select`ed between at the very end, so every
//     texture read sits in uniform control flow — which WGSL requires and which
//     costs nothing, because the underwater branch reads no textures of its own.
//   * the wave table never changes at runtime, so `packWaves()` is evaluated
//     once at build time and the six waves are baked into the graph as
//     constants rather than carried in a uniform array. water/waves.js is still
//     the single definition of the train.

import * as THREE from 'three';
import {
  Fn, texture, uniform, vec2, vec3, vec4, float,
  max, min, clamp, mix, pow, dot, step, smoothstep, fract, floor,
  sin, cos, abs, exp, normalize, length, reflect, select, If,
  screenUV, frontFacing, cameraPosition, cameraViewMatrix, cameraProjectionMatrix,
  modelWorldMatrix, positionGeometry, varyingProperty,
} from 'three/tsl';
import { WAVE_COUNT, packWaves } from './waves.js';
import { makeRng } from '../core/rng.js';

// ---------------------------------------------------------------------------
// A seamlessly tiling ripple field, built from a sum of integer-frequency
// sinusoids so it wraps exactly and so its gradient is analytic.
//   RG  gradient (dh/du, dh/dv), signed, packed to [0,1]
//   B   height
//   A   a second, uncorrelated field used to break up foam edges
// ---------------------------------------------------------------------------
function buildDetailTexture(size, seed) {
  const rng = makeRng(seed >>> 0);

  const band = (n, maxF, exponent) => {
    const fx = new Float32Array(n), fz = new Float32Array(n);
    const ph = new Float32Array(n), am = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = Math.round(rng.range(-maxF, maxF));
      let b = Math.round(rng.range(-maxF, maxF));
      if (a === 0 && b === 0) b = 1;
      fx[i] = a; fz[i] = b;
      ph[i] = rng.range(0, Math.PI * 2);
      am[i] = 1 / Math.pow(Math.hypot(a, b), exponent);
    }
    return { n, fx, fz, ph, am };
  };

  const main = band(22, 13, 1.30);
  const alt = band(10, 7, 1.10);

  const gx = new Float32Array(size * size);
  const gz = new Float32Array(size * size);
  const hh = new Float32Array(size * size);
  const nn = new Float32Array(size * size);

  const TAU = Math.PI * 2;
  let gMax = 1e-6, hMin = 1e9, hMax = -1e9, nMin = 1e9, nMax = -1e9;

  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      let dx = 0, dz = 0, h = 0;
      for (let k = 0; k < main.n; k++) {
        const p = TAU * (main.fx[k] * u + main.fz[k] * v) + main.ph[k];
        const a = main.am[k];
        h += Math.sin(p) * a;
        const c = Math.cos(p) * a * TAU;
        dx += c * main.fx[k];
        dz += c * main.fz[k];
      }
      let s = 0;
      for (let k = 0; k < alt.n; k++) {
        s += Math.sin(TAU * (alt.fx[k] * u + alt.fz[k] * v) + alt.ph[k]) * alt.am[k];
      }
      const idx = j * size + i;
      gx[idx] = dx; gz[idx] = dz; hh[idx] = h; nn[idx] = s;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      if (m > gMax) gMax = m;
      if (h < hMin) hMin = h; if (h > hMax) hMax = h;
      if (s < nMin) nMin = s; if (s > nMax) nMax = s;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const gs = 0.5 / gMax;
  const hs = 1 / Math.max(1e-6, hMax - hMin);
  const ns = 1 / Math.max(1e-6, nMax - nMin);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.max(0, Math.min(255, Math.round((0.5 + gx[i] * gs) * 255)));
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((0.5 + gz[i] * gs) * 255)));
    data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round((hh[i] - hMin) * hs * 255)));
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((nn[i] - nMin) * ns * 255)));
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// The shared GLSL chunks this shader used, as node graphs. Same constants.
// ---------------------------------------------------------------------------

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** core/glsl.js `sat` — clamp to the unit range. */
const sat = (x) => clamp(x, 0, 1);

const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const hash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

/** Voronoi returning (distance to nearest, distance to second, cell id). */
const worley = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const d1 = float(8.0).toVar();
  const d2 = float(8.0).toVar();
  const id = float(0.0).toVar();
  // The 3x3 neighbourhood is unrolled here rather than looped: the graph is
  // built in JS, so a fixed count costs nothing to spell out.
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const g = vec2(x, y);
      const o = hash22(i.add(g));
      const d = length(g.add(o).sub(f)).toVar();
      If(d.lessThan(d1), () => {
        d2.assign(d1); d1.assign(d); id.assign(hash12(i.add(g)));
      }).ElseIf(d.lessThan(d2), () => {
        d2.assign(d);
      });
    }
  }
  return vec3(d1, d2, id);
});

const fresnelSchlick = Fn(([cosT, f0]) => {
  const m = clamp(cosT.oneMinus(), 0, 1).toVar();
  const m2 = m.mul(m).toVar();
  return f0.add(f0.oneMinus().mul(m2).mul(m2).mul(m));
});

// mat2(0.8253, -0.5647, 0.5647, 0.8253), column major as GLSL reads it.
const CAUSTIC_ROT = [0.8253, -0.5647, 0.5647, 0.8253];
const causticRot = (v) => vec2(
  v.x.mul(CAUSTIC_ROT[0]).add(v.y.mul(CAUSTIC_ROT[2])),
  v.x.mul(CAUSTIC_ROT[1]).add(v.y.mul(CAUSTIC_ROT[3])),
);

// The six waves, resolved once. dir is already unit; k, amplitude, steepness and
// omega are exactly what the GLSL read out of uWaveA/uWaveB.
const packed = packWaves(1, 1);
const WAVES = [];
for (let i = 0; i < WAVE_COUNT; i++) {
  WAVES.push({
    dx: packed.a[i * 4 + 0], dz: packed.a[i * 4 + 1],
    k: packed.a[i * 4 + 2], amp: packed.a[i * 4 + 3],
    steep: packed.b[i * 4 + 0], omega: packed.b[i * 4 + 1],
  });
}

/** k * dot(d, p) - omega * t, for one wave. */
const wavePhase = (w, p, t) => float(w.k).mul(p.x.mul(w.dx).add(p.y.mul(w.dz))).sub(t.mul(w.omega));

/** 1x1 stand-ins so every texture node is valid before setTargets runs. */
function blankTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * The surface material. `depthTexture` is the coarse seabed map built by
 * surface.js; everything else arrives later through setTargets/applyEnv.
 */
export function createWaterMaterial({
  renderer, seed = 1, quality = null,
  depthTexture = null, depthExtent = 1120, depthMax = 64,
  wakeSize = 256, wakeWorld = 128, detailSize = 256,
} = {}) {
  const detail = buildDetailTexture(detailSize, seed ^ 0x5f3a91);
  // The node renderer answers getMaxAnisotropy() itself; the classic
  // `renderer.capabilities` object does not exist on it.
  const maxAniso = renderer?.getMaxAnisotropy?.()
    ?? (renderer?.capabilities?.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  detail.anisotropy = Math.min(8, maxAniso || 1);

  const placeholders = [];
  const blank = () => { const t = blankTexture(); placeholders.push(t); return t; };
  const blankDepth = () => {
    const t = new THREE.DepthTexture(1, 1, THREE.FloatType);
    t.needsUpdate = true;
    placeholders.push(t);
    return t;
  };

  // --- uniforms ------------------------------------------------------------
  // Same names, same defaults as the WebGL build. Each is a TSL uniform node,
  // so `uniforms.uFoo.value` still reads and writes exactly as it did.
  const uTime = uniform(0);
  const uWind = uniform(1);

  const tRefraction = texture(blank());
  const tRefractionDepth = texture(blankDepth());
  const tReflection = texture(blank());
  const tCaustic = texture(blank());
  const tDetail = texture(detail);
  const tWake = texture(blank());
  const tDepthMap = texture(depthTexture ?? blank());

  const uDepthOrigin = uniform(new THREE.Vector2(0, 0));
  const uDepthInvExtent = uniform(1 / depthExtent);
  const uDepthMax = uniform(depthMax);

  const uResolution = uniform(new THREE.Vector2(1280, 720));
  const uNear = uniform(0.35);
  const uFar = uniform(6000);

  const uAbsorb = uniform(new THREE.Vector3(0.33, 0.07, 0.042));
  const uScatter = uniform(new THREE.Color(0x22acbc));
  const uShallow = uniform(new THREE.Color(0x63e2d4));
  const uMid = uniform(new THREE.Color(0x23bec6));
  const uDeep = uniform(new THREE.Color(0x0a4ea4));

  const uFogColor = uniform(new THREE.Color(0xaadaf2));
  const uFogNear = uniform(260);
  const uFogFar = uniform(2000);
  const uSkyZenith = uniform(new THREE.Color(0x1361d2));
  const uSkyHorizon = uniform(new THREE.Color(0xc6e7f8));
  const uHorizonGlow = uniform(0.48);

  const uKeyDir = uniform(new THREE.Vector3(0.4, 0.8, -0.45));
  const uKeyColor = uniform(new THREE.Color(0xfff6e2));
  const uKeyIntensity = uniform(3.7);
  const uAmbient = uniform(new THREE.Color(0xa2cef2));
  const uAmbIntensity = uniform(1);
  const uDayFactor = uniform(1);

  const uSpecular = uniform(1);
  const uRoughness = uniform(0.06);
  const uGlitter = uniform(0.85);
  const uGlitterSize = uniform(1);
  const uGlitterColor = uniform(new THREE.Color(0xfffcf0));
  const uReflStrength = uniform(0.92);
  const uReflEnabled = uniform(quality && quality.reflections === false ? 0 : 1);
  const uCaustic = uniform(1);
  const uCausticScale = uniform(1 / 8.5);
  const uFoamTint = uniform(new THREE.Color(0xffffff));
  const uFoamBright = uniform(1);

  const uWakeCenter = uniform(new THREE.Vector2());
  const uWakeWorld = uniform(wakeWorld);
  const uWakeTexel = uniform(1 / wakeSize);
  const uWakeSlope = uniform(5.5);
  const uWakeArmSlope = uniform(1.6);
  const uWakeFoam = uniform(1.25);
  const uWakeArmFoam = uniform(0.32);

  const uDetailStrength = uniform(0.22);
  const uRefractDistort = uniform(0.26);
  const uReflDistort = uniform(0.12);
  const uScatterStrength = uniform(0.85);
  const uShoreFoamDepth = uniform(0.72);

  const uniforms = {
    uTime, uWind,
    tRefraction, tRefractionDepth, tReflection, tCaustic, tDetail, tWake, tDepthMap,
    uDepthOrigin, uDepthInvExtent, uDepthMax,
    uResolution, uNear, uFar,
    uAbsorb, uScatter, uShallow, uMid, uDeep,
    uFogColor, uFogNear, uFogFar, uSkyZenith, uSkyHorizon, uHorizonGlow,
    uKeyDir, uKeyColor, uKeyIntensity, uAmbient, uAmbIntensity, uDayFactor,
    uSpecular, uRoughness, uGlitter, uGlitterSize, uGlitterColor,
    uReflStrength, uReflEnabled, uCaustic, uCausticScale, uFoamTint, uFoamBright,
    uWakeCenter, uWakeWorld, uWakeTexel, uWakeSlope, uWakeArmSlope, uWakeFoam, uWakeArmFoam,
    uDetailStrength, uRefractDistort, uReflDistort, uScatterStrength, uShoreFoamDepth,
  };

  // --- what the vertex stage hands the fragment stage ----------------------
  const vWorld = varyingProperty('vec3', 'vWaterWorld');
  const vFlat = varyingProperty('vec2', 'vWaterFlat');
  const vShore = varyingProperty('float', 'vWaterShore');
  const vBedDepth = varyingProperty('float', 'vWaterBedDepth');
  const vJac = varyingProperty('float', 'vWaterJac');
  const vCrest = varyingProperty('float', 'vWaterCrest');
  const vDist = varyingProperty('float', 'vWaterDist');

  // Window depth -> positive metres along the camera's forward axis.
  const linearDepth = Fn(([d]) => {
    const ndc = d.mul(2.0).sub(1.0);
    return float(2.0).mul(uNear).mul(uFar).div(uFar.add(uNear).sub(ndc.mul(uFar.sub(uNear))));
  });

  const skyAt = Fn(([dir]) => {
    const h = sat(dir.y).toVar();
    const c = mix(uSkyHorizon, uSkyZenith, pow(h, 0.42)).toVar();
    const fd = normalize(vec2(dir.x, dir.z).add(1e-5)).toVar();
    const kd = normalize(vec2(uKeyDir.x, uKeyDir.z).add(1e-5)).toVar();
    const g = pow(sat(dot(fd, kd)), 5.0).mul(h.oneMinus()).toVar();
    return c.add(uSkyHorizon.mul(g).mul(uHorizonGlow).mul(0.45));
  });

  // --- vertex --------------------------------------------------------------
  const vertexNode = Fn(() => {
    const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz;
    const p = wp.xz.toVar();
    vFlat.assign(p);

    // Water depth from the coarse seabed map: waves flatten as they run up the
    // reef instead of clipping through it, and the CPU sampler uses the same
    // field so the hull floats on the crest you can see.
    const duv = p.sub(uDepthOrigin).mul(uDepthInvExtent).add(0.5).toVar();
    const depth = tDepthMap.sample(clamp(duv, vec2(0.0), vec2(1.0))).r.toVar();
    depth.assign(depth.mul(depth).mul(uDepthMax));
    const outside = step(vec2(1.0), abs(duv.sub(0.5)).mul(2.0)).toVar();
    depth.assign(mix(depth, uDepthMax, max(outside.x, outside.y)));
    const shore = float(0.10).add(smoothstep(0.20, 3.0, depth).mul(0.90)).toVar();
    vShore.assign(shore);
    vBedDepth.assign(depth);

    // Horizontal pinch plus vertical displacement — the crest sharpening that
    // makes a swell read as water rather than as a sine sheet. Alongside it, the
    // Jacobian of that pinch: where it collapses the crest is being squeezed to
    // a point, and that is where a real wave throws foam.
    let accX = float(0.0), accY = float(0.0), accZ = float(0.0);
    let jxx = float(1.0), jzz = float(1.0), jxz = float(0.0);
    for (const w of WAVES) {
      const a = float(w.amp).mul(uWind).mul(shore).toVar();
      const phase = wavePhase(w, p, uTime);
      const s = sin(phase).toVar();
      const c = cos(phase).toVar();
      accY = accY.add(a.mul(s));
      const pinch = a.mul(w.steep).mul(c).toVar();
      accX = accX.add(pinch.mul(w.dx));
      accZ = accZ.add(pinch.mul(w.dz));
      const q = a.mul(w.steep * w.k).mul(s).toVar();
      jxx = jxx.sub(q.mul(w.dx * w.dx));
      jzz = jzz.sub(q.mul(w.dz * w.dz));
      jxz = jxz.sub(q.mul(w.dx * w.dz));
    }
    const gx = accX.toVar(), gy = accY.toVar(), gz = accZ.toVar();
    const jx = jxx.toVar(), jz = jzz.toVar(), jc = jxz.toVar();

    const world = vec3(p.x.add(gx), gy, p.y.add(gz)).toVar();
    vCrest.assign(gy);
    vJac.assign(jx.mul(jz).sub(jc.mul(jc)));
    vWorld.assign(world);
    vDist.assign(length(world.sub(cameraPosition)));

    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1.0))).toVar();
    // The disc runs past the far plane on purpose so the water reaches the true
    // horizon; clamp z so the far ring is never clipped into a sliver of sky.
    return vec4(clip.xy, min(clip.z, clip.w.mul(0.999995)), clip.w);
  });

  // --- fragment ------------------------------------------------------------
  const fragmentNode = Fn(() => {
    const suv = screenUV.toVar();
    const V = normalize(cameraPosition.sub(vWorld)).toVar();
    const L = normalize(uKeyDir).toVar();
    const dist = vDist.toVar();

    // --- surface normal ---------------------------------------------------
    // gerstnerNormal(vFlat, uTime, uWind, vShore), unrolled.
    let gradX = float(0.0), gradZ = float(0.0);
    for (const w of WAVES) {
      const a = float(w.amp).mul(uWind).mul(vShore);
      const slope = a.mul(w.k).mul(cos(wavePhase(w, vFlat, uTime))).toVar();
      gradX = gradX.add(slope.mul(w.dx));
      gradZ = gradZ.add(slope.mul(w.dz));
    }
    const N = normalize(vec3(gradX.negate(), 1.0, gradZ.negate())).toVar();
    const ng = vec2(N.x.negate(), N.z.negate()).div(max(N.y, 1e-3)).toVar();

    const d0 = tDetail.sample(vFlat.mul(0.285).add(vec2(0.021, -0.034).mul(uTime))).toVar();
    const d1 = tDetail.sample(vFlat.mul(0.110).add(vec2(-0.016, 0.012).mul(uTime))).toVar();
    const d2 = tDetail.sample(vFlat.mul(0.043).add(vec2(0.008, 0.006).mul(uTime))).toVar();
    const ripFade = smoothstep(140.0, 900.0, dist).oneMinus().toVar();
    const grad = d0.rg.mul(2.0).sub(1.0).mul(0.85)
      .add(d1.rg.mul(2.0).sub(1.0).mul(0.55))
      .add(d2.rg.mul(2.0).sub(1.0).mul(0.34)).toVar();
    ng.addAssign(grad.mul(uDetailStrength.mul(ripFade)));
    const breakup = d0.a.mul(0.45).add(d1.a.mul(0.33)).add(d2.a.mul(0.22)).toVar();

    // --- the boat's ripple field ------------------------------------------
    const wuv = vFlat.sub(uWakeCenter).div(uWakeWorld).add(0.5).toVar();
    const wa = smoothstep(vec2(0.0), vec2(0.05), wuv).toVar();
    const wb = smoothstep(vec2(0.95), vec2(1.0), wuv).oneMinus().toVar();
    const wmask = wa.x.mul(wa.y).mul(wb.x).mul(wb.y).toVar();
    const wC = tWake.sample(wuv).toVar();
    const wL = tWake.sample(wuv.sub(vec2(uWakeTexel, 0.0))).toVar();
    const wR = tWake.sample(wuv.add(vec2(uWakeTexel, 0.0))).toVar();
    const wD = tWake.sample(wuv.sub(vec2(0.0, uWakeTexel))).toVar();
    const wU = tWake.sample(wuv.add(vec2(0.0, uWakeTexel))).toVar();
    ng.addAssign(vec2(wR.r.sub(wL.r), wU.r.sub(wD.r)).mul(uWakeSlope.mul(wmask)));
    ng.addAssign(vec2(wR.a.sub(wL.a), wU.a.sub(wD.a)).mul(uWakeArmSlope.mul(wmask)));

    N.assign(normalize(vec3(ng.x.negate(), 1.0, ng.y.negate())));
    // Filtered normal: flatten and roughen with distance or the far water boils.
    const flatten = smoothstep(90.0, 1500.0, dist).toVar();
    N.assign(normalize(mix(N, vec3(0.0, 1.0, 0.0), flatten.mul(0.88))));
    const rough = mix(uRoughness, float(0.34), smoothstep(30.0, 900.0, dist)).toVar();

    // Screen-space offsets must come from how far the normal has been bent away
    // from flat, not from the normal itself — the latter is a constant slide of
    // the whole image with no wobble in it at all.
    const Nv = cameraViewMatrix.mul(vec4(N, 0.0)).xyz.toVar();
    const bend = Nv.xy.sub(cameraViewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xy).toVar();

    // Foam is a diffuse white scatterer lit by the whole dome, so it must not
    // collapse when the key drops to the horizon — at sunset the wake is still
    // the brightest thing outside the light path.
    const foamLight = uAmbIntensity.mul(0.85)
      .add(uKeyIntensity.mul(0.40).mul(sat(L.y.mul(1.5).add(0.12)))).toVar();
    const foamCol = vec3(uFoamTint.mul(uFoamBright.mul(float(0.45).add(foamLight)))).toVar();

    // --- the view from underneath -----------------------------------------
    // Snell's window: the whole sky squeezed into a 97 degree cone, and outside
    // it the underside of the surface turns into a mirror of the gloom below.
    const up = V.negate().toVar();
    const win = smoothstep(0.52, 0.80, sat(dot(up, N))).toVar();
    const through = vec3(skyAt(normalize(mix(vec3(0.0, 1.0, 0.0), up, 0.6)))).toVar();
    const gloom = vec3(uDeep.mul(0.70).add(uScatter.mul(0.30))).toVar();
    const under = vec3(mix(gloom, through.mul(1.15), win)).toVar();
    under.addAssign(uKeyColor.mul(uKeyIntensity).mul(pow(sat(dot(up, L)), 60.0)).mul(win).mul(1.2));
    const wf = sat(wC.b.mul(uWakeFoam).add(wC.a.mul(uWakeArmFoam))).mul(wmask).toVar();
    under.assign(mix(under, foamCol.mul(0.5), sat(wf).mul(0.55)));
    under.assign(mix(under, gloom.mul(0.55), smoothstep(10.0, 140.0, dist)));
    // Modulate after the distance blend, or the far ceiling reads as a flat wall.
    under.mulAssign(float(0.78).add(sat(N.y.mul(0.4).add(vCrest.mul(1.8)).add(0.45)).mul(0.52)));

    const RD = normalize(vWorld.sub(cameraPosition)).toVar();
    // dot(RD, cameraForward) without pulling a column out of the view matrix:
    // the camera looks down -Z in view space, so it is just -RD.z there.
    const cosA = max(cameraViewMatrix.mul(vec4(RD, 0.0)).z.negate(), 1e-3).toVar();

    // --- refraction --------------------------------------------------------
    const bed0 = linearDepth(tRefractionDepth.sample(suv)).div(cosA).toVar();
    const column0 = max(bed0.sub(dist), 0.0).mul(max(RD.y.negate(), 0.06)).toVar();

    const distort = uRefractDistort.mul(sat(column0.mul(0.7)))
      .div(float(1.0).add(dist.mul(0.045))).toVar();
    const ruv = clamp(suv.add(bend.mul(distort)), vec2(0.002), vec2(0.998)).toVar();
    const bed1 = linearDepth(tRefractionDepth.sample(ruv)).div(cosA).toVar();
    // If the offset sample sits in front of the surface it is something above the
    // water leaking in — fall back to the straight sample.
    const ok = step(dist, bed1).toVar();
    const fuv = mix(suv, ruv, ok).toVar();
    const bedDist = mix(bed0, bed1, ok).toVar();

    const refr = tRefraction.sample(fuv).rgb.toVar();
    const bedWorld = cameraPosition.add(RD.mul(bedDist)).toVar();
    const path = max(bedDist.sub(dist), 0.0).toVar();
    const column = max(vWorld.y.sub(bedWorld.y), 0.0).toVar();
    const hasBed = smoothstep(2200.0, 4200.0, bedDist).oneMinus().toVar();

    // --- caustics on the seabed, in world XZ -------------------------------
    const cuv = bedWorld.xz.mul(uCausticScale).toVar();
    const c1 = tCaustic.sample(cuv).rgb.toVar();
    const c2 = tCaustic.sample(causticRot(cuv).mul(0.61).add(vec2(0.37, 0.11))).rgb.toVar();
    // Caustics MODULATE the seabed, they do not add to it. Written as a gain
    // around 1.0: the bright filaments roughly double the sand, the gaps darken
    // it slightly, and the mean stays put. Adding an unbounded product instead
    // (which is the obvious way to write this) multiplies the reef by three or
    // four and the whole bay comes back as a sheet of white lace.
    const caus = c1.add(c2).mul(0.5).add(c1.mul(c2).mul(1.4)).toVar();
    const causFade = hasBed.mul(smoothstep(1.5, 13.0, column).oneMinus()).mul(sat(L.y.mul(2.4))).toVar();
    const causGain = caus.sub(0.42).mul(float(1.35).mul(uCaustic).mul(causFade)).add(1.0).toVar();
    refr.mulAssign(max(causGain, vec3(0.55)));
    refr.addAssign(max(caus.sub(0.55), vec3(0.0)).mul(uKeyColor).mul(float(0.10).mul(uCaustic).mul(causFade)));

    // --- the water column ---------------------------------------------------
    const trans = exp(uAbsorb.negate().mul(path.add(column.mul(0.65)))).toVar();
    const body = mix(mix(uShallow, uMid, smoothstep(0.15, 2.4, column)),
      uDeep, smoothstep(2.4, 14.0, column)).toVar();
    const inScatter = vec3(mix(body, uScatter, 0.28)).toVar();
    const col = vec3(refr.mul(trans).add(inScatter.mul(trans.oneMinus()))).toVar();

    // A body the size of the leviathan blocks the light coming up through the
    // column, so the water directly above it scatters less back at the camera.
    // Without this the animal is physically correct and dramatically useless:
    // twenty metres of water absorbs ninety per cent of its silhouette and ref/04
    // never happens. The test is deliberately narrow — it fires only where the
    // thing under the water is far darker than the water itself, which is true of
    // the creature and of nothing else in the bay. Sand and reef sit well above
    // the deep-water body colour and never trip it.
    const refrL = dot(refr, LUMA).toVar();
    const scatL = dot(inScatter, LUMA).toVar();
    const bodyDark = sat(refrL.div(max(scatL, 1e-4)).oneMinus()).toVar();
    const bodyOcc = smoothstep(0.42, 0.86, bodyDark).mul(hasBed)
      .mul(smoothstep(24.0, 46.0, column).oneMinus()).toVar();
    col.mulAssign(bodyOcc.mul(0.60).oneMinus());

    // --- reflection ---------------------------------------------------------
    const R0 = reflect(V.negate(), N).toVar();
    const R = vec3(R0.x, max(R0.y, 0.010), R0.z).toVar();
    const sky = vec3(skyAt(R)).toVar();
    // Reflections stretch vertically at grazing incidence; without the stretch a
    // mirrored island reads as a hard-edged decal lying on the water.
    const rd = uReflDistort.div(float(1.0).add(dist.mul(0.012))).toVar();
    const rv = clamp(suv.add(vec2(bend.x, bend.y.mul(1.8)).mul(rd)), vec2(0.002), vec2(0.998)).toVar();
    const refl = vec3(tReflection.sample(vec2(rv.x.oneMinus(), rv.y)).rgb).toVar();
    refl.assign(mix(sky, refl, uReflEnabled.mul(uReflStrength)));

    const F = fresnelSchlick(max(dot(N, V), 0.0), float(0.02)).toVar();
    col.assign(mix(col, refl, F));

    // --- back-lit crests: the jade glow inside a wave ----------------------
    const wrap = sat(dot(V, L.negate()).mul(0.6).add(0.4)).toVar();
    const sss = pow(wrap, 3.0).mul(sat(vCrest.mul(2.6))).mul(sat(N.y.mul(0.4).oneMinus())).toVar();
    col.addAssign(uScatter.mul(sss.mul(uScatterStrength).mul(float(0.5).add(uKeyIntensity.mul(0.7)))));

    // --- foam ---------------------------------------------------------------
    // Shore foam asks the SEABED how deep it is here, not the refraction buffer.
    // The refraction pass contains the boat's own submerged hull, so a column
    // reconstructed from it reads a few centimetres deep right around the
    // waterline and every hull in the bay wore a white foam blob.
    const colEff = vBedDepth.sub(vCrest.mul(0.8)).toVar();
    const shore = smoothstep(0.0, uShoreFoamDepth, colEff).oneMinus().toVar();
    shore.assign(smoothstep(0.42, 0.88, shore.mul(1.2).sub(breakup.mul(0.5)).add(0.14)));
    // The bright line right at the waterline. Narrow — it is an edge, not a band.
    shore.addAssign(exp(abs(colEff.sub(0.06)).mul(-16.0)).mul(0.42));
    shore.mulAssign(hasBed);

    // The Jacobian of this (gentle, sheltered-bay) train only dips to about 0.87,
    // so the threshold has to sit inside that range or crest foam never fires —
    // but sitting too low fires it across the whole bay and the water turns to
    // milk. Only the sharpest few per cent of crests get foam.
    const crest = smoothstep(0.905, 0.975, vJac).oneMinus().toVar();
    crest.assign(smoothstep(0.38, 0.92, crest.mul(1.15).sub(breakup.mul(0.55)).add(0.16)).mul(0.75));

    // Churn is the persistent trail, arms are the current V. Both are cut into
    // curls by the world-space noise rather than filled — the art has a lace of
    // fine white loops behind the transom, never a solid streak.
    const lace = float(0.40).add(breakup.mul(1.25)).toVar();
    const churn = wC.b.mul(uWakeFoam).mul(wmask).toVar();
    const arms = wC.a.mul(uWakeArmFoam).mul(wmask).toVar();
    const wake = smoothstep(0.32, 1.10, churn.mul(lace)).mul(0.9)
      .add(smoothstep(0.26, 0.80, arms.mul(lace))).toVar();

    const foam = sat(sat(shore).add(crest).add(sat(wake))).toVar();
    // Texture inside the foam, so a splash reads as churned water and not a plate.
    col.assign(mix(col, foamCol.mul(float(0.70).add(breakup.mul(0.58))), foam));

    // --- the light path -----------------------------------------------------
    const H = normalize(V.add(L)).toVar();
    const ndh = max(dot(N, H), 1e-5).toVar();
    const shin = min(float(2.0).div(max(rough.mul(rough), 1e-4)).sub(2.0), 2048.0).toVar();
    const core = pow(ndh, shin).mul(shin.add(2.0)).mul(0.02).toVar();
    const broad = pow(ndh, 28.0).toVar();
    const sheen = pow(ndh, 9.0).toVar();

    // Sparkles hold still in world space and twinkle as the wave passes under
    // them. Cubing the phase keeps most cells dark most of the time, which is
    // what makes a path read as a scatter of points rather than a wash.
    const gp = vFlat.div(max(uGlitterSize, 0.05)).toVar();
    const cell = worley(gp.mul(2.2).add(vec2(uTime.mul(0.021), uTime.mul(-0.017)))).toVar();
    const tw = sin(uTime.mul(float(2.6).add(cell.z.mul(11.0))).add(cell.z.mul(57.0)))
      .mul(0.5).add(0.5).toVar();
    const sparkle = pow(smoothstep(0.0, 0.20, cell.x).oneMinus(), 7.0).mul(tw).mul(tw).mul(tw).toVar();
    sparkle.mulAssign(smoothstep(140.0, 620.0, dist).oneMinus());

    const keyUp = sat(L.y.mul(8.0)).toVar();
    const grazing = mix(float(0.35), float(1.0), F).toVar();
    // Trimmed hard from where this started. The glitter has to survive being
    // pushed above 1.0 for the bloom, but at grazing angles the far half of the
    // bay is all glitter and it burns out into a white sheet.
    const spec = vec3(
      uKeyColor.mul(core.mul(uSpecular).mul(0.20))
        .add(uGlitterColor.mul(
          broad.mul(float(0.12).add(sparkle.mul(3.1))).add(sheen.mul(0.035)).mul(uGlitter),
        )),
    ).toVar();
    spec.mulAssign(uKeyIntensity.mul(keyUp).mul(grazing).mul(foam.mul(0.3).oneMinus()));

    // --- horizon ------------------------------------------------------------
    const fog = sat(dist.sub(uFogNear).div(max(uFogFar.sub(uFogNear), 1.0))).toVar();
    fog.assign(fog.mul(fog).mul(float(3.0).sub(fog.mul(2.0))));
    col.assign(mix(col, mix(uFogColor, uSkyHorizon, 0.42), fog));
    col.addAssign(spec.mul(fog.mul(0.55).oneMinus()));

    return vec4(max(select(frontFacing, col, under), vec3(0.0)), 1.0);
  });

  const material = new THREE.NodeMaterial();
  material.vertexNode = vertexNode();
  material.fragmentNode = fragmentNode();
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.fog = false;
  material.lights = false;
  material.name = 'SaltyFinWater';

  return {
    material,
    uniforms,
    detailTexture: detail,
    dispose() {
      material.dispose();
      detail.dispose();
      for (const t of placeholders) t.dispose();
    },
  };
}

export { buildDetailTexture };
