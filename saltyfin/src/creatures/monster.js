// The leviathan.
//
// ref/04 is the brief: a vast dark shape gliding under clear blue water beneath
// the boat — broad body, long tapering tail, enormous swept pectorals, a horned
// head — reading as an *absence of light* rather than as an object. ref/05 is
// the same animal breaching in the distance, spiky head and shoulders bursting
// up in a ring of white water.
//
// Three things make that read:
//
//   * It lives on LAYER.MAIN + LAYER.UNDERWATER, so the water's refraction pass
//     picks it up and the surface veils it with its own absorption. That veil is
//     the softening in ref/04; nothing here fakes it. LAYER.REFLECTED is on too,
//     but the reflection pass clips at the waterline, so only a breach reflects.
//   * Its colour is `env.waterDeep` crushed to about a third. The refraction
//     target is *cleared* to waterDeep, so anything darker than that is a hole
//     in the water. Never a picked black — at night waterDeep is nearly black
//     already and the creature still has to sit a shade under it.
//   * Every scrap of motion is in the vertex shader: a travelling sine down the
//     spine driving the tail, the pectorals sweeping on a longer cycle. The CPU
//     moves one Object3D and touches no vertex.
//
// The body is a 34 m loft — nineteen ellipse stations along a curved spine,
// skinned into one shell — with a lower jaw, back-swept horns, a dorsal ridge of
// spines, two huge swept pectorals, small pelvic fins and a vertical fluke, all
// merged into a single vertex buffer with one extra attribute (`aFin`) telling
// the shader which vertices belong to which fin and how far out along it they
// sit. Two draw calls: the animal, and its eyes.
//
// The module also owns the **disturbance** — the churned patch and rising
// bubbles out toward the lighthouse island that the quest sends the player to
// investigate. `api.disturbance` is the public handle for it.

import * as THREE from 'three';
import {
  Fn, uniform, attribute, varying, uv, materialOpacity,
  positionLocal, positionGeometry, positionWorld, positionViewDirection,
  normalLocal, transformNormalToView, transformedNormalView, cameraPosition,
  vec2, vec3, vec4, float, floor, fract, mod, sin, cos, atan, abs, dot, mix,
  step, smoothstep, clamp as tslClamp, max as tslMax, length, oneMinus,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng, clamp } from '../core/rng.js';

const TAU = Math.PI * 2;

// --- dimensions -------------------------------------------------------------
// Built nose-first along -Z, so `forward` is -Z: the same convention as the boat.

const LEN = 34.0;
const HALF = LEN * 0.5;

// The place the quest points at. Out past the reef edge, on the line from the
// bay toward the lighthouse island but well clear of its rocks — about 250 m
// from the start, in roughly 15 m of water.
const DISTURB_X = 118;
const DISTURB_Z = -206;
const DISTURB_R = 11.5;

// The home circuit sits in genuinely deep water: the bathymetry only passes 25 m
// somewhere around r = 300, so the anchor is never allowed closer in than this.
const ANCHOR_MIN_R = 318;
const CIRCUIT_R = 96;
const HOME_X = 140;
const HOME_Z = -300;

// The shallowest floor the animal will deliberately swim over. Its spine rides
// 4.6 m off the bottom and the dorsal ridge stands about 4.2 m above the spine,
// so -13.5 leaves roughly four metres of water over its back. Any less and a
// 34 m leviathan is wading.
const MIN_FLOOR = -13.5;

// --- scratch (module scope; update() allocates nothing) ---------------------

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _m3 = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _head = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _look = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _IDENT = new THREE.Matrix4();
const _AXIS_Z = new THREE.Vector3(0, 0, 1);

function xf(px, py, pz, rx, ry, rz) {
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz), _q, new THREE.Vector3(1, 1, 1),
  );
}

/** Matrix laying a unit +Y cone (base at y=0, tip at y=1) from a point along a direction. */
function limb(fx, fy, fz, dx, dy, dz, len, rad) {
  _n.set(dx, dy, dz).normalize();
  _q.setFromUnitVectors(_UP, _n);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(fx, fy, fz), _q, new THREE.Vector3(rad, len, rad),
  );
}

// --- the mesher -------------------------------------------------------------
// One non-indexed buffer with position / normal / aFin. aFin.x is the part kind
// (0 body, 1 pectoral, 2 pelvic, 3 fluke) and aFin.y is 0 at the root and 1 at
// the tip — that pair is the entire animation rig.

function Mesher() { this.pos = []; this.nor = []; this.fin = []; }

Mesher.prototype.add = function add(geo, matrix, kind, spanFn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const pa = g.attributes.position.array;
  const na = g.attributes.normal.array;
  const count = g.attributes.position.count;
  _m3.getNormalMatrix(matrix || _IDENT);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    _v.set(pa[o], pa[o + 1], pa[o + 2]);
    const span = spanFn ? spanFn(_v.x, _v.y, _v.z) : 0;
    if (matrix) _v.applyMatrix4(matrix);
    this.pos.push(_v.x, _v.y, _v.z);
    _n.set(na[o], na[o + 1], na[o + 2]).applyMatrix3(_m3);
    if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
    this.nor.push(_n.x, _n.y, _n.z);
    this.fin.push(kind, span);
  }
  if (g !== geo) g.dispose();
  return this;
};

Mesher.prototype.build = function build() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
  geo.setAttribute('aFin', new THREE.BufferAttribute(new Float32Array(this.fin), 2));
  geo.computeBoundingSphere();
  // The vertex shader pushes the tail about a metre and a half sideways; the
  // static sphere would cull the animal at the edge of frame without this.
  if (geo.boundingSphere) geo.boundingSphere.radius *= 1.22;
  return geo;
};

/** Mirror a geometry across x, keeping the winding and the normals honest. */
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

// --- the body profile -------------------------------------------------------
// t runs 0 at the snout to 1 at the tip of the tail. halfW/halfH are the section
// semi-axes in metres; yc lifts the spine — a shallow arch through the shoulders
// falling away to a drooping tail.

const PROF = [
  //  t     halfW  halfH    yc
  [0.000, 0.030, 0.040, 0.30],
  [0.018, 0.620, 0.550, 0.26],
  [0.045, 1.180, 0.960, 0.20],
  [0.080, 1.720, 1.420, 0.15],
  [0.120, 2.050, 1.780, 0.12],
  [0.160, 1.860, 1.660, 0.20],
  [0.195, 1.640, 1.520, 0.36],
  [0.240, 2.550, 2.240, 0.58],
  [0.300, 3.300, 2.620, 0.80],
  [0.360, 3.180, 2.520, 0.86],
  [0.430, 2.720, 2.260, 0.78],
  [0.510, 2.120, 1.900, 0.58],
  [0.590, 1.550, 1.520, 0.30],
  [0.670, 1.100, 1.180, 0.00],
  [0.750, 0.760, 0.900, -0.30],
  [0.830, 0.500, 0.680, -0.58],
  [0.900, 0.320, 0.520, -0.80],
  [0.955, 0.190, 0.400, -0.94],
  [1.000, 0.030, 0.260, -1.02],
];

