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
// water.
//
// Since the editor, everything that STANDS ON the decks — buildings, the
// stall, benches, lamps, clutter — is data rather than code: a layout of
// { kind, x, z, yaw } items in town-local coordinates, built into the same
// three merged meshes as before. The town can rebuild itself from a new
// layout at runtime by swapping geometry on those persistent meshes; the
// materials are created exactly once and never touched again, so a rebuild
// re-keys no WebGPU pipeline and compiles nothing. The decks, piles,
// railings and jetty stay fixed — they are the walkable guarantee, and the
// editor has no business breaking it.
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
// has no corner to catch on. Rebuilt from scratch on every layout build — a
// module-level array that only ever grew once doubled every solid on the
// first rebuild.
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

// --- the layout --------------------------------------------------------------
//
// Everything the editor can touch. An item is { k, x, z } plus, by kind:
// yaw (radians), the shop's w/d/h, and a seed that pins the item's palette
// and small asymmetries so a building keeps its face when it is moved.

export const TOWN_LAYOUT_KEY = 'saltyfin-town-layout-v1';

const KIND = {
  shop: { label: 'Shop', yaw: true, fp: (it) => Math.max(it.w, it.d) * 0.5 + 0.35 },
  tavern: { label: 'Tavern', yaw: true, fp: () => 5.2 },
  stall: { label: 'Stall', yaw: true, fp: () => 2.3 },
  bench: { label: 'Bench', yaw: true, fp: () => 1.3 },
  lamp: { label: 'Lamp', yaw: false, fp: () => 0.55 },
  crate: { label: 'Crate', yaw: true, fp: () => 0.75 },
  barrel: { label: 'Barrel', yaw: false, fp: () => 0.75 },
  planter: { label: 'Planter', yaw: false, fp: () => 0.75 },
};

/** Kinds the editor's add-palette offers. One tavern exists; it moves, it is
 *  not minted. */
export const KIND_LIST = Object.keys(KIND)
  .filter((k) => k !== 'tavern')
  .map((k) => ({ k, label: KIND[k].label, yaw: KIND[k].yaw }));

/** Selection / collision radius for an item, metres. */
export function footprint(it) {
  const m = KIND[it.k];
  return m ? m.fp(it) : 0.8;
}

// The shipped town, expressed in its own data format. Positions are the ones
// the hand-placed version used; seeds are arbitrary but FIXED, so the default
// town always greets you with the same faces.
const DEFAULT_ITEMS = [
  { k: 'shop', x: -15.0, z: 0.0, yaw: Math.PI * 0.5, w: 7.0, d: 5.6, h: 3.4, seed: 11 },
  { k: 'shop', x: 15.0, z: 0.0, yaw: -Math.PI * 0.5, w: 7.0, d: 5.6, h: 3.6, seed: 12 },
  { k: 'shop', x: -8.6, z: -13.6, yaw: 0, w: 6.4, d: 5.0, h: 3.3, seed: 13 },
  { k: 'shop', x: 8.6, z: -13.6, yaw: 0, w: 6.4, d: 5.0, h: 3.5, seed: 14 },
  { k: 'shop', x: 8.6, z: 13.6, yaw: Math.PI, w: 6.6, d: 5.2, h: 3.4, seed: 16 },
  { k: 'tavern', x: -9.6, z: 14.2, yaw: Math.PI, seed: 7 },
  { k: 'stall', x: 0, z: 0, yaw: 0, seed: 21 },
  { k: 'bench', x: -4.5, z: 25.5, yaw: 0, seed: 31 },
  { k: 'bench', x: 4.5, z: 25.5, yaw: 0, seed: 32 },
  // Lamps down both sides of the street (bunting hangs between these), then
  // around the square, the jetty and the lookout.
  ...[-22, -14.5, -7, 0.5, 8, 15.5].flatMap((z, i) => [
    { k: 'lamp', x: -4.3, z, seed: 41 + i * 2 },
    { k: 'lamp', x: 4.3, z, seed: 42 + i * 2 },
  ]),
  { k: 'lamp', x: -11.2, z: -8.2, seed: 61 },
  { k: 'lamp', x: 11.2, z: -8.2, seed: 62 },
  { k: 'lamp', x: -11.2, z: 7.2, seed: 63 },
  { k: 'lamp', x: 11.2, z: 7.2, seed: 64 },
  { k: 'lamp', x: -3.4, z: -30.0, seed: 65 },
  { k: 'lamp', x: 3.4, z: -30.0, seed: 66 },
  { k: 'lamp', x: -8.2, z: 26.5, seed: 67 },
  { k: 'lamp', x: 8.2, z: 26.5, seed: 68 },
  // Crates and barrels tucked against the rails, never in the middle.
  { k: 'crate', x: -4.2, z: -18, yaw: 0.2, seed: 71 },
  { k: 'barrel', x: 4.2, z: -14, seed: 72 },
  { k: 'crate', x: -11.2, z: 3.4, yaw: -0.3, seed: 73 },
  { k: 'barrel', x: 11.2, z: -3.4, seed: 74 },
  { k: 'crate', x: -4.2, z: 12, yaw: 0.35, seed: 75 },
  { k: 'barrel', x: 4.2, z: 18, seed: 76 },
  { k: 'crate', x: -3.2, z: -28, yaw: -0.15, seed: 77 },
  { k: 'crate', x: 3.2, z: -26, yaw: 0.4, seed: 78 },
];

