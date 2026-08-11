// The harbour front — the one piece of this world you can stand on.
//
// Everything else the player touches is a boat or a camera. Walking needs
// GROUND, and the village island has none: measured on the terrain function
// itself, the shelf where the dock lands sits at 0.4-1.5 m and the hill behind
// it climbs about 1.2 metres for every metre inland — a 50 degree face. The
// flattest three-metre cell anywhere within seventy metres of the town still
// falls 2.9 m across itself. There is nowhere to put a square.
//
// So the square is BUILT, which is what a harbour town is: a stone quay on a
// sea wall, filled behind, with the terraces stacked up the hill above it. The
// deck is dead flat at the dock's own deck height, so you walk off the planks
// onto the stone without a step, and the wall skirts down to whatever the
// terrain is doing underneath — 1.5 m of it at the back, 3.3 m at the seaward
// corner where it stands out of the water.
//
// The walkable surface is DATA, not geometry. `ground()` answers from a short
// list of rectangles in the dock's own (u, v) frame, so the walk controller
// never raycasts and never touches the mesh; the mesh is drawn from the same
// list, so the two cannot drift. `blocked()` is the same idea for the things
// you should not walk through.
//
// Coordinates. `u` runs across the dock, positive toward open water; `v` runs
// along it, positive from the shore toward the head. The shore end of the dock
// is the origin. Every number in this file is in that frame, because every
// number in this file has to line up with the dock.

import * as THREE from 'three';
import { Fn, uniform, attribute, vertexColor, float, sin, step } from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// --- the frame, shared with dock.js ------------------------------------------
// These two points are dock.js's SHORE and HEAD. They are repeated rather than
// imported because dock.js keeps them module-private, and a harbour that
// silently moved when the dock did would be worse than one that fails loudly.
// `assertFrame` below checks them against the dock's own info at build time.

const SHORE = new THREE.Vector2(-95, 10);
const HEAD = new THREE.Vector2(-58, -4);

const _f = new THREE.Vector2().subVectors(HEAD, SHORE);
const RUN = _f.length();
const FX = _f.x / RUN, FZ = _f.y / RUN;       // along, shore -> head
const RX = -FZ, RZ = FX;                       // across, positive to seaward

/** Dock-local (u, v) -> world x. */
export const worldX = (u, v) => SHORE.x + RX * u + FX * v;
/** Dock-local (u, v) -> world z. */
export const worldZ = (u, v) => SHORE.y + RZ * u + FZ * v;
/** World -> dock-local u (across). */
export const localU = (x, z) => (x - SHORE.x) * RX + (z - SHORE.y) * RZ;
/** World -> dock-local v (along). */
export const localV = (x, z) => (x - SHORE.x) * FX + (z - SHORE.y) * FZ;

/** The dock's own yaw, so anything placed here faces the way the dock does. */
export const DOCK_YAW = Math.atan2(FX, FZ);

// --- the walkable set --------------------------------------------------------
//
// One flat deck and the dock it joins. Two levels were drawn and thrown away:
// at 1.2 m of rise per metre inland, a second terrace six metres deep needs a
// five-metre retaining wall at the front and a four-metre cut at the back, and
// what you get for all that stone is a corridor. One good square beats two
// mean ones, and the hillside town already rises behind it for free.
//
// `y` is flat; `pad` is how far outside the rectangle the walk controller is
// still allowed to be, so you do not fall off a kerb you cannot see.

const QUAY_Y = 2.90;            // checked against dock.info.deckY at build

const DECKS = [
  // The square. Measured against the terrain rather than drawn to taste: the
  // shelf here is only about 13 m wide before the hill starts, and the coast
  // runs DIAGONALLY to the dock axis, so a rectangle that looked symmetrical
  // in this frame buried its far corner sixteen metres inside the hillside —
  // the walk controller cheerfully let you stroll through solid rock at 2.9 m
  // while the island went past overhead at 19. u to -3 and v to -15 keeps
  // every corner on ground the terrain function agrees is under 4 m; v to +3
  // so the square reaches the foot of the town's stair.
  { id: 'quay', u0: -3.0, u1: 10.0, v0: -15.0, v1: 3.0, y: QUAY_Y },
  // The dock deck itself, so you can walk out to the boat. Its half-width is
  // dock.js's MAIN_W / 2 = 4.5; 4.1 keeps you off the very edge.
  { id: 'pier', u0: -4.1, u1: 4.1, v0: 0.0, v1: RUN - 1.5, y: QUAY_Y },
  // The two finger piers, at dock.js's own offsets. Their inner edges OVERLAP
  // the main deck rather than abutting it: dock.js has them meeting the deck
  // exactly at |u| = 4.5, and insetting both by 0.4 m for safety left a 0.4 m
  // gap that the walk controller reads as a hole in the middle of a pier.
  { id: 'finger-a', u0: -12.5, u1: -3.8, v0: 12.0, v1: 16.6, y: QUAY_Y },
  { id: 'finger-b', u0: 3.8, u1: 11.3, v0: 22.0, v1: 26.2, y: QUAY_Y },
];

