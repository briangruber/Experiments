// The set dressing.
//
// Everything that makes the bay look inhabited and, more importantly, everything
// that makes it look *afloat*: a moored sailboat out in the roads, three dories
// working the dock, nine mooring buoys, four lit channel markers driven into the
// reef, and a shoreline of crab pots, nets, barrels and fish boxes.
//
// The whole harbour rises and falls together because every floating object asks
// `ctx.water.sampleHeight` for its height and tilts to the wave field each
// frame — the boats by sampling fore/aft and port/starboard and solving pitch
// and roll from the difference, the buoys straight off `sampleNormal`. That is
// four to five wave evaluations per hull and one normal per buoy: about sixty
// evaluations a frame for the whole bay, which is nothing, and it is the single
// cheapest thing in the game that sells the water.
//
// Construction matches the dock and the village: unit primitives stamped into
// merged vertex-coloured buffers. The two hull shapes are proper (if small)
// lofts — ten stations, a shared section profile, flat-shaded — because a
// stylised boat made of boxes reads as boxes at any distance.
//
// Nothing here invents light. The channel-marker lamps take their colour and
// their level from `env.windowLight` and `env.lanternIntensity`; by day they are
// dark lumps of iron, at night they are the only warm points out on the reef.

import * as THREE from 'three';
import { LAYER, setLayers, addLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// --- binding world layout ------------------------------------------------------

const ISLE_X = -150;
const ISLE_Z = -60;
const DOCK_SHORE = new THREE.Vector2(-95, 10);
const DOCK_HEAD = new THREE.Vector2(-58, -4);

// --- palette (albedo only; every light comes from env) -------------------------

const HULL_WHITE = 0xF1ECDF;
const HULL_CREAM = 0xE8DCC2;
const HULL_GREEN = 0xBFD2C0;
const HULL_BLUE = 0xBACBD8;
const BOOT = 0x2B3B4E;
const ANTIFOUL = 0x3C5A56;
const DECK_CREAM = 0xE4D7BA;
const HONEY = 0xC28C4C;
const HONEY_DK = 0x8A6A44;
const TIMBER_DK = 0x4A3220;
const SAILCLOTH = 0xEDE2C6;
const ROPE = 0xC9B48C;
const IRON = 0x3A3A3E;
const DARK_IRON = 0x25262A;
const BUOY_RED = 0xC8382C;
const BUOY_WHITE = 0xF0EADC;
const BUOY_ORANGE = 0xE2762A;
const NET = 0x3E4A3A;
const NET_LT = 0x5C6E4E;
const CRATE = [0x8A6A44, 0x9B7B50, 0x6F573A];
const BARREL = 0x7A5B39;
const STONE = [0x8C8A82, 0x9A968C, 0x7E7C74];
const GLASS_TINT = 0xFFE2AC;
const WEED = 0x4A5C42;

// --- scratch (module scope; nothing here allocates in update) -------------------

const _mLocal = new THREE.Matrix4();
const _mOut = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cr = new THREE.Vector3();
const _niCache = new WeakMap();

// update-only scratch
const _UP = new THREE.Vector3(0, 1, 0);
const _nrm = new THREE.Vector3(0, 1, 0);
const _qTilt = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qOut = new THREE.Quaternion();
const _mInst = new THREE.Matrix4();
const _pInst = new THREE.Vector3();
const _sInst = new THREE.Vector3();

function NI(g) {
  if (!g.index) return g;
  let r = _niCache.get(g);
  if (!r) { r = g.toNonIndexed(); _niCache.set(g, r); }
  return r;
}

function compose(out, x, y, z, sx, sy, sz, rx, ry, rz) {
  _e.set(rx || 0, ry || 0, rz || 0, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

/**
 * Accumulates transformed primitives and raw triangles into flat arrays.
 * `tri` is what the hull lofts use: flat-shaded, one face normal per triangle,
 * which is exactly the chunky faceted look the concept art has.
 */
function makeBuilder(extras) {
  const pos = [];
  const nrm = [];
  const col = [];
  const ex = [];
  for (const e of extras || []) ex.push({ name: e.name, size: e.size, data: [], def: e.def || 0 });

  const pushExtra = (extraVals, n) => {
    for (let k = 0; k < ex.length; k++) {
      const e = ex[k];
      const src = extraVals && extraVals[e.name];
      for (let i = 0; i < n; i++) for (let j = 0; j < e.size; j++) e.data.push(src ? src[j] : e.def);
    }
  };

  const B = {
    add(geo, matrix, color, extraVals) {
      const g = NI(geo);
      const pa = g.attributes.position.array;
      const na = g.attributes.normal.array;
      const count = g.attributes.position.count;
      _n3.getNormalMatrix(matrix);
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        _v.set(pa[i3], pa[i3 + 1], pa[i3 + 2]).applyMatrix4(matrix);
        pos.push(_v.x, _v.y, _v.z);
        _v.set(na[i3], na[i3 + 1], na[i3 + 2]).applyMatrix3(_n3).normalize();
        nrm.push(_v.x, _v.y, _v.z);
        col.push(color.r, color.g, color.b);
      }
      pushExtra(extraVals, count);
    },

    /** One flat-shaded triangle, already in the target frame. */
    tri(ax, ay, az, bx, by, bz, cx, cy, cz, color) {
      _a.set(bx - ax, by - ay, bz - az);
      _b.set(cx - ax, cy - ay, cz - az);
      _cr.crossVectors(_a, _b);
      if (_cr.lengthSq() < 1e-14) return;
      _cr.normalize();
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (let i = 0; i < 3; i++) nrm.push(_cr.x, _cr.y, _cr.z);
      for (let i = 0; i < 3; i++) col.push(color.r, color.g, color.b);
      pushExtra(null, 3);
    },

    /** Quad a-b-c-d, wound so its face normal agrees with the hint. */
    quadH(a, b, c, d, color, hx, hy, hz) {
      _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      _cr.crossVectors(_a, _b);
      if (_cr.x * hx + _cr.y * hy + _cr.z * hz < 0) {
        B.tri(a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2], color);
        B.tri(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], color);
      } else {
        B.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], color);
        B.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], color);
      }
    },

    get empty() { return pos.length === 0; },

    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      for (let k = 0; k < ex.length; k++) {
        g.setAttribute(ex[k].name, new THREE.Float32BufferAttribute(ex[k].data, ex[k].size));
      }
      g.computeBoundingSphere();
      return g;
    },
  };
  return B;
}

