// The cloud layer.
//
// Chunky cumulus with bright tops, grey undersides and — when the key light is
// low — a hot rim along the sun-facing silhouette. That rim is the whole trick
// behind ref/02, so it is driven directly off the sun's elevation.
//
// Geometry is a BackSide dome cap, but the clouds themselves do not live on it:
// each fragment intersects its view ray with a *curved* shell (a sphere of
// radius SHELL_R tangent to a plane CLOUD_H above the water). A flat sky plane
// sends the intersection to infinity at the horizon and smears; the curved
// shell keeps it finite (~3.3 km at grazing) so the clouds pile up, flatten and
// thin toward the horizon the way the concept art does.
//
// Density is a 2.5D field rather than a raymarch: a big fbm for the cluster
// shapes plus a smaller one for the puffs, and a second lookup offset toward
// the key light for the self-shadow term. `quality.cloudSteps` picks the octave
// counts and how much of the detail layer survives — the loops are constant
// bound (ESSL 1.00) and baked at build time, so a lower tier really is cheaper
// rather than just masked out.

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';
import { LAYER, setLayers } from '../core/layers.js';

const RADIUS = 4000;

const VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function tierFor(steps) {
  if (steps >= 20) return { big: 5, med: 4, sha: 3, detail: 1.0 };
  if (steps >= 12) return { big: 4, med: 3, sha: 3, detail: 0.85 };
  return { big: 3, med: 2, sha: 2, detail: 0.55 };
}

function buildFragment(quality) {
  const t = tierFor(quality?.cloudSteps ?? 24);
  return /* glsl */`
varying vec3 vDir;

uniform vec3  uLit;
uniform vec3  uShadow;
uniform vec3  uRim;
uniform vec3  uFog;
uniform vec3  uLightDir;
uniform vec2  uOrigin;
uniform vec2  uDrift;
uniform float uCover;
uniform float uOpacity;
uniform float uHaze;
uniform float uDetail;

${GLSL.util}
${GLSL.hash}
${GLSL.noise}

#define OCT_BIG ${t.big}
#define OCT_MED ${t.med}
#define OCT_SHA ${t.sha}

const mat2 CROT = mat2(0.80, -0.60, 0.60, 0.80);

const float CLOUD_H = 780.0;    // deck height above the water, metres
const float SHELL_R = 5200.0;   // curvature of the deck; smaller = tighter horizon
const float SCALE   = 0.00062;  // world metres -> noise units (~1.6 km per cell)

float fbmBig(vec2 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<OCT_BIG;i++){ s += a*vnoise(p); n += a; a *= 0.5; p = CROT*p*2.07; }
  return s/max(n, 1e-4);
}
float fbmMed(vec2 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<OCT_MED;i++){ s += a*vnoise(p); n += a; a *= 0.5; p = CROT*p*2.07; }
  return s/max(n, 1e-4);
}
float fbmSha(vec2 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<OCT_SHA;i++){ s += a*vnoise(p); n += a; a *= 0.5; p = CROT*p*2.07; }
  return s/max(n, 1e-4);
}

// Distance along the view ray to the curved cloud deck.
float shellT(float dy){
  float k = SHELL_R - CLOUD_H;
  float c = 2.0*SHELL_R*CLOUD_H - CLOUD_H*CLOUD_H;
  return -dy*k + sqrt(max(dy*dy*k*k + c, 1.0));
}

void main(){
  vec3 d = normalize(vDir);

  float fade = smoothstep(-0.035, 0.050, d.y);
  if (fade <= 0.0005) discard;

  float t = shellT(d.y);
  vec2 world = uOrigin + d.xz * t;
  vec2 q = world * SCALE + uDrift;

  // Kill the small scale before it aliases into a shimmer at the horizon.
  float det = uDetail * (1.0 - smoothstep(1000.0, 2700.0, t));

  float big = fbmBig(q);
  float med = fbmMed(q * 3.1 + vec2(21.7, -8.3) + uDrift * 0.7);
  float dens = mix(big, big*0.66 + med*0.34, det);

  float thr = 1.03 - uCover;
  // Narrow band, not a lazy fade: cumulus have edges.
  float a = smoothstep(thr - 0.015, thr + 0.085, dens);
  if (a <= 0.002) discard;

  // --- self shadow ---------------------------------------------------------
  // Sample the field displaced toward the light. A high sun gives a short
  // offset (lit tops, dark cores); a low sun gives a long one, which is what
  // throws half the cloud into violet shadow at sunset.
  vec2 lh = uLightDir.xz;
  lh /= max(length(lh), 1e-4);
  float el = max(uLightDir.y, 0.05);
  float off = min(190.0 / el, 1250.0);
  float ds = fbmSha(q + lh * (off * SCALE));
  float shade = sat((ds - thr) / 0.17);
  float light = exp(-shade * 2.1);
  light *= mix(0.68, 1.0, 1.0 - sat((dens - thr) / 0.34));

  // --- sun-facing rim ------------------------------------------------------
  float rimStr = 0.30 + 1.55 * (1.0 - sat(uLightDir.y * 1.7));
  float edge = a * (1.0 - smoothstep(thr + 0.045, thr + 0.170, dens));
  float rim = edge * sat(1.0 - shade * 1.7) * rimStr;

  vec3 c = mix(uShadow, uLit, light);
  c += uRim * rim;

  // Distant decks sit back into the atmosphere.
  float fa = sat(smoothstep(700.0, 3050.0, t) * (0.30 + 0.62 * uHaze));
  c = mix(c, uFog, fa);

  a *= uOpacity * fade;
  a *= mix(1.0, 0.66, smoothstep(1400.0, 3100.0, t));

  c += (ign(gl_FragCoord.xy) - 0.5) * (1.5 / 255.0) * sqrt(max(c, vec3(0.0)));

  gl_FragColor = vec4(max(c, vec3(0.0)), a);
}
`;
}