// The town's own street, as a walkable corridor. village.js lays its stone
// steps along a polyline solved from the terrain; this is that same polyline,
// so the surface you can stand on and the surface that was drawn are one
// object. Height comes from the terrain rather than from the points, because
// that is where the steps were put.
let STAIR = null;                 // [{x, z, s}], shore end first, s = arc length
let stairHeight = null;           // (x, z) => y
const STAIR_HALF = 1.15;          // the steps are 2.5 m wide; stay off the edge

// The quay is flat at 2.90 and the bank behind it is already at 4.09 half a
// metre up the stair — measured, a 1.19 m wall exactly where the two are
// supposed to meet, and the one break in an otherwise continuous climb whose
// every other step is under half a metre. So the first few metres of the
// corridor ramp out of the deck instead of standing on the terrain: a flight
// of steps, which is what is drawn there too.
const STAIR_BLEND = 4.0;

/**
 * Hand the harbour the village's stair. Called once at build; without it the
 * quay is simply a dead end, which is a worse town but not a broken one.
 */
export function setStair(points, heightAt) {
  // The points carry their own y now: village.js gradient-limits the profile
  // and lays its step boxes at exactly these heights, so reading y here is
  // what makes "the surface you stand on is the surface that was drawn" true
  // rather than merely intended. `heightAt` is kept only for the buried-deck
  // test, which is about the island and not about the stair.
  STAIR = (points || []).map((p) => ({ x: p.x, y: p.y, z: p.z, s: 0 }));
  for (let i = 1; i < STAIR.length; i++) {
    const a = STAIR[i - 1], b = STAIR[i];
    b.s = a.s + Math.hypot(b.x - a.x, b.z - a.z);
  }
  stairHeight = heightAt || null;
}

/**
 * The ground under a world point, or null if there is none.
 *
 * Flat rectangles first — four comparisons each, no allocation — then the
 * stair corridor. Called every frame by the walk controller and wants to stay
 * that way.
 */