// --- the hull loft --------------------------------------------------------------
//
// Stations run bow (-z) to transom (+z) as [z, halfBeam, draft, sheer]. The
// section profile is shared: [fraction of halfBeam, mode, value] where mode 0 is
// -draft * v, mode 1 is sheer * v and mode 2 is an absolute y. Mode 2 is how the
// boot stripe gets a crisp constant-height band at the waterline whatever the
// section is doing.

const PROFILE = [
  [0.00, 0, 1.00],    // keel
  [0.46, 0, 0.86],
  [0.82, 0, 0.42],
  [0.97, 2, -0.050],  // just below the waterline
  [0.99, 2, 0.025],   // just above it
  [1.00, 1, 0.34],
  [0.97, 1, 1.00],    // sheer
  [0.94, 1, 1.15],    // toe rail cap
];
const PN = PROFILE.length;
const RINGN = PN * 2 - 1;

const profileY = (mode, v, draft, sheer) => (mode === 0 ? -draft * v : (mode === 1 ? sheer * v : v));

/** Ring index -> [profile index, side sign]. Index PN-1 is the keel. */
function ringIndex(j, out) {
  if (j < PN - 1) { out[0] = PN - 1 - j; out[1] = -1; } else { out[0] = j - (PN - 1); out[1] = 1; }
  return out;
}
const _ri = [0, 0];

/**
 * Skin a set of stations and hand back the ring point table so the caller can
 * hang a deck, thwarts and fittings off the same vertices the hull was built on.
 * `bandCol` is one colour per section band (PN-1 of them), bottom to rail.
 */
function loftHull(B, stations, bandCol, capCol) {
  const ns = stations.length;
  const pts = new Float32Array(ns * RINGN * 3);
  for (let s = 0; s < ns; s++) {
    const st = stations[s];
    for (let j = 0; j < RINGN; j++) {
      ringIndex(j, _ri);
      const pr = PROFILE[_ri[0]];
      const o = (s * RINGN + j) * 3;
      pts[o] = _ri[1] * pr[0] * st[1];
      pts[o + 1] = profileY(pr[1], pr[2], st[2], st[3]);
      pts[o + 2] = st[0];
    }
  }
  const gx = (s, j) => pts[(s * RINGN + j) * 3];
  const gy = (s, j) => pts[(s * RINGN + j) * 3 + 1];
  const gz = (s, j) => pts[(s * RINGN + j) * 3 + 2];
  const bandOf = (j) => (j < PN - 1 ? PN - 2 - j : j - (PN - 1));

  // The ring is traversed port-sheer -> keel -> starboard-sheer and the stations
  // run bow to stern, which makes (s,j) (s,j+1) (s+1,j+1) (s+1,j) wind outward
  // on both sides without a per-quad hint.
  for (let s = 0; s < ns - 1; s++) {
    for (let j = 0; j < RINGN - 1; j++) {
      const col = bandCol[bandOf(j)];
      B.tri(gx(s, j), gy(s, j), gz(s, j),
        gx(s, j + 1), gy(s, j + 1), gz(s, j + 1),
        gx(s + 1, j + 1), gy(s + 1, j + 1), gz(s + 1, j + 1), col);
      B.tri(gx(s, j), gy(s, j), gz(s, j),
        gx(s + 1, j + 1), gy(s + 1, j + 1), gz(s + 1, j + 1),
        gx(s + 1, j), gy(s + 1, j), gz(s + 1, j), col);
    }
  }

  // Transom fan (+z outward) and stem fan (-z outward).
  const last = ns - 1;
  const kx = gx(last, PN - 1), ky = gy(last, PN - 1), kz = gz(last, PN - 1);
  for (let j = 0; j < RINGN - 1; j++) {
    B.tri(kx, ky, kz,
      gx(last, j), gy(last, j), gz(last, j),
      gx(last, j + 1), gy(last, j + 1), gz(last, j + 1), capCol);
  }
  const sx = gx(0, PN - 1), sy = gy(0, PN - 1), sz = gz(0, PN - 1);
  for (let j = 0; j < RINGN - 1; j++) {
    B.tri(sx, sy, sz,
      gx(0, j + 1), gy(0, j + 1), gz(0, j + 1),
      gx(0, j), gy(0, j), gz(0, j), capCol);
  }

  return { pts, gx, gy, gz, ns };
}

/** A strut between two points: a unit-Y cylinder solved onto the segment. */
function strutAngles(dx, dy, dz, out) {
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-6) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const ux = dx / L, uy = dy / L, uz = dz / L;
  const rz = -Math.asin(Math.max(-1, Math.min(1, ux)));
  const cz = Math.max(1e-4, Math.cos(rz));
  const rx = Math.atan2(uz / cz, uy / cz);
  out[0] = rx; out[1] = rz; out[2] = L;
  return out;
}
const _st = [0, 0, 0];

// --- the emissive-lamp material (the dock's, unchanged) -------------------------

function makeGlowMaterial(uniforms, baseHex) {
  const m = new THREE.MeshStandardMaterial({
    color: C(baseHex), roughness: 0.30, metalness: 0.0, vertexColors: true, fog: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowTime = uniforms.time;
    shader.uniforms.uGlowColor = uniforms.color;
    shader.uniforms.uGlowI = uniforms.intensity;
    shader.vertexShader = 'attribute vec2 aGlow;\nvarying vec2 vGlow;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vGlow = aGlow;',
    );
    shader.fragmentShader = 'uniform float uGlowTime;\nuniform vec3 uGlowColor;\nuniform float uGlowI;\nvarying vec2 vGlow;\n' + shader.fragmentShader.replace(
      'vec3 totalEmissiveRadiance = emissive;',
      `vec3 totalEmissiveRadiance = emissive;
  float gph = vGlow.y;
  float gfl = 1.0 + step(0.001, gph) * (
      0.14 * sin(uGlowTime * (2.1 + gph * 2.7) + gph * 23.0)
    + 0.06 * sin(uGlowTime * (6.9 + gph * 1.3) + gph * 41.0));
  totalEmissiveRadiance += uGlowColor * (uGlowI * vGlow.x * gfl) * vColor.rgb;`,
    );
  };
  return m;
}