const _prof = [0, 0, 0];

function profileAt(t, out) {
  const n = PROF.length;
  if (t <= PROF[0][0]) { out[0] = PROF[0][1]; out[1] = PROF[0][2]; out[2] = PROF[0][3]; return out; }
  for (let i = 1; i < n; i++) {
    if (t <= PROF[i][0] || i === n - 1) {
      const a = PROF[i - 1], b = PROF[i];
      const span = b[0] - a[0];
      const f = span > 1e-6 ? clamp((t - a[0]) / span, 0, 1) : 0;
      const g = f * f * (3 - 2 * f);
      out[0] = a[1] + (b[1] - a[1]) * g;
      out[1] = a[2] + (b[2] - a[2]) * g;
      out[2] = a[3] + (b[3] - a[3]) * g;
      return out;
    }
  }
  return out;
}

/**
 * The torso. Superellipse sections rather than plain ellipses: the exponent
 * squares the silhouette off a little, which is what makes it read carved and
 * chunky instead of inflated. The belly is flattened; the back is not.
 */
function buildBody(stations, radial) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    profileAt(t, _prof);
    const w = _prof[0], h = _prof[1], yc = _prof[2];
    const z = -HALF + t * LEN;
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * TAU;
      const sa = Math.sin(a), ca = Math.cos(a);
      const px = w * Math.sign(sa) * Math.pow(Math.abs(sa), 0.82);
      let py = h * Math.sign(ca) * Math.pow(Math.abs(ca), 0.82);
      if (py < 0) py *= 0.82;
      pos.push(px, yc + py, z);
    }
  }
  for (let i = 0; i < stations; i++) {
    const a0 = i * radial, a1 = (i + 1) * radial;
    for (let k = 0; k < radial; k++) {
      const kn = (k + 1) % radial;
      idx.push(a0 + k, a1 + k, a1 + kn);
      idx.push(a0 + k, a1 + kn, a0 + kn);
    }
  }
  profileAt(0, _prof);
  const noseIdx = pos.length / 3;
  pos.push(0, _prof[2], -HALF - 0.34);
  for (let k = 0; k < radial; k++) idx.push(noseIdx, (k + 1) % radial, k);
  profileAt(1, _prof);
  const tailIdx = pos.length / 3;
  pos.push(0, _prof[2], HALF + 0.10);
  const last = stations * radial;
  for (let k = 0; k < radial; k++) idx.push(tailIdx, last + k, last + (k + 1) % radial);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A fin. `table` rows are [u, leadingZ, trailingZ, y, thickness]; u is the
 * fraction of the span. Each section is a four-point diamond, which keeps the
 * whole thing chunky and hand-cut rather than aerofoil-smooth.
 */
function buildFin(table, span) {
  const pos = [];
  const idx = [];
  const N = table.length;
  for (let i = 0; i < N; i++) {
    const r = table[i];
    const x = r[0] * span;
    const zl = r[1], zt = r[2], y = r[3];
    const zm = (zl + zt) * 0.5;
    const th = r[4] * 0.5;
    pos.push(x, y, zl, x, y + th, zm, x, y, zt, x, y - th, zm);
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

/** A closed box loft along z: rows are [z, halfW, yTop, yBottom]. */
function buildLoftBox(rows) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    pos.push(-r[1], r[2], r[0], r[1], r[2], r[0], r[1], r[3], r[0], -r[1], r[3], r[0]);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const a = i * 4, b = (i + 1) * 4;
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(a + k, b + k, b + k2);
      idx.push(a + k, b + k2, a + k2);
    }
  }
  idx.push(0, 1, 2, 0, 2, 3);
  const l = (rows.length - 1) * 4;
  idx.push(l, l + 2, l + 1, l, l + 3, l + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Planforms. The pectoral is enormous and swept: the leading edge rakes back
// until the tip trails behind the shoulder, which is the shape ref/04 reads as a
// pair of wings spread under the boat.
const FIN_PEC = [
  // u,   zLE,   zTE,     y,    th
  [0.00, -2.30, 2.60, 0.00, 0.55],
  [0.18, -2.70, 3.30, -0.22, 0.44],
  [0.40, -2.25, 4.70, -0.66, 0.30],
  [0.62, -0.85, 6.30, -1.22, 0.19],
  [0.82, 1.30, 7.70, -1.92, 0.10],
  [0.94, 3.70, 8.50, -2.50, 0.05],
  [1.00, 6.30, 8.90, -2.95, 0.02],
];

const FIN_PELVIC = [
  [0.00, -1.10, 1.20, 0.00, 0.45],
  [0.30, -1.00, 1.75, -0.30, 0.30],
  [0.62, -0.10, 2.40, -0.72, 0.17],
  [0.86, 1.10, 2.90, -1.15, 0.08],
  [1.00, 2.10, 3.10, -1.45, 0.02],
];

// The fluke is the same builder rolled into the vertical plane: one long upper
// lobe and a shorter lower one.
const FLUKE_UP = [
  [0.00, -2.60, 1.20, 0.00, 0.40],
  [0.26, -2.90, 1.60, 0.00, 0.28],
  [0.55, -2.60, 2.30, 0.00, 0.17],
  [0.80, -1.30, 2.90, 0.00, 0.08],
  [1.00, 0.90, 3.20, 0.00, 0.02],
];

const FLUKE_DN = [
  [0.00, -2.20, 1.00, 0.00, 0.36],
  [0.34, -2.30, 1.50, 0.00, 0.22],
  [0.70, -1.40, 2.10, 0.00, 0.11],
  [1.00, 0.30, 2.40, 0.00, 0.02],
];

const JAW = [
  [-16.80, 0.09, -0.14, -0.34],
  [-16.10, 0.58, -0.06, -0.86],
  [-15.10, 1.10, 0.02, -1.34],
  [-13.90, 1.50, 0.10, -1.66],
  [-12.70, 1.62, 0.16, -1.72],
  [-11.60, 1.36, 0.22, -1.44],
  [-10.90, 1.02, 0.26, -1.06],
];

// Horns, cheek spikes and the shoulder armour of ref/05. Every row is mirrored.
// fx, fy, fz, dx, dy, dz, len, rad
const HORNS = [
  [1.15, 1.62, -13.10, 0.44, 0.60, 0.67, 3.70, 0.30],
  [0.78, 1.42, -12.60, 0.56, 0.30, 0.78, 2.10, 0.20],
  [1.55, 0.30, -14.10, 0.86, 0.16, 0.48, 1.25, 0.17],
  [1.60, -0.15, -13.20, 0.90, -0.14, 0.42, 1.05, 0.15],
  [1.34, 0.62, -12.10, 0.72, 0.26, 0.64, 1.15, 0.15],
  [2.05, 0.95, -8.60, 0.62, 0.58, 0.53, 1.70, 0.24],
  [2.35, 0.30, -7.10, 0.80, 0.34, 0.50, 1.35, 0.20],
  [2.10, -0.45, -5.60, 0.84, -0.10, 0.53, 1.05, 0.17],
];

/** Dorsal ridge height at t — a bell over the shoulders with a long low tail. */
function spineHeight(t) {
  const d = (t - 0.32) / 0.27;
  return 0.20 + 1.30 * Math.exp(-d * d) + 0.34 * (1 - t) * (1 - t);
}

const PEC_SPAN = 8.8;
const PEL_SPAN = 3.7;
const FLUKE_UP_SPAN = 4.6;
const FLUKE_DN_SPAN = 2.9;

function buildMonster(rng) {
  const M = new Mesher();

  const body = buildBody(52, 16);
  M.add(body, null, 0, null);
  body.dispose();

  const jaw = buildLoftBox(JAW);
  M.add(jaw, null, 0, null);
  jaw.dispose();

  // One unit cone, base at y=0 and tip at y=1, placed by `limb`. Five sides
  // keeps the facets visible, which is what stops the silhouette going soft.
  const cone = new THREE.ConeGeometry(1, 1, 5, 1);
  cone.translate(0, 0.5, 0);

  for (let i = 0; i < HORNS.length; i++) {
    const h = HORNS[i];
    M.add(cone, limb(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]), 0, null);
    M.add(cone, limb(-h[0], h[1], h[2], -h[3], h[4], h[5], h[6], h[7]), 0, null);
  }

  const SPINES = 24;
  for (let i = 0; i < SPINES; i++) {
    const t = 0.135 + (i / (SPINES - 1)) * 0.79;
    profileAt(t, _prof);
    const z = -HALF + t * LEN;
    const y = _prof[2] + _prof[1] * 0.985;
    const len = spineHeight(t) * (0.85 + rng.range(0, 0.30));
    const rad = 0.10 + 0.10 * len;
    M.add(cone, limb(0, y - 0.08, z, 0, 1, 0.42 + 0.5 * t, len, rad), 0, null);
  }
  cone.dispose();

  const pecFn = (x) => clamp(Math.abs(x) / PEC_SPAN, 0, 1);
  const pec = buildFin(FIN_PEC, PEC_SPAN);
  const pecL = mirroredX(pec);
  M.add(pec, xf(2.55, 0.20, -6.30), 1, pecFn);
  M.add(pecL, xf(-2.55, 0.20, -6.30), 1, pecFn);
  pec.dispose(); pecL.dispose();

  const pelFn = (x) => clamp(Math.abs(x) / PEL_SPAN, 0, 1);
  const pel = buildFin(FIN_PELVIC, PEL_SPAN);
  const pelL = mirroredX(pel);
  M.add(pel, xf(1.15, -0.55, 3.80), 2, pelFn);
  M.add(pelL, xf(-1.15, -0.55, 3.80), 2, pelFn);
  pel.dispose(); pelL.dispose();

  const upFn = (x) => clamp(Math.abs(x) / FLUKE_UP_SPAN, 0, 1);
  const dnFn = (x) => clamp(Math.abs(x) / FLUKE_DN_SPAN, 0, 1);
  const fu = buildFin(FLUKE_UP, FLUKE_UP_SPAN);
  const fd = buildFin(FLUKE_DN, FLUKE_DN_SPAN);
  M.add(fu, xf(0, -0.95, 14.60, 0, 0, Math.PI * 0.5), 3, upFn);
  M.add(fd, xf(0, -1.05, 14.60, 0, 0, -Math.PI * 0.5), 3, dnFn);
  fu.dispose(); fd.dispose();

  return M.build();
}

