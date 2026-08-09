// The dock.
//
// A wide plank deck on chunky round pilings running out from the shore at
// (-95, 0, 10) to (-58, 0, -4), with two finger piers, a lower landing stage,
// cross-braced pilings, tyre fenders, cleats, rope, crab pots and lamp posts.
//
// Everything is merged into three meshes: the deck-and-furniture mesh above
// water, the piling mesh (which also goes into the refraction pass so the posts
// carry on down through the surface to the seabed), and the emissive lamp glass.
// The pilings are modelled full length from the seabed to the deck; the
// refraction pass's clip plane trims them at the waterline for free.

import * as THREE from 'three';
import { Fn, uniform, attribute, vertexColor, float, sin, step } from 'three/tsl';
import { LAYER, setLayers, addLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// --- binding world layout ----------------------------------------------------

const SHORE = new THREE.Vector2(-95, 10);
const HEAD = new THREE.Vector2(-58, -4);
const MAIN_W = 9.0;

const DECK = [0x9A7A50, 0x8A6C46, 0xA5854F, 0x7E6340, 0x93764C];
const POST = [0x6B5238, 0x5C462F, 0x765B3E];
const IRON = 0x3A3A3E;
const RUBBER = 0x1E1E20;
const ROPE = 0xC7B189;
const CRATE = [0x8A6A44, 0x9B7B50, 0x6F573A];

// --- scratch -----------------------------------------------------------------

const _mLocal = new THREE.Matrix4();
const _mOut = new THREE.Matrix4();
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

// The lamp glass. `aGlow.x` is how lit the pane is, `aGlow.y` a flicker seed
// (0 = steady); the pane tint is the vertex colour. The old build injected this
// into `totalEmissiveRadiance`; here it is the material's `emissiveNode`, which
// replaces the (unused) `emissive` term outright.
//
// `vertexColor()` is a vec4 — instancing can supply a fourth channel — so the
// multiply has to take `.rgb` or the emissive picks up an alpha it has no
// business seeing.
function makeGlowMaterial(uniforms, baseHex) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: C(baseHex), roughness: 0.30, metalness: 0.0, vertexColors: true, fog: true,
  });
  m.emissiveNode = Fn(() => {
    const glow = attribute('aGlow', 'vec2');
    const gph = glow.y.toVar();
    const gfl = float(1).add(step(0.001, gph).mul(
      sin(uniforms.time.mul(gph.mul(3.1).add(1.9)).add(gph.mul(29.0))).mul(0.13)
        .add(sin(uniforms.time.mul(gph.mul(1.7).add(6.3)).add(gph.mul(13.0))).mul(0.07)),
    ));
    return uniforms.color.mul(uniforms.intensity.mul(glow.x).mul(gfl)).mul(vertexColor().rgb);
  })();
  return m;
}

// =============================================================================

