// Stilt Town — a boardwalk village on piles, out in the shallows.
//
// The previous attempt built a quay against the island and it failed four
// different ways, all of them the same way: the island is a 50-degree face and
// every walkable surface had to be reconciled with terrain that did not want
// it. Rectangles ended up buried in rock; deck heights disagreed with the
// ground under them; the walkable set was narrow strips with 0.4 m gaps in
// them; and the one piece I placed by GUESSING a dock constant instead of
// reading it put the player five metres off the end of a pier, standing on
// water.
//
// So this town does not touch the land at all. It stands on piles in 0.8-5.5 m
// of water at a site chosen by measurement — 100% of a 65x45 m footprint clear
// of land, mean depth 2.7 m, forty-odd metres off the harbour — and EVERY
// walkable surface is at exactly one height. That single decision removes the
// whole class of bug:
//
//   * no stairs, so no risers to be too tall
//   * no terrain query, so nothing to disagree with
//   * no height blending, so the walker cannot float or sink
//   * every deck rectangle OVERLAPS its neighbours by at least a metre, so
//     the walkable set is contiguous by construction rather than by luck
//
// The layout is a street. You moor at the jetty, walk up the boardwalk into
// the square with the shops around it, and at the far end there is a deck
// facing the island so the last thing you see is the hillside town across the
// water. Everything is generous — the narrowest thing you can walk on is 5 m
// wide — because the previous version's 2.3 m corridors were miserable.
//
// Local frame: +x is across the street, +z runs up it, away from the sea and
// toward the island. The origin is the middle of the square.

import * as THREE from 'three';
import { Fn, uniform, attribute, vertexColor, float, sin, step } from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// --- where it stands ---------------------------------------------------------

const SITE_X = -60, SITE_Z = 40;
// The street points at the harbour, so walking up it walks you toward the
// island and the old town on the hill fills the end of the view.
const TOWN_YAW = Math.atan2(-95 - SITE_X, 10 - SITE_Z);
const DECK_Y = 2.55;                    // one height, for everything

const CY = Math.cos(TOWN_YAW), SY = Math.sin(TOWN_YAW);

/** Town-local (x, z) -> world x. */
export const worldX = (x, z) => SITE_X + x * CY + z * SY;
/** Town-local (x, z) -> world z. */
export const worldZ = (x, z) => SITE_Z - x * SY + z * CY;
/** World -> town-local x. */
export const localX = (wx, wz) => (wx - SITE_X) * CY - (wz - SITE_Z) * SY;
/** World -> town-local z. */
export const localZ = (wx, wz) => (wx - SITE_X) * SY + (wz - SITE_Z) * CY;

export const YAW = TOWN_YAW;

// --- the walkable set --------------------------------------------------------
//
// Ordered seaward-first. Neighbours overlap deliberately: `jetty` runs to
// z = -24 and `street` starts at z = -26, so there is two metres of shared
// deck rather than a shared edge. An edge is a place a float can fall between.

const DECKS = [
  // Where you tie up. Wide enough to turn round on with the boat alongside.
  { id: 'jetty', x0: -4.0, x1: 4.0, z0: -34.0, z1: -24.0 },
  // The boardwalk.
  { id: 'street', x0: -5.0, x1: 5.0, z0: -26.0, z1: 22.0 },
  // The square, straddling the street.
  { id: 'square', x0: -12.0, x1: 12.0, z0: -9.0, z1: 8.0 },
  // Two side decks off the square, where the shops sit.
  { id: 'west', x0: -18.0, x1: -11.0, z0: -6.0, z1: 6.0 },
  { id: 'east', x0: 11.0, x1: 18.0, z0: -6.0, z1: 6.0 },
  // The deck at the head of the street, looking back at the island.
  { id: 'lookout', x0: -9.0, x1: 9.0, z0: 20.0, z1: 28.0 },
];

/** The one height anything walkable has. */
export const deckY = DECK_Y;

/**
 * The ground under a world point, or null. One height, so this is a
 * containment test and nothing else — no terrain, no interpolation, no
 * blending, and therefore nothing that can put the walker's feet anywhere
 * except on the deck.
 */
export function ground(wx, wz) {
  const x = localX(wx, wz), z = localZ(wx, wz);
  for (let i = 0; i < DECKS.length; i++) {
    const d = DECKS[i];
    if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return DECK_Y;
  }
  return null;
}