// --- shading ----------------------------------------------------------------

// core/glsl.js's hash12 / vnoise / fbmV, as node graphs. Same constants, so the
// churn on the disturbance patch boils in exactly the same places it did.
const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(vec3(dot(p3, p3.yzx.add(33.33))));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const vnoise = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)).toVar();
  return mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), u.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

/** FBM_ROT * p * 2.03 — the octave twist, so the lattice never lines up. */
const fbmTwist = (p) => vec2(
  p.x.mul(0.8).add(p.y.mul(0.6)),
  p.x.mul(-0.6).add(p.y.mul(0.8)),
).mul(2.03);

/** fbmV(p, 3): the loop is unrolled because the octave count is a constant. */
const fbmV3 = Fn(([p0]) => {
  const p = p0.toVar();
  const s = vnoise(p).mul(0.5).toVar();
  p.assign(fbmTwist(p));
  s.addAssign(vnoise(p).mul(0.25));
  p.assign(fbmTwist(p));
  s.addAssign(vnoise(p).mul(0.125));
  return s.div(0.875);
});

// The leviathan's own shading. Every scrap of motion is still in the vertex
// stage; what used to be three GLSL injections is now `positionNode`,
// `normalNode` and a wrap around `setupOutput` (which is where the old
// `#include <opaque_fragment>` patch sat — before fog, after lighting).
function decorateMonsterMaterial(mat, uni) {
  const aFin = attribute('aFin', 'vec2');

  const monSway = Fn(([z, t]) => {
    const s = tslClamp(z.add(HALF).div(LEN), 0, 1).toVar();
    const amp = uni.uSwimAmp
      .mul(smoothstep(0.12, 0.96, s))
      .mul(s.mul(s).mul(0.82).add(0.18));
    return sin(t.mul(uni.uSwimRate).sub(s.mul(uni.uSwimWaves).mul(6.283185307))).mul(amp);
  });

  // Finite difference rather than the analytic derivative: three sines is cheap,
  // and the section yaw stays correct if the amplitude ramp is ever retuned.
  const monAngle = Fn(([z, t]) => atan(
    monSway(z.add(0.7), t).sub(monSway(z.sub(0.7), t)).mul(0.5 / 0.7),
  ));

  mat.positionNode = Fn(() => {
    const kind = aFin.x;
    const span = aFin.y;
    const isP = step(0.5, kind).mul(step(kind, 1.5));
    const isV = step(1.5, kind).mul(step(kind, 2.5));
    const f = span.mul(span);
    const w = sin(uni.uMTime.mul(uni.uFinRate));

    const ox = positionLocal.x.toVar();
    const py = positionLocal.y
      .add(w.mul(f).mul(uni.uFinAmp).mul(isP.add(isV.mul(0.5)))).toVar();
    const pz = positionLocal.z
      .add(oneMinus(cos(uni.uMTime.mul(uni.uFinRate))).mul(f).mul(uni.uFinAmp).mul(0.20).mul(isP))
      .toVar();

    const ma = monAngle(positionGeometry.z, uni.uMTime).toVar();
    const mc = cos(ma).toVar();
    const ms = sin(ma).toVar();

    return vec3(
      ox.mul(mc).add(monSway(positionGeometry.z, uni.uMTime)),
      py,
      pz.sub(ox.mul(ms)),
    );
  })();

  // The section yaw has to turn the normal with it or the tail lights as if it
  // were still straight. Computed per vertex, exactly as `beginnormal_vertex`
  // did, then handed to the shading normal in view space.
  const monNormal = Fn(() => {
    const ma = monAngle(positionGeometry.z, uni.uMTime).toVar();
    const mc = cos(ma).toVar();
    const ms = sin(ma).toVar();
    return vec3(
      normalLocal.x.mul(mc).add(normalLocal.z.mul(ms)),
      normalLocal.y,
      normalLocal.x.mul(ms).negate().add(normalLocal.z.mul(mc)),
    );
  })();
  mat.normalNode = transformNormalToView(varying(monNormal));

  const vMonShade = varying(
    smoothstep(-1.6, 2.4, positionGeometry.y).mul(0.34).add(aFin.y.mul(0.10)).add(0.78),
  );

  mat.colorNode = Fn(() => {
    const above = smoothstep(-1.8, 2.6, positionWorld.y);
    return mix(uni.uBodyWater, uni.uBodyAir, above).mul(vMonShade);
  })();

  // The lit result is dragged most of the way back to the flat body colour: a
  // leviathan under fifteen metres of water is a silhouette, not a shaded
  // model. Above the waterline it is allowed to light properly, which is what
  // gives ref/05 its wet slate armour.
  const monOutput = Fn(([lit]) => {
    const above = smoothstep(-1.8, 2.6, positionWorld.y).toVar();
    const base = mix(uni.uBodyWater, uni.uBodyAir, above).mul(vMonShade);
    const c = mix(base, lit, mix(uni.uLitMix, float(0.88), above)).toVar();
    const fres = oneMinus(
      tslClamp(dot(transformedNormalView, positionViewDirection), 0, 1),
    ).toVar();
    fres.assign(fres.mul(fres).mul(fres));
    c.addAssign(uni.uRim.mul(fres).mul(above.mul(0.60).add(0.40)));
    return c;
  });

  const superSetupOutput = mat.setupOutput.bind(mat);
  mat.setupOutput = (builder, outputNode) =>
    superSetupOutput(builder, vec4(monOutput(outputNode.rgb), outputNode.a));
}

