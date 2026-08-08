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
// shell keeps it finite (~10 km at grazing) so the clouds pile up, flatten and
// thin toward the horizon the way the concept art does.
//
// Density is a 2.5D field rather than a raymarch, which SwiftShader would never
// survive: a big fbm places the clusters, a jittered cell layer bulges them into
// individual puffs, a small fbm frays the edges. The cell layer also hands back
// a per-puff surface normal, so the tops still light up when the sun is high and
// the deck does not read as flat paper. A second density lookup offset toward
// the key light gives the self-shadow, and the length of that offset falls out
// of the sun's elevation — which is why sunset throws long violet shadows and a
// hot rim, for free.
//
// quality.cloudSteps picks the octave counts and how much of the detail layer
// survives. The loops are constant bound (ESSL 1.00) and baked at build time, so
// a lower tier really is cheaper rather than just masked out.

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';
import { makeRng } from '../core/rng.js';
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
uniform vec2  uEvolve;
uniform vec2  uSeed;
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

const float CLOUD_H = 1500.0;   // deck height above the water, metres
const float SHELL_R = 34000.0;  // curvature of the deck; smaller = tighter horizon
const float SCALE   = 0.0011;   // world metres -> noise units (~900 m per cluster)
const float FAR_T   = 9990.0;   // distance to the deck at grazing incidence

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

// Nearest jittered feature point: xy is the offset from the sample toward that
// point, z the distance. It gives rounded blobs to add to the density *and* a
// usable per-blob surface normal, which is what stops a high sun leaving the
// whole deck flat and papery.
vec3 puffCell(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float best = 8.0;
  vec2 bo = vec2(0.0);
  for(int y=-1;y<=1;y++){
    for(int x=-1;x<=1;x++){
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + hash22(i+g) - f;
      float d2 = dot(r, r);
      if(d2 < best){ best = d2; bo = r; }
    }
  }
  return vec3(bo, sqrt(best));
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
  vec2 world = uOrigin + d.xz * t + uDrift;
  vec2 q = world * SCALE + uSeed;

  // Everything small has to die off with distance or the horizon turns into a
  // field of aliasing speckle — one texel of deck covers hundreds of metres out
  // there. The far term drives detail amplitude and widens the silhouette band.
  float far = smoothstep(3200.0, 8600.0, t);
  float det = uDetail * (1.0 - far);

  // Three scales: the big fbm decides where a cluster is, the cell layer bulges
  // it into individual puffs, the small fbm frays the edges. The detail term is
  // zero-mean so turning it down on a lower tier does not change coverage.
  float big = fbmBig(q);
  vec3  pc  = puffCell(q * 1.5 + vec2(4.3, -1.7));
  float puff = mix(0.55, 1.0 - sat(pc.z * 1.05), 1.0 - far * 0.85);
  float med = fbmMed(q * 3.1 + vec2(21.7, -8.3) + uEvolve);
  float dens = big*0.68 + puff*0.32 + (med - 0.5) * (0.26 * det);
  // Renormalise back onto the same mean/spread the coverage curve expects.
  dens = 0.5 + (dens - 0.516) * 1.13;

  float thr = 1.03 - uCover;
  // Narrow band, not a lazy fade: cumulus have edges. It only widens far away,
  // where a hard edge would crawl.
  float band = mix(0.042, 0.110, far);
  float a = smoothstep(thr - band * 0.19, thr + band, dens);
  if (a <= 0.002) discard;

  // --- self shadow ---------------------------------------------------------
  // Sample the field displaced toward the light. A high sun gives a short
  // offset (lit tops, dark cores); a low sun gives a long one, which is what
  // throws half the cloud into violet shadow at sunset.
  vec2 lh = uLightDir.xz;
  lh /= max(length(lh), 1e-4);
  float el = max(uLightDir.y, 0.05);
  // Keep the offset inside half a cell: beyond that the lookup decorrelates
  // from the cloud it is meant to be shadowing and the whole deck turns to mush.
  float off = min(340.0 / el, 480.0);
  float ds = fbmSha(q + lh * (off * SCALE));
  float shade = sat((ds - thr) / 0.12);

  // Each puff is a dome; its normal comes free out of puffCell.
  float hh = sqrt(max(1.0 - dot(pc.xy, pc.xy), 0.05));
  vec3 nrm = normalize(vec3(-pc.x, hh, -pc.y));
  float ndlRaw = sat(dot(nrm, uLightDir));
  float ndl = ndlRaw * 0.62 + 0.38;

  float light = ndl * exp(-shade * 1.15);
  // Thick cores sit in their own shadow — the soft grey underside.
  light *= mix(0.62, 1.0, 1.0 - sat((dens - thr) / 0.22));
  light = sat(light * 1.18);

  // --- sun-facing rim ------------------------------------------------------
  // Only the thin outer band, only where it faces the light and nothing is
  // between it and the light. Strongest when the key is low — ref/02.
  float rimStr = 0.18 + 0.80 * (1.0 - sat(uLightDir.y * 1.7));
  float edge = a * (1.0 - smoothstep(thr + band * 0.45, thr + band * 2.30, dens));
  float rim = edge * ndlRaw * sat(1.0 - shade * 1.5) * rimStr;

  vec3 c = mix(uShadow, uLit, light);
  c += uRim * rim;

  // Distant decks sit back into the atmosphere.
  float fa = sat(smoothstep(2200.0, FAR_T, t) * (0.30 + 0.62 * uHaze));
  c = mix(c, uFog, fa);

  a *= uOpacity * fade;
  a *= mix(1.0, 0.58, smoothstep(4000.0, FAR_T, t));

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
  const rng = makeRng((opts.seed ?? 1) ^ 0x2b7e1516);
  const seedOffset = new THREE.Vector2(rng.range(0, 24), rng.range(0, 24));

  // Cap only — the dome stops a little below the horizon, which is all the
  // deck the shell intersection produces anything useful for.
  const geo = new THREE.SphereGeometry(RADIUS, 96, 48, 0, Math.PI * 2, 0, Math.PI * 0.55);
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
      uEvolve: { value: new THREE.Vector2() },
      uSeed: { value: seedOffset },
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
  // Slow trade-wind drift, metres per second, plus a much slower evolution of
  // the small scale so a cluster does not read as a rigid stencil sliding past.
  const WIND_X = 3.4, WIND_Z = -1.5;
  const EVOLVE_X = 0.0022, EVOLVE_Z = -0.0014;

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
      u.uDrift.value.set(ctx.time * WIND_X, ctx.time * WIND_Z);
      u.uEvolve.value.set(ctx.time * EVOLVE_X, ctx.time * EVOLVE_Z);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
