// The sky dome.
//
// One BackSide sphere at 4.5 km, centred on the camera's x/z (y stays on the
// water plane so the beauty camera and the mirrored reflection camera agree on
// where the horizon is). Everything in it is driven off `env`:
//
//   gradient   skyZenith -> skyMid -> skyHorizon, with two power curves so the
//              middle stays smooth and the last few degrees above the horizon
//              tighten up. A linear mix bands badly and puts the sunset's hot
//              band in the wrong place.
//   halo       exponential angular falloff around the key body (sunHalo,
//              sunHaloSize), plus a much wider, weaker horizonGlow lobe that
//              hugs the horizon on the sun's side — that is what wraps ref/02's
//              orange around the whole frame.
//   haze       fogColor lifted into the bottom of the dome by hazeStrength.
//   stars      two procedural hash-grid layers plus a Milky Way band, faded by
//              starOpacity / milkyWayOpacity and washed out by the haze.
//
// The lower hemisphere renders a mirrored, heavily hazed copy of the gradient.
// It is normally hidden behind the water, but if the water mesh ever stops
// short of the horizon the failure mode is a band of sea haze rather than a
// hole.
//
// Ported from GLSL to TSL. The shader is a single NodeMaterial.fragmentNode; the
// old `varying vec3 vDir` is `varying(positionLocal)`, which is the same thing
// the vertex stage used to write by hand. The dynamic-uniform `if` guards around
// the star field survive as TSL `If`, so a daytime sky still skips the whole
// star/Milky Way block rather than multiplying it out by zero.

import * as THREE from 'three';
import {
  Fn, uniform, varying, positionLocal, screenCoordinate,
  vec2, vec3, vec4, float,
  max, clamp, mix, pow, dot, step, smoothstep, fract, floor, sin,
  abs, exp, sqrt, normalize, length, acos, If,
} from 'three/tsl';
import { makeRng } from '../core/rng.js';
import { LAYER, setLayers } from '../core/layers.js';

// ---------------------------------------------------------------------------
// Shared TSL noise, node for node from core/glsl.js.
//
// core/glsl.js is still the WebGL build's copy and stays exactly where it is;
// these are the same functions with the same magic constants, expressed as node
// graphs. The constants matter: change one and the star lattice moves, the
// Milky Way lands somewhere else and every cloud in the sky is a different
// cloud. sky.js owns them because it is the biggest consumer; clouds.js and
// celestial.js import what they need from here.
//
// Only the helpers the sky actually uses are ported — gradient noise, worley and
// the eight-octave masked fbm from glsl.js have no caller up here.
// ---------------------------------------------------------------------------

/** hash12 — vec2 -> float. */
export const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

/** hash22 — vec2 -> vec2. */
export const hash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

/** hash13 — vec3 -> float. */
export const hash13 = Fn(([p0]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.addAssign(dot(p, p.zyx.add(31.32)));
  return fract(p.x.add(p.y).mul(p.z));
});

/** Value noise, 2D. Cheap, smooth, the workhorse. */
export const vnoise = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(float(3).sub(f.mul(2))).toVar();
  return mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), u.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

/** Value noise, 3D. */
export const vnoise3 = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(float(3).sub(f.mul(2))).toVar();
  const n000 = hash13(i);
  const n100 = hash13(i.add(vec3(1, 0, 0)));
  const n010 = hash13(i.add(vec3(0, 1, 0)));
  const n110 = hash13(i.add(vec3(1, 1, 0)));
  const n001 = hash13(i.add(vec3(0, 0, 1)));
  const n101 = hash13(i.add(vec3(1, 0, 1)));
  const n011 = hash13(i.add(vec3(0, 1, 1)));
  const n111 = hash13(i.add(vec3(1, 1, 1)));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z,
  );
});

/** The FBM_ROT / CROT / MROT rotation, mat2(0.80,-0.60,0.60,0.80), applied. */
export const rot2c = (p) => vec2(
  p.x.mul(0.80).add(p.y.mul(0.60)),
  p.x.mul(-0.60).add(p.y.mul(0.80)),
);

/**
 * Value fbm over the rotated lattice. The octave count is a build-time number
 * on both sides — GLSL had to mask a constant-bound loop for ESSL 1.00, here we
 * are generating the graph in JavaScript so it just unrolls.
 */
