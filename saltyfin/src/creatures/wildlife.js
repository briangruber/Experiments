// Everything alive that is not the leviathan.
//
// Three things, and each one is here because the concept art has it:
//
//   * **Fish schools.** ref/01 is clear water over a reef; clear water reads as
//     clear only when something is moving down there. Four schools of small
//     tapered bodies at 3–9 m, one InstancedMesh each, on LAYER.MAIN +
//     LAYER.UNDERWATER so the refraction pass carries them.
//   * **Seagulls.** ref/01 has them wheeling over the harbour at three
//     different heights — they are most of what sells the scale of the village.
//     One InstancedMesh, lazy orbits, wings flapping in the vertex shader with a
//     per-bird phase and a per-bird glide. LAYER.MAIN + LAYER.REFLECTED, faded
//     out with `env.dayFactor`.
//   * **A jumping fish**, now and then, in the mid-distance: out of the water,
//     an arc, and back in, stamping the ripple sim on the way out and the way
//     back. It is a two-second event every half minute and it makes the whole
//     bay feel occupied.
//
// The flocking is deliberately cheap. A school is one Object3D following a
// wandering Lissajous; the instances hold fixed offsets inside it and the
// per-fish swim wiggle and jostle happen in the vertex shader off a hash of the
// instance's own offset. That is three transforms a frame for the whole bay.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { GLSL } from '../core/glsl.js';
import { makeRng, clamp } from '../core/rng.js';

const TAU = Math.PI * 2;
const SRGB = THREE.SRGBColorSpace;
const col = (hex) => new THREE.Color().setHex(hex, SRGB);

// --- scratch ----------------------------------------------------------------

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m3 = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _IDENT = new THREE.Matrix4();

// --- the mesher -------------------------------------------------------------
// position / normal / colour, non-indexed. Same shape as the boat's and the
// leviathan's: everything a creature is made of ends up in one buffer.

function Mesher() { this.pos = []; this.nor = []; this.col = []; }

Mesher.prototype.add = function add(geo, matrix, colorFn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const pa = g.attributes.position.array;
  const na = g.attributes.normal.array;
  const count = g.attributes.position.count;
  _m3.getNormalMatrix(matrix || _IDENT);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    _v.set(pa[o], pa[o + 1], pa[o + 2]);
    colorFn(_v.x, _v.y, _v.z, _c2);
    if (matrix) _v.applyMatrix4(matrix);
    this.pos.push(_v.x, _v.y, _v.z);
    _n.set(na[o], na[o + 1], na[o + 2]).applyMatrix3(_m3);
    if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
    this.nor.push(_n.x, _n.y, _n.z);
    this.col.push(_c2.r, _c2.g, _c2.b);
  }
  if (g !== geo) g.dispose();
  return this;
};

Mesher.prototype.build = function build() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
  geo.computeBoundingSphere();
  return geo;
};

function mirroredX(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  for (let i = 0; i < p.length; i += 3) { p[i] = -p[i]; n[i] = -n[i]; }
  for (let i = 0; i + 8 < p.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      let t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t;
      t = n[i + 3 + k]; n[i + 3 + k] = n[i + 6 + k]; n[i + 6 + k] = t;
    }
  }
  return g;
}

// --- shared little builders --------------------------------------------------

/** Loft an ellipse section along -Z..+Z. rows: [t, halfW, halfH, yc]. */
function loft(rows, length, radial) {
  const pos = [];
  const idx = [];
  const half = length * 0.5;
  const stations = rows.length;
  for (let i = 0; i < stations; i++) {
    const r = rows[i];
    const z = -half + r[0] * length;
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * TAU;
      pos.push(r[1] * Math.sin(a), r[3] + r[2] * Math.cos(a), z);
    }
  }
  for (let i = 0; i < stations - 1; i++) {
    const a0 = i * radial, a1 = (i + 1) * radial;
    for (let k = 0; k < radial; k++) {
      const kn = (k + 1) % radial;
      idx.push(a0 + k, a1 + k, a1 + kn);
      idx.push(a0 + k, a1 + kn, a0 + kn);
    }
  }
  const noseIdx = pos.length / 3;
  pos.push(0, rows[0][3], -half - length * 0.02);
  for (let k = 0; k < radial; k++) idx.push(noseIdx, (k + 1) % radial, k);
  const tailIdx = pos.length / 3;
  pos.push(0, rows[stations - 1][3], half + length * 0.02);
  const last = (stations - 1) * radial;
  for (let k = 0; k < radial; k++) idx.push(tailIdx, last + k, last + (k + 1) % radial);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A four-point-section blade. rows: [u, zLE, zTE, y, thickness]; span along +x. */
