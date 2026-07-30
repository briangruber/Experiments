// The bay of Salty Fin, built entirely from primitives.
//
// Two meshes come out of here: everything the main pass draws (village, docks,
// islands, trees) and everything the refraction pass draws (the bed, the kelp,
// the submerged half of the pilings and rocks). A handful of props are in both
// because they cross the waterline.
//
// Layout, looking down (+x east, +z south):
//
//        -z   .. lighthouse island (95,-70), rock stacks
//   village along x=-46, quay running north-south, open bay to the east
//        +z   .. a couple of outer skerries
//
// Distances are metres. The dock deck is 1.55m over the water; a person is
// 1.7m; the dinghy is 3.6m long. Keeping to real scale is what makes a chunky,
// stylised model read as a place rather than a toy.

import { MeshBuilder, uploadMesh, shade } from './geom.js';
import { mulberry32, smoothstep } from '../src/math.js';

// ---------------------------------------------------------------- palette
export const PAL = {
  sand: '#cbb589', sandDark: '#a8926a', bedRock: '#6f7d6c', bedWeed: '#31573e',
  kelp: '#2f6b52', kelpLight: '#4c8a5c', coral: '#c9705f',
  plank: '#b8874f', plankDark: '#8d6237', plankPale: '#cfa270',
  post: '#7b5936', postWet: '#5d4630',
  plaster: '#f2ead6', plaster2: '#e6dcc2', timber: '#6b4a30',
  roofRed: '#b4453c', roofTeal: '#3f8f8b', roofBlue: '#3c6fa8', roofOchre: '#c98a3e',
  stone: '#9aa0a2', stoneDark: '#6f7679',
  rock: '#a39a88', rockDark: '#82796b', grass: '#6cb254', grassDark: '#4a8c40',
  pine: '#39794c', pineDark: '#2b6040', trunk: '#5b4128',
  white: '#f6f6f2', red: '#c9453e', glass: '#8fd3e8', lamp: '#ffcf7a',
  awningA: '#e4e0d2', awningB: '#c8503f', awningC: '#3f8f8b',
  rope: '#c3ae7f', tire: '#3a3a3c', metal: '#5f6b72',
};

// ---------------------------------------------------------------- noise
const rnd = mulberry32(20260730);
const H = new Float32Array(4096);
for (let i = 0; i < H.length; i++) H[i] = rnd();
const hash2 = (x, y) => H[(((x * 374761393 + y * 668265263) >>> 0) % 4096)];
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm2(x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); f *= 2.07; a *= 0.5; }
  return s;
}

// ---------------------------------------------------------------- terrain
// Islands are mounds in the bed; the faceted rock stacks are modelled on top
// so the silhouette stays sharp where it matters, at the waterline.
export const ISLANDS = [
  { x: 96, z: -74, r: 21, h: 12.5, kind: 'lighthouse' },
  { x: 34, z: -104, r: 17, h: 10.0, kind: 'pines' },
  { x: 132, z: -6, r: 15, h: 8.0, kind: 'pines' },
  { x: -6, z: -142, r: 13, h: 7.0, kind: 'bare' },
  { x: 74, z: 84, r: 11, h: 5.5, kind: 'bare' },
];

const QUAY_X = -44;          // the quay's seaward edge
const QUAY_Z0 = -46, QUAY_Z1 = 34;

export function bedHeight(x, z) {
  // Shelf: shallow along the quay, dropping away to the east and the south.
  const fromQuay = x - QUAY_X;
  let y = -1.9 - 11.5 * smoothstep(0, 150, fromQuay) - 5 * smoothstep(40, 260, Math.hypot(x, z));
  y += (fbm2(x * 0.035 + 12.3, z * 0.035 - 4.1, 4) - 0.5) * 3.4;
  y += (fbm2(x * 0.11, z * 0.11, 2) - 0.5) * 0.8;

  // land behind the village so the shore reads as a coast, not a wall
  y += 9.5 * smoothstep(6, -22, fromQuay);

  for (const I of ISLANDS) {
    const d = Math.hypot(x - I.x, z - I.z);
    const t = smoothstep(I.r * 2.6, I.r * 0.55, d);
    y += (I.h * 0.55 + 3.5) * t;
  }
  return y;
}

// ---------------------------------------------------------------- pixel font
// 3x5 glyphs, painted as little cubes. Signwriting by hand, effectively.
const FONT = {
  A: '111101111101101', B: '110101110101110', C: '111100100100111', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '111100101101111', H: '101101111101101',
  I: '111010010010111', J: '001001001101111', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '101111111111101', O: '111101101101111', P: '111101111100100',
  Q: '111101101111011', R: '111101110101101', S: '111100111001111', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101111010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111',
  '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
  '6': '111100111101111', '7': '111001001010010', '8': '111101111101111', '9': '111101111001111',
  '.': '000000000000010', "'": '010010000000000', '-': '000000111000000', ' ': '000000000000000',
};