export const fbmValue2 = (p0, oct, lacunarity = 2.07) => {
  const p = p0.toVar();
  const s = float(0).toVar();
  let n = 0, a = 0.5;
  for (let i = 0; i < oct; i++) {
    s.addAssign(vnoise(p).mul(a));
    n += a; a *= 0.5;
    p.assign(rot2c(p).mul(lacunarity));
  }
  return s.div(Math.max(n, 1e-4));
};

/** Value fbm in 3D, `p = p*lacunarity + offset` between octaves. */
export const fbmValue3 = (p0, oct, lacunarity = 2.11, offset = 17.3) => {
  const p = p0.toVar();
  const s = float(0).toVar();
  let n = 0, a = 0.5;
  for (let i = 0; i < oct; i++) {
    s.addAssign(vnoise3(p).mul(a));
    n += a; a *= 0.5;
    p.assign(p.mul(lacunarity).add(offset));
  }
  return s.div(Math.max(n, 1e-4));
};

/** Interleaved gradient noise — the good cheap dither. */
export const ign = Fn(([p]) => fract(
  float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715)))),
));

// ---------------------------------------------------------------------------

const RADIUS = 4500;

// A jittered point per lattice cell on a shell of the given resolution. Small,
// varied in size and brightness, faintly warm or cool, gently twinkling.
const starLayer = Fn(([d, cell, density, radius, gain, t, seed]) => {
  const p = d.mul(cell).add(seed).toVar();
  const i = floor(p).toVar();
  const f = p.sub(i).sub(0.5).toVar();
  const sel = hash13(i.add(0.5)).toVar();
  const keep = step(float(1).sub(density), sel).toVar();
  const off = vec3(
    hash13(i.add(3.17)),
    hash13(i.add(7.41)),
    hash13(i.add(11.93)),
  ).sub(0.5).toVar();
  const dist = length(f.sub(off.mul(0.62))).toVar();
  const mag = hash13(i.add(19.71)).toVar();
  const rr = radius.mul(mag.mul(mag).mul(0.75).add(0.55)).toVar();
  const s = smoothstep(float(0), rr, dist).oneMinus().toVar();
  s.assign(s.mul(s));
  const tw = sin(t.mul(mag.mul(2.4).add(0.8)).add(mag.mul(41.0))).mul(0.44).add(0.72).toVar();
  const hue = hash13(i.add(27.33)).toVar();
  const tint = mix(vec3(0.74, 0.83, 1.00), vec3(1.00, 0.90, 0.74), hue.mul(hue)).toVar();
  return tint.mul(s.mul(keep).mul(tw).mul(gain).mul(mag.mul(mag).mul(1.45).add(0.12)));
});

/** Blend of the moon and the sun: whichever actually owns the glow right now. */
function lightDirInto(env, out) {
  const w = THREE.MathUtils.smoothstep(env.sunDir.y, -0.30, -0.02);
  out.copy(env.moonDir).lerp(env.sunDir, w);
  if (out.lengthSq() < 1e-6) out.copy(env.keyDir);
  return out.normalize();
}

const _keyDir = new THREE.Vector3();