// Circles you cannot walk through, in town-local coordinates. Circles rather
// than boxes because the walker slides along the push-out normal, and a circle
// has no corner to catch on.
const SOLIDS = [];

export function unblock(wx, wz, radius, out) {
  let x = localX(wx, wz), z = localZ(wx, wz);
  for (let i = 0; i < SOLIDS.length; i++) {
    const s = SOLIDS[i];
    const dx = x - s.x, dz = z - s.z;
    const r = s.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r || d2 < 1e-9) continue;
    const d = Math.sqrt(d2);
    x = s.x + (dx / d) * r;
    z = s.z + (dz / d) * r;
  }
  out.x = worldX(x, z);
  out.z = worldZ(x, z);
  return out;
}

// --- mooring -----------------------------------------------------------------
//
// Alongside the jetty on the east side, bow toward open water. Read off the
// deck table rather than typed in, so it cannot drift from the jetty the way
// the last berth drifted five metres off a finger pier I had guessed the
// position of.

const JETTY = DECKS[0];
export const BERTH = { x: JETTY.x1 + 3.4, z: (JETTY.z0 + JETTY.z1) / 2, yaw: TOWN_YAW };
export const LANDING = { x: JETTY.x1 - 1.6, z: (JETTY.z0 + JETTY.z1) / 2 };

export function berthWorld(out) {
  return out.set(worldX(BERTH.x, BERTH.z), 0, worldZ(BERTH.x, BERTH.z));
}
export function landingWorld(out) {
  return out.set(worldX(LANDING.x, LANDING.z), DECK_Y, worldZ(LANDING.x, LANDING.z));
}

export const DOCK_RANGE = 18.0;

export function nearBerth(wx, wz) {
  const dx = localX(wx, wz) - BERTH.x;
  const dz = localZ(wx, wz) - BERTH.z;
  return dx * dx + dz * dz <= DOCK_RANGE * DOCK_RANGE;
}

// --- palette -----------------------------------------------------------------

const PLANK = [0xB08A57, 0xA07E4E, 0xBB9560, 0x97744A, 0xAD8853];
const PILE = [0x6B5238, 0x5C462F, 0x765B3E];
const WALLS = [0xF2E2C4, 0xE8D3B0, 0xF6EAD2, 0xDCC8A8, 0xEFDDBE, 0xE3D6BC];
const ACCENT = [0x3E7F8C, 0xC15A3E, 0x5B8C5A, 0xC79A3C, 0x8E5C86, 0x3F6E9E];
const ROOFS = [0xC2503C, 0xB4462E, 0x8E5A3A, 0xA8503E, 0x7E6A4C];
const TRIM = 0x4A3A2C;
const IRON = 0x36363A;
const GLASS_TINT = 0xFFDCA8;
const CRATE = [0x8A6A44, 0x9B7B50, 0x6F573A];
const BUNTING = [0xE05C4A, 0xF2C14E, 0x4E9BC4, 0xF2E9D8, 0x5FA98A];
const LEAF = [0x3E7A3A, 0x4E8C42, 0x356B34];

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
  const pos = [], nrm = [], col = [], ex = [];
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
      }
      for (let k = 0; k < ex.length; k++) {
        const e = ex[k];
        const src = extraVals && extraVals[e.name];
        for (let i = 0; i < count; i++) for (let j = 0; j < e.size; j++) e.data.push(src ? src[j] : e.def);
      }
    },
    get count() { return pos.length / 3; },
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
      for (const e of ex) g.setAttribute(e.name, new THREE.BufferAttribute(new Float32Array(e.data), e.size));
      g.computeBoundingSphere();
      return g;
    },
  };
}

function makeGlowMaterial(uniforms, baseHex) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: C(baseHex), roughness: 0.30, metalness: 0.0, vertexColors: true, fog: true,
  });
  const aGlow = attribute('aGlow', 'vec2');
  m.emissiveNode = Fn(() => {
    const gph = aGlow.y.toVar();
    const gfl = float(1.0).add(step(0.001, gph).mul(
      sin(uniforms.time.mul(gph.mul(2.7).add(2.1)).add(gph.mul(23.0))).mul(0.13)
        .add(sin(uniforms.time.mul(gph.mul(1.3).add(6.9)).add(gph.mul(41.0))).mul(0.06)),
    )).toVar();
    return uniforms.color.mul(uniforms.intensity.mul(aGlow.x).mul(gfl)).mul(vertexColor().rgb);
  })();
  return m;
}