export function pixelText(m, text, size, thick, col, { center = true } = {}) {
  const chars = [...text.toUpperCase()];
  const w = chars.length * 4 - 1;
  const x0 = center ? -w * size / 2 : 0;
  chars.forEach((ch, ci) => {
    const g = FONT[ch];
    if (!g) return;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (g[r * 3 + c] !== '1') continue;
        m.save();
        m.translate(x0 + (ci * 4 + c) * size + size / 2, (4 - r) * size + size / 2, 0);
        m.box(size * 1.04, size * 1.04, thick, col);
        m.restore();
      }
    }
  });
  return m;
}

// ---------------------------------------------------------------- props
function plankDeck(m, w, d, { plank = 0.34, gap = 0.03, thick = 0.14, along = 'z', seed = 1 } = {}) {
  const r = mulberry32(seed);
  const n = Math.floor((along === 'z' ? w : d) / (plank + gap));
  for (let i = 0; i < n; i++) {
    const off = (i + 0.5) * (plank + gap) - (along === 'z' ? w : d) / 2;
    const k = (r() - 0.5) * 0.26;
    const col = shade(r() < 0.22 ? PAL.plankDark : PAL.plank, k * 0.5);
    m.save();
    if (along === 'z') m.translate(off, 0, 0), m.box(plank, thick, d, col);
    else m.translate(0, 0, off), m.box(w, thick, plank, col);
    m.restore();
  }
}

function piling(m, x, z, top, { r = 0.28, tilt = 0 } = {}) {
  m.save();
  m.translate(x, -9, z);
  m.rotZ(tilt);
  m.cyl([r * 1.14, r], top + 9, 7, PAL.post, { capTop: true });
  m.restore();
  // a wet, weeded band right at the waterline reads as tide
  m.save();
  m.translate(x, -0.55, z);
  m.cyl([r * 1.2, r * 1.14], 1.0, 7, PAL.postWet, { capTop: false });
  m.restore();
}

function tire(m, x, y, z, rot = 0) {
  m.save();
  m.translate(x, y, z);
  m.rotY(rot);
  m.rotX(Math.PI / 2);
  m.torus(0.42, 0.15, 10, 6, PAL.tire);
  m.restore();
}

function lantern(m, x, y, z, s = 1) {
  m.save();
  m.translate(x, y, z);
  m.scale(s);
  m.box(0.1, 0.5, 0.1, PAL.metal);
  m.save(); m.translate(0, -0.42, 0);
  m.box(0.34, 0.12, 0.34, PAL.metal);
  m.translate(0, -0.26, 0);
  m.box(0.30, 0.42, 0.30, PAL.lamp, { emis: 1.35 });
  m.translate(0, -0.28, 0);
  m.box(0.36, 0.10, 0.36, PAL.metal);
  m.restore();
  m.restore();
}

function crate(m, x, y, z, s, rot, col = PAL.plank) {
  m.save();
  m.translate(x, y + s / 2, z); m.rotY(rot);
  m.box(s, s, s, col);
  const t = s * 0.09;
  for (const sy of [-s / 2 + t, s / 2 - t]) {
    m.save(); m.translate(0, sy, 0); m.box(s * 1.03, t * 1.4, s * 1.03, shade(col, -0.25)); m.restore();
  }
  m.restore();
}

function barrel(m, x, y, z, rot = 0) {
  m.save();
  m.translate(x, y, z); m.rotY(rot);
  m.cyl([0.34, 0.34], 0.86, 9, PAL.plankDark, { capTop: true });
  for (const h of [0.14, 0.7]) {
    m.save(); m.translate(0, h, 0); m.cyl([0.37, 0.37], 0.07, 9, PAL.metal, { capTop: false }); m.restore();
  }
  m.restore();
}