export function createDock(opts = {}) {
  const terrain = opts.terrain || null;
  const rng = makeRng(((opts.seed || 1) ^ 0xD0C4A1) >>> 0);

  const group = new THREE.Group();
  group.name = 'dock';

  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const CYL10 = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const CONE = new THREE.ConeGeometry(0.5, 1, 10);
  const TORUS = new THREE.TorusGeometry(0.5, 0.17, 6, 14);
  const RING = new THREE.TorusGeometry(0.5, 0.09, 5, 12);
  const SOURCES = [BOX, CYL8, CYL10, CYL12, CONE, TORUS, RING];

  const bDeck = makeBuilder();
  const bPost = makeBuilder();
  const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

  const put = (B, geo, W, x, y, z, sx, sy, sz, rx, ry, rz, color, extra) => {
    compose(_mLocal, x, y, z, sx, sy, sz, rx, ry, rz);
    _mOut.multiplyMatrices(W, _mLocal);
    B.add(geo, _mOut, color, extra);
  };

  const seabedAt = (x, z) => {
    if (!terrain || !terrain.seabedHeight) return -4;
    const h = terrain.seabedHeight(x, z);
    return Number.isFinite(h) ? Math.min(h, 0.2) : -4;
  };
  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return -1e4;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };
  /** The ground the pilings stand on: land where there is land, seabed otherwise. */
  const groundAt = (x, z) => Math.max(landAt(x, z), seabedAt(x, z));

  // --- the deck frame -------------------------------------------------------

  const dirX = HEAD.x - SHORE.x;
  const dirZ = HEAD.y - SHORE.y;
  const runLen = Math.hypot(dirX, dirZ);
  const ux = dirX / runLen, uz = dirZ / runLen;      // along the pier
  const rx = -uz, rz = ux;                            // across the pier
  const yaw = Math.atan2(ux, uz);

  const shoreLand = landAt(SHORE.x, SHORE.y);
  const DECK_Y = Math.max(2.9, (Number.isFinite(shoreLand) && shoreLand > -50 ? shoreLand : 2.4) + 0.55);
  const DECK_T = 0.30;

  const centreX = SHORE.x + ux * runLen * 0.5;
  const centreZ = SHORE.y + uz * runLen * 0.5;

  // World matrix of the pier: origin at the shore end, +Z runs out to sea.
  const Wpier = new THREE.Matrix4();
  compose(Wpier, SHORE.x, DECK_Y, SHORE.y, 1, 1, 1, 0, yaw, 0);
  const WpierInv = new THREE.Matrix4().copy(Wpier).invert();

  const toWorld = (u, v, out) => {
    out.x = SHORE.x + ux * v + rx * u;
    out.z = SHORE.y + uz * v + rz * u;
    return out;
  };

  const _pw = new THREE.Vector3();

  /**
   * A planked deck panel in pier space: `u` across, `v` along, both in metres,
   * centred on (uc, vc). Planks run across the pier with weathered gaps.
   */
  function plankDeck(uc, vc, width, length, y, plankAlongV) {
    const n = Math.max(3, Math.round((plankAlongV ? width : length) / 0.62));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const col = C(DECK[(i * 3 + (uc | 0) + (vc | 0)) % DECK.length]);
      col.multiplyScalar(0.90 + 0.20 * rng.next());
      const jitter = rng.range(-0.03, 0.03);
      if (plankAlongV) {
        const u = uc - width * 0.5 + width * t;
        put(bDeck, BOX, Wpier, u, y - DECK_Y, vc, width / n - 0.07, DECK_T, length + jitter,
          0, 0, 0, col);
      } else {
        const v = vc - length * 0.5 + length * t;
        put(bDeck, BOX, Wpier, uc, y - DECK_Y, v, width + jitter, DECK_T, length / n - 0.07,
          0, 0, 0, col);
      }
    }
    // stringers under the planks
    const beam = C(POST[1]);
    for (let s = -1; s <= 1; s += 2) {
      put(bDeck, BOX, Wpier, uc + s * (width * 0.5 - 0.35), y - DECK_Y - 0.34, vc,
        0.34, 0.42, length, 0, 0, 0, beam);
    }
    put(bDeck, BOX, Wpier, uc, y - DECK_Y - 0.34, vc, 0.34, 0.42, length, 0, 0, 0, beam);
  }

  // main run
  plankDeck(0, runLen * 0.5, MAIN_W, runLen, DECK_Y, false);
  // finger piers
  const F1V = runLen * 0.42, F2V = runLen * 0.74;
  plankDeck(-MAIN_W * 0.5 - 4.0, F1V, 8.0, 4.6, DECK_Y, true);
  plankDeck(MAIN_W * 0.5 + 3.4, F2V, 6.8, 4.2, DECK_Y, true);
  // shore apron
  plankDeck(0, -2.2, MAIN_W + 3.0, 4.6, DECK_Y, false);

  // lower landing stage off the seaward end
  const LAND_Y = DECK_Y - 1.55;
  plankDeck(-MAIN_W * 0.5 - 2.6, runLen - 3.0, 5.2, 5.0, LAND_Y, true);

  // steps from the main deck down onto the landing stage
  {
    const drop = DECK_Y - LAND_Y;
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      put(bDeck, BOX, Wpier, -MAIN_W * 0.5 - 0.35 - i * 0.62, -drop * t + 0.04, runLen - 3.0,
        0.66, 0.24, 2.2, 0, 0, 0, C(DECK[i % DECK.length]));
      put(bDeck, BOX, Wpier, -MAIN_W * 0.5 - 0.35 - i * 0.62, -drop * t - 0.16, runLen - 3.0,
        0.20, drop, 2.0, 0, 0, 0, C(POST[1]));
    }
    for (let s = -1; s <= 1; s += 2) {
      put(bDeck, BOX, Wpier, -MAIN_W * 0.5 - 1.9, -drop * 0.5 + 0.9, runLen - 3.0 + s * 1.15,
        3.6, 0.16, 0.16, 0, 0, Math.atan2(drop, 3.1), C(POST[2]));
    }
  }

  // --- pilings --------------------------------------------------------------

  const pilingSpots = [];
  const rows = Math.max(4, Math.round(runLen / 4.6));
  for (let i = 0; i <= rows; i++) {
    const v = (runLen * i) / rows;
    for (let s = -1; s <= 1; s += 2) {
      pilingSpots.push({ u: s * (MAIN_W * 0.5 - 0.45), v, top: DECK_Y, cap: true });
    }
    if (i % 2 === 0) pilingSpots.push({ u: 0, v, top: DECK_Y, cap: false });
  }
  // finger pier and landing stage supports
  for (const f of [
    { u: -MAIN_W * 0.5 - 7.4, v: F1V - 1.9 }, { u: -MAIN_W * 0.5 - 7.4, v: F1V + 1.9 },
    { u: -MAIN_W * 0.5 - 1.2, v: F1V - 1.9 }, { u: -MAIN_W * 0.5 - 1.2, v: F1V + 1.9 },
    { u: MAIN_W * 0.5 + 6.4, v: F2V - 1.7 }, { u: MAIN_W * 0.5 + 6.4, v: F2V + 1.7 },
    { u: MAIN_W * 0.5 + 1.0, v: F2V - 1.7 }, { u: MAIN_W * 0.5 + 1.0, v: F2V + 1.7 },
  ]) pilingSpots.push({ u: f.u, v: f.v, top: DECK_Y, cap: true });
  for (const f of [
    { u: -MAIN_W * 0.5 - 4.9, v: runLen - 5.3 }, { u: -MAIN_W * 0.5 - 4.9, v: runLen - 0.7 },
    { u: -MAIN_W * 0.5 - 0.3, v: runLen - 5.3 }, { u: -MAIN_W * 0.5 - 0.3, v: runLen - 0.7 },
  ]) pilingSpots.push({ u: f.u, v: f.v, top: LAND_Y, cap: true });

  const pilingInfo = [];
  for (let pi2 = 0; pi2 < pilingSpots.length; pi2++) {
    const sp = pilingSpots[pi2];
    toWorld(sp.u, sp.v, _pw);
    const g = groundAt(_pw.x, _pw.z);
    const bottom = Math.min(g - 0.7, sp.top - 1.2);
    const h = sp.top - bottom;
    const r = 0.42 + rng.range(-0.05, 0.07);
    const col = C(POST[(pi2 + 1) % POST.length]);
    col.multiplyScalar(0.88 + 0.24 * rng.next());
    put(bPost, CYL10, Wpier, sp.u, bottom + h * 0.5 - DECK_Y, sp.v, r * 2, h, r * 2,
      rng.range(-0.02, 0.02), 0, rng.range(-0.02, 0.02), col);
    // weed / barnacle band at the waterline
    put(bPost, CYL10, Wpier, sp.u, -DECK_Y + 0.15, sp.v, r * 2.24, 0.85, r * 2.24,
      0, 0, 0, C(0x4A5C42));
    if (sp.cap) {
      put(bPost, CYL10, Wpier, sp.u, sp.top - DECK_Y + 0.05, sp.v, r * 2.4, 0.24, r * 2.4,
        0, 0, 0, C(IRON));
    }
    pilingInfo.push({ u: sp.u, v: sp.v, bottom, top: sp.top, r });
  }

  // cross-bracing between the two main rows, below deck
  for (let i = 0; i < rows; i++) {
    const v0 = (runLen * i) / rows;
    const v1 = (runLen * (i + 1)) / rows;
    const u = MAIN_W * 0.5 - 0.45;
    const dv = v1 - v0;
    for (let s = -1; s <= 1; s += 2) {
      put(bPost, BOX, Wpier, s * u, -0.90, (v0 + v1) * 0.5,
        0.24, 0.24, dv + 0.2, 0, 0, 0, C(POST[2]));
    }
    // an X-brace every other bay, spanning the width
    if (i % 2 === 0) {
      const wdt = MAIN_W - 0.9;
      const dl = Math.hypot(wdt, dv);
      const th = Math.atan2(dv, wdt);
      put(bPost, BOX, Wpier, 0, -1.72, (v0 + v1) * 0.5, dl, 0.20, 0.20,
        0, -th, 0, C(POST[0]));
      put(bPost, BOX, Wpier, 0, -1.72, (v0 + v1) * 0.5, dl, 0.20, 0.20,
        0, th, 0, C(POST[0]));
    }
  }

  // --- furniture ------------------------------------------------------------

  const iron = C(IRON);
  const rubber = C(RUBBER);
  const rope = C(ROPE);

  // tyre fenders on the outer pilings
  for (let i = 0; i < pilingInfo.length; i += 3) {
    const pi = pilingInfo[i];
    if (Math.abs(pi.u) < MAIN_W * 0.4) continue;
    const side = Math.sign(pi.u);
    const y = 0.9 + rng.range(-0.25, 0.25);
    put(bPost, TORUS, Wpier, pi.u + side * (pi.r + 0.24), y - DECK_Y, pi.v,
      1.3, 1.3, 1.3, 0, Math.PI * 0.5, 0, rubber);
    put(bPost, BOX, Wpier, pi.u + side * (pi.r + 0.12), y + 0.85 - DECK_Y, pi.v,
      0.07, 1.7, 0.07, 0, 0, 0, rope);
  }

  // iron rings and cleats along the deck edge
  for (let i = 0; i < 8; i++) {
    const v = 2.5 + (runLen - 5) * (i / 7);
    const s = i % 2 === 0 ? 1 : -1;
    const u = s * (MAIN_W * 0.5 - 0.28);
    put(bDeck, RING, Wpier, u, 0.06, v, 0.55, 0.55, 0.55, Math.PI * 0.5, 0, 0, iron);
    if (i % 3 === 1) {
      put(bDeck, BOX, Wpier, u - s * 0.55, 0.20, v, 0.20, 0.26, 0.20, 0, 0, 0, iron);
      put(bDeck, BOX, Wpier, u - s * 0.55, 0.34, v, 0.22, 0.14, 0.92, 0, 0, 0, iron);
      // a coil of rope beside it
      for (let k = 0; k < 3; k++) {
        put(bDeck, TORUS, Wpier, u - s * 1.35, 0.11 + k * 0.10, v + 0.25,
          1.05 - k * 0.16, 1.05 - k * 0.16, 0.55, 0, 0, 0, rope);
      }
    }
  }

  // hand rail along the seaward half of the west edge
  {
    const u = -MAIN_W * 0.5 + 0.25;
    const v0 = runLen * 0.20, v1 = runLen * 0.98;
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const v = v0 + (v1 - v0) * (i / n);
      put(bDeck, BOX, Wpier, u, 0.62, v, 0.16, 1.10, 0.16, 0, 0, 0, C(POST[1]));
    }
    put(bDeck, BOX, Wpier, u, 1.10, (v0 + v1) * 0.5, 0.14, 0.16, v1 - v0, 0, 0, 0, C(POST[2]));
    put(bDeck, BOX, Wpier, u, 0.66, (v0 + v1) * 0.5, 0.11, 0.13, v1 - v0, 0, 0, 0, C(POST[2]));
  }

  // crab pots, fish crates and barrels
  function crabPot(u, v, y, rot) {
    const wood = C(0x7E6039);
    const net = C(0x3E4A3A);
    put(bDeck, CYL8, Wpier, u, y + 0.10 - DECK_Y, v, 1.30, 0.20, 1.30, 0, rot, 0, wood);
    put(bDeck, CYL8, Wpier, u, y + 0.42 - DECK_Y, v, 1.22, 0.60, 1.22, 0, rot, 0, net);
    put(bDeck, CYL8, Wpier, u, y + 0.74 - DECK_Y, v, 1.05, 0.16, 1.05, 0, rot, 0, wood);
    for (let k = 0; k < 4; k++) {
      const a = rot + k * Math.PI * 0.5 + 0.4;
      put(bDeck, BOX, Wpier, u + Math.sin(a) * 0.58, y + 0.44 - DECK_Y, v + Math.cos(a) * 0.58,
        0.09, 0.72, 0.09, 0, a, 0, wood);
    }
  }
  function crateStack(u, v, y, n, rot) {
    for (let k = 0; k < n; k++) {
      const sz = 0.86 - k * 0.06;
      put(bDeck, BOX, Wpier, u + rng.range(-0.1, 0.1), y + 0.30 + k * 0.62 - DECK_Y,
        v + rng.range(-0.1, 0.1), sz, 0.58, sz, 0, rot + rng.range(-0.3, 0.3), 0,
        C(CRATE[(k + n) % CRATE.length]));
      put(bDeck, BOX, Wpier, u, y + 0.30 + k * 0.62 - DECK_Y, v, sz + 0.06, 0.10, sz + 0.06,
        0, rot, 0, C(POST[0]));
    }
  }
  function barrel(u, v, y, rot) {
    put(bDeck, CYL12, Wpier, u, y + 0.46 - DECK_Y, v, 0.72, 0.92, 0.72, 0, rot, 0, C(0x7A5B39));
    put(bDeck, CYL12, Wpier, u, y + 0.22 - DECK_Y, v, 0.78, 0.12, 0.78, 0, rot, 0, iron);
    put(bDeck, CYL12, Wpier, u, y + 0.70 - DECK_Y, v, 0.78, 0.12, 0.78, 0, rot, 0, iron);
    put(bDeck, CYL12, Wpier, u, y + 0.93 - DECK_Y, v, 0.66, 0.08, 0.66, 0, rot, 0, C(0x8A6A44));
  }

  crabPot(MAIN_W * 0.5 - 1.1, 3.2, DECK_Y, 0.3);
  crabPot(MAIN_W * 0.5 - 1.1, 4.3, DECK_Y, 1.1);
  crabPot(MAIN_W * 0.5 - 2.0, 3.8, DECK_Y + 0.9, 0.7);
  crabPot(-MAIN_W * 0.5 + 1.2, runLen - 6.5, DECK_Y, 2.1);
  crateStack(MAIN_W * 0.5 - 1.3, 8.5, DECK_Y, 3, 0.2);
  crateStack(-MAIN_W * 0.5 + 1.4, 12.0, DECK_Y, 2, -0.5);
  crateStack(MAIN_W * 0.5 - 1.4, runLen - 9.0, DECK_Y, 2, 0.9);
  barrel(-MAIN_W * 0.5 + 1.3, 5.6, DECK_Y, 0.4);
  barrel(-MAIN_W * 0.5 + 1.3, 6.9, DECK_Y, 1.4);
  barrel(MAIN_W * 0.5 - 1.2, runLen - 3.4, DECK_Y, 0.1);

  // a draped net over the rail
  for (let i = 0; i < 5; i++) {
    put(bDeck, BOX, Wpier, -MAIN_W * 0.5 + 0.32, 0.55 - i * 0.16, runLen * 0.55 + i * 0.22,
      0.10, 0.9 - i * 0.1, 0.20, 0.35, 0, 0, C(0x4A5C42));
  }

  // --- lamp posts -----------------------------------------------------------

  const lampSpots = [
    { u: MAIN_W * 0.5 - 0.35, v: runLen * 0.16 },
    { u: -MAIN_W * 0.5 + 0.35, v: runLen * 0.52 },
    { u: MAIN_W * 0.5 - 0.35, v: runLen * 0.90 },
  ];
  const lights = [];
  for (let i = 0; i < lampSpots.length; i++) {
    const L = lampSpots[i];
    const dark = C(0x2C2A26);
    put(bDeck, CYL8, Wpier, L.u, 1.55, L.v, 0.24, 3.1, 0.24, 0, 0, 0, dark);
    put(bDeck, CYL8, Wpier, L.u, 0.14, L.v, 0.46, 0.28, 0.46, 0, 0, 0, iron);
    put(bDeck, BOX, Wpier, L.u, 3.10, L.v, 0.34, 0.16, 0.34, 0, 0, 0, dark);
    put(bDeck, BOX, Wpier, L.u, 3.86, L.v, 0.12, 0.62, 0.12, 0, 0, 0, dark);
    put(bDeck, CONE, Wpier, L.u, 3.66, L.v, 0.86, 0.46, 0.86, 0, 0, 0, dark);
    put(bDeck, CONE, Wpier, L.u, 2.98, L.v, 0.80, -0.30, 0.80, 0, 0, 0, dark);
    put(bGlow, BOX, Wpier, L.u, 3.30, L.v, 0.50, 0.60, 0.50, 0, Math.PI * 0.25, 0,
      C(0xFFE2AC), { aGlow: [1.25, 0.25 + i * 0.3] });
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI * 0.5 + Math.PI * 0.25;
      put(bDeck, BOX, Wpier, L.u + Math.sin(a) * 0.28, 3.30, L.v + Math.cos(a) * 0.28,
        0.06, 0.62, 0.06, 0, a, 0, dark);
    }

    if (i !== 1) {
      const wp = new THREE.Vector3(L.u, 0, L.v).applyMatrix4(Wpier);
      const l = new THREE.PointLight(0xffb755, 0, 24, 2);
      l.position.set(wp.x, DECK_Y + 3.3, wp.z);
      group.add(l);
      lights.push(l);
    }
  }

  // --- assemble -------------------------------------------------------------

  const uniforms = {
    time: uniform(0),
    color: uniform(new THREE.Color(1, 0.72, 0.36)),
    intensity: uniform(0),
  };

  const matDeck = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.90, metalness: 0.0, fog: true,
  });
  const matPost = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0, fog: true,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1C22);

  const geos = [];
  const deckMesh = new THREE.Mesh(bDeck.build(), matDeck);
  const postMesh = new THREE.Mesh(bPost.build(), matPost);
  const glowMesh = new THREE.Mesh(bGlow.build(), matGlow);
  geos.push(deckMesh.geometry, postMesh.geometry, glowMesh.geometry);
  for (const m of [deckMesh, postMesh, glowMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
  }
  deckMesh.name = 'dock.deck';
  postMesh.name = 'dock.pilings';
  glowMesh.name = 'dock.lamps';

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  addLayers(postMesh, LAYER.UNDERWATER);
  // addLayers only adds, so the pilings were in the reflection pass as well as
  // the refraction one, untrimmed in both.
  applyWaterClip(group);
  for (const l of lights) l.layers.enableAll();

  return {
    group,

    /** Where the dock actually is, for anything that wants to moor against it. */
    info: {
      shore: new THREE.Vector3(SHORE.x, DECK_Y, SHORE.y),
      head: new THREE.Vector3(HEAD.x, DECK_Y, HEAD.y),
      centre: new THREE.Vector3(centreX, DECK_Y, centreZ),
      deckY: DECK_Y,
      yaw,
      matrix: Wpier,
      inverse: WpierInv,
    },

    update(ctx) {
      uniforms.time.value = ctx.time;
    },

    applyEnv(env) {
      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.lanternIntensity * 1.15;
      const li = env.lanternIntensity * 11.0;
      for (const l of lights) {
        l.color.copy(env.windowLight);
        l.intensity = li;
        l.visible = li > 0.02;
      }
    },

    dispose() {
      for (const g of geos) g.dispose();
      for (const g of SOURCES) g.dispose();
      matDeck.dispose(); matPost.dispose(); matGlow.dispose();
    },
  };
}