export function createSky(opts = {}) {
  const quality = opts.quality ?? {};
  const steps = quality.cloudSteps ?? 24;
  // The Milky Way only needs a handful of octaves; the full eight would be
  // spent on grain nobody can see.
  const mwOct = steps >= 20 ? 3 : 2;

  // The only randomness in the sky: where the star lattice starts and which way
  // the Milky Way crosses the dome. Seeded, so a given seed is a given sky.
  const rng = makeRng((opts.seed ?? 1) ^ 0x5c1f5c1f);
  const starSeed = new THREE.Vector3(rng.range(0, 97), rng.range(0, 97), rng.range(0, 97));
  const mwAxis = new THREE.Vector3(
    rng.range(0.30, 0.62) * rng.sign(),
    rng.range(0.26, 0.46),
    rng.range(0.60, 0.88) * rng.sign(),
  ).normalize();

  const uZenith = uniform(new THREE.Vector3(0.05, 0.20, 0.60));
  const uMid = uniform(new THREE.Vector3(0.20, 0.45, 0.80));
  const uHorizon = uniform(new THREE.Vector3(0.70, 0.86, 0.95));
  const uHalo = uniform(new THREE.Vector3(1, 1, 1));
  const uFog = uniform(new THREE.Vector3(0.65, 0.82, 0.92));
  const uKeyDir = uniform(new THREE.Vector3(0, 1, 0));
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uHaloSize = uniform(0.1);
  const uHaloAmt = uniform(1);
  const uHorizonGlow = uniform(0.5);
  const uKeyLow = uniform(1);
  const uHaze = uniform(0.35);
  const uStars = uniform(0);
  const uMilky = uniform(0);
  const uTime = uniform(0);
  const uStarSeed = uniform(starSeed);
  const uMwAxis = uniform(mwAxis);

  const vDir = varying(positionLocal, 'vDir');

  const mat = new THREE.NodeMaterial();
  mat.side = THREE.BackSide;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.transparent = false;
  mat.fog = false;

  mat.fragmentNode = Fn(() => {
    const d = normalize(vDir).toVar();
    const y = d.y.toVar();
    const ay = abs(y).toVar();
    const below = clamp(y.mul(-5.0), 0, 1).toVar();

    // --- gradient ----------------------------------------------------------
    // Two falloffs: a broad one that carries zenith into mid, and a tight one
    // that slams the horizon colour into the last few degrees.
    // The zenith has to hold most of the way down. At an exponent near 1 the mid
    // tone takes over within ten degrees of the top and the whole sky above the
    // horizon reads as pale wash — which is what a gameplay camera, pointed
    // almost level, spends all its time looking at.
    const wMid = pow(max(float(1).sub(ay), 0.0), 2.7).toVar();
    const wHor = pow(max(float(1).sub(ay), 0.0), 15.0).toVar();
    const col = mix(uZenith, uMid, wMid).toVar();
    col.assign(mix(col, uHorizon, wHor));

    // --- haze --------------------------------------------------------------
    const hz = uHaze.mul(exp(max(y, 0.0).mul(-6.5))).toVar();
    hz.assign(max(hz, below.mul(uHaze.mul(0.50).add(0.42))));
    hz.assign(clamp(hz.mul(0.88), 0, 1));
    col.assign(mix(col, uFog, hz));

    // --- key-body halo -----------------------------------------------------
    // A tight core plus a much wider, weaker skirt. sunHaloSize runs 0.06 at noon
    // to 0.30 at night, so the same pair of exponentials gives a hard little
    // flare around the midday sun and a broad soft bloom around the moon.
    const ang = acos(clamp(dot(d, uKeyDir), -1.0, 1.0)).toVar();
    const hs = max(uHaloSize, 0.02).toVar();
    const halo = exp(ang.div(hs.mul(0.30)).negate()).mul(1.15)
      .add(exp(ang.div(hs.mul(0.95)).negate()).mul(0.20)).toVar();

    // --- horizon glow on the sun's side ------------------------------------
    // Wide, weak, hugging the horizon. This is the term that wraps ref/02's
    // orange most of the way around the frame.
    const sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z).add(vec3(1e-5, 0.0, 0.0))).toVar();
    const dH = normalize(vec3(d.x, 0.0, d.z).add(vec3(1e-5, 0.0, 0.0))).toVar();
    const az = clamp(dot(dH, sunH).mul(0.5).add(0.5), 0, 1).toVar();
    const lift = exp(max(y, 0.0).mul(-2.6)).toVar();
    const glow = pow(uHorizonGlow, 1.4).mul(az).mul(az).mul(lift).mul(uKeyLow).toVar();

    // Blend toward the halo colour rather than adding it. Adding drives most of
    // the frame past post's bloom threshold and the sky comes back as pale wash;
    // screening lifts the weak channels and desaturates. Mixing keeps sunHalo's
    // saturation and only goes over 1.0 in the small core, which is exactly what
    // should bloom.
    const fl = clamp(halo.mul(0.42).mul(uHaloAmt).add(glow.mul(0.60)), 0, 1).toVar();
    col.assign(mix(col, uHalo.mul(fl.mul(0.85).add(0.85)), fl));

    // --- stars -------------------------------------------------------------
    // After the flare so a bright star keeps its HDR headroom, but washed out
    // near the moon by that same flare.
    If(uStars.greaterThan(0.002).or(uMilky.greaterThan(0.002)), () => {
      const vis = clamp(y.mul(7.0), 0, 1)
        .mul(hz.oneMinus())
        .mul(clamp(fl.mul(2.2), 0, 1).oneMinus()).toVar();
      If(vis.greaterThan(0.001), () => {
        const s = vec3(0.0).toVar();
        If(uMilky.greaterThan(0.002), () => {
          // Narrow, faint and grainy. A wide bright band reads as fog, not sky.
          const band = smoothstep(0.015, 0.22, abs(dot(d, uMwAxis))).oneMinus().toVar();
          const n = fbmValue3(d.mul(9.0).add(9.0), mwOct).toVar();
          const lanes = fbmValue3(d.mul(21.0).sub(3.0), mwOct).toVar();
          const mw = band
            .mul(n.mul(1.10).add(0.25))
            .mul(smoothstep(0.30, 0.68, lanes).mul(0.90).add(0.35)).toVar();
          s.addAssign(
            mix(vec3(0.62, 0.70, 1.00), vec3(1.00, 0.94, 0.86), 0.35)
              .mul(mw).mul(0.018).mul(uMilky),
          );
          // The band is where the sky actually gets grainy with faint stars.
          s.addAssign(starLayer(d, 300.0, 0.070, 0.32, 0.75, uTime, uStarSeed).mul(band).mul(uMilky));
        });
        If(uStars.greaterThan(0.002), () => {
          s.addAssign(starLayer(d, 210.0, 0.030, 0.38, 1.05, uTime, uStarSeed).mul(uStars));
          s.addAssign(starLayer(d, 96.0, 0.020, 0.44, 2.00, uTime.mul(0.77), uStarSeed).mul(uStars));
        });
        col.addAssign(s.mul(vis));
      });
    });

    // A gradient this smooth over 1400 px bands without help. Scale the dither
    // with sqrt(colour) so it stays near one output LSB across the whole range
    // instead of shredding the near-black night zenith.
    col.addAssign(
      ign(screenCoordinate.xy).sub(0.5).mul(1.5 / 255.0).mul(sqrt(max(col, vec3(0.0)))),
    );

    return vec4(max(col, vec3(0.0)), 1.0);
  })();

  const geo = new THREE.SphereGeometry(RADIUS, 64, 40);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  const group = new THREE.Group();
  group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);

  return {
    group,

    applyEnv(env) {
      uZenith.value.set(env.skyZenith.r, env.skyZenith.g, env.skyZenith.b);
      uMid.value.set(env.skyMid.r, env.skyMid.g, env.skyMid.b);
      uHorizon.value.set(env.skyHorizon.r, env.skyHorizon.g, env.skyHorizon.b);
      uHalo.value.set(env.sunHalo.r, env.sunHalo.g, env.sunHalo.b);
      uFog.value.set(env.fogColor.r, env.fogColor.g, env.fogColor.b);
      uHaloSize.value = env.sunHaloSize;
      uHorizonGlow.value = env.horizonGlow;
      uHaze.value = env.hazeStrength;
      uStars.value = env.starOpacity;
      uMilky.value = env.milkyWayOpacity;
      uSunDir.value.copy(env.sunDir);

      lightDirInto(env, _keyDir);
      uKeyDir.value.copy(_keyDir);
      uHaloAmt.value = THREE.MathUtils.clamp((_keyDir.y + 0.14) / 0.20, 0, 1);
      // How low the key light is, not whether it has set: the horizon wrap is a
      // long-path-through-the-atmosphere effect, so it belongs to a sun near the
      // horizon and should be almost gone at noon. Written the other way round
      // this read 1.0 at midday and bleached the whole horizon band white.
      uKeyLow.value = 0.15 + 0.85 * (1.0 - THREE.MathUtils.smoothstep(env.sunDir.y, 0.0, 0.42));
    },

    update(ctx) {
      uTime.value = ctx.time;
      const c = ctx.camera.position;
      group.position.set(c.x, 0, c.z);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