// A catenary of little segments - ropes strung between posts do more for a
// harbour's silhouette than another building would.
function rope(m, a, b, sag, col = PAL.rope, r = 0.045) {
  const N = 9;
  for (let i = 0; i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N;
    const P = (t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * sag,
      a[2] + (b[2] - a[2]) * t,
    ];
    const p0 = P(t0), p1 = P(t1);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz);
    m.save();
    m.translate((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
    m.rotY(Math.atan2(dx, dz));
    m.rotX(Math.atan2(dy, Math.hypot(dx, dz)));
    m.box(r * 2, r * 2, len * 1.04, col);
    m.restore();
  }
}

function window4(m, w, h, { sill = true } = {}) {
  m.box(w, h, 0.1, PAL.timber);
  m.save(); m.translate(0, 0, 0.055);
  m.box(w * 0.78, h * 0.8, 0.06, PAL.glass, { emis: 0.15 });
  m.box(w * 0.07, h * 0.82, 0.09, PAL.white);
  m.box(w * 0.8, h * 0.07, 0.09, PAL.white);
  m.restore();
  if (sill) { m.save(); m.translate(0, -h / 2 - 0.06, 0.06); m.box(w * 1.2, 0.1, 0.24, PAL.white); m.restore(); }
}

// Overlapping courses of slabs. Reads as tile at any distance and gives the
// roof the thick, hand-laid edge the reference has.
function tiledRoof(m, w, d, h, col, { eave = 0.35, courses = 7 } = {}) {
  const half = w / 2 + eave;
  const slope = Math.hypot(half, h);
  const ang = Math.atan2(h, half);
  for (const side of [1, -1]) {
    for (let i = 0; i < courses; i++) {
      const t = i / courses;
      const len = slope / courses;
      const cx = side * (half * (t + 0.5 / courses));
      const cy = h * (1 - (t + 0.5 / courses));
      const k = (i % 2 ? 0.05 : -0.05) + (i / courses) * 0.06;
      m.save();
      m.translate(cx, cy, 0);
      m.rotZ(side > 0 ? -ang : ang);
      m.box(len * 1.06, 0.15, d + eave * 2, shade(col, k));
      m.restore();
    }
  }
  m.save(); m.translate(0, h + 0.05, 0); m.box(0.42, 0.2, d + eave * 2.2, shade(col, 0.16)); m.restore();
  // dark underside so the eave shadow exists even in flat light
  m.save(); m.translate(0, h * 0.02, 0); m.wedge(w * 1.02, h * 0.98, d + eave * 1.9, shade(col, -0.55)); m.restore();
}

function cottage(m, { w, d, h, wall, roof, roofH, dormer = false, chimney = true, timbered = true, seed = 3 }) {
  const r = mulberry32(seed);
  m.save();
  m.translate(0, h / 2, 0);
  m.box(w, h, d, wall);
  m.restore();

  if (timbered) {
    const t = 0.13;
    for (const [sx, sz, ww] of [[0, d / 2 + 0.005, w], [0, -d / 2 - 0.005, w]]) {
      for (const y of [h * 0.5, h * 0.94]) {
        m.save(); m.translate(sx, y, sz); m.box(ww * 1.002, t, 0.06, PAL.timber); m.restore();
      }
      for (const fx of [-w * 0.34, 0, w * 0.34]) {
        m.save(); m.translate(fx, h * 0.72, sz); m.box(t, h * 0.44, 0.06, PAL.timber); m.restore();
      }
      // a leaning brace, the detail that makes it read as half-timbered
      m.save(); m.translate(-w * 0.17, h * 0.72, sz); m.rotZ(0.62);
      m.box(t, h * 0.5, 0.06, PAL.timber); m.restore();
    }
    for (const sx of [w / 2 + 0.005, -w / 2 - 0.005]) {
      for (const y of [h * 0.5, h * 0.94]) {
        m.save(); m.translate(sx, y, 0); m.box(0.06, t, d * 1.002, PAL.timber); m.restore();
      }
    }
  }

  m.save(); m.translate(0, h, 0); tiledRoof(m, w, d, roofH, roof); m.restore();

  if (chimney) {
    const cx = w * (r() > 0.5 ? 0.28 : -0.28);
    m.save();
    m.translate(cx, h + roofH * 0.55, d * 0.18);
    m.box(0.62, 1.9, 0.62, PAL.stone);
    m.translate(0, 1.05, 0); m.box(0.8, 0.22, 0.8, PAL.stoneDark);
    m.restore();
  }

  if (dormer) {
    m.save();
    m.translate(w * 0.12, h + roofH * 0.28, d / 2 - 0.5);
    m.box(1.5, 1.25, 1.4, wall);
    m.save(); m.translate(0, 0.05, 0.72); m.scale(0.62); window4(m, 1.5, 1.4, { sill: false }); m.restore();
    m.translate(0, 0.62, 0); tiledRoof(m, 1.6, 1.5, 0.7, roof, { eave: 0.2, courses: 3 });
    m.restore();
  }
  return m;
}

function awning(m, w, d, colA, colB) {
  const strips = Math.max(3, Math.round(w / 0.42));
  for (let i = 0; i < strips; i++) {
    const x = (i + 0.5) / strips * w - w / 2;
    m.save();
    m.translate(x, 0, 0);
    m.rotX(0.42);
    m.box(w / strips * 0.98, 0.07, d, i % 2 ? colA : colB);
    m.restore();
  }
  // scalloped valance
  for (let i = 0; i < strips; i++) {
    const x = (i + 0.5) / strips * w - w / 2;
    m.save();
    m.translate(x, -d * 0.42 * 0.42 - 0.12, d * 0.44);
    m.box(w / strips * 0.98, 0.26, 0.07, i % 2 ? colA : colB);
    m.restore();
  }
}

function conifer(m, x, y, z, s, seed) {
  const r = mulberry32(seed);
  m.save();
  m.translate(x, y, z);
  m.rotY(r() * 6.28);
  m.scale(s * (0.85 + r() * 0.4));
  m.cyl([0.22, 0.16], 1.5, 6, PAL.trunk);
  const tiers = 3 + (r() > 0.6 ? 1 : 0);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    m.save();
    m.translate(0, 1.0 + t * 3.4, 0);
    m.cyl([1.55 * (1 - t * 0.72), 0.05], 2.1 - t * 0.5, 7, i % 2 ? PAL.pine : PAL.pineDark, { capBottom: true });
    m.restore();
  }
  m.restore();
}

