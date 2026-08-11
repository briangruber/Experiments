// The player's dinghy.
//
// A 4.6 m carvel-ish skiff: cream painted planking under a broad honey timber
// capping rail, a hard chine, a blunt pointed stem and a transom-hung outboard.
// The hull is a proper loft — ten stations, each a section from keel to sheer,
// skinned into one indexed shell so the normals stay smooth and the chine stays
// hard where two rows of coincident vertices break the seam.
//
// Everything that does not move is merged into a handful of vertex-coloured
// meshes; the outboard, the rod and the lantern stay separate because they are
// animated. Nine draw calls for the whole boat, plus one dark silhouette on
// LAYER.UNDERWATER so the hull's shadow reads through the water.
//
// Orientation note — see the report/comment at `update()`: the bow is built
// along local -Z and the group is yawed by -heading, which is what puts the
// stem on `ctx.boat.forward`.

import * as THREE from 'three';
import {
  Fn, positionGeometry, float, vec2, vec3, floor, fract, dot, mix, mod,
  smoothstep as tslSmoothstep,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const TAU = Math.PI * 2;

// --- palette (albedo only; every light and every tint comes from env) --------

const CREAM = C(0xF4EEE0);
const BOOT = C(0x2B3B4E);
const BOTTOM = C(0x93A39C);
const HONEY = C(0xCFAE83);
const HONEY_DK = C(0xA8855A);
const HONEY_LT = C(0xE3C9A2);
const TIMBER_DK = C(0x7A5C3C);
const RUBBER = C(0x3A2E28);
const NAVY = C(0x252D3C);
const NAVY_LT = C(0x39445A);
const STEEL = C(0x6E7684);
const ALLOY = C(0x9AA1A8);
const BRASS = C(0xB88A3E);
const RING_ORANGE = C(0xE2662A);
const RING_WHITE = C(0xEFE7DA);
const OLIVE = C(0x4E5A31);
const ROPE = C(0xC9B48C);
const LINE = C(0xD8D6C6);
const DARK_UNDER = C(0x0B1622);

// --- scratch (module scope; nothing allocates in update) --------------------

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
const _mtx = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _tp = new THREE.Vector3();
const _ts = new THREE.Vector3();

function xf(px, py, pz, rx, ry, rz, sx, sy, sz) {
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  return _mtx.compose(
    _tp.set(px, py, pz), _q,
    _ts.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz),
  );
}

// --- geometry merger --------------------------------------------------------
// Concatenates primitives into one vertex-coloured buffer. Build time only.

function Merger() {
  this.pos = [];
  this.nor = [];
  this.col = [];
}

Merger.prototype.addGeo = function addGeo(geo, matrix, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  _m3.getNormalMatrix(matrix);
  const count = g.attributes.position.count;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    _v.set(p[o], p[o + 1], p[o + 2]).applyMatrix4(matrix);
    this.pos.push(_v.x, _v.y, _v.z);
    _v.set(n[o], n[o + 1], n[o + 2]).applyMatrix3(_m3);
    if (_v.lengthSq() < 1e-12) _v.set(0, 1, 0); else _v.normalize();
    this.nor.push(_v.x, _v.y, _v.z);
    this.col.push(color.r, color.g, color.b);
  }
  if (g !== geo) g.dispose();
  geo.dispose();
  return this;
};

Merger.prototype.tri = function tri(a, b, c, color) {
  _a.subVectors(b, a);
  _b.subVectors(c, a);
  _n.crossVectors(_a, _b);
  if (_n.lengthSq() < 1e-14) return this;
  _n.normalize();
  const pts = [a, b, c];
  for (let i = 0; i < 3; i++) {
    this.pos.push(pts[i].x, pts[i].y, pts[i].z);
    this.nor.push(_n.x, _n.y, _n.z);
    this.col.push(color.r, color.g, color.b);
  }
  return this;
};

Merger.prototype.quad = function quad(a, b, c, d, color) {
  this.tri(a, b, c, color);
  this.tri(a, c, d, color);
  return this;
};

/** Quad whose winding is corrected so its face normal agrees with `hint`. */
Merger.prototype.quadOut = function quadOut(a, b, c, d, color, hx, hy, hz) {
  _a.subVectors(b, a);
  _b.subVectors(c, a);
  _c.crossVectors(_a, _b);
  if (_c.x * hx + _c.y * hy + _c.z * hz < 0) {
    this.tri(a, d, c, color);
    this.tri(a, c, b, color);
  } else {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }
  return this;
};

Merger.prototype.build = function build() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
  g.computeBoundingSphere();
  return g;
};

// --- primitives -------------------------------------------------------------

function roundedBox(w, h, d, r, seg) {
  const rr = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  const s = seg || 2;
  const g = new THREE.BoxGeometry(w, h, d, s, s, s);
  const p = g.attributes.position;
  const hw = w * 0.5 - rr, hh = h * 0.5 - rr, hd = d * 0.5 - rr;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const cx = Math.max(-hw, Math.min(hw, x));
    const cy = Math.max(-hh, Math.min(hh, y));
    const cz = Math.max(-hd, Math.min(hd, z));
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) {
      p.setXYZ(i, cx + (dx / l) * rr, cy + (dy / l) * rr, cz + (dz / l) * rr);
    }
  }
  g.computeVertexNormals();
  return g;
}

