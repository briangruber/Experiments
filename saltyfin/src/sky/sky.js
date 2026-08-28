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

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';
import { makeRng } from '../core/rng.js';
import { LAYER, setLayers } from '../core/layers.js';

const RADIUS = 4500;

const VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function buildFragment(quality) {
  const steps = quality?.cloudSteps ?? 24;
  const mwOct = steps >= 20 ? 3 : 2;

  return /* glsl */`
varying vec3 vDir;

uniform vec3  uZenith;
uniform vec3  uMid;
uniform vec3  uHorizon;
uniform vec3  uHalo;
uniform vec3  uFog;
uniform vec3  uKeyDir;
uniform vec3  uSunDir;
uniform float uHaloSize;
uniform float uHaloAmt;
uniform float uHorizonGlow;
uniform float uKeyLow;
uniform float uHaze;
uniform float uStars;
uniform float uMilky;
uniform float uTime;
uniform vec3  uStarSeed;
uniform vec3  uMwAxis;

${GLSL.constants}
${GLSL.util}
${GLSL.hash}
${GLSL.noise}

#define MW_OCT ${mwOct}

// Small dedicated fbm3 — GLSL.fbm always spins its full eight iterations, and
// the Milky Way only needs a handful.
float mwFbm(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<MW_OCT;i++){ s += a*vnoise3(p); n += a; a *= 0.5; p = p*2.11 + 17.3; }
  return s/max(n, 1e-4);
}

// A jittered point per lattice cell on a shell of the given resolution. Small,
// varied in size and brightness, faintly warm or cool, gently twinkling.
vec3 starLayer(vec3 d, float cell, float density, float radius, float gain, float t){
  vec3 p = d * cell + uStarSeed;
  vec3 i = floor(p);
  vec3 f = p - i - 0.5;
  float sel = hash13(i + 0.5);
  float keep = step(1.0 - density, sel);
  vec3 off = vec3(hash13(i + 3.17), hash13(i + 7.41), hash13(i + 11.93)) - 0.5;
  float dist = length(f - off * 0.62);
  float mag = hash13(i + 19.71);
  float rr = radius * (0.55 + 0.75 * mag * mag);
  float s = 1.0 - smoothstep(0.0, rr, dist);
  s *= s;
  float tw = 0.72 + 0.44 * sin(t * (0.8 + 2.4 * mag) + mag * 41.0);
  float hue = hash13(i + 27.33);
  vec3 tint = mix(vec3(0.74, 0.83, 1.00), vec3(1.00, 0.90, 0.74), hue*hue);
  return tint * (s * keep * tw * gain * (0.12 + mag * mag * 1.45));
}

void main(){
  vec3 d = normalize(vDir);
  float y = d.y;
  float ay = abs(y);
  float below = sat(-y * 5.0);

  // --- gradient ------------------------------------------------------------
  // Two falloffs: a broad one that carries zenith into mid, and a tight one
  // that slams the horizon colour into the last few degrees.
  // The zenith has to hold most of the way down. At an exponent near 1 the mid
  // tone takes over within ten degrees of the top and the whole sky above the
  // horizon reads as pale wash — which is what a gameplay camera, pointed
  // almost level, spends all its time looking at.
  float wMid = pow(max(1.0 - ay, 0.0), 2.7);
  float wHor = pow(max(1.0 - ay, 0.0), 15.0);
  vec3 col = mix(uZenith, uMid, wMid);
  col = mix(col, uHorizon, wHor);

  // --- haze ----------------------------------------------------------------
  float hz = uHaze * exp(-max(y, 0.0) * 6.5);
  hz = max(hz, below * (0.42 + 0.50 * uHaze));
  hz = sat(hz * 0.88);
  col = mix(col, uFog, hz);

  // --- key-body halo -------------------------------------------------------
  // A tight core plus a much wider, weaker skirt. sunHaloSize runs 0.06 at noon
  // to 0.30 at night, so the same pair of exponentials gives a hard little
  // flare around the midday sun and a broad soft bloom around the moon.
  float ang = acos(clamp(dot(d, uKeyDir), -1.0, 1.0));
  float hs = max(uHaloSize, 0.02);
  float halo = exp(-ang / (hs * 0.30)) * 1.15 + exp(-ang / (hs * 0.95)) * 0.20;

  // --- horizon glow on the sun's side --------------------------------------
  // Wide, weak, hugging the horizon. This is the term that wraps ref/02's
  // orange most of the way around the frame.
  vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5, 0.0, 0.0));
  vec3 dH   = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5, 0.0, 0.0));
  float az = sat(dot(dH, sunH) * 0.5 + 0.5);
  float lift = exp(-max(y, 0.0) * 2.6);
  float glow = pow(uHorizonGlow, 1.4) * az * az * lift * uKeyLow;

  // Blend toward the halo colour rather than adding it. Adding drives most of
  // the frame past post's bloom threshold and the sky comes back as pale wash;
  // screening lifts the weak channels and desaturates. Mixing keeps sunHalo's
  // saturation and only goes over 1.0 in the small core, which is exactly what
  // should bloom.
  float fl = sat(halo * 0.42 * uHaloAmt + glow * 0.60);
  col = mix(col, uHalo * (0.85 + 0.85 * fl), fl);

  // --- stars ---------------------------------------------------------------
  // After the flare so a bright star keeps its HDR headroom, but washed out
  // near the moon by that same flare.
  if (uStars > 0.002 || uMilky > 0.002) {
    float vis = sat(y * 7.0) * (1.0 - hz) * (1.0 - sat(fl * 2.2));
    if (vis > 0.001) {
      vec3 s = vec3(0.0);
      if (uMilky > 0.002) {
        // Narrow, faint and grainy. A wide bright band reads as fog, not sky.
        float band = 1.0 - smoothstep(0.015, 0.22, abs(dot(d, uMwAxis)));
        float n = mwFbm(d * 9.0 + 9.0);
        float lanes = mwFbm(d * 21.0 - 3.0);
        float mw = band * (0.25 + 1.10 * n) * (0.35 + 0.90 * smoothstep(0.30, 0.68, lanes));
        s += mix(vec3(0.62, 0.70, 1.00), vec3(1.00, 0.94, 0.86), 0.35) * mw * 0.018 * uMilky;
        // The band is where the sky actually gets grainy with faint stars.
        s += starLayer(d, 300.0, 0.070, 0.32, 0.75, uTime) * band * uMilky;
      }
      if (uStars > 0.002) {
        s += starLayer(d, 210.0, 0.030, 0.38, 1.05, uTime) * uStars;
        s += starLayer(d,  96.0, 0.020, 0.44, 2.00, uTime * 0.77) * uStars;
      }
      col += s * vis;
    }
  }

  // A gradient this smooth over 1400 px bands without help. Scale the dither
  // with sqrt(colour) so it stays near one output LSB across the whole range
  // instead of shredding the near-black night zenith.
  col += (ign(gl_FragCoord.xy) - 0.5) * (1.5 / 255.0) * sqrt(max(col, vec3(0.0)));

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
}

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

  // The only randomness in the sky: where the star lattice starts and which way
  // the Milky Way crosses the dome. Seeded, so a given seed is a given sky.
  const rng = makeRng((opts.seed ?? 1) ^ 0x5c1f5c1f);
  const starSeed = new THREE.Vector3(rng.range(0, 97), rng.range(0, 97), rng.range(0, 97));
  const mwAxis = new THREE.Vector3(
    rng.range(0.30, 0.62) * rng.sign(),
    rng.range(0.26, 0.46),
    rng.range(0.60, 0.88) * rng.sign(),
  ).normalize();

  const geo = new THREE.SphereGeometry(RADIUS, 64, 40);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    transparent: false,
    vertexShader: VERT,
    fragmentShader: buildFragment(quality),
    uniforms: {
      uZenith: { value: new THREE.Color(0.05, 0.20, 0.60) },
      uMid: { value: new THREE.Color(0.20, 0.45, 0.80) },
      uHorizon: { value: new THREE.Color(0.70, 0.86, 0.95) },
      uHalo: { value: new THREE.Color(1, 1, 1) },
      uFog: { value: new THREE.Color(0.65, 0.82, 0.92) },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uHaloSize: { value: 0.1 },
      uHaloAmt: { value: 1 },
      uHorizonGlow: { value: 0.5 },
      uKeyLow: { value: 1 },
      uHaze: { value: 0.35 },
      uStars: { value: 0 },
      uMilky: { value: 0 },
      uTime: { value: 0 },
      uStarSeed: { value: starSeed },
      uMwAxis: { value: mwAxis },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  const group = new THREE.Group();
  group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);

  const u = mat.uniforms;

  return {
    group,

    applyEnv(env) {
      u.uZenith.value.copy(env.skyZenith);
      u.uMid.value.copy(env.skyMid);
      u.uHorizon.value.copy(env.skyHorizon);
      u.uHalo.value.copy(env.sunHalo);
      u.uFog.value.copy(env.fogColor);
      u.uHaloSize.value = env.sunHaloSize;
      u.uHorizonGlow.value = env.horizonGlow;
      u.uHaze.value = env.hazeStrength;
      u.uStars.value = env.starOpacity;
      u.uMilky.value = env.milkyWayOpacity;
      u.uSunDir.value.copy(env.sunDir);

      lightDirInto(env, _keyDir);
      u.uKeyDir.value.copy(_keyDir);
      u.uHaloAmt.value = THREE.MathUtils.clamp((_keyDir.y + 0.14) / 0.20, 0, 1);
      // How low the key light is, not whether it has set: the horizon wrap is a
      // long-path-through-the-atmosphere effect, so it belongs to a sun near the
      // horizon and should be almost gone at noon. Written the other way round
      // this read 1.0 at midday and bleached the whole horizon band white.
      u.uKeyLow.value = 0.15 + 0.85 * (1.0 - THREE.MathUtils.smoothstep(env.sunDir.y, 0.0, 0.42));
    },

    update(ctx) {
      u.uTime.value = ctx.time;
      const c = ctx.camera.position;
      group.position.set(c.x, 0, c.z);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