// Faceted stack: a few extruded n-gons with per-vertex noise, each smaller and
// twisted off the one below. Cheap, and no two come out alike.
function rockStack(m, x, y, z, radius, height, seed, { grass = false } = {}) {
  const r = mulberry32(seed);
  const sides = 8;
  const layers = 4;
  let prev = null;
  const profile = (rad, jitter) => {
    const pts = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + r() * 0.06;
      const rr = rad * (1 + (r() - 0.5) * jitter);
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    return pts;
  };
  for (let l = 0; l < layers; l++) {
    const t0 = l / layers, t1 = (l + 1) / layers;
    const r0 = radius * (1 - t0 * 0.42) * (1 - t0 * t0 * 0.25);
    const r1 = radius * (1 - t1 * 0.42) * (1 - t1 * t1 * 0.25);
    const p0 = prev || profile(r0, 0.30);
    const p1 = profile(r1, 0.30);
    prev = p1;
    const y0 = y + height * t0, y1 = y + height * t1;
    const col = shade(l % 2 ? PAL.rock : PAL.rockDark, (r() - 0.5) * 0.14);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      m.quad(
        [x + p0[i][0], y0, z + p0[i][1]], [x + p0[j][0], y0, z + p0[j][1]],
        [x + p1[j][0], y1, z + p1[j][1]], [x + p1[i][0], y1, z + p1[i][1]], col,
      );
    }
  }
  // cap
  const top = y + height;
  const capCol = grass ? PAL.grass : PAL.rock;
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    m.tri([x, top + (grass ? 0.5 : 0.15), z],
      [x + prev[i][0], top, z + prev[i][1]],
      [x + prev[j][0], top, z + prev[j][1]], capCol);
  }
  if (grass) {
    // a grass lip that overhangs the rock, like turf on a sea cliff
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      m.quad(
        [x + prev[i][0] * 1.1, top - 0.5, z + prev[i][1] * 1.1],
        [x + prev[j][0] * 1.1, top - 0.5, z + prev[j][1] * 1.1],
        [x + prev[j][0] * 1.02, top + 0.35, z + prev[j][1] * 1.02],
        [x + prev[i][0] * 1.02, top + 0.35, z + prev[i][1] * 1.02], PAL.grassDark,
      );
    }
  }
  return prev;
}

function lighthouse(m, x, y, z) {
  m.save();
  m.translate(x, y, z);
  // base plinth
  m.cyl([3.4, 3.0], 1.2, 12, PAL.stone);
  m.save(); m.translate(0, 1.2, 0);
  const bands = 6, bh = 1.75;
  for (let i = 0; i < bands; i++) {
    const r0 = 2.5 - i * 0.17, r1 = 2.5 - (i + 1) * 0.17;
    m.save(); m.translate(0, i * bh, 0);
    m.cyl([r0, r1], bh, 14, i % 2 ? PAL.red : PAL.white, { capTop: false });
    m.restore();
  }
  const top = bands * bh;
  m.save(); m.translate(0, top, 0);
  m.cyl([2.35, 2.35], 0.28, 14, PAL.white);                    // gallery
  m.save(); m.translate(0, 0.28, 0);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    m.save(); m.translate(Math.cos(a) * 2.15, 0, Math.sin(a) * 2.15);
    m.box(0.1, 0.62, 0.1, PAL.metal); m.restore();
  }
  m.cyl([2.2, 2.2], 0.72, 14, PAL.red, { capTop: false });     // rail band
  m.translate(0, 0.1, 0);
  m.cyl([1.45, 1.45], 1.9, 12, PAL.lamp, { emis: 1.6, capTop: false });
  m.save(); m.translate(0, 1.9, 0);
  m.cyl([1.7, 0.0], 1.5, 12, PAL.red);
  m.translate(0, 1.5, 0); m.ball(0.22, 6, 4, PAL.metal);
  m.restore();
  m.restore();
  m.restore();
  m.restore();
  m.restore();
}