// --- the hull loft ----------------------------------------------------------
// z runs bow (-2.30) to transom (+2.30). halfBeam is at the chine.

const STATION = [
  // z,      halfBeam, draft, sheer
  [-2.300, 0.085, 0.100, 0.870],
  [-2.080, 0.205, 0.190, 0.828],
  [-1.720, 0.405, 0.278, 0.778],
  [-1.240, 0.620, 0.340, 0.722],
  [-0.620, 0.822, 0.375, 0.665],
  [0.000, 0.925, 0.386, 0.628],
  [0.620, 0.950, 0.380, 0.608],
  [1.220, 0.925, 0.356, 0.602],
  [1.780, 0.860, 0.306, 0.615],
  [2.300, 0.770, 0.236, 0.640],
];

// Half-section, keel outward. mode 0 -> y = -draft * f, 1 -> y = sheer * f,
// 2 -> y = f. Index 4/5 are coincident: that pair is the hard chine.
const PROFILE = [
  [0.000, 0, 1.00],
  [0.340, 0, 0.94],
  [0.700, 0, 0.60],
  [0.930, 0, 0.18],
  [1.000, 2, 0.045],
  [1.000, 2, 0.045],
  [0.995, 1, 0.42],
  [0.968, 1, 0.80],
  [0.930, 1, 1.00],
];
const PN = PROFILE.length;          // 9
const RING = PN * 2 - 1;            // 17
const KEEL = PN - 1;                // 8
const SEAM_A = 3;                   // degenerate loft band (port chine)
const SEAM_B = RING - 5;            // 12 (starboard chine)

function profileY(mode, f, draft, sheer) {
  if (mode === 0) return -draft * f;
  if (mode === 1) return sheer * f;
  return f;
}

function ringPoint(s, j, out) {
  const st = STATION[s];
  const hb = st[1], draft = st[2], sheer = st[3];
  let idx, sign;
  if (j < KEEL) { idx = PN - 1 - j; sign = -1; } else { idx = j - KEEL; sign = 1; }
  const pr = PROFILE[idx];
  return out.set(sign * pr[0] * hb, profileY(pr[1], pr[2], draft, sheer), st[0]);
}

function lerpStation(z, field) {
  if (z <= STATION[0][0]) return STATION[0][field];
  const last = STATION.length - 1;
  if (z >= STATION[last][0]) return STATION[last][field];
  for (let i = 0; i < last; i++) {
    const a = STATION[i], b = STATION[i + 1];
    if (z <= b[0]) {
      const t = (z - a[0]) / (b[0] - a[0]);
      return a[field] + (b[field] - a[field]) * t;
    }
  }
  return STATION[last][field];
}
const halfBeamAt = (z) => lerpStation(z, 1);
const sheerAt = (z) => lerpStation(z, 3);