const copyLayout = (l) => JSON.parse(JSON.stringify(l));

/** The layout the game ships with. */
export function defaultLayout() {
  return copyLayout({ v: 1, items: DEFAULT_ITEMS });
}

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, numOr(v, d)));

/**
 * Turn untrusted layout data (localStorage, the editor's import box) into a
 * layout the builder can trust, or null if it is not a layout at all. Unknown
 * kinds and broken items are dropped rather than fatal; numbers are clamped
 * into the town's plausible envelope; at most one tavern survives.
 */
export function sanitizeLayout(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.items)) return null;
  const items = [];
  let tavernSeen = false;
  for (const it of raw.items) {
    // hasOwnProperty, not a truthy lookup: KIND is a plain object literal, so
    // KIND['constructor'] is truthy and an item of kind "constructor" would
    // sail through, persist, and then blow up footprint() on every tap.
    if (!it || typeof it !== 'object' || typeof it.k !== 'string'
      || !Object.prototype.hasOwnProperty.call(KIND, it.k)) continue;
    if (it.k === 'tavern') {
      if (tavernSeen) continue;
      tavernSeen = true;
    }
    const o = {
      k: it.k,
      x: clampNum(it.x, -24, 24, 0),
      z: clampNum(it.z, -40, 40, 0),
      seed: (numOr(it.seed, 1) >>> 0) || 1,
    };
    if (KIND[it.k].yaw) {
      let y = numOr(it.yaw, 0) % (Math.PI * 2);
      if (y > Math.PI) y -= Math.PI * 2;
      if (y < -Math.PI) y += Math.PI * 2;
      o.yaw = y;
    }
    if (it.k === 'shop') {
      o.w = clampNum(it.w, 4, 10, 6.4);
      o.d = clampNum(it.d, 3.5, 8, 5.0);
      o.h = clampNum(it.h, 2.6, 5.5, 3.4);
    }
    items.push(o);
    if (items.length >= 140) break;
  }
  return { v: 1, items };
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
      if (pos.length) {
        g.computeBoundingSphere();
      } else {
        // An empty geometry (a layout with no lamps, say) must still carry a
        // valid sphere or the frustum test reads NaN and the mesh flickers.
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
      }
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
  // The hero tavern, a generated GLB passed in ready-parsed. When present, the
  // layout's tavern item mounts it; when absent (asset failed, dev server
  // without assets) the tavern item builds as a big procedural shop instead.
  const heroTavern = opts.tavern || null;
  const SEED = ((opts.seed | 0) ^ 0x70774E) >>> 0;

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

  // Created ONCE and reused across every rebuild. A rebuild swaps geometry on
  // these; touching the materials would re-key their pipelines and stall.
  const matDeck = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0, fog: true,
  });
  const matWall = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.80, metalness: 0.0, fog: true, side: THREE.DoubleSide,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1C22);

  const meshDeck = new THREE.Mesh(undefined, matDeck);
  const meshWall = new THREE.Mesh(undefined, matWall);
  const meshGlow = new THREE.Mesh(undefined, matGlow);
  meshDeck.name = 'town-deck';
  meshWall.name = 'town-walls';
  meshGlow.name = 'town-glow';
  for (const m of [meshDeck, meshWall]) { m.castShadow = true; m.receiveShadow = true; }
  group.add(meshDeck, meshWall, meshGlow);

  // The tavern's scale is measured once, from the raw GLB, and memoised: a
  // rebuild re-measuring an already-scaled object would compound the factor.
  let tavernScale = 0;
  // True while the tavern is mounted ONLY so the boot warm-up can compile its
  // pipelines — see the ghost mount after the first build below.
  let ghostTavern = false;

  // Scale, rotate and set the hero tavern down at an item's spot. SOLIDS is
  // the caller's business — the warm-up ghost must not block walking.
  function mountTavern(item) {
    if (heroTavern.parent !== group) group.add(heroTavern);
    const box = new THREE.Box3();
    if (!tavernScale) {
      // Measure the raw model exactly once. Re-measuring after a scale has
      // been applied would compound it on every rebuild.
      heroTavern.rotation.y = 0;
      heroTavern.scale.setScalar(1);
      heroTavern.updateMatrixWorld(true);
      box.setFromObject(heroTavern);
      const size = box.getSize(new THREE.Vector3());
      tavernScale = 10.5 / Math.max(size.x, size.z, 1e-3);
    }
    heroTavern.scale.setScalar(tavernScale);
    // Rotate FIRST, then measure, then place: the bbox of the rotated object
    // is what has to land on the pad, and rotating about a GLB's arbitrary
    // origin moves it.
    heroTavern.rotation.y = TOWN_YAW + (item.yaw ?? Math.PI);
    // Two passes: measure-and-move, then re-measure-and-correct.
    // Box3.setFromObject on a GLB with its own baked node transforms is only
    // exact once every matrix has been updated in place, and chasing WHY is
    // worth less than one more cheap correction.
    for (let pass = 0; pass < 2; pass++) {
      heroTavern.updateMatrixWorld(true);
      box.setFromObject(heroTavern);
      const c = box.getCenter(new THREE.Vector3());
      heroTavern.position.x += worldX(item.x, item.z) - c.x;
      heroTavern.position.z += worldZ(item.x, item.z) - c.z;
      heroTavern.position.y += DECK_Y - box.min.y;
    }
    heroTavern.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  const pickWith = (r, a) => C(a[r.int(0, a.length - 1)]);
  const seabedAt = (x, z) => {
    if (!terrain || !terrain.seabedHeight) return -3;
    const h = terrain.seabedHeight(worldX(x, z), worldZ(x, z));
    return Number.isFinite(h) ? h : -3;
  };

  const W = new THREE.Matrix4();
  compose(W, SITE_X, 0, SITE_Z, 1, 1, 1, 0, TOWN_YAW, 0);

  // The current, applied layout. Never handed out by reference. An empty
  // items list is legitimate — someone deleted their whole town, and the
  // decks still stand — but a layout that fails to parse falls back whole.
  let current = sanitizeLayout(opts.layout) || defaultLayout();

  // --- one whole build from a layout ----------------------------------------

  function buildAll(items) {
    SOLIDS.length = 0;
    const rng = makeRng(SEED);            // the FIXED part's stream: same seed,
    const bDeck = makeBuilder();          // same planks, every rebuild
    const bWall = makeBuilder();
    const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

    const put = (B, geo, x, y, z, sx, sy, sz, rx, ry, rz, color, extra) => {
      compose(_mLocal, x, y, z, sx, sy, sz, rx, ry, rz);
      _mOut.multiplyMatrices(W, _mLocal);
      B.add(geo, _mOut, color, extra);
    };
    const pick = (a) => pickWith(rng, a);

    // --- decking (fixed) ----------------------------------------------------
    //
    // Planks run ACROSS the street, the way a boardwalk's do, and they are
    // laid per deck rather than as one slab so the joins read.

    for (const d of DECKS) {
      const w = d.x1 - d.x0, l = d.z1 - d.z0;
      const cx = (d.x0 + d.x1) / 2, cz = (d.z0 + d.z1) / 2;
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

    // --- railings (fixed) ---------------------------------------------------
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

    // Mooring bollards along the jetty (fixed).
    for (let z = JETTY.z0 + 1.6; z < JETTY.z1; z += 3.0) {
      put(bDeck, CYL10, JETTY.x1 - 0.55, DECK_Y + 0.3, z, 0.34, 0.62, 0.34, 0, 0, 0, C(IRON));
    }

    // --- the items ----------------------------------------------------------
    //
    // Each gets its own rng from its own seed, so moving one building cannot
    // re-roll the palette of every building placed after it.

    // Stilt-town vernacular shop: a plank box with a shallow pitched roof, a
    // shuttered window either side of the door, an awning over the front and a
    // hanging sign. `face` is the yaw that points its front at the street.
    function shop(x, z, face, w, d, h, r) {
      const wall = pickWith(r, WALLS);
      const roofC = pickWith(r, ROOFS);
      const acc = pickWith(r, ACCENT);
      const s = Math.sin(face), c = Math.cos(face);
      const at = (ox, oz) => [x + ox * c + oz * s, z - ox * s + oz * c];

      // Floor pad and its own piles.
      put(bDeck, BOX, x, DECK_Y - 0.12, z, w + 0.6, 0.3, d + 0.6, 0, face, 0, C(PLANK[3]));
      for (const [ox, oz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
        const [px, pz] = at(ox, oz);
        const bed = seabedAt(px, pz);
        put(bDeck, CYL8, px, bed + (DECK_Y - bed) * 0.5, pz, 0.38, DECK_Y - bed, 0.38, 0, 0, 0, pickWith(r, PILE));
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
          { aGlow: [1.15, r.range(0.1, 1.0)] });
      }

      // Awning over the front, striped.
      const [ax, az] = at(0, fz - 0.85);
      put(bWall, BOX, ax, DECK_Y + 2.42, az, w + 0.4, 0.12, 1.8, -0.32, face, 0, acc);
      for (let i = 0; i < 4; i++) {
        const [sx2, sz2] = at(-w * 0.35 + i * (w * 0.23), fz - 0.85);
        put(bWall, BOX, sx2, DECK_Y + 2.44, sz2, w * 0.11, 0.13, 1.82, -0.32, face, 0,
          C(0xF6EEDC));
      }

      // A hanging sign on a bracket.
      const [bx, bz] = at(w * 0.5 + 0.1, fz + 0.2);
      put(bWall, BOX, bx, DECK_Y + 2.75, bz, 1.0, 0.09, 0.09, 0, face, 0, C(IRON));
      const [gx, gz] = at(w * 0.5 + 0.55, fz + 0.2);
      put(bWall, BOX, gx, DECK_Y + 2.35, gz, 0.9, 0.62, 0.07, 0, face, 0, pickWith(r, ACCENT));

      // Something on the deck outside: crates, or a pot of greenery.
      const [cx2, cz2] = at(-w * 0.5 - 0.9, fz - 0.6);
      if (r.chance(0.6)) {
        put(bWall, BOX, cx2, DECK_Y + 0.42, cz2, 0.84, 0.84, 0.78, 0, face + r.range(-0.3, 0.3), 0, pickWith(r, CRATE));
      } else {
        put(bWall, CYL10, cx2, DECK_Y + 0.34, cz2, 0.70, 0.68, 0.70, 0, 0, 0, C(0x8A6A44));
        put(bWall, CONE, cx2, DECK_Y + 1.05, cz2, 1.15, 1.1, 1.15, 0, r.range(0, 3), 0, pickWith(r, LEAF));
      }

      SOLIDS.push({ x, z, r: Math.max(w, d) * 0.5 + 0.35 });
    }

    function stall(x, z, face, r) {
      const s = Math.sin(face), c = Math.cos(face);
      const at = (ox, oz) => [x + ox * c + oz * s, z - ox * s + oz * c];
      put(bWall, BOX, x, DECK_Y + 0.52, z, 3.6, 1.0, 1.5, 0, face, 0, C(PLANK[2]));
      put(bWall, BOX, x, DECK_Y + 1.06, z, 3.8, 0.12, 1.7, 0, face, 0, C(0xF6EEDC));
      for (const ox of [-1.7, 1.7]) {
        for (const oz of [-0.65, 0.65]) {
          const [px, pz] = at(ox, oz);
          put(bWall, BOX, px, DECK_Y + 1.4, pz, 0.10, 1.8, 0.10, 0, face, 0, C(TRIM));
        }
      }
      for (let i = 0; i < 5; i++) {
        const [px, pz] = at(-1.6 + i * 0.8, 0);
        put(bWall, BOX, px, DECK_Y + 2.34, pz, 0.78, 0.12, 2.2, 0, face, 0,
          C(i % 2 ? 0xC15A3E : 0xF6EEDC));
      }
      SOLIDS.push({ x, z, r: 2.3 });
    }

    function bench(x, z, face, r) {
      const s = Math.sin(face), c = Math.cos(face);
      const at = (ox, oz) => [x + ox * c + oz * s, z - ox * s + oz * c];
      const [sx, sz] = at(0, -0.1);
      put(bWall, BOX, sx, DECK_Y + 0.42, sz, 2.2, 0.14, 0.56, 0, face, 0, C(PLANK[0]));
      const [kx, kz] = at(0, 0.2);
      put(bWall, BOX, kx, DECK_Y + 0.72, kz, 2.2, 0.50, 0.12, -0.22, face, 0, C(PLANK[0]));
      for (const ox of [-0.9, 0.9]) {
        const [px, pz] = at(ox, -0.1);
        put(bWall, BOX, px, DECK_Y + 0.20, pz, 0.14, 0.42, 0.5, 0, face, 0, C(TRIM));
      }
      SOLIDS.push({ x, z, r: 1.3 });
    }

    function lamp(x, z, phase) {
      put(bDeck, CYL8, x, DECK_Y + 0.14, z, 0.44, 0.28, 0.44, 0, 0, 0, C(IRON));
      put(bDeck, CYL8, x, DECK_Y + 1.55, z, 0.13, 2.8, 0.13, 0, 0, 0, C(IRON));
      put(bDeck, BOX, x, DECK_Y + 3.10, z, 0.40, 0.46, 0.40, 0, 0, 0, C(IRON));
      put(bDeck, CONE, x, DECK_Y + 3.46, z, 0.56, 0.30, 0.56, 0, Math.PI * 0.25, 0, C(IRON));
      put(bGlow, BOX, x, DECK_Y + 3.10, z, 0.28, 0.36, 0.28, 0, 0, 0, C(GLASS_TINT),
        { aGlow: [1.4, 0.2 + phase * 0.13] });
      SOLIDS.push({ x, z, r: 0.32 });
    }

    function crate(x, z, face, r) {
      put(bWall, BOX, x, DECK_Y + 0.42, z, 0.86, 0.84, 0.8, 0, face + r.range(-0.08, 0.08), 0, pickWith(r, CRATE));
      SOLIDS.push({ x, z, r: 0.75 });
    }

    function barrel(x, z, r) {
      const h = r.range(0.8, 1.0);
      put(bWall, CYL10, x, DECK_Y + h * 0.5, z, 0.70, h, 0.70, 0, 0, 0, C(0x6E4E30));
      put(bWall, CYL10, x, DECK_Y + h * 0.78, z, 0.76, 0.08, 0.76, 0, 0, 0, C(IRON));
      SOLIDS.push({ x, z, r: 0.75 });
    }

    function planter(x, z, r) {
      put(bWall, CYL10, x, DECK_Y + 0.34, z, 0.70, 0.68, 0.70, 0, 0, 0, C(0x8A6A44));
      put(bWall, CONE, x, DECK_Y + 1.05, z, 1.15, 1.1, 1.15, 0, r.range(0, 3), 0, pickWith(r, LEAF));
      SOLIDS.push({ x, z, r: 0.75 });
    }

    let lampIndex = 0;
    let tavernItem = null;
    for (const it of items) {
      const r = makeRng(((it.seed >>> 0) ^ 0x5F17) >>> 0 || 1);
      switch (it.k) {
        case 'shop': shop(it.x, it.z, it.yaw || 0, it.w, it.d, it.h, r); break;
        case 'tavern':
          tavernItem = it;
          if (!heroTavern) shop(it.x, it.z, it.yaw || 0, 6.6, 5.2, 3.9, r);
          break;
        case 'stall': stall(it.x, it.z, it.yaw || 0, r); break;
        case 'bench': bench(it.x, it.z, it.yaw || 0, r); break;
        case 'lamp': lamp(it.x, it.z, lampIndex++); break;
        case 'crate': crate(it.x, it.z, it.yaw || 0, r); break;
        case 'barrel': barrel(it.x, it.z, r); break;
        case 'planter': planter(it.x, it.z, r); break;
      }
    }

    // --- the hero tavern ----------------------------------------------------
    // Scaled from its own bounding box rather than trusted: generated models
    // arrive at whatever size the generator dreamt. The SOLIDS circle goes in
    // with everything else's, so the boards darken under it below — that
    // shared contact shadow is most of why a generated asset reads as part of
    // the town instead of pasted on.
    if (heroTavern && tavernItem) {
      mountTavern(tavernItem);
      ghostTavern = false;
      SOLIDS.push({ x: tavernItem.x, z: tavernItem.z, r: 5.2 });
    } else if (heroTavern && heroTavern.parent === group && !ghostTavern) {
      // The layout has no tavern; the object leaves the scene. Within one
      // session its materials keep their compiled pipelines, and across a
      // reload the warm-up ghost below keeps them compiled too, so putting it
      // back later costs a rebuild and nothing else.
      group.remove(heroTavern);
    }

    // --- bunting ------------------------------------------------------------
    //
    // Strung between neighbouring street lamps, wherever the layout put them:
    // a sagging run of thin segments between the lamp heads, pennants tucked
    // under it. Derived, not placed — move a lamp and its bunting comes along;
    // delete one and the line goes with it. This is the single cheapest thing
    // in the file and it does more for the place than any of the geometry
    // above it.
    const lampsBySide = [[], []];
    for (const it of items) {
      if (it.k !== 'lamp' || it.z <= -25 || it.z >= 22) continue;
      if (Math.abs(it.x + 4.3) < 1.3) lampsBySide[0].push(it);
      else if (Math.abs(it.x - 4.3) < 1.3) lampsBySide[1].push(it);
    }
    for (const line of lampsBySide) {
      line.sort((a, b) => a.z - b.z);
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1];
        const runX = b.x - a.x, runZ = b.z - a.z;
        const len = Math.hypot(runX, runZ);
        if (len < 4 || len > 11) continue;
        const yawR = Math.atan2(runX, runZ);
        const N = 12;
        for (let k = 0; k < N; k++) {
          const t = (k + 0.5) / N;
          const px = a.x + runX * t, pz = a.z + runZ * t;
          const sag = Math.sin(t * Math.PI) * 0.5;
          const drop = Math.sin((t + 0.5 / N) * Math.PI) - Math.sin((t - 0.5 / N) * Math.PI);
          put(bWall, BOX, px, DECK_Y + 3.06 - sag, pz, 0.035, 0.035, len / N + 0.02,
            -Math.atan2(drop * 0.5, len / N), yawR, 0, C(0xE8E0CE));
          if (k % 2 === 0) {
            put(bWall, CONE, px, DECK_Y + 2.92 - sag, pz, 0.15, 0.22, 0.04, Math.PI, yawR, 0,
              C(BUNTING[(k >> 1) % BUNTING.length]));
          }
        }
      }
    }

    // --- baked contact shadow -----------------------------------------------
    //
    // The concept-art look is mostly THIS: things sitting IN their world
    // instead of on it. Real AO is a bake nobody here can afford, but the town
    // already knows exactly where everything heavy stands — SOLIDS, the same
    // circles the walk controller slides you around — so the deck darkens
    // toward each one, and every wall darkens in its bottom half-metre where
    // it meets the boards. Vertex colours, written once per build.
    const smoothstep01 = (t) => { const k = Math.max(0, Math.min(1, t)); return k * k * (3 - 2 * k); };
    function bakeContact(geo, kind) {
      const pos = geo.attributes.position;
      const col = geo.attributes.color;
      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i), wy = pos.getY(i), wz = pos.getZ(i);
        let k = 1;
        if (kind === 'deck') {
          const lx = localX(wx, wz), lz = localZ(wx, wz);
          for (let j = 0; j < SOLIDS.length; j++) {
            const so = SOLIDS[j];
            const reach = so.r + 1.1;
            const d = Math.hypot(lx - so.x, lz - so.z);
            if (d < reach) k = Math.min(k, 0.52 + 0.48 * smoothstep01(d / reach));
          }
        } else {
          // The grounding skirt: the bottom of every wall, post, crate and
          // barrel eases toward shadow where it meets the deck.
          const h = wy - DECK_Y;
          if (h < 0.6 && h > -0.4) k = Math.min(k, 0.70 + 0.30 * smoothstep01(h / 0.6));
        }
        if (k < 1) col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
      }
    }

    const geoDeck = bDeck.build();
    const geoWall = bWall.build();
    const geoGlow = bGlow.build();
    bakeContact(geoDeck, 'deck');
    bakeContact(geoWall, 'walls');
    return { geoDeck, geoWall, geoGlow };
  }

  function applyGeos(g) {
    meshDeck.geometry?.dispose?.();
    meshWall.geometry?.dispose?.();
    meshGlow.geometry?.dispose?.();
    meshDeck.geometry = g.geoDeck;
    meshWall.geometry = g.geoWall;
    meshGlow.geometry = g.geoGlow;
  }

  applyGeos(buildAll(current.items));

  // The warm-up ghost: if the saved layout has no tavern (the player deleted
  // it in the editor), the GLB would never be in the scene during the boot
  // warm-up, none of its pipelines would compile, and the first Reset or
  // Apply that brings it back would stall the frame for however long its
  // shaders take. So it is mounted regardless for warm-up — at the default
  // spot, with no SOLIDS circle — and main dismisses it (warmupDone) the
  // moment the warm-up has rendered its 24 hours.
  if (heroTavern && heroTavern.parent !== group) {
    mountTavern({ k: 'tavern', x: -9.6, z: 14.2, yaw: Math.PI });
    ghostTavern = true;
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
    KIND_LIST,
    footprint,
    defaultLayout,

    /** A deep copy of the layout the town is currently built from. */
    layout() { return copyLayout(current); },

    /** Dismiss the warm-up ghost (see above). Called once, after warmUpClock. */
    warmupDone() {
      if (ghostTavern && heroTavern) {
        group.remove(heroTavern);
        ghostTavern = false;
      }
    },

    /**
     * Rebuild the town from a new layout. Sanitizes first; returns a deep
     * copy of what was actually applied, or null if `raw` was not a layout.
     * Costs a full geometry build (~tens of ms) — commit-time only.
     */
    rebuild(raw) {
      const clean = sanitizeLayout(raw);
      if (!clean) return null;
      current = clean;
      applyGeos(buildAll(current.items));
      // New meshes never appear here (the three are persistent), but the
      // tavern may have been re-added: keep layers and clip complete.
      setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
      applyWaterClip(group);
      return copyLayout(current);
    },

    update(ctx) { uniforms.time.value = ctx.time; },

    applyEnv(env) {
      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.lanternIntensity * 1.35;
    },

    dispose() {
      meshDeck.geometry?.dispose?.();
      meshWall.geometry?.dispose?.();
      meshGlow.geometry?.dispose?.();
      for (const g of SOURCES) g.dispose();
      matDeck.dispose(); matWall.dispose(); matGlow.dispose();
    },
  };
}