// --- the disturbance --------------------------------------------------------

const BUBBLE_RISE = 13.0;

// The churned patch. Was a ShaderMaterial; now a NodeMaterial with a fragment
// node, which needs no vertex shader of its own — `uv()` gives the old `vLocal`
// and `positionWorld` the old `vWorld`.
//
// The two `discard`s are gone. Both were pure fill savings: outside r = 1 the
// ring and core masks are already zero, and the a < 0.004 cut is below what an
// 8-bit blend can carry, so dropping them changes no pixel.
function makePatchMaterial(uni) {
  const m = new THREE.NodeMaterial();
  m.fragmentNode = Fn(() => {
    const vLocal = uv().sub(0.5).mul(2.0).toVar();
    const r = length(vLocal).toVar();

    // A slow rotation on the coarse octave and an outward drift on the fine one:
    // the patch boils rather than scrolls.
    const ra = uni.uTime.mul(0.055).toVar();
    const rs = sin(ra).toVar();
    const rc = cos(ra).toVar();
    const q = vec2(
      vLocal.x.mul(rc).add(vLocal.y.mul(rs)),
      vLocal.x.mul(rs).negate().add(vLocal.y.mul(rc)),
    );
    const coarse = fbmV3(q.mul(2.3).add(vec2(uni.uTime.mul(0.021), uni.uTime.mul(-0.017))));
    const fine = fbmV3(
      vLocal.mul(6.5).add(vec2(uni.uTime.mul(-0.06), uni.uTime.mul(0.045))).add(17.3),
    );
    const churn = coarse.mul(0.62).add(fine.mul(0.38)).toVar();

    const ring = smoothstep(0.20, 0.62, r).mul(oneMinus(smoothstep(0.72, 1.0, r)));
    const core = oneMinus(smoothstep(0.0, 0.66, r)).toVar();
    const mask = tslMax(ring, core.mul(0.55));

    const a = mask.mul(smoothstep(0.40, 0.78, churn.add(core.mul(0.10)))).mul(uni.uOpacity).toVar();

    const c = uni.uFoam.mul(churn.mul(0.45).add(0.80)).toVar();
    const d = length(positionWorld.sub(cameraPosition));
    const fog = tslClamp(d.sub(uni.uFogNear).div(tslMax(float(1.0), uni.uFogFar.sub(uni.uFogNear))), 0, 1);
    c.assign(mix(c, uni.uFogColor, fog.mul(0.85)));
    return vec4(c, a);
  })();
  return m;
}

// The bubbles. `aBub` is (phase, speed, size) per instance.
//
// `positionNode` is evaluated after the node renderer has folded the instance
// matrix into `positionLocal`, so the old object-space `transformed *= aBub.z`
// has to be re-expressed. Every bubble's instance matrix here is a pure
// translation, so `positionLocal - positionGeometry` is exactly the instance
// origin and scaling the geometry about it is the same rescale the GLSL did.
function decorateBubbleMaterial(mat, uni) {
  const aBub = attribute('aBub', 'vec3');
  const bhNode = mod(uni.uBTime.mul(aBub.y).add(aBub.x), BUBBLE_RISE);

  mat.positionNode = Fn(() => {
    const bh = bhNode.toVar();
    const wob = bh.mul(0.45).add(aBub.x.mul(7.0)).toVar();
    const t = bh.div(BUBBLE_RISE).toVar();
    const p = positionLocal.add(positionGeometry.mul(aBub.z.sub(1.0))).toVar();
    return vec3(
      p.x.add(sin(uni.uBTime.mul(1.3).add(wob)).mul(0.30).mul(t)),
      p.y.add(bh),
      p.z.add(cos(uni.uBTime.mul(1.1).add(wob.mul(1.3))).mul(0.30).mul(t)),
    );
  })();

  const vBubA = varying(
    smoothstep(0.0, 1.4, bhNode)
      .mul(oneMinus(smoothstep(BUBBLE_RISE * 0.80, BUBBLE_RISE, bhNode))),
  );
  // `diffuseColor.a *= vBubA`, with the material's own opacity still in play.
  mat.opacityNode = materialOpacity.mul(vBubA);
}

// --- quest handshake --------------------------------------------------------
// The quest module belongs to someone else, so this reads generously and never
// depends on any particular field existing. If none of it matches, the proximity
// fallback in update() still gets the encounter going.

