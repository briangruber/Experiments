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
// survives. Those counts are baked at graph-build time — the GLSL build had to
// spell out constant-bound loops for ESSL 1.00, the TSL build unrolls them in
// JavaScript — so a lower tier really is cheaper rather than just masked out.
//
// Ported from GLSL to TSL. The noise is the shared set in sky.js, which is the
// same hash constants core/glsl.js uses, so every cloud is in the same place it
// was on the WebGL build.

import * as THREE from 'three';
import {
  Fn, uniform, varying, positionLocal, screenCoordinate, Discard, If,
  vec2, vec3, vec4, float,
  max, min, clamp, mix, dot, smoothstep, floor, fract,
  exp, sqrt, normalize, length,
} from 'three/tsl';
import { hash22, fbmValue2, ign } from './sky.js';
import { makeRng } from '../core/rng.js';
import { LAYER, setLayers } from '../core/layers.js';

const RADIUS = 4000;

const CLOUD_H = 1500.0;   // deck height above the water, metres
const SHELL_R = 34000.0;  // curvature of the deck; smaller = tighter horizon
const SCALE = 0.00082;    // world metres -> noise units (~1200 m per cluster)
const FAR_T = 9990.0;     // distance to the deck at grazing incidence

function tierFor(steps) {
  if (steps >= 20) return { big: 5, med: 4, sha: 3, detail: 1.0 };
  if (steps >= 12) return { big: 4, med: 3, sha: 3, detail: 0.85 };
  return { big: 3, med: 2, sha: 2, detail: 0.55 };
}

// Nearest jittered feature point: xy is the offset from the sample toward that
// point, z the distance. It gives rounded blobs to add to the density *and* a
// usable per-blob surface normal, which is what stops a high sun leaving the
// whole deck flat and papery.
const puffCell = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const best = float(8.0).toVar();
  const bo = vec2(0.0).toVar();
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const g = vec2(x, y);
      const r = g.add(hash22(i.add(g))).sub(f).toVar();
      const d2 = dot(r, r).toVar();
      If(d2.lessThan(best), () => { best.assign(d2); bo.assign(r); });
    }
  }
  return vec3(bo, sqrt(best));
});

