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
//     but water/clip.js trims the reflection pass at the waterline, so only a
//     breach reflects. Naming the module matters: this comment used to claim the
//     pass clipped by itself, which is how the animal ended up on REFLECTED with
//     nothing trimming it, painting a dark smear across open water.
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
// sit.
//
// TWO draw calls per animal — the body and the eyes — and that took a fix. The
// eyes were two Meshes sharing one geometry and one material, so a single
// animal was THREE meshes; on layers MAIN|UNDERWATER|REFLECTED, drawn by
// main.js:559-561 in three passes, that is nine draw calls for one leviathan.
// Merging the eyes into one two-sphere buffer at build time takes it to six.
//
// THE POD. There are now two to four of them, because the deep water was empty
// and the player asked for it not to be. Everything about "several" is in
// `makeAnimal` and in three rules learned from pictures rather than from code:
//
//   * ONE geometry family, ONE material. Every body is a separate Mesh over a
//     BufferGeometry that shares position/normal/aFin by reference; only the
//     tiny constant `aLev` differs. Identical attribute layout and an identical
//     material object mean one WGSL module and one pipeline for all of them
//     (clip.js:19-28). Measured: three extra bodies cost +9 draw calls and
//     +21,492 triangles when all are in frame, and +0 when they sit at their
//     real anchors, because per-mesh frustum culling removes them.
//   * THEY DO NOT SCHOOL. Each owns one lobe of the deep annulus, at least
//     160 m from its neighbours. What makes the deep feel inhabited is that
//     something lives at the north-west drop and something ELSE lives off the
//     lighthouse — not four animals in one place.
//   * AT CRUISE DEPTH IN THE DEEP THEY ARE INVISIBLE. That is measured: at
//     20 m down and 70 m out a 34 m leviathan is indistinguishable from cloud
//     mottle; at 12 m it is a smudge; at 7-9 m it is unmistakable. So "more
//     monsters in deeper water" is not delivered by parking silhouettes at
//     25 m. It is delivered by the SOUNDING — drive out to one of their homes
//     and it comes up to 8.5 m and crosses your bow — and by breaches, which
//     are legible at any range.
//
// The module also owns the **disturbance** — the churned patch and rising
// bubbles out toward the lighthouse island that the quest sends the player to
// investigate. `api.disturbance` is the public handle for it. There is exactly
// ONE of those however many animals there are: quest.js:99-107 latches it on
// its first read, inside createQuest, before any update has run.

import * as THREE from 'three';
import {
  Fn, uniform, attribute, varying, uv, materialOpacity,
  positionLocal, positionGeometry, positionWorld, positionViewDirection,
  normalLocal, transformNormalToView, transformedNormalView, transformedNormalWorld,
  cameraPosition,
  vec2, vec3, vec4, float, floor, fract, mod, sin, cos, atan, abs, dot, mix,
  step, smoothstep, clamp as tslClamp, max as tslMax, length, oneMinus,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng, clamp } from '../core/rng.js';
import { createSplash } from './splash.js';

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

// DEEP water, which is a stricter thing than "not aground", and the difference
// is the whole point of the pod. Probed on sixteen bearings against
// terrain.seabedHeight: the reef flats run to r ~ 200, the shelf edge crosses
// MIN_FLOOR at r 234-240, -20 m at r 256-262, -25 m at r 274-284, and the deep
// proper (-27 to -33) starts around r 300 north and r 400 elsewhere.
//
// The radius alone is NOT a depth test and must never be used as one: (-300, 0)
// is at r = 300, is 161 m from the village-island keep-out centre and therefore
// passes every circle below, and sits in 6.9 m of water — the island's sand
// apron (seabed.js:103-105) reaches well past its keep-out radius. So the
// radius is only the cheap pre-filter and the seabed height is the authority.
//
// -24 is chosen so a spine at -19 still has clearance under it with a metre in
// hand. Anchors AND circuit targets are both vetted against it — today only the
// anchor was, and a primary circuit point landed at (140, -204) in 15.6 m.
const DEEP_MIN_R = 300;
const DEEP_FLOOR = -24;

// Where the pod lives. Every one of these was probed before it was written
// down; the depth in the comment is terrain.seabedHeight at that point.
//
// The ORDER is the order they are populated in as the geometry budget rises, so
// the low tiers get the two that are most likely to be found. Pairwise
// separation is at least 160 m by construction (the closest pair is L1-L3 at
// 178 m), which is why nothing has to enforce separation per frame.
//
// `band` is the cruise depth range in metres. It is deliberately different per
// animal and deliberately deeper for the far ones: L3 lives at 26-30 m five
// hundred metres offshore and the only thing that will ever reveal it is the
// player going out there and it rising to meet him. Invisibility is the water
// column, not a visibility flag — nothing here is ever hidden or revealed.
const POD = [
  // x     z      scale band          circuit  stretch rate    speed
  { x: 140, z: -300, s: 1.00, d0: 13.5, d1: 24.5, r: 96, k: 1.25, u: 0.032, v: 4.2 },  // -30.8  the quest's animal
  { x: -20, z: -380, s: 0.88, d0: 14.0, d1: 18.0, r: 84, k: 1.30, u: 0.026, v: 3.6 },  // -33    due north, over the drop
  { x: -250, z: -290, s: 1.15, d0: 20.0, d1: 24.0, r: 108, k: 1.15, u: 0.020, v: 3.4 }, // -31.5  the north-west deep
  { x: 90, z: -520, s: 1.08, d0: 26.0, d1: 30.0, r: 124, k: 1.20, u: 0.038, v: 5.2 },  // -42    the one you have to go and find
];

