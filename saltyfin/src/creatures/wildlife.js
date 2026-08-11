// Everything alive that is not the leviathan.
//
// Three things, and each one is here because the concept art has it:
//
//   * **Fish.** ref/01 is clear water over a reef; clear water reads as clear
//     only when something is moving down there. Six species — bait, damsel,
//     snapper, parrot, grouper, eagle ray — sharing ONE material and ONE
//     attribute layout, one InstancedMesh per species, on LAYER.MAIN +
//     LAYER.UNDERWATER so the refraction pass carries them.
//   * **Seagulls.** ref/01 has them wheeling over the harbour at three
//     different heights — they are most of what sells the scale of the village.
//     One InstancedMesh, lazy orbits, LAYER.MAIN + LAYER.REFLECTED, faded out
//     with `env.dayFactor`.
//   * **A jumping fish**, now and then, in the mid-distance: out of the water,
//     an arc, and back in, stamping the ripple sim on the way out and the way
//     back.
//   * **Skitter** — a surface baitfish that scatters off the bow. See the block
//     above `SPECIES` and `startle` below. It is the only species here that is
//     designed for the CHASE CAMERA rather than for the water: everything about
//     it is sized against 848.1/d pixels per metre from an eye 12.5 m astern at
//     5 m (chaseCamera.js:12), where the nearest water on screen is 8.8 m away
//     and a 0.34 m fish can never be more than 33 px. So the thing that has to
//     be big is the EVENT and not the animal.
//
// Determinism note (CONTRACT.md: "All randomness goes through core/rng.js with
// an explicit seed, so the world is identical between runs"). The skitter
// shoals RECYCLE: a shoal that ends up more than `recycle.far` metres from the
// boat is re-vetted ahead of it (see `findSpotNear`). Every draw still comes
// from the seeded stream, so a fixed drive path is reproducible frame for
// frame — but two DIFFERENT drive paths put the shoals in different places, and
// a screenshot taken after driving is only comparable to one taken after the
// same drive. Captures that use `--boat` to teleport stay deterministic,
// because the recycler only fires on a shoal that is genuinely `far` away.
//
// What changed, and why
// ---------------------
// This file used to say "the flocking is deliberately cheap. A school is one
// Object3D following a wandering Lissajous; the instances hold fixed offsets
// inside it and the per-fish swim wiggle and jostle happen in the vertex shader
// off a hash of the instance's own offset."
//
// The second half of that was never true on this branch. The wiggle lived in an
// `onBeforeCompile` injection, and `onBeforeCompile` does not exist in
// three.webgpu.min.js — the string appears zero times in it, and a runtime spy
// on the school material was never called after a forced rebuild. So the fish
// were a perfectly rigid lattice of ~30 identical charcoal slivers being flown
// around the bay in formation, with nothing hiding it. A capture from the boat
// at (-1, 76) confirmed it: parallel dashes 3-8 body lengths apart, reading as
// debris. From the overhead camera they were not visible at all.
//
// So the trade the old comment describes was being paid for and nothing was
// coming back. Now:
//
//   * Per-fish state lives on the CPU (six Float32Arrays per species) and the
//     boids run there, because the CPU also needs the positions for the flee
//     response and the terrain plane, and because a compute path would exist on
//     the WebGPU backend and not on the WebGL backend of the same renderer —
//     one branch, two behaviours, ruled out.
//   * The vertex stage is TSL (`positionNode`), the way monster.js:648 does the
//     bubbles. It carries ONLY the swim bend, driven by a per-instance phase
//     accumulator so the beat rate can rise with speed without any uniform
//     moving.
//   * Terrain is sampled per SCHOOL, never per fish. `seabedHeight` costs
//     1.82 us a call (measured, 100k calls); one per fish at 470 fish would be
//     0.86 ms/frame, six times the cost of everything else in this file
//     combined. Two calls per school per frame is 0.055 ms.
//
// Measured cost of the whole module at quality=high, 470 fish: see the note
// above `updateFish`.

import * as THREE from 'three';
import {
  Fn, attribute, uniform, positionLocal, positionGeometry, vec2, vec3, float,
  sin, fract, floor, length, mix, smoothstep as tslSmoothstep,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng, clamp, hash3 } from '../core/rng.js';

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
const _sw = new THREE.Vector3();
const _IDENT = new THREE.Matrix4();

// --- the mesher -------------------------------------------------------------
// position / normal / colour / aSwim, non-indexed. Same shape as the boat's and
// the leviathan's: everything a creature is made of ends up in one buffer.
//
// `aSwim` is (station 0..1 along the body, lateral participation, vertical
// participation). It is baked NORMALISED so one material serves a 0.16 m
// sardine and a 1.9 m ray without a per-species constant in the node graph —
// folding a per-species number into the graph would give each species its own
// WGSL module and its own pipeline, which is hard constraint 3.

function Mesher() { this.pos = []; this.nor = []; this.col = []; this.swm = []; this.anySwim = false; }

Mesher.prototype.add = function add(geo, matrix, colorFn, swimFn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const pa = g.attributes.position.array;
  const na = g.attributes.normal.array;
  const count = g.attributes.position.count;
  _m3.getNormalMatrix(matrix || _IDENT);
  if (swimFn) this.anySwim = true;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    _v.set(pa[o], pa[o + 1], pa[o + 2]);
    colorFn(_v.x, _v.y, _v.z, _c2);
    if (swimFn) swimFn(_v.x, _v.y, _v.z, _sw); else _sw.set(0, 0, 0);
    if (matrix) _v.applyMatrix4(matrix);
    this.pos.push(_v.x, _v.y, _v.z);
    _n.set(na[o], na[o + 1], na[o + 2]).applyMatrix3(_m3);
    if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
    this.nor.push(_n.x, _n.y, _n.z);
    this.col.push(_c2.r, _c2.g, _c2.b);
    this.swm.push(_sw.x, _sw.y, _sw.z);
  }
  if (g !== geo) g.dispose();
  return this;
};