export function createTown(opts = {}) {
  const terrain = opts.terrain || null;
  const rng = makeRng(((opts.seed | 0) ^ 0x70774E) >>> 0);

  const group = new THREE.Group();
  group.name = 'town';

  const uniforms = {
    time: uniform(0),
    color: uniform(new THREE.Color(1, 0.72, 0.36)),
    intensity: uniform(0),
  };

  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const CYL10 = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CONE = new THREE.ConeGeometry(0.5, 1, 4);
  const SOURCES = [BOX, CYL8, CYL10, CONE];

  const bDeck = makeBuilder();       // planks and piles
  const bWall = makeBuilder();       // buildings
  const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

  const W = new THREE.Matrix4();
  compose(W, SITE_X, 0, SITE_Z, 1, 1, 1, 0, TOWN_YAW, 0);

  const put = (B, geo, x, y, z, sx, sy, sz, rx, ry, rz, color, extra) => {
    compose(_mLocal, x, y, z, sx, sy, sz, rx, ry, rz);
    _mOut.multiplyMatrices(W, _mLocal);
    B.add(geo, _mOut, color, extra);
  };

  const pick = (a) => C(a[rng.int(0, a.length - 1)]);
  const seabedAt = (x, z) => {
    if (!terrain || !terrain.seabedHeight) return -3;
    const h = terrain.seabedHeight(worldX(x, z), worldZ(x, z));
    return Number.isFinite(h) ? h : -3;
  };

  // --- decking --------------------------------------------------------------
  //
  // Planks run ACROSS the street, the way a boardwalk's do, and they are laid
  // per deck rather than as one slab so the joins read.

  for (const d of DECKS) {
    const w = d.x1 - d.x0, l = d.z1 - d.z0;
    const cx = (d.x0 + d.x1) / 2, cz = (d.z0 + d.z1) / 2;
    // Bearers under the planks.
    put(bDeck, BOX, cx, DECK_Y - 0.26, cz, w, 0.22, l, 0, 0, 0, C(PILE[1]));
    const n = Math.max(4, Math.round(l / 0.62));
    for (let i = 0; i < n; i++) {
      const z = d.z0 + (i + 0.5) * (l / n);
      const c = pick(PLANK).multiplyScalar(0.94 + rng.range(0, 0.13));
      put(bDeck, BOX, cx, DECK_Y - 0.07, z, w, 0.14, l / n - 0.045, 0, 0, 0, c);
    }
  }

  // Piles, on a grid under the decks, carried down to the seabed.
  const piled = new Set();
  for (const d of DECKS) {
    for (let x = d.x0 + 1.2; x < d.x1; x += 3.6) {
      for (let z = d.z0 + 1.2; z < d.z1; z += 3.6) {
        const key = `${Math.round(x / 3.6)},${Math.round(z / 3.6)}`;
        if (piled.has(key)) continue;
        piled.add(key);
        const bed = seabedAt(x, z);
        const h = DECK_Y - bed + 0.4;
        put(bDeck, CYL8, x, bed + h * 0.5 - 0.2, z, 0.42, h, 0.42,
          rng.range(-0.02, 0.02), 0, rng.range(-0.02, 0.02), pick(PILE));
      }
    }
  }

  // --- railings -------------------------------------------------------------
  //
  // Along every outer edge, with a gap at the jetty where the boat comes in.
  // A boardwalk with no rail reads as a raft.

  function rail(x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const n = Math.max(2, Math.round(len / 2.2));
    const ang = Math.atan2(dx, dz);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      put(bDeck, BOX, x0 + dx * t, DECK_Y + 0.44, z0 + dz * t, 0.13, 0.88, 0.13, 0, ang, 0, C(TRIM));
    }
    put(bDeck, BOX, x0 + dx * 0.5, DECK_Y + 0.84, z0 + dz * 0.5, 0.10, 0.10, len, 0, ang, 0, C(TRIM));
    put(bDeck, BOX, x0 + dx * 0.5, DECK_Y + 0.50, z0 + dz * 0.5, 0.08, 0.08, len, 0, ang, 0, C(TRIM));
  }

  rail(-5.0, -26.0, -5.0, -9.0);   rail(5.0, -26.0, 5.0, -9.0);
  rail(-5.0, 8.0, -5.0, 22.0);     rail(5.0, 8.0, 5.0, 22.0);
  rail(-12.0, -9.0, 12.0, -9.0);   rail(-12.0, 8.0, -5.0, 8.0);
  rail(5.0, 8.0, 12.0, 8.0);
  rail(-18.0, -6.0, -18.0, 6.0);   rail(18.0, -6.0, 18.0, 6.0);
  rail(-9.0, 28.0, 9.0, 28.0);     rail(-9.0, 20.0, -9.0, 28.0);
  rail(9.0, 20.0, 9.0, 28.0);
  rail(-4.0, -34.0, -4.0, -24.0);  rail(-4.0, -34.0, 4.0, -34.0);

  // --- a shop ---------------------------------------------------------------
  //
  // One function, six calls. Stilt-town vernacular: a plank box with a shallow
  // pitched roof, a shuttered window either side of the door, an awning over
  // the front, and a hanging sign. `face` is the yaw that points its front at
  // the street.

  function shop(x, z, face, w, d, h, opt = {}) {
    const wall = pick(WALLS);
    const roofC = pick(ROOFS);
    const acc = pick(ACCENT);
    const s = Math.sin(face), c = Math.cos(face);
    const at = (ox, oz) => [x + ox * c + oz * s, z - ox * s + oz * c];

    // Floor pad and its own piles.
    put(bDeck, BOX, x, DECK_Y - 0.12, z, w + 0.6, 0.3, d + 0.6, 0, face, 0, C(PLANK[3]));
    for (const [ox, oz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      const [px, pz] = at(ox, oz);
      const bed = seabedAt(px, pz);
      put(bDeck, CYL8, px, bed + (DECK_Y - bed) * 0.5, pz, 0.38, DECK_Y - bed, 0.38, 0, 0, 0, pick(PILE));
    }

    // Body, with a plank course pattern.
    const rows = Math.max(3, Math.round(h / 0.5));
    for (let i = 0; i < rows; i++) {
      const y = DECK_Y + (i + 0.5) * (h / rows);
      const k = 0.95 + 0.08 * ((i % 3) / 2);
      put(bWall, BOX, x, y, z, w, h / rows + 0.01, d, 0, face, 0,
        new THREE.Color().copy(wall).multiplyScalar(k));
    }
    // Corner posts.
    for (const [ox, oz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      const [px, pz] = at(ox, oz);
      put(bWall, BOX, px, DECK_Y + h * 0.5, pz, 0.17, h, 0.17, 0, face, 0, C(TRIM));
    }

    // Roof: two slabs leaning on a ridge.
    const rise = 0.30 + w * 0.13;
    for (const sgn of [-1, 1]) {
      const [px, pz] = at(0, sgn * d * 0.25);
      put(bWall, BOX, px, DECK_Y + h + rise * 0.5, pz,
        w + 0.7, 0.16, d * 0.62, sgn * -0.42, face, 0, roofC);
    }
    put(bWall, BOX, x, DECK_Y + h + rise + 0.06, z, w + 0.8, 0.15, 0.30, 0, face, 0,
      new THREE.Color().copy(roofC).multiplyScalar(0.86));

    // Door and windows on the front face (-z in local terms).
    const fz = -d / 2 - 0.04;
    const [dx0, dz0] = at(0, fz);
    put(bWall, BOX, dx0, DECK_Y + 1.05, dz0, 0.92, 2.1, 0.10, 0, face, 0, acc);
    for (const ox of [-w * 0.30, w * 0.30]) {
      const [wx2, wz2] = at(ox, fz);
      put(bWall, BOX, wx2, DECK_Y + 1.55, wz2, 0.86, 0.86, 0.10, 0, face, 0, C(TRIM));
      put(bGlow, BOX, wx2, DECK_Y + 1.55, wz2, 0.70, 0.70, 0.06, 0, face, 0, C(GLASS_TINT),
        { aGlow: [1.15, rng.range(0.1, 1.0)] });
    }

    // Awning over the front, striped.
    if (opt.awning !== false) {
      const [ax, az] = at(0, fz - 0.85);
      put(bWall, BOX, ax, DECK_Y + 2.42, az, w + 0.4, 0.12, 1.8, -0.32, face, 0, acc);
      for (let i = 0; i < 4; i++) {
        const [sx2, sz2] = at(-w * 0.35 + i * (w * 0.23), fz - 0.85);
        put(bWall, BOX, sx2, DECK_Y + 2.44, sz2, w * 0.11, 0.13, 1.82, -0.32, face, 0,
          C(0xF6EEDC));
      }
    }

    // A hanging sign on a bracket.
    if (opt.sign !== false) {
      const [bx, bz] = at(w * 0.5 + 0.1, fz + 0.2);
      put(bWall, BOX, bx, DECK_Y + 2.75, bz, 1.0, 0.09, 0.09, 0, face, 0, C(IRON));
      const [gx, gz] = at(w * 0.5 + 0.55, fz + 0.2);
      put(bWall, BOX, gx, DECK_Y + 2.35, gz, 0.9, 0.62, 0.07, 0, face, 0, pick(ACCENT));
    }

    // Something on the deck outside: crates, a barrel, a pot of greenery.
    const [cx2, cz2] = at(-w * 0.5 - 0.9, fz - 0.6);
    if (rng.chance(0.6)) {
      put(bWall, BOX, cx2, DECK_Y + 0.42, cz2, 0.84, 0.84, 0.78, 0, face + rng.range(-0.3, 0.3), 0, pick(CRATE));
    } else {
      put(bWall, CYL10, cx2, DECK_Y + 0.34, cz2, 0.70, 0.68, 0.70, 0, 0, 0, C(0x8A6A44));
      put(bWall, CONE, cx2, DECK_Y + 1.05, cz2, 1.15, 1.1, 1.15, 0, rng.range(0, 3), 0, pick(LEAF));
    }

    SOLIDS.push({ x, z, r: Math.max(w, d) * 0.5 + 0.35 });
  }

  // Shops around the square, fronts facing in. `face` is chosen so the door
  // looks at the middle of the square from wherever the building stands.
  shop(-15.0, 0.0, Math.PI * 0.5, 7.0, 5.6, 3.4);          // west side
  shop(15.0, 0.0, -Math.PI * 0.5, 7.0, 5.6, 3.6);          // east side
  shop(-8.6, -13.6, 0, 6.4, 5.0, 3.3);                     // south-west corner
  shop(8.6, -13.6, 0, 6.4, 5.0, 3.5);                      // south-east
  shop(-8.6, 13.6, Math.PI, 6.6, 5.2, 3.9);                // north-west
  shop(8.6, 13.6, Math.PI, 6.6, 5.2, 3.4);                 // north-east

  // --- street furniture -----------------------------------------------------

  // Lamps down both sides of the street and around the square.
  const lamps = [];
  for (let z = -22; z <= 20; z += 7.5) lamps.push([-4.3, z], [4.3, z]);
  lamps.push([-11.2, -8.2], [11.2, -8.2], [-11.2, 7.2], [11.2, 7.2]);
  lamps.push([-3.4, -30.0], [3.4, -30.0], [-8.2, 26.5], [8.2, 26.5]);
  lamps.forEach(([x, z], i) => {
    put(bDeck, CYL8, x, DECK_Y + 0.14, z, 0.44, 0.28, 0.44, 0, 0, 0, C(IRON));
    put(bDeck, CYL8, x, DECK_Y + 1.55, z, 0.13, 2.8, 0.13, 0, 0, 0, C(IRON));
    put(bDeck, BOX, x, DECK_Y + 3.10, z, 0.40, 0.46, 0.40, 0, 0, 0, C(IRON));
    put(bDeck, CONE, x, DECK_Y + 3.46, z, 0.56, 0.30, 0.56, 0, Math.PI * 0.25, 0, C(IRON));
    put(bGlow, BOX, x, DECK_Y + 3.10, z, 0.28, 0.36, 0.28, 0, 0, 0, C(GLASS_TINT),
      { aGlow: [1.4, 0.2 + i * 0.13] });
  });

  // Bunting strung between the lamps down the street: little triangles on a
  // line. This is the single cheapest thing in the file and it does more for
  // the place than any of the geometry above it.
  for (let z = -22; z < 20; z += 7.5) {
    for (const side of [-1, 1]) {
      const x = side * 4.3;
      for (let k = 0; k < 9; k++) {
        const t = (k + 0.5) / 9;
        const zz = z + t * 7.5;
        const sag = Math.sin(t * Math.PI) * 0.55;
        put(bWall, CONE, x, DECK_Y + 3.05 - sag, zz, 0.30, 0.36, 0.06, Math.PI, 0, 0,
          C(BUNTING[k % BUNTING.length]));
      }
    }
  }

  // Benches on the lookout deck, facing the island.
  for (const x of [-4.5, 4.5]) {
    put(bWall, BOX, x, DECK_Y + 0.42, 25.4, 2.2, 0.14, 0.56, 0, 0, 0, C(PLANK[0]));
    put(bWall, BOX, x, DECK_Y + 0.72, 25.7, 2.2, 0.50, 0.12, -0.22, 0, 0, C(PLANK[0]));
    for (const ox of [-0.9, 0.9]) {
      put(bWall, BOX, x + ox, DECK_Y + 0.20, 25.4, 0.14, 0.42, 0.5, 0, 0, 0, C(TRIM));
    }
    SOLIDS.push({ x, z: 25.5, r: 1.3 });
  }

  // A fish stall in the middle of the square: a counter under a striped roof.
  put(bWall, BOX, 0, DECK_Y + 0.52, 0, 3.6, 1.0, 1.5, 0, 0, 0, C(PLANK[2]));
  put(bWall, BOX, 0, DECK_Y + 1.06, 0, 3.8, 0.12, 1.7, 0, 0, 0, C(0xF6EEDC));
  for (const ox of [-1.7, 1.7]) {
    for (const oz of [-0.65, 0.65]) {
      put(bWall, BOX, ox, DECK_Y + 1.4, oz, 0.10, 1.8, 0.10, 0, 0, 0, C(TRIM));
    }
  }
  for (let i = 0; i < 5; i++) {
    put(bWall, BOX, -1.6 + i * 0.8, DECK_Y + 2.34, 0, 0.78, 0.12, 2.2, 0, 0, 0,
      C(i % 2 ? 0xC15A3E : 0xF6EEDC));
  }
  SOLIDS.push({ x: 0, z: 0, r: 2.3 });

  // Crates and barrels tucked against the rails, never in the middle.
  const clutter = [[-4.2, -18], [4.2, -14], [-11.2, 3.4], [11.2, -3.4],
    [-4.2, 12], [4.2, 18], [-3.2, -28], [3.2, -26]];
  for (const [x, z] of clutter) {
    if (rng.chance(0.5)) {
      put(bWall, BOX, x, DECK_Y + 0.42, z, 0.86, 0.84, 0.8, 0, rng.range(-0.4, 0.4), 0, pick(CRATE));
    } else {
      const h = rng.range(0.8, 1.0);
      put(bWall, CYL10, x, DECK_Y + h * 0.5, z, 0.70, h, 0.70, 0, 0, 0, C(0x6E4E30));
      put(bWall, CYL10, x, DECK_Y + h * 0.78, z, 0.76, 0.08, 0.76, 0, 0, 0, C(IRON));
    }
    SOLIDS.push({ x, z, r: 0.75 });
  }

  // Mooring bollards along the jetty.
  for (let z = JETTY.z0 + 1.6; z < JETTY.z1; z += 3.0) {
    put(bDeck, CYL10, JETTY.x1 - 0.55, DECK_Y + 0.3, z, 0.34, 0.62, 0.34, 0, 0, 0, C(IRON));
  }

  // --- build ----------------------------------------------------------------

  const matDeck = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0, fog: true,
  });
  const matWall = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.80, metalness: 0.0, fog: true, side: THREE.DoubleSide,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1C22);

  const geos = [];
  for (const [b, mat, name] of [[bDeck, matDeck, 'town-deck'],
    [bWall, matWall, 'town-walls'], [bGlow, matGlow, 'town-glow']]) {
    if (!b.count) continue;
    const g = b.build();
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = name !== 'town-glow';
    m.receiveShadow = name !== 'town-glow';
    group.add(m);
  }

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  applyWaterClip(group);

  return {
    group,
    ground,
    unblock,
    berthWorld,
    landingWorld,
    nearBerth,
    BERTH,
    LANDING,
    deckY: DECK_Y,
    worldX,
    worldZ,
    localX,
    localZ,
    yaw: TOWN_YAW,
    decks: DECKS,

    update(ctx) { uniforms.time.value = ctx.time; },

    applyEnv(env) {
      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.lanternIntensity * 1.35;
    },

    dispose() {
      for (const g of geos) g.dispose();
      for (const g of SOURCES) g.dispose();
      matDeck.dispose(); matWall.dispose(); matGlow.dispose();
    },
  };
}