export function ground(x, z) {
  const u = localU(x, z), v = localV(x, z);
  // The terrain, once. A deck rectangle is only a floor where the ground is
  // BELOW it: the dock's landward finger overlaps the foot of the town's stair
  // in plan while sitting four metres under it in height, and with the rects
  // winning unconditionally the whole route read as one flat 2.9 m plateau
  // that dead-ended in a wall. Measured with a flood fill from the landing —
  // 591 m2 reachable, every cell at 2.90, the stair top unreachable.
  const h = stairHeight ? stairHeight(x, z) : -1e4;
  for (let i = 0; i < DECKS.length; i++) {
    const d = DECKS[i];
    if (u < d.u0 || u > d.u1 || v < d.v0 || v > d.v1) continue;
    if (!(Number.isFinite(h) && h > d.y + 0.45)) return d.y;
    break;                                  // buried here; the bank owns it
  }
  if (STAIR && stairHeight) {
    // The NEAREST leg, not the first one that contains the point. The stair is
    // a switchback: two legs pass within a couple of metres of each other in
    // plan while sitting three and a half metres apart in height, so their
    // corridors overlap, and first-match handed back whichever leg happened to
    // be earlier in the array. The climb died at every turn. Nearest-centreline
    // picks the leg you are actually on, and at the corner itself both legs
    // meet at the same point so they agree.
    let bestD2 = STAIR_HALF * STAIR_HALF;
    let bestY = null;
    for (let i = 0; i < STAIR.length - 1; i++) {
      const a = STAIR[i], b = STAIR[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz;
      if (L2 < 1e-6) continue;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = a.x + dx * t, pz = a.z + dz * t;
      const ox = x - px, oz = z - pz;
      const d2 = ox * ox + oz * oz;
      if (d2 > bestD2) continue;
      // The CENTRELINE's height, interpolated along the leg — not the terrain
      // under your feet. Sampling terrain made the corridor a strip of raw
      // 50-degree hillside, 2.7 m of cross-fall across its own width, and the
      // climb died at 5.6 m every time because stepping sideways was a
      // two-metre drop.
      const hh = a.y + (b.y - a.y) * t;
      if (!(Number.isFinite(hh) && hh > -900)) continue;
      let y = hh + 0.28;
      // Ramp out of the quay over the first few metres rather than starting at
      // whatever the bank happens to be doing.
      const arc = a.s + Math.sqrt(L2) * t;
      if (arc < STAIR_BLEND) {
        const k = arc / STAIR_BLEND;
        y = QUAY_Y + (y - QUAY_Y) * (k * k * (3 - 2 * k));
      }
      bestD2 = d2;
      bestY = y;
    }
    if (bestY !== null) return bestY;
  }
  return null;
}

/** Where the stair begins, in world space, or null if it has not been set. */
export function stairFoot() {
  return STAIR && STAIR.length ? { x: STAIR[0].x, z: STAIR[0].z } : null;
}

// Things on the quay you cannot walk through, as circles in the local frame.
// Buildings get a circle each rather than a rectangle because the walk
// controller slides along the normal, and sliding around a circle never
// catches a corner. Filled by `createHarbour`.
const SOLIDS = [];

/**
 * Register something you cannot walk through, in world coordinates. Called by
 * whoever places the buildings — the quay does not own them, so it cannot know
 * about them without being told.
 */
export function addSolid(x, z, r) { SOLIDS.push({ x, z, r }); }

/** Forget every registered solid. Only for a rebuild. */
export function clearSolids() { SOLIDS.length = 0; }

/**
 * Push a walker out of anything solid, in WORLD coordinates. Circles rather
 * than rectangles because the push is along the normal, and sliding around a
 * circle never catches on a corner the way a box does.
 */
export function unblock(x, z, radius, out) {
  let hit = false;
  for (let i = 0; i < SOLIDS.length; i++) {
    const s = SOLIDS[i];
    const dx = x - s.x, dz = z - s.z;
    const r = s.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r || d2 < 1e-9) continue;
    const d = Math.sqrt(d2);
    x = s.x + (dx / d) * r;
    z = s.z + (dz / d) * r;
    hit = true;
  }
  out.x = x; out.z = z;
  return hit;
}

// --- where the boat ties up and where you step off ---------------------------
//
// The berth is alongside the main deck on the landward side, far enough out
// that the hull does not clip the pilings and near enough that the gangway is
// believable. The landing is the deck point you appear at, one step inboard.

// Alongside the outer finger pier, in water that is actually there.
//
// This was u = -6.6 — "alongside the main deck on the landward side" — and
// landward of this dock is the ISLAND. Measured: that point is dry land at
// 4.56 m, `isLand` true, and every cell around it for fifteen metres reads
// land too. The prompt could never arm, so there was never a dock button, on
// a phone or anywhere else. The depth map says water exists only on the +u
// side; the deepest spot touching a walkable deck is beside finger-b at about
// 2.7 m, which is also the first part of the dock you meet coming in off the
// sea.
export const BERTH = { u: 13.2, v: 24.0, yaw: DOCK_YAW };
// On the finger pier beside the boat — you step off where you tied up, and
// the walk down the pier and into the square is the arrival. Landing on the
// quay itself was tried while the berth was (wrongly) at the shore end; with
// the berth out here, teleporting ashore would skip the best part.
export const LANDING = { u: 9.4, v: 24.0 };

/** The landing, in world space — where you appear when you step off. */
export function landingWorld(out) {
  return out.set(worldX(LANDING.u, LANDING.v), 0, worldZ(LANDING.u, LANDING.v));
}

/** Where the boat should sit when moored, in world space. */
export function berthWorld(out) {
  return out.set(worldX(BERTH.u, BERTH.v), 0, worldZ(BERTH.u, BERTH.v));
}

/** How close the boat has to be to the berth before the prompt appears. */
export const DOCK_RANGE = 16.0;

/** Is the boat near enough to tie up? `bx`/`bz` are world. */
export function nearBerth(bx, bz) {
  const du = localU(bx, bz) - BERTH.u;
  const dv = localV(bx, bz) - BERTH.v;
  return du * du + dv * dv <= DOCK_RANGE * DOCK_RANGE;
}