// ---------------------------------------------------------------- village
function buildVillage(m) {
  const deckY = 1.55;

  // ---- main quay running north-south, with a finger pier reaching east
  m.save();
  m.translate(QUAY_X - 5, deckY, -6);
  plankDeck(m, 12, 74, { along: 'x', seed: 11 });
  m.restore();

  // stone edge behind the deck, where the shore rises
  m.save();
  m.translate(QUAY_X - 13.5, deckY - 1.1, -6);
  m.box(6, 3.2, 74, PAL.stone);
  m.restore();

  m.save();
  m.translate(QUAY_X + 7.5, deckY, 4);
  plankDeck(m, 25, 6.6, { along: 'x', seed: 12 });
  m.restore();

  // ---- pilings under both, with cross braces
  for (let i = 0; i < 12; i++) {
    const z = -40 + i * 6.4;
    piling(m, QUAY_X + 0.2, deckY - 0.1, z);
    piling(m, QUAY_X - 9.6, deckY - 0.1, z);
    if (i % 2 === 0) {
      m.save();
      m.translate(QUAY_X - 4.7, 0.55, z);
      m.rotZ(0.05);
      m.box(10.2, 0.26, 0.26, PAL.postWet);
      m.restore();
    }
  }
  for (let i = 0; i < 5; i++) {
    const x = QUAY_X + 3 + i * 4.6;
    piling(m, x, deckY - 0.1, 1.1);
    piling(m, x, deckY - 0.1, 6.9);
  }
  // taller mooring posts with rope strung between them
  const posts = [];
  for (let i = 0; i < 7; i++) {
    const z = -34 + i * 11;
    piling(m, QUAY_X + 0.55, deckY + 1.15, z, { r: 0.24 });
    posts.push([QUAY_X + 0.55, deckY + 1.05, z]);
  }
  for (let i = 0; i < posts.length - 1; i++) rope(m, posts[i], posts[i + 1], 0.55);

  // ---- fenders and a ladder
  for (let i = 0; i < 9; i++) tire(m, QUAY_X + 0.55, 0.55 + (i % 2) * 0.25, -38 + i * 8.6, Math.PI / 2);
  m.save();
  m.translate(QUAY_X + 0.9, 0, 8.5);
  for (let i = 0; i < 6; i++) {
    m.save(); m.translate(0, 0.1 + i * 0.32, 0); m.box(0.5, 0.07, 0.09, PAL.metal); m.restore();
  }
  m.box(0.08, 2.1, 0.09, PAL.metal);
  m.save(); m.translate(0.42, 0, 0); m.box(0.08, 2.1, 0.09, PAL.metal); m.restore();
  m.restore();

  // ---- the Salty Fin, standing over the water on its own piles
  const shopX = QUAY_X - 10.5, shopZ = 2;
  m.save();
  m.translate(shopX, deckY, shopZ);
  cottage(m, { w: 9.5, d: 11, h: 4.4, wall: PAL.plaster, roof: PAL.roofRed, roofH: 2.9, dormer: true, seed: 21 });
  // shopfront: awning, counter, crates of catch
  m.save();
  m.translate(4.75, 2.75, 2.2);
  m.rotY(-Math.PI / 2);
  awning(m, 6.5, 1.9, PAL.awningA, PAL.awningB);
  m.restore();
  for (const z of [-2.2, 1.2]) {
    m.save(); m.translate(4.8, 1.5, z); m.rotY(Math.PI / 2); window4(m, 2.0, 2.1); m.restore();
  }
  m.restore();

  // hanging sign on a bracket over the quay
  m.save();
  m.translate(QUAY_X - 5.4, deckY + 4.9, 8.6);
  m.box(0.22, 3.4, 0.22, PAL.timber);
  m.save(); m.translate(0, 1.5, 1.2); m.box(0.18, 0.18, 2.6, PAL.timber); m.restore();
  m.save(); m.translate(0.4, 1.15, 0.5); m.rotZ(-0.7); m.box(0.14, 1.4, 0.14, PAL.timber); m.restore();
  m.save();
  m.translate(0, 0.55, 2.35);
  rope(m, [0, 0.85, -0.7], [0, 0.55, -0.7], 0);
  m.box(3.5, 1.7, 0.16, PAL.plankPale);
  m.save(); m.translate(0, 0, 0.09); m.box(3.2, 1.42, 0.06, shade(PAL.plankPale, 0.16)); m.restore();
  m.save();
  m.translate(0, 0.18, 0.14);
  pixelText(m, 'SALTY', 0.16, 0.06, PAL.timber);
  m.restore();
  m.save();
  m.translate(-0.62, -0.52, 0.14);
  pixelText(m, 'FIN', 0.16, 0.06, PAL.timber);
  m.restore();
  // little painted fish next to the word
  m.save();
  m.translate(0.78, -0.34, 0.15);
  m.scale(0.5);
  m.loft([
    { z: -0.02, pts: [[-0.7, 0], [-0.35, 0.12], [0.35, 0.16], [0.75, 0], [0.35, -0.16], [-0.35, -0.12]] },
    { z: 0.02, pts: [[-0.7, 0], [-0.35, 0.12], [0.35, 0.16], [0.75, 0], [0.35, -0.16], [-0.35, -0.12]] },
  ], PAL.roofTeal);
  m.save(); m.translate(-0.78, 0, 0); m.rotZ(0.1);
  m.card(0.42, 0.42, PAL.roofTeal); m.restore();
  m.restore();
  m.restore();
  m.restore();

  // ---- terraced houses climbing the shore behind the shop
  const row = [
    { x: -17.5, z: -12, w: 8.5, d: 9.5, h: 5.2, roofH: 3.2, roof: PAL.roofTeal, y: 2.6, rot: 0.06 },
    { x: -20.0, z: -22.5, w: 7.5, d: 8.5, h: 4.6, roofH: 2.8, roof: PAL.roofBlue, y: 3.6, rot: -0.05 },
    { x: -15.0, z: 13.5, w: 8.0, d: 9.0, h: 6.4, roofH: 3.0, roof: PAL.roofOchre, y: 2.2, rot: 0.03 },
    { x: -21.0, z: 24.0, w: 7.0, d: 8.0, h: 4.8, roofH: 2.9, roof: PAL.roofRed, y: 3.9, rot: -0.09 },
    { x: -24.0, z: -33.0, w: 6.5, d: 7.5, h: 4.4, roofH: 2.6, roof: PAL.roofTeal, y: 4.6, rot: 0.11 },
  ];
  row.forEach((b, i) => {
    m.save();
    m.translate(QUAY_X + b.x, b.y, b.z);
    m.rotY(b.rot);
    cottage(m, {
      w: b.w, d: b.d, h: b.h, wall: i % 2 ? PAL.plaster : PAL.plaster2,
      roof: b.roof, roofH: b.roofH, dormer: i % 2 === 0, seed: 30 + i,
    });
    m.restore();
  });

  // a taller gable right on the quay edge, to break the skyline
  m.save();
  m.translate(QUAY_X - 8.5, deckY, -14);
  cottage(m, { w: 6.0, d: 7.0, h: 7.6, wall: PAL.plaster2, roof: PAL.roofBlue, roofH: 2.8, seed: 44 });
  m.save(); m.translate(3.05, 2.0, 1.0); m.rotY(Math.PI / 2); window4(m, 1.6, 1.9); m.restore();
  m.save(); m.translate(3.05, 5.0, -1.0); m.rotY(Math.PI / 2); window4(m, 1.4, 1.5); m.restore();
  m.restore();

  // market stall on the finger pier
  m.save();
  m.translate(QUAY_X + 9, deckY, 4);
  for (const [sx, sz] of [[-1.8, -1.5], [1.8, -1.5], [-1.8, 1.5], [1.8, 1.5]]) {
    m.save(); m.translate(sx, 1.1, sz); m.box(0.14, 2.2, 0.14, PAL.timber); m.restore();
  }
  m.save(); m.translate(0, 2.3, 0); awning(m, 4.4, 3.6, PAL.awningA, PAL.awningC); m.restore();
  m.save(); m.translate(0, 0.9, 0); m.box(4.0, 0.12, 3.0, PAL.plankPale); m.restore();
  crate(m, -1.2, 1.0, 0.6, 0.6, 0.2);
  crate(m, 1.1, 1.0, -0.5, 0.55, -0.4, PAL.plankDark);
  m.restore();

  // clutter along the quay: crates, barrels, coiled rope, lanterns
  const clutter = mulberry32(77);
  for (let i = 0; i < 16; i++) {
    const z = -38 + clutter() * 70;
    const x = QUAY_X - 2.2 - clutter() * 5.5;
    const k = clutter();
    if (k < 0.45) crate(m, x, deckY, z, 0.55 + clutter() * 0.35, clutter() * 3, clutter() < 0.3 ? PAL.plankDark : PAL.plank);
    else if (k < 0.75) barrel(m, x, deckY, z, clutter() * 3);
    else {
      m.save(); m.translate(x, deckY + 0.1, z);
      m.torus(0.42, 0.09, 10, 5, PAL.rope);
      m.translate(0, 0.13, 0); m.torus(0.34, 0.08, 10, 5, PAL.rope);
      m.restore();
    }
  }
  for (const z of [-30, -8, 14, 30]) lantern(m, QUAY_X - 1.2, deckY + 3.2, z, 1.1);
  for (const z of [-30, -8, 14, 30]) {
    m.save(); m.translate(QUAY_X - 1.2, deckY, z); m.cyl([0.12, 0.09], 3.2, 6, PAL.metal); m.restore();
  }

  // bollards
  for (let i = 0; i < 6; i++) {
    m.save();
    m.translate(QUAY_X - 1.0, deckY + 0.07, -32 + i * 12);
    m.cyl([0.2, 0.17], 0.5, 8, PAL.metal);
    m.translate(0, 0.5, 0); m.ball(0.2, 8, 4, PAL.metal, { squash: 0.7 });
    m.restore();
  }
}

