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
  // Same predicate surface.js uses to size the wake sim — a geometry budget, not
  // a tier name, so an unlisted tier cannot fall through into the rich branch.
  const lean = (quality?.geometry ?? 1) < 0.6;
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
  // Central differences of the wake field are raw texel-to-texel deltas, and a
  // texel is 0.5 m at high/med and 1.0 m at low/mobile (surface.js:153). Divide
  // by the span so every gain below is "per metre" and reads the same on a
  // phone as on a desktop; without it the low tier got twice the slope and twice
  // the foam-rim gain for free.
  const uWakeGrad = uniform(1 / (2 * (wakeWorld / wakeSize)));
  // 5.5 and 1.6 on the RAW delta was a 79 degree surface tilt at the worst
  // measured point, with 20% of the wake footprint past 45 degrees — for scale
  // the whole six-wave Gerstner train contributes 0.14 of tangent and the three
  // detail layers at most 0.38. That is where the mirrored tan/blue plates and
  // the onion-ring contours around the boat came from: the reflection and
  // refraction lookups were being thrown a fifth of the screen sideways. These
  // land the wake's peak added slope near 1.0, still ~2.5x the detail layers.
  // The ripple channel's tilt, and the ceiling it saturates against. Scaling
  // this down was how the mirrored tan/blue plates behind the boat were killed,
  // but the R channel is also where water.disturb() writes — a breaching
  // leviathan, a jumping fish, the quest's churned patch — so a flat 16x cut
  // silenced all of those to fix an artefact only the boat produced. A soft
  // limit does both jobs: a distant low-amplitude ring keeps the full gain, and
  // the boat's own near-field, which is an order of magnitude steeper, folds
  // over into the ceiling instead of turning the surface into onion rings.
  const uWakeSlope = uniform(2.4);
  const uWakeSlopeMax = uniform(0.16);
  const uWakeArmSlope = uniform(0.12);
  // Gains on the two foam LOCATORS below — |grad B| for the trail rims and the
  // compressed A for the Kelvin arms. Not the same quantities the old 1.25/0.32
  // multiplied, so the numbers are not comparable to the ones they replace.
  const uWakeFoam = uniform(0.85);
  const uWakeArmFoam = uniform(0.70);
  // Erosion depth, coarse threshold wander, and the threshold itself. Coverage
  // is the thing to retune here, never brightness: the paintings have no grey
  // foam anywhere, only fewer and shorter white strokes.
  // Reinhard knees. Smaller = the foam holds its brightness further astern.
  const uWakeSoft = uniform(1.80);
  const uWakeArmSoft = uniform(0.85);
  // How much of the foam's alpha the churn texture is allowed to take away. At
  // 1.0 the noise reaches zero and the trail breaks into filaments again, which
  // is the thing this is not.
  const uWakeMottle = uniform(0.70);
  // The breaking crest along the arm's outer edge, and how fine the churn is.
  const uWakeRim = uniform(0.55);
  const uWakeChurnScale = uniform(1.60);
  // How opaque the wake foam is allowed to get. foamCol lands near 2.25 in
  // linear at the day preset, so a fully opaque strand reads as 96% sRGB after
  // the tonemap and feeds the bloom; measured on ref/01 the foam's p99 is 75%
  // and its p99.9 is 85%, and solving mix(water, target, a) per channel against
  // the painting gives alpha 0.35 at the strand edges and 0.72-0.96 at the very
  // hottest cores — the water colour reads through everywhere. This caps the
  // wake alone rather than trimming foamCol, which shore and crest foam share
  // and which is tuned where it is for them.
  const uWakeBright = uniform(0.62);

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
    uWakeCenter, uWakeWorld, uWakeTexel, uWakeGrad, uWakeSlope, uWakeSlopeMax, uWakeArmSlope,
    uWakeFoam, uWakeArmFoam, uWakeSoft, uWakeArmSoft, uWakeMottle, uWakeBright,
    uWakeRim, uWakeChurnScale,
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
    // Per-metre, so the low tier's 1 m texels do not silently double the tilt.
    const wgrad = uWakeGrad.mul(wmask).toVar();
    // Soft limit, not a clamp: g / (1 + |g| / max) is smooth everywhere, so a
    // ripple that grows past the ceiling flattens instead of developing a hard
    // rim where it crosses it.
    const rip = vec2(wR.r.sub(wL.r), wU.r.sub(wD.r)).mul(uWakeSlope.mul(wgrad)).toVar();
    ng.addAssign(rip.div(length(rip).div(uWakeSlopeMax).add(1.0)));
    ng.addAssign(vec2(wR.a.sub(wL.a), wU.a.sub(wD.a)).mul(uWakeArmSlope.mul(wgrad)));

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
    // Seen from below, the wake is a bright ceiling patch and nothing more — so
    // it takes the channel VALUES with their own constants. It deliberately does
    // not share uWakeFoam/uWakeArmFoam any more: those now scale a gradient and
    // a compressed ridge, and reusing them here silently gave the underside a
    // different wake shape than the top surface every time the top was retuned.
    const wf = sat(wC.b.mul(0.80).add(wC.a.mul(0.60))).mul(wmask).toVar();
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

    // --- the wake -----------------------------------------------------------
    // The wake field is a WHERE and never a WHAT. It is 0.5 m per texel on
    // desktop and 1.0 m on mobile, and the foam flakes measured in ref/01 are
    // 10-15 cm across with 10-20 cm of clear water between them — so the field
    // can carry the envelope and the filament has to be cut out of it with
    // world-space noise. Locate, erode, threshold. Never multiply.
    //
    // What this replaces, and what it looked like:
    //   smoothstep(0.32, 1.10, B*1.25*lace)*0.9 + smoothstep(0.26, 0.80, A*0.32*lace)
    // Read back off the GPU, B reaches 1.43 near the transom, so the first term
    // ran 2-3x past the top of its own smoothstep for the first ~25 m of trail.
    // A gain cannot break a plateau: the noise it was multiplied by had nothing
    // to bite on and the trail rendered as one flat 205-237 luma lozenge welded
    // to the transom, 46% of the region behind the boat painted white where the
    // paintings paint 7%. The second term's LOWER edge, 0.26, sat above A*0.32
    // everywhere except the arm vertex where A peaks at 1.05 — the Kelvin V was
    // rebuilt correctly by wake.js every single frame and then thresholded to
    // nothing. Zeroing uWakeFoam and leaving the arms on left no white on screen
    // at all. The two terms were mistuned in opposite directions by about 3x.
    // Shore foam twenty lines up already does it the right way round (subtract
    // the noise, then threshold) and that is the vocabulary borrowed here.

    // Foam from the field's VALUE, softened, textured, never cut.
    //
    // The version this replaces located foam by the GRADIENT of the churn
    // channel and then cut it with the ridged contour of a noise octave. On
    // paper that gives thin meandering filaments like the ones in ref/01. On a
    // phone it gives white squiggles scattered across the bay that read as
    // scribbles rather than water, and — because a plateau has no gradient —
    // nothing at all touching the hull, which is the one place a wake must
    // never be missing. Two lessons in it. A contour is a curve of zero width,
    // so its on-screen thickness is set by the field's slope rather than by
    // anything chosen, and it thins to single aliased pixels wherever the field
    // is flat. And subtracting a cut before a narrow threshold lets the CUT
    // decide where foam is, so noise alone can put a strand in open water.
    //
    // So: value, not gradient — the churn is stamped at the hull, so its value
    // is high exactly where the foam has to start. Reinhard rather than a
    // threshold, because B reaches 1.43 near the transom and 0.15 at the tail
    // and no single band spans 10:1 without either flooding or vanishing.
    // And the noise MULTIPLIES the result instead of being subtracted from it,
    // which is the whole difference: multiplied, it can only ever mottle foam
    // that the wake put there, so open water stays open.
    const wakeBody = wC.b.div(wC.b.add(uWakeSoft)).toVar();
    const armv = wC.a.div(wC.a.add(uWakeArmSoft)).toVar();
    // The lower edge sits above where the bilinear halo of overlapping stamp
    // tails lands (B and A both sit around 0.02-0.05 out there); below it that
    // halo comes back as a faint triangle of haze behind the boat.
    const bodyF = smoothstep(0.12, 0.55, wakeBody).mul(uWakeFoam).toVar();
    const armF = smoothstep(0.15, 0.60, armv).mul(uWakeArmFoam).toVar();
    // A brighter rim along the outside of each arm. A wake's crest is where the
    // water is actually breaking, and without it the arms read as two smooth
    // painted ribbons — correct in shape, dead in the water. Taking the band
    // between two smoothsteps costs nothing and needs no derivative, which
    // matters because a derivative of this field is what produced filaments.
    const armEdge = smoothstep(0.26, 0.52, armv)
      .mul(smoothstep(0.52, 0.86, armv).oneMinus()).toVar();
    const wake = max(bodyF, armF).add(armEdge.mul(uWakeRim)).mul(wmask).toVar();

    // Mottle it. Two scales, because one gives an obvious repeating pattern at
    // the size of its own tile: the coarse one breaks the trail into patches
    // the size of the boat, the fine one gives the surface its churn. Kept well
    // above zero — this is texture inside foam, not holes punched through it,
    // and anything that reaches zero starts reading as filaments again.
    const churn = lean
      ? d0.b.toVar()
      : mix(d0.b, tDetail.sample(vFlat.mul(uWakeChurnScale)).b, 0.6).toVar();
    wake.mulAssign(churn.mul(uWakeMottle).add(float(1.0).sub(uWakeMottle)));

    // Fade with distance. Even softened, foam held at full contrast to the
    // horizon aliases into bright dots that post's chromatic aberration paints
    // magenta and green — the glitter above fades for the same reason.
    wake.mulAssign(smoothstep(90.0, 340.0, dist).oneMinus());

    const foam = sat(sat(shore).add(crest).add(sat(wake).mul(uWakeBright))).toVar();
    // Texture inside the foam, so a splash reads as churned water and not a
    // plate. Capped below 1: solving mix(water, target, a) against ref/01 gives
    // a = 0.35 at the strand edges and 0.72-0.96 at the hottest cores, so the
    // water colour reads through everywhere — foam is never fully opaque.
    col.assign(mix(col, foamCol.mul(float(0.70).add(breakup.mul(0.58))), foam.mul(0.92)));

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
    // The water immediately around a wake is visibly rougher than open water in
    // every painting — fine bright filigree that never crosses the foam
    // threshold. `field` is the wake locator already sitting in a register, so
    // buying that is one multiply-add and no new mechanism. Kept small: at 0.9
    // the glitter — which the old blob used to suppress and which now runs right
    // up to the foam edge — took the whole wedge over and the wake read as a fan
    // of sparks rather than as foam.
    sparkle.mulAssign(wake.mul(0.35).add(1.0));

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
