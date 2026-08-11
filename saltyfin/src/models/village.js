// The village.
//
// A terraced fishing town spilling down the south-east face of the village
// island, from the dock front at about y = 4 up to the ridge at about y = 44,
// with a zig-zag stone stair threading between the terraces.
//
// The whole town is built from one kit — walls, half-timbering, fat tile
// courses, windows, chimneys, awnings — and every piece is baked into a handful
// of merged BufferGeometries, one per material family. Thirty-odd buildings,
// roughly two thousand boxes, six draw calls.
//
// Colour discipline: albedo (stucco cream, chocolate timber, terracotta tile)
// is authored here as vertex colour, because paint is a property of the town.
// Light is not: the windows take their emissive from `env.windowLight` and
// `env.windowIntensity`, and the two practicals outside the Salty Fin take
// theirs from `env.lanternIntensity`. At night the hillside becomes a
// constellation of warm rectangles and nothing else about the module changes.

import * as THREE from 'three';
import { Fn, uniform, attribute, vertexColor, float, sin, step } from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

const DEG = Math.PI / 180;
const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// --- the binding world layout ------------------------------------------------

const ISLE_X = -150;
const ISLE_Z = -60;

/** Terrace rows: target height, the angular sector they occupy, how many. */
const ROWS = [
  { h: 4.6, a0: 28, a1: 90, n: 5 },
  { h: 9.2, a0: 24, a1: 98, n: 5 },
  { h: 14.2, a0: 28, a1: 102, n: 5 },
  { h: 19.6, a0: 33, a1: 105, n: 4 },
  { h: 25.2, a0: 37, a1: 104, n: 4 },
  { h: 30.6, a0: 42, a1: 100, n: 3 },
  { h: 36.0, a0: 47, a1: 95, n: 3 },
  { h: 41.2, a0: 53, a1: 88, n: 2 },
];

/** The stone stair, as (angle°, height) waypoints; radii are solved from terrain. */
const PATH = [
  [50, 3.2], [42, 7.0], [56, 10.5], [45, 15.0], [61, 19.5],
  [49, 24.0], [66, 28.5], [55, 33.5], [72, 38.5], [62, 43.0],
];

// --- palette (albedo only; all light comes from env) -------------------------

const STUCCO = [0xF3E7CF, 0xEFE2C4, 0xE9DCBE, 0xF6EFDD, 0xE3D6BB, 0xEADFC8];
const TIMBER = [0x4A3220, 0x3C2A1B, 0x54381F, 0x412C1C];
const ROOFS = [
  0xB4462E, 0xC2553A, 0x9A3B2A,          // terracotta
  0x466C8E, 0x3B5F80, 0x54809E,          // slate blue
  0x3E7A6A, 0x4C8A72,                    // teal green
  0x6E7076, 0x82817A,                    // weathered grey
];
const STONE = [0x8C8A82, 0x9A968C, 0x7E7C74, 0x93908A];
const BRICK = 0x9A5442;
const PLANK = [0x7A5B3A, 0x6B4E31, 0x866644];
const DOORS = [0x5A3A22, 0x2E4C6E, 0x7A3B2E, 0x35543F];
const AWNINGS = [
  [0xC24438, 0xF2E9D8],
  [0x2E7A55, 0xF2E9D8],
  [0x2B5E86, 0xF4EBDA],
];
const GLASS_TINT = 0xFFDCA8;
const FRAME_WHITE = 0xF7F2E4;
const GREEN = 0x3E7A3A;
const FLOWERS = [0xE05A6A, 0xE8A23C, 0xD8536E, 0xF0C24A];

// --- scratch (module scope; nothing here allocates after build) ---------------

const _mLocal = new THREE.Matrix4();
const _mOut = new THREE.Matrix4();
const _mTmp = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _niCache = new WeakMap();

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
 * Accumulates transformed copies of source geometries into flat arrays.
 * `extras` declares constant-per-piece vertex attributes (used for the window
 * emissive mask). Build time only — nothing here runs in a frame.
 */
function makeBuilder(extras) {
  const pos = [];
  const nrm = [];
  const col = [];
  const ex = [];
  for (const e of extras || []) ex.push({ name: e.name, size: e.size, data: [], def: e.def || 0 });

  return {
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
        for (let k = 0; k < ex.length; k++) {
          const e = ex[k];
          const src = extraVals && extraVals[e.name];
          for (let j = 0; j < e.size; j++) e.data.push(src ? src[j] : e.def);
        }
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
}

/** A triangular prism: base 1 wide in x, 1 tall in y (base at y=0), 1 deep in z. */
function makePrism() {
  const h = 0.5;
  const P = [];
  const N = [];
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) => {
    P.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    N.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };
  // caps
  tri(-h, 0, h, h, 0, h, 0, 1, h, 0, 0, 1);
  tri(h, 0, -h, -h, 0, -h, 0, 1, -h, 0, 0, -1);
  // bottom
  tri(-h, 0, -h, h, 0, -h, h, 0, h, 0, -1, 0);
  tri(-h, 0, -h, h, 0, h, -h, 0, h, 0, -1, 0);
  // +x slope
  const k = 1 / Math.sqrt(1.25);
  tri(h, 0, -h, 0, 1, -h, 0, 1, h, k, 0.5 * k, 0);
  tri(h, 0, -h, 0, 1, h, h, 0, h, k, 0.5 * k, 0);
  // -x slope
  tri(-h, 0, h, 0, 1, h, 0, 1, -h, -k, 0.5 * k, 0);
  tri(-h, 0, h, 0, 1, -h, -h, 0, -h, -k, 0.5 * k, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return g;
}

// --- the emissive-window material -------------------------------------------
//
// One MeshStandardNodeMaterial with an `emissiveNode`: a per-vertex vec2 where
// x is "how lit is this pane" and y is a flicker seed (0 = steady). The pane
// tint comes from the vertex colour so a candle-lit attic can be warmer than a
// tavern window without another material.
//
// `emissiveNode` stands in for the whole `totalEmissiveRadiance` term the GLSL
// used to add to; the material's own `emissive` is black and unused either way.
// `vertexColor()` is a vec4 — instancing can supply a fourth channel — so the
// multiply must take `.rgb` or the windows pick up an alpha they never had.

function makeGlowMaterial(uniforms, baseHex) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: C(baseHex), roughness: 0.28, metalness: 0.0, vertexColors: true, fog: true,
  });
  m.emissiveNode = Fn(() => {
    const glow = attribute('aGlow', 'vec2');
    const gph = glow.y.toVar();
    const gfl = float(1).add(step(0.001, gph).mul(
      sin(uniforms.time.mul(gph.mul(3.3).add(1.7)).add(gph.mul(37.0))).mul(0.16)
        .add(sin(uniforms.time.mul(gph.mul(2.1).add(5.9)).add(gph.mul(11.0))).mul(0.09)),
    ));
    return uniforms.color.mul(uniforms.intensity.mul(glow.x).mul(gfl)).mul(vertexColor().rgb);
  })();
  return m;
}

// --- the SALTY FIN sign board ------------------------------------------------

function makeSignTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const g = cv.getContext('2d');

  g.fillStyle = '#6d4726';
  g.fillRect(0, 0, 512, 256);
  // plank seams
  g.strokeStyle = 'rgba(52,32,16,0.55)';
  g.lineWidth = 3;
  for (let y = 64; y < 256; y += 64) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke();
  }
  // grain
  g.strokeStyle = 'rgba(122,88,52,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i < 26; i++) {
    const y = (i * 97) % 250 + 3;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(160, y + 5, 340, y - 6, 512, y + 2);
    g.stroke();
  }
  // border
  g.strokeStyle = '#3a2413';
  g.lineWidth = 16;
  g.strokeRect(12, 12, 488, 232);
  g.strokeStyle = '#8a6136';
  g.lineWidth = 4;
  g.strokeRect(26, 26, 460, 204);

  // lettering
  g.fillStyle = '#F6E7C2';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 78px Georgia, "Times New Roman", serif';
  g.fillText('SALTY FIN', 256, 92);

  // fish emblem
  g.save();
  g.translate(256, 178);
  g.fillStyle = '#F6E7C2';
  g.beginPath();
  g.moveTo(-64, 0);
  g.bezierCurveTo(-30, -30, 34, -30, 62, 0);
  g.bezierCurveTo(34, 30, -30, 30, -64, 0);
  g.fill();
  g.beginPath();
  g.moveTo(-58, 0);
  g.lineTo(-96, -24);
  g.lineTo(-88, 0);
  g.lineTo(-96, 24);
  g.closePath();
  g.fill();
  g.fillStyle = '#6d4726';
  g.beginPath(); g.arc(34, -6, 6, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#6d4726';
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(-6, -22); g.lineTo(-16, 0); g.lineTo(-6, 22); g.stroke();
  g.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// =============================================================================

export function createVillage(opts = {}) {
  const terrain = opts.terrain || null;
  const rng = makeRng(((opts.seed || 1) ^ 0x5A17F1) >>> 0);

  const group = new THREE.Group();
  group.name = 'village';

  // --- source primitives ----------------------------------------------------
  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const CYLT = new THREE.CylinderGeometry(0.34, 0.5, 1, 12);
  const CONE = new THREE.ConeGeometry(0.5, 1, 12);
  const SPH = new THREE.IcosahedronGeometry(0.5, 0);
  const DISC = new THREE.CircleGeometry(0.5, 14);
  const PRISM = makePrism();
  const SOURCES = [BOX, CYL8, CYL12, CYLT, CONE, SPH, DISC, PRISM];

  // --- builders -------------------------------------------------------------
  const bSolid = makeBuilder();   // stucco, timber, stone, brick, props
  const bRoof = makeBuilder();    // tile courses and ridges
  const bCloth = makeBuilder();   // awnings, banners
  const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

  const put = (B, geo, W, x, y, z, sx, sy, sz, rx, ry, rz, color, extra) => {
    compose(_mLocal, x, y, z, sx, sy, sz, rx, ry, rz);
    _mOut.multiplyMatrices(W, _mLocal);
    B.add(geo, _mOut, color, extra);
  };

  // --- terrain queries ------------------------------------------------------

  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return 0;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };

  /** Solve for the distance from the island centre at which the land is `h` m. */
  function radiusFor(angRad, h) {
    const ca = Math.cos(angRad), sa = Math.sin(angRad);
    let lo = 3, hi = 205;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) * 0.5;
      if (landAt(ISLE_X + ca * mid, ISLE_Z + sa * mid) > h) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  /** Highest of five samples across a w x d footprint at yaw `rot`. */
  function padHeight(x, z, w, d, rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    let best = landAt(x, z);
    const hw = w * 0.5, hd = d * 0.5;
    for (let i = 0; i < 4; i++) {
      const ox = (i & 1) ? hw : -hw;
      const oz = (i & 2) ? hd : -hd;
      const px = x + ox * c + oz * s;
      const pz = z - ox * s + oz * c;
      const h = landAt(px, pz);
      if (h > best) best = h;
    }
    return best;
  }

  // =========================================================================
  // THE KIT
  // =========================================================================

  /** A pitched roof in a local frame whose origin is the ridge-centre of the eave line. */
  function roof(W, halfSpan, halfDepth, rise, tileHex, opts2) {
    const o = opts2 || {};
    const tile = C(tileHex);
    const dark = C(TIMBER[0]);
    const a = Math.atan2(rise, halfSpan);
    const L = Math.hypot(halfSpan, rise);
    const N = o.courses || 6;
    const step = L / N;
    const thick = 0.24;
    const nx = Math.sin(a), ny = Math.cos(a);
    const shade = new THREE.Color();

    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      for (let i = 0; i < N; i++) {
        const sdist = (i + 0.5) * step;
        const px = sgn * (halfSpan - Math.cos(a) * sdist);
        const py = Math.sin(a) * sdist;
        const off = thick * 0.5 + (i % 2 === 0 ? 0.05 : 0.0);
        shade.copy(tile).multiplyScalar(0.9 + 0.2 * ((i * 7 + side * 3) % 5) / 4);
        put(bRoof, BOX, W,
          px + sgn * nx * off, py + ny * off, 0,
          step + 0.16, thick, halfDepth * 2,
          0, 0, sgn > 0 ? -a : a, shade);
      }
      // fascia along the eave
      put(bRoof, BOX, W, sgn * (halfSpan + 0.05), -0.14, 0,
        0.20, 0.34, halfDepth * 2 + 0.1, 0, 0, 0, dark);
    }
    // ridge cap
    put(bRoof, BOX, W, 0, rise + 0.06, 0, 0.52, 0.26, halfDepth * 2 + 0.22, 0, 0, 0, tile);
    put(bRoof, BOX, W, 0, rise + 0.22, 0, 0.30, 0.16, halfDepth * 2 + 0.18, 0, 0, 0,
      new THREE.Color().copy(tile).multiplyScalar(1.12));

    // barge boards on the gable ends
    for (let end = 0; end < 2; end++) {
      const z = (end === 0 ? 1 : -1) * (halfDepth + 0.09);
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        put(bRoof, BOX, W, sgn * halfSpan * 0.5, rise * 0.5 + 0.16, z,
          L + 0.2, 0.20, 0.18, 0, 0, sgn > 0 ? -a : a, dark);
      }
    }
  }

  /** A window: frame, sill, muntins and an emissive pane. */
  function window1(W, x, y, z, ww, wh, lit, seed, faceRot, extras) {
    const frame = C(FRAME_WHITE);
    const dark = C(TIMBER[1]);
    const tint = C(GLASS_TINT);
    const g = [lit, seed];
    const R = faceRot || 0;
    const M = _mTmp.copy(W).multiply(compose(_mLocal, x, y, z, 1, 1, 1, 0, R, 0));
    const Wl = M.clone();

    put(bSolid, BOX, Wl, 0, 0, 0.04, ww + 0.20, wh + 0.20, 0.10, 0, 0, 0, frame);
    put(bGlow, BOX, Wl, 0, 0, 0.10, ww, wh, 0.06, 0, 0, 0, tint, { aGlow: g });
    put(bSolid, BOX, Wl, 0, 0, 0.14, 0.05, wh, 0.04, 0, 0, 0, dark);
    put(bSolid, BOX, Wl, 0, 0, 0.14, ww, 0.05, 0.04, 0, 0, 0, dark);
    put(bSolid, BOX, Wl, 0, -wh * 0.5 - 0.12, 0.12, ww + 0.40, 0.10, 0.26, 0, 0, 0, frame);

    if (extras && extras.shutters) {
      const sh = C(extras.shutterHex || 0x3E6E7A);
      for (let s = -1; s <= 1; s += 2) {
        put(bSolid, BOX, Wl, s * (ww * 0.5 + 0.20), 0, 0.06, 0.32, wh + 0.14, 0.07, 0, 0, 0, sh);
      }
    }
    if (extras && extras.box) {
      put(bSolid, BOX, Wl, 0, -wh * 0.5 - 0.32, 0.20, ww + 0.24, 0.26, 0.30, 0, 0, 0, C(PLANK[1]));
      const gr = C(GREEN);
      for (let i = -1; i <= 1; i++) {
        put(bSolid, SPH, Wl, i * (ww * 0.32), -wh * 0.5 - 0.16, 0.20, 0.30, 0.24, 0.28, 0, 0, 0, gr);
        put(bSolid, SPH, Wl, i * (ww * 0.32) + 0.06, -wh * 0.5 - 0.06, 0.22,
          0.13, 0.13, 0.13, 0, 0, 0, C(FLOWERS[(i + 1 + (seed * 7 | 0)) % FLOWERS.length]));
      }
    }
  }

  /** Half-timbering on one wall face: plates, studs, a mid rail and braces. */
  function halfTimber(W, faceRot, width, height, y0, z0) {
    const dark = C(TIMBER[(rng.int(0, 3))]);
    const M = _mTmp.copy(W).multiply(compose(_mLocal, 0, 0, 0, 1, 1, 1, 0, faceRot, 0));
    const Wl = M.clone();
    const t = 0.13;
    const zz = z0 + 0.05;

    put(bSolid, BOX, Wl, 0, y0 + 0.09, zz, width, 0.24, t, 0, 0, 0, dark);
    put(bSolid, BOX, Wl, 0, y0 + height - 0.11, zz, width, 0.26, t, 0, 0, 0, dark);
    const mid = y0 + height * 0.52;
    put(bSolid, BOX, Wl, 0, mid, zz, width, 0.20, t, 0, 0, 0, dark);

    const studs = Math.max(2, Math.round(width / 1.5));
    for (let i = 0; i <= studs; i++) {
      const x = -width * 0.5 + (width * i) / studs;
      put(bSolid, BOX, Wl, x, y0 + height * 0.5, zz, 0.20, height, t, 0, 0, 0, dark);
    }
    // corner posts, a touch fatter
    for (let s = -1; s <= 1; s += 2) {
      put(bSolid, BOX, Wl, s * width * 0.5, y0 + height * 0.5, zz, 0.28, height, t + 0.03, 0, 0, 0, dark);
    }
    // braces in the lower panel
    const bw = width / studs;
    const bh = mid - y0 - 0.2;
    const la = Math.atan2(bh, bw);
    const len = Math.hypot(bh, bw);
    for (let i = 0; i < studs; i++) {
      if (i % 2 === 1) continue;
      const cx = -width * 0.5 + bw * (i + 0.5);
      const sgn = (i % 4 === 0) ? 1 : -1;
      put(bSolid, BOX, Wl, cx, (y0 + 0.16 + mid) * 0.5, zz, len, 0.17, t * 0.92,
        0, 0, sgn * (Math.PI * 0.5 - la), dark);
    }
  }

  /** One building. `p` carries everything the kit needs to know. */
  function building(W, p) {
    const stucco = C(p.wallHex);
    const stone = C(p.stoneHex);
    const dark = C(TIMBER[0]);

    const w = p.w, d = p.d;
    const baseH = p.stoneBase ? 1.35 : 0;
    const h1 = p.h1;
    const h2 = p.storeys > 1 ? p.h2 : 0;
    const jut = p.storeys > 1 ? 0.34 : 0;
    const wallTop = baseH + h1 + h2;

    // stone plinth
    if (p.stoneBase) {
      put(bSolid, BOX, W, 0, baseH * 0.5, 0, w + 0.30, baseH, d + 0.30, 0, 0, 0, stone);
      put(bSolid, BOX, W, 0, baseH + 0.06, 0, w + 0.42, 0.16, d + 0.42, 0, 0, 0,
        new THREE.Color().copy(stone).multiplyScalar(1.1));
    } else {
      put(bSolid, BOX, W, 0, 0.16, 0, w + 0.24, 0.34, d + 0.24, 0, 0, 0, stone);
    }

    // ground storey
    put(bSolid, BOX, W, 0, baseH + h1 * 0.5, 0, w, h1, d, 0, 0, 0, stucco);
    if (p.style === 'plank') {
      const pl = C(p.plankHex);
      const rows = Math.max(3, Math.round(h1 / 0.55));
      for (let i = 0; i < rows; i++) {
        const y = baseH + (i + 0.5) * (h1 / rows);
        const prod = (i % 2) ? 0.05 : 0.02;
        put(bSolid, BOX, W, 0, y, d * 0.5 + prod, w + 0.06, h1 / rows - 0.05, 0.10, 0, 0, 0,
          new THREE.Color().copy(pl).multiplyScalar(0.92 + 0.16 * (i % 3) / 2));
      }
    } else {
      halfTimber(W, 0, w, h1, baseH, d * 0.5);
      halfTimber(W, Math.PI * 0.5, d, h1, baseH, w * 0.5);
      halfTimber(W, -Math.PI * 0.5, d, h1, baseH, w * 0.5);
    }

    // upper storey, jettied out over the street
    if (p.storeys > 1) {
      const w2 = w + jut * 2, d2 = d + jut * 2;
      put(bSolid, BOX, W, 0, baseH + h1 + h2 * 0.5, 0, w2, h2, d2, 0, 0, 0, stucco);
      put(bSolid, BOX, W, 0, baseH + h1 + 0.10, 0, w2 + 0.16, 0.24, d2 + 0.16, 0, 0, 0, dark);
      halfTimber(W, 0, w2, h2, baseH + h1, d2 * 0.5);
      halfTimber(W, Math.PI * 0.5, d2, h2, baseH + h1, w2 * 0.5);
      halfTimber(W, -Math.PI * 0.5, d2, h2, baseH + h1, w2 * 0.5);
      // corbels under the jetty
      for (let s = -1; s <= 1; s += 2) {
        put(bSolid, BOX, W, s * w * 0.32, baseH + h1 - 0.18, d * 0.5 + 0.18,
          0.22, 0.44, 0.5, -0.5, 0, 0, dark);
      }
    }

    // roof
    const topW = p.storeys > 1 ? w + jut * 2 : w;
    const topD = p.storeys > 1 ? d + jut * 2 : d;
    const ridgeAlongX = p.ridgeAlongX;
    const span = (ridgeAlongX ? topD : topW) * 0.5 + p.eave;
    const halfDepth = (ridgeAlongX ? topW : topD) * 0.5 + p.eave;
    const rise = span * p.pitch;
    compose(_mLocal, 0, wallTop, 0, 1, 1, 1, 0, ridgeAlongX ? Math.PI * 0.5 : 0, 0);
    const Wr = _mTmp.copy(W).multiply(_mLocal).clone();
    roof(Wr, span, halfDepth, rise, p.roofHex, { courses: p.courses });

    // gable fills, in the wall colour with a brace or two
    const gw = (ridgeAlongX ? topD : topW);
    for (let end = 0; end < 2; end++) {
      const z = (end === 0 ? 1 : -1) * ((ridgeAlongX ? topW : topD) * 0.5 - 0.05);
      put(bSolid, PRISM, Wr, 0, 0, z, gw, rise * (gw / (span * 2)), 0.20, 0, 0, 0, stucco);
      const gr = rise * (gw / (span * 2));
      put(bSolid, BOX, Wr, 0, gr * 0.45, z + 0.07, gw * 0.5, 0.16, 0.10, 0, 0, 0, dark);
      const ba = Math.atan2(gr, gw * 0.5);
      for (let s = -1; s <= 1; s += 2) {
        put(bSolid, BOX, Wr, s * gw * 0.22, gr * 0.28, z + 0.07,
          Math.hypot(gr * 0.55, gw * 0.26), 0.15, 0.09, 0, 0, s * (Math.PI * 0.5 - ba) * 0.9, dark);
      }
      // gable roundel
      if (p.gableWindow && end === 0) {
        put(bSolid, CYL8, Wr, 0, gr * 0.52, z + 0.10, 0.86, 0.14, 0.86, Math.PI * 0.5, 0, 0, C(FRAME_WHITE));
        put(bGlow, CYL8, Wr, 0, gr * 0.52, z + 0.17, 0.60, 0.10, 0.60, Math.PI * 0.5, 0, 0,
          C(GLASS_TINT), { aGlow: [p.lit * 0.9, p.flick] });
      }
    }

    // windows on the bay-facing wall
    const rows = p.storeys > 1 ? 2 : 1;
    const cols = Math.max(2, Math.round(w / 2.3));
    for (let r = 0; r < rows; r++) {
      const isUpper = r === 1;
      const fy = baseH + (isUpper ? h1 + h2 * 0.55 : h1 * 0.60);
      const fz = (isUpper ? (d + jut * 2) : d) * 0.5 + 0.02;
      for (let c = 0; c < cols; c++) {
        const fx = (-w * 0.5 + (w * (c + 0.5)) / cols) * (isUpper ? (w + jut * 2) / w : 1);
        if (!isUpper && p.door && c === p.doorCol) continue;
        const lit = rng.chance(p.litFraction) ? 0.75 + rng.range(0, 0.5) : 0.0;
        window1(W, fx, fy, fz, 0.86, 1.10, lit, rng.chance(0.16) ? rng.range(0.2, 1) : 0, 0,
          { shutters: p.shutters, shutterHex: p.shutterHex, box: isUpper && rng.chance(0.45) });
      }
    }
    // a window each side
    for (let s = -1; s <= 1; s += 2) {
      const lit = rng.chance(p.litFraction * 0.7) ? 0.7 + rng.range(0, 0.4) : 0.0;
      window1(W, s * (w * 0.5 + 0.02), baseH + h1 * 0.58, d * 0.12, 0.72, 0.96,
        lit, 0, s * Math.PI * 0.5, { shutters: false });
    }

    // door
    if (p.door) {
      const dx = -w * 0.5 + (w * (p.doorCol + 0.5)) / cols;
      const dz = d * 0.5 + 0.02;
      put(bSolid, BOX, W, dx, baseH + 1.10, dz + 0.03, 1.22, 2.24, 0.14, 0, 0, 0, dark);
      put(bSolid, BOX, W, dx, baseH + 1.08, dz + 0.10, 1.00, 2.06, 0.10, 0, 0, 0, C(p.doorHex));
      put(bSolid, BOX, W, dx, baseH + 2.30, dz + 0.16, 1.50, 0.20, 0.36, 0, 0, 0, dark);
      put(bSolid, BOX, W, dx, baseH + 0.09, dz + 0.28, 1.60, 0.20, 0.66, 0, 0, 0, stone);
      put(bSolid, SPH, W, dx + 0.34, baseH + 1.10, dz + 0.17, 0.16, 0.16, 0.16, 0, 0, 0, C(0xC9A24A));
    }

    // awning over the shopfront
    if (p.awning) {
      const [ha, hb] = p.awningHex;
      const ca = C(ha), cb = C(hb);
      const aw = Math.min(w + 0.6, 5.6);
      const strips = Math.max(5, Math.round(aw / 0.52));
      const alen = 1.55;
      const tilt = -0.42;
      const ay = baseH + h1 - 0.35;
      for (let i = 0; i < strips; i++) {
        const x = -aw * 0.5 + (aw * (i + 0.5)) / strips;
        put(bCloth, BOX, W, x, ay - 0.24, d * 0.5 + 0.78, aw / strips + 0.01, 0.09, alen,
          tilt, 0, 0, i % 2 ? ca : cb);
      }
      put(bSolid, BOX, W, 0, ay + 0.06, d * 0.5 + 0.14, aw + 0.2, 0.18, 0.22, 0, 0, 0, dark);
      // scalloped valance
      for (let i = 0; i < strips; i++) {
        const x = -aw * 0.5 + (aw * (i + 0.5)) / strips;
        put(bCloth, BOX, W, x, ay - 0.86, d * 0.5 + 1.44, aw / strips + 0.01, 0.34, 0.07,
          0, 0, 0, i % 2 ? ca : cb);
      }
      for (let s = -1; s <= 1; s += 2) {
        put(bSolid, BOX, W, s * aw * 0.48, ay - 1.05, d * 0.5 + 1.45, 0.10, 2.1, 0.10, 0, 0, 0, dark);
      }
    }

    // hanging shop sign
    if (p.sign) {
      const sx = w * 0.5 - 0.4;
      const sy = baseH + h1 + (p.storeys > 1 ? 0.4 : -0.2);
      put(bSolid, BOX, W, sx, sy + 0.5, d * 0.5 + 0.55, 0.12, 0.12, 1.3, 0, 0, 0, dark);
      put(bSolid, BOX, W, sx, sy + 0.24, d * 0.5 + 0.55, 0.06, 0.6, 0.06, 0, 0, 0, dark);
      put(bSolid, BOX, W, sx, sy - 0.34, d * 0.5 + 0.55, 0.10, 0.86, 1.05, 0, 0, 0, C(p.signHex));
      put(bSolid, BOX, W, sx, sy - 0.34, d * 0.5 + 0.55, 0.13, 0.92, 0.14, 0, 0, 0, dark);
    }

    // chimneys
    for (let i = 0; i < p.chimneys; i++) {
      const cxp = (i === 0 ? -1 : 1) * w * 0.28;
      const czp = (rng.chance(0.5) ? -1 : 1) * d * 0.22;
      const top = wallTop + rise * 0.75 + 1.4;
      put(bSolid, BOX, W, cxp, top * 0.5 + 0.6, czp, 0.86, top - 0.6, 0.80, 0, 0, 0, C(BRICK));
      put(bSolid, BOX, W, cxp, top + 0.10, czp, 1.10, 0.24, 1.04, 0, 0, 0, stone);
      put(bSolid, CYL8, W, cxp - 0.2, top + 0.42, czp, 0.30, 0.52, 0.30, 0, 0, 0, C(0x53412F));
      put(bSolid, CYL8, W, cxp + 0.2, top + 0.36, czp, 0.26, 0.42, 0.26, 0, 0, 0, C(0x53412F));
    }

    // dormer
    if (p.dormer) {
      const dy = wallTop + rise * 0.38;
      const dz = topD * 0.5 - 0.35;
      put(bSolid, BOX, W, p.dormerX, dy + 0.75, dz, 1.5, 1.5, 1.4, 0, 0, 0, stucco);
      compose(_mLocal, p.dormerX, dy + 1.5, dz, 1, 1, 1, 0, 0, 0);
      const Wd = _mTmp.copy(W).multiply(_mLocal).clone();
      roof(Wd, 1.0, 0.85, 0.85, p.roofHex, { courses: 3 });
      put(bSolid, PRISM, Wd, 0, 0, 0.7, 1.5, 0.85, 0.16, 0, 0, 0, stucco);
      window1(W, p.dormerX, dy + 1.05, dz + 0.72, 0.70, 0.80,
        rng.chance(p.litFraction) ? 0.9 : 0, 0, 0, null);
    }

    // little balcony
    if (p.balcony && p.storeys > 1) {
      const by = baseH + h1 + 0.1;
      const bz = (d + jut * 2) * 0.5 + 0.6;
      put(bSolid, BOX, W, 0, by, bz, w * 0.8, 0.16, 1.2, 0, 0, 0, C(PLANK[0]));
      put(bSolid, BOX, W, 0, by + 0.86, bz + 0.55, w * 0.8, 0.12, 0.12, 0, 0, 0, dark);
      const posts = 6;
      for (let i = 0; i <= posts; i++) {
        const x = -w * 0.4 + (w * 0.8 * i) / posts;
        put(bSolid, BOX, W, x, by + 0.45, bz + 0.55, 0.09, 0.9, 0.09, 0, 0, 0, dark);
      }
      for (let s = -1; s <= 1; s += 2) {
        put(bSolid, BOX, W, s * w * 0.4, by + 0.45, bz, 0.09, 0.9, 1.2, 0, 0, 0, dark);
      }
    }

    // external stair
    if (p.stair) {
      const sx = -(w * 0.5 + 0.55);
      for (let i = 0; i < 7; i++) {
        put(bSolid, BOX, W, sx, baseH + 0.24 + i * 0.42, -d * 0.3 + i * 0.42,
          1.20, 0.22, 0.48, 0, 0, 0, C(STONE[i % STONE.length]));
      }
    }

    // clutter by the door
    if (p.clutter) {
      const cxp = w * 0.5 - 0.9;
      put(bSolid, CYL12, W, cxp, baseH + 0.42, d * 0.5 + 0.65, 0.66, 0.84, 0.66, 0, 0, 0, C(PLANK[1]));
      put(bSolid, CYL12, W, cxp, baseH + 0.84, d * 0.5 + 0.65, 0.70, 0.10, 0.70, 0, 0, 0, C(0x6A6258));
      put(bSolid, BOX, W, cxp - 1.05, baseH + 0.28, d * 0.5 + 0.60, 0.72, 0.56, 0.72,
        0, rng.range(-0.4, 0.4), 0, C(PLANK[2]));
      put(bSolid, BOX, W, cxp - 1.05, baseH + 0.76, d * 0.5 + 0.60, 0.60, 0.42, 0.60,
        0, rng.range(-0.4, 0.4), 0, C(PLANK[0]));
    }
  }

  // =========================================================================
  // LAYOUT
  // =========================================================================

  const placed = [];
  const Wb = new THREE.Matrix4();

  function makeParams(row, isShop) {
    const style = rng.chance(0.24) ? 'plank' : 'timber';
    const storeys = rng.chance(row < 3 ? 0.72 : 0.45) ? 2 : 1;
    const w = rng.range(5.0, 7.6);
    const d = rng.range(4.8, 6.6);
    const cols = Math.max(2, Math.round(w / 2.3));
    return {
      w, d,
      h1: rng.range(3.1, 3.7),
      h2: rng.range(2.7, 3.2),
      storeys,
      style,
      stoneBase: rng.chance(0.34),
      wallHex: STUCCO[rng.int(0, STUCCO.length - 1)],
      plankHex: PLANK[rng.int(0, PLANK.length - 1)],
      stoneHex: STONE[rng.int(0, STONE.length - 1)],
      roofHex: ROOFS[rng.int(0, ROOFS.length - 1)],
      doorHex: DOORS[rng.int(0, DOORS.length - 1)],
      signHex: PLANK[rng.int(0, PLANK.length - 1)],
      shutterHex: rng.chance(0.5) ? 0x3E6E7A : 0x8C4438,
      pitch: rng.range(0.95, 1.30),
      eave: rng.range(0.40, 0.62),
      courses: 6,
      ridgeAlongX: rng.chance(0.45),
      chimneys: rng.chance(0.35) ? 2 : 1,
      dormer: rng.chance(0.30),
      dormerX: rng.range(-1.4, 1.4),
      balcony: rng.chance(0.24),
      stair: rng.chance(0.18),
      clutter: rng.chance(0.42),
      shutters: rng.chance(0.55),
      gableWindow: rng.chance(0.4),
      door: true,
      doorCol: rng.int(0, cols - 1),
      awning: isShop && rng.chance(0.75),
      awningHex: AWNINGS[rng.int(0, AWNINGS.length - 1)],
      sign: isShop && rng.chance(0.55),
      litFraction: 0.42 + rng.range(0, 0.44),
      lit: rng.chance(0.6) ? 0.9 : 0.0,
      flick: rng.chance(0.2) ? rng.range(0.2, 1) : 0,
    };
  }

  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r];
    for (let i = 0; i < row.n; i++) {
      const f = row.n === 1 ? 0.5 : i / (row.n - 1);
      const ang = (row.a0 + (row.a1 - row.a0) * f + rng.range(-3.2, 3.2)) * DEG;
      const h = row.h + rng.range(-0.9, 0.9);
      const rad = radiusFor(ang, h);
      const x = ISLE_X + Math.cos(ang) * rad;
      const z = ISLE_Z + Math.sin(ang) * rad;

      let clash = false;
      for (const q of placed) {
        const dx = q.x - x, dz = q.z - z;
        if (dx * dx + dz * dz < 84) { clash = true; break; }
      }
      if (clash) continue;
      if (landAt(x, z) < -5) continue;

      const p = makeParams(r, r <= 1);
      const rot = Math.atan2(Math.cos(ang), Math.sin(ang)) + rng.range(-0.16, 0.16);
      const y = padHeight(x, z, p.w + 1.2, p.d + 1.2, rot) - 0.30;

      compose(Wb, x, y, z, 1, 1, 1, 0, rot, 0);
      building(Wb.clone(), p);
      placed.push({ x, z, y, rot, r });

      // a small retaining wall holding the terrace up in front
      if (rng.chance(0.6)) {
        const fwdX = Math.cos(ang), fwdZ = Math.sin(ang);
        const wx = x + fwdX * (p.d * 0.5 + 2.2);
        const wz = z + fwdZ * (p.d * 0.5 + 2.2);
        const wy = landAt(wx, wz);
        compose(_mOut, wx, wy, wz, 1, 1, 1, 0, rot, 0);
        const Ww = _mOut.clone();
        const wl = p.w + rng.range(1.0, 3.0);
        put(bSolid, BOX, Ww, 0, 0.42, 0, wl, 1.5, 0.7, 0, 0, 0, C(STONE[rng.int(0, 3)]));
        for (let k = 0; k < 5; k++) {
          put(bSolid, BOX, Ww, -wl * 0.4 + wl * 0.2 * k, 0.92, 0.06,
            wl * 0.18, 0.26, 0.82, 0, 0, 0, C(STONE[(k + 1) % 4]));
        }
      }
    }
  }

  // --- the Salty Fin --------------------------------------------------------

  const sfAng = 58 * DEG;
  const sfRad = radiusFor(sfAng, 4.0);
  const sfX = ISLE_X + Math.cos(sfAng) * sfRad;
  const sfZ = ISLE_Z + Math.sin(sfAng) * sfRad;
  const sfRot = Math.atan2(Math.cos(sfAng), Math.sin(sfAng));
  const sfY = padHeight(sfX, sfZ, 13, 11, sfRot) - 0.3;

  const sf = makeParams(0, true);
  sf.w = 11.0; sf.d = 8.6;
  sf.h1 = 4.2; sf.h2 = 3.5; sf.storeys = 2;
  sf.style = 'timber';
  sf.stoneBase = true;
  sf.wallHex = 0xF2E6CE;
  sf.roofHex = 0xB4462E;
  sf.pitch = 1.20;
  sf.eave = 0.72;
  sf.courses = 8;
  sf.ridgeAlongX = true;
  sf.chimneys = 2;
  sf.dormer = true;
  sf.dormerX = 2.2;
  sf.balcony = true;
  sf.clutter = true;
  sf.shutters = true;
  sf.gableWindow = true;
  sf.awning = true;
  sf.awningHex = AWNINGS[0];
  sf.sign = false;
  sf.doorCol = 2;
  sf.litFraction = 0.95;
  sf.lit = 1.0;

  compose(Wb, sfX, sfY, sfZ, 1, 1, 1, 0, sfRot, 0);
  const Wsf = Wb.clone();
  building(Wsf.clone(), sf);
  placed.push({ x: sfX, z: sfZ, y: sfY, rot: sfRot, r: 0 });

  // the big hanging sign board, its bracket, and two lanterns
  const signTex = makeSignTexture();
  const signMat = new THREE.MeshStandardMaterial({
    map: signTex, roughness: 0.78, metalness: 0.0, fog: true,
  });
  const signGeo = new THREE.PlaneGeometry(4.6, 2.3);
  const signBack = signGeo.clone();
  signBack.rotateY(Math.PI);

  const signFront = new THREE.Mesh(signGeo, signMat);
  const signRear = new THREE.Mesh(signBack, signMat);
  const signPivot = new THREE.Group();
  signPivot.position.set(0, sf.h1 + sf.h2 + 1.35 - 0.55, sf.d * 0.5 + 2.5);
  signFront.position.z = 0.07;
  signRear.position.z = -0.07;
  signPivot.add(signFront, signRear);
  const signRoot = new THREE.Group();
  signRoot.matrixAutoUpdate = false;
  signRoot.matrix.copy(Wsf);
  signRoot.matrixWorldNeedsUpdate = true;
  signRoot.add(signPivot);
  group.add(signRoot);
  signFront.castShadow = true;

  {
    const dark = C(TIMBER[0]);
    const y = sf.h1 + sf.h2 + 1.35;
    const zf = sf.d * 0.5;
    // bracket arm out over the street
    put(bSolid, BOX, Wsf, 0, y + 1.5, zf + 0.25, 0.30, 0.30, 0.8, 0, 0, 0, dark);
    put(bSolid, BOX, Wsf, 0, y + 1.5, zf + 1.6, 0.26, 0.26, 2.6, 0, 0, 0, dark);
    put(bSolid, BOX, Wsf, 0, y + 0.9, zf + 0.9, 0.20, 1.7, 0.20, 0.72, 0, 0, dark);
    for (let s = -1; s <= 1; s += 2) {
      // chains from the arm down to the board
      put(bSolid, BOX, Wsf, s * 1.9, y + 1.05, zf + 2.5, 0.09, 0.95, 0.09, 0, 0, 0, dark);
      put(bSolid, BOX, Wsf, s * 1.9, y + 1.44, zf + 2.5, 0.16, 0.20, 0.16, 0, 0, 0, dark);
    }
    // frame around the board (board is 4.6 x 2.3, centred at y - 0.55)
    put(bSolid, BOX, Wsf, 0, y + 0.72, zf + 2.5, 5.1, 0.24, 0.26, 0, 0, 0, dark);
    put(bSolid, BOX, Wsf, 0, y - 1.82, zf + 2.5, 5.1, 0.24, 0.26, 0, 0, 0, dark);
    for (let s = -1; s <= 1; s += 2) {
      put(bSolid, BOX, Wsf, s * 2.43, y - 0.55, zf + 2.5, 0.24, 2.8, 0.26, 0, 0, 0, dark);
    }
    // lanterns either side of the door
    for (let s = -1; s <= 1; s += 2) {
      const lx = s * 3.2, ly = 1.35 + 2.8, lz = zf + 0.35;
      put(bSolid, BOX, Wsf, lx, ly + 0.55, lz, 0.16, 0.9, 0.16, 0, 0, 0, dark);
      put(bSolid, BOX, Wsf, lx, ly + 0.98, lz - 0.22, 0.14, 0.14, 0.5, 0, 0, 0, dark);
      put(bSolid, CONE, Wsf, lx, ly + 0.44, lz, 0.62, 0.36, 0.62, 0, 0, 0, C(0x2E2A24));
      put(bGlow, BOX, Wsf, lx, ly, lz, 0.40, 0.52, 0.40, 0, 0, 0, C(0xFFE0A8),
        { aGlow: [1.35, 0.55 + s * 0.2] });
      put(bSolid, BOX, Wsf, lx, ly - 0.34, lz, 0.52, 0.14, 0.52, 0, 0, 0, C(0x2E2A24));
    }
  }

  // --- church / clocktower on the ridge -------------------------------------
  {
    const ang = 104 * DEG;
    const rad = radiusFor(ang, 40.5);
    const x = ISLE_X + Math.cos(ang) * rad;
    const z = ISLE_Z + Math.sin(ang) * rad;
    const rot = Math.atan2(Math.cos(ang), Math.sin(ang));
    const y = padHeight(x, z, 9, 9, rot) - 0.2;
    compose(Wb, x, y, z, 1, 1, 1, 0, rot, 0);
    const W = Wb.clone();

    const stucco = C(0xF4EADA);
    const dark = C(TIMBER[0]);
    const stone = C(STONE[1]);
    const spire = C(0xA83A2A);

    put(bSolid, BOX, W, 0, 0.5, 0, 6.6, 1.0, 6.6, 0, 0, 0, stone);
    put(bSolid, BOX, W, 0, 8.0, 0, 5.4, 14.0, 5.4, 0, 0, 0, stucco);
    put(bSolid, BOX, W, 0, 15.2, 0, 6.2, 0.5, 6.2, 0, 0, 0, dark);
    // belfry
    put(bSolid, BOX, W, 0, 17.2, 0, 4.6, 3.6, 4.6, 0, 0, 0, stucco);
    for (let f = 0; f < 4; f++) {
      const a = f * Math.PI * 0.5;
      put(bSolid, BOX, W, Math.sin(a) * 2.36, 17.2, Math.cos(a) * 2.36,
        2.2, 2.6, 0.18, 0, a, 0, dark);
      put(bGlow, BOX, W, Math.sin(a) * 2.42, 17.2, Math.cos(a) * 2.42,
        1.8, 2.2, 0.10, 0, a, 0, C(GLASS_TINT), { aGlow: [1.1, 0] });
    }
    put(bSolid, BOX, W, 0, 19.3, 0, 5.6, 0.6, 5.6, 0, 0, 0, dark);
    // clock face
    put(bSolid, CYL12, W, 0, 11.6, 2.78, 2.5, 0.20, 2.5, Math.PI * 0.5, 0, 0, C(0xF7F0DE));
    put(bSolid, CYL12, W, 0, 11.6, 2.72, 2.8, 0.18, 2.8, Math.PI * 0.5, 0, 0, dark);
    put(bSolid, BOX, W, 0, 12.1, 2.90, 0.13, 1.0, 0.06, 0, 0, 0, dark);
    put(bSolid, BOX, W, 0.45, 11.6, 2.90, 0.9, 0.13, 0.06, 0, 0, 0, dark);
    // spire
    put(bSolid, CONE, W, 0, 24.6, 0, 5.6, 10.0, 5.6, 0, 0, 0, spire);
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      put(bSolid, CONE, W, 0, 20.1 + t * 9.2, 0, 5.4 * (1 - t) + 0.3, 0.5, 5.4 * (1 - t) + 0.3,
        0, 0, 0, new THREE.Color().copy(spire).multiplyScalar(0.86 + 0.24 * (i % 2)));
    }
    put(bSolid, CYL8, W, 0, 30.0, 0, 0.18, 1.6, 0.18, 0, 0, 0, dark);
    put(bSolid, SPH, W, 0, 30.9, 0, 0.44, 0.44, 0.44, 0, 0, 0, C(0xC9A24A));
    put(bSolid, BOX, W, 0, 31.6, 0, 0.10, 1.2, 0.10, 0, 0, 0, C(0xC9A24A));
    put(bSolid, BOX, W, 0, 31.9, 0, 0.7, 0.10, 0.10, 0, 0, 0, C(0xC9A24A));
    // a low nave off the back
    put(bSolid, BOX, W, 0, 2.6, -6.2, 5.0, 5.2, 7.0, 0, 0, 0, stucco);
    compose(_mLocal, 0, 5.2, -6.2, 1, 1, 1, 0, Math.PI * 0.5, 0);
    roof(_mTmp.copy(W).multiply(_mLocal).clone(), 4.2, 3.0, 3.4, 0xA83A2A, { courses: 5 });
  }

  // --- windmill, further back along the ridge -------------------------------
  const windmill = new THREE.Group();
  const bladeGroup = new THREE.Group();
  {
    const ang = 78 * DEG;
    const rad = radiusFor(ang, 42.0);
    const x = ISLE_X + Math.cos(ang) * rad;
    const z = ISLE_Z + Math.sin(ang) * rad;
    const rot = Math.atan2(Math.cos(ang), Math.sin(ang));
    const y = padHeight(x, z, 8, 8, rot) - 0.2;
    compose(Wb, x, y, z, 1, 1, 1, 0, rot, 0);
    const W = Wb.clone();

    const wall = C(0xEFE2C4);
    const dark = C(TIMBER[0]);
    put(bSolid, CYL12, W, 0, 0.4, 0, 6.4, 0.8, 6.4, 0, 0, 0, C(STONE[2]));
    put(bSolid, CYLT, W, 0, 5.6, 0, 6.0, 10.0, 6.0, 0, 0, 0, wall);
    put(bSolid, CYL12, W, 0, 10.8, 0, 4.6, 0.5, 4.6, 0, 0, 0, dark);
    put(bSolid, CONE, W, 0, 12.4, 0, 4.6, 3.0, 4.6, 0, 0, 0, C(0x7A4A2C));
    put(bSolid, BOX, W, 0, 6.0, 0, 0.28, 9.0, 3.7, 0, 0, 0, dark);
    put(bSolid, BOX, W, 0, 4.2, 2.05, 3.6, 0.24, 0.24, 0, 0, 0, dark);
    put(bGlow, BOX, W, 0, 7.4, 2.02, 0.9, 1.1, 0.10, 0, 0, 0, C(GLASS_TINT), { aGlow: [0.9, 0.4] });
    put(bSolid, BOX, W, 0, 1.3, 2.0, 1.1, 2.4, 0.16, 0, 0, 0, dark);

    // blades — their own little mesh so they can turn
    const bb = makeBuilder();
    const I = new THREE.Matrix4();
    const sail = C(0xE8DCC0);
    const arm = C(0x6B4E31);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5;
      compose(_mLocal, 0, 0, 0, 1, 1, 1, 0, 0, a);
      const Wa = _mLocal.clone();
      put(bb, BOX, Wa, 0, 4.4, 0, 0.30, 8.6, 0.22, 0, 0, 0, arm);
      for (let k = 0; k < 6; k++) {
        put(bb, BOX, Wa, 0.62, 1.4 + k * 1.25, 0.02, 1.0, 1.05, 0.07, 0, 0, 0,
          k % 2 ? sail : new THREE.Color().copy(sail).multiplyScalar(0.88));
      }
      put(bb, BOX, Wa, 0.62, 4.4, 0, 0.14, 8.0, 0.16, 0, 0, 0, arm);
    }
    bb.add(CYL12, compose(I, 0, 0, 0, 1.0, 0.7, 1.0, Math.PI * 0.5, 0, 0), C(0x3C2A1B));
    const bladeGeo = bb.build();
    const bladeMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide, fog: true,
    });
    const bladeMesh = new THREE.Mesh(bladeGeo, bladeMat);
    bladeMesh.castShadow = true;
    bladeGroup.add(bladeMesh);
    bladeGroup.position.set(0, 11.4, 2.6);
    windmill.matrixAutoUpdate = false;
    windmill.matrix.copy(W);
    windmill.matrixWorldNeedsUpdate = true;
    windmill.add(bladeGroup);
    group.add(windmill);
    windmill.userData.mat = bladeMat;
    windmill.userData.geo = bladeGeo;
  }

  // --- the stone stair ------------------------------------------------------
  // `stairPts` escapes the block: world/harbour.js turns it into a walkable
  // corridor, so the street you climb on foot is the same polyline the steps
  // were laid along and cannot drift from it.
  const stairPts = [];
  {
    // The waypoints, solved against the terrain as before.
    const way = [];
    for (const [aDeg, h] of PATH) {
      const a = aDeg * DEG;
      const rad = radiusFor(a, h);
      way.push(new THREE.Vector3(ISLE_X + Math.cos(a) * rad, 0, ISLE_Z + Math.sin(a) * rad));
    }

    // Sample the whole run at half-metre spacing, then LIMIT THE GRADIENT.
    //
    // Laying each step at raw `landAt` made the flight follow every lump of
    // the hill, and the hill here is a 50 degree face: measured along the
    // drawn centreline, eleven risers were over 0.70 m and the worst was
    // 1.12 m. Nobody climbs a 1.1 m step, and neither does the walk
    // controller — the flood fill from the quay died at 20.9 m of a 43 m
    // climb, every time, at whichever spike came first.
    //
    // A flight of stairs is a constant pitch, not a terrain follower. Two
    // sweeps clamp the rise between neighbours to RISE_MAX, forward then
    // backward, which is the cheapest way to get a monotone-ish profile that
    // still sits on the ground wherever the ground is gentle enough to allow
    // it. The result is what gets drawn AND what world/harbour.js walks on —
    // the same array, so the steps you see and the surface you stand on are
    // one object by construction.
    const STEP_LEN = 0.5;
    const RISE_MAX = 0.34;              // per STEP_LEN: about a 34 degree flight
    for (let i = 0; i < way.length - 1; i++) {
      const a = way[i], b = way[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(2, Math.round(len / STEP_LEN));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const y = landAt(x, z);
        if (y < -3) continue;
        stairPts.push(new THREE.Vector3(x, y, z));
      }
    }
    for (let i = 1; i < stairPts.length; i++) {
      const d = stairPts[i].y - stairPts[i - 1].y;
      if (d > RISE_MAX) stairPts[i].y = stairPts[i - 1].y + RISE_MAX;
      else if (d < -RISE_MAX) stairPts[i].y = stairPts[i - 1].y - RISE_MAX;
    }
    for (let i = stairPts.length - 2; i >= 0; i--) {
      const d = stairPts[i].y - stairPts[i + 1].y;
      if (d > RISE_MAX) stairPts[i].y = stairPts[i + 1].y + RISE_MAX;
    }

    // Lay a step box at every sample, along the local run direction.
    const Wp = new THREE.Matrix4();
    for (let i = 0; i < stairPts.length; i++) {
      const p = stairPts[i];
      const q = stairPts[Math.min(stairPts.length - 1, i + 1)];
      const r = stairPts[Math.max(0, i - 1)];
      const yaw = Math.atan2(q.x - r.x, q.z - r.z);
      compose(Wp, p.x, p.y, p.z, 1, 1, 1, 0, yaw, 0);
      // Deeper than the sample spacing so consecutive treads overlap; a stair
      // built from non-overlapping boxes shows daylight between every step
      // wherever the run is not axis-aligned.
      put(bSolid, BOX, Wp, 0, -0.14, 0, 2.5, 0.46, 0.86, 0, 0, 0,
        C(STONE[i % STONE.length]));
      if (i % 4 === 0) {
        put(bSolid, BOX, Wp, 1.45, 0.12, 0, 0.55, 0.7, 0.9, 0, 0, 0, C(STONE[(i + 2) % 4]));
        put(bSolid, BOX, Wp, -1.45, 0.10, 0, 0.55, 0.6, 0.9, 0, 0, 0, C(STONE[(i + 1) % 4]));
      }
    }
  }

  // --- assemble -------------------------------------------------------------

  const uniforms = {
    time: uniform(0),
    color: uniform(new THREE.Color(1, 0.72, 0.36)),
    intensity: uniform(0),
  };

  const matSolid = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0, fog: true,
  });
  const matRoof = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.66, metalness: 0.0, fog: true,
  });
  const matCloth = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0, side: THREE.DoubleSide, fog: true,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1E26);

  const meshes = [];
  const geos = [];
  const mk = (builder, mat, name) => {
    if (builder.empty) return null;
    const g = builder.build();
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    meshes.push(m);
    group.add(m);
    return m;
  };

  mk(bSolid, matSolid, 'village.solid');
  mk(bRoof, matRoof, 'village.roof');
  mk(bCloth, matCloth, 'village.cloth');
  mk(bGlow, matGlow, 'village.glow');

  // --- practicals -----------------------------------------------------------

  const lights = [];
  for (let s = -1; s <= 1; s += 2) {
    const l = new THREE.PointLight(0xffb755, 0, 26, 2);
    l.position.set(s * 3.2, 4.2, sf.d * 0.5 + 0.5);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(Wsf);
    holder.matrixWorldNeedsUpdate = true;
    holder.add(l);
    group.add(holder);
    lights.push(l);
  }

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  for (const l of lights) l.layers.enableAll();

  const state = { t: 0 };

  return {
    group,

    /**
     * The stone stair's centreline, shore end first. The steps sit on the
     * terrain, so a walker on this polyline should take its height from
     * `terrain.landHeight` rather than from the y in these points (which is 0).
     */
    stair: stairPts,

    update(ctx) {
      state.t = ctx.time;
      uniforms.time.value = ctx.time;
      bladeGroup.rotation.z = ctx.time * 0.22;
    },

    applyEnv(env) {
      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.windowIntensity;
      const li = env.lanternIntensity * 9.0;
      for (const l of lights) {
        l.color.copy(env.windowLight);
        // Never toggle a LIGHT's visibility. three keys every render object on
        // [object, material, renderContext, lightsNode], so changing which
        // lights exist builds a different lights node, every render object in
        // the scene misses the chain map, and all of them are disposed and
        // recompiled — synchronously, on WebGPU. Measured: one 8.5-second
        // frame at the hour this crossed. Intensity 0 costs one dead light
        // loop per fragment and nothing else.
        l.intensity = li;
      }
    },

    dispose() {
      for (const g of geos) g.dispose();
      for (const g of SOURCES) g.dispose();
      matSolid.dispose(); matRoof.dispose(); matCloth.dispose(); matGlow.dispose();
      signMat.dispose(); signTex.dispose();
      signGeo.dispose(); signBack.dispose();
      if (windmill.userData.geo) windmill.userData.geo.dispose();
      if (windmill.userData.mat) windmill.userData.mat.dispose();
    },
  };
}