// ---------------------------------------------------------------- moored boats
function sailboat(m, x, z, rot) {
  m.save();
  m.translate(x, 0, z);
  m.rotY(rot);
  const hull = (s) => [[-1.0 * s, 0.42], [-0.86 * s, -0.30], [0, -0.52], [0.86 * s, -0.30], [1.0 * s, 0.42]];
  m.loft([
    { z: -3.4, pts: hull(0.12) }, { z: -2.2, pts: hull(0.62) }, { z: 0.4, pts: hull(1.0) },
    { z: 2.6, pts: hull(0.9) }, { z: 3.4, pts: hull(0.55) },
  ], PAL.white);
  m.save(); m.translate(0, 0.36, 0); m.box(1.9, 0.14, 6.2, PAL.plankPale); m.restore();
  m.save(); m.translate(0, 0.42, 1.1); m.box(1.5, 0.7, 2.2, shade(PAL.white, -0.08)); m.restore();
  m.save(); m.translate(0, 0.4, -0.6); m.cyl([0.09, 0.06], 7.5, 6, PAL.plankPale); m.restore();
  m.save(); m.translate(0, 1.0, -0.55); m.rotY(-0.06);
  m.card(0.06, 6.4, shade(PAL.white, 0.05));
  m.restore();
  // furled sail as a slim cone along the boom
  m.save(); m.translate(0, 1.5, -0.5); m.rotX(Math.PI / 2); m.cyl([0.16, 0.1], 3.2, 6, shade(PAL.white, -0.03)); m.restore();
  m.restore();
}