function blade(rows, span) {
  const pos = [];
  const idx = [];
  const N = rows.length;
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    const x = r[0] * span;
    const zm = (r[1] + r[2]) * 0.5;
    const th = r[4] * 0.5;
    pos.push(x, r[3], r[1], x, r[3] + th, zm, x, r[3], r[2], x, r[3] - th, zm);
  }
  for (let i = 0; i < N - 1; i++) {
    const a = i * 4, b = (i + 1) * 4;
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(a + k, b + k, b + k2);
      idx.push(a + k, b + k2, a + k2);
    }
  }
  idx.push(0, 1, 2, 0, 2, 3);
  const l = (N - 1) * 4;
  idx.push(l, l + 2, l + 1, l, l + 3, l + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A flat fan: a point at the origin opening back to two tips at z1, `up` to one
 * side of the axis and `down` to the other, with a shallow bulge across so it is
 * not a zero-volume sheet. `vertical` true spreads in y (a caudal fin or a
 * dorsal), false spreads in x (a bird's tail).
 */
function fan(z0, z1, up, down, thick, vertical) {
  const t = thick * 0.5;
  const zm = (z0 + z1) * 0.5;
  const sm = (up - down) * 0.25;
  const V = (spread, across, z) => (vertical
    ? [across, spread, z]
    : [spread, across, z]);
  const R = V(0, 0, z0);
  const U = V(up, 0, z1);
  const D = V(-down, 0, z1);
  const A = V(sm, t, zm);
  const B = V(sm, -t, zm);
  const pos = new Float32Array([
    ...R, ...U, ...A, ...R, ...A, ...D,
    ...R, ...D, ...B, ...R, ...B, ...U,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// --- the fish ---------------------------------------------------------------
// 0.30 m of tapered body, a vertical tail and a small dorsal. Read through five
// metres of water, which eats red first, so the albedo is biased warm on purpose
// exactly the way the reef's is.

const FISH_LEN = 0.30;
const FISH_PROF = [
  [0.00, 0.006, 0.009, 0.000],
  [0.08, 0.026, 0.036, 0.004],
  [0.20, 0.040, 0.058, 0.005],
  [0.36, 0.042, 0.062, 0.002],
  [0.55, 0.032, 0.048, -0.002],
  [0.72, 0.020, 0.031, -0.004],
  [0.86, 0.011, 0.019, -0.005],
  [1.00, 0.005, 0.011, -0.005],
];

const FISH_BACK = col(0x2E5E70);
const FISH_MID = col(0x8FB6A8);
const FISH_BELLY = col(0xF0E6C8);
const FISH_FIN = col(0x9E8C64);

function fishColor(x, y, z, out) {
  const u = clamp(y / 0.062 * 0.5 + 0.5, 0, 1);
  if (u < 0.55) out.copy(FISH_BELLY).lerp(FISH_MID, u / 0.55);
  else out.copy(FISH_MID).lerp(FISH_BACK, (u - 0.55) / 0.45);
  // A single lateral stripe, the way most reef fish read at distance.
  const band = 1 - Math.min(1, Math.abs(u - 0.60) * 14);
  if (band > 0) out.lerp(FISH_BELLY, band * 0.35);
  return out;
}

function buildFish(bright) {
  const M = new Mesher();
  const body = loft(FISH_PROF, FISH_LEN, 9);
  M.add(body, null, fishColor);
  body.dispose();

  const half = FISH_LEN * 0.5;
  const finColor = (x, y, z, out) => out.copy(FISH_FIN);

  // Caudal fin: a symmetric fork off the tail stock.
  const tail = fan(half * 0.74, half * 1.34, 0.052, 0.046, 0.010, true);
  M.add(tail, null, finColor);
  tail.dispose();

  // Dorsal, riding on top of the body.
  const dorsal = fan(-half * 0.16, half * 0.46, 0.042, 0.0, 0.006, true);
  dorsal.translate(0, 0.050, 0);
  M.add(dorsal, null, finColor);
  dorsal.dispose();

  // Two little pectorals so the fish is not a bare lozenge in profile.
  const pect = fan(-half * 0.28, half * 0.16, 0.030, 0.0, 0.005, false);
  const pectL = mirroredX(pect);
  pect.translate(0.026, -0.010, 0);
  pectL.translate(-0.026, -0.010, 0);
  M.add(pect, null, finColor);
  M.add(pectL, null, finColor);
  pect.dispose(); pectL.dispose();

  const geo = M.build();
  if (bright !== 1) {
    const c = geo.attributes.color.array;
    for (let i = 0; i < c.length; i++) c[i] = Math.min(1, c[i] * bright);
  }
  return geo;
}

// --- the gull ---------------------------------------------------------------

const GULL_LEN = 0.42;
const GULL_SPAN = 0.55;
const GULL_PROF = [
  [0.00, 0.005, 0.005, 0.004],
  [0.09, 0.011, 0.011, 0.006],
  [0.17, 0.030, 0.033, 0.010],
  [0.29, 0.025, 0.029, 0.004],
  [0.47, 0.052, 0.055, 0.000],
  [0.66, 0.047, 0.049, -0.004],
  [0.84, 0.026, 0.029, -0.006],
  [1.00, 0.008, 0.014, -0.004],
];

const GULL_WING = [
  [0.00, -0.090, 0.090, 0.010, 0.018],
  [0.30, -0.100, 0.070, 0.028, 0.011],
  [0.62, -0.075, 0.035, 0.046, 0.006],
  [0.85, -0.025, 0.015, 0.058, 0.004],
  [1.00, 0.020, 0.050, 0.062, 0.002],
];

const GULL_WHITE = col(0xF6F3EC);
const GULL_GREY = col(0xB9C1CA);
const GULL_TIP = col(0x39414C);
const GULL_BEAK = col(0xE8A234);

function buildGull() {
  const M = new Mesher();
  const half = GULL_LEN * 0.5;
  const body = loft(GULL_PROF, GULL_LEN, 8);
  M.add(body, null, (x, y, z, out) => {
    const t = (z + half) / GULL_LEN;
    if (t < 0.11) out.copy(GULL_BEAK);
    else if (t > 0.90) out.copy(GULL_TIP);
    else if (t > 0.74) out.copy(GULL_WHITE).lerp(GULL_GREY, (t - 0.74) / 0.16);
    else out.copy(GULL_WHITE);
  });
  body.dispose();

  const wingColor = (x, y, z, out) => {
    const u = clamp(Math.abs(x) / GULL_SPAN, 0, 1);
    if (u > 0.74) out.copy(GULL_GREY).lerp(GULL_TIP, (u - 0.74) / 0.26);
    else out.copy(GULL_WHITE).lerp(GULL_GREY, u * 0.85);
  };
  const wing = blade(GULL_WING, GULL_SPAN);
  const wingL = mirroredX(wing);
  M.add(wing, null, wingColor);
  M.add(wingL, null, wingColor);
  wing.dispose(); wingL.dispose();

  // A short horizontal tail fan, so the silhouette from above is a bird and not
  // a cigar with wings.
  const tail = fan(half * 0.72, half * 1.18, 0.055, 0.055, 0.012, false);
  tail.translate(0, -0.004, 0);
  M.add(tail, null, (x, y, z, out) => out.copy(GULL_WHITE).lerp(GULL_GREY, 0.45));
  tail.dispose();

  return M.build();
}

// --- shading ----------------------------------------------------------------

function decorateFishMaterial(mat, uni) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFTime = uni.uFTime;
    shader.uniforms.uFWig = uni.uFWig;
    shader.uniforms.uFRate = uni.uFRate;
    shader.vertexShader = /* glsl */`
uniform float uFTime;
uniform float uFWig;
uniform float uFRate;
const float FISH_HALF = ${(FISH_LEN * 0.5).toFixed(4)};
const float FISH_LEN_ = ${FISH_LEN.toFixed(4)};
${GLSL.hash}
` + shader.vertexShader;

    // The swim wiggle is a travelling sine down the body, exactly like the
    // leviathan's but an order of magnitude smaller, plus a slow jostle so the
    // school is not a rigid lattice being flown around the bay.
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          float fph = hash13(instanceMatrix[3].xyz * 3.17 + 5.1) * 6.283185307;
        #else
          float fph = 0.0;
        #endif
        float fs = clamp((position.z + FISH_HALF) / FISH_LEN_, 0.0, 1.0);
        float famp = uFWig * (0.08 + 0.92 * fs * fs);
        transformed.x += sin(uFTime * uFRate + fph - fs * 4.2) * famp;
        transformed.y += sin(uFTime * 0.80 + fph * 3.1) * 0.055;
        transformed.z += sin(uFTime * 0.55 + fph * 5.7) * 0.090;
      }
    `);
  };
  mat.customProgramCacheKey = () => 'saltyfin-fish-1';
}

function decorateGullMaterial(mat, uni) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGTime = uni.uGTime;
    shader.uniforms.uGRate = uni.uGRate;
    shader.vertexShader = /* glsl */`
attribute vec2 aBird;      // flap phase, flap amplitude (0 = gliding)
uniform float uGTime;
uniform float uGRate;
const float GULL_SPAN_ = ${GULL_SPAN.toFixed(4)};
` + shader.vertexShader;

    // Span-weighted flap. The body sits inside |x| < 0.06, where the weight is
    // effectively zero, so no extra attribute is needed to hold it still.
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      {
        float gs = clamp(abs(position.x) / GULL_SPAN_, 0.0, 1.0);
        float gf = gs * gs * gs;
        float flap = sin(uGTime * uGRate + aBird.x) * aBird.y;
        transformed.y += flap * gf * 0.30;
        transformed.x *= 1.0 - 0.14 * abs(flap) * gf;
      }
    `);
    // The wing is a thin blade; without bending the normal with it the flap
    // reads as a texture crawl rather than a wing.
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', /* glsl */`
      #include <beginnormal_vertex>
      {
        float gs = clamp(abs(position.x) / GULL_SPAN_, 0.0, 1.0);
        float flap = sin(uGTime * uGRate + aBird.x) * aBird.y;
        float tilt = -flap * gs * gs * 0.9 * sign(position.x);
        float tc = cos(tilt), ts = sin(tilt);
        objectNormal = vec3(objectNormal.x * tc - objectNormal.y * ts,
                            objectNormal.x * ts + objectNormal.y * tc,
                            objectNormal.z);
      }
    `);
  };
  mat.customProgramCacheKey = () => 'saltyfin-gull-1';
}

// ---------------------------------------------------------------- the module

export function createWildlife(opts = {}) {
  const group = new THREE.Group();
  group.name = 'wildlife';

  const seed = (opts.seed | 0) || 20260807;
  const rng = makeRng((seed ^ 0x5eab1d) >>> 0);
  // See TIERS in core/renderer.js — one budget, no tier-name ladder.
  const geo = opts.quality?.geometry ?? 1;
  const lerpI = (a, b) => Math.round(a + (b - a) * Math.min(1, Math.max(0, (geo - 0.42) / 0.58)));
  const terrain = opts.terrain || null;

  const seabed = (terrain && typeof terrain.seabedHeight === 'function')
    ? terrain.seabedHeight
    : (x, z) => {
      const r = Math.sqrt(x * x + z * z);
      return r <= 200 ? -(2.6 + 5.1 * (r / 200)) : -(7.7 + 26 * Math.min(1, (r - 200) / 380));
    };
  const isLand = (terrain && typeof terrain.isLand === 'function')
    ? terrain.isLand : () => false;
  const landHeight = (terrain && typeof terrain.landHeight === 'function')
    ? terrain.landHeight : () => -Infinity;

  const uni = {
    uFTime: { value: 0 },
    uFWig: { value: 0.030 },
    uFRate: { value: 7.2 },
    uGTime: { value: 0 },
    uGRate: { value: 4.6 },
  };

  // ======================================================== fish schools =====

  const SCHOOLS = lerpI(3, 4);
  const PER_SCHOOL = lerpI(22, 56);

  const fishGeo = buildFish(1);
  const fishMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.0,
    side: THREE.DoubleSide,
    fog: true,
    dithering: true,
  });
  decorateFishMaterial(fishMat, uni);

  const schools = [];
  const schoolGroup = new THREE.Group();
  schoolGroup.name = 'schools';

  /**
   * Somewhere over the reef with 4–13 m of water and no land underfoot. The
   * bearing is stratified by school index so four schools cannot all land in one
   * quadrant and leave three-quarters of the reef empty.
   */
  function findSchoolSpot(out, si, total) {
    const sector = TAU / total;
    for (let tries = 0; tries < 220; tries++) {
      const a = sector * (si + rng.next());
      const r = 42 + Math.pow(rng.next(), 0.6) * 145;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r - 8;
      if (isLand(x, z)) continue;
      const d = -seabed(x, z);
      if (d < 5.0 || d > 13) continue;
      out.set(x, 0, z);
      return true;
    }
    const a = sector * (si + 0.5);
    out.set(Math.cos(a) * 110, 0, Math.sin(a) * 110 - 8);
    return false;
  }

  const WHITE = new THREE.Color(1, 1, 1);

  for (let si = 0; si < SCHOOLS; si++) {
    findSchoolSpot(_p, si, SCHOOLS);
    // _p is scratch and the instance loop below is about to trample it.
    const spotX = _p.x;
    const spotZ = _p.z;
    const g = new THREE.Group();
    g.rotation.order = 'YXZ';
    g.position.set(spotX, -4, spotZ);

    const mesh = new THREE.InstancedMesh(fishGeo, fishMat, PER_SCHOOL);
    mesh.name = 'school-' + si;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    // The shoal shape: a flattened ellipsoid, denser toward the middle.
    const rx = rng.range(3.4, 6.2);
    const ry = rng.range(0.7, 1.3);
    const rz = rng.range(4.5, 8.0);
    for (let i = 0; i < PER_SCHOOL; i++) {
      const u = rng.range(-1, 1), v = rng.range(-1, 1), w = rng.range(-1, 1);
      const k = Math.pow(rng.next(), 0.45);
      const len = Math.max(1e-3, Math.hypot(u, v, w));
      _p.set(u / len * rx * k, v / len * ry * k, w / len * rz * k);
      _e.set(rng.range(-0.16, 0.16), rng.range(-0.30, 0.30), rng.range(-0.12, 0.12), 'YXZ');
      _q.setFromEuler(_e);
      _s.setScalar(rng.range(0.78, 1.34));
      _m4.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m4);

      // Per-fish tint. Small hue and lightness jitter on a warm bias, because
      // everything down here is seen through several metres of water.
      _c.setHSL(rng.range(0.02, 0.14), rng.range(0.18, 0.46), rng.range(0.48, 0.72), SRGB);
      _c.lerp(WHITE, 0.35);
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 1.0;
    g.add(mesh);
    schoolGroup.add(g);

    const depth = clamp(-seabed(spotX, spotZ) * 0.55, 2.6, 7.5);
    schools.push({
      group: g,
      mesh,
      cx: spotX, cz: spotZ,
      ax: rng.range(13, 29), az: rng.range(13, 29),
      w1: rng.range(0.030, 0.062), p1: rng.range(0, TAU),
      w2: rng.range(0.026, 0.055), p2: rng.range(0, TAU),
      w3: rng.range(0.075, 0.140), p3: rng.range(0, TAU),
      w4: rng.range(0.068, 0.135), p4: rng.range(0, TAU),
      w5: rng.range(0.055, 0.105), p5: rng.range(0, TAU),
      depth,
      depthAmp: rng.range(0.9, 2.4),
      halfHeight: ry + 0.5,
    });
  }
  group.add(schoolGroup);
  setLayers(schoolGroup, LAYER.MAIN, LAYER.UNDERWATER);

  // ============================================================== gulls ======

  const GULLS = lerpI(6, 11);

  // Over the harbour water, over the village slope, and a pair further out —
  // the three heights ref/01 stacks its birds at.
  const GULL_CENTRES = [
    [-78, -10],
    [-124, -36],
    [-34, 6],
  ];

  const gullGeo = buildGull();
  const gullMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.78,
    metalness: 0.0,
    side: THREE.DoubleSide,
    fog: true,
    dithering: true,
  });
  decorateGullMaterial(gullMat, uni);

  const gulls = new THREE.InstancedMesh(gullGeo, gullMat, GULLS);
  gulls.name = 'gulls';
  gulls.castShadow = false;
  gulls.receiveShadow = false;
  gulls.frustumCulled = false;      // they orbit far outside their bake pose
  const aBird = new Float32Array(GULLS * 2);
  const birds = [];
  for (let i = 0; i < GULLS; i++) {
    const c = GULL_CENTRES[i % GULL_CENTRES.length];
    const r = rng.range(20, 58);
    const cx = c[0] + rng.range(-16, 16);
    const cz = c[1] + rng.range(-16, 16);
    // Clear the ground: the village island rises to ~50 m, so sample the orbit
    // before choosing a height rather than guessing one.
    let top = -Infinity;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      const h = landHeight(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
      if (Number.isFinite(h) && h > top) top = h;
    }
    const base = Number.isFinite(top) ? top : 0;
    const y = Math.max(21 + rng.range(0, 38), base + 15);
    birds.push({
      cx, cz, r, y,
      ang: rng.range(0, TAU),
      omega: rng.sign() * rng.range(0.055, 0.135),
      bobA: rng.range(0.7, 2.6),
      bobW: rng.range(0.18, 0.45),
      bobP: rng.range(0, TAU),
      scale: rng.range(1.25, 1.75),
      flap: 1,
      flapTarget: 1,
      switchT: rng.range(1.5, 7),
      phase: rng.range(0, TAU),
    });
    aBird[i * 2] = birds[i].phase;
    aBird[i * 2 + 1] = 1;

    // Prime the matrix. update() rewrites it before the first render, but an
    // InstancedMesh starts out full of zeroed matrices and a degenerate model
    // matrix is not something to leave lying around.
    const b0 = birds[i];
    _p.set(cx + Math.cos(b0.ang) * r, y, cz + Math.sin(b0.ang) * r);
    _q.identity();
    _s.setScalar(b0.scale);
    _m4.compose(_p, _q, _s);
    gulls.setMatrixAt(i, _m4);
  }
  gulls.instanceMatrix.needsUpdate = true;
  const birdAttr = new THREE.InstancedBufferAttribute(aBird, 2);
  birdAttr.setUsage(THREE.DynamicDrawUsage);
  gullGeo.setAttribute('aBird', birdAttr);
  gulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(gulls);
  setLayers(gulls, LAYER.MAIN, LAYER.REFLECTED);

  // ======================================================= jumping fish ======

  const jumperGeo = buildFish(1.25);
  const jumper = new THREE.Mesh(jumperGeo, fishMat);
  jumper.name = 'jumper';
  jumper.scale.setScalar(1.9);
  jumper.rotation.order = 'YXZ';
  jumper.castShadow = false;
  jumper.receiveShadow = false;
  jumper.visible = false;
  jumper.frustumCulled = false;
  group.add(jumper);
  setLayers(jumper, LAYER.MAIN, LAYER.REFLECTED);
  // Crosses the waterline twice a leap, flashing an upside-down fish into the
  // reflection at each end of the arc. Shares its material with the schools,
  // which want the same clip anyway.
  applyWaterClip(jumper);

  const jump = {
    active: false,
    wait: 6 + rng.range(0, 14),
    t: 0,
    dur: 1.5,
    x0: 0, z0: 0, x1: 0, z1: 0,
    apex: 1.4,
    exited: false,
  };

  // --- frame ---------------------------------------------------------------

  const _prevPos = new THREE.Vector3();
  const _nowPos = new THREE.Vector3();

  /**
   * Where a school is at time t. The Lissajous wanders up to fifty metres from
   * the vetted centre, which is enough to walk it onto a reef head or a beach —
   * so the point is pulled back toward the centre in proportion to how thin the
   * water under it has become. The pull is a smooth function of position, so the
   * shoal eases away from the shallows instead of snapping.
   */
  function schoolPoint(sc, t, out) {
    let x = sc.cx + sc.ax * Math.sin(sc.w1 * t + sc.p1) + sc.ax * 0.42 * Math.sin(sc.w3 * t + sc.p3);
    let z = sc.cz + sc.az * Math.cos(sc.w2 * t + sc.p2) + sc.az * 0.42 * Math.sin(sc.w4 * t + sc.p4);
    const sb = seabed(x, z);
    if (!(sb < -4.6)) {
      const k = clamp((Number.isFinite(sb) ? sb : 0) + 4.6, 0, 3.4) / 3.4;
      x += (sc.cx - x) * k;
      z += (sc.cz - z) * k;
    }
    const y = -(sc.depth + sc.depthAmp * Math.sin(sc.w5 * t + sc.p5));
    return out.set(x, y, z);
  }

  function faceAlong(obj, vx, vy, vz) {
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-5) return;
    const ny = clamp(vy / len, -1, 1);
    obj.rotation.y = Math.atan2(-vx, -vz);
    obj.rotation.x = Math.asin(ny);
  }

  function startJump(ctx) {
    const bx = ctx.boat ? ctx.boat.position.x : 0;
    const bz = ctx.boat ? ctx.boat.position.z : 0;
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, TAU);
      const d = rng.range(26, 82);
      const x = bx + Math.cos(a) * d;
      const z = bz + Math.sin(a) * d;
      if (isLand(x, z)) continue;
      if (seabed(x, z) > -2.4) continue;
      const dir = rng.range(0, TAU);
      const run = rng.range(2.4, 4.6);
      jump.x0 = x; jump.z0 = z;
      jump.x1 = x + Math.cos(dir) * run;
      jump.z1 = z + Math.sin(dir) * run;
      if (isLand(jump.x1, jump.z1)) continue;
      jump.apex = rng.range(0.9, 1.9);
      jump.dur = rng.range(1.2, 1.8);
      jump.t = 0;
      jump.active = true;
      jump.exited = false;
      jumper.visible = true;
      return;
    }
    jump.wait = 4 + rng.range(0, 8);
  }

  function update(ctx) {
    const t = ctx.time;
    const dt = ctx.dt;
    uni.uFTime.value = t;
    uni.uGTime.value = t;

    // ---- schools ---------------------------------------------------------
    for (let i = 0; i < schools.length; i++) {
      const sc = schools[i];
      schoolPoint(sc, t, _nowPos);
      schoolPoint(sc, t + 0.35, _prevPos);          // a look-ahead, not a history

      // Stay off the seabed and out of the air. If the column is too thin to
      // hold the shoal at all the two limits cross, and clamping in either order
      // would bury it — so that case centres the school in whatever water there
      // is and lets it thin out rather than sink into the sand.
      const sb = seabed(_nowPos.x, _nowPos.z);
      const lo = (Number.isFinite(sb) ? sb : -30) + sc.halfHeight + 0.4;
      const hi = -1.3 - sc.halfHeight;
      const y = lo > hi ? ((Number.isFinite(sb) ? sb : -30) - 1.3) * 0.5
        : clamp(_nowPos.y, lo, hi);
      sc.group.position.set(_nowPos.x, y, _nowPos.z);
      faceAlong(sc.group, _prevPos.x - _nowPos.x, _prevPos.y - _nowPos.y, _prevPos.z - _nowPos.z);
    }

    // ---- gulls -----------------------------------------------------------
    if (gulls.visible) {
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        b.ang += b.omega * dt;
        b.switchT -= dt;
        if (b.switchT <= 0) {
          // Gulls flap in bursts and then hang on the wind. Roughly two seconds
          // of wingbeats to four of glide.
          b.flapTarget = b.flapTarget > 0.5 ? 0.10 : 1.0;
          b.switchT = b.flapTarget > 0.5 ? rng.range(1.4, 3.2) : rng.range(2.5, 6.5);
        }
        b.flap += (b.flapTarget - b.flap) * Math.min(1, dt * 1.8);
        aBird[i * 2 + 1] = b.flap;

        const ca = Math.cos(b.ang), sa = Math.sin(b.ang);
        const x = b.cx + ca * b.r;
        const z = b.cz + sa * b.r;
        const y = b.y + Math.sin(t * b.bobW + b.bobP) * b.bobA;
        // Tangent of the circle, scaled by the sign of the orbit.
        const tx = -sa * b.omega;
        const tz = ca * b.omega;
        const yaw = Math.atan2(-tx, -tz);
        const roll = clamp(b.omega * 3.4, -0.55, 0.55);
        const pitch = Math.sin(t * b.bobW + b.bobP + Math.PI * 0.5) * b.bobA * b.bobW * 0.35;
        _e.set(pitch, yaw, roll, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(x, y, z);
        _s.setScalar(b.scale);
        _m4.compose(_p, _q, _s);
        gulls.setMatrixAt(i, _m4);
      }
      gulls.instanceMatrix.needsUpdate = true;
      birdAttr.needsUpdate = true;
    }

    // ---- the jumper ------------------------------------------------------
    const water = ctx.water;
    if (jump.active) {
      jump.t += dt;
      const u = jump.t / jump.dur;
      if (u >= 1) {
        jump.active = false;
        jumper.visible = false;
        jump.wait = 14 + rng.range(0, 34);
        if (water && water.disturb) water.disturb(jump.x1, jump.z1, 1.5, 2.6);
      } else {
        const x = jump.x0 + (jump.x1 - jump.x0) * u;
        const z = jump.z0 + (jump.z1 - jump.z0) * u;
        const y = jump.apex * 4 * u * (1 - u);
        // Velocity of that parabola, for the pitch. dy/du = apex*4*(1-2u).
        const vy = jump.apex * 4 * (1 - 2 * u) / jump.dur;
        const vx = (jump.x1 - jump.x0) / jump.dur;
        const vz = (jump.z1 - jump.z0) / jump.dur;
        jumper.position.set(x, y - 0.06, z);
        faceAlong(jumper, vx, vy, vz);
        if (!jump.exited && u > 0.04) {
          jump.exited = true;
          if (water && water.disturb) water.disturb(jump.x0, jump.z0, 1.2, 2.2);
        }
      }
    } else {
      jump.wait -= dt;
      if (jump.wait <= 0) startJump(ctx);
    }
  }

  function applyEnv(env) {
    if (!env) return;

    // Fish are lit by the same water light the reef is, and never allowed to
    // fall to black under the moon.
    fishMat.emissive.copy(env.waterScatter).multiplyScalar(0.05 + 0.10 * env.nightFactor);
    uni.uFWig.value = 0.026 + 0.010 * env.dayFactor;
    uni.uFRate.value = 6.2 + 1.8 * env.dayFactor;

    // Gulls go home at dusk. The material stays opaque — a transparent bird
    // would have to sort against the clouds, and would be stripped of its
    // shadow-caster flag for nothing — so the fade is on albedo, which reads as
    // the birds sinking into the twilight before they wink out.
    const day = env.dayFactor;
    const vis = clamp((day - 0.06) / 0.30, 0, 1);
    gullMat.color.setScalar(0.12 + 0.88 * vis);
    gulls.visible = vis > 0.03;
    // A whisper of sky in the plumage keeps them from reading as paper cutouts
    // against a bright horizon.
    _c.copy(env.ambientSky).multiplyScalar(0.05 + 0.05 * day);
    gullMat.emissive.copy(_c);
    uni.uGRate.value = 4.2 + 1.0 * day;
  }

  function dispose() {
    fishGeo.dispose();
    jumperGeo.dispose();
    fishMat.dispose();
    gullGeo.dispose();
    gullMat.dispose();
    gulls.dispose();
    for (const sc of schools) sc.mesh.dispose();
    schools.length = 0;
    group.clear();
  }

  return { group, update, applyEnv, dispose };
}