// ===============================================================================

export function createProps(opts = {}) {
  const terrain = opts.terrain || null;
  const rng = makeRng(((opts.seed || 1) ^ 0x9B0475) >>> 0);

  const group = new THREE.Group();
  group.name = 'props';

  // --- source primitives ----------------------------------------------------
  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const CYLT = new THREE.CylinderGeometry(0.30, 0.5, 1, 10);
  const CONE = new THREE.ConeGeometry(0.5, 1, 10);
  const SPH = new THREE.IcosahedronGeometry(0.5, 1);
  const TORUS = new THREE.TorusGeometry(0.5, 0.12, 5, 14);
  const SOURCES = [BOX, CYL6, CYL8, CYL12, CYLT, CONE, SPH, TORUS];

  const put = (B, geo, W, x, y, z, sx, sy, sz, rx, ry, rz, color, extra) => {
    compose(_mLocal, x, y, z, sx, sy, sz, rx, ry, rz);
    _mOut.multiplyMatrices(W, _mLocal);
    B.add(geo, _mOut, color, extra);
  };

  /** Stamp a cylinder along a segment. Used for stays, oars, rope and braces. */
  const strut = (B, W, ax, ay, az, bx, by, bz, r, color) => {
    strutAngles(bx - ax, by - ay, bz - az, _st);
    put(B, CYL6, W, (ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5,
      r * 2, _st[2], r * 2, _st[0], 0, _st[1], color);
  };

  const I4 = new THREE.Matrix4();

  // --- terrain queries ------------------------------------------------------

  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return -1e4;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };
  const seabedAt = (x, z) => {
    if (!terrain || !terrain.seabedHeight) return -4;
    const h = terrain.seabedHeight(x, z);
    return Number.isFinite(h) ? Math.min(h, 0.1) : -4;
  };
  const depthAt = (x, z) => {
    if (!terrain || !terrain.depthAt) return 4;
    const d = terrain.depthAt(x, z);
    return Number.isFinite(d) ? d : 4;
  };
  const isLand = (x, z) => (terrain && terrain.isLand ? !!terrain.isLand(x, z) : false);

  /** Distance from the village island centre at which the land is `h` metres. */
  function radiusFor(angRad, h) {
    const ca = Math.cos(angRad), sa = Math.sin(angRad);
    let lo = 3, hi = 200;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5;
      if (landAt(ISLE_X + ca * mid, ISLE_Z + sa * mid) > h) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  /**
   * Nudge a mooring outward from the island until it is genuinely afloat. The
   * shoreline has a metre or two of angular noise in it, so a hand-picked
   * position near the dock can land on a rock that only exists at this seed.
   */
  const _spot = { x: 0, z: 0 };
  function floatSpot(x, z, minDepth) {
    const dx = x - ISLE_X, dz = z - ISLE_Z;
    const L = Math.max(1e-3, Math.hypot(dx, dz));
    const ux = dx / L, uz = dz / L;
    for (let i = 0; i < 26; i++) {
      const px = x + ux * i * 2.0;
      const pz = z + uz * i * 2.0;
      if (!isLand(px, pz) && depthAt(px, pz) >= minDepth) {
        _spot.x = px; _spot.z = pz;
        return _spot;
      }
    }
    _spot.x = x + ux * 52; _spot.z = z + uz * 52;
    return _spot;
  }

  // --- shared materials -----------------------------------------------------

  const uniforms = {
    time: { value: 0 },
    color: { value: new THREE.Color(1, 0.72, 0.36) },
    intensity: { value: 0 },
  };

  // Boats are open shells — the inside of a dory is as visible as the outside —
  // so the hull material is double sided. Three flips the normal on backfaces,
  // so the interior lights correctly.
  const matBoat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.72, metalness: 0.0,
    side: THREE.DoubleSide, fog: true,
  });
  const matSolid = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.90, metalness: 0.0, fog: true,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1C22);

  const geos = [];
  const floaters = [];      // rigid-body floaters: sailboat and dories
  const bobbers = [];       // instanced floaters: buoys
  const instMeshes = [];

  // =========================================================================
  // THE SAILBOAT — about 7 m, moored in the roads north-east of the dock
  // =========================================================================

  const SAIL_STATIONS = [
    [-3.40, 0.09, 0.16, 0.60],
    [-3.00, 0.24, 0.32, 0.56],
    [-2.30, 0.50, 0.54, 0.50],
    [-1.40, 0.78, 0.68, 0.45],
    [-0.40, 0.93, 0.74, 0.41],
    [0.60, 0.96, 0.72, 0.39],
    [1.60, 0.89, 0.63, 0.39],
    [2.50, 0.76, 0.48, 0.41],
    [3.20, 0.62, 0.33, 0.45],
    [3.50, 0.54, 0.22, 0.47],
  ];

  function buildSailboat() {
    const B = makeBuilder();
    const white = C(HULL_WHITE);
    const whiteHi = new THREE.Color().copy(white).multiplyScalar(1.05);
    const bands = [
      C(ANTIFOUL), C(ANTIFOUL), new THREE.Color().copy(C(ANTIFOUL)).multiplyScalar(1.1),
      C(BOOT), white, whiteHi, C(HONEY_DK),
    ];
    const hull = loftHull(B, SAIL_STATIONS, bands, C(HULL_WHITE));

    const deck = C(DECK_CREAM);
    const honey = C(HONEY);
    const honeyDk = C(HONEY_DK);
    const cloth = C(SAILCLOTH);
    const rope = C(ROPE);
    const dark = C(TIMBER_DK);

    // Deck: a cambered skin from each rail to a crown on the centreline.
    const A = [0, 0, 0], Bv = [0, 0, 0], Cv = [0, 0, 0], D = [0, 0, 0];
    const crown = (s) => SAIL_STATIONS[s][3] * 1.15 + 0.10;
    for (let s = 0; s < hull.ns - 1; s++) {
      for (const j of [RINGN - 1, 0]) {
        A[0] = hull.gx(s, j); A[1] = hull.gy(s, j) - 0.02; A[2] = hull.gz(s, j);
        Bv[0] = 0; Bv[1] = crown(s); Bv[2] = SAIL_STATIONS[s][0];
        Cv[0] = 0; Cv[1] = crown(s + 1); Cv[2] = SAIL_STATIONS[s + 1][0];
        D[0] = hull.gx(s + 1, j); D[1] = hull.gy(s + 1, j) - 0.02; D[2] = hull.gz(s + 1, j);
        B.quadH(A, Bv, Cv, D, deck, 0, 1, 0);
      }
    }

    // Coachroof, companionway and a pair of portholes.
    put(B, BOX, I4, 0, 0.66, -0.45, 1.24, 0.44, 2.50, 0, 0, 0, whiteHi);
    put(B, BOX, I4, 0, 0.90, -0.45, 1.36, 0.10, 2.62, 0, 0, 0, honeyDk);
    put(B, BOX, I4, 0, 0.74, 0.86, 0.86, 0.60, 0.22, 0, 0, 0, dark);
    for (let s = -1; s <= 1; s += 2) {
      for (let i = 0; i < 2; i++) {
        put(B, CYL8, I4, s * 0.63, 0.68, -1.15 + i * 0.85, 0.22, 0.10, 0.22,
          0, 0, Math.PI * 0.5, C(0x2A3038));
      }
    }
    // cockpit well aft
    put(B, BOX, I4, 0, 0.26, 2.05, 1.20, 0.36, 1.90, 0, 0, 0, honeyDk);
    put(B, BOX, I4, 0, 0.46, 2.05, 1.04, 0.10, 1.74, 0, 0, 0, honey);

    // Mast, stepped just forward of the coachroof and raked aft five degrees.
    const RAKE = 0.088;
    const MAST_H = 7.4;
    const stepY = 0.52;
    const stepZ = -0.55;
    const headY = stepY + MAST_H * Math.cos(RAKE);
    const headZ = stepZ + MAST_H * Math.sin(RAKE);
    put(B, CYLT, I4, 0, (stepY + headY) * 0.5, (stepZ + headZ) * 0.5,
      0.17, MAST_H, 0.17, RAKE, 0, 0, honeyDk);
    put(B, BOX, I4, 0, stepY + 0.16, stepZ, 0.34, 0.32, 0.34, 0, 0, 0, dark);
    put(B, SPH, I4, 0, headY + 0.06, headZ, 0.16, 0.16, 0.16, 0, 0, 0, C(0xB88A3E));

    // Boom and the sail furled onto it, with four ties.
    const boomY = stepY + 1.28;
    const boomZ0 = stepZ + 0.20;
    const boomZ1 = stepZ + 3.55;
    strut(B, I4, 0, boomY + 0.04, boomZ0, 0, boomY - 0.10, boomZ1, 0.055, honeyDk);
    put(B, CYLT, I4, 0, boomY + 0.14, (boomZ0 + boomZ1) * 0.5 + 0.15,
      0.40, boomZ1 - boomZ0 - 0.5, 0.34, Math.PI * 0.5 - 0.04, 0, 0, cloth);
    for (let i = 0; i < 4; i++) {
      const z = boomZ0 + 0.6 + i * 0.72;
      put(B, CYL8, I4, 0, boomY + 0.14, z, 0.44, 0.06, 0.40, Math.PI * 0.5, 0, 0, rope);
    }
    // gooseneck and topping lift
    put(B, BOX, I4, 0, boomY + 0.04, boomZ0 - 0.08, 0.18, 0.18, 0.22, 0, 0, 0, C(IRON));
    strut(B, I4, 0, headY - 0.20, headZ, 0, boomY - 0.06, boomZ1 - 0.1, 0.016, rope);

    // Forestay with the jib furled on it, backstay, two shrouds.
    const bowX = 0, bowY = 0.62, bowZ = -3.42;
    strut(B, I4, bowX, bowY, bowZ, 0, headY - 0.05, headZ, 0.018, rope);
    put(B, CYLT, I4, 0, (bowY + headY * 0.52) * 0.5 + 0.1, (bowZ + headZ * 0.52) * 0.5,
      0.34, 4.05, 0.30,
      Math.atan2(headZ - bowZ, headY - bowY), 0, 0, cloth);
    strut(B, I4, 0, headY - 0.05, headZ, 0, 0.56, 3.44, 0.016, rope);
    for (let s = -1; s <= 1; s += 2) {
      strut(B, I4, s * 0.86, 0.50, -0.30, 0, headY - 0.55, headZ, 0.016, rope);
      put(B, BOX, I4, s * 0.86, 0.48, -0.30, 0.12, 0.26, 0.12, 0, 0, 0, C(IRON));
    }

    // Pulpit, tiller, a couple of fenders and a mooring pendant.
    for (let s = -1; s <= 1; s += 2) {
      strut(B, I4, s * 0.30, 0.58, -3.24, s * 0.38, 1.22, -2.88, 0.028, C(0x9AA1A8));
    }
    strut(B, I4, -0.38, 1.22, -2.88, 0.38, 1.22, -2.88, 0.028, C(0x9AA1A8));
    put(B, CYL8, I4, 0, 0.60, 3.05, 0.10, 1.30, 0.10, 1.32, 0, 0, honey);
    for (let s = -1; s <= 1; s += 2) {
      put(B, CYL12, I4, s * 0.96, -0.02, 0.9 + s * 0.5, 0.34, 0.62, 0.34, 0, 0, 0.22, C(0xE8E2D4));
      strut(B, I4, s * 0.92, 0.42, 0.9 + s * 0.5, s * 0.99, 0.30, 0.9 + s * 0.5, 0.014, rope);
    }
    strut(B, I4, 0, 0.58, -3.38, 0.35, -0.55, -4.60, 0.020, rope);
    // a coil of rope on the foredeck
    for (let k = 0; k < 3; k++) {
      put(B, TORUS, I4, -0.26, 0.66 + k * 0.055, -2.05, 0.62 - k * 0.10, 0.62 - k * 0.10, 0.28,
        0, 0, 0, rope);
    }

    const g = B.build();
    geos.push(g);
    const mesh = new THREE.Mesh(g, matBoat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'props.sailboat';
    return mesh;
  }

  // =========================================================================
  // THE DORIES — about 3.9 m, oars shipped
  // =========================================================================

  const DORY_STATIONS = [
    [-1.95, 0.06, 0.11, 0.42],
    [-1.62, 0.24, 0.21, 0.40],
    [-1.10, 0.48, 0.30, 0.37],
    [-0.45, 0.64, 0.35, 0.355],
    [0.25, 0.68, 0.35, 0.345],
    [0.90, 0.65, 0.32, 0.35],
    [1.45, 0.57, 0.25, 0.365],
    [1.95, 0.48, 0.15, 0.385],
  ];

  function buildDory(topsideHex, seedOff) {
    const B = makeBuilder();
    const top = C(topsideHex);
    const topHi = new THREE.Color().copy(top).multiplyScalar(1.06);
    const bands = [
      C(ANTIFOUL), C(ANTIFOUL), new THREE.Color().copy(C(ANTIFOUL)).multiplyScalar(1.12),
      C(BOOT), top, topHi, C(HONEY_DK),
    ];
    const hull = loftHull(B, DORY_STATIONS, bands, top);

    const honey = C(HONEY);
    const honeyDk = C(HONEY_DK);
    const dark = C(TIMBER_DK);
    const rope = C(ROPE);

    // Floorboards over the bilge so the boat has a bottom to look into.
    for (let z = -1.15; z < 1.6; z += 0.20) {
      const t = (z + 1.95) / 3.9;
      const w = (0.30 + 1.05 * Math.sin(Math.min(1, Math.max(0, t)) * Math.PI)) * 0.95;
      put(B, BOX, I4, 0, -0.10, z, w, 0.035, 0.16, 0, 0, 0,
        new THREE.Color().copy(honey).multiplyScalar(0.92 + 0.16 * ((z * 7 + seedOff) % 3) / 2));
    }
    // Thwarts.
    for (const z of [-0.55, 0.45, 1.30]) {
      put(B, BOX, I4, 0, 0.16, z, 1.28, 0.065, 0.28, 0, 0, 0, C(0xD9A661));
      for (let s = -1; s <= 1; s += 2) {
        put(B, BOX, I4, s * 0.52, 0.06, z, 0.07, 0.16, 0.10, 0, 0, 0, honeyDk);
      }
    }
    // Two oars shipped fore and aft along the thwarts, blades forward.
    for (let s = -1; s <= 1; s += 2) {
      const ox = s * 0.30;
      strut(B, I4, ox, 0.23, 1.62, ox * 0.55, 0.21, -1.30, 0.036, honey);
      put(B, BOX, I4, ox * 0.55, 0.22, -1.62, 0.16, 0.045, 0.66, 0, 0, 0, C(0xE8DCC0));
      put(B, CYL8, I4, ox, 0.24, 1.68, 0.10, 0.22, 0.10, Math.PI * 0.5, 0, 0, dark);
      // rowlock
      put(B, CYL8, I4, s * 0.60, 0.34, 0.10, 0.09, 0.30, 0.09, 0, 0, 0, C(IRON));
    }
    // A bailer, a coil of warp, a crate.
    put(B, CYL12, I4, 0.24, -0.02, -0.85, 0.24, 0.22, 0.24, 0, 0, 0.30, C(0xB8C0BA));
    for (let k = 0; k < 3; k++) {
      put(B, TORUS, I4, -0.22, -0.06 + k * 0.05, 0.95, 0.56 - k * 0.09, 0.56 - k * 0.09, 0.24,
        0, 0, 0, rope);
    }
    put(B, BOX, I4, 0.15, 0.02, -1.35, 0.44, 0.30, 0.38, 0, 0.4, 0, C(CRATE[seedOff % 3]));
    // Painter made off at the stem and trailing.
    strut(B, I4, 0, 0.36, -1.92, 0.22, -0.30, -2.70, 0.018, rope);
    // Bow and stern ring bolts.
    put(B, TORUS, I4, 0, 0.40, -1.86, 0.34, 0.34, 0.16, Math.PI * 0.5, 0, 0, C(IRON));

    const g = B.build();
    geos.push(g);
    const mesh = new THREE.Mesh(g, matBoat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'props.dory';
    return mesh;
  }

  // --- place the boats ------------------------------------------------------

  function addFloater(mesh, x, z, yaw, halfLen, halfBeam, damp, yOff) {
    const holder = new THREE.Group();
    holder.add(mesh);
    group.add(holder);
    addLayers(mesh, LAYER.UNDERWATER);
    floaters.push({
      obj: holder, x, z, yaw, hl: halfLen, hb: halfBeam, damp, yOff,
    });
    return holder;
  }

  {
    const sb = floatSpot(-16, -52, 2.0);
    addFloater(buildSailboat(), sb.x, sb.z, 0.72, 2.9, 0.95, 0.55, 0.0);
  }

  {
    const specs = [
      { x: -73.8, z: 9.5, yaw: 2.11, hex: HULL_WHITE },
      { x: -70.0, z: -8.6, yaw: 1.38, hex: HULL_GREEN },
      { x: -64.9, z: -13.7, yaw: 1.93, hex: HULL_BLUE },
    ];
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      const p = floatSpot(sp.x, sp.z, 1.1);
      addFloater(buildDory(sp.hex, i * 2 + 1), p.x, p.z, sp.yaw, 1.6, 0.66, 0.8, 0.0);
    }
  }

  // =========================================================================
  // MOORING BUOYS — three variants, instanced, bobbing on the wave field
  // =========================================================================

  function buildBuoy(kind) {
    const B = makeBuilder();
    const white = C(BUOY_WHITE);
    const red = C(BUOY_RED);
    const orange = C(BUOY_ORANGE);
    const iron = C(DARK_IRON);
    const rope = C(ROPE);

    if (kind === 0 || kind === 2) {
      // can buoy: white body, red belt, conical top, ring
      put(B, CYL12, I4, 0, -0.02, 0, 0.62, 0.62, 0.62, 0, 0, 0, white);
      put(B, CYL12, I4, 0, 0.06, 0, 0.64, 0.20, 0.64, 0, 0, 0, red);
      put(B, CYL12, I4, 0, -0.30, 0, 0.52, 0.22, 0.52, 0, 0, 0, C(WEED));
      put(B, CONE, I4, 0, 0.44, 0, 0.62, 0.42, 0.62, 0, 0, 0, red);
      put(B, CYL8, I4, 0, 0.70, 0, 0.10, 0.30, 0.10, 0, 0, 0, iron);
      put(B, TORUS, I4, 0, 0.86, 0, 0.30, 0.30, 0.18, Math.PI * 0.5, 0, 0, iron);
    } else {
      // spherical float, half sunk, with a lashing
      put(B, SPH, I4, 0, 0.02, 0, 0.72, 0.66, 0.72, 0, 0, 0, orange);
      put(B, CYL12, I4, 0, 0.02, 0, 0.74, 0.12, 0.74, 0, 0, 0,
        new THREE.Color().copy(orange).multiplyScalar(0.72));
      put(B, CYL8, I4, 0, 0.34, 0, 0.09, 0.22, 0.09, 0, 0, 0, iron);
      put(B, TORUS, I4, 0, 0.46, 0, 0.26, 0.26, 0.16, Math.PI * 0.5, 0, 0, iron);
      strut(B, I4, 0.05, 0.44, 0, 0.30, 0.10, 0.34, 0.018, rope);
    }

    if (kind === 2) {
      // a pole with a small flag, so a couple of the moorings read at distance
      put(B, CYL8, I4, 0, 1.35, 0, 0.09, 1.90, 0.09, 0, 0, 0, iron);
      put(B, BOX, I4, 0.24, 2.08, 0, 0.46, 0.30, 0.035, 0, 0, 0, red);
      put(B, BOX, I4, 0.24, 2.08, 0, 0.20, 0.31, 0.036, 0, 0, 0, white);
      put(B, SPH, I4, 0, 2.32, 0, 0.16, 0.16, 0.16, 0, 0, 0, iron);
    }

    const g = B.build();
    geos.push(g);
    return g;
  }

  {
    // scattered across the bay, well clear of the boat's start at (-6, 0, 24)
    const spots = [
      [-46, 14, 0], [-40, -14, 1], [-30, 2, 0], [-22, -26, 2],
      [-13, 9, 1], [-34, -34, 0], [-52, -22, 2], [-58, 12, 1], [-8, -14, 0],
    ];
    const byKind = [[], [], []];
    for (const [x, z, kind] of spots) {
      const p = floatSpot(x, z, 1.0);
      byKind[kind].push({ x: p.x, z: p.z });
    }
    for (let kind = 0; kind < 3; kind++) {
      const list = byKind[kind];
      if (!list.length) continue;
      const geo = buildBuoy(kind);
      const mesh = new THREE.InstancedMesh(geo, matBoat, list.length);
      mesh.name = `props.buoy${kind}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(mesh);
      instMeshes.push(mesh);
      for (let i = 0; i < list.length; i++) {
        bobbers.push({
          mesh, i,
          x: list[i].x, z: list[i].z,
          yaw: rng.range(0, Math.PI * 2),
          scale: rng.range(0.86, 1.14),
          tilt: rng.range(0.55, 0.85),
          phase: rng.range(0, Math.PI * 2),
          yOff: rng.range(-0.03, 0.03),
        });
        // seed the matrix so the first frame is never a pile at the origin
        _mInst.compose(_pInst.set(list[i].x, 0, list[i].z), _qOut.identity(),
          _sInst.setScalar(1));
        mesh.setMatrixAt(i, _mInst);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // =========================================================================
  // CHANNEL MARKERS — poles driven into the reef, lit at night
  // =========================================================================

  const bMarker = makeBuilder();
  const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

  {
    const iron = C(IRON);
    const dark = C(DARK_IRON);
    const wood = C(HONEY_DK);
    const weed = C(WEED);
    const spots = [
      [-46, -6, 0], [-34, -12, 1], [-22, -18, 0], [-10, -26, 1],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [x, z, side] = spots[i];
      const bed = seabedAt(x, z);
      const bottom = Math.min(bed - 0.8, -1.6);
      const TOP = 3.35;
      const h = TOP - bottom;
      const lean = rng.range(-0.035, 0.035);
      compose(_mLocal, x, 0, z, 1, 1, 1, 0, rng.range(0, Math.PI), 0);
      const W = _mLocal.clone();

      put(bMarker, CYL8, W, 0, bottom + h * 0.5, 0, 0.28, h, 0.28, lean, 0, lean * 0.6, wood);
      // barnacle collar at the waterline and a bit of weed below it
      put(bMarker, CYL8, W, 0, 0.10, 0, 0.40, 0.90, 0.40, 0, 0, 0, weed);
      put(bMarker, CYL8, W, 0, -0.75, 0, 0.36, 0.80, 0.36, 0, 0, 0,
        new THREE.Color().copy(weed).multiplyScalar(0.8));
      // stabilising legs into the reef
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.4;
        strut(bMarker, W, 0, 0.30, 0,
          Math.cos(a) * 1.25, Math.max(bottom + 0.3, bed - 0.2), Math.sin(a) * 1.25,
          0.075, wood);
      }
      // daymark: a square board, port red or starboard green
      put(bMarker, BOX, W, 0, TOP - 0.85, 0.05, 0.86, 0.86, 0.10, 0, 0, 0,
        side === 0 ? C(BUOY_RED) : C(0x2E7A55));
      put(bMarker, BOX, W, 0, TOP - 0.85, 0.11, 0.42, 0.42, 0.06, 0, 0, 0, C(BUOY_WHITE));
      // lamp housing
      put(bMarker, CYL8, W, 0, TOP - 0.14, 0, 0.44, 0.16, 0.44, 0, 0, 0, dark);
      put(bMarker, CONE, W, 0, TOP + 0.34, 0, 0.60, 0.34, 0.60, 0, 0, 0, dark);
      put(bMarker, BOX, W, 0, TOP + 0.56, 0, 0.10, 0.24, 0.10, 0, 0, 0, iron);
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI * 0.5 + Math.PI * 0.25;
        put(bMarker, BOX, W, Math.cos(a) * 0.20, TOP + 0.08, Math.sin(a) * 0.20,
          0.05, 0.42, 0.05, 0, a, 0, dark);
      }
      put(bGlow, CYL8, W, 0, TOP + 0.08, 0, 0.34, 0.42, 0.34, 0, 0, 0, C(GLASS_TINT),
        { aGlow: [1.25, 0.3 + i * 0.21] });
    }
  }

  // =========================================================================
  // SHORELINE CLUTTER — the working end of the harbour
  // =========================================================================

  const bShore = makeBuilder();

  {
    const wood = C(0x7E6039);
    const net = C(NET);
    const netLt = C(NET_LT);
    const rope = C(ROPE);
    const iron = C(IRON);

    /** A spot on the beach at the given bearing from the island and height. */
    const beach = (angDeg, h, out) => {
      const a = angDeg * Math.PI / 180;
      const r = radiusFor(a, h);
      out.x = ISLE_X + Math.cos(a) * r;
      out.z = ISLE_Z + Math.sin(a) * r;
      out.y = landAt(out.x, out.z);
      return out;
    };
    const _bs = { x: 0, y: 0, z: 0 };

    const crabPot = (W, x, y, z, rot) => {
      put(bShore, CYL8, W, x, y + 0.10, z, 1.28, 0.20, 1.28, 0, rot, 0, wood);
      put(bShore, CYL8, W, x, y + 0.42, z, 1.20, 0.60, 1.20, 0, rot, 0, net);
      put(bShore, CYL8, W, x, y + 0.74, z, 1.02, 0.16, 1.02, 0, rot, 0, wood);
      for (let k = 0; k < 4; k++) {
        const a = rot + k * Math.PI * 0.5 + 0.4;
        put(bShore, BOX, W, x + Math.sin(a) * 0.56, y + 0.44, z + Math.cos(a) * 0.56,
          0.09, 0.72, 0.09, 0, a, 0, wood);
      }
    };
    const barrel = (W, x, y, z, rot) => {
      put(bShore, CYL12, W, x, y + 0.46, z, 0.72, 0.92, 0.72, 0, rot, 0, C(BARREL));
      put(bShore, CYL12, W, x, y + 0.22, z, 0.78, 0.12, 0.78, 0, rot, 0, iron);
      put(bShore, CYL12, W, x, y + 0.70, z, 0.78, 0.12, 0.78, 0, rot, 0, iron);
      put(bShore, CYL12, W, x, y + 0.93, z, 0.66, 0.08, 0.66, 0, rot, 0, C(0x8A6A44));
    };
    const crateStack = (W, x, y, z, n, rot) => {
      for (let k = 0; k < n; k++) {
        const sz = 0.84 - k * 0.05;
        put(bShore, BOX, W, x + rng.range(-0.08, 0.08), y + 0.30 + k * 0.60,
          z + rng.range(-0.08, 0.08), sz, 0.56, sz, 0, rot + rng.range(-0.3, 0.3), 0,
          C(CRATE[(k + n) % CRATE.length]));
        put(bShore, BOX, W, x, y + 0.30 + k * 0.60, z, sz + 0.06, 0.09, sz + 0.06,
          0, rot, 0, C(HONEY_DK));
      }
    };
    /** A stack of shallow fish boxes, the pale ones you see on every quay. */
    const fishBoxes = (W, x, y, z, n, rot) => {
      for (let k = 0; k < n; k++) {
        put(bShore, BOX, W, x + rng.range(-0.05, 0.05), y + 0.14 + k * 0.26,
          z + rng.range(-0.05, 0.05), 0.92, 0.24, 0.62,
          0, rot + rng.range(-0.14, 0.14), 0,
          k % 2 ? C(0xD8D2C0) : C(0xC8CBC4));
        put(bShore, BOX, W, x, y + 0.25 + k * 0.26, z, 0.96, 0.05, 0.66, 0, rot, 0,
          C(0xB0B4AC));
      }
    };
    /** Two stakes with a net slung between them, drying. */
    const netRack = (W, x, y, z, rot, span) => {
      const c = Math.cos(rot), s = Math.sin(rot);
      for (let e = -1; e <= 1; e += 2) {
        put(bShore, CYL8, W, x + c * span * 0.5 * e, y + 0.95, z - s * span * 0.5 * e,
          0.14, 1.90, 0.14, 0.06 * e, 0, 0, wood);
      }
      put(bShore, BOX, W, x, y + 1.82, z, span, 0.09, 0.09, 0, rot, 0, wood);
      const n = Math.max(4, Math.round(span / 0.55));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const drop = 1.05 - 0.45 * Math.cos(t * 2.6);
        put(bShore, BOX, W, x + c * span * t, y + 1.80 - drop * 0.5, z - s * span * t,
          span / n + 0.02, drop, 0.05, 0, rot, 0, i % 2 ? net : netLt);
      }
      // a couple of cork floats caught in it
      for (let i = 0; i < 3; i++) {
        const t = (i - 1) * 0.24;
        put(bShore, SPH, W, x + c * span * t, y + 1.02, z - s * span * t + 0.08,
          0.22, 0.22, 0.22, 0, 0, 0, C(BUOY_ORANGE));
      }
    };

    // Everything sits on the beach face south-east of the village, either side
    // of where the dock walks ashore.
    const cluster = [
      { a: 44, h: 2.2, kind: 'pots' },
      { a: 47.5, h: 1.5, kind: 'rack' },
      { a: 50, h: 2.8, kind: 'crates' },
      { a: 53, h: 1.8, kind: 'barrels' },
      { a: 56, h: 2.6, kind: 'boxes' },
      { a: 59, h: 1.6, kind: 'pots' },
      { a: 62, h: 3.1, kind: 'rack' },
      { a: 65, h: 2.0, kind: 'barrels' },
      { a: 41, h: 3.0, kind: 'boxes' },
    ];
    for (let i = 0; i < cluster.length; i++) {
      const c = cluster[i];
      beach(c.a + rng.range(-0.8, 0.8), c.h, _bs);
      if (_bs.y < -100) continue;
      const rot = Math.atan2(Math.cos(c.a * Math.PI / 180), Math.sin(c.a * Math.PI / 180))
        + rng.range(-0.5, 0.5);
      compose(_mLocal, _bs.x, _bs.y, _bs.z, 1, 1, 1, 0, rot, 0);
      const W = _mLocal.clone();
      if (c.kind === 'pots') {
        crabPot(W, 0, 0, 0, rng.range(0, 1.4));
        crabPot(W, 1.15, 0, 0.35, rng.range(0, 1.4));
        crabPot(W, 0.55, 0.84, 0.18, rng.range(0, 1.4));
        for (let k = 0; k < 3; k++) {
          put(bShore, TORUS, W, -0.9, 0.10 + k * 0.09, 0.5, 1.0 - k * 0.16, 1.0 - k * 0.16,
            0.5, 0, 0, 0, rope);
        }
      } else if (c.kind === 'barrels') {
        barrel(W, 0, 0, 0, rng.range(0, 1.4));
        barrel(W, 1.05, 0, 0.3, rng.range(0, 1.4));
        // one on its side
        put(bShore, CYL12, W, -1.1, 0.36, 0.15, 0.72, 0.92, 0.72,
          Math.PI * 0.5, rng.range(0, 1.4), 0, C(BARREL));
      } else if (c.kind === 'crates') {
        crateStack(W, 0, 0, 0, 3, rng.range(0, 1.0));
        crateStack(W, 1.1, 0, 0.4, 2, rng.range(0, 1.0));
      } else if (c.kind === 'boxes') {
        fishBoxes(W, 0, 0, 0, 4, rng.range(0, 1.0));
        fishBoxes(W, 1.05, 0, 0.25, 3, rng.range(0, 1.0));
        // a pair of oars leaning on the stack
        strut(bShore, W, 1.05, 0.9, 0.25, 1.9, 2.5, 0.9, 0.045, C(HONEY));
        strut(bShore, W, 1.15, 0.9, 0.35, 2.1, 2.4, 1.0, 0.045, C(HONEY));
      } else {
        netRack(W, 0, 0, 0, 0, rng.range(3.0, 4.4));
      }
      // a stone or two so nothing sits on bare sand
      put(bShore, SPH, W, rng.range(-2.2, 2.2), 0.12, rng.range(-1.6, 1.6),
        rng.range(0.6, 1.1), rng.range(0.4, 0.7), rng.range(0.6, 1.1),
        rng.range(0, 1), rng.range(0, 3), rng.range(0, 1), C(STONE[i % STONE.length]));
    }
  }

  // --- assemble the static meshes -------------------------------------------

  const markerMesh = new THREE.Mesh(bMarker.build(), matSolid);
  markerMesh.name = 'props.markers';
  const shoreMesh = new THREE.Mesh(bShore.build(), matSolid);
  shoreMesh.name = 'props.shore';
  const glowMesh = new THREE.Mesh(bGlow.build(), matGlow);
  glowMesh.name = 'props.markerLamps';
  geos.push(markerMesh.geometry, shoreMesh.geometry, glowMesh.geometry);
  for (const m of [markerMesh, shoreMesh, glowMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
  }

  // --- layers ---------------------------------------------------------------
  //
  // Everything reads above water; the hulls and the marker poles also go into the
  // refraction pass, where the clip plane trims them at the surface for free, so
  // the wetted parts carry on down through the water instead of stopping dead.

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  addLayers(markerMesh, LAYER.UNDERWATER);
  for (const f of floaters) addLayers(f.obj, LAYER.UNDERWATER);
  for (const m of instMeshes) addLayers(m, LAYER.UNDERWATER);

  // =========================================================================

  return {
    group,

    update(ctx) {
      uniforms.time.value = ctx.time;
      const w = ctx.water;
      if (!w || !w.sampleHeight) return;
      const t = ctx.time;

      // Hulls: pitch and roll solved from four samples across the boat, so a
      // seven-metre sailboat rides the swell instead of following one point.
      for (let i = 0; i < floaters.length; i++) {
        const f = floaters[i];
        const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw);
        const fx = -sy, fz = -cy;          // bow (built along local -Z)
        const rx = cy, rz = -sy;           // starboard
        const hc = w.sampleHeight(f.x, f.z, t);
        const hf = w.sampleHeight(f.x + fx * f.hl, f.z + fz * f.hl, t);
        const ha = w.sampleHeight(f.x - fx * f.hl, f.z - fz * f.hl, t);
        const hs = w.sampleHeight(f.x + rx * f.hb, f.z + rz * f.hb, t);
        const hp = w.sampleHeight(f.x - rx * f.hb, f.z - rz * f.hb, t);
        f.obj.position.set(f.x, hc + f.yOff, f.z);
        f.obj.rotation.set(
          Math.atan2(hf - ha, 2 * f.hl) * f.damp,
          f.yaw,
          Math.atan2(hs - hp, 2 * f.hb) * f.damp,
          'YXZ',
        );
      }

      // Buoys: straight off the analytic normal, damped a little so they lean
      // with the swell rather than snapping to every ripple.
      for (let i = 0; i < bobbers.length; i++) {
        const b = bobbers[i];
        const y = w.sampleHeight(b.x, b.z, t);
        w.sampleNormal(b.x, b.z, t, _nrm);
        _qTilt.setFromUnitVectors(_UP, _nrm);
        _qOut.identity().slerp(_qTilt, b.tilt);
        _qYaw.setFromAxisAngle(_UP, b.yaw);
        _qOut.multiply(_qYaw);
        _pInst.set(b.x, y + b.yOff + Math.sin(t * 1.35 + b.phase) * 0.022, b.z);
        _sInst.setScalar(b.scale);
        _mInst.compose(_pInst, _qOut, _sInst);
        b.mesh.setMatrixAt(b.i, _mInst);
      }
      for (let i = 0; i < instMeshes.length; i++) instMeshes[i].instanceMatrix.needsUpdate = true;
    },

    applyEnv(env) {
      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.lanternIntensity * 1.25;
    },

    dispose() {
      for (const g of geos) g.dispose();
      for (const g of SOURCES) g.dispose();
      matBoat.dispose();
      matSolid.dispose();
      matGlow.dispose();
    },
  };
}