function rowboat(m, x, z, rot, col = PAL.plank) {
  m.save();
  m.translate(x, -0.12, z);
  m.rotY(rot);
  const sec = (s) => [[-0.85 * s, 0.45], [-0.7 * s, -0.18], [0, -0.34], [0.7 * s, -0.18], [0.85 * s, 0.45]];
  m.loft([
    { z: -1.9, pts: sec(0.25) }, { z: -1.2, pts: sec(0.72) }, { z: 0.3, pts: sec(1.0) },
    { z: 1.5, pts: sec(0.82) }, { z: 2.0, pts: sec(0.32) },
  ], col);
  for (const z2 of [-0.7, 0.6]) { m.save(); m.translate(0, 0.3, z2); m.box(1.5, 0.1, 0.3, shade(col, 0.18)); m.restore(); }
  m.restore();
}

// ---------------------------------------------------------------- seabed
function buildBed(m) {
  const EXT = 460, N = 148;
  m.field(EXT, EXT, N, N, (x, z) => {
    const y = bedHeight(x, z);
    const rocky = fbm2(x * 0.06 + 40, z * 0.06 - 20, 3);
    const weedy = fbm2(x * 0.09 - 7, z * 0.09 + 3, 3);
    let c = PAL.sand;
    if (y > -1.2) c = PAL.sandDark;
    if (rocky > 0.60) c = PAL.bedRock;
    if (weedy > 0.63 && y < -2.2) c = PAL.bedWeed;
    const tint = (noise2(x * 0.7, z * 0.7) - 0.5) * 0.12;
    return [y, shade(c, tint)];
  });
}

function kelpClump(m, x, y, z, s, seed) {
  const r = mulberry32(seed);
  m.save();
  m.translate(x, y, z);
  m.rotY(r() * 6.3);
  m.scale(s);
  const blades = 5 + Math.floor(r() * 4);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * 6.283 + r() * 0.4;
    const rad = 0.2 + r() * 0.5;
    m.save();
    m.translate(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    m.rotY(a);
    m.rotZ((r() - 0.5) * 0.5);
    const h = 1.1 + r() * 1.5;
    const col = r() < 0.3 ? PAL.kelpLight : PAL.kelp;
    m.cyl([0.06, 0.02], h, 4, col);
    for (let k = 0; k < 3; k++) {
      m.save();
      m.translate(0, h * (0.35 + k * 0.22), 0);
      m.rotY(k * 1.9);
      m.ball(0.30 + r() * 0.2, 5, 3, col, { squash: 0.7 });
      m.restore();
    }
    m.restore();
  }
  m.restore();
}

function coralFan(m, x, y, z, s, seed) {
  const r = mulberry32(seed);
  m.save();
  m.translate(x, y, z); m.rotY(r() * 6.3); m.scale(s);
  for (let i = 0; i < 5; i++) {
    m.save();
    m.rotY(i * 1.25);
    m.rotZ(0.35);
    m.cyl([0.12, 0.05], 0.9, 5, PAL.coral);
    m.translate(0, 0.9, 0); m.ball(0.18, 5, 3, shade(PAL.coral, 0.12));
    m.restore();
  }
  m.restore();
}