/** Blend of the moon and the sun: whichever actually owns the light right now. */
function lightDirInto(env, out) {
  const w = THREE.MathUtils.smoothstep(env.sunDir.y, -0.30, -0.02);
  out.copy(env.moonDir).lerp(env.sunDir, w);
  if (out.lengthSq() < 1e-6) out.copy(env.keyDir);
  return out.normalize();
}

const _light = new THREE.Vector3();

export function createClouds(opts = {}) {
  const quality = opts.quality ?? {};

  // Cap only — the dome stops a little below the horizon, which is all the
  // deck the shell intersection produces anything useful for.
  const geo = new THREE.SphereGeometry(RADIUS, 64, 24, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    vertexShader: VERT,
    fragmentShader: buildFragment(quality),
    uniforms: {
      uLit: { value: new THREE.Color(1, 1, 1) },
      uShadow: { value: new THREE.Color(0.5, 0.6, 0.75) },
      uRim: { value: new THREE.Color(1, 1, 1) },
      uFog: { value: new THREE.Color(0.65, 0.82, 0.92) },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uOrigin: { value: new THREE.Vector2() },
      uDrift: { value: new THREE.Vector2() },
      uCover: { value: 0.42 },
      uOpacity: { value: 1 },
      uHaze: { value: 0.35 },
      uDetail: { value: tierFor(quality?.cloudSteps ?? 24).detail },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  const group = new THREE.Group();
  group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);

  const u = mat.uniforms;
  // Slow trade-wind drift. Accumulated on the CPU so the noise never sees a
  // large time value and loses precision.
  const WIND_X = 2.6, WIND_Z = -1.15;

  return {
    group,

    applyEnv(env) {
      u.uLit.value.copy(env.cloudLit);
      u.uShadow.value.copy(env.cloudShadow);
      u.uRim.value.copy(env.cloudRim);
      u.uFog.value.copy(env.fogColor);
      u.uCover.value = env.cloudCover;
      u.uOpacity.value = env.cloudOpacity;
      u.uHaze.value = env.hazeStrength;
      lightDirInto(env, _light);
      u.uLightDir.value.copy(_light);
    },

    update(ctx) {
      const c = ctx.camera.position;
      group.position.set(c.x, 0, c.z);
      u.uOrigin.value.set(c.x, c.z);
      // 0.00062 noise units per metre; keep the drift in noise units directly.
      u.uDrift.value.set(ctx.time * WIND_X * 0.00062, ctx.time * WIND_Z * 0.00062);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