// Distance along the view ray to the curved cloud deck. k and c are constant on
// both sides of the port, so they fold in JavaScript instead of the shader.
const SHELL_K = SHELL_R - CLOUD_H;
const SHELL_C = 2.0 * SHELL_R * CLOUD_H - CLOUD_H * CLOUD_H;
const shellT = (dy) => dy.mul(-SHELL_K)
  .add(sqrt(max(dy.mul(dy).mul(SHELL_K * SHELL_K).add(SHELL_C), 1.0)));

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
  const tier = tierFor(quality.cloudSteps ?? 24);
  const rng = makeRng((opts.seed ?? 1) ^ 0x2b7e1516);
  const seedOffset = new THREE.Vector2(rng.range(0, 24), rng.range(0, 24));

  const uLit = uniform(new THREE.Vector3(1, 1, 1));
  const uShadow = uniform(new THREE.Vector3(0.5, 0.6, 0.75));
  const uRim = uniform(new THREE.Vector3(1, 1, 1));
  const uFog = uniform(new THREE.Vector3(0.65, 0.82, 0.92));
  const uLightDir = uniform(new THREE.Vector3(0, 1, 0));
  const uOrigin = uniform(new THREE.Vector2());
  const uDrift = uniform(new THREE.Vector2());
  const uEvolve = uniform(new THREE.Vector2());
  const uSeed = uniform(seedOffset);
  const uCover = uniform(0.42);
  const uOpacity = uniform(1);
  const uHaze = uniform(0.35);
  const uDetail = uniform(tier.detail);

  const vDir = varying(positionLocal, 'vDir');

  const mat = new THREE.NodeMaterial();
  mat.side = THREE.BackSide;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.fog = false;

  mat.fragmentNode = Fn(() => {
    const d = normalize(vDir).toVar();

    const fade = smoothstep(-0.035, 0.050, d.y).toVar();
    Discard(fade.lessThanEqual(0.0005));

    const t = shellT(d.y).toVar();
    const world = uOrigin.add(d.xz.mul(t)).add(uDrift).toVar();
    const q = world.mul(SCALE).add(uSeed).toVar();

    // Everything small has to die off with distance or the horizon turns into a
    // field of aliasing speckle — one texel of deck covers hundreds of metres out
    // there. The far term drives detail amplitude and widens the silhouette band.
    const far = smoothstep(3200.0, 8600.0, t).toVar();
    const det = uDetail.mul(far.oneMinus()).toVar();

    // Three scales: the big fbm decides where a cluster is, the cell layer bulges
    // it into individual puffs, the small fbm frays the edges. The detail term is
    // zero-mean so turning it down on a lower tier does not change coverage.
    const big = fbmValue2(q, tier.big).toVar();
    const pc = puffCell(q.mul(1.5).add(vec2(4.3, -1.7))).toVar();
    const puff = mix(float(0.55), clamp(pc.z.mul(1.05), 0, 1).oneMinus(), far.mul(0.85).oneMinus()).toVar();
    const med = fbmValue2(q.mul(3.1).add(vec2(21.7, -8.3)).add(uEvolve), tier.med).toVar();
    // The puffs are GATED by the big field rather than added to it. Added, every
    // cell in the sky bulges and the deck becomes an even carpet of identical
    // blobs; gated, puffs only form where a cluster already exists and the gaps
    // between clusters stay open sky.
    const cluster = smoothstep(0.34, 0.66, big).toVar();
    const dens = big.mul(0.60)
      .add(puff.mul(0.40).mul(cluster))
      .add(med.sub(0.5).mul(det.mul(0.26))).toVar();
    // Renormalise back onto the same mean/spread the coverage curve expects.
    dens.assign(dens.sub(0.470).mul(1.22).add(0.5));

    const thr = float(1.03).sub(uCover).toVar();
    // Narrow band, not a lazy fade: cumulus have edges. It only widens far away,
    // where a hard edge would crawl.
    const band = mix(float(0.058), float(0.125), far).toVar();
    const a = smoothstep(thr.sub(band.mul(0.19)), thr.add(band), dens).toVar();
    Discard(a.lessThanEqual(0.002));

    // --- self shadow -------------------------------------------------------
    // Sample the field displaced toward the light. A high sun gives a short
    // offset (lit tops, dark cores); a low sun gives a long one, which is what
    // throws half the cloud into violet shadow at sunset.
    const lh = uLightDir.xz.toVar();
    lh.assign(lh.div(max(length(lh), 1e-4)));
    const el = max(uLightDir.y, 0.05).toVar();
    // Keep the offset inside half a cell: beyond that the lookup decorrelates
    // from the cloud it is meant to be shadowing and the whole deck turns to mush.
    const off = min(float(340.0).div(el), 480.0).toVar();
    const ds = fbmValue2(q.add(lh.mul(off.mul(SCALE))), tier.sha).toVar();
    const shade = clamp(ds.sub(thr).div(0.12), 0, 1).toVar();

    // How deep into the cloud this pixel sits. 0 at the silhouette, 1 in the core.
    const thick = clamp(dens.sub(thr).div(0.30), 0, 1).toVar();

    // Each puff is a dome; its normal comes free out of puffCell. The vertical
    // component is deliberately squashed: at full height every puff on a flat
    // deck faces a high sun equally, ndl pins to 1 everywhere and the deck comes
    // back as flat white paper. Flattening it lets the light's horizontal
    // direction separate a lit side from a shaded one.
    const hh = sqrt(max(float(1.0).sub(dot(pc.xy, pc.xy)), 0.05)).toVar();
    const nrm = normalize(vec3(pc.x.negate(), hh.mul(0.5), pc.y.negate())).toVar();
    const ndlRaw = clamp(dot(nrm, uLightDir), 0, 1).toVar();
    const ndl = ndlRaw.mul(0.78).add(0.22).toVar();

    const light = ndl.mul(exp(shade.mul(-1.25))).toVar();
    // We are underneath this deck looking up, so the thick middle of a cumulus is
    // its own shadowed base and the thin edges are where light gets through. That
    // inversion — bright rim, grey belly — is what makes it read as a cloud.
    light.mulAssign(mix(float(1.0), float(0.40), thick));
    light.assign(clamp(light, 0, 1));

    // --- sun-facing rim ----------------------------------------------------
    // Only the thin outer band, only where it faces the light and nothing is
    // between it and the light. Strongest when the key is low — ref/02.
    const rimStr = clamp(uLightDir.y.mul(1.7), 0, 1).oneMinus().mul(0.80).add(0.18).toVar();
    const edge = a.mul(smoothstep(thr.add(band.mul(0.45)), thr.add(band.mul(2.30)), dens).oneMinus()).toVar();
    const rim = edge.mul(ndlRaw).mul(clamp(shade.mul(-1.5).add(1.0), 0, 1)).mul(rimStr).toVar();

    const c = mix(uShadow, uLit, light).toVar();
    c.addAssign(uRim.mul(rim));

    // Distant decks sit back into the atmosphere.
    const fa = clamp(smoothstep(2200.0, FAR_T, t).mul(uHaze.mul(0.62).add(0.30)), 0, 1).toVar();
    c.assign(mix(c, uFog, fa));

    a.mulAssign(uOpacity.mul(fade));
    a.mulAssign(mix(float(1.0), float(0.58), smoothstep(4000.0, FAR_T, t)));

    c.addAssign(ign(screenCoordinate.xy).sub(0.5).mul(1.5 / 255.0).mul(sqrt(max(c, vec3(0.0)))));

    return vec4(max(c, vec3(0.0)), a);
  })();

  // Cap only — the dome stops a little below the horizon, which is all the
  // deck the shell intersection produces anything useful for.
  const geo = new THREE.SphereGeometry(RADIUS, 96, 48, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  const group = new THREE.Group();
  group.add(mesh);
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);

  // Slow trade-wind drift, metres per second, plus a much slower evolution of
  // the small scale so a cluster does not read as a rigid stencil sliding past.
  const WIND_X = 3.4, WIND_Z = -1.5;
  const EVOLVE_X = 0.0022, EVOLVE_Z = -0.0014;

  return {
    group,

    applyEnv(env) {
      uLit.value.set(env.cloudLit.r, env.cloudLit.g, env.cloudLit.b);
      uShadow.value.set(env.cloudShadow.r, env.cloudShadow.g, env.cloudShadow.b);
      uRim.value.set(env.cloudRim.r, env.cloudRim.g, env.cloudRim.b);
      uFog.value.set(env.fogColor.r, env.fogColor.g, env.fogColor.b);
      uCover.value = env.cloudCover;
      uOpacity.value = env.cloudOpacity;
      uHaze.value = env.hazeStrength;
      lightDirInto(env, _light);
      uLightDir.value.copy(_light);
    },

    update(ctx) {
      const c = ctx.camera.position;
      group.position.set(c.x, 0, c.z);
      uOrigin.value.set(c.x, c.z);
      uDrift.value.set(ctx.time * WIND_X, ctx.time * WIND_Z);
      uEvolve.value.set(ctx.time * EVOLVE_X, ctx.time * EVOLVE_Z);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