// --- palette -----------------------------------------------------------------
// The quay is older than the town on it: grey granite, not the warm stucco of
// the houses. That contrast is what makes the buildings read as a later, softer
// thing sitting on a working wall.

const GRANITE = [0x8E8B83, 0x9B978D, 0x82807A, 0x968F84, 0x8A8E88];
const COBBLE = [0x8A867C, 0x938E82, 0x7E7A72, 0x8E8878, 0x847F76, 0x999284];
const KERB = 0xA9A296;
const TIMBER = [0x7A5B3A, 0x6B4E31, 0x866644];
const IRON = 0x36363A;
const ROPE = 0xC7B189;
const CRATE = [0x8A6A44, 0x9B7B50, 0x6F573A];
const BARREL = [0x6E4E30, 0x7C5A38];
const NET = 0x9AA88C;
const GLASS_TINT = 0xFFDCA8;

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
      for (const e of ex) {
        g.setAttribute(e.name, new THREE.BufferAttribute(new Float32Array(e.data), e.size));
      }
      g.computeBoundingSphere();
      return g;
    },
  };
}

// The lamp material, same shape as the one in props.js: an emissiveNode driven
// by two uniforms the day/night cycle writes, and a per-vertex (strength,
// phase) so one mesh carries every lamp on the quay.
function makeGlowMaterial(uniforms, baseHex) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: C(baseHex), roughness: 0.32, metalness: 0.0, vertexColors: true, fog: true,
  });
  const aGlow = attribute('aGlow', 'vec2');
  m.emissiveNode = Fn(() => {
    const gph = aGlow.y.toVar();
    const gfl = float(1.0).add(step(0.001, gph).mul(
      sin(uniforms.time.mul(gph.mul(2.7).add(2.1)).add(gph.mul(23.0))).mul(0.13)
        .add(sin(uniforms.time.mul(gph.mul(1.3).add(6.9)).add(gph.mul(41.0))).mul(0.06)),
    )).toVar();
    return uniforms.color
      .mul(uniforms.intensity.mul(aGlow.x).mul(gfl))
      .mul(vertexColor().rgb);
  })();
  return m;
}