function buildHullGeometry() {
  const ns = STATION.length;
  const pos = [];
  const idx = [];
  const push = (s, j) => {
    ringPoint(s, j, _v);
    pos.push(_v.x, _v.y, _v.z);
  };
  for (let s = 0; s < ns; s++) for (let j = 0; j < RING; j++) push(s, j);

  const at = (s, j) => s * RING + j;
  for (let s = 0; s < ns - 1; s++) {
    for (let j = 0; j < RING - 1; j++) {
      if (j === SEAM_A || j === SEAM_B) continue;
      const a = at(s, j), b = at(s, j + 1), c = at(s + 1, j + 1), d = at(s + 1, j);
      idx.push(a, b, c, a, c, d);
    }
  }

  // Caps get their own vertex block so the transom and stem edges stay crisp.
  const stemBase = pos.length / 3;
  for (let j = 0; j < RING; j++) push(0, j);
  const tranBase = pos.length / 3;
  for (let j = 0; j < RING; j++) push(ns - 1, j);

  for (let j = 0; j < RING - 1; j++) {
    if (j === SEAM_A || j === SEAM_B || j === KEEL - 1 || j === KEEL) continue;
    idx.push(tranBase + KEEL, tranBase + j, tranBase + j + 1);
    idx.push(stemBase + KEEL, stemBase + j + 1, stemBase + j);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// --- shader: painted planking, boot line, bottom paint ----------------------
//
// This used to be an `onBeforeCompile` patch against the MeshStandardMaterial
// chunk graph. `onBeforeCompile` DOES NOT EXIST in the WebGPU build — grep the
// vendored bundle, it is zero hits — so for the whole life of the TSL port the
// hook was never called and the hull rendered as its base material: flat
// `color: 0xffffff`, roughness 0.56. Against bright tropical water, through the
// bloom, a pure-white unbroken shell washes out to nearly the value of the
// water behind it, which is what "the boat is see-through" was describing.
// Nothing about it was transparent; it had no albedo left to be opaque with.
//
// Same field, as a node graph. `positionGeometry` is the raw local attribute —
// the old `position.xyz` varying — so the planking is pinned to the hull and
// not to the world, and every constant below is the one the GLSL used.
//
// It is a MeshStandardNodeMaterial, not a plain MeshStandardMaterial with a
// colorNode hung on it, for the reason spelled out at wildlife.js:895: two
// plain standard materials that differ only in their node graph collide on
// `customProgramCacheKey` and the second silently renders with the first's
// shader. The old `customProgramCacheKey` override here was exactly that trap.

// core/glsl.js's hash12 / vnoise as node graphs — the same port coral.js uses,
// so the planking grain lands where it did in GLSL.
const hullHash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(vec3(dot(p3, p3.yzx.add(33.33))));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const hullNoise = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)).toVar();
  return mix(
    mix(hullHash12(i), hullHash12(i.add(vec2(1, 0))), u.x),
    mix(hullHash12(i.add(vec2(0, 1))), hullHash12(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

const tsl = (c) => vec3(c.r, c.g, c.b);

function makeHullMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.56,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  // Plank index, shared by the albedo and the roughness so the caulk seam is
  // dark AND matte, which is what actually reads as a lapped seam at 20 px.
  const plankLip = Fn(() => {
    const pf = fract(positionGeometry.y.sub(0.055).div(0.118)).toVar();
    return tslSmoothstep(0.0, 0.07, pf).mul(tslSmoothstep(0.90, 1.0, pf).oneMinus());
  });

  mat.colorNode = Fn(() => {
    const hy = positionGeometry.y.toVar();
    const plank = hy.sub(0.055).div(0.118).toVar();
    const lip = plankLip().toVar();
    const alt = mod(floor(plank), 2.0).toVar();
    const hc = tsl(CREAM)
      .mul(float(0.90).add(lip.mul(0.10)))
      .mul(float(0.975).add(alt.mul(0.05)))
      .toVar();
    const hn = hullNoise(vec2(
      positionGeometry.x.mul(4.0).add(positionGeometry.z.mul(1.7)),
      hy.mul(11.0),
    )).toVar();
    hc.mulAssign(float(0.955).add(hn.mul(0.085)));
    hc.assign(mix(hc, tsl(CREAM).mul(0.78), tslSmoothstep(0.34, 0.10, hy).mul(0.55)));
    hc.assign(mix(hc, tsl(BOOT), tslSmoothstep(0.118, 0.086, hy)));
    hc.assign(mix(hc, tsl(BOTTOM), tslSmoothstep(-0.015, -0.055, hy)));
    return hc;
  })();

  // Topsides are painted and semi-gloss; the antifouled bottom is chalky. The
  // seam between planks holds a little more roughness than the plank face.
  mat.roughnessNode = Fn(() => float(0.62)
    .sub(plankLip().mul(0.10))
    .add(tslSmoothstep(0.02, -0.05, positionGeometry.y).mul(0.28)))();

  return mat;
}

// ============================================================================

export function createBoat(opts = {}) {
  const rng = makeRng(((opts.seed | 0) ^ 0x51a17b) >>> 0);
  const group = new THREE.Group();
  group.name = 'boat';

  const geometries = [];
  const materials = [];
  const track = (g) => { geometries.push(g); return g; };
  const trackM = (m) => { materials.push(m); return m; };

  const jitter = (base, amt) => base.clone().multiplyScalar(1 + (rng.next() - 0.5) * amt);

  // ---- hull ---------------------------------------------------------------

  const hullGeo = track(buildHullGeometry());
  const hullMat = trackM(makeHullMaterial());
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  // ---- timber: rail, strake, decks, thwarts, floorboards ------------------

  const tm = new Merger();

  // Capping rail, swept along the sheer on both sides.
  const RAIL_TOP = 0.078;
  const RAIL_DROP = 0.030;
  const railPts = [];   // per station, per side: [outerTop, innerTop, outerBot, innerBot]
  for (let s = 0; s < STATION.length; s++) {
    const st = STATION[s];
    const hb = st[1], sheer = st[3], z = st[0];
    const xo = 0.988 * hb, xi = 0.780 * hb;
    railPts.push({
      z, sheer,
      xo, xi,
      yt: sheer + RAIL_TOP,
      yb: sheer - RAIL_DROP,
    });
  }
  for (let side = -1; side <= 1; side += 2) {
    for (let s = 0; s < railPts.length - 1; s++) {
      const p = railPts[s], q = railPts[s + 1];
      const col = jitter(HONEY_LT, 0.10);
      const colIn = jitter(HONEY, 0.08);
      const po = new THREE.Vector3(side * p.xo, p.yt, p.z);
      const pi = new THREE.Vector3(side * p.xi, p.yt, p.z);
      const qo = new THREE.Vector3(side * q.xo, q.yt, q.z);
      const qi = new THREE.Vector3(side * q.xi, q.yt, q.z);
      const pob = new THREE.Vector3(side * p.xo, p.yb, p.z);
      const qob = new THREE.Vector3(side * q.xo, q.yb, q.z);
      const pib = new THREE.Vector3(side * p.xi, p.yb, p.z);
      const qib = new THREE.Vector3(side * q.xi, q.yb, q.z);
      tm.quadOut(po, qo, qi, pi, col, 0, 1, 0);              // top
      tm.quadOut(po, qo, qob, pob, col, side, 0.15, 0);      // outboard face
      tm.quadOut(pi, qi, qib, pib, colIn, -side, 0.15, 0);   // inboard face
    }
  }
  // Stem head cap and transom cap close the rail loop.
  tm.addGeo(roundedBox(0.30, 0.10, 0.44, 0.035, 2), xf(0, 0.885, -2.16), jitter(HONEY_LT, 0.08));
  {
    const st = STATION[STATION.length - 1];
    tm.addGeo(
      roundedBox(2 * st[1] * 0.99, 0.098, 0.185, 0.032, 2),
      xf(0, st[3] + RAIL_TOP - 0.049, st[0] - 0.055),
      jitter(HONEY_LT, 0.06),
    );
  }

  // Rubbing strake.
  for (let side = -1; side <= 1; side += 2) {
    for (let s = 0; s < STATION.length - 1; s++) {
      const A = STATION[s], B = STATION[s + 1];
      const ya = A[3] * 0.52, yb = B[3] * 0.52;
      const xa0 = side * A[1] * 0.986, xa1 = side * A[1] * 1.040;
      const xb0 = side * B[1] * 0.986, xb1 = side * B[1] * 1.040;
      const col = jitter(TIMBER_DK, 0.10);
      const a0 = new THREE.Vector3(xa1, ya + 0.043, A[0]);
      const a1 = new THREE.Vector3(xa1, ya - 0.043, A[0]);
      const b0 = new THREE.Vector3(xb1, yb + 0.043, B[0]);
      const b1 = new THREE.Vector3(xb1, yb - 0.043, B[0]);
      const a0i = new THREE.Vector3(xa0, ya + 0.043, A[0]);
      const a1i = new THREE.Vector3(xa0, ya - 0.043, A[0]);
      const b0i = new THREE.Vector3(xb0, yb + 0.043, B[0]);
      const b1i = new THREE.Vector3(xb0, yb - 0.043, B[0]);
      tm.quadOut(a0, b0, b1, a1, col, side, 0, 0);       // outboard face
      tm.quadOut(a0, b0, b0i, a0i, col, 0, 1, 0);        // top lip
      tm.quadOut(a1, b1, b1i, a1i, col, 0, -1, 0);       // under lip
    }
  }

  // Floorboards (the sole) — athwartships planks over the bilge.
  const SOLE_Y = 0.075;
  for (let z = -1.28; z < 2.06; z += 0.185) {
    const w = halfBeamAt(z) * 1.62;
    tm.addGeo(
      new THREE.BoxGeometry(w, 0.036, 0.150),
      xf(0, SOLE_Y, z),
      jitter(HONEY, 0.16),
    );
  }
  // Two fore-and-aft stringers under the sole edge.
  for (let side = -1; side <= 1; side += 2) {
    tm.addGeo(
      new THREE.BoxGeometry(0.055, 0.10, 3.30),
      xf(side * 0.60, SOLE_Y - 0.062, 0.38),
      jitter(HONEY_DK, 0.10),
    );
  }

  // Raised foredeck.
  for (let i = 0; i < 6; i++) {
    const x = -0.60 + i * 0.24;
    const zc = -1.78;
    const len = 0.92;
    tm.addGeo(
      new THREE.BoxGeometry(0.215, 0.045, len * (1 - Math.abs(x) * 0.32)),
      xf(x, sheerAt(zc) - 0.055, zc - Math.abs(x) * 0.22),
      jitter(HONEY, 0.14),
    );
  }
  tm.addGeo(new THREE.BoxGeometry(1.30, 0.075, 0.09), xf(0, sheerAt(-1.30) - 0.075, -1.30), jitter(HONEY_DK, 0.08));

  // Quarter (side) decks aft — the lantern and the fuel can live on these.
  for (let side = -1; side <= 1; side += 2) {
    tm.addGeo(new THREE.BoxGeometry(0.30, 0.055, 0.90), xf(side * 0.585, 0.585, 1.78), jitter(HONEY, 0.12));
    tm.addGeo(new THREE.BoxGeometry(0.30, 0.16, 0.06), xf(side * 0.585, 0.505, 1.34), jitter(HONEY_DK, 0.10));
  }

  // Transom liner.
  tm.addGeo(new THREE.BoxGeometry(1.40, 0.42, 0.055), xf(0, 0.335, 2.215), jitter(HONEY_DK, 0.08));

  // Thwarts. The aft one is the fisher's seat.
  const SEAT_Z = 1.05;
  const SEAT_Y = 0.358;
  tm.addGeo(new THREE.BoxGeometry(1.58, 0.072, 0.335), xf(0, SEAT_Y - 0.036, SEAT_Z), jitter(HONEY_LT, 0.08));
  tm.addGeo(new THREE.BoxGeometry(1.52, 0.070, 0.315), xf(0, 0.352, -0.45), jitter(HONEY_LT, 0.08));
  for (let side = -1; side <= 1; side += 2) {
    tm.addGeo(new THREE.BoxGeometry(0.075, 0.16, 0.10), xf(side * 0.66, 0.245, SEAT_Z), jitter(HONEY_DK, 0.08));
    tm.addGeo(new THREE.BoxGeometry(0.075, 0.16, 0.10), xf(side * 0.63, 0.240, -0.45), jitter(HONEY_DK, 0.08));
  }

  // Cleats: bow plus one each side amidships.
  const cleat = (x, y, z, ry) => {
    tm.addGeo(new THREE.BoxGeometry(0.055, 0.052, 0.15), xf(x, y, z, 0, ry, 0), HONEY_DK);
    tm.addGeo(new THREE.BoxGeometry(0.045, 0.038, 0.24), xf(x, y + 0.042, z, 0, ry, 0), HONEY_DK);
  };
  cleat(0, 0.945, -2.14, 0);
  cleat(0.755, sheerAt(-0.62) + RAIL_TOP + 0.022, -0.62, 0);
  cleat(-0.755, sheerAt(-0.62) + RAIL_TOP + 0.022, -0.62, 0);

  // A crate and a bucket in the bilge.
  tm.addGeo(roundedBox(0.36, 0.28, 0.30, 0.028, 2), xf(-0.40, SOLE_Y + 0.158, -0.98, 0, 0.18, 0), jitter(HONEY_DK, 0.10));
  tm.addGeo(new THREE.BoxGeometry(0.37, 0.035, 0.31), xf(-0.40, SOLE_Y + 0.30, -0.98, 0, 0.18, 0), jitter(HONEY, 0.08));

  const timberGeo = track(tm.build());
  const timberMat = trackM(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.74, metalness: 0.0, flatShading: true,
  }));
  const timber = new THREE.Mesh(timberGeo, timberMat);
  timber.castShadow = true;
  timber.receiveShadow = true;
  group.add(timber);

  // ---- gear: life ring, jerry can, rope, painter, bucket, line ------------

  const gm = new Merger();

  // Life ring on the starboard quarter, hung outboard.
  {
    // Emitted by hand so each vertex keeps its orange/white band colour.
    const ring = new THREE.TorusGeometry(0.225, 0.062, 7, 26);
    const nonIdx = ring.toNonIndexed();
    const np = nonIdx.attributes.position;
    const nn = nonIdx.attributes.normal;
    const mtx = xf(0.895, 0.415, 1.80, 0, Math.PI / 2, 0.10);
    _m3.getNormalMatrix(mtx);
    for (let i = 0; i < np.count; i++) {
      _v.set(np.getX(i), np.getY(i), np.getZ(i));
      const ang = Math.atan2(_v.y, _v.x);
      const sector = Math.floor(((ang + TAU) % TAU) / (TAU / 8));
      const cc = sector % 2 === 0 ? RING_ORANGE : RING_WHITE;
      _v.applyMatrix4(mtx);
      gm.pos.push(_v.x, _v.y, _v.z);
      _v.set(nn.getX(i), nn.getY(i), nn.getZ(i)).applyMatrix3(_m3).normalize();
      gm.nor.push(_v.x, _v.y, _v.z);
      gm.col.push(cc.r, cc.g, cc.b);
    }
    nonIdx.dispose();
    ring.dispose();
  }
  // Lashing that holds the ring to the rail.
  gm.addGeo(new THREE.BoxGeometry(0.055, 0.20, 0.030), xf(0.865, 0.560, 1.80, 0, 0, 0.16), ROPE);

  // Jerry can on the starboard side deck.
  gm.addGeo(roundedBox(0.155, 0.30, 0.215, 0.030, 2), xf(0.585, 0.762, 1.62, 0, 0.06, 0), OLIVE);
  gm.addGeo(new THREE.CylinderGeometry(0.030, 0.034, 0.045, 8), xf(0.585, 0.928, 1.545), OLIVE.clone().multiplyScalar(0.7));
  gm.addGeo(new THREE.BoxGeometry(0.165, 0.036, 0.036), xf(0.585, 0.895, 1.70), OLIVE.clone().multiplyScalar(1.15));

  // Coil of rope on the foredeck.
  gm.addGeo(new THREE.TorusGeometry(0.155, 0.032, 5, 18), xf(-0.24, sheerAt(-1.75) - 0.010, -1.74, Math.PI / 2, 0, 0, 1, 1, 0.62), ROPE);
  gm.addGeo(new THREE.TorusGeometry(0.105, 0.030, 5, 16), xf(-0.24, sheerAt(-1.75) + 0.022, -1.74, Math.PI / 2, 0, 0, 1, 1, 0.62), jitter(ROPE, 0.10));

  // Painter, made off at the bow and trailing into the water.
  {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.02, 0.955, -2.12),
      new THREE.Vector3(0.16, 0.62, -2.52),
      new THREE.Vector3(0.13, 0.24, -2.86),
      new THREE.Vector3(0.05, 0.02, -3.02),
    ]);
    gm.addGeo(new THREE.TubeGeometry(curve, 14, 0.018, 4, false), xf(0, 0, 0), ROPE);
  }

  // Bucket.
  gm.addGeo(new THREE.CylinderGeometry(0.145, 0.118, 0.235, 10), xf(0.40, SOLE_Y + 0.135, -1.06), C(0xB8C0BA));
  gm.addGeo(new THREE.TorusGeometry(0.128, 0.014, 4, 12), xf(0.40, SOLE_Y + 0.255, -1.06, Math.PI / 2, 0, 0), C(0x8A9490));

  // ---- fishing rod --------------------------------------------------------

  const ROD_BASE = new THREE.Vector3(0.660, 0.505, 1.220);
  const ROD_DIR = new THREE.Vector3(0.244, 0.914, 0.325).normalize();
  const ROD_LEN = 2.60;
  const rodTip = ROD_BASE.clone().addScaledVector(ROD_DIR, ROD_LEN);
  const rodGrip = ROD_BASE.clone().addScaledVector(ROD_DIR, 0.36);

  // Rod holder, mounted inside the starboard rail.
  gm.addGeo(
    new THREE.CylinderGeometry(0.042, 0.046, 0.24, 8),
    (() => {
      _q.setFromUnitVectors(_a.set(0, 1, 0), ROD_DIR);
      return _mtx.compose(
        _tp.copy(ROD_BASE).addScaledVector(ROD_DIR, 0.06), _q, _ts.set(1, 1, 1),
      );
    })(),
    TIMBER_DK,
  );

  // Fishing line: hangs from the tip out to the water. Static in boat space —
  // the rod's spring is a couple of centimetres and the line reads fine.
  {
    const curve = new THREE.CatmullRomCurve3([
      rodTip.clone(),
      new THREE.Vector3(1.62, 1.86, 1.92),
      new THREE.Vector3(1.90, 0.78, 1.48),
      new THREE.Vector3(1.98, 0.03, 1.10),
    ]);
    gm.addGeo(new THREE.TubeGeometry(curve, 16, 0.0085, 3, false), xf(0, 0, 0), LINE);
  }

  const gearGeo = track(gm.build());
  const gearMat = trackM(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.02,
  }));
  const gear = new THREE.Mesh(gearGeo, gearMat);
  gear.castShadow = true;
  gear.receiveShadow = true;
  group.add(gear);

  // ---- metal fittings material (shared by outboard, rod, prop) ------------

  const metalMat = trackM(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.44, metalness: 0.45,
  }));

  // Rod assembly on its own pivot so the tip can spring.
  const rodPivot = new THREE.Group();
  rodPivot.position.copy(ROD_BASE);
  group.add(rodPivot);
  {
    const rm = new Merger();
    _q.setFromUnitVectors(_a.set(0, 1, 0), ROD_DIR);
    const R = new THREE.Matrix4().makeRotationFromQuaternion(_q);
    const along = (dist, geo, color, extra) => {
      const m = new THREE.Matrix4().makeTranslation(0, dist, 0);
      if (extra) m.multiply(extra);
      rm.addGeo(geo, new THREE.Matrix4().copy(R).multiply(m), color);
    };
    along(0.115, new THREE.CylinderGeometry(0.027, 0.030, 0.23, 8), C(0x3A2C24));
    along(0.255, new THREE.CylinderGeometry(0.032, 0.032, 0.06, 8), ALLOY);
    along(1.50, new THREE.CylinderGeometry(0.0065, 0.021, 2.36, 6), C(0x241E1B));
    // reel, offset off the blank
    along(0.255, new THREE.CylinderGeometry(0.062, 0.062, 0.052, 12),
      C(0x55606B), new THREE.Matrix4().makeTranslation(-0.075, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
    along(0.255, new THREE.CylinderGeometry(0.020, 0.020, 0.055, 8),
      ALLOY, new THREE.Matrix4().makeTranslation(-0.140, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
    // three guides up the blank
    for (let i = 0; i < 3; i++) {
      const d = 0.85 + i * 0.62;
      along(d, new THREE.TorusGeometry(0.026, 0.006, 4, 10), ALLOY,
        new THREE.Matrix4().makeTranslation(0.030, 0, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    }
    const rodGeo = track(rm.build());
    const rodMesh = new THREE.Mesh(rodGeo, metalMat);
    rodMesh.castShadow = true;
    rodPivot.add(rodMesh);
  }

  // ---- outboard motor -----------------------------------------------------

  const OUT_X = -0.300;
  const OUT_Z = 2.345;
  const outboard = new THREE.Group();
  outboard.position.set(OUT_X, 0, OUT_Z);
  group.add(outboard);
  {
    const om = new Merger();
    // transom bracket + clamps
    om.addGeo(roundedBox(0.235, 0.30, 0.155, 0.035, 2), xf(0, 0.585, -0.045), NAVY_LT);
    om.addGeo(new THREE.CylinderGeometry(0.030, 0.030, 0.20, 8), xf(-0.095, 0.475, -0.075, Math.PI / 2, 0, 0), STEEL);
    om.addGeo(new THREE.CylinderGeometry(0.030, 0.030, 0.20, 8), xf(0.095, 0.475, -0.075, Math.PI / 2, 0, 0), STEEL);
    // cowling
    om.addGeo(roundedBox(0.395, 0.455, 0.435, 0.105, 3), xf(0, 0.845, 0.185), NAVY);
    om.addGeo(roundedBox(0.345, 0.070, 0.385, 0.030, 2), xf(0, 0.622, 0.185), NAVY_LT);
    om.addGeo(new THREE.BoxGeometry(0.30, 0.012, 0.045), xf(0, 0.870, 0.400), ALLOY);
    // midsection and leg
    om.addGeo(roundedBox(0.145, 0.60, 0.215, 0.050, 2), xf(0, 0.290, 0.170), NAVY);
    om.addGeo(roundedBox(0.130, 0.42, 0.190, 0.045, 2), xf(0, -0.100, 0.170), NAVY);
    // anti-cavitation plate
    om.addGeo(roundedBox(0.315, 0.028, 0.290, 0.012, 2), xf(0, -0.288, 0.185), ALLOY);
    // gearcase
    om.addGeo(new THREE.CapsuleGeometry(0.078, 0.28, 4, 10), xf(0, -0.385, 0.185, Math.PI / 2, 0, 0), NAVY);
    // skeg
    om.addGeo(new THREE.BoxGeometry(0.032, 0.175, 0.185), xf(0, -0.475, 0.135), NAVY);
    // tiller handle
    om.addGeo(new THREE.CylinderGeometry(0.026, 0.030, 0.52, 8),
      xf(-0.155, 0.760, -0.135, -1.30, 0, 0.42), C(0x2A2A30));
    om.addGeo(new THREE.CylinderGeometry(0.034, 0.034, 0.14, 8),
      xf(-0.275, 0.700, -0.375, -1.30, 0, 0.42), C(0x1E1E24));
    const outGeo = track(om.build());
    const outMesh = new THREE.Mesh(outGeo, metalMat);
    outMesh.castShadow = true;
    outboard.add(outMesh);
  }

  // Propeller — its own child so it can spin.
  const propGroup = new THREE.Group();
  propGroup.position.set(0, -0.385, 0.345);
  outboard.add(propGroup);
  {
    const pm = new Merger();
    pm.addGeo(new THREE.CylinderGeometry(0.042, 0.052, 0.075, 10), xf(0, 0, 0, Math.PI / 2, 0, 0), ALLOY);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      const m = new THREE.Matrix4().makeRotationZ(a)
        .multiply(new THREE.Matrix4().makeTranslation(0, 0.082, 0))
        .multiply(new THREE.Matrix4().makeRotationY(0.55));
      pm.addGeo(new THREE.BoxGeometry(0.075, 0.105, 0.014), m, STEEL);
    }
    const propGeo = track(pm.build());
    const propMesh = new THREE.Mesh(propGeo, metalMat);
    propGroup.add(propMesh);
  }

  // ---- lantern on the port quarter ---------------------------------------

  const LANTERN = new THREE.Vector3(-0.585, 0.613, 1.86);
  const lanternGroup = new THREE.Group();
  lanternGroup.position.copy(LANTERN);
  group.add(lanternGroup);

  const brassMat = trackM(new THREE.MeshStandardMaterial({
    color: BRASS, roughness: 0.34, metalness: 0.72,
  }));
  const glassMat = trackM(new THREE.MeshStandardMaterial({
    color: C(0x3A2A12), roughness: 0.18, metalness: 0.0,
    emissive: C(0xFFB25A), emissiveIntensity: 1.0,
  }));

  {
    const lm = new Merger();
    lm.addGeo(new THREE.CylinderGeometry(0.062, 0.072, 0.045, 10), xf(0, 0.022, 0), BRASS);
    lm.addGeo(new THREE.CylinderGeometry(0.050, 0.058, 0.035, 10), xf(0, 0.058, 0), BRASS);
    // cage uprights
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      lm.addGeo(new THREE.BoxGeometry(0.012, 0.135, 0.012),
        xf(Math.cos(a) * 0.049, 0.145, Math.sin(a) * 0.049), BRASS);
    }
    lm.addGeo(new THREE.CylinderGeometry(0.055, 0.050, 0.028, 10), xf(0, 0.226, 0), BRASS);
    lm.addGeo(new THREE.CylinderGeometry(0.020, 0.070, 0.065, 10), xf(0, 0.272, 0), BRASS);
    lm.addGeo(new THREE.SphereGeometry(0.020, 8, 6), xf(0, 0.310, 0), BRASS);
    lm.addGeo(new THREE.TorusGeometry(0.058, 0.008, 4, 12, Math.PI), xf(0, 0.318, 0, 0, Math.PI / 2, 0), BRASS);
    const lgeo = track(lm.build());
    lgeo.deleteAttribute('color');
    const lmesh = new THREE.Mesh(lgeo, brassMat);
    lmesh.castShadow = true;
    lanternGroup.add(lmesh);
  }
  const glassGeo = track(new THREE.CylinderGeometry(0.044, 0.046, 0.140, 10));
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.position.set(0, 0.146, 0);
  lanternGroup.add(glass);

  const lanternLight = new THREE.PointLight(0xffb25a, 1.0, 3.6, 1.7);
  lanternLight.position.set(0, 0.150, 0);
  lanternLight.castShadow = false;
  lanternGroup.add(lanternLight);

  // ---- underwater silhouette ---------------------------------------------
  // Shares the hull buffer; the refraction pass clips it at y <= 0.12, so all
  // that survives is the wetted hull and the outboard leg.

  const underGroup = new THREE.Group();
  const underMat = trackM(new THREE.MeshBasicMaterial({
    color: DARK_UNDER, fog: true, side: THREE.FrontSide,
  }));
  const underHull = new THREE.Mesh(hullGeo, underMat);
  underHull.scale.set(1.01, 1.0, 1.005);
  underGroup.add(underHull);
  {
    const um = new Merger();
    um.addGeo(roundedBox(0.145, 1.05, 0.215, 0.050, 2), xf(OUT_X, -0.06, OUT_Z + 0.17), DARK_UNDER);
    um.addGeo(roundedBox(0.330, 0.030, 0.300, 0.012, 2), xf(OUT_X, -0.288, OUT_Z + 0.185), DARK_UNDER);
    um.addGeo(new THREE.CapsuleGeometry(0.085, 0.30, 4, 8), xf(OUT_X, -0.385, OUT_Z + 0.185, Math.PI / 2, 0, 0), DARK_UNDER);
    um.addGeo(new THREE.BoxGeometry(0.040, 0.185, 0.195), xf(OUT_X, -0.475, OUT_Z + 0.135), DARK_UNDER);
    const ugeo = track(um.build());
    ugeo.deleteAttribute('color');
    underGroup.add(new THREE.Mesh(ugeo, underMat));
  }
  group.add(underGroup);

  // ---- layers -------------------------------------------------------------

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  setLayers(underGroup, LAYER.UNDERWATER);
  // Without this the boat reflected its own hull bottom and propeller instead
  // of its topsides. One call on `group` reaches underGroup too.
  applyWaterClip(group);

  // ---- state --------------------------------------------------------------

  let lanternBase = 1.0;
  let glassBase = 1.0;
  let smoothRoll = 0;
  let smoothLift = 0;
  let propSpin = 0;
  const warmLight = new THREE.Color();

  const api = {
    group,

    // Anchors other modules can hang off (boat-local space).
    seat: new THREE.Vector3(0, SEAT_Y, SEAT_Z),
    rodGrip,
    rodTip,
    lanternPosition: LANTERN.clone(),

    applyEnv(env) {
      const li = env.lanternIntensity;
      warmLight.copy(env.windowLight);
      lanternLight.color.copy(warmLight);
      lanternBase = li * 2.6;
      glassBase = 0.35 + li * 2.2;
      // Never toggle a LIGHT's visibility. three keys every render object on
      // [object, material, renderContext, lightsNode], so changing which
      // lights exist builds a different lights node, every render object in
      // the scene misses the chain map, and all of them are disposed and
      // recompiled — synchronously, on WebGPU. Measured: one 8.5-second
      // frame at the hour this crossed. Intensity 0 costs one dead light
      // loop per fragment and nothing else.
      glass.visible = true;
      glassMat.emissive.copy(warmLight);
      glassMat.emissiveIntensity = glassBase;

      // The submerged silhouette is a shadow in the water, so its colour is the
      // deep-water body colour crushed down rather than a picked black.
      underMat.color.copy(env.waterDeep).multiplyScalar(0.34);
      underMat.color.r = Math.min(underMat.color.r, 0.06);
    },

    update(ctx) {
      const b = ctx.boat;
      const t = ctx.time;
      const dt = ctx.dt;

      // The scaffold's heading grows clockwise from north while three's
      // rotation.y is counter-clockwise, so the yaw is negated: that is what
      // puts the bow (built along local -Z) onto ctx.boat.forward. trim is
      // negated for the same reason — negative trim means bow-up in the
      // controller, and positive rotation.x is bow-up with the bow at -Z.
      group.position.copy(b.position);

      // A little extra life on top of what the controller gives: sample the
      // wave field across the beam for a slow roll, and a lazy bob.
      let extraRoll = 0;
      const w = ctx.water;
      if (w && w.sampleHeight) {
        const sx = Math.cos(b.heading);
        const sz = Math.sin(b.heading);
        const hs = w.sampleHeight(b.position.x + sx * 0.95, b.position.z + sz * 0.95, t);
        const hp = w.sampleHeight(b.position.x - sx * 0.95, b.position.z - sz * 0.95, t);
        extraRoll = Math.atan2(hs - hp, 1.9) * 0.42;
      }
      const k = Math.min(1, dt * 3.2);
      smoothRoll += (extraRoll - smoothRoll) * k;
      smoothLift += ((Math.sin(t * 0.83) * 0.011 + Math.sin(t * 1.47 + 1.9) * 0.006) - smoothLift) * k;
      group.position.y += smoothLift;

      group.rotation.set(
        -b.trim + Math.sin(t * 0.61 + 0.7) * 0.006,
        -b.heading,
        b.heel + smoothRoll,
        'YXZ',
      );

      // Outboard: idles with a faint shiver, buzzes under throttle.
      const thr = Math.abs(b.throttle);
      const vib = 0.12 + 0.88 * thr;
      outboard.position.x = OUT_X + Math.sin(t * 47.3) * 0.0035 * vib;
      outboard.position.y = Math.sin(t * 41.7 + 1.1) * 0.0040 * vib;
      outboard.rotation.z = Math.sin(t * 39.1) * 0.009 * vib;
      outboard.rotation.x = Math.sin(t * 53.7 + 0.5) * 0.007 * vib;
      propSpin += dt * (2.0 + 46.0 * thr);
      if (propSpin > TAU) propSpin -= TAU;
      propGroup.rotation.z = propSpin;

      // Rod tip spring: a slow nod plus a faster tremble with way on.
      const sp = Math.min(1, Math.abs(b.speed) / 6.5);
      rodPivot.rotation.x = Math.sin(t * 2.15) * 0.016 + Math.sin(t * 6.4 + 0.8) * 0.011 * (0.25 + sp);
      rodPivot.rotation.z = Math.sin(t * 1.73 + 1.3) * 0.020 - b.turnRate * 0.055 - sp * 0.02;

      // Lantern flicker.
      const f = 0.86
        + 0.070 * Math.sin(t * 7.31)
        + 0.045 * Math.sin(t * 11.87 + 2.1)
        + 0.035 * Math.sin(t * 3.09 + 0.4);
      lanternLight.intensity = lanternBase * f;
      glassMat.emissiveIntensity = glassBase * (0.90 + 0.55 * (f - 0.86));
    },

    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
      materials.length = 0;
      group.clear();
    },
  };

  return api;
}