function questWantsApproach(ctx) {
  const q = ctx.quest && ctx.quest.state;
  if (!q) return false;
  if (q.monsterApproach === true || q.alerted === true || q.summonMonster === true) return true;
  if (q.reachedDisturbance === true || q.atDisturbance === true) return true;
  const raw = q.stage ?? q.phase ?? q.step ?? q.state ?? q.objective ?? q.key;
  if (typeof raw !== 'string') return false;
  const k = raw.toLowerCase();
  return k.indexOf('approach') >= 0 || k.indexOf('encounter') >= 0
    || k.indexOf('arriv') >= 0 || k.indexOf('reach') >= 0
    || k.indexOf('confront') >= 0 || k.indexOf('breach') >= 0
    || k.indexOf('leviathan') >= 0 || k.indexOf('monster') >= 0;
}

// ---------------------------------------------------------------- the module

export function createMonster(opts = {}) {
  const group = new THREE.Group();
  group.name = 'monster';

  const seed = (opts.seed | 0) || 20260807;
  const rng = makeRng((seed ^ 0x1ea71a) >>> 0);
  // See TIERS in core/renderer.js — one budget, no tier-name ladder.
  const geoBudget = opts.quality?.geometry ?? 1;
  const terrain = opts.terrain || null;

  // Fall back to the layout in CONTRACT.md if the terrain module is not
  // answering, so the animal never swims through a floor it cannot see.
  const seabed = (terrain && typeof terrain.seabedHeight === 'function')
    ? terrain.seabedHeight
    : (x, z) => {
      const r = Math.sqrt(x * x + z * z);
      return r <= 200 ? -(2.6 + 5.1 * (r / 200)) : -(7.7 + 26 * Math.min(1, (r - 200) / 380));
    };

  const uni = {
    uMTime: uniform(0),
    uSwimAmp: uniform(1.45),
    uSwimRate: uniform(0.62),
    uSwimWaves: uniform(0.85),
    uFinAmp: uniform(0.95),
    uFinRate: uniform(0.34),
    uBodyWater: uniform(new THREE.Color(0.010, 0.020, 0.050)),
    uBodyAir: uniform(new THREE.Color(0.020, 0.060, 0.100)),
    uRim: uniform(new THREE.Color(0.030, 0.090, 0.120)),
    uLitMix: uniform(0.46),
    uBTime: uniform(0),
  };

  // ---- the animal --------------------------------------------------------
  // DoubleSide on purpose: a hand-lofted shell has a couple of caps whose
  // winding is not worth arguing with, and three flips the normal on back faces
  // so the shading comes out right either way.

  const geo = buildMonster(rng);
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide,
    fog: true,
    dithering: true,
  });
  decorateMonsterMaterial(mat, uni);

  // `group` is the static root main.js adds to the scene. Only `body` moves —
  // the disturbance hangs off the root, not off the animal, or it would be
  // dragged round the bay on the leviathan's back.
  const body = new THREE.Group();
  body.name = 'leviathan-body';
  group.add(body);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'leviathan';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  body.add(mesh);

  // Eyes. Small, unlit, warm — the one thing in the silhouette that is not a
  // hole in the water. They sit forward of where the spine sway begins, so they
  // ride the body transform and need no shader of their own.
  const eyeGeo = new THREE.SphereGeometry(0.23, 8, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffb755, fog: true });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-1.58, 0.75, -14.10);
  eyeR.position.set(1.58, 0.75, -14.10);
  eyeL.castShadow = false;
  eyeR.castShadow = false;
  body.add(eyeL, eyeR);

  setLayers(group, LAYER.MAIN, LAYER.UNDERWATER, LAYER.REFLECTED);

  // ---- the disturbance ---------------------------------------------------

  const disturbGroup = new THREE.Group();
  disturbGroup.name = 'disturbance';
  const disturbPos = new THREE.Vector3(DISTURB_X, 0, DISTURB_Z);

  const patchUni = {
    uTime: uniform(0),
    uFoam: uniform(new THREE.Color(0.80, 0.90, 1.00)),
    uOpacity: uniform(0.6),
    uFogColor: uniform(new THREE.Color(0.5, 0.6, 0.7)),
    uFogNear: uniform(200),
    uFogFar: uniform(2000),
  };
  const patchGeo = new THREE.CircleGeometry(DISTURB_R, 44);
  patchGeo.rotateX(-Math.PI / 2);
  const patchMat = makePatchMaterial(patchUni);
  patchMat.transparent = true;
  patchMat.depthWrite = false;
  patchMat.side = THREE.DoubleSide;
  patchMat.fog = false;           // it fogs itself, against the world position
  const patch = new THREE.Mesh(patchGeo, patchMat);
  patch.position.y = 0.16;
  patch.castShadow = false;
  patch.receiveShadow = false;
  patch.renderOrder = 4;
  disturbGroup.add(patch);

  const bubbleCount = Math.round(42 + (118 - 42) * Math.min(1, Math.max(0, (geoBudget - 0.42) / 0.58)));
  const bubbleGeo = new THREE.IcosahedronGeometry(1, 0);
  const bubBase = clamp(seabed(DISTURB_X, DISTURB_Z) + 0.8, -BUBBLE_RISE - 4, -3);
  const bubMat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.35,
    metalness: 0.0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    fog: true,
  });
  decorateBubbleMaterial(bubMat, uni);
  const bubbles = new THREE.InstancedMesh(bubbleGeo, bubMat, bubbleCount);
  bubbles.castShadow = false;
  bubbles.receiveShadow = false;
  bubbles.renderOrder = 3;
  {
    const aBub = new Float32Array(bubbleCount * 3);
    for (let i = 0; i < bubbleCount; i++) {
      const a = rng.range(0, TAU);
      const rr = Math.pow(rng.next(), 0.55) * DISTURB_R * 0.78;
      _p.set(Math.cos(a) * rr, bubBase, Math.sin(a) * rr);
      _q.identity();
      _s.setScalar(1);
      _m4.compose(_p, _q, _s);
      bubbles.setMatrixAt(i, _m4);
      aBub[i * 3] = rng.range(0, BUBBLE_RISE);
      aBub[i * 3 + 1] = rng.range(1.05, 2.30);
      aBub[i * 3 + 2] = rng.range(0.055, 0.185);
    }
    bubbles.instanceMatrix.needsUpdate = true;
    bubbleGeo.setAttribute('aBub', new THREE.InstancedBufferAttribute(aBub, 3));
    bubbles.computeBoundingSphere();
    if (bubbles.boundingSphere) bubbles.boundingSphere.radius += BUBBLE_RISE;
  }
  disturbGroup.add(bubbles);

  disturbGroup.position.copy(disturbPos);
  group.add(disturbGroup);
  setLayers(patch, LAYER.MAIN);
  setLayers(bubbles, LAYER.MAIN, LAYER.UNDERWATER);

  // ---- state -------------------------------------------------------------

  const position = new THREE.Vector3(HOME_X * 0.5, -21, HOME_Z - 40);
  const velocity = new THREE.Vector3(0, 0, -4);
  const anchor = new THREE.Vector3(HOME_X, 0, HOME_Z);
  const desired = new THREE.Vector3();

  const state = {
    position,
    heading: 0,
    depth: 21,
    distance: 260,
    surfaced: 0,
    phase: 'cruise',
    alerted: false,
    disturbance: disturbPos,
  };

  let phase = 'cruise';
  let phaseT = 0;
  let circuitU = 0;
  let bank = 0;
  let speed = 4.0;
  let nearDisturbT = 0;
  let breachCooldown = 30;
  let approachLock = 0;
  let flybyT = 20;
  let flyby = 0;
  let ringDone = false;
  let lastY = position.y;
  let stampT = 0;

  const brP0 = new THREE.Vector3();
  const brP1 = new THREE.Vector3();
  const brP2 = new THREE.Vector3();
  let brT = 0;
  const BREACH_TIME = 4.6;

  // Keep the circuit anchor out of the islands. The bathymetry is essentially
  // radial, so pushing away from the origin buys the depth; these three circles
  // buy the clearance.
  const KEEP_OUT = [
    [-150, -60, 150],     // village island
    [215, -195, 108],     // lighthouse island
    [340, -70, 82],       // the outer pine-topped rock
  ];

  function deepenAnchor(v) {
    const r = Math.hypot(v.x, v.z);
    if (r < ANCHOR_MIN_R) {
      if (r > 1e-3) { const k = ANCHOR_MIN_R / r; v.x *= k; v.z *= k; }
      else v.set(0, 0, -ANCHOR_MIN_R);
    }
    for (let i = 0; i < KEEP_OUT.length; i++) {
      const k = KEEP_OUT[i];
      const dx = v.x - k[0], dz = v.z - k[1];
      const d = Math.hypot(dx, dz);
      if (d < k[2]) {
        if (d > 1e-3) { const f = k[2] / d; v.x = k[0] + dx * f; v.z = k[1] + dz * f; }
        else v.x = k[0] + k[2];
      }
    }
    return v;
  }

  /** Walk a target point outward until the animal actually fits under it. */
  function pushDeep(v) {
    for (let i = 0; i < 8; i++) {
      if (seabed(v.x, v.z) < MIN_FLOOR) break;
      const r = Math.hypot(v.x, v.z);
      if (r > 720) break;
      if (r > 1e-3) { const f = (r + 34) / r; v.x *= f; v.z *= f; } else v.z = -60;
    }
    return v;
  }

  /** Deepest the spine may sit at (x, z): a body-height clear of the floor. */
  function floorLimit(x, z) {
    const h = seabed(x, z);
    return (Number.isFinite(h) ? h : -30) + 4.6;
  }

  function bezier(out, t) {
    const it = 1 - t;
    const a = it * it, b = 2 * it * t, c = t * t;
    out.set(
      brP0.x * a + brP1.x * b + brP2.x * c,
      brP0.y * a + brP1.y * b + brP2.y * c,
      brP0.z * a + brP1.z * b + brP2.z * c,
    );
    return out;
  }

  function setPhase(next) {
    phase = next;
    state.phase = next;
    phaseT = 0;
  }

  function beginBreach(surfaceX, surfaceZ) {
    brP0.copy(position);
    _dir.set(surfaceX - position.x, 0, surfaceZ - position.z);
    if (_dir.lengthSq() < 1e-4) _dir.set(velocity.x, 0, velocity.z);
    if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
    _dir.normalize();
    const ex = surfaceX + _dir.x * 46;
    const ez = surfaceZ + _dir.z * 46;
    brP2.set(ex, Math.max(-15, floorLimit(ex, ez)), ez);
    // Solve the control point for a *chosen* apex rather than adding a fixed
    // lift: a quadratic through B(0.5) = (P0 + 2*P1 + P2)/4 means P1 has to
    // start from where the ends actually are. Adding a constant instead let a
    // breach that began near the surface throw thirty metres of leviathan into
    // the sky.
    const apex = 9.5 + rng.range(0, 3.5);
    brP1.set(
      (brP0.x + brP2.x) * 0.5,
      2 * apex - 0.5 * (brP0.y + brP2.y),
      (brP0.z + brP2.z) * 0.5,
    );
    brT = 0;
    ringDone = false;
    setPhase('breach');
  }

  // ---- the frame ---------------------------------------------------------

  function orient(dt) {
    if (velocity.lengthSq() < 1e-6) return;
    _look.copy(velocity).normalize();
    _az.copy(_look).multiplyScalar(-1);           // object +Z runs down the tail
    _v.copy(_UP);
    if (Math.abs(_v.dot(_az)) > 0.985) _v.set(0, 0, _az.y > 0 ? 1 : -1);
    _ax.crossVectors(_v, _az).normalize();
    _ay.crossVectors(_az, _ax).normalize();
    _m4.makeBasis(_ax, _ay, _az);
    _q.setFromRotationMatrix(_m4);
    _qr.setFromAxisAngle(_AXIS_Z, bank);
    _q.multiply(_qr);
    body.quaternion.slerp(_q, Math.min(1, dt * 2.4));
  }

  /**
   * Slow, heavy steering: the velocity takes a couple of seconds to come round,
   * which is what gives the long lazy arcs the art has. The yaw rate falls out
   * of the turn and drives the bank.
   */
  function steerTo(tx, ty, tz, want, dt) {
    desired.set(tx - position.x, ty - position.y, tz - position.z);
    const d = desired.length();
    if (d > 1e-4) desired.multiplyScalar(want / d);
    else desired.copy(velocity);
    const prevYaw = Math.atan2(velocity.x, -velocity.z);
    velocity.lerp(desired, Math.min(1, dt * 0.55));
    let dyaw = Math.atan2(velocity.x, -velocity.z) - prevYaw;
    while (dyaw > Math.PI) dyaw -= TAU;
    while (dyaw < -Math.PI) dyaw += TAU;
    const rate = dt > 1e-5 ? dyaw / dt : 0;
    bank += (clamp(rate * 2.6, -0.55, 0.55) - bank) * Math.min(1, dt * 1.6);
  }

  function update(ctx) {
    const dt = ctx.dt;
    const t = ctx.time;
    uni.uMTime.value = t;
    uni.uBTime.value = t;
    patchUni.uTime.value = t;

    const boat = ctx.boat;
    const bx = boat ? boat.position.x : 0;
    const bz = boat ? boat.position.z : 0;
    const water = ctx.water;

    phaseT += dt;
    breachCooldown -= dt;
    approachLock -= dt;
    flybyT -= dt;
    stampT += dt;

    // --- triggers ---------------------------------------------------------
    const dxq = bx - DISTURB_X, dzq = bz - DISTURB_Z;
    const atDisturbance = (dxq * dxq + dzq * dzq) < 48 * 48;
    nearDisturbT = atDisturbance ? nearDisturbT + dt : 0;
    const wantApproach = questWantsApproach(ctx) || nearDisturbT > 2.4 || state.alerted;

    if (phase === 'cruise' && wantApproach && approachLock <= 0) setPhase('approach');

    // --- behaviour --------------------------------------------------------
    if (phase === 'breach') {
      brT += dt / BREACH_TIME;
      _prev.copy(position);
      bezier(position, clamp(brT, 0, 1));
      if (dt > 1e-5) velocity.copy(position).sub(_prev).multiplyScalar(1 / dt);
      bank += (0 - bank) * Math.min(1, dt * 1.2);
      speed = velocity.length();

      // Hammer the ripple sim along the path while the animal is near the
      // surface. The wake window is only 128 m across, so anything further out
      // than that would be thrown away anyway — do not spend the stamps.
      if (water && water.disturb) {
        _dir.set(velocity.x, 0, velocity.z);
        if (_dir.lengthSq() > 1e-6) _dir.normalize(); else _dir.set(0, 0, -1);
        _head.copy(position).addScaledVector(_dir, 15);
        const near = Math.hypot(_head.x - bx, _head.z - bz) < 58;
        if (near && position.y > -9 && stampT > 0.07) {
          stampT = 0;
          const st = clamp(1.2 + Math.abs(velocity.y) * 0.16, 0.6, 3.4);
          water.disturb(_head.x, _head.z, st, 5.5 + 3.0 * clamp(position.y / 8 + 1, 0, 1));
          water.disturb(position.x, position.z, st * 0.7, 8.5);
        }
        // The crash. One ring of stamps, once, as the body goes back through.
        if (!ringDone && lastY > 0.5 && position.y <= 0.5) {
          ringDone = true;
          if (Math.hypot(position.x - bx, position.z - bz) < 62) {
            water.disturb(position.x, position.z, 5.0, 13.0);
            for (let i = 0; i < 10; i++) {
              const a = (i / 10) * TAU;
              water.disturb(position.x + Math.cos(a) * 11, position.z + Math.sin(a) * 11, 2.6, 6.5);
            }
          }
        }
      }
      lastY = position.y;
      if (brT >= 1) {
        breachCooldown = 34 + rng.range(0, 22);
        approachLock = 65;
        setPhase('dive');
      }
    } else {
      // Where the circuit is centred. It eases onto the boat only while the boat
      // is somewhere the animal fits; otherwise it falls back to deep water.
      if (seabed(bx, bz) < MIN_FLOOR) _tgt.set(bx, 0, bz);
      else _tgt.set(HOME_X, 0, HOME_Z);
      deepenAnchor(_tgt);
      anchor.lerp(_tgt, 1 - Math.exp(-dt / 22));

      if (phase === 'cruise') {
        if (flyby > 0) {
          // A deliberate pass under the boat. This is the ref/04 shot and it is
          // not left to chance — but it is only ever attempted while the boat is
          // floating over water deep enough to hide 34 m of leviathan.
          flyby -= dt;
          const away = Math.hypot(position.x - bx, position.z - bz);
          _dir.set(bx - position.x, 0, bz - position.z);
          if (_dir.lengthSq() < 1) _dir.copy(velocity).setY(0);
          _dir.normalize();
          _tgt.set(bx + _dir.x * 70, 0, bz + _dir.z * 70);
          pushDeep(_tgt);
          const lim = floorLimit(_tgt.x, _tgt.z);
          steerTo(_tgt.x, Math.min(-11, Math.max(-20, lim)), _tgt.z, 5.4, dt);
          if (flyby <= 0 || away > 340 || seabed(bx, bz) > MIN_FLOOR) {
            flyby = 0;
            flybyT = 46 + rng.range(0, 34);
          }
        } else {
          circuitU += dt * 0.032;
          const ca = Math.cos(circuitU * TAU), sa = Math.sin(circuitU * TAU);
          _tgt.set(anchor.x + ca * CIRCUIT_R * 1.25, 0, anchor.z + sa * CIRCUIT_R);
          const depthWant = 19 + 5.5 * Math.sin(t * 0.052 + 1.3);
          const lim = floorLimit(_tgt.x, _tgt.z);
          steerTo(_tgt.x, Math.min(-9, Math.max(-depthWant, lim)), _tgt.z, 4.2, dt);
          if (flybyT <= 0 && seabed(bx, bz) < MIN_FLOOR
            && Math.hypot(position.x - bx, position.z - bz) < 340) flyby = 42;
        }
        speed = velocity.length();

        // The idle breach in the middle distance — ref/05's establishing shot.
        if (breachCooldown <= 0) {
          const d = Math.hypot(position.x - bx, position.z - bz);
          if (d > 80 && d < 300) {
            _dir.set(bx - position.x, 0, bz - position.z).normalize();
            beginBreach(position.x + _dir.x * 34, position.z + _dir.z * 34);
          } else {
            breachCooldown = 12;
          }
        }
      } else if (phase === 'approach') {
        // Rises toward the boat, quicker and shallower every second. It has to
        // get genuinely shallow to be worth anything: at twenty metres the
        // water column absorbs ninety-odd per cent of the silhouette and a
        // thirty-four metre animal reads as a faint smudge. Around seven, it
        // reads as the shadow in ref/04.
        const rise = clamp(phaseT / 12, 0, 1);
        const depthWant = 19 - 12.5 * rise;
        _dir.set(bx - position.x, 0, bz - position.z);
        const away = _dir.length();
        if (away < 1) _dir.copy(velocity).setY(0);
        _dir.normalize();
        _tgt.set(bx + _dir.x * 40, 0, bz + _dir.z * 40);
        pushDeep(_tgt);
        const lim = floorLimit(_tgt.x, _tgt.z);
        steerTo(_tgt.x, Math.min(-7.5, Math.max(-depthWant, lim)), _tgt.z, 4.6 + 2.6 * rise, dt);
        speed = velocity.length();

        if (water && water.disturb && away < 55 && position.y > -13 && stampT > 0.22) {
          stampT = 0;
          water.disturb(position.x, position.z, 0.55, 7.0);
        }
        if (phaseT > 27 || (away < 26 && phaseT > 17)) {
          _dir.set(bx - position.x, 0, bz - position.z);
          if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
          _dir.normalize();
          const jx = boat ? boat.right.x : 1;
          const jz = boat ? boat.right.z : 0;
          const j = rng.range(-14, 14);
          beginBreach(bx + _dir.x * 26 + jx * j, bz + _dir.z * 26 + jz * j);
        }
      } else {
        // dive — sink away, slow down, then fold back into the circuit.
        const lim = floorLimit(position.x, position.z);
        const depthWant = Math.min(-14, Math.max(-25, lim));
        _dir.copy(velocity).setY(0);
        if (_dir.lengthSq() < 1) _dir.set(0, 0, -1);
        _dir.normalize();
        steerTo(position.x + _dir.x * 90, depthWant, position.z + _dir.z * 90,
          5.0 - 2.0 * clamp(phaseT / 14, 0, 1), dt);
        speed = velocity.length();
        if (phaseT > 20) { state.alerted = false; nearDisturbT = 0; setPhase('cruise'); }
      }

      // Shallow-water bail-out. It runs after whatever the phase wanted and
      // overrides it, because a phase only ever vets its *target*: the line the
      // animal takes to get there can still cross the reef, and 34 m of
      // leviathan aground on a coral head is the one thing that must never
      // happen. The bathymetry is radial, so "outward" is "deeper".
      const floorHere = seabed(position.x, position.z);
      if (Number.isFinite(floorHere) && floorHere > MIN_FLOOR) {
        const r = Math.hypot(position.x, position.z) || 1;
        const urgency = clamp((floorHere - MIN_FLOOR) / 6, 0, 1);
        desired.set(position.x / r * 6.5, -1.4, position.z / r * 6.5);
        velocity.lerp(desired, Math.min(1, dt * (0.9 + 3.6 * urgency)));
      }

      position.addScaledVector(velocity, dt);
      // Floor first, ceiling last: if the water is too thin for both, the
      // ceiling wins. A dark shape clipping a reef head for a couple of seconds
      // is invisible; a leviathan standing in the shallows is not.
      const lim = floorLimit(position.x, position.z);
      if (position.y < lim) { position.y = lim; if (velocity.y < 0) velocity.y *= 0.2; }
      if (position.y > -3.5) { position.y = -3.5; if (velocity.y > 0) velocity.y *= 0.2; }
      lastY = position.y;
    }

    orient(dt);
    body.position.copy(position);

    // The tail beats harder the faster it swims; the fins keep their own, much
    // longer cycle so the two never lock into one rhythm.
    const sp = clamp(speed, 0, 12);
    uni.uSwimRate.value = 0.42 + sp * 0.115;
    uni.uSwimAmp.value = 1.15 + sp * 0.075;
    uni.uFinRate.value = 0.28 + sp * 0.030;

    // ---- exported state --------------------------------------------------
    state.heading = Math.atan2(velocity.x, -velocity.z);
    state.depth = Math.max(0, -position.y);
    state.distance = Math.hypot(position.x - bx, position.z - bz);
    // 0 while it is anywhere near its cruising ceiling, 1 once the head and
    // shoulders are clear — the HUD reads this to decide it has been sighted.
    state.surfaced = clamp((position.y + 2.0) / 8.0, 0, 1);
    state.phase = phase;

    // Keep the disturbance boiling when the boat is close enough for the ripple
    // sim to see it at all.
    if (water && water.disturb && atDisturbance && stampT > 0.30) {
      stampT = 0;
      const a = rng.range(0, TAU);
      const rr = rng.range(0, DISTURB_R * 0.8);
      water.disturb(DISTURB_X + Math.cos(a) * rr, DISTURB_Z + Math.sin(a) * rr, 0.75, 3.6);
    }
  }

  function applyEnv(env) {
    if (!env) return;

    // Underwater body: darker than the colour the refraction target is cleared
    // to, or it stops being a shadow and starts being an object.
    _c.copy(env.waterDeep).multiplyScalar(0.30);
    _c2.copy(env.ambientGround).multiplyScalar(0.55);
    _c.lerp(_c2, 0.30);
    _c2.copy(env.waterScatter).multiplyScalar(0.022);
    _c.add(_c2);
    uni.uBodyWater.value.copy(_c);

    // In air it is wet slate: the mid-water colour crushed and pulled toward the
    // sky ambient, which keeps it blue at noon and violet at sunset.
    _c.copy(env.waterMid).multiplyScalar(0.30);
    _c2.copy(env.ambientSky).multiplyScalar(0.12);
    _c.lerp(_c2, 0.35);
    uni.uBodyAir.value.copy(_c);

    // The rim is the water's own light grazing the silhouette, nothing else.
    _c.copy(env.waterShallow).lerp(env.keyColor, 0.35)
      .multiplyScalar(0.055 + 0.045 * env.dayFactor);
    uni.uRim.value.copy(_c);
    uni.uLitMix.value = 0.40 + 0.14 * env.dayFactor;

    // The eyes take the practical warmth of the village lamps, so they warm and
    // cool with the hour instead of sitting at a fixed amber.
    _c.copy(env.windowLight).multiplyScalar(0.55 + 0.85 * env.nightFactor);
    eyeMat.color.copy(_c);

    patchUni.uFoam.value.copy(env.foamTint).multiplyScalar(0.55 + 0.55 * env.foamBrightness);
    patchUni.uOpacity.value = 0.34 + 0.34 * env.dayFactor;
    patchUni.uFogColor.value.copy(env.fogColor);
    patchUni.uFogNear.value = env.fogNear;
    patchUni.uFogFar.value = env.fogFar;

    _c.copy(env.foamTint).lerp(env.waterShallow, 0.35);
    bubMat.color.copy(_c);
    bubMat.emissive.copy(env.waterScatter).multiplyScalar(0.10 + 0.20 * env.nightFactor);
    bubMat.opacity = 0.34 + 0.28 * env.dayFactor;
  }

  function dispose() {
    geo.dispose();
    mat.dispose();
    eyeGeo.dispose();
    eyeMat.dispose();
    patchGeo.dispose();
    patchMat.dispose();
    bubbleGeo.dispose();
    bubMat.dispose();
    bubbles.dispose();
    group.clear();
  }

  // Prime the exported state so the HUD and the quest have sane numbers on the
  // very first frame, before update() has ever run.
  body.position.copy(position);
  state.heading = Math.atan2(velocity.x, -velocity.z);
  state.depth = Math.max(0, -position.y);

  return {
    group,
    state,
    update,
    applyEnv,
    dispose,

    /** Where the quest sends the player. Read-only for everyone else. */
    disturbance: { position: disturbPos, radius: DISTURB_R },
    disturbancePosition: disturbPos,

    /** Let the quest drive the encounter explicitly if it would rather. */
    alert() { state.alerted = true; approachLock = 0; if (phase === 'cruise') setPhase('approach'); },
    calm() { state.alerted = false; if (phase === 'approach') setPhase('dive'); },

    /** Force a breach at a surface point, or straight ahead if none is given. */
    breach(x, z) {
      if (phase === 'breach') return;
      if (typeof x === 'number' && typeof z === 'number') { beginBreach(x, z); return; }
      _dir.copy(velocity).setY(0);
      if (_dir.lengthSq() < 1) _dir.set(0, 0, -1);
      _dir.normalize();
      beginBreach(position.x + _dir.x * 34, position.z + _dir.z * 34);
    },
  };
}