// ---------------------------------------------------------------- assembly
export function buildWorld(gl) {
  const above = new MeshBuilder();
  const below = new MeshBuilder();
  const both = new MeshBuilder();     // crosses the waterline, drawn in both

  buildBed(below);

  // scatter of bed life, thickest on the shallow shelf where you can see it
  const r = mulberry32(4242);
  for (let i = 0; i < 460; i++) {
    const x = -70 + r() * 250, z = -160 + r() * 260;
    const y = bedHeight(x, z);
    if (y > -0.9 || y < -13) continue;
    const k = r();
    if (k < 0.62) kelpClump(below, x, y, z, 0.7 + r() * 0.9, 900 + i);
    else if (k < 0.78) coralFan(below, x, y, z, 0.6 + r() * 0.7, 900 + i);
    else {
      below.save();
      below.translate(x, y, z);
      below.rotY(r() * 6.3);
      below.ball(0.5 + r() * 1.3, 6, 4, shade(PAL.bedRock, (r() - 0.5) * 0.2), { squash: 0.55 });
      below.restore();
    }
  }

  buildVillage(both);

  // islands
  for (const I of ISLANDS) {
    const seed = Math.round(I.x * 31 + I.z * 7 + 1000);
    const baseY = -3.2;
    rockStack(both, I.x, baseY, I.z, I.r, I.h + 3.2, seed, { grass: I.kind !== 'bare' });
    const rr = mulberry32(seed + 5);
    // skirt boulders sitting in the shallows around each stack
    for (let i = 0; i < 7; i++) {
      const a = rr() * 6.28, d = I.r * (0.85 + rr() * 0.5);
      const bx = I.x + Math.cos(a) * d, bz = I.z + Math.sin(a) * d;
      rockStack(both, bx, bedHeight(bx, bz) - 0.5, bz, 1.4 + rr() * 2.4, 2.2 + rr() * 3.2, seed + i * 13);
    }
    if (I.kind === 'lighthouse') {
      lighthouse(above, I.x, I.h + 0.55, I.z);
      // keeper's cottage
      above.save();
      above.translate(I.x - 7.5, I.h - 0.4, I.z + 5.5);
      above.rotY(0.5);
      cottage(above, { w: 5.2, d: 6.0, h: 3.2, wall: PAL.plaster, roof: PAL.roofRed, roofH: 2.0, timbered: false, seed: 61 });
      above.restore();
      for (let i = 0; i < 5; i++) {
        const a = rr() * 6.28, d = I.r * 0.55 * rr();
        conifer(above, I.x + Math.cos(a) * d, I.h + 0.2, I.z + Math.sin(a) * d, 0.9, seed + 200 + i);
      }
    } else if (I.kind === 'pines') {
      for (let i = 0; i < 12; i++) {
        const a = rr() * 6.28, d = I.r * 0.62 * Math.sqrt(rr());
        conifer(above, I.x + Math.cos(a) * d, I.h + 0.1, I.z + Math.sin(a) * d, 1.0 + rr() * 0.5, seed + 300 + i);
      }
    }
  }

  // trees on the shore behind the village
  for (let i = 0; i < 26; i++) {
    const x = QUAY_X - 16 - r() * 26;
    const z = -60 + r() * 110;
    const y = Math.max(2.0, bedHeight(x, z));
    conifer(above, x, y, z, 0.9 + r() * 0.7, 500 + i);
  }

  // moored craft
  sailboat(both, 62, -36, 0.6);
  rowboat(both, QUAY_X + 4.5, -18, 0.35);
  rowboat(both, QUAY_X + 3.6, 22, -0.5, PAL.plankPale);

  const aboveData = new MeshBuilder();
  aboveData.concat(above); aboveData.concat(both);
  const belowData = new MeshBuilder();
  belowData.concat(below); belowData.concat(both);

  const obstacles = [
    ...ISLANDS.map((I) => ({ x: I.x, z: I.z, r: I.r * 1.15 })),
    { x: 62, z: -36, r: 5 },
  ];
  // the quay itself, as a run of circles
  for (let i = 0; i < 16; i++) obstacles.push({ x: QUAY_X - 1, z: -44 + i * 5.4, r: 3.4 });
  for (let i = 0; i < 6; i++) obstacles.push({ x: QUAY_X + 2 + i * 4.6, z: 4, r: 3.6 });

  return {
    above: uploadMesh(gl, aboveData.build()),
    below: uploadMesh(gl, belowData.build()),
    obstacles,
    // where you sell: alongside the quay by the ladder and the shopfront
    sellPoint: { x: QUAY_X + 4.6, z: 10.5, r: 8.0 },
    quayX: QUAY_X, quayZ0: QUAY_Z0, quayZ1: QUAY_Z1,
    tris: (aboveData.vertexCount + belowData.vertexCount) / 3,
  };
}