export function createHarbour(opts = {}) {
  const terrain = opts.terrain || null;
  const deckY = Number.isFinite(opts.deckY) ? opts.deckY : QUAY_Y;
  const rng = makeRng(((opts.seed | 0) ^ 0x9A2B07) >>> 0);

  // The quay is flush with the dock by construction, so if dock.js ever moves
  // its deck the two would part company silently. Follow it instead.
  for (const d of DECKS) d.y = deckY;

  const group = new THREE.Group();
  group.name = 'harbour';

  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return -1e4;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };

  const uniforms = {
    time: uniform(0),
    color: uniform(new THREE.Color(1, 0.72, 0.36)),
    intensity: uniform(0),
  };

  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const CYL10 = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const CONE = new THREE.ConeGeometry(0.5, 1, 8);
  const SOURCES = [BOX, CYL8, CYL10, CONE];

  const bStone = makeBuilder();
  const bWood = makeBuilder();
  const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

  // Everything is placed in the local frame and transformed once, so the code
  // reads in the same coordinates the layout was designed in.
  const W = new THREE.Matrix4();
  compose(W, SHORE.x, 0, SHORE.y, 1, 1, 1, 0, DOCK_YAW, 0);

  // In this matrix local +z is `v` (along the dock) and local +x is `u`.
  const put = (B, geo, u, y, v, su, sy, sv, rx, ry, rz, color, extra) => {
    compose(_mLocal, u, y, v, su, sy, sv, rx, ry, rz);
    _mOut.multiplyMatrices(W, _mLocal);
    B.add(geo, _mOut, color, extra);
  };

  const pick = (arr) => C(arr[rng.int(0, arr.length - 1)]);

  // --- the quay deck --------------------------------------------------------
  //
  // Cobbles as a coarse grid of slightly-proud boxes rather than one slab: at
  // the scale you walk on it, a flat plane reads as a bug. 1.6 m cells keep it
  // to ~130 boxes for the whole square.

  const Q = DECKS[0];
  const QW = Q.u1 - Q.u0, QL = Q.v1 - Q.v0;

  // The slab the cobbles sit on, and the fill under it down to the terrain.
  put(bStone, BOX, (Q.u0 + Q.u1) / 2, deckY - 0.35, (Q.v0 + Q.v1) / 2,
    QW, 0.7, QL, 0, 0, 0, C(GRANITE[2]));

  const CELL = 1.6;
  for (let u = Q.u0 + CELL * 0.5; u < Q.u1; u += CELL) {
    for (let v = Q.v0 + CELL * 0.5; v < Q.v1; v += CELL) {
      const c = pick(COBBLE);
      const k = 0.94 + rng.range(0, 0.14);
      put(bStone, BOX, u + rng.range(-0.05, 0.05), deckY - 0.02, v + rng.range(-0.05, 0.05),
        CELL - 0.10, 0.10, CELL - 0.10, 0, rng.range(-0.03, 0.03), 0,
        c.multiplyScalar(k));
    }
  }

  // --- the sea wall ---------------------------------------------------------
  //
  // Skirts the three exposed sides down to the terrain beneath, sampled per
  // panel so it always meets the ground instead of floating or burying itself.
  // The seaward face is the tall one — about 3.3 m out of the water at the
  // corner — and it is the whole reason the square exists.

  function wall(u0, v0, u1, v1, thick) {
    const du = u1 - u0, dv = v1 - v0;
    const len = Math.hypot(du, dv);
    const n = Math.max(2, Math.round(len / 2.0));
    const ang = Math.atan2(du, dv);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const u = u0 + du * t, v = v0 + dv * t;
      const g = landAt(worldX(u, v), worldZ(u, v));
      const base = Math.min(deckY - 0.6, g > -900 ? g - 0.8 : -2.2);
      const h = deckY - base;
      put(bStone, BOX, u, base + h * 0.5, v, thick, h, len / n + 0.06, 0, ang, 0, pick(GRANITE));
      // A course of capstones along the top, proud of the face.
      put(bStone, BOX, u, deckY + 0.10, v, thick + 0.28, 0.22, len / n + 0.02, 0, ang, 0, C(KERB));
    }
  }

  wall(Q.u1, Q.v0, Q.u1, Q.v1, 0.9);          // seaward face
  wall(Q.u0, Q.v0, Q.u1, Q.v0, 0.9);          // the far end
  // The near end is split around the dock mouth so you can walk straight out.
  wall(Q.u0, Q.v1, -4.6, Q.v1, 0.9);
  wall(4.6, Q.v1, Q.u1, Q.v1, 0.9);

  // --- bollards and rings ---------------------------------------------------

  for (let v = Q.v0 + 2.4; v < Q.v1 - 1.0; v += 4.2) {
    put(bStone, CYL10, Q.u1 - 0.9, deckY + 0.34, v, 0.46, 0.68, 0.46, 0, 0, 0, C(IRON));
    put(bStone, CYL10, Q.u1 - 0.9, deckY + 0.70, v, 0.60, 0.16, 0.60, 0, 0, 0, C(IRON));
    if (rng.chance(0.6)) {
      // A coil of rope dropped beside it.
      const cu = Q.u1 - 1.9, cv = v + rng.range(-0.5, 0.5);
      for (let k = 0; k < 3; k++) {
        put(bWood, CYL10, cu, deckY + 0.06 + k * 0.07, cv,
          0.86 - k * 0.16, 0.10, 0.86 - k * 0.16, 0, 0, 0, C(ROPE));
      }
    }
  }

  // --- the lamps ------------------------------------------------------------
  // Four along the seaward edge, two at the head of the square. At night these
  // are the reason to come back.

  const lampSpots = [];
  for (let v = Q.v0 + 3.0; v < Q.v1 - 1.0; v += 6.4) lampSpots.push([Q.u1 - 1.6, v]);
  lampSpots.push([Q.u0 + 1.6, Q.v0 + 4.0], [Q.u0 + 1.6, Q.v1 - 4.0]);

  lampSpots.forEach(([u, v], i) => {
    put(bStone, CYL8, u, deckY + 0.16, v, 0.62, 0.32, 0.62, 0, 0, 0, C(IRON));
    put(bStone, CYL8, u, deckY + 1.70, v, 0.17, 3.1, 0.17, 0, 0, 0, C(IRON));
    put(bStone, BOX, u, deckY + 3.34, v, 0.46, 0.52, 0.46, 0, 0, 0, C(IRON));
    put(bStone, CONE, u, deckY + 3.74, v, 0.60, 0.30, 0.60, 0, 0, 0, C(IRON));
    put(bGlow, BOX, u, deckY + 3.34, v, 0.34, 0.42, 0.34, 0, 0, 0, C(GLASS_TINT),
      { aGlow: [1.35, 0.25 + i * 0.19] });
  });

  // --- the cosy clutter -----------------------------------------------------
  //
  // A working quay is never empty. Crates, barrels, a net spread to dry, a
  // fish crate or two — all of it hard against the walls so the middle of the
  // square stays open to walk in, which is the whole point of a square.

  function crate(u, v, s, rot) {
    put(bWood, BOX, u, deckY + s * 0.5, v, s, s, s * 0.92, 0, rot, 0, pick(CRATE));
    const e = new THREE.Color(0x000000);
    for (const [ox, oz] of [[0, s * 0.47], [0, -s * 0.47]]) {
      put(bWood, BOX, u + Math.cos(rot) * ox - Math.sin(rot) * oz, deckY + s * 0.5,
        v + Math.sin(rot) * ox + Math.cos(rot) * oz,
        s * 1.02, s * 0.14, 0.06, 0, rot, 0, e.copy(pick(CRATE)).multiplyScalar(0.8));
    }
  }

  function barrel(u, v) {
    const h = rng.range(0.8, 1.0);
    put(bWood, CYL10, u, deckY + h * 0.5, v, 0.72, h, 0.72, 0, 0, 0, pick(BARREL));
    for (const t of [0.22, 0.78]) {
      put(bWood, CYL10, u, deckY + h * t, v, 0.78, 0.08, 0.78, 0, 0, 0, C(IRON));
    }
  }

  const clutter = [
    [Q.u0 + 1.3, Q.v0 + 8.0], [Q.u0 + 1.2, Q.v0 + 9.6], [Q.u0 + 2.4, Q.v0 + 8.8],
    [Q.u1 - 2.2, Q.v0 + 1.6], [Q.u1 - 3.4, Q.v0 + 1.4],
    [Q.u0 + 1.4, Q.v1 - 3.2], [Q.u1 - 2.0, Q.v1 - 2.6],
  ];
  for (const [u, v] of clutter) {
    if (rng.chance(0.55)) crate(u, v, rng.range(0.8, 1.15), rng.range(-0.4, 0.4));
    else barrel(u, v);
  }

  // A net spread on the stones near the far corner, and stacked fish crates.
  for (let i = 0; i < 3; i++) {
    put(bWood, BOX, Q.u1 - 3.0 + i * 0.1, deckY + 0.28 + i * 0.46, Q.v0 + 5.2 + i * 0.12,
      1.35, 0.44, 0.95, 0, rng.range(-0.2, 0.2), 0, pick(CRATE));
  }
  put(bWood, BOX, Q.u1 - 5.2, deckY + 0.04, Q.v0 + 3.4, 3.2, 0.06, 2.4,
    0, rng.range(-0.3, 0.3), 0, C(NET));

  // --- steps from the quay down to the water --------------------------------
  // Every harbour has them, and they are what makes the wall read as tall.

  for (let i = 0; i < 6; i++) {
    put(bStone, BOX, Q.u1 + 0.35, deckY - 0.30 - i * 0.36, Q.v0 + 12.0,
      1.5, 0.34, 1.1 + i * 0.0, 0, 0, 0, pick(GRANITE));
  }

  // --- build ----------------------------------------------------------------

  const matStone = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0.0, fog: true,
  });
  const matWood = new THREE.MeshStandardNodeMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.0, fog: true,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1C22);

  const geos = [];
  const meshes = [];
  for (const [b, mat, name] of [[bStone, matStone, 'harbour-stone'],
    [bWood, matWood, 'harbour-wood'], [bGlow, matGlow, 'harbour-glow']]) {
    if (!b.count) continue;
    const g = b.build();
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = name !== 'harbour-glow';
    m.receiveShadow = name !== 'harbour-glow';
    group.add(m);
    meshes.push(m);
  }

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  applyWaterClip(group);

  return {
    group,
    ground,
    unblock,
    stairFoot,
    landingWorld,
    addSolid,
    berthWorld,
    nearBerth,
    BERTH,
    LANDING,
    deckY,
    worldX,
    worldZ,
    localU,
    localV,
    yaw: DOCK_YAW,

    update(ctx) {
      uniforms.time.value = ctx.time;
    },

    applyEnv(env) {
      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.lanternIntensity * 1.3;
    },

    dispose() {
      for (const g of geos) g.dispose();
      for (const g of SOURCES) g.dispose();
      matStone.dispose(); matWood.dispose(); matGlow.dispose();
    },
  };
}