Mesher.prototype.build = function build() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
  if (this.anySwim) {
    geo.setAttribute('aSwim', new THREE.BufferAttribute(new Float32Array(this.swm), 3));
  }
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
 * dorsal), false spreads in x (a pectoral, or a bird's tail).
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

// ============================================================ the fish ======
//
// One builder, three body profiles, six species.
//
// The profiles are NORMALISED — w and h in 0..1, y as a fraction of length — so
// `girth`, `depth` and `length` are pure per-species data and one table serves
// several species. PROF_SLIM is the old FISH_PROF divided through by its own
// maxima (0.042 half-width, 0.062 half-height, 0.30 length), which is why the
// snapper below still comes out at exactly 160 triangles: a before/after capture
// of that species is comparable.

// Peak girth at t≈0.36, long tail stock. Herring, snapper.
const PROF_SLIM = [
  [0.00, 0.143, 0.145, 0.0000],
  [0.08, 0.619, 0.581, 0.0133],
  [0.20, 0.952, 0.935, 0.0167],
  [0.36, 1.000, 1.000, 0.0067],
  [0.55, 0.762, 0.774, -0.0067],
  [0.72, 0.476, 0.500, -0.0133],
  [0.86, 0.262, 0.306, -0.0167],
  [1.00, 0.119, 0.177, -0.0167],
];

// Peak at t≈0.38, blunt nose, tall belly. Damsel, parrot, grouper.
const PROF_DEEP = [
  [0.00, 0.220, 0.260, 0.0000],
  [0.10, 0.720, 0.720, 0.0100],
  [0.24, 0.950, 0.940, 0.0140],
  [0.38, 1.000, 1.000, 0.0080],
  [0.55, 0.820, 0.830, -0.0040],
  [0.72, 0.520, 0.550, -0.0120],
  [0.88, 0.240, 0.300, -0.0160],
  [1.00, 0.100, 0.160, -0.0160],
];

// Wide and shallow, tapering to a whip. The ray's disc is the wings; this is
// only the thickened spine they hang off.
const PROF_FLAT = [
  [0.00, 0.180, 0.400, 0.0000],
  [0.12, 0.620, 0.860, 0.0060],
  [0.26, 0.920, 1.000, 0.0060],
  [0.40, 1.000, 0.960, 0.0020],
  [0.58, 0.720, 0.700, -0.0020],
  [0.76, 0.340, 0.380, -0.0060],
  [0.90, 0.140, 0.180, -0.0080],
  [1.00, 0.060, 0.090, -0.0080],
];

/**
 * Resample a normalised profile onto `stations` evenly spaced t. Station count
 * is a budget lever — a 6-station sardine is 68 triangles where the old uniform
 * body was 160 — so the tables cannot hard-code it.
 */
function resample(prof, stations) {
  const rows = [];
  const last = prof.length - 1;
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    let k = 0;
    while (k < last - 1 && prof[k + 1][0] < t) k++;
    const a = prof[k], b = prof[k + 1];
    const f = clamp((t - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
    rows.push([
      t,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
      a[3] + (b[3] - a[3]) * f,
    ]);
  }
  return rows;
}

// The ray's wing, in metres against a half-span of 1. Swept: the leading edge
// walks aft as the span grows, which is the whole silhouette from above.
const RAY_WING = [
  [0.00, -0.360, 0.360, 0.000, 0.075],
  [0.30, -0.320, 0.320, 0.012, 0.046],
  [0.60, -0.190, 0.270, 0.020, 0.026],
  [0.84, -0.020, 0.210, 0.026, 0.013],
  [1.00, 0.130, 0.185, 0.030, 0.005],
];

/**
 * Six species. Sizes are nose-to-tail-tip in metres. Everything a species
 * differs by is here; nothing below this table branches on a species name.
 *
 * `band`/`bandMode` is where the species lives: 'surface' counts metres down
 * from y=0, 'floor' counts metres up from the seabed. `water` is the depth
 * window `findSpot` will accept for the school's home.
 *
 * The palettes are VALUE first and hue second, in that order, but they are not
 * value ONLY — that was the previous rule and it produced six greys, khakis and
 * a mint that read from the boat as drifting silt. Every fish here still has a
 * dark back, because the water above 4 m is bright and a pale fish disappears
 * into it; the flanks, belly and fins are then free to carry real saturation,
 * and those are the surfaces a fish turns toward you as it banks. Extinction
 * does flatten hue with depth, which is an argument for putting the loud species
 * shallow rather than for painting them grey: the parrotfish and the damsels
 * live in the top six metres where the colour survives, and the ray — dark blue,
 * unmistakable in silhouette — is the one that works at depth.
 */
const SPECIES = [
  {
    // 0.16 m is the honest size for a bait fish and it was unreadable: at 11 m
    // through the water a 0.16 m body is 12 px by 2 px in a 900x640 frame, and a
    // silver one at that. 0.32 m is still less than two-thirds of the snapper
    // and it is the difference between a school you can see and one you cannot.
    // (This comment said "0.22" for one build after the size bump landed in the
    // data and not in the prose. 0.22 x 1.45 = 0.319.)
    //
    // The school COUNT came down from 7x60 to 4x40 when `skitter` arrived. Those
    // seven shoals sat at x 52..131, 60+ m from the boat's spawn, and a 4x crop
    // of the chase frame showed them as fine dark pepper — 420 sardines were
    // paying 33,600 triangles for something nobody could see. The species keeps
    // its 0.8-2.4 m mid-water band because that IS legible from the ref/04
    // overhead framing; it is only the population that was speculative.
    key: 'sardine', prof: PROF_SLIM, len: 0.32, sizeJit: [0.85, 1.22],
    girth: 0.055, depth: 0.115, stations: 6, radial: [5, 6],
    caudal: [0.18, 0.30, 0.28], dorsal: 0.11, anal: 0, pect: false,
    // Dark-backed, silver-bellied. The first pass used a pale silver back and it
    // vanished into bright shallow water — value, not hue, is the only channel
    // that survives, and up here the background is BRIGHT, so the fish has to be
    // the dark thing. Compare the old build's charcoal slivers: too sparse to
    // read as a school, but never invisible.
    pal: { back: 0x14344B, mid: 0x8FC7D8, belly: 0xFFF6E2, fin: 0xFFC24A },
    marks: null,
    tint: { h: [0.50, 0.60], s: [0.04, 0.14], l: [0.54, 0.78] },
    social: 'ball', schools: [2, 4], per: [20, 40], roam: 1.0, ceil: -0.85,
    bandMode: 'surface', band: [0.8, 2.4], water: [3.0, 14.0], clear: 1.1,
    beat: [9.0, 11.5], amp: 0.13,
  },
  {
    // ---- the skitter --------------------------------------------------------
    // A hardyhead/whitebait shoal, and the only species in this file aimed at
    // the driving seat instead of at the water.
    //
    // Why it exists. The chase camera sits 12.5 m behind the boat at 5 m
    // (chaseCamera.js:12) on an axis 11.3 deg down. That puts the nearest water
    // on screen 8.8 m from the eye, so at 848.1/d px per metre a 0.34 m fish
    // tops out at 33 px and is 22 px where it actually matters (13 m, abeam the
    // hull). An INDIVIDUAL fish can never read at this camera; measured, on the
    // best case the old design could offer — 0.62 m parrotfish at 18.7 m, 26 px,
    // spread across 750 px of unoccluded frame, in 2.5 m of clear water — I
    // could not pick out one animal at 1:1. So this species is built so that
    // what reads is the EVENT: a 1.9 m ballistic arc is 124 px, an expanding
    // ripple ring is ~100 px, and a shoal splitting into two arms 6 m apart
    // sweeps 450 px of screen in a second. Five to twenty times the animal.
    //
    // Cheapest fish in the file: 2*radial*stations + 4 = 54 tris at budget 1.0,
    // 44 at the floor, against the sardine's 80. `dorsal: 0` because at 11-20
    // deg of depression you never see one edge-on and a dorsal is the one
    // surface that would poke through a wave as a stray sliver.
    key: 'skitter', prof: PROF_SLIM, len: 0.34, sizeJit: [0.80, 1.15],
    girth: 0.050, depth: 0.130, stations: 5, radial: [4, 5],
    caudal: [0.20, 0.26, 0.24], dorsal: 0, anal: 0, pect: false,
    // The palette is the second half of the fix and it is INVERTED against the
    // rule at the top of this block. "The fish has to be the dark thing" holds
    // when a fish is silhouetted against a bright water column from below. At
    // this camera the background behind a fish a metre under the surface is the
    // REEF, which seabed.js:130-131 paints 0x849070 / 0xA08A63 broken by dark
    // worley patches — the same value as the sardine's 0x14344B back. Dark on
    // dark has no contrast boundary at any size. So: olive-black back, which
    // reads as shadow-on-water rather than as a navy chip on a navy reef, and a
    // near-white flank, which is what you see when the fish banks and when it
    // leaves the water. Near-field water in a day frame tops out around 0.80-
    // 0.85 of white, so the flank has to clear that; `bright` below carries it
    // the rest of the way.
    pal: { back: 0x2A4A3E, mid: 0xE8F0F2, belly: 0xFFFFFF, fin: 0xCFE4EC },
    // No markings. A stripe on a 22 px fish is 2 px, i.e. noise.
    marks: null,
    tint: { h: [0.48, 0.56], s: [0.02, 0.07], l: [0.80, 0.92] },
    // Baked into the vertex colour buffer at build (buildCreature's `bright`),
    // which is a geometry attribute and touches no material property — hard
    // constraint 1 — and needs no light, which is hard constraint 2. The jumper
    // already uses the same door at 1.25.
    bright: 1.30,
    // `roam` is deliberately the lowest of any schooling species here. The
    // recycler vets a spot on the boat's track and the whole encounter rate
    // depends on the shoal still being there when the bow arrives 10-15 s
    // later; at the sardine's roam of 1.0 the anchor wanders up to 37 m, which
    // is four times the corridor's half-width and would throw most of the
    // interceptions away. 0.45 holds it inside ~12 m — and a baitfish shoal
    // working one patch of flat is what it should be doing anyway.
    social: 'skitter', schools: [4, 8], per: [16, 34], roam: 0.45, ceil: -0.28,
    // 'ride' = the band FOLLOWS the water surface. See RIDE_MARGIN.
    bandMode: 'ride', band: [0.28, 0.66], water: [1.6, 6.5], clear: 0.8,
    // Base beat is deliberately below the 12-15 Hz a real baitfish tail runs at:
    // the rate multiplier in the beat accumulator reaches 2.0 at a burst, and
    // 12 x 2.0 = 24 Hz is already close to what 60 fps can carry without the
    // tail strobing backwards.
    beat: [9.0, 12.0], amp: 0.15,
    reflected: true,     // see the LAYER note where the meshes are built
    // The scatter. Everything here is metres, seconds and m/s^2; the reasoning
    // is at `startleBlock` in updateFish.
    startle: {
      lead: [2.3, 1.15],   // corridor length = lead[0] + lead[1] * |speed|
      half: 3.2,           // corridor half-width
      decay: 0.55,         // seconds; impulse e-folding
      imp: 26.0,           // m/s^2 at startle = 1
      side: 0.86, ahead: 0.28, up: 0.42,
      // Fraction that leaves the water. The spec for this species said 0.30 and
      // "all of them is popcorn", which is right — but a capture settled the
      // other end of it. At 900x640 a SUBMERGED bolter 20 m from the eye is a
      // 2-3 px pale sliver and I could not find one at 1:1 in a frame where the
      // probe put 34 of them across 700 px of screen. The intact shoal reads
      // (dense dark stipple, unmistakably not reef mottle) and the AIRBORNE
      // fish read (13-15 px, near-white, against surface water), and nothing in
      // between does. So the shower carries the whole event and 0.30 was too
      // thin: 0.36 puts 12 of 34 up at once, which in the capture is a spray
      // and still not popcorn.
      jumpP: 0.36,
      jumpV: [3.90, 0.50], // m/s up, from the band — not from the surface
      jumpRun: [3.1, 1.0], // m/s along the escape, so the arc is 1.7-2.1 m
      minSpeed: 1.6,       // boat m/s below which nothing jumps
      // The shower is a SECOND, closer trigger than the bolt — 0.55 s of
      // warning against the bolt's 1.15 — and it is wider, because by then the
      // fish it is testing have already bolted 2-3 m off the centreline. See
      // the jump block in updateFish for the measurement that forced this.
      // 5.2 m, not 4.6: a 26 s soak driving straight through the flats at
      // 6.7 m/s never once got the nearest fish inside 6.2 m, because a shoal
      // the recycler puts on the track still usually passes a few metres to one
      // side. At 4.6 that whole run produced no shower at all. 5.2 m from a
      // 1.9 m beam is still unambiguously the boat's doing, and it turns the
      // common near-miss into an event instead of nothing.
      jumpLead: [1.2, 0.55], jumpHalf: 5.2,
    },
    // Recycling, so the encounter rate does not depend on where findSpot
    // happened to put eight shoals at boot.
    // far: a shoal this far astern is worth nothing — 0.34 m at 95 m is 3.0 px
    // through ~78% reflective water — so it is the one to move. near: where it
    // is put, far enough that it fades up over the 10-18 s it takes to drive
    // there rather than popping in. cone: half-angle around the heading.
    recycle: { far: 95, near: [50, 88], cone: 1.22 },
  },
  {
    key: 'damsel', prof: PROF_DEEP, len: 0.24, sizeJit: [0.84, 1.22],
    girth: 0.085, depth: 0.240, stations: 7, radial: [6, 7],
    caudal: [0.16, 0.24, 0.22], dorsal: 0.15, anal: 0.11, pect: false,
    pal: { back: 0x14224E, mid: 0x2E6BE0, belly: 0xFFE45C, fin: 0x2E6BE0 },
    marks: { kind: 'stripe', u: 0.30, w: 9, color: col(0xF2E5A8), amount: 0.40 },
    tint: { h: [0.12, 0.16], s: [0.10, 0.34], l: [0.60, 0.84] },
    social: 'cloud', schools: [4, 9], per: [10, 24], roam: 0.7, ceil: -1.20,
    bandMode: 'floor', band: [0.8, 2.5], water: [3.0, 7.5], clear: 0.7,
    beat: [7.5, 9.5], amp: 0.12,
  },
  {
    key: 'snapper', prof: PROF_SLIM, len: 0.50, sizeJit: [0.80, 1.26],
    girth: 0.140, depth: 0.207, stations: 8, radial: [7, 9],
    caudal: [0.17, 0.173, 0.153], dorsal: 0.14, anal: 0, pect: true,
    pal: { back: 0x7A2410, mid: 0xFF7A2E, belly: 0xFFF0D2, fin: 0xFFB13A },
    marks: { kind: 'stripe', u: 0.60, w: 14, color: col(0xF0E6C8), amount: 0.35 },
    tint: { h: [0.06, 0.14], s: [0.14, 0.38], l: [0.62, 0.86] },
    social: 'school', schools: [4, 8], per: [9, 20], roam: 1.0, ceil: -1.20,
    bandMode: 'surface', band: [1.6, 4.5], water: [3.5, 13.0], clear: 1.0,
    beat: [5.6, 7.4], amp: 0.10,
  },
  {
    key: 'parrot', prof: PROF_DEEP, len: 0.62, sizeJit: [0.81, 1.24],
    girth: 0.115, depth: 0.215, stations: 8, radial: [7, 9],
    caudal: [0.12, 0.22, 0.22], dorsal: 0.13, anal: 0.10, pect: true,
    pal: { back: 0x0E5F4E, mid: 0x2ED08C, belly: 0xFF9A5C, fin: 0xFFD94A },
    marks: { kind: 'bars', n: 4, color: col(0x1C5A55), amount: 0.25 },
    tint: { h: [0.36, 0.46], s: [0.22, 0.46], l: [0.52, 0.76] },
    social: 'gang', schools: [3, 6], per: [4, 8], roam: 0.5, ceil: -1.00,
    bandMode: 'floor', band: [0.5, 2.0], water: [2.5, 5.5], clear: 0.55,
    beat: [3.4, 4.6], amp: 0.075,
  },
  {
    key: 'grouper', prof: PROF_DEEP, len: 1.05, sizeJit: [0.80, 1.30],
    girth: 0.155, depth: 0.235, stations: 9, radial: [8, 10],
    caudal: [0.10, 0.16, 0.16], dorsal: 0.12, anal: 0.09, pect: true,
    pal: { back: 0x5B2B5E, mid: 0xB05CC0, belly: 0xF6D9A8, fin: 0x8A3E8F },
    marks: { kind: 'spots', cell: 0.05, thresh: 0.58, color: col(0x2B2A1E), amount: 0.45 },
    tint: { h: [0.08, 0.13], s: [0.10, 0.26], l: [0.56, 0.78] },
    social: 'solitary', schools: [3, 5], per: [1, 1], roam: 0.35, ceil: -2.60,
    bandMode: 'floor', band: [0.6, 1.6], water: [5.0, 11.0], clear: 0.6,
    beat: [2.2, 3.0], amp: 0.055,
  },
  {
    key: 'ray', prof: PROF_FLAT, len: 1.70, sizeJit: [0.86, 1.16],
    girth: 0.130, depth: 0.055, stations: 6, radial: [6, 8],
    caudal: [0.90, 0.020, 0.020], dorsal: 0, anal: 0, pect: false,
    wing: { span: 0.95, rows: [4, 5] },
    pal: { back: 0x131C3A, mid: 0x3B5C8C, belly: 0xF2F4F0, fin: 0x24365C },
    marks: { kind: 'spots', cell: 0.09, thresh: 0.62, color: col(0xD6DCE0), amount: 0.50 },
    tint: { h: [0.56, 0.62], s: [0.06, 0.18], l: [0.52, 0.68] },
    social: 'ray', schools: [3, 5], per: [1, 1], roam: 0.8, ceil: -2.20,
    bandMode: 'floor', band: [1.2, 3.5], water: [5.0, 16.0], clear: 1.0,
    beat: [0.9, 1.3], amp: 0.16,
  },
];

/**
 * Boids weights, keyed off `spec.social` so the distinction between "these
 * school" and "this one holds station" is data.
 *
 * `k` is how many school-mates each fish samples per frame. The exact
 * neighbourhood solve is not worth it: measured on this container, 400 fish
 * all-pairs is 0.708 ms/frame, per-school locality is 0.143 ms, and a fixed
 * 7-sample ring is 0.020 ms. The stride below walks a different set of
 * school-mates every frame, so over ~7 frames (0.12 s) every fish has seen every
 * neighbour it could plausibly collide with and separation is integrated over
 * time instead of solved exactly. At 60 fps that is indistinguishable and 35x
 * cheaper.
 *
 * `wCoh` pulls toward a blend of the school centroid and the school's anchor —
 * see `COH_ANCHOR`. The solitary rows keep a small `wCoh` even though they have
 * no school, because with none of it a lone grouper has nothing tethering it to
 * the reef it was placed on and walks off across the bay.
 */
const SOCIAL = {
  // The bait ball's spacing is the one number that decides whether a school
  // reads as fish or as a rock. rSep 0.22 against a 0.16 m sardine settled at a
  // 0.144 m mean nearest neighbour and a 1.6 m ball — denser than a real bait
  // ball and, at 14 m through water, an undifferentiated dark pellet. 0.34
  // opens it to ~3 m across, where the individual bodies still resolve.
  ball: { k: 10, rSep: 0.34, wSep: 9.0, wAli: 2.2, wCoh: 0.90, wWander: 0.5, wRate: 0.9, wDepth: 1.6, wFloor: 7.0, vMin: 0.55, vMax: 1.40, drag: 0.9, panic: 2.6 },
  // TIGHTER than the bait ball on purpose, and that is not a contradiction of
  // the note above. Opening the ball to 0.34 was right for a school seen at 14 m
  // through 4 m of water, where the goal is that individuals resolve. Here the
  // shoal is at 12-16 m in clear surface water and the goal is a MASS that then
  // breaks: the tight ball is the "before" and the scatter is the "after".
  // cbrt(34) * 0.26 * 2.1 = 1.77 m across, which at 13 m from the eye projects
  // to ~230 x 110 px carrying 34 fish at 22 x 5 px — 19% coverage, a dark patch.
  // Below ~20 fish that is pepper again; above ~45 the separation term costs
  // real time and it stops looking like more.
  //
  // vMax 1.50 x panic 3.6 = 5.4 m/s, about 16 body lengths/s. Over-scaled like
  // everything else here, and it HAS to beat the boat's top speed or the arms
  // never get clear of the hull. wDepth is nearly double the ball's because a
  // surface shoal that sags out of its band is back to being invisible.
  skitter: { k: 8, rSep: 0.26, wSep: 9.5, wAli: 2.6, wCoh: 1.10, wWander: 0.6, wRate: 1.1, wDepth: 2.4, wFloor: 7.0, vMin: 0.50, vMax: 1.50, drag: 0.9, panic: 3.6 },
  cloud: { k: 6, rSep: 0.45, wSep: 6.0, wAli: 1.0, wCoh: 0.70, wWander: 1.1, wRate: 0.7, wDepth: 1.3, wFloor: 6.0, vMin: 0.20, vMax: 0.80, drag: 0.8, panic: 2.2 },
  // rSep 0.55 over 18 snappers spread them across 3 m and a capture at 11 m read
  // as four or five unrelated fish, not a school. 0.44 with more bodies is what
  // makes the group legible AS a group.
  school: { k: 6, rSep: 0.44, wSep: 6.0, wAli: 1.4, wCoh: 0.55, wWander: 0.9, wRate: 0.6, wDepth: 1.2, wFloor: 6.0, vMin: 0.35, vMax: 1.10, drag: 0.6, panic: 2.2 },
  gang: { k: 5, rSep: 0.90, wSep: 5.0, wAli: 0.6, wCoh: 0.25, wWander: 1.0, wRate: 0.4, wDepth: 1.0, wFloor: 6.5, vMin: 0.15, vMax: 0.55, drag: 0.7, panic: 1.8 },
  solitary: { k: 0, rSep: 0, wSep: 0, wAli: 0, wCoh: 0.12, wWander: 0.8, wRate: 0.15, wDepth: 0.9, wFloor: 6.0, vMin: 0.10, vMax: 0.50, drag: 0.5, panic: 2.0 },
  ray: { k: 0, rSep: 0, wSep: 0, wAli: 0, wCoh: 0.10, wWander: 0.4, wRate: 0.12, wDepth: 0.7, wFloor: 6.0, vMin: 0.60, vMax: 1.60, drag: 0.4, panic: 1.6 },
};

// How much of the cohesion target is the school's wandering anchor rather than
// its own centroid. Pure centroid cohesion holds a school together but lets it
// drift anywhere; pure anchor cohesion makes a rigid ball on a rail — which is
// what this file used to be. 0.35 keeps the school coherent AND on its beat.
const COH_ANCHOR = 0.35;

// The shallowest ANY fish is ever allowed, used for the water-column tests. The
// Gerstner train in water/waves.js reaches -0.456 m in a trough, so anything
// above about -0.6 pokes out of the back of a wave; -0.85 keeps a small fish's
// whole body wet. Each species then has its own `ceil` on top of this: a soak
// found groupers and eagle rays riding up to -0.85 whenever their anchor
// wandered over a reef top, and a 0.85 m grouper at the surface reads as a
// mistake even though nothing was technically broken.
const FISH_CEIL = -0.85;

/**
 * How far under the LOCAL water surface a `bandMode: 'ride'` shoal is kept.
 *
 * FISH_CEIL exists because the wave train troughs to -0.456 m in open water, so
 * a fish pinned at a fixed y anywhere near 0 spends part of every wave cycle in
 * open air at random. The answer for a surface species is not a deeper band —
 * that is what made the sardines invisible — it is to make the band follow the
 * surface, one `ctx.water.sampleHeight` call per SHOAL per frame. That is the
 * same discipline the terrain probe already runs under (`seabedHeight` costs
 * 1.82 us a call, so nothing in this file samples per fish); eight extra calls
 * a frame is ~0.016 ms. It MUST go through `ctx.water.sampleHeight` rather than
 * re-deriving the wave sum, because that function is the CPU half of the shared
 * evaluation in water/waves.js and it carries the `shore` damping.
 *
 * The margin is measured, not guessed. Over the 1.6-6.5 m reef flats this
 * species lives on, sampleHeight troughs to -0.199 m at 2.0 m of depth and
 * -0.508 m at 5.9 m (11 sites, 20 s each). More to the point, the surface
 * height 2 m away from the sample point differs from the sample by up to
 * 0.218 m — a shoal is 1.8 m across, so the fish at its edge is under a surface
 * the shoal centre never saw. 0.26 m of margin keeps that fish ~0.04 m wet at
 * the worst measured case.
 *
 * The species' own `ceil` (-0.28) is then an ABSOLUTE cap on top of that, and
 * it is set by the reflection clip, not by the waves: CLIP.ABOVE keeps
 * worldY >= -0.12 (clip.js SEAM), and a swimming fish that crosses that line
 * gets drawn upside-down into the reflection target in exactly the band where
 * Fresnel has driven the reflection term to ~1. -0.28, plus a 0.06 m swim bend
 * and 0.022 m of half-body, leaves the topmost vertex at about -0.20. Only a
 * JUMPING fish crosses the seam, which is the entire point of the jump.
 */
const RIDE_MARGIN = 0.26;

/** Per-frame ceiling on ripple stamps from this module. See `stampBudget`. */
const STAMP_MAX = 6;
const ARM_MAX = 2;

/** Body colour ramp plus the species' markings. `gH` is the max half-height. */
function creatureColor(spec, gH, x, y, z, out) {
  const P = spec._pal;
  const u = clamp(y / Math.max(1e-4, gH) * 0.5 + 0.5, 0, 1);
  if (u < 0.55) out.copy(P.belly).lerp(P.mid, u / 0.55);
  else out.copy(P.mid).lerp(P.back, (u - 0.55) / 0.45);

  const m = spec.marks;
  if (!m) return out;
  if (m.kind === 'stripe') {
    // One lateral band, the way most reef fish read at distance.
    const b = 1 - Math.min(1, Math.abs(u - m.u) * m.w);
    if (b > 0) out.lerp(m.color, b * m.amount);
  } else if (m.kind === 'bars') {
    // Vertical bars down the flank. sin^6 so they are narrow, not a gradient.
    const s = z / spec.len + 0.5;
    const b = Math.pow(Math.abs(Math.sin(s * Math.PI * m.n)), 6);
    out.lerp(m.color, b * m.amount);
  } else if (m.kind === 'spots') {
    // Mottling. Quantised to a cell so the hash lands on blotches rather than
    // per-vertex speckle, which at 5 m through water is just noise. Mottling is
    // the one marking that still reads at that distance; a stripe does not.
    const h = hash3(Math.floor(x / m.cell), Math.floor(y / m.cell), Math.floor(z / m.cell));
    if (h > m.thresh) out.lerp(m.color, m.amount);
  }
  return out;
}

/**
 * Build one species' geometry. `radial`, the wing row count and whether the
 * pectorals exist all come from the caller's geometry budget, so LOD scales the
 * MESH as well as the population — the tier that could least afford the old
 * uniform 160-triangle body is the one that benefits most from a 68-triangle
 * sardine.
 *
 * Triangles are exactly `2 * radial * stations + 4 * fans` for a lofted body
 * (verified against a probe: predicted 160 for the old fish, measured 160), plus
 * `8 * (rows - 1) + 4` per blade.
 */
function buildCreature(spec, radial, wingRows, withPect, bright) {
  const M = new Mesher();
  const L = spec.len;
  const half = L * 0.5;
  const gW = spec.girth * L;
  const gH = spec.depth * L;
  const isRay = !!spec.wing;

  const rows = resample(spec.prof, spec.stations)
    .map((r) => [r[0], gW * r[1], gH * r[2], L * r[3]]);
  const body = loft(rows, L, radial);

  // Body swim: a travelling sine whose amplitude ramps as s^2 so the head is
  // almost still and the tail stock carries it. The ray's spine barely bends —
  // its motion is the wings.
  const bodyLat = isRay ? 0.18 : 1.0;
  M.add(body, null,
    (x, y, z, out) => creatureColor(spec, gH, x, y, z, out),
    (x, y, z, out) => {
      const s = clamp((z + half) / L, 0, 1);
      out.set(s, (0.08 + 0.92 * s * s) * bodyLat, 0);
    });
  body.dispose();

  const finColor = (x, y, z, out) => out.copy(spec._pal.fin);

  // Caudal. [reach, up, down] as fractions of length; reach is how far past the
  // tail the fork extends.
  const cd = spec.caudal;
  const tail = fan(L * 0.37, L * (0.50 + cd[0]), L * cd[1], L * cd[2], L * 0.033, true);
  M.add(tail, null, finColor, (x, y, z, out) => out.set(1, 1, 0));
  tail.dispose();

  if (spec.dorsal > 0) {
    const dorsal = fan(-L * 0.08, L * 0.23, L * spec.dorsal, 0, L * 0.02, true);
    dorsal.translate(0, gH * 0.80, 0);
    M.add(dorsal, null, finColor, (x, y, z, out) => {
      const s = clamp((z + half) / L, 0, 1);
      out.set(s, 0.08 + 0.92 * s * s, 0);
    });
    dorsal.dispose();
  }

  if (spec.anal > 0) {
    const anal = fan(L * 0.06, L * 0.30, 0, L * spec.anal, L * 0.018, true);
    anal.translate(0, -gH * 0.70, 0);
    M.add(anal, null, finColor, (x, y, z, out) => {
      const s = clamp((z + half) / L, 0, 1);
      out.set(s, 0.08 + 0.92 * s * s, 0);
    });
    anal.dispose();
  }

  if (spec.pect && withPect) {
    // Two little pectorals so the fish is not a bare lozenge in profile. They
    // sit at s≈0.4 and get their own flex so a slow reef grazer, which rows with
    // its pectorals rather than beating its tail, still has something moving.
    const pect = fan(-L * 0.14, L * 0.08, L * 0.10, 0, L * 0.017, false);
    const pectL = mirroredX(pect);
    pect.translate(gW * 0.62, -gH * 0.16, 0);
    pectL.translate(-gW * 0.62, -gH * 0.16, 0);
    const pectSwim = (x, y, z, out) => out.set(0.42, 0.75, 0);
    M.add(pect, null, finColor, pectSwim);
    M.add(pectL, null, finColor, pectSwim);
    pect.dispose(); pectL.dispose();
  }

  if (isRay) {
    // The wings flap in Y, span-weighted — the gull's old GLSL flap, slowed and
    // moved into aSwim.z. A 1.9 m span is the only fish silhouette in this file
    // that is legible from the ref/04 overhead framing.
    const span = spec.wing.span * (spec.len / 1.10);
    const rowsW = wingRows >= RAY_WING.length ? RAY_WING : resampleWing(wingRows);
    const wing = blade(rowsW, span);
    const wingL = mirroredX(wing);
    const wingColor = (x, y, z, out) => creatureColor(spec, gH, x, gH * 0.7, z, out);
    const wingSwim = (x, y, z, out) => {
      const u = clamp(Math.abs(x) / span, 0, 1);
      out.set(0.55, 0, u * u * u);
    };
    M.add(wing, null, wingColor, wingSwim);
    M.add(wingL, null, wingColor, wingSwim);
    wing.dispose(); wingL.dispose();
  }

  const geo = M.build();
  if (bright !== 1) {
    const c = geo.attributes.color.array;
    for (let i = 0; i < c.length; i++) c[i] = Math.min(1, c[i] * bright);
  }
  return geo;
}

/** Drop rows out of the ray's wing table when the budget is tight. */
function resampleWing(n) {
  const out = [];
  const last = RAY_WING.length - 1;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * last;
    const k = Math.min(last - 1, Math.floor(t));
    const f = t - k;
    const a = RAY_WING[k], b = RAY_WING[k + 1];
    out.push([
      a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
      a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f,
    ]);
  }
  return out;
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

// ---------------------------------------------------------------- the module

export function createWildlife(opts = {}) {
  const group = new THREE.Group();
  group.name = 'wildlife';

  const seed = (opts.seed | 0) || 20260807;
  const rng = makeRng((seed ^ 0x5eab1d) >>> 0);
  // See TIERS in core/renderer.js — one budget, no tier-name ladder. An unlisted
  // tier that fell through a name ladder once gave a phone a 333k-triangle
  // seabed; every count in this file goes through lerpI.
  const geo = opts.quality?.geometry ?? 1;
  const budget = Math.min(1, Math.max(0, (geo - 0.42) / 0.58));
  const lerpI = (a, b) => Math.round(a + (b - a) * budget);
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

  // ======================================================== the fish =========

  // ONE MeshStandardNodeMaterial for all six species and the jumper. Six
  // geometries carrying an identical attribute layout (position, normal, color,
  // aSwim + instanceMatrix, instanceColor, aFish) share one pipeline per mesh
  // per pass: vertex COUNT is not in the 29-component render cache key, the
  // attribute LAYOUT is (see clip.js:19-28). It is a NODE material and not a
  // plain one on purpose — two plain MeshStandardMaterials differing only in
  // their node graph collide on `customProgramCacheKey` and the second silently
  // renders with the first's shader. That is measured, not theoretical.
  const aSwim = attribute('aSwim', 'vec3');
  const aFish = attribute('aFish', 'vec4');

  const fishMat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.0,
    side: THREE.DoubleSide,
    fog: true,
    dithering: true,
  });

  // aFish is (beat phase, amplitude in world metres, cos yaw, sin yaw), rewritten
  // on the CPU next to the instance matrix.
  //
  //   * the phase is ACCUMULATED, not `time * rate`, so beat rate is per fish and
  //     can rise with speed and panic without any uniform moving (constraint 3).
  //   * the amplitude is in metres with the per-instance scale already folded in,
  //     so the shader needs no knowledge of the instance matrix it cannot see.
  //   * cos/sin of a yaw the CPU already computed for that matrix, so there is no
  //     trig in the vertex stage.
  //
  // `positionNode` is evaluated AFTER the instance matrix has been folded into
  // positionLocal (monster.js:643-647), so the lateral bend has to be rotated
  // into world space by the fish's own yaw: local +X maps to world
  // (cos yaw, 0, -sin yaw). Pitch is ignored in that rotation — it is clamped to
  // ±0.45 rad below, so the worst error is a 10% shortening of a 3 cm offset.
  //
  // Normals are deliberately not rotated with the bend. The old GLSL did not
  // either, and at 0.3 m of body through 4 m of water it is invisible; bending
  // them costs a second Fn evaluated per vertex for nothing.
  // --- scales ---------------------------------------------------------------
  //
  // No UVs anywhere on a creature — the Mesher writes position, normal, colour
  // and aSwim and nothing else — so the scales are procedural, in GEOMETRY
  // space. `positionGeometry` is the raw attribute: before the swim bend, before
  // the instance matrix, and identical for every instance of a species, which is
  // exactly what is wanted. A fish is built at its real length, so one frequency
  // gives a 0.24 m damsel small scales and a 1.7 m ray large ones without a
  // per-species constant — and a per-species constant is precisely what hard
  // constraint 3 forbids, because it would give each species its own WGSL
  // module and its own pipeline.
  //
  // A BRICK lattice, not a square one. Scales overlap in staggered rows, so the
  // row offset is half a cell — without it the pattern reads as graph paper the
  // moment it is bigger than a few pixels. The cell is stretched 1:1.55 along
  // the body because a scale is wider than it is tall.
  //
  // `colorNode` replaces the material's `color` (which is white) and three
  // multiplies vertexColors and instanceColor on top of it, so this modulates
  // the palette rather than replacing it. emissiveNode is deliberately NOT
  // touched: applyEnv writes fishMat.emissive every frame for the night floor,
  // and a node there would silently win.
  // Cycles per metre of body. Uniforms, because the only way to pick this is to
  // look at a fish on screen at the distance the game actually shows one, and
  // that is a sweep rather than a calculation: at 46 a sardine got fifteen rows
  // of two pixels each and the whole thing averaged out to flat blue.
  const uScaleFreq = uniform(18.0);
  const uScaleAmp = uniform(1.4);
  const scaleField = Fn(() => {
    const p = positionGeometry.mul(uScaleFreq).toVar();
    // Rows run around the body (y), columns along it (z).
    const row = p.y.toVar();
    // The stagger has to be constant WITHIN a row, so it comes off floor(row).
    // Using fract(row * 0.5) directly is a sawtooth along the row instead of a
    // step between rows, which shears every column continuously — the first
    // version came out as wavy horizontal stripes rather than scales, and it
    // looked deliberate enough that it took a close-up to catch.
    const col = p.z.add(fract(floor(row).mul(0.5))).toVar();
    const c = vec2(fract(col).sub(0.5), fract(row).sub(0.5)).toVar();
    const d = length(vec2(c.x.mul(0.64), c.y)).toVar();
    // A scale is a soft disc with a bright leading rim, which is the bit that
    // actually catches light on a real fish.
    const body = tslSmoothstep(0.48, 0.16, d).toVar();
    const rim = tslSmoothstep(0.30, 0.44, d).mul(tslSmoothstep(0.52, 0.42, d)).toVar();
    return body.mul(0.55).add(rim.mul(1.0)).mul(uScaleAmp).toVar();
  });

  fishMat.colorNode = Fn(() => {
    const s = scaleField().toVar();
    // Held tight around 1: the palette is already doing the work, and anything
    // wider turns a 20-pixel fish into noise. The blue channel moves least, so
    // the pattern reads as sheen rather than as a colour change.
    return vec3(
      float(0.82).add(s.mul(0.40)),
      float(0.84).add(s.mul(0.34)),
      float(0.89).add(s.mul(0.22)),
    );
  })();

  // And the scales are SMOOTHER than the skin between them, which is what makes
  // them catch the sun as a fish banks. roughnessNode replaces the material's
  // 0.62 outright, so the base value is spelled out here.
  fishMat.roughnessNode = Fn(() => float(0.62).sub(scaleField().mul(0.26)))();

  fishMat.positionNode = Fn(() => {
    const w = sin(aFish.x.sub(aSwim.x.mul(4.2))).mul(aFish.y);
    const dx = w.mul(aSwim.y);
    const dy = w.mul(aSwim.z);
    return positionLocal.add(vec3(dx.mul(aFish.z), dy, dx.mul(aFish.w).negate()));
  })();

  const fishGroup = new THREE.Group();
  fishGroup.name = 'fish';

  // How many schools in total, so `findSpot` can stratify bearings across ALL of
  // them and not leave three-quarters of the reef empty.
  let totalSchools = 0;
  for (const spec of SPECIES) totalSchools += lerpI(spec.schools[0], spec.schools[1]);
  let sectorNext = 0;

  /**
   * Somewhere over the reef with the depth this species wants and no land
   * underfoot. Bearings are stratified across every school of every species.
   *
   * Three passes: the sector with the species' exact depth window, the sector
   * with a widened one, then the whole circle. A shallow grazer and a deep ray
   * want windows that do not both exist in every sector, and a school that never
   * gets placed is worse than one placed a little off its ideal depth.
   */
  function findSpot(out, si, dmin, dmax) {
    const sector = TAU / Math.max(1, totalSchools);
    for (let pass = 0; pass < 3; pass++) {
      const lo = pass === 0 ? dmin : dmin * 0.72;
      const hi = pass === 0 ? dmax : dmax * 1.35;
      for (let tries = 0; tries < 140; tries++) {
        const a = pass < 2 ? sector * (si + rng.next()) : rng.range(0, TAU);
        const r = 14 + Math.pow(rng.next(), 0.75) * 150;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r - 8;
        if (isLand(x, z)) continue;
        const d = -seabed(x, z);
        if (d < lo || d > hi) continue;
        out.set(x, 0, z);
        return true;
      }
    }
    const a = sector * (si + 0.5);
    out.set(Math.cos(a) * 110, 0, Math.sin(a) * 110 - 8);
    return false;
  }

  /**
   * The recycler's placer: somewhere ahead of the boat, in water this species
   * wants, on land nowhere.
   *
   * This is the answer to the half of the brief that is not about one shoal.
   * `findSpot` puts every school in a fixed 14-164 m annulus around (0,-8) and
   * they roam at most 11-26 m from where they land, so drive north past 200 m
   * and there are no fish at all — and even inside the annulus, 44 schools over
   * ~80,000 m^2 means the nearest one is usually 60 m away, i.e. 5 px per fish.
   * Placing a hundred static shoals to fix that is not affordable. The same
   * eight shoals, always near the player, are worth more than 44 mostly nowhere
   * near them.
   *
   * `cone` is the half-angle around the boat's heading, and the bearing inside
   * it is drawn u*|u| rather than uniformly. Both halves of that matter. A
   * NARROW cone would put every new shoal on the centreline and the player
   * would learn that fish only ever appear dead ahead; a UNIFORM draw across
   * 70 deg puts almost none of them on the track, because the corridor is
   * 6.4 m wide plus a 1.8 m shoal and at 70 m that subtends 0.14 rad out of
   * 2.44 — one interception in every seventeen re-vets. The shaped draw keeps
   * the full 70 deg of spread but lands 29% of shoals within 0.1 rad of the
   * heading, which at a re-vet every couple of seconds is an encounter every
   * ten seconds or so of driving. That is the number the brief is actually
   * about: the same eight shoals, always near the player.
   *
   * At the 50-88 m the re-vet uses, a 0.34 m fish is 3.3-5.8 px through 60-80%
   * reflective water, so nothing pops in; the shoal fades up over the ten to
   * eighteen seconds it takes to drive there.
   *
   * @param {number} hx,hz unit heading; the boat's own direction of travel
   */
  function findSpotNear(out, bx, bz, hx, hz, rmin, rmax, cone, dmin, dmax) {
    for (let pass = 0; pass < 2; pass++) {
      const lo = pass === 0 ? dmin : dmin * 0.72;
      const hi = pass === 0 ? dmax : dmax * 1.35;
      for (let tries = 0; tries < 48; tries++) {
        const u = rng.range(-1, 1);
        const a = Math.atan2(hz, hx) + cone * u * Math.abs(u);
        const r = rmin + rng.next() * (rmax - rmin);
        const x = bx + Math.cos(a) * r;
        const z = bz + Math.sin(a) * r;
        if (isLand(x, z)) continue;
        const d = -seabed(x, z);
        if (d < lo || d > hi) continue;
        out.set(x, 0, z);
        return true;
      }
    }
    // Nothing suitable inside the cone — the boat is pointed at a beach, or out
    // over deep water. Leave the shoal exactly where it is and try again next
    // time this one comes up in the round robin; a failed re-vet costs 96
    // rejected candidates once every nShoals frames, and a shoal parked 110 m
    // astern is invisible anyway.
    return false;
  }

  /** Smallest stride coprime with n, so the k-sample walk visits everyone. */
  function coprimeStride(n) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    for (const s of [7, 11, 13, 17, 19, 23, 5, 3, 2]) {
      if (s < n && gcd(s, n) === 1) return s;
    }
    return 1;
  }

  const WHITE = new THREE.Color(1, 1, 1);
  const kinds = [];          // one runtime record per species

  /**
   * Scatter a school's bodies inside its own radius, at its band, with a random
   * heading each. Everything here is POSITIONAL, so the recycler can call it to
   * move a shoal that has fallen 110 m astern without creating or destroying
   * anything (hard constraint 4) — the instances are the same instances, they
   * are simply somewhere else. The per-fish constants (scale, beat rate, tint,
   * the aFish amplitude) are drawn once at build and never touched again.
   *
   * `k^0.45` biases toward the rim: a uniform radius draw piles a third of the
   * shoal into the middle 10% of the volume and the separation term then spends
   * the first second pushing them apart, which reads as an explosion at boot.
   */
  function placeSchoolBodies(rec, sk) {
    const S = rec.S;
    for (let i = sk.base; i < sk.base + sk.n; i++) {
      const u = rng.range(-1, 1), v = rng.range(-1, 1), w = rng.range(-1, 1);
      const len = Math.max(1e-3, Math.hypot(u, v, w));
      const kk = Math.pow(rng.next(), 0.45) * sk.radius;
      rec.px[i] = sk.cx + u / len * kk;
      rec.py[i] = sk.bandY + v / len * kk * 0.35;
      rec.pz[i] = sk.cz + w / len * kk;
      const a0 = rng.range(0, TAU);
      rec.vx[i] = Math.sin(a0) * S.vMin;
      rec.vy[i] = 0;
      rec.vz[i] = Math.cos(a0) * S.vMin;
      rec.wang[i] = rng.range(0, TAU);
      rec.wrate[i] = rng.sign() * S.wRate * rng.range(0.7, 1.4);
      // A recycled shoal must arrive calm. Carrying a half-spent impulse or a
      // mid-air ballistic flag across a 100 m teleport would hurl the whole
      // shoal sideways the instant it lands in front of the player.
      if (rec.st) { rec.st[i] = 0; rec.ex[i] = 0; rec.ey[i] = 0; rec.ez[i] = 0; rec.air[i] = 0; }
    }
  }

  const withPect = lerpI(0, 1) === 1;   // pectorals are the first thing to go
  const wingRows = lerpI(RAY_WING.length - 1, RAY_WING.length);

  for (let sp = 0; sp < SPECIES.length; sp++) {
    const spec = SPECIES[sp];
    spec._pal = {
      back: col(spec.pal.back), mid: col(spec.pal.mid),
      belly: col(spec.pal.belly), fin: col(spec.pal.fin),
    };
    const radial = lerpI(spec.radial[0], spec.radial[1]);
    const nSchools = lerpI(spec.schools[0], spec.schools[1]);
    const perSchool = lerpI(spec.per[0], spec.per[1]);
    const count = nSchools * perSchool;
    const S = SOCIAL[spec.social];

    // `bright` writes the colour attribute at build. Free, and invisible to
    // getMaterialCacheKey — which is the whole reason the skitter's silver
    // flank is a geometry fact and not a light or a material property.
    const g = buildCreature(spec, radial, wingRows, withPect, spec.bright || 1);
    const mesh = new THREE.InstancedMesh(g, fishMat, count);
    mesh.name = 'fish-' + spec.key;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The boids move every instance every frame, so the build-time bounding
    // sphere is meaningless within a second. Frustum culling would also defer
    // this mesh's pipeline to the frame it first drifts into view and compile it
    // synchronously there — three of the four old schools had never had a
    // pipeline built at all, and each one was a live hitch waiting to happen.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const aArr = new Float32Array(count * 4);
    const attr = new THREE.InstancedBufferAttribute(aArr, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aFish', attr);

    const rec = {
      spec, S, mesh, geo: g, attr, aArr, count,
      mat: mesh.instanceMatrix.array,
      px: new Float32Array(count), py: new Float32Array(count), pz: new Float32Array(count),
      vx: new Float32Array(count), vy: new Float32Array(count), vz: new Float32Array(count),
      wang: new Float32Array(count), wrate: new Float32Array(count),
      amp: new Float32Array(count), scl: new Float32Array(count),
      yOff: new Float32Array(count), beatR: new Float32Array(count),
      schools: [],
      // --- the scatter, only for a species that declares `startle` -----------
      // Two Float32Arrays and a Uint8Array per rec, 2.2 kB at 272 fish. `st` is
      // the impulse envelope, `ex/ey/ez` the escape direction fixed once on
      // entry (the boat turns; re-deriving it from boat.right every frame would
      // swing the escape round with the helm), `air` is the ballistic state:
      //   0 = swimming, 1 = launched and still under the surface, 2 = airborne.
      st: spec.startle ? new Float32Array(count) : null,
      ex: spec.startle ? new Float32Array(count) : null,
      ey: spec.startle ? new Float32Array(count) : null,
      ez: spec.startle ? new Float32Array(count) : null,
      air: spec.startle ? new Uint8Array(count) : null,
    };

    const bandHalf = (spec.band[1] - spec.band[0]) * 0.5;
    const bandMid = (spec.band[0] + spec.band[1]) * 0.5;

    for (let s = 0; s < nSchools; s++) {
      findSpot(_p, sectorNext++, spec.water[0], spec.water[1]);
      const cx = _p.x, cz = _p.z;
      const base = s * perSchool;
      // Radius of the shoal at rest, from the target spacing the social role
      // wants. Real schools sit at 0.3-0.5 body lengths; the old ellipsoid gave
      // 0.72 m for a 0.30 m fish, i.e. 2.4 body lengths, which is why it read as
      // scatter rather than a shoal.
      const spread = Math.max(1.2, Math.cbrt(perSchool) * S.rSep * 2.1);
      // Seed at the band the school will actually settle into. A 'floor' species
      // seeded at -bandMid starts near the surface and spends its first two
      // seconds sinking — harmless in play, but warmUpClock draws the boot pose
      // and a grouper hanging a metre under the waves is not what it is for.
      const sbHome = seabed(cx, cz);
      const seedRaw = spec.bandMode === 'floor' ? sbHome + bandMid : -bandMid;
      const seedY = clamp(seedRaw, Math.min(spec.ceil - 0.2, sbHome + spec.clear + 0.25), spec.ceil - 0.2);
      const sk = {
        base, n: perSchool, stride: coprimeStride(perSchool),
        cx, cz,                       // running centroid
        homeX: cx, homeZ: cz,         // the vetted spot; the anchor is pulled back to it
        ax: cx, az: cz,               // the wandering anchor
        radius: spread,
        bandY: seedY, bandHalf,
        // Local water surface under the shoal centroid, refreshed once a frame
        // for a 'ride' species and left at 0 for everyone else. Declared here so
        // every school record has the same shape — a shoal that grew a property
        // in updateFish would deoptimise the hot loop for all of them.
        surfY: 0,
        floorY: Math.min(-1.5, sbHome), floorGX: 0, floorGZ: 0, floorHard: -1e9,
        ring: [0, 0, 0, 0], ringN: 0, probe: 0,
        panic: 1,
        // The anchor path: the same two-term Lissajous per axis the old schools
        // flew, which was tuned and is a smooth function of time. It is now what
        // the school WANTS rather than where every fish IS.
        // `roam` scales how far the anchor wanders from its vetted home. A
        // grouper that holds station on one reef head has no business crossing
        // 26 m of open sand into 2 m of water, and that excursion is exactly how
        // one ended up at the surface in a 40 s soak.
        pax: rng.range(11, 26) * spec.roam, paz: rng.range(11, 26) * spec.roam,
        w1: rng.range(0.030, 0.062), p1: rng.range(0, TAU),
        w2: rng.range(0.026, 0.055), p2: rng.range(0, TAU),
        w3: rng.range(0.075, 0.140), p3: rng.range(0, TAU),
        w4: rng.range(0.068, 0.135), p4: rng.range(0, TAU),
        w5: rng.range(0.055, 0.105), p5: rng.range(0, TAU),
      };
      // Prime the plane fit so the first frame is not run against a zeroed ring.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        sk.ring[k] = seabed(cx + Math.cos(a) * spread, cz + Math.sin(a) * spread);
      }
      sk.ringN = 4;
      rec.schools.push(sk);
      // Seed inside the shoal so warmUpClock draws them somewhere sane — an
      // InstancedMesh starts full of zeroed matrices and a degenerate model
      // matrix is not something to leave lying around.
      placeSchoolBodies(rec, sk);

      for (let i = 0; i < perSchool; i++) {
        const gi = base + i;
        const scale = rng.range(spec.sizeJit[0], spec.sizeJit[1]);
        rec.scl[gi] = scale;
        rec.amp[gi] = spec.amp * spec.len * scale;
        rec.yOff[gi] = rng.range(-bandHalf, bandHalf);
        rec.beatR[gi] = rng.range(spec.beat[0], spec.beat[1]);
        rec.aArr[gi * 4] = rng.range(0, TAU);
        rec.aArr[gi * 4 + 1] = rec.amp[gi];
        rec.aArr[gi * 4 + 2] = 1;
        rec.aArr[gi * 4 + 3] = 0;
        rec.mat[gi * 16 + 3] = 0;
        rec.mat[gi * 16 + 7] = 0;
        rec.mat[gi * 16 + 11] = 0;
        rec.mat[gi * 16 + 15] = 1;

        // Per-fish tint, multiplied against the baked vertex colours. Lightness
        // is the channel that matters: at 4 m the old 0.48-0.72 range came out
        // as black slivers regardless of hue, so every species' band is pushed
        // up into the value range the reef occupies in ref/01.
        _c.setHSL(rng.range(spec.tint.h[0], spec.tint.h[1]),
          rng.range(spec.tint.s[0], spec.tint.s[1]),
          rng.range(spec.tint.l[0], spec.tint.l[1]), SRGB);
        _c.lerp(WHITE, 0.22);
        mesh.setColorAt(gi, _c);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    fishGroup.add(mesh);
    kinds.push(rec);
  }

  group.add(fishGroup);
  setLayers(fishGroup, LAYER.MAIN, LAYER.UNDERWATER);
  // ...then widen the one species that leaves the water. A fish in the air with
  // no reflection under it reads as a decal stuck on the frame; this is the
  // jumper's exact recipe. It costs a third draw call for that mesh and a third
  // triangle submission, and NOT a third pipeline — the clip is a uniform, not a
  // material property (clip.js), and the reflection pass draws the same
  // 29-component cache key as the beauty pass does. `setLayers` walks the
  // subtree and must run AFTER the group-wide call above, which would otherwise
  // overwrite it.
  for (const rec of kinds) {
    if (rec.spec.reflected) setLayers(rec.mesh, LAYER.MAIN, LAYER.UNDERWATER, LAYER.REFLECTED);
  }
  applyWaterClip(fishGroup);

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
  // NOTE: this used to carry a `decorateGullMaterial` that injected a
  // span-weighted flap through `onBeforeCompile`. That hook does not exist in
  // three.webgpu.min.js, so the gulls have never flapped on this branch and the
  // `aBird` attribute was uploaded every frame for nothing. The flap is NOT
  // ported here because a gull's instance matrix carries yaw, roll and pitch,
  // and `positionNode` runs after that matrix is folded in — reconstructing the
  // bird's own up-axis needs three more per-instance floats. It is a real fix,
  // it belongs to whoever next owns the gulls, and it is out of scope for a fish
  // change. The attribute is gone; the birds are honestly rigid rather than
  // pretending otherwise.
  const gullMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.78,
    metalness: 0.0,
    side: THREE.DoubleSide,
    fog: true,
    dithering: true,
  });

  const gulls = new THREE.InstancedMesh(gullGeo, gullMat, GULLS);
  gulls.name = 'gulls';
  gulls.castShadow = false;
  gulls.receiveShadow = false;
  gulls.frustumCulled = false;      // they orbit far outside their bake pose
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
    });

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
  gulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(gulls);
  setLayers(gulls, LAYER.MAIN, LAYER.REFLECTED);

  // ======================================================= jumping fish ======
  //
  // An InstancedMesh of one, on MAIN | UNDERWATER | REFLECTED, ALWAYS VISIBLE.
  // It used to be `visible = false` at build and first shown 6-20 s into play,
  // which is exactly the hazard warmUpClock exists to remove: an object that is
  // never drawn has no pipeline, so the first leap paid a synchronous
  // `createRenderPipeline` mid-game. Now it idles underwater as one more
  // snapper — where CLIP.ABOVE discards it from the reflection anyway — and
  // detaches into the arc when it leaps. Zero visibility toggling.
  //
  // It needs its own geometry rather than sharing the snapper's, because `aFish`
  // is an attribute ON the geometry and two InstancedMeshes sharing one geometry
  // would share one instance buffer.

  const JUMP_SPEC = SPECIES[2];      // the snapper
  const jumperGeo = buildCreature(JUMP_SPEC, lerpI(JUMP_SPEC.radial[0], JUMP_SPEC.radial[1]),
    wingRows, withPect, 1.25);
  const jumperA = new Float32Array(4);
  const jumperAttr = new THREE.InstancedBufferAttribute(jumperA, 4);
  jumperAttr.setUsage(THREE.DynamicDrawUsage);
  jumperGeo.setAttribute('aFish', jumperAttr);
  const jumper = new THREE.InstancedMesh(jumperGeo, fishMat, 1);
  jumper.name = 'jumper';
  jumper.castShadow = false;
  jumper.receiveShadow = false;
  jumper.frustumCulled = false;
  jumper.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  jumperA[1] = JUMP_SPEC.amp * JUMP_SPEC.len * 1.9;
  jumperA[2] = 1;
  const jmat = jumper.instanceMatrix.array;
  jmat[3] = 0; jmat[7] = 0; jmat[11] = 0; jmat[15] = 1;
  _c.setHSL(0.10, 0.30, 0.80, SRGB);
  jumper.setColorAt(0, _c);
  group.add(jumper);
  setLayers(jumper, LAYER.MAIN, LAYER.UNDERWATER, LAYER.REFLECTED);
  // Crosses the waterline twice a leap, flashing an upside-down fish into the
  // reflection at each end of the arc.
  applyWaterClip(jumper);

  const JUMP_SCALE = 1.9;
  const jump = {
    active: false,
    wait: 6 + rng.range(0, 14),
    t: 0,
    dur: 1.5,
    x0: 0, z0: 0, x1: 0, z1: 0,
    apex: 1.4,
    exited: false,
    idleAng: rng.range(0, TAU),
    beat: 0,
    y: -1.6,
  };

  /**
   * Pick where the next leap happens. Called at build and after every jump, so
   * the fish is already loitering at the spot it will leap from — no teleport
   * the frame the arc starts.
   */
  function pickJumpSite(bx, bz) {
    for (let tries = 0; tries < 14; tries++) {
      const a = rng.range(0, TAU);
      const d = rng.range(26, 82);
      const x = bx + Math.cos(a) * d;
      const z = bz + Math.sin(a) * d;
      if (isLand(x, z)) continue;
      const sb = seabed(x, z);
      if (sb > -2.4) continue;
      const dir = rng.range(0, TAU);
      const run = rng.range(2.4, 4.6);
      const x1 = x + Math.cos(dir) * run;
      const z1 = z + Math.sin(dir) * run;
      if (isLand(x1, z1)) continue;
      jump.x0 = x; jump.z0 = z; jump.x1 = x1; jump.z1 = z1;
      jump.y = clamp(sb + 1.1, -3.2, -1.2);
      jump.apex = rng.range(0.9, 1.9);
      jump.dur = rng.range(1.2, 1.8);
      return true;
    }
    return false;
  }
  pickJumpSite(0, 0);

  // --- frame ---------------------------------------------------------------

  // The dock's pilings are not on ctx — dock.js:491 returns only
  // {shore, head, centre, deckY, yaw, matrix, inverse} and `pilingInfo` never
  // escapes. So this is a capsule baked from the two endpoints dock.js:23-24
  // fixes at build time, tested once per SCHOOL per frame (~15 flops) against
  // the anchor, not per fish. The honest fix is `dock.info.pilings` plus a
  // CONTRACT.md amendment; this is the cheap stand-in until someone owns that.
  const DOCK_AX = -95, DOCK_AZ = 10;
  const DOCK_BX = -58, DOCK_BZ = -4;
  const DOCK_R = 4.5;
  const DOCK_DX = DOCK_BX - DOCK_AX, DOCK_DZ = DOCK_BZ - DOCK_AZ;
  const DOCK_LL = DOCK_DX * DOCK_DX + DOCK_DZ * DOCK_DZ;

  const FLEE_R = 9.0;         // metres; the boat
  const W_FLEE = 14.0;
  const MON_R = 30.0;         // metres; the leviathan
  const W_MON = 26.0;

  // Environment-driven scalars. They are PLAIN JS NUMBERS folded into aFish on
  // the CPU, never node literals — a literal in a node graph means a fresh WGSL
  // module and a blocking pipeline build every time the sun moves.
  let envAmp = 1.0;
  let envRate = 1.0;

  // How many ripple stamps this module has left this frame. `water.disturb` is
  // the public door into the wake sim (surface.js -> wake.js) and it holds a
  // pending queue of PENDING_MAX = 48 a frame that the BOAT WAKE also draws
  // from. A shoal of 34 fish hitting the water at once could ask for 34 stamps
  // and starve the wake, which is hard constraint 5. Six is enough: a stamp is
  // a ~1.5 m ring that lives for several seconds, so six a frame at 60 fps is
  // 360 rings a second and the shoal cannot use them all anyway.
  let stampBudget = STAMP_MAX;
  let armBudget = ARM_MAX;

  /**
   * Instance matrix + `aFish`, for one fish, from a position and a velocity.
   *
   * Yaw so local -Z runs along the velocity, pitch from its rise. Same
   * convention `faceAlong` uses, hand-rolled into the instance array:
   * Matrix4.compose + setMatrixAt is 0.085 us a fish, writing the eight
   * non-zero terms directly is 0.018 us — at 866 fish that difference is
   * 0.058 ms a frame, which is a third of this module's whole budget.
   *
   * `pitchLimit` is 0.44 rad for a swimming fish, because positionNode rotates
   * the lateral bend by yaw only and ignores pitch (the worst error at 0.44 is
   * a 10% shortening of a 3 cm offset), and 1.15 for a fish in the air, where
   * nose-up-out / nose-down-in is most of what makes an arc read as a fish.
   */
  function writePose(rec, mArr, aArr, i, nx, ny, nz, vx, vy, vz, sp, pitchLimit, S, dt) {
    const hl = Math.sqrt(vx * vx + vz * vz);
    let yaw;
    if (hl > 1e-5) yaw = Math.atan2(-vx, -vz);
    else yaw = Math.atan2(-aArr[i * 4 + 3], aArr[i * 4 + 2]);
    const pitch = Math.asin(clamp(sp > 1e-5 ? vy / sp : 0, -pitchLimit, pitchLimit));
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const cp = Math.cos(pitch), spp = Math.sin(pitch);
    const sc = rec.scl[i];
    const o = i * 16;
    mArr[o] = sc * ca; mArr[o + 1] = 0; mArr[o + 2] = -sc * sa;
    mArr[o + 4] = sc * sa * spp; mArr[o + 5] = sc * cp; mArr[o + 6] = sc * ca * spp;
    mArr[o + 8] = sc * sa * cp; mArr[o + 9] = -sc * spp; mArr[o + 10] = sc * ca * cp;
    mArr[o + 12] = nx; mArr[o + 13] = ny; mArr[o + 14] = nz;

    // ---- the beat --------------------------------------------------------
    // A phase accumulator, so rate can track speed and panic without any
    // uniform moving. A fish at a standstill still idles at half rate.
    //
    // The rate multiplier is clamped at 2.0. It never used to be, because the
    // fastest species could only reach 1.8 (vCap = vMax * panic 2.6); the
    // skitter's panic of 3.6 takes it to 2.3, and 12 Hz x 2.3 = 27.6 Hz is past
    // what a 60 fps sample of a sine can carry — the tail strobes backwards.
    const ao = i * 4;
    let ph = aArr[ao] + rec.beatR[i] * envRate * clamp(0.5 + 0.5 * sp / S.vMax, 0, 2.0) * dt;
    if (ph > TAU) ph -= TAU * Math.floor(ph / TAU);
    aArr[ao] = ph;
    aArr[ao + 1] = rec.amp[i] * envAmp * (0.55 + 0.45 * clamp(sp / S.vMax, 0, 1.6));
    aArr[ao + 2] = ca;
    aArr[ao + 3] = sa;
  }

  /**
   * The whole fish frame. Measured shape of the cost at 470 fish:
   *   centroid pass ................ ~0.006 ms
   *   k-sample separation+alignment  ~0.024 ms
   *   the other terms + integrate .. ~0.015 ms
   *   matrix + aFish write ......... ~0.047 ms
   *   per-school terrain ........... ~0.055 ms   <- the expensive half
   *   flee culls ................... ~0.006 ms
   * against ~6 ms of main thread on an iPhone. The terrain line is why every
   * seabed query in here is per SCHOOL and amortised across frames.
   */
  function updateFish(ctx) {
    const t = ctx.time;
    const dt = ctx.dt;
    if (dt <= 0) return;
    const frame = ctx.frame | 0;

    const boat = ctx.boat;
    const bx = boat ? boat.position.x : 0;
    const by = boat ? boat.position.y : 0;
    const bz = boat ? boat.position.z : 0;
    const bSpeed = boat ? Math.abs(boat.speed || 0) : 0;
    const bWeight = 0.35 + 0.65 * clamp(bSpeed / 4, 0, 1);

    // Boat-local basis for the swept corridor. `dirX/dirZ` is the direction of
    // TRAVEL, not the bow: astern, the bow wave is behind the transom and the
    // corridor has to be there too, or backing off a shoal walks the hull
    // through it with nothing happening.
    const sgnSpeed = boat && (boat.speed || 0) < 0 ? -1 : 1;
    const dirX = boat ? boat.forward.x * sgnSpeed : 0;
    const dirZ = boat ? boat.forward.z * sgnSpeed : -1;
    const rgtX = boat ? boat.right.x : 1;
    const rgtZ = boat ? boat.right.z : 0;

    // The water module's public doors, read defensively: `wildlife` is built
    // before nothing in particular and a harness can render a frame with no
    // water module at all. `disturbArm` is NOT in CONTRACT.md's water API — it
    // exists on wake.js and surface.js does not currently re-export it, so this
    // feature-detects and silently does without.
    const water = ctx.water;
    const fDisturb = water && typeof water.disturb === 'function' ? water.disturb : null;
    const fArm = water && typeof water.disturbArm === 'function' ? water.disturbArm : null;
    const fSurf = water && typeof water.sampleHeight === 'function' ? water.sampleHeight : null;
    stampBudget = STAMP_MAX;
    armBudget = ARM_MAX;

    // Read the leviathan defensively — the quest module can own his state and
    // `ctx.monster` is not in CONTRACT.md's ctx table (it should be; main.js:214
    // sets it before this module is built).
    const mon = ctx.monster && ctx.monster.state;
    const mx = mon ? mon.position.x : 0;
    const my = mon ? mon.position.y : 0;
    const mz = mon ? mon.position.z : 0;
    const monBig = mon && (mon.phase === 'breach' || (mon.distance || 999) < 40);

    for (let ki = 0; ki < kinds.length; ki++) {
      const rec = kinds[ki];
      const spec = rec.spec;
      const S = rec.S;
      const isFloor = spec.bandMode === 'floor';
      const isRide = spec.bandMode === 'ride';
      const clearance = spec.clear;
      const ceilY = spec.ceil;
      const mArr = rec.mat;
      const aArr = rec.aArr;
      const rSep2 = S.rSep * S.rSep;
      // Non-null only for a species that declares `startle`. Hoisted out of the
      // school loop so the branch is one property read per species per frame.
      const stArr = rec.st, exArr = rec.ex, eyArr = rec.ey, ezArr = rec.ez, airArr = rec.air;
      const K_ST = spec.startle;
      // Corridor length is a TIME, not a distance. The existing FLEE_R = 9.0 is
      // backwards: at 1 m/s it gives a shoal nine seconds of warning, so it is
      // always already gone by the time you arrive and you never see it intact;
      // at 8 m/s it gives 1.1 s. Seeing it whole and THEN seeing it go is the
      // causality — it is what makes the player feel they did it. 1.15 s of
      // warning at any speed: 2.3 m at rest (you have to nudge them), 8.1 m at
      // 5 m/s, 11.5 m at 8 m/s.
      const lead = K_ST ? K_ST.lead[0] + K_ST.lead[1] * bSpeed : 0;
      const half2 = K_ST ? K_ST.half * K_ST.half : 0;
      // e^(-dt/decay), one exp per species per frame instead of one per fish.
      const stDecay = K_ST ? Math.exp(-dt / K_ST.decay) : 0;
      // What the player feels across ONE throttle press: drifting past makes
      // them ease aside, driving at them blows the shoal up.
      const stGate = K_ST ? 0.10 + 0.90 * clamp(bSpeed / 3.2, 0, 1) : 0;
      const canJump = K_ST ? bSpeed > K_ST.minSpeed : false;
      const jumpLead = K_ST ? K_ST.jumpLead[0] + K_ST.jumpLead[1] * bSpeed : 0;
      const jumpHalf2 = K_ST ? K_ST.jumpHalf * K_ST.jumpHalf : 0;

      // ---- recycle one shoal a frame, round robin ------------------------
      // Nothing is created or destroyed (hard constraint 4): these are the same
      // instances on a different pair of coordinates. Cost is at most one
      // findSpotNear per frame against the 44 findSpots the build already pays
      // in one go.
      const RC = spec.recycle;
      if (RC && boat && rec.schools.length > 0) {
        const si = frame % rec.schools.length;
        const skR = rec.schools[si];
        const ddx = skR.cx - bx, ddz = skR.cz - bz;
        if (ddx * ddx + ddz * ddz > RC.far * RC.far) {
          if (findSpotNear(_p, bx, bz, dirX, dirZ, RC.near[0], RC.near[1], RC.cone,
            spec.water[0], spec.water[1])) {
            skR.homeX = _p.x; skR.homeZ = _p.z;
            skR.cx = _p.x; skR.cz = _p.z;
            skR.ax = _p.x; skR.az = _p.z;
            const sb = seabed(_p.x, _p.z);
            skR.floorY = Number.isFinite(sb) ? sb : -20;
            skR.floorHard = skR.floorY - 0.15;
            for (let k = 0; k < 4; k++) {
              const a = (k / 4) * TAU;
              const h = seabed(_p.x + Math.cos(a) * skR.radius, _p.z + Math.sin(a) * skR.radius);
              skR.ring[k] = Number.isFinite(h) ? h : -20;
            }
            skR.bandY = (fSurf ? fSurf(_p.x, _p.z, t) : 0) - (spec.band[0] + spec.band[1]) * 0.5;
            skR.panic = 1;
            placeSchoolBodies(rec, skR);
          }
        }
      }

      for (let si = 0; si < rec.schools.length; si++) {
        const sk = rec.schools[si];
        const base = sk.base, n = sk.n;

        // ---- the anchor -------------------------------------------------
        // Two-term Lissajous, then a shallow-water pull-back. `isLand` implies
        // seabed >= 0, so the pull-back collapses to k=1 there and snaps the
        // anchor back onto its vetted home — the island case is handled by the
        // same three lines as the reef-head case, with no extra query.
        let axp = sk.homeX + sk.pax * Math.sin(sk.w1 * t + sk.p1)
          + sk.pax * 0.42 * Math.sin(sk.w3 * t + sk.p3);
        let azp = sk.homeZ + sk.paz * Math.cos(sk.w2 * t + sk.p2)
          + sk.paz * 0.42 * Math.sin(sk.w4 * t + sk.p4);
        const sbA = seabed(axp, azp);
        const sbAf = Number.isFinite(sbA) ? sbA : -20;
        if (!(sbAf < -4.6)) {
          // Ramp width 2.4 rather than 3.4, so anything shallower than 2.2 m
          // snaps the anchor all the way home instead of leaving 9% of the
          // excursion in place — which was enough to park a school in water too
          // thin to hold its own depth band.
          const k = clamp(sbAf + 4.6, 0, 2.4) / 2.4;
          axp += (sk.homeX - axp) * k;
          azp += (sk.homeZ - azp) * k;
        }
        // Push the anchor out of the dock capsule.
        {
          const wx = axp - DOCK_AX, wz = azp - DOCK_AZ;
          const u = clamp((wx * DOCK_DX + wz * DOCK_DZ) / DOCK_LL, 0, 1);
          const dx = axp - (DOCK_AX + DOCK_DX * u);
          const dz = azp - (DOCK_AZ + DOCK_DZ * u);
          const d2 = dx * dx + dz * dz;
          if (d2 < DOCK_R * DOCK_R && d2 > 1e-6) {
            const inv = 1 / Math.sqrt(d2);
            axp += dx * inv * (DOCK_R - d2 * inv);
            azp += dz * inv * (DOCK_R - d2 * inv);
          }
        }
        sk.ax = axp;
        sk.az = azp;

        // ---- the terrain plane ------------------------------------------
        // One probe on a ring whose bearing advances a quarter turn each visit,
        // every other frame. A school is 6-12 m across and the seabed's finest
        // term is a 0.24 m ripple ridge (seabed.js:91-94), so a plane fitted
        // across the school is accurate to well under the clearance the fish
        // keep. Coral heads need no query at all: seabed.js:82 folds the
        // head mask into the height field, so `seabedHeight` already rises
        // under one and the clearance clears it. That is where the "flowing
        // over the reef" comes from, for free.
        if (((frame + si) & 1) === 0) {
          const k = sk.probe & 3;
          const a = (k / 4) * TAU;
          const h = seabed(sk.cx + Math.cos(a) * sk.radius, sk.cz + Math.sin(a) * sk.radius);
          sk.ring[k] = Number.isFinite(h) ? h : -20;
          sk.probe++;
        }
        const hC = Number.isFinite(sbA) ? sbA : -20;
        sk.floorY = hC;
        // gx = (east - west) / 2R, gz = (south - north) / 2R. Clamped, because a
        // ring sample that lands on a coral head gives a gradient that would
        // fling the shoal sideways.
        const invR = 1 / (2 * Math.max(0.5, sk.radius));
        sk.floorGX = clamp((sk.ring[0] - sk.ring[2]) * invR, -1.5, 1.5);
        sk.floorGZ = clamp((sk.ring[1] - sk.ring[3]) * invR, -1.5, 1.5);
        // The highest seabed anywhere in the neighbourhood. The plane fit is an
        // estimate; this is the number that guarantees a fish never ends up
        // inside a feature the plane missed.
        let hMax = hC;
        for (let k = 0; k < 4; k++) if (sk.ring[k] > hMax) hMax = sk.ring[k];
        // A 60 s soak put a damsel 0.038 m off the sand: the plane fit was 0.38 m
        // optimistic where the ring straddled a coral head. 0.15 m of slack
        // instead of 0.30, with the post-integration clamp at 0.75 of clearance
        // rather than 0.6, buys that back and still lets a reef species hug the
        // structure it is supposed to be hugging.
        sk.floorHard = hMax - 0.15;

        // ---- the band ----------------------------------------------------
        // ONE sampleHeight per shoal per frame for a 'ride' species — see
        // RIDE_MARGIN for why the band follows the surface instead of sitting
        // at a fixed y, and for where the 0.26 came from. Everyone else pays
        // nothing: `isRide` is false and the call never happens.
        let surfY = 0;
        let ceilNow = ceilY;
        if (isRide) {
          surfY = fSurf ? fSurf(sk.cx, sk.cz, t) : 0;
          sk.surfY = surfY;
          const rideCeil = surfY - RIDE_MARGIN;
          ceilNow = rideCeil < ceilY ? rideCeil : ceilY;
        }
        const wob = Math.sin(sk.w5 * t + sk.p5) * sk.bandHalf * 0.55;
        const bandMid = (spec.band[0] + spec.band[1]) * 0.5;
        let bandY = isFloor ? hC + bandMid + wob
          : (isRide ? surfY - bandMid + wob : -bandMid + wob);
        const bandFloor = hC + clearance + 0.25;
        if (bandY < bandFloor) bandY = bandFloor;
        // The pad under the ceiling is 0.2 m for a species whose band is 1.6-3.9 m
        // deep and 0.06 for one whose whole band is 0.38 m — 0.2 there would
        // collapse the band onto its own floor every time a crest went past.
        const ceilPad = isRide ? 0.06 : 0.2;
        if (bandY > ceilNow - ceilPad) bandY = ceilNow - ceilPad;
        sk.bandY = bandY;

        // ---- centroid and mean velocity ----------------------------------
        // Cohesion is against the CENTROID, not a local neighbourhood. That is
        // the term that is O(N^2) in textbook boids and collapses to O(N) here,
        // because a school is a coherent blob by construction. It is also what
        // closes the school back up after the boat has driven through it.
        let cx = 0, cz = 0, cy = 0;
        for (let i = base; i < base + n; i++) { cx += rec.px[i]; cy += rec.py[i]; cz += rec.pz[i]; }
        cx /= n; cy /= n; cz /= n;
        sk.cx = cx; sk.cz = cz;
        const tgtX = cx + (sk.ax - cx) * COH_ANCHOR;
        const tgtZ = cz + (sk.az - cz) * COH_ANCHOR;
        const tgtY = cy + (bandY - cy) * COH_ANCHOR;

        // ---- who is close enough to be scared ----------------------------
        const dbx = cx - bx, dbz = cz - bz;
        const dBoat2 = dbx * dbx + dbz * dbz;
        // A startle species uses the corridor, whose reach is `lead` and whose
        // width is `half`; the classic species use the fixed FLEE_R disc. Both
        // culls are the same shape, so this is one radius that depends on which.
        const nearR = K_ST ? (lead + sk.radius + K_ST.half) : (FLEE_R + sk.radius + 4);
        const boatNear = dBoat2 < nearR * nearR;
        const dmx = cx - mx, dmy = cy - my, dmz = cz - mz;
        const monNear = mon && (dmx * dmx + dmy * dmy + dmz * dmz)
          < (MON_R + sk.radius) * (MON_R + sk.radius);

        sk.panic += (1 - sk.panic) * Math.min(1, dt * 0.8);
        if (monBig && monNear) sk.panic = S.panic;
        const vCap = S.vMax * sk.panic;

        // ---- nervous water over a shoal the boat is bearing down on -------
        // This is the part that makes the event legible at ranges where the
        // ANIMAL is not, because it sits on the boundary the eye is already
        // reading. wake.js zeroes the arm field every sim step, so an arm stamp
        // can never stain the way a re-stamped height/foam ring would, and its
        // `armEdge` term gives it a bright thinning rim — a moving patch of
        // bright-edged nervous water over the shoal for two array writes.
        // Capped at ARM_MAX = 2 a frame against wake.js's PENDING_ARM_MAX = 32,
        // so the boat's own arms keep their headroom (hard constraint 5).
        // Only AHEAD, though: the disc above is centred on the boat, and a
        // patch of nervous water appearing over a shoal the boat has already
        // gone past reads as a wake artefact rather than as a cause.
        if (fArm && K_ST && boatNear && armBudget > 0 && bSpeed > 0.6
          && (dbx * dirX + dbz * dirZ) > -3) {
          fArm(sk.cx, sk.cz, 0.85, sk.radius * 1.3);
          armBudget--;
        }

        const stride = sk.stride;
        const skew = n > 1 ? frame % n : 0;
        const K = Math.min(S.k, n - 1);

        for (let i = base; i < base + n; i++) {
          const px = rec.px[i], py = rec.py[i], pz = rec.pz[i];
          let ax = 0, ay = 0, az = 0;
          let vx, vy, vz, nx, ny, nz, sp;
          // Airborne fish pitch nose-up on the way out and nose-down on the way
          // in, and that reading is worth more than any amount of texture — so
          // they get 1.15 rad of pitch where a swimming fish gets the 0.44 the
          // lateral-bend approximation in positionNode is only valid to.
          let pitchLimit = 0.44;

          // ================= the ballistic branch ==========================
          // A fish that has left the shoal on a jump integrates under gravity
          // ONLY: no separation, no alignment, no cohesion, no floor, no depth
          // keeping, no wander. One branch, and it takes the fish out of the
          // expensive inner loop for half a second.
          // 1 = launched and still under the surface, 2 = airborne. 3 is a
          // SWIMMING state — "jump already spent" — and must not take the
          // ballistic path.
          const airState = airArr ? airArr[i] : 0;
          if (airState === 1 || airState === 2) {
            vx = rec.vx[i];
            vy = rec.vy[i] - 9.81 * dt;
            vz = rec.vz[i];
            nx = px + vx * dt; ny = py + vy * dt; nz = pz + vz * dt;
            // The surface the shoal is riding. Using the shoal's sample rather
            // than the fish's own is the same per-SCHOOL discipline as the
            // terrain plane, and the worst measured disagreement over a 2 m
            // offset is 0.218 m — under a wave crest, not enough to make an
            // exit look like it happened in mid-air.
            if (airState === 1) {
              // Launched, still climbing through the water. Breaking the
              // surface is what stamps the ring.
              if (ny >= surfY) {
                airArr[i] = 2;
                if (fDisturb && stampBudget > 0) { fDisturb(nx, nz, 0.30, 0.55); stampBudget--; }
              } else if (vy < 0 && ny <= surfY - RIDE_MARGIN) {
                // Never made it out — the shoal was in a trough, or the fish
                // launched into the back of a crest. Hand it back rather than
                // leaving it falling in state 1 forever. Still counts as spent,
                // or it re-rolls the same hash next frame and pogos under the
                // surface.
                airArr[i] = 3;
              }
            } else if (ny <= surfY) {
              // Re-entry. Stamp again, kill the plunge so the fish does not
              // porpoise straight down through its own shoal, and put it back
              // at the ride ceiling rather than just under the surface — one
              // frame above -0.12 is one frame of an upside-down fish in the
              // reflection target (clip.js SEAM).
              airArr[i] = 3;
              if (fDisturb && stampBudget > 0) { fDisturb(nx, nz, 0.30, 0.55); stampBudget--; }
              if (vy < -1.4) vy = -1.4;
              ny = surfY - RIDE_MARGIN;
            }
            if (airArr[i] === 1 || airArr[i] === 2) pitchLimit = 1.15;
            sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
            // The impulse keeps decaying while the fish is in the air, so it
            // lands already coasting instead of bolting a second time.
            if (stArr) stArr[i] *= stDecay;
            rec.px[i] = nx; rec.py[i] = ny; rec.pz[i] = nz;
            rec.vx[i] = vx; rec.vy[i] = vy; rec.vz[i] = vz;
            writePose(rec, mArr, aArr, i, nx, ny, nz, vx, vy, vz, sp, pitchLimit, S, dt);
            continue;
          }

          // 1+2. Separation and alignment over K sampled school-mates. No sqrt:
          // the (rSep2/d2 - 1) falloff is 0 at the radius and grows without
          // bound at contact, which is exactly what separation wants.
          if (K > 0) {
            let sumVX = 0, sumVY = 0, sumVZ = 0;
            const local = i - base;
            for (let k = 1; k <= K; k++) {
              const j = base + ((local + k * stride + skew) % n);
              const dx = px - rec.px[j], dy = py - rec.py[j], dz = pz - rec.pz[j];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < rSep2 && d2 > 1e-6) {
                const f = S.wSep * (rSep2 / d2 - 1);
                ax += dx * f; ay += dy * f; az += dz * f;
              }
              sumVX += rec.vx[j]; sumVY += rec.vy[j]; sumVZ += rec.vz[j];
            }
            const inv = 1 / K;
            ax += (sumVX * inv - rec.vx[i]) * S.wAli;
            ay += (sumVY * inv - rec.vy[i]) * S.wAli;
            az += (sumVZ * inv - rec.vz[i]) * S.wAli;
          }

          // 3. Cohesion, toward the centroid blended with the anchor.
          ax += (tgtX - px) * S.wCoh;
          ay += (tgtY - py) * S.wCoh * 0.5;
          az += (tgtZ - pz) * S.wCoh;

          // 4. Wander. One INTEGRATED angle per fish, not a per-frame hash —
          // hashed wander is jitter, an integrated angle is a fish making up its
          // mind.
          const wa = rec.wang[i] + rec.wrate[i] * dt;
          rec.wang[i] = wa;
          ax += Math.cos(wa) * S.wWander;
          ay += Math.sin(wa * 0.7) * S.wWander * 0.35;
          az += Math.sin(wa) * S.wWander;

          // 5. Depth keeping, against the school's band plus this fish's own
          // offset so the shoal has thickness.
          const wantY = bandY + rec.yOff[i];
          ay += (wantY - py) * S.wDepth;

          // ---- flee, BEFORE the floor term so a panicking school cannot be
          // driven into the sand by its own escape ------------------------
          //
          // startleBlock. A species that declares `startle` does NOT also run
          // the radial flee below: running both gives a fish two escape
          // directions that partially cancel, and the radial one is actively
          // wrong up here. `ay -= g * 0.30` ducks the fish DOWNWARD, which is
          // right for a school at four metres — from the ref/04 overhead
          // framing ducking reads where scattering does not — and catastrophic
          // for a surface shoal, because down is out of the only band where it
          // is visible at all. The other half of the failure is that a radial
          // push from the boat CENTRE accelerates a fish dead ahead straight
          // down the bow line, so it stays ahead, is caught again next frame,
          // and gets bulldozed forward for as long as the throttle is held.
          // That is why nothing ever comes down the side.
          //
          // So: a swept CORRIDOR in boat-local coordinates with a LATERAL
          // escape. A fish leaves by the shortest route and is never
          // re-triggered.
          if (K_ST) {
            let s0 = stArr[i];
            if (boatNear && s0 < 0.05) {
              const rx = px - bx, rz = pz - bz;
              const f = rx * dirX + rz * dirZ;              // + = ahead
              const sL = rx * rgtX + rz * rgtZ;             // + = to starboard
              // half 3.2 m is the 1.9 m beam plus about 1.5 m of bow wave each
              // side. Narrower and the arms pass under the hull; wider and they
              // break before the player is close enough to own it.
              if (f > 0 && f < lead && sL * sL < half2) {
                s0 = 1;
                // Ties on the centreline are broken by a hash of the instance
                // index, so a fish exactly ahead picks a side instead of
                // dithering between two equal escapes for a frame each.
                const side = Math.abs(sL) < 0.05
                  ? (hash3(i, 7, 13) < 0.5 ? -1 : 1)
                  : (sL >= 0 ? 1 : -1);
                // The small forward term matters. A purely lateral throw reads
                // as a plough shoving things aside; a little forward reads as
                // fleeing. The up term is what lifts them into the top 20 cm.
                let ex = rgtX * K_ST.side * side + dirX * K_ST.ahead;
                let ez = rgtZ * K_ST.side * side + dirZ * K_ST.ahead;
                const el = Math.max(1e-4, Math.hypot(ex, ez));
                ex /= el; ez /= el;
                exArr[i] = ex; eyArr[i] = K_ST.up; ezArr[i] = ez;
                if (sk.panic < S.panic) sk.panic = S.panic;
              }
            }

            // ---- and about a third of them leave the water ----------------
            // The element that clears every legibility problem at once. A 1.9 m
            // arc at 13 m from the eye is 124 px long and 23 px high against a
            // 22 px fish: FIVE TIMES THE ANIMAL. `jumpV` is measured from the
            // BAND, not from the surface — the fish is ~0.47 m down and has to
            // climb that before any of the arc is visible, so 3.90 m/s here is
            // 2.64 m/s at the surface, a 0.36 m apex and 0.54 s of airtime.
            //
            // This is a SEPARATE, LATER trigger than the bolt above, and that
            // is measured. Rolling the jump at the moment a fish enters the
            // bolt corridor put the whole shower 8.6 m ahead of the boat at
            // 5.5 m/s — 21 m from the eye, where the arc is 68 px instead of
            // 100 and the boat is nowhere near it. `jumpLead` is half the bolt
            // lead, so the shower goes up 3-4 m off the bow: 16-17 m from the
            // eye, the peak-legibility band, and unmistakably caused by the
            // hull that is about to arrive. `jumpHalf` is WIDER than the bolt
            // corridor because the fish being tested bolted 2-3 m sideways a
            // second ago and a 3.2 m box would no longer contain them.
            //
            // Not all of them — see `jumpP` for the measurement that set the
            // fraction. The bolters are the shoal; the jumpers are what the
            // player actually sees.
            //
            // `air === 3` is "swimming, jump already spent". Without it a fish
            // that lands still inside the box re-rolls the same hash the next
            // frame and pogos.
            if (canJump && airArr[i] === 0 && boatNear && hash3(i, 31, 5) < K_ST.jumpP) {
              const rx = px - bx, rz = pz - bz;
              const f = rx * dirX + rz * dirZ;
              const sL = rx * rgtX + rz * rgtZ;
              if (f > -1.0 && f < jumpLead && sL * sL < jumpHalf2) {
                const side = Math.abs(sL) < 0.05
                  ? (hash3(i, 7, 13) < 0.5 ? -1 : 1)
                  : (sL >= 0 ? 1 : -1);
                let ex = rgtX * K_ST.side * side + dirX * K_ST.ahead;
                let ez = rgtZ * K_ST.side * side + dirZ * K_ST.ahead;
                const el = Math.max(1e-4, Math.hypot(ex, ez));
                const h = hash3(i, 3, 91);
                const run = (K_ST.jumpRun[0] + K_ST.jumpRun[1] * h) / el;
                rec.vx[i] = ex * run;
                rec.vz[i] = ez * run;
                rec.vy[i] = K_ST.jumpV[0] + K_ST.jumpV[1] * h;
                airArr[i] = 1;
                if (sk.panic < S.panic) sk.panic = S.panic;
              }
            } else if (!boatNear && airArr[i] === 3) {
              // Out of range again: re-arm for the next boat.
              airArr[i] = 0;
            }
            // Impulse, not force. A sustained force ties escape speed to how
            // long you loiter, so idling beside a shoal accelerates it forever;
            // an impulse with a 0.55 s e-fold gives snap-then-coast and lets
            // the cohesion term close the school back up astern, which is half
            // the pleasure. 26 m/s^2 reaches the 5.4 m/s cap in ~0.21 s and
            // displaces ~3.5 m in the first second — comfortably out of a 3.2 m
            // half-corridor from anywhere inside it.
            if (s0 > 1e-3) {
              const g = K_ST.imp * s0 * stGate;
              ax += exArr[i] * g;
              ay += eyArr[i] * g;
              az += ezArr[i] * g;
              stArr[i] = s0 * stDecay;
            } else if (s0 !== 0) {
              stArr[i] = 0;
            }
          } else if (boatNear) {
            const dx = px - bx, dz = pz - bz;
            const d2 = dx * dx + dz * dz;
            if (d2 < FLEE_R * FLEE_R) {
              const inv = 1 / Math.sqrt(d2 + 0.05);
              // A fish six metres down barely notices a hull.
              const vert = 1 - clamp((by - py) / 6.5, 0, 1);
              const g = W_FLEE * (FLEE_R * inv - 1) * vert * bWeight;
              ax += dx * inv * g;
              az += dz * inv * g;
              // Down, not just sideways: a real school ducks under a hull, and
              // from the overhead framing ducking reads where scattering does
              // not.
              ay -= g * 0.30;
              if (sk.panic < S.panic) sk.panic = S.panic;
            }
          }
          if (monNear) {
            const dx = px - mx, dy = py - my, dz = pz - mz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < MON_R * MON_R) {
              const inv = 1 / Math.sqrt(d2 + 0.5);
              const g = W_MON * (MON_R * inv - 1);
              ax += dx * inv * g; ay += dy * inv * g; az += dz * inv * g;
              if (sk.panic < S.panic) sk.panic = S.panic;
              // The leviathan gets the shoal for free: a surface shoal showering
              // as he passes underneath welds two systems the player already
              // connects, and it is the same impulse the bow uses. Jumping needs
              // no boat speed here — the trigger IS the monster.
              if (K_ST && stArr[i] < 0.05) {
                const hl2 = Math.max(1e-4, Math.hypot(dx, dz));
                stArr[i] = 1;
                exArr[i] = dx / hl2; eyArr[i] = K_ST.up * 1.4; ezArr[i] = dz / hl2;
                if (monBig && hash3(i, 17, 41) < K_ST.jumpP) {
                  const h = hash3(i, 3, 91);
                  rec.vx[i] = dx / hl2 * (K_ST.jumpRun[0] + K_ST.jumpRun[1] * h);
                  rec.vz[i] = dz / hl2 * (K_ST.jumpRun[0] + K_ST.jumpRun[1] * h);
                  rec.vy[i] = K_ST.jumpV[0] + K_ST.jumpV[1] * h;
                  airArr[i] = 1;
                }
              }
            }
          }

          // Launched THIS frame, by the bow or by the leviathan. Everything
          // above computed accelerations for a fish that is no longer in the
          // shoal, so drop them on the floor and go ballistic from here — in
          // particular the surface clamp at the bottom of this loop would
          // otherwise slam the fish straight back under before the arc began.
          if (airArr && airArr[i] === 1) {
            vx = rec.vx[i]; vy = rec.vy[i]; vz = rec.vz[i];
            nx = px + vx * dt; ny = py + vy * dt; nz = pz + vz * dt;
            sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
            rec.px[i] = nx; rec.py[i] = ny; rec.pz[i] = nz;
            writePose(rec, mArr, aArr, i, nx, ny, nz, vx, vy, vz, sp, 1.15, S, dt);
            continue;
          }

          // 6. Floor. The fitted plane, never below the worst sample seen.
          let floorY = sk.floorY + sk.floorGX * (px - cx) + sk.floorGZ * (pz - cz);
          if (floorY < sk.floorHard) floorY = sk.floorHard;
          const gap = py - (floorY + clearance);
          if (gap < 0) ay -= gap * S.wFloor;

          // ...and go round it, not just over it. The water column here is
          // (FISH_CEIL - floorY); when that is too thin to hold the fish, steer
          // downhill along the negative of the fitted gradient. This is the
          // "swimming around objects" beat, and it costs four multiplies
          // because the gradient was already paid for by the floor term.
          // The reference ceiling is the species', not the global one: a 'ride'
          // species' own ceiling is ~0.6 m higher than FISH_CEIL, so using
          // FISH_CEIL here would make it think the column was thinner than it
          // is and steer it downhill off perfectly good reef flats.
          const colH = (isRide ? ceilNow : FISH_CEIL) - floorY;
          const wantCol = clearance + 0.9;
          if (colH < wantCol) {
            const g = (wantCol - colH) * 3.0;
            ax -= sk.floorGX * g;
            az -= sk.floorGZ * g;
          }

          // ---- integrate ---------------------------------------------------
          vx = rec.vx[i] + ax * dt;
          vy = rec.vy[i] + ay * dt;
          vz = rec.vz[i] + az * dt;
          const damp = 1 - Math.min(0.9, S.drag * dt);
          vx *= damp; vy *= damp; vz *= damp;
          const sp2 = vx * vx + vy * vy + vz * vz;
          sp = Math.sqrt(sp2);
          if (sp > vCap) { const f = vCap / sp; vx *= f; vy *= f; vz *= f; sp = vCap; }
          else if (sp < S.vMin && sp > 1e-5) { const f = S.vMin / sp; vx *= f; vy *= f; vz *= f; sp = S.vMin; }

          nx = px + vx * dt;
          ny = py + vy * dt;
          nz = pz + vz * dt;

          // Hard clamp after integration. wFloor at 6-7 against a peak flee
          // acceleration of ~26 is not enough on its own; this is what actually
          // guarantees no fish is ever inside the sand or out in the air.
          // `ceilNow` is the species' ceiling for everyone except a 'ride'
          // species, where it is the local water surface less RIDE_MARGIN —
          // this line is what actually keeps a surface shoal wet through a
          // trough that the band term only aims at.
          const lo = floorY + clearance * 0.75;
          if (ny < lo) { ny = lo; if (vy < 0) vy = 0; }
          if (ny > ceilNow) { ny = ceilNow; if (vy > 0) vy = 0; }

          rec.px[i] = nx; rec.py[i] = ny; rec.pz[i] = nz;
          rec.vx[i] = vx; rec.vy[i] = vy; rec.vz[i] = vz;

          writePose(rec, mArr, aArr, i, nx, ny, nz, vx, vy, vz, sp, pitchLimit, S, dt);
        }
      }
      rec.mesh.instanceMatrix.needsUpdate = true;
      rec.attr.needsUpdate = true;
    }
  }

  function faceAlong(vx, vy, vz, out) {
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-5) { out.set(0, 0, 0); return out; }
    return out.set(Math.asin(clamp(vy / len, -1, 1)), Math.atan2(-vx, -vz), 0);
  }

  function writeJumper(x, y, z, yaw, pitch, sc) {
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    jmat[0] = sc * ca; jmat[1] = 0; jmat[2] = -sc * sa;
    jmat[4] = sc * sa * sp; jmat[5] = sc * cp; jmat[6] = sc * ca * sp;
    jmat[8] = sc * sa * cp; jmat[9] = -sc * sp; jmat[10] = sc * ca * cp;
    jmat[12] = x; jmat[13] = y; jmat[14] = z;
    jumperA[2] = ca;
    jumperA[3] = sa;
    jumper.instanceMatrix.needsUpdate = true;
    jumperAttr.needsUpdate = true;
  }

  function update(ctx) {
    const t = ctx.time;
    const dt = ctx.dt;

    updateFish(ctx);

    // ---- gulls -----------------------------------------------------------
    if (gulls.visible) {
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        b.ang += b.omega * dt;
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
    }

    // ---- the jumper ------------------------------------------------------
    const water = ctx.water;
    jump.beat += dt * (jump.active ? 16 : 5.5);
    if (jump.beat > TAU) jump.beat -= TAU * Math.floor(jump.beat / TAU);
    jumperA[0] = jump.beat;
    if (jump.active) {
      jump.t += dt;
      const u = jump.t / jump.dur;
      if (u >= 1) {
        jump.active = false;
        jump.wait = 14 + rng.range(0, 34);
        if (water && water.disturb) water.disturb(jump.x1, jump.z1, 1.5, 2.6);
        const b = ctx.boat;
        pickJumpSite(b ? b.position.x : 0, b ? b.position.z : 0);
      } else {
        const x = jump.x0 + (jump.x1 - jump.x0) * u;
        const z = jump.z0 + (jump.z1 - jump.z0) * u;
        const y = jump.apex * 4 * u * (1 - u);
        // Velocity of that parabola, for the pitch. dy/du = apex*4*(1-2u).
        const vy = jump.apex * 4 * (1 - 2 * u) / jump.dur;
        const vx = (jump.x1 - jump.x0) / jump.dur;
        const vz = (jump.z1 - jump.z0) / jump.dur;
        faceAlong(vx, vy, vz, _v);
        writeJumper(x, y - 0.06, z, _v.y, _v.x, JUMP_SCALE);
        if (!jump.exited && u > 0.04) {
          jump.exited = true;
          if (water && water.disturb) water.disturb(jump.x0, jump.z0, 1.2, 2.2);
        }
      }
    } else {
      jump.wait -= dt;
      // Loitering. A slow circle a metre or two under the surface, at the exact
      // spot the next leap starts from, so the arc never begins with a teleport.
      jump.idleAng += dt * 0.55;
      const r = 1.6;
      const x = jump.x0 + Math.cos(jump.idleAng) * r;
      const z = jump.z0 + Math.sin(jump.idleAng) * r;
      const y = jump.y + Math.sin(jump.idleAng * 1.7) * 0.25;
      writeJumper(x, y, z, Math.atan2(Math.sin(jump.idleAng), Math.cos(jump.idleAng)) - Math.PI * 0.5,
        0, JUMP_SCALE * 0.55);
      if (jump.wait <= 0) {
        jump.t = 0;
        jump.active = true;
        jump.exited = false;
      }
    }
  }

  // ======================================================== actors ===========
  //
  // A pool of fish that somebody ELSE poses, frame by frame. The fishing game
  // needs animals it can steer — turn one toward a lure, make it circle,
  // spook it, drag it up on a line — and none of that belongs in a boids
  // module whose whole job is that nothing steers an individual.
  //
  // What it does NOT do is build a second kind of fish. Same SPECIES table,
  // same buildCreature, same fishMat, same aFish convention, same layers and
  // the same waterline clip — so a fish on the end of a line is one of the
  // animals swimming past it, not a lookalike that has to be kept in sync by
  // hand. The pool is built at boot and drawn from the first frame for the
  // reason the jumper is (see its comment): an InstancedMesh that is never
  // drawn has no pipeline, and building one mid-game is a synchronous compile
  // on the WebGPU backend. They idle parked far below the seabed where nothing
  // occludes them into view, at a cost of `count` degenerate instances.
  const PARK_Y = -140;
  const actorPools = [];

  function createActors(key, count) {
    const spec = SPECIES.find((s) => s.key === key) || SPECIES[0];
    const geo = buildCreature(
      spec, lerpI(spec.radial[0], spec.radial[1]), wingRows, withPect, spec.bright || 1,
    );
    const arr = new Float32Array(count * 4);
    const attr = new THREE.InstancedBufferAttribute(arr, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFish', attr);

    const mesh = new THREE.InstancedMesh(geo, fishMat, count);
    mesh.name = 'actor-' + spec.key;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const m = mesh.instanceMatrix.array;
    for (let i = 0; i < count; i++) {
      const o = i * 16;
      m[o] = 1; m[o + 5] = 1; m[o + 10] = 1; m[o + 15] = 1;
      m[o + 13] = PARK_Y;
      // Beat amplitude in world metres, with the instance scale folded in — the
      // shader cannot see the matrix. Rewritten by setScale below.
      arr[i * 4 + 1] = spec.amp * spec.len;
      arr[i * 4 + 2] = 1;
      _c.setHSL(
        rng.range(spec.tint.h[0], spec.tint.h[1]),
        rng.range(spec.tint.s[0], spec.tint.s[1]),
        rng.range(spec.tint.l[0], spec.tint.l[1]), SRGB,
      );
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    setLayers(mesh, LAYER.MAIN, LAYER.UNDERWATER, LAYER.REFLECTED);
    // A hooked fish comes out of the water at the end, so it crosses the
    // waterline exactly like the jumper does.
    applyWaterClip(mesh);
    const pool = {
      key: spec.key,
      len: spec.len,
      count,
      spec,
      /** Beat rate this species swims at, for the caller's phase accumulator. */
      beatRate: (spec.beat[0] + spec.beat[1]) * 0.5,
      /** Pose one fish. Angles in radians, `sc` a multiplier on spec.len. */
      set(i, x, y, z, yaw, pitch, sc, beatPhase, amp) {
        const o = i * 16;
        const ca = Math.cos(yaw), sa = Math.sin(yaw);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        m[o] = sc * ca; m[o + 1] = 0; m[o + 2] = -sc * sa;
        m[o + 4] = sc * sa * sp; m[o + 5] = sc * cp; m[o + 6] = sc * ca * sp;
        m[o + 8] = sc * sa * cp; m[o + 9] = -sc * sp; m[o + 10] = sc * ca * cp;
        m[o + 12] = x; m[o + 13] = y; m[o + 14] = z;
        const a = i * 4;
        arr[a] = beatPhase;
        arr[a + 1] = (amp ?? spec.amp) * spec.len * sc * envAmp;
        arr[a + 2] = ca;
        arr[a + 3] = sa;
      },
      /** Send one back to the car park. Cheaper than toggling visibility. */
      park(i) {
        const o = i * 16;
        m[o] = 1; m[o + 1] = 0; m[o + 2] = 0;
        m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0;
        m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1;
        m[o + 12] = 0; m[o + 13] = PARK_Y; m[o + 14] = 0;
      },
      /** Once per frame, after the last set()/park(). */
      flush() {
        mesh.instanceMatrix.needsUpdate = true;
        attr.needsUpdate = true;
      },
      mesh,
      dispose() {
        group.remove(mesh);
        mesh.dispose();
        geo.dispose();
      },
    };
    actorPools.push(pool);
    return pool;
  }

  function applyEnv(env) {
    if (!env) return;

    // Fish are lit by the same water light the reef is, and never allowed to
    // fall to black under the moon.
    //
    // The daytime coefficient stays at the shipped 0.05. Raising it to 0.10 was
    // tried and it is actively wrong in daylight: `waterScatter` is the water's
    // own in-scattered turquoise, so more of it paints the fish the exact colour
    // of the background they have to stand out against. A capture at 11 m with
    // 0.10 showed the sardines as a faint speckle. The NIGHT half is raised
    // instead, from 0.10 to 0.17, because that is the case the floor exists for.
    fishMat.emissive.copy(env.waterScatter).multiplyScalar(0.05 + 0.17 * env.nightFactor);
    envAmp = 0.86 + 0.34 * env.dayFactor;
    envRate = 0.86 + 0.28 * env.dayFactor;

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
  }

  function dispose() {
    for (const pool of actorPools) pool.dispose();
    actorPools.length = 0;
    for (const rec of kinds) { rec.mesh.dispose(); rec.geo.dispose(); }
    kinds.length = 0;
    jumper.dispose();
    jumperGeo.dispose();
    fishMat.dispose();
    gullGeo.dispose();
    gullMat.dispose();
    gulls.dispose();
    group.clear();
  }

  return { group, update, applyEnv, dispose, createActors, species: SPECIES,
    tex: { uScaleFreq, uScaleAmp } };
}