// The sounding — the reward for driving out to where one of them lives, and the
// only thing that makes a deep animal legible at all.
//
// The numbers come from photographs, not from taste. At 20 m depth / 70 m range
// I could not tell a leviathan from a cloud reflection. At 12 m it is a distinct
// dark shape but it sits directly behind the boat hull, which the chase framing
// keeps low-centre. At 7 m and 22 m it spans ~440 px against a ~110 px hull.
// So: come up to 8.5 m, and cross the BOW rather than coming down the
// centreline — the primary's own flyby aims at `boat + dir * 70`, straight
// through the boat, which is exactly the framing that hides it.
const SOUND_R = 140;        // how close to its home the boat has to come
const SOUND_RISE = 14;      // seconds from the cruise band up to SOUND_Y
const SOUND_HOLD = 20;      // seconds at depth, i.e. two or three crossings
const SOUND_FALL = 12;      // and back down
const SOUND_Y = 8.5;
const SOUND_LOCK = 90;      // before that animal will do it again
const SOUND_ABEAM = 60;     // metres to the side of the boat it aims for
// How far off the beam an approaching animal settles. Far enough that the
// player can see the whole of her and turn to face her, close enough that she
// is plainly interested in the boat rather than passing by.
const APPROACH_ABEAM = 38;
const SOUND_AHEAD = 30;     // and ahead, so the crossing happens off the bow

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

  // Per-ANIMAL individuality, and the only reason the pod is not one animal
  // rendered four times.
  //
  // There are now several leviathans on this ONE material, and a material owns
  // exactly one `uni.uMTime`. Feed that straight into the swim and four animals
  // beat their tails in perfect lockstep — a fleet, not wildlife. A second
  // uniform cannot fix it (a uniform is per material, not per mesh) and a
  // rebuilt graph per animal is four blocking pipeline builds (constraint 3).
  //
  // So the clock is bent per animal by a constant vertex attribute, exactly the
  // trick wildlife.js:733-747 uses for `aFish`: `aLev` is (phase offset in
  // seconds, rate scale), identical across every vertex of one animal and
  // different between animals. Each body gets its own BufferGeometry that
  // SHARES position/normal/aFin by reference and adds its own 57 KB aLev buffer
  // — 8 useful floats blown up to a vertex attribute, which is ugly, but the
  // attribute LAYOUT is identical so all of them still compile ONE pipeline
  // (clip.js:19-28, wildlife.js:714-719), and it costs zero CPU per frame.
  //
  // EVERY animal carries aLev, the primary included. A mixed attribute layout
  // would be two pipelines, which is the thing this whole file is built to
  // avoid.
  const aLev = attribute('aLev', 'vec2');
  const mTime = uni.uMTime.mul(aLev.y).add(aLev.x);

  // The fragment stage needs the same bent clock for the wet-collar streaks.
  // It has to come across as a varying: `aLev` is a vertex attribute and
  // reading one in the fragment stage is not free the way `positionWorld` is —
  // the same argument vWetU below is built on. One interpolated float.
  const vLevTime = varying(mTime, 'vLevTime');

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
    const w = sin(mTime.mul(uni.uFinRate));

    const ox = positionLocal.x.toVar();
    const py = positionLocal.y
      .add(w.mul(f).mul(uni.uFinAmp).mul(isP.add(isV.mul(0.5)))).toVar();
    const pz = positionLocal.z
      .add(oneMinus(cos(mTime.mul(uni.uFinRate))).mul(f).mul(uni.uFinAmp).mul(0.20).mul(isP))
      .toVar();

    const ma = monAngle(positionGeometry.z, mTime).toVar();
    const mc = cos(ma).toVar();
    const ms = sin(ma).toVar();

    return vec3(
      ox.mul(mc).add(monSway(positionGeometry.z, mTime)),
      py,
      pz.sub(ox.mul(ms)),
    );
  })();

  // The section yaw has to turn the normal with it or the tail lights as if it
  // were still straight. Computed per vertex, exactly as `beginnormal_vertex`
  // did, then handed to the shading normal in view space.
  const monNormal = Fn(() => {
    const ma = monAngle(positionGeometry.z, mTime).toVar();
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

  // The sheeting coordinate for the wet collar: a value that varies ACROSS the
  // body and is constant down it, so the noise it feeds becomes vertical streaks
  // of running water rather than a blotchy wash. It has to be a varying —
  // `positionGeometry` is a vertex attribute and reading it in the fragment
  // stage is not free the way `positionWorld` is.
  const vWetU = varying(
    positionGeometry.x.mul(1.05).add(positionGeometry.z.mul(0.30)), 'vWetU',
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

    // The wet collar. In ref/05 the single most prominent thing in the whole
    // breach is not the ring on the water — it is the opaque white skirt where
    // the body meets the sea, plus the sheets of water still running off the
    // shoulders. It costs no new object, no new draw call and no new pipeline:
    // `above` is already being computed twice here, so this is one band, one
    // noise and an add.
    //
    // Two terms. `collar` is a tight band around world y = 0, which is where
    // the water is actually breaking against the body. `runoff` is everything
    // low on the animal, weaker, and it is what makes a leviathan that has just
    // come out of the sea look wet instead of merely dark.
    // The band is +-1.8 m, not +-3.4. At 3.4 it swallowed the pectoral fin
    // whole — a fin lying flat at the surface sits entirely inside the band and
    // came back as a pale grey card with no silhouette left in it. A leviathan
    // is a hole in the water first and a wet animal second.
    // Narrowing the band was not enough on its own, and could not be: a
    // pectoral fin lying flat at the surface is THINNER than any band worth
    // having, so the whole of it sits inside one and comes back as a flat pale
    // card with no shading left. What separates a fin from a shoulder is not
    // height, it is FACING — the water breaks on a surface it can run down, and
    // it sheets straight off a horizontal one. So the collar is gated on how
    // vertical the surface is. A near-horizontal face keeps its own shading and
    // stops reading as a floating slab of polystyrene, which is what the frame
    // half a second after impact looked like.
    const upright = oneMinus(abs(transformedNormalWorld.y)).toVar();
    const collar = oneMinus(smoothstep(0.05, 1.8, positionWorld.y))
      .mul(smoothstep(-1.8, -0.15, positionWorld.y))
      .mul(smoothstep(0.15, 0.62, upright)).toVar();
    const runoff = oneMinus(smoothstep(0.0, 9.0, positionWorld.y)).mul(0.26).toVar();
    // Scrolling downward, so the streaks read as water falling rather than as a
    // texture painted on the hide.
    const wn = vnoise(vec2(vWetU, positionWorld.y.mul(0.26).sub(vLevTime.mul(1.35)))).toVar();
    c.addAssign(
      uni.uWetCol.mul(uni.uWet)
        .mul(collar.mul(0.95).add(runoff))
        .mul(wn.mul(0.75).add(0.40)),
    );
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
/**
 * Both eyes in ONE buffer.
 *
 * They were two Meshes sharing one SphereGeometry and one MeshBasicMaterial,
 * which reads as free and is not: a Mesh is a draw call per pass, and the animal
 * is on three passes, so the pair cost six draws. Merged, they cost three. At
 * four animals that is twelve draw calls saved for ten lines at build time —
 * more than instancing the bodies would have saved, and without the
 * positionNode/normalNode rewrite instancing would have forced.
 */
function buildEyes() {
  const src = new THREE.SphereGeometry(0.23, 8, 6);
  const sp = src.attributes.position.array;
  const sn = src.attributes.normal.array;
  const si = src.index.array;
  const n = src.attributes.position.count;
  const P = new Float32Array(sp.length * 2);
  const N = new Float32Array(sn.length * 2);
  const I = new Uint16Array(si.length * 2);
  for (let s = 0; s < 2; s++) {
    const ox = s === 0 ? -1.58 : 1.58;
    const vo = s * n;
    for (let i = 0; i < n; i++) {
      P[(vo + i) * 3] = sp[i * 3] + ox;
      P[(vo + i) * 3 + 1] = sp[i * 3 + 1] + 0.75;
      P[(vo + i) * 3 + 2] = sp[i * 3 + 2] - 14.10;
      N[(vo + i) * 3] = sn[i * 3];
      N[(vo + i) * 3 + 1] = sn[i * 3 + 1];
      N[(vo + i) * 3 + 2] = sn[i * 3 + 2];
    }
    for (let k = 0; k < si.length; k++) I[s * si.length + k] = si[k] + vo;
  }
  src.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setIndex(new THREE.BufferAttribute(I, 1));
  g.computeBoundingSphere();
  return g;
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
    // How wet she is, 0..1. Rises the instant the head clears the water and
    // takes a couple of seconds to run off — see the collar in monOutput.
    // Shared by the whole pod, and honest because the breach token below
    // guarantees only one animal is ever out of the water.
    uWet: uniform(0),
    uWetCol: uniform(new THREE.Color(0.9, 0.95, 1.0)),
  };

  // ---- the shared parts bin ----------------------------------------------
  // DoubleSide on purpose: a hand-lofted shell has a couple of caps whose
  // winding is not worth arguing with, and three flips the normal on back faces
  // so the shading comes out right either way.
  //
  // `geoTemplate` is never drawn. It is where the position/normal/aFin buffers
  // live, and every animal's geometry points at those same three
  // BufferAttributes — one upload, one GPU buffer each, however many animals.

  const geoTemplate = buildMonster(rng);
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide,
    fog: true,
    dithering: true,
  });
  decorateMonsterMaterial(mat, uni);

  // Eyes. Small, unlit, warm — the one thing in the silhouette that is not a
  // hole in the water. They sit forward of where the spine sway begins, so they
  // ride the body transform and need no shader of their own.
  const eyeGeo = buildEyes();
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffb755, fog: true });

  // ---- how many ----------------------------------------------------------
  // The house ramp, `lerpI` in splash.js:122, branching on the geometry BUDGET
  // and never on a tier name. geometry 1.00 -> 4, 0.68 -> 3, 0.50 -> 2,
  // 0.42 -> 2. Never fewer than two: one is what there was before the player
  // asked for more.
  const podCount = Math.min(
    POD.length,
    Math.round(2 + 2 * clamp((geoBudget - 0.42) / 0.58, 0, 1)),
  );

  const podGeos = [];
  function levGeometry(phase, rate) {
    const g = new THREE.BufferGeometry();
    // Shared by REFERENCE. Same buffers, same layout, one pipeline.
    g.setAttribute('position', geoTemplate.attributes.position);
    g.setAttribute('normal', geoTemplate.attributes.normal);
    g.setAttribute('aFin', geoTemplate.attributes.aFin);
    const n = geoTemplate.attributes.position.count;
    const a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { a[i * 2] = phase; a[i * 2 + 1] = rate; }
    g.setAttribute('aLev', new THREE.BufferAttribute(a, 2));
    g.boundingSphere = geoTemplate.boundingSphere.clone();
    podGeos.push(g);
    return g;
  }

  // ---- the disturbance ---------------------------------------------------
  // Exactly one, whatever the pod is doing. It is a quest LOCATION, and
  // quest.js:99-107 latches it permanently the first time it reads it — inside
  // createQuest (main.js:230), before a single update has run.

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

  // ---- white water -------------------------------------------------------
  // Two rigs, built here at boot and drawn every frame from here on —
  // collapsed to a point when idle. See the header of splash.js for why they
  // must never be created, revealed or unculled at the moment of impact.
  //
  // Why TWO and not one, and why not four. A rig is one set of
  // uT/uOrigin/uDir/uPower uniforms, so it can carry exactly one splash at a
  // time. The primary gets its own, because `api.breach()` is the quest's and
  // the capture harness's entry point and must never have to queue behind an
  // idle breach happening two hundred metres away. The rest of the pod share
  // the second, which is safe because the breach token below lets only one of
  // them be airborne at once. Four rigs would cost 2,840 idle triangles and
  // four idle draw calls each for nothing.
  const splashA = createSplash({ quality: opts.quality, seed });
  const splashB = createSplash({ quality: opts.quality, seed: seed ^ 0x51a5 });

  // Only one animal may be off the bottom of a breach arc at a time, and there
  // is an eight-second lockout after one ends. Two 34 m animals erupting
  // together reads as a cutscene rather than as wildlife, it would need a third
  // splash rig, and it would make the shared `uni.uWet` a lie.
  let airborne = 0;
  let breachLock = 0;

  // ---- steering shared by every animal ------------------------------------

  /**
   * Drag a circuit CENTRE out into water an animal actually fits in.
   *
   * Radius first because it is free, then the island keep-outs, then — and this
   * is the part that was missing — an actual depth test. The three circles do
   * not describe the islands' sand aprons: (-300, 0) clears all of them and is
   * in 6.9 m of water.
   */
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
    return pushDeep(v, DEEP_FLOOR);
  }

  /**
   * Walk a target point outward until the animal actually fits under it. The
   * bathymetry is radial, so "outward" is "deeper" on every bearing.
   *
   * `floor` is a parameter and not MIN_FLOOR because the two callers want
   * different things: a circuit target has to be in DEEP water (-24) or the
   * player's "put them in the deep" is not delivered, while a flyby target is
   * allowed anywhere the animal physically fits (-13.5 x its scale), because
   * the whole point of a flyby is that it comes to the boat.
   */
  function pushDeep(v, floor) {
    for (let i = 0; i < 8; i++) {
      if (seabed(v.x, v.z) < floor) break;
      const r = Math.hypot(v.x, v.z);
      if (r > 720) break;
      if (r > 1e-3) { const f = (r + 34) / r; v.x *= f; v.z *= f; } else v.z = -60;
    }
    return v;
  }

  // ---- one animal ---------------------------------------------------------

  /**
   * Everything that makes a leviathan an individual. All of this was already
   * per-closure before there was a pod; the only genuinely shared things are the
   * shader clock (bent per animal by `aLev`), the one disturbance, and the two
   * splash rigs.
   */
  function makeAnimal(index, spec) {
    const isPrimary = index === 0;
    const scale = spec.s;
    // Every clearance scales with the animal or a big one grounds. The
    // derivation at MIN_FLOOR above is per-metre-of-leviathan: spine 4.6 m off
    // the bottom, ridge 4.2 m above the spine, four metres of water over the
    // back.
    const clearance = 4.6 * scale;
    const minFloor = MIN_FLOOR * scale;
    const ceiling = -3.5 * scale;
    const rig = isPrimary ? splashA : splashB;

    // Its own geometry: shared buffers, its own two-float clock bend. Phase is
    // wide enough that no two tails are ever near each other; the rate scale is
    // narrow because past about ±20% the swim stops looking like the same
    // species.
    const geo = levGeometry(rng.range(0, TAU * 2), rng.range(0.86, 1.18));

    const body = new THREE.Group();
    body.name = isPrimary ? 'leviathan-body' : `leviathan-body-${index}`;
    body.scale.setScalar(scale);
    group.add(body);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = isPrimary ? 'leviathan' : `leviathan-${index}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const eyes = new THREE.Mesh(eyeGeo, eyeMat);
    eyes.name = isPrimary ? 'leviathan-eyes' : `leviathan-eyes-${index}`;
    eyes.castShadow = false;
    eyes.receiveShadow = false;
    body.add(mesh, eyes);

    // THE PRIMARY IS NEVER CULLED, THE REST ALWAYS MAY BE.
    //
    // splash.js:45-48 forbids culling outright, and the reason is exact: a
    // culled object is never reached by renderObject(), so its pipeline is not
    // compiled, and warmUpClock's frames all come from one camera pose — culling
    // defers a first draw exactly like `visible = false` does. That argument
    // applies to an object whose pipeline NOTHING ELSE compiles. It does not
    // apply here: every animal shares one material and one attribute layout, so
    // the primary compiles the pipeline for all of them.
    //
    // The primary is pinned because it must not be left to luck. Probed at boot:
    // the animal is at (70, -21, -340) and the default camera at (-6.6, 5.1,
    // 36.5) does have it in frustum — but `?boat=x,z,heading` (main.js:223-228)
    // teleports the boat BEFORE warmUpClock runs, and a start pose facing south
    // would leave the pipeline uncompiled until the first time the player turned
    // round. Pinning 7,164 vertices through three passes costs nothing and makes
    // the warm-up deterministic.
    mesh.frustumCulled = !isPrimary;
    eyes.frustumCulled = !isPrimary;

    // Where it lives. Vetted here, once, against the real seabed — not trusted
    // from the table.
    const anchor = new THREE.Vector3(spec.x, 0, spec.z);
    deepenAnchor(anchor);

    const position = isPrimary
      ? new THREE.Vector3(HOME_X * 0.5, -21, HOME_Z - 40)
      : new THREE.Vector3(anchor.x + spec.r * spec.k * 0.6, -(spec.d0 + spec.d1) * 0.5, anchor.z);
    if (!isPrimary) pushDeep(position, DEEP_FLOOR);
    const velocity = new THREE.Vector3(0, 0, -spec.v);
    const desired = new THREE.Vector3();

    const state = {
      position,
      heading: 0,
      depth: Math.max(0, -position.y),
      distance: 260,
      surfaced: 0,
      phase: 'cruise',
      alerted: false,
    };
    if (isPrimary) state.disturbance = disturbPos;

    let phase = 'cruise';
    let phaseT = 0;
    // Never phase-locked: a quarter turn apart round the circuit at boot, plus
    // a per-animal rate, means the pod never falls into formation.
    let circuitU = index * 0.27 + rng.range(0, 0.14);
    let bank = 0;
    let speed = spec.v;
    let nearDisturbT = 0;
    // Measured, and then lengthened. With the primary's 34 + 0..22 s on all four
    // animals, a boat parked in the middle of the annulus saw two breaches in
    // eighty seconds — one at 236 m and one at 169 m — and a leviathan erupting
    // every half-minute is a fairground attraction, not a sighting. The primary
    // keeps its own cadence because the player is usually nowhere near it and
    // because the quest breach does not go through this gate at all; the rest of
    // the pod wait two to three minutes each, which with three of them is one
    // breach somewhere in the deep every minute or so at the very most.
    let breachCooldown = (isPrimary ? 30 : 70) + index * 24;
    let approachLock = 0;
    let flybyT = 20;
    let flyby = 0;
    let soundLock = 25 + index * 9;
    let soundSide = index & 1 ? 1 : -1;
    let ringDone = false;
    let exitDone = false;
    let lastY = position.y;
    let stampT = 0;
    let mine = false;               // does this animal hold the breach token

    // The harpoon line. `hooked` is a phase like any other, entered only from
    // outside (the harpoon module owns the rope, the tension and the strain
    // arithmetic; the animal owns how it FEELS about being tethered). towAcc
    // is the line's pull, in m/s^2, written fresh every frame by towPull and
    // consumed exactly once.
    let hooked = false;
    let strain = 0;                 // 0 fresh .. 1 exhausted, set from outside
    let hookRetarget = 0;
    let lungeT = 0;
    const hookTarget = new THREE.Vector3();
    const towAcc = new THREE.Vector3();

    const brP0 = new THREE.Vector3();
    const brP1 = new THREE.Vector3();
    const brP2 = new THREE.Vector3();
    let brT = 0;
    const BREACH_TIME = 4.6;

    /** Deepest the spine may sit at (x, z): a body-height clear of the floor. */
    function floorLimit(x, z) {
      const h = seabed(x, z);
      return (Number.isFinite(h) ? h : -30) + clearance;
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

    /**
     * @param {number} surfaceX where she is aimed to break water
     * @param {number} surfaceZ
     * @param {number} [run] metres she carries on PAST that point before landing.
     *   This is what decides where the crash actually happens, and it used to be
     *   hard-wired at 46. That is why the game's most important breach — the one
     *   the quest builds to — landed 72 m from the boat: the approach aimed at
     *   `boat + dir*26` and then this pushed the landing another 46 m along the
     *   same line, past the boat, past the 62 m stamp gate, and past the point
     *   where a player looking at their own bow would see any of it.
     */
    function beginBreach(surfaceX, surfaceZ, run = 46) {
      brP0.copy(position);
      _dir.set(surfaceX - position.x, 0, surfaceZ - position.z);
      if (_dir.lengthSq() < 1e-4) _dir.set(velocity.x, 0, velocity.z);
      if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
      _dir.normalize();
      const ex = surfaceX + _dir.x * run;
      const ez = surfaceZ + _dir.z * run;
      brP2.set(ex, Math.max(-15 * scale, floorLimit(ex, ez)), ez);
      // Solve the control point for a *chosen* apex rather than adding a fixed
      // lift: a quadratic through B(0.5) = (P0 + 2*P1 + P2)/4 means P1 has to
      // start from where the ends actually are. Adding a constant instead let a
      // breach that began near the surface throw thirty metres of leviathan into
      // the sky.
      const apex = (9.5 + rng.range(0, 3.5)) * scale;
      brP1.set(
        (brP0.x + brP2.x) * 0.5,
        2 * apex - 0.5 * (brP0.y + brP2.y),
        (brP0.z + brP2.z) * 0.5,
      );
      brT = 0;
      ringDone = false;
      exitDone = false;
      if (!mine) { mine = true; airborne++; }
      setPhase('breach');
    }

    function releaseToken() {
      if (mine) { mine = false; airborne--; breachLock = 8; }
    }

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

    /** @returns {number} the animal's y, so the caller can drive the shared uWet. */
    function update(ctx, atDisturbance) {
      const dt = ctx.dt;
      const t = ctx.time;
      const boat = ctx.boat;
      const bx = boat ? boat.position.x : 0;
      const bz = boat ? boat.position.z : 0;
      const water = ctx.water;

      phaseT += dt;
      breachCooldown -= dt;
      approachLock -= dt;
      flybyT -= dt;
      soundLock -= dt;
      stampT += dt;

      // --- triggers -------------------------------------------------------
      // ONLY THE PRIMARY KNOWS THE BOAT EXISTS in this sense. If all four
      // responded to the quest the climactic breach becomes four breaches and
      // the beat is destroyed; if all four eased their circuits onto the player
      // he would be permanently mobbed and none of it would mean anything.
      if (isPrimary) {
        nearDisturbT = atDisturbance ? nearDisturbT + dt : 0;
        const wantApproach = questWantsApproach(ctx) || nearDisturbT > 2.4 || state.alerted;
        if (phase === 'cruise' && wantApproach && approachLock <= 0) setPhase('approach');
      }

      // --- behaviour ------------------------------------------------------
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
        _dir.set(velocity.x, 0, velocity.z);
        if (_dir.lengthSq() > 1e-6) _dir.normalize(); else _dir.set(0, 0, -1);

        if (water && water.disturb) {
          // The lead used to be a flat 15 m and the proximity test used to be run
          // against the LEAD point rather than against the animal. Both were
          // wrong. She travels 17.4 m/s, so a 15 m lead lays the whole descent
          // trail a full frame-and-a-half ahead of the body and the landing
          // arrives inside a 30 x 60 m streak that got there first; and testing
          // the lead meant the trail switched off 58 m from the boat measured
          // from a point that is not the animal. Lead only while she is RISING —
          // that is the bow wave of something coming up — and stop leading once
          // she is on the way down, where the water should be reacting behind her.
          const lead = velocity.y > 0 ? 12 : 3;
          _head.copy(position).addScaledVector(_dir, lead);
          const near = Math.hypot(position.x - bx, position.z - bz) < 62;
          if (near && position.y > -9 && stampT > 0.07) {
            stampT = 0;
            const st = clamp(1.2 + Math.abs(velocity.y) * 0.16, 0.6, 3.4);
            water.disturb(_head.x, _head.z, st, 5.5 + 3.0 * clamp(position.y / 8 + 1, 0, 1));
            water.disturb(position.x, position.z, st * 0.7, 8.5);
          }
        }

        // Coming OUT. A smaller version of the same rig: ref/05 is this moment,
        // not the landing, and a leviathan that erupts through the surface with
        // nothing breaking around her looks like she was always standing there.
        if (!exitDone && lastY <= 0.2 && position.y > 0.2) {
          exitDone = true;
          rig.fire(position.x, 0.15, position.z, _dir.x, _dir.z,
            (0.42 + 0.020 * Math.min(26, velocity.length())) * scale);
        }

        // The crash. NOT gated on distance to the boat — a stamp that lands
        // outside the 128 m wake window is thrown away, but geometry is geometry
        // and the idle breach in the middle distance is exactly the ref/05
        // establishing shot. splash.update() does its own gating for the part
        // that touches the ripple sim.
        if (!ringDone && lastY > 0.5 && position.y <= 0.5) {
          ringDone = true;
          // She hits at about 15 m/s down and 17 m/s forward — a 41 degree entry
          // at 23 m/s. The old stamp strength was `clamp(1.2 + |vy|*0.16, 0.6,
          // 3.4)`, which saturates at 3.4 precisely at the moment of impact, so a
          // hard landing wrote no more than a gentle one. Power is taken from the
          // whole speed and left uncapped at the top of the range this arc can
          // actually reach.
          rig.fire(position.x, 0.0, position.z, _dir.x, _dir.z,
            (0.55 + 0.022 * Math.min(28, velocity.length())) * scale);
        }
        lastY = position.y;
        if (brT >= 1) {
          breachCooldown = isPrimary ? 34 + rng.range(0, 22) : 95 + rng.range(0, 75);
          approachLock = 65;
          releaseToken();
          setPhase('dive');
        }
      } else {
        if (mine) releaseToken();       // anything that interrupts a breach

        // Where the circuit is centred. The primary's eases onto the boat while
        // the boat is somewhere the animal fits; every other animal's is fixed
        // at its own lobe of the annulus and never moves, which is what stops
        // the pod converging into a fleet. Separation is guaranteed at build
        // time by the POD table (closest pair 178 m apart), so nothing has to be
        // tested per frame.
        if (isPrimary) {
          // Her circuit is centred NEAR the player, not ON him. Centring it on
          // the boat meant the circuit radius carried her straight over the
          // hull twice a lap and she read as parked under it — "they seem to
          // want to stay under my boat so I can't move around to see them".
          // The centre now stands off by the circuit's own radius, so she
          // swims her lap in view and the player follows her instead of
          // wearing her.
          if (seabed(bx, bz) < minFloor) {
            _v.set(anchor.x - bx, 0, anchor.z - bz);
            if (_v.lengthSq() < 1) _v.set(0, 0, -1);
            _v.normalize();
            const stand = spec.r * spec.k * 0.9 + 40;
            _tgt.set(bx + _v.x * stand, 0, bz + _v.z * stand);
          } else _tgt.set(HOME_X, 0, HOME_Z);
          deepenAnchor(_tgt);
          anchor.lerp(_tgt, 1 - Math.exp(-dt / 26));
        }

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
            // ACROSS the bow, not through the keel. The offset has to be big
            // enough to survive the geometry: the closest approach of a line
            // aimed 70 m past the boat is only the offset scaled by how far
            // she still has to come, so 34 m of lateral became 20 m of actual
            // clearance. 55 m keeps the pass out at a watchable distance.
            _tgt.set(bx + _dir.x * 70 - _dir.z * 55, 0, bz + _dir.z * 70 + _dir.x * 55);
            pushDeep(_tgt, minFloor);
            const lim = floorLimit(_tgt.x, _tgt.z);
            steerTo(_tgt.x, Math.min(-11, Math.max(-20, lim)), _tgt.z, 5.4, dt);
            if (flyby <= 0 || away > 340 || seabed(bx, bz) > minFloor) {
              flyby = 0;
              flybyT = 46 + rng.range(0, 34);
            }
          } else {
            circuitU += dt * spec.u;
            const ca = Math.cos(circuitU * TAU), sa = Math.sin(circuitU * TAU);
            _tgt.set(anchor.x + ca * spec.r * spec.k, 0, anchor.z + sa * spec.r);
            // The circuit TARGET is vetted, not just the anchor. Without this
            // the primary's own circuit reached (140, -204) — r 247, 15.6 m of
            // water, three metres off the reef edge and nowhere near "the deep".
            pushDeep(_tgt, DEEP_FLOOR);
            const depthWant = (spec.d0 + spec.d1) * 0.5
              + (spec.d1 - spec.d0) * 0.5 * Math.sin(t * 0.052 + 1.3 + index);
            const lim = floorLimit(_tgt.x, _tgt.z);
            steerTo(_tgt.x, Math.min(-9 * scale, Math.max(-depthWant, lim)), _tgt.z, spec.v, dt);
            if (isPrimary && flybyT <= 0 && seabed(bx, bz) < minFloor
              && Math.hypot(position.x - bx, position.z - bz) < 340) flyby = 42;
          }
          speed = velocity.length();

          // THE SOUNDING. The reward for driving out to where one of them
          // lives, and the only thing that makes a deep animal legible. The
          // primary does not do it — it already has the flyby and the quest
          // approach, and it is the one animal that follows the player around.
          if (!isPrimary && soundLock <= 0 && flyby <= 0
            && Math.hypot(bx - anchor.x, bz - anchor.z) < SOUND_R
            && seabed(bx, bz) < DEEP_FLOOR) {
            setPhase('sound');
          }

          // The idle breach in the middle distance — ref/05's establishing shot.
          // The far pod animals are allowed a longer leash than the primary: a
          // breach is legible at any range and an eruption on the horizon is
          // precisely what an empty deep was missing.
          if (breachCooldown <= 0) {
            const d = Math.hypot(position.x - bx, position.z - bz);
            const near = isPrimary ? 80 : 90;
            const far = isPrimary ? 300 : 380;
            if (d > near && d < far && airborne === 0 && breachLock <= 0) {
              _dir.set(bx - position.x, 0, bz - position.z).normalize();
              beginBreach(position.x + _dir.x * 34, position.z + _dir.z * 34);
            } else {
              breachCooldown = 12;
            }
          }
        } else if (phase === 'sound') {
          // Up to 8.5 m over fourteen seconds, hold twenty, sink back over
          // twelve. And aim ACROSS the bow — `boat + right*60 + forward*30`,
          // flipping sides each time it gets there — rather than straight down
          // the centreline, where the hull the framing keeps low-centre is
          // exactly what it hides behind.
          const cruiseY = (spec.d0 + spec.d1) * 0.5;
          let depthWant = SOUND_Y;
          if (phaseT < SOUND_RISE) {
            depthWant = cruiseY + (SOUND_Y - cruiseY) * (phaseT / SOUND_RISE);
          } else if (phaseT > SOUND_RISE + SOUND_HOLD) {
            const f = clamp((phaseT - SOUND_RISE - SOUND_HOLD) / SOUND_FALL, 0, 1);
            depthWant = SOUND_Y + (cruiseY - SOUND_Y) * f;
          }
          const rx = boat ? boat.right.x : 1;
          const rz = boat ? boat.right.z : 0;
          const fx = boat ? boat.forward.x : 0;
          const fz = boat ? boat.forward.z : -1;
          _tgt.set(
            bx + rx * SOUND_ABEAM * soundSide + fx * SOUND_AHEAD, 0,
            bz + rz * SOUND_ABEAM * soundSide + fz * SOUND_AHEAD,
          );
          pushDeep(_tgt, minFloor);
          if (Math.hypot(position.x - _tgt.x, position.z - _tgt.z) < 45) soundSide = -soundSide;
          const lim = floorLimit(_tgt.x, _tgt.z);
          steerTo(_tgt.x, Math.min(-7.0 * scale, Math.max(-depthWant, lim)), _tgt.z, 5.6, dt);
          speed = velocity.length();

          // A shallow animal moving fast drags the surface with it. Same stamp
          // the primary's approach uses.
          if (water && water.disturb && position.y > -13 && stampT > 0.22
            && Math.hypot(position.x - bx, position.z - bz) < 70) {
            stampT = 0;
            water.disturb(position.x, position.z, 0.55, 7.0);
          }

          // Bail out if the player drives off the deep, or the whole pass is
          // over: either way it goes back down and will not do it again for a
          // minute and a half.
          if (seabed(bx, bz) > DEEP_FLOOR) { soundLock = 30; setPhase('dive'); }
          else if (phaseT > SOUND_RISE + SOUND_HOLD + SOUND_FALL) {
            soundLock = SOUND_LOCK;
            setPhase('dive');
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
          // COME ALONGSIDE, and stop there. Aiming at a point BEYOND the boat
          // — even one offset to the side — still draws her line straight
          // across the hull, and because the target moves with the boat she
          // then hovers on it: measured at 2 m for thirty seconds, which is
          // exactly the "stays under my boat" the player reported. The target
          // is now abeam at a fixed standoff, so the line she swims ends
          // beside the player rather than through him.
          _tgt.set(bx - _dir.z * APPROACH_ABEAM, 0, bz + _dir.x * APPROACH_ABEAM);
          pushDeep(_tgt, minFloor);
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
            // Break water 26 m past the boat and land 12 m further on, i.e. 38 m
            // from the player and comfortably inside both the camera and the
            // 62 m wake window. With the old run of 46 this landed at 72 m,
            // measured live, which is why the climactic breach was silent.
            //
            // NOT gated on the breach token: this is the quest's beat, the
            // primary has its own splash rig, and it must never be swallowed
            // because something two hundred metres away happened to be in the
            // air.
            beginBreach(bx + _dir.x * 26 + jx * j, bz + _dir.z * 26 + jz * j, 12);
          }
        } else if (phase === 'hooked') {
          // On the line. The animal picks a fresh idea every few seconds:
          // mostly a hard run away from the boat, sometimes a cut across its
          // stern — which is the sideways yank that heels the hull — and it
          // stops choosing the deep sprint as it tires. All the actual rope
          // physics live in the harpoon module; what arrives here is just an
          // acceleration, applied after the steering so a hard pull visibly
          // bends the path the animal wanted.
          hookRetarget -= dt;
          lungeT -= dt;
          if (hookRetarget <= 0) {
            hookRetarget = 2.6 + rng.range(0, 2.8);
            _dir.set(position.x - bx, 0, position.z - bz);
            if (_dir.lengthSq() < 1) _dir.copy(velocity).setY(0);
            if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
            _dir.normalize();
            if (strain < 0.7 && rng.chance(0.32) && boat) {
              const side = rng.chance(0.5) ? 1 : -1;
              hookTarget.set(
                bx + boat.right.x * 95 * side - _dir.x * 20, 0,
                bz + boat.right.z * 95 * side - _dir.z * 20,
              );
            } else {
              hookTarget.set(position.x + _dir.x * 130, 0, position.z + _dir.z * 130);
            }
            pushDeep(hookTarget, minFloor);
            lungeT = rng.chance(0.45) ? 1.7 : 0;
          }
          // Tired is slow, and tired gives up the deep: at full strain she
          // wallows near the surface, which is both the read (you can SEE that
          // you are winning) and the win condition's setup.
          const tired = 1 - 0.62 * strain;
          const want = (lungeT > 0 ? 9.5 : 6.4) * tired;
          const deepWant = -16 * scale + (strain * strain) * 10 * scale;
          const lim2 = floorLimit(hookTarget.x, hookTarget.z);
          steerTo(hookTarget.x, Math.min(-5.5 * scale, Math.max(deepWant, lim2)),
            hookTarget.z, want, dt);
          velocity.addScaledVector(towAcc, dt);
          towAcc.set(0, 0, 0);
          speed = velocity.length();

          // A tethered animal near the surface churns it.
          if (water && water.disturb && position.y > -12 * scale && stampT > 0.18) {
            stampT = 0;
            water.disturb(position.x, position.z, 0.85, 8.0);
          }
        } else if (phase === 'spent') {
          // Beaten fair. She stays up for a long moment, rolling in her own
          // wash, before the deep takes her back — the win the player just
          // fought a minute for is a SIGHT, not a toast message.
          _dir.copy(velocity).setY(0);
          if (_dir.lengthSq() < 1) _dir.set(0, 0, -1);
          _dir.normalize();
          const limS = floorLimit(position.x, position.z);
          steerTo(position.x + _dir.x * 40, Math.max(-5.5 * scale, limS),
            position.z + _dir.z * 40, 2.2, dt);
          speed = velocity.length();
          if (water && water.disturb && stampT > 0.25
            && Math.hypot(position.x - bx, position.z - bz) < 70) {
            stampT = 0;
            water.disturb(position.x, position.z, 0.7, 8.5);
          }
          if (phaseT > 9) setPhase('dive');
        } else {
          // dive — sink away, slow down, then fold back into the circuit.
          const lim = floorLimit(position.x, position.z);
          const depthWant = Math.min(-14 * scale, Math.max(-25 * scale, lim));
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
        if (Number.isFinite(floorHere) && floorHere > minFloor) {
          const r = Math.hypot(position.x, position.z) || 1;
          const urgency = clamp((floorHere - minFloor) / 6, 0, 1);
          desired.set(position.x / r * 6.5, -1.4, position.z / r * 6.5);
          velocity.lerp(desired, Math.min(1, dt * (0.9 + 3.6 * urgency)));
        }

        position.addScaledVector(velocity, dt);
        // Floor first, ceiling last: if the water is too thin for both, the
        // ceiling wins. A dark shape clipping a reef head for a couple of seconds
        // is invisible; a leviathan standing in the shallows is not.
        const lim = floorLimit(position.x, position.z);
        if (position.y < lim) { position.y = lim; if (velocity.y < 0) velocity.y *= 0.2; }
        if (position.y > ceiling) { position.y = ceiling; if (velocity.y > 0) velocity.y *= 0.2; }
        lastY = position.y;
      }

      orient(dt);
      body.position.copy(position);

      // ---- exported state ------------------------------------------------
      state.heading = Math.atan2(velocity.x, -velocity.z);
      state.depth = Math.max(0, -position.y);
      state.distance = Math.hypot(position.x - bx, position.z - bz);
      // 0 while it is anywhere near its cruising ceiling, 1 once the head and
      // shoulders are clear — the HUD reads this to decide it has been sighted.
      state.surfaced = clamp((position.y + 2.0) / 8.0, 0, 1);
      state.phase = phase;

      return position.y;
    }

    // Prime the exported state so the HUD and the quest have sane numbers on the
    // very first frame, before update() has ever run.
    body.position.copy(position);
    state.heading = Math.atan2(velocity.x, -velocity.z);

    return {
      state,
      anchor,
      update,
      get speed() { return speed; },
      get phase() { return phase; },
      get velocity() { return velocity; },   // live reference; read, never write
      get scale() { return scale; },
      get hooked() { return hooked; },
      hook() {
        // No hooking an airborne animal: the rope would pin a Bezier.
        if (phase === 'breach') return false;
        hooked = true;
        strain = 0;
        hookRetarget = 0;
        state.alerted = true;
        setPhase('hooked');
        return true;
      },
      unhook(spent) {
        if (!hooked) return;
        hooked = false;
        towAcc.set(0, 0, 0);
        // Short lockouts. The first cut of this used 45 s and a 30 s breach
        // floor, and the felt result was reported in three words: "I don't
        // see any more leviathans" — every fight ended with the animal a
        // hundred metres away, deep, and refusing to come back for most of a
        // minute. A fight should END with a leviathan in view.
        approachLock = 18;
        breachCooldown = Math.max(breachCooldown, 14);
        setPhase(spent ? 'spent' : 'dive');
      },
      towPull(x, y, z) { if (hooked) towAcc.set(x, y, z); },
      setStrain(s) { strain = clamp(s, 0, 1); },
      alert() { state.alerted = true; approachLock = 0; if (phase === 'cruise') setPhase('approach'); },
      calm() { state.alerted = false; if (phase === 'approach') setPhase('dive'); },
      forceBreach(x, z) {
        // A breach is a Bezier that owns the position outright; starting one
        // under a live tether would pin the rope to a flight path the tug
        // physics cannot touch. The line has to come off first.
        if (hooked) return;
        if (phase === 'breach') return;
        if (typeof x === 'number' && typeof z === 'number') { beginBreach(x, z); return; }
        _dir.copy(velocity).setY(0);
        if (_dir.lengthSq() < 1) _dir.set(0, 0, -1);
        _dir.normalize();
        beginBreach(position.x + _dir.x * 34, position.z + _dir.z * 34);
      },
    };
  }

  // ---- build the pod ------------------------------------------------------
  // Every animal exists and is drawn from boot. Nothing is ever created,
  // revealed, hidden or LOD-swapped later — constraint 4, and the reason a
  // distant animal is a full-detail body rather than a cheap one.

  const pod = [];
  for (let i = 0; i < podCount; i++) pod.push(makeAnimal(i, POD[i]));
  const primary = pod[0];
  // The SAME object, never a copy: quest.js:67-73/147, hud.js:311-313 and
  // wildlife.js:1170-1173 all hold `monster.state` and `state.position` by
  // reference across frames.
  const state = primary.state;

  setLayers(group, LAYER.MAIN, LAYER.UNDERWATER, LAYER.REFLECTED);
  // Submerged almost always, so without a waterline clip its mirror image
  // lands above the reflected horizon and smears across open water.
  applyWaterClip(group);

  disturbGroup.position.copy(disturbPos);
  group.add(disturbGroup);
  group.add(splashA.group);
  group.add(splashB.group);
  setLayers(patch, LAYER.MAIN);
  setLayers(bubbles, LAYER.MAIN, LAYER.UNDERWATER);

  // ---- the frame ---------------------------------------------------------

  let wet = 0;
  let disturbStampT = 0;

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

    breachLock -= dt;
    disturbStampT += dt;

    const dxq = bx - DISTURB_X, dzq = bz - DISTURB_Z;
    const atDisturbance = (dxq * dxq + dzq * dzq) < 48 * 48;

    // SEQUENTIALLY. The nineteen module-scope scratch vectors are transient
    // inside one call, which is exactly what makes N animals safe here and what
    // would break the moment anything interleaved them.
    let topY = -1e3;
    for (let i = 0; i < pod.length; i++) {
      const y = pod[i].update(ctx, atDisturbance);
      if (y > topY) topY = y;
    }

    // Wetness. Snaps on the moment ANY animal is out of the water (the ramp is
    // ~0.15 s) and runs off over a couple of seconds after it is under again,
    // which is the timescale the sheets in ref/05 imply. One uniform for the
    // whole pod, which is honest because the breach token lets only one of them
    // be airborne — and the collar is masked by world height anyway, so a
    // submerged animal at -19 m gets nothing from it either way.
    const dry = topY < -2.2;
    wet += ((dry ? 0 : 1) - wet) * Math.min(1, dt * (dry ? 0.75 : 8.0));
    uni.uWet.value = wet;

    splashA.update(ctx);
    splashB.update(ctx);

    // The tail beats harder the faster it swims; the fins keep their own, much
    // longer cycle so the two never lock into one rhythm. These are ONE
    // material's uniforms, so they are driven by the primary — the per-animal
    // `aLev` rate scale is what stops the pod beating in lockstep.
    const sp = clamp(primary.speed, 0, 12);
    uni.uSwimRate.value = 0.42 + sp * 0.115;
    uni.uSwimAmp.value = 1.15 + sp * 0.075;
    uni.uFinRate.value = 0.28 + sp * 0.030;

    // Keep the disturbance boiling when the boat is close enough for the ripple
    // sim to see it at all.
    if (water && water.disturb && atDisturbance && disturbStampT > 0.30) {
      disturbStampT = 0;
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

    // The collar takes the palette's own foam, dimmed a little: it is an
    // ADDITIVE term on top of a body that is deliberately darker than the water,
    // so full-strength foamTint here blows the silhouette out into a white blob.
    // dayFactor for the same reason splash.js folds it in: this is an ADDITIVE
    // term on a body deliberately darker than the water, and at night the sea is
    // at 0.1 linear while foamTint is still at 0.5 — leave the day gain on and
    // the wetted pectoral comes back as a white card floating in the dark.
    _c.copy(env.foamTint)
      .multiplyScalar((0.22 + 0.30 * env.foamBrightness) * (0.35 + 0.65 * env.dayFactor));
    uni.uWetCol.value.copy(_c);
    splashA.applyEnv(env);
    splashB.applyEnv(env);

    _c.copy(env.foamTint).lerp(env.waterShallow, 0.35);
    bubMat.color.copy(_c);
    bubMat.emissive.copy(env.waterScatter).multiplyScalar(0.10 + 0.20 * env.nightFactor);
    bubMat.opacity = 0.34 + 0.28 * env.dayFactor;
  }

  function dispose() {
    for (let i = 0; i < podGeos.length; i++) podGeos[i].dispose();
    geoTemplate.dispose();
    mat.dispose();
    eyeGeo.dispose();
    eyeMat.dispose();
    patchGeo.dispose();
    patchMat.dispose();
    bubbleGeo.dispose();
    bubMat.dispose();
    bubbles.dispose();
    splashA.dispose();
    splashB.dispose();
    group.clear();
  }

  return {
    group,
    state,
    update,
    applyEnv,
    dispose,

    /** Where the quest sends the player. Read-only for everyone else. */
    disturbance: { position: disturbPos, radius: DISTURB_R },
    disturbancePosition: disturbPos,

    /**
     * The whole pod, read-only, `pod[0]` being the animal `state` aliases. This
     * is ADDITIVE — nothing that existed changed shape — and it is here so that
     * wildlife.js can one day flee all of them instead of only the primary,
     * which is the one thing this change leaves on the table.
     */
    pod,
    primary,

    /** Let the quest drive the encounter explicitly if it would rather. */
    alert() { primary.alert(); },
    calm() { primary.calm(); },

    /**
     * The harpoon line's half of the tug-of-war, always the PRIMARY — the
     * animal that shadows the player. The harpoon module owns the rope and
     * every number here; the animal owns its own behaviour on the line
     * (see the 'hooked' phase).
     */
    hook: {
      engage() { return primary.hook(); },
      release() { primary.unhook(); },
      pull(x, y, z) { primary.towPull(x, y, z); },
      strain(s) { primary.setStrain(s); },
      get active() { return primary.hooked; },
      get velocity() { return primary.velocity; },
      get scale() { return primary.scale; },
    },

    /**
     * Force a breach at a surface point, or straight ahead if none is given.
     * THE PRIMARY, always: this is the quest's climax and the capture harness's
     * entry point, and it has its own splash rig so it can never be blocked.
     */
    breach(x, z) { primary.forceBreach(x, z); },
  };
}
