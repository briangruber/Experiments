// The ground above water: three cliff islands, their sea stacks and shoreline
// boulders, and a ring of hazy silhouettes on the horizon.
//
// The signature of the concept art is a dark, faceted, stratified rock mass
// capped with a bright rounded green shelf and skirted with pale sand at the
// waterline. That comes out of four things, in this order:
//
//   1. a blob radius per island — a few angular harmonics plus a little fbm, so
//      the plan shape is a lumpy oval rather than a circle;
//   2. a radial profile that spends almost all of its height between t = 0.6 and
//      t = 1.0, which is what makes a cliff instead of a hill;
//   3. terracing — the height is pulled most of the way onto a staircase, giving
//      flat treads (the village's buildable ledges) and hard risers (strata);
//   4. a waterline compression, `h - (1-k)*W*tanh(h/W)`, which flattens the
//      slope near y = 0 without breaking monotonicity. `k` is small on the
//      south/south-east faces (a beach) and near 1 on the west/north (cliffs
//      straight into the sea).
//
// Every module that puts something on land asks `landHeight`/`isLand`, and the
// seabed asks `islandFloor` for the shallow apron that wraps each island, so all
// of it has to be one exact, cheap, allocation-free function. It is.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';
import { makeRng, fbm2D, ridged2D, value2D, hash2, hash3, smoothstep, clamp } from '../core/rng.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Width of the waterline flattening, in metres. */
const BEACH_W = 5.5;

// --- the three islands -------------------------------------------------------
// Centres, extents and summit heights are the binding world layout. Everything
// else is shape authoring.

const ISLANDS = [
  {
    id: 'village',
    cx: -150, cz: -60, R: 114, peak: 48,
    lobe: 0.12, lobeAng: 232 * DEG,      // mass pushed north-west, bay to the south-east
    h2: 0.085, p2: 0.9, h3: 0.055, p3: 2.4,
    rough: 0.150,
    beachAng: 74 * DEG,                  // south-east/south face is the soft one
    band: 3.8, ridge: 0.21, ridgeScale: 0.0175, o: 3.1,
    rings: 76, sectors: 176,
  },
  {
    id: 'lighthouse',
    cx: 215, cz: -195, R: 66, peak: 34,
    lobe: 0.11, lobeAng: 25 * DEG,
    h2: 0.115, p2: 2.1, h3: 0.07, p3: 0.4,
    rough: 0.135,
    beachAng: 205 * DEG,
    band: 3.0, ridge: 0.15, ridgeScale: 0.026, o: 17.7,
    rings: 58, sectors: 124,
  },
  {
    id: 'rock',
    cx: 340, cz: -70, R: 45, peak: 21,
    lobe: 0.125, lobeAng: 105 * DEG,
    h2: 0.13, p2: 1.3, h3: 0.08, p3: 2.9,
    rough: 0.145,
    beachAng: 250 * DEG,
    band: 2.6, ridge: 0.17, ridgeScale: 0.036, o: 41.2,
    rings: 50, sectors: 100,
  },
];

for (const isl of ISLANDS) isl.cull2 = (isl.R * 3.0) * (isl.R * 3.0);

// --- the height field --------------------------------------------------------

/** Pull `h` most of the way onto a staircase of `band`-metre treads. */
function terraceH(h, band, sharp) {
  const q = h / band;
  const fl = Math.floor(q);
  const f = q - fl;
  const s = smoothstep(0.5 - sharp, 0.5 + sharp, f);
  return (fl + s) * band;
}

// Two module-scope scratch records; the field is evaluated hundreds of thousands
// of times at build time and once or twice a frame after that, so nothing here
// may allocate.
const _one = { land: -1e4, floor: -1e4, t: 9, face: 0, rr: 1 };
const _acc = { land: -1e4, floor: -1e4, t: 9, face: 0, rr: 1, idx: -1 };

/**
 * One island's contribution at (x, z). Returns false when the point is outside
 * the island's cull radius entirely. `out.land` is the surface of the rock,
 * `out.floor` the seabed apron that wraps it (a little lower, and shelving out
 * far more gently so the shallows read turquoise all around the shore).
 */
function islandOne(isl, x, z, out) {
  const dx = x - isl.cx, dz = z - isl.cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > isl.cull2) return false;

  const d = Math.sqrt(d2);
  const ang = Math.atan2(dz, dx);
  const ca = Math.cos(ang), sa = Math.sin(ang);

  // 1 on the soft shore side, 0 on the cliff side.
  const face = 0.5 + 0.5 * Math.cos(ang - isl.beachAng);

  // The plan shape. The angular fbm is damped on the beach face so the village
  // and the dock get a shoreline they can predict.
  const rough = isl.rough * (1 - 0.55 * face);
  let rr = isl.R * (1
    + isl.lobe * Math.cos(ang - isl.lobeAng)
    + isl.h2 * Math.cos(2 * ang + isl.p2)
    + isl.h3 * Math.cos(3 * ang + isl.p3)
    + rough * fbm2D(ca * 2.6 + isl.o, sa * 2.6 - isl.o, 2));
  if (rr < isl.R * 0.55) rr = isl.R * 0.55;

  const t = d / rr;
  out.t = t; out.face = face; out.rr = rr;

  // Well outside: a plain linear descent, continuous with the branch below.
  if (t > 1.8) {
    const drop = (t - 1.8) * isl.R * 0.8;
    out.land = -37.0 - drop;
    out.floor = -25.45 - drop;
    return true;
  }

  // The radial profile: nearly all of the height in a narrow band below t = 1.
  // On the hard faces that band is only a quarter of the radius wide, which is
  // what turns a hill into the cliff the concept art wants; on the soft face it
  // opens out into the terraced ramp the village is built on.
  const m = smoothstep(1.0, 0.60 + 0.17 * (1 - face), t);
  const core = smoothstep(0.74, 0.04, t);
  let h = isl.peak * (0.80 * Math.pow(m, 0.9) + 0.20 * core);

  // Ridged detail for the summit and the cliff faces, faded to nothing at the
  // waterline so the shoreline stays where the plan shape put it.
  const fade = smoothstep(0.015, 0.28, m);
  if (fade > 0.001) {
    h += isl.peak * isl.ridge * (ridged2D(x * isl.ridgeScale + isl.o, z * isl.ridgeScale - isl.o, 3) - 0.44) * fade;
    h += isl.peak * 0.05 * fbm2D(x * isl.ridgeScale * 3.3 - isl.o, z * isl.ridgeScale * 3.3 + isl.o, 2) * fade;
  }

  // Strata. Faded out near y = 0 so no tread ever lands coplanar with the water.
  const tw = 0.78 * smoothstep(0.6, 3.2, h < 0 ? -h : h);
  if (tw > 0.001) h += (terraceH(h, isl.band, 0.15) - h) * tw;

  // Beach on the soft face, cliff on the hard one.
  const k = 0.92 - 0.62 * Math.pow(face, 1.6);
  h -= (1 - k) * BEACH_W * Math.tanh(h / BEACH_W);

  // Below the waterline the rock mesh dives away fast (it ends up buried inside
  // the seabed), while the seabed apron shelves out slowly.
  const beach = 3.0 * smoothstep(0.99, 1.16, t);
  out.land = h - beach - 46.0 * smoothstep(1.14, 1.52, t);
  out.floor = h - beach - 0.45 - 22.0 * smoothstep(1.16, 1.80, t);
  return true;
}

function evalIslands(x, z, out) {
  out.land = -1e4; out.floor = -1e4; out.idx = -1; out.face = 0; out.t = 9; out.rr = 1;
  for (let i = 0; i < ISLANDS.length; i++) {
    if (!islandOne(ISLANDS[i], x, z, _one)) continue;
    if (_one.land > out.land) {
      out.land = _one.land; out.idx = i; out.face = _one.face; out.t = _one.t; out.rr = _one.rr;
    }
    if (_one.floor > out.floor) out.floor = _one.floor;
  }
  return out;
}

/** Island surface height at (x, z), or -Infinity where there is no island. */
export function landHeightAt(x, z) {
  evalIslands(x, z, _acc);
  return _acc.land > -8 ? _acc.land : -Infinity;
}

/** True where there is dry land to stand on. */
export function isLandAt(x, z) {
  evalIslands(x, z, _acc);
  return _acc.land > 0.2;
}

/**
 * What the islands contribute to the seabed: the rock, offset a little down so
 * the two meshes never fight, plus the shallow sand apron that wraps it out to
 * roughly 1.8x the island radius. `seabed.js` soft-maxes this with the open bay.
 */
export function islandFloor(x, z) {
  evalIslands(x, z, _acc);
  return _acc.floor;
}

/** Radius of the shoreline at a bearing, used to scatter rocks along it. */
function shoreRadius(isl, ang) {
  const face = 0.5 + 0.5 * Math.cos(ang - isl.beachAng);
  const rough = isl.rough * (1 - 0.55 * face);
  let rr = isl.R * (1
    + isl.lobe * Math.cos(ang - isl.lobeAng)
    + isl.h2 * Math.cos(2 * ang + isl.p2)
    + isl.h3 * Math.cos(3 * ang + isl.p3)
    + rough * fbm2D(Math.cos(ang) * 2.6 + isl.o, Math.sin(ang) * 2.6 - isl.o, 2));
  if (rr < isl.R * 0.55) rr = isl.R * 0.55;
  return rr;
}

// --- palette -----------------------------------------------------------------
// Albedo only. Light, fog and sky all come from `env` via the scene lights.

const _col = new THREE.Color();
function lin(hex) { _col.setHex(hex, THREE.SRGBColorSpace); return [_col.r, _col.g, _col.b]; }

const C_ROCK_LO = lin(0x685F52);
const C_ROCK_HI = lin(0x9C907A);
const C_ROCK_WARM = lin(0x8A7154);
const C_MOSS = lin(0x4E5C34);
const C_GRASS = lin(0x7CB444);
const C_GRASS_DK = lin(0x4C7A30);
const C_SAND = lin(0xE8D6A8);
const C_WET = lin(0x4E4C42);
// The submerged apron. Not beach and not cliff — dark reef rock with weed on
// it. Sand-bright vertices down here read straight through the clear water as
// a tan shelf spread across half the bay.
const C_SUBMERGED = lin(0x2E4038);

const _c3 = [0, 0, 0];
const _col2 = [0, 0, 0];
function setC(dst, src) { dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; }
function mixC(dst, src, t) {
  if (t <= 0) return;
  const u = t > 1 ? 1 : t;
  dst[0] += (src[0] - dst[0]) * u;
  dst[1] += (src[1] - dst[1]) * u;
  dst[2] += (src[2] - dst[2]) * u;
}

// --- island mesh -------------------------------------------------------------

// The mesh has to run out far enough for the underwater dive below to actually
// finish. At 1.30 the rim stopped around eleven metres down — still bright
// enough through clear water to read as a tan shelf with a hard edge cutting
// across the bay.
const T_MAX = 1.58;

/** Ring parameter: coarse over the summit, fine through the cliff and shore. */
function ringT(s) {
  return s < 0.45 ? (0.75 * s / 0.45) : (0.75 + (T_MAX - 0.75) * (s - 0.45) / 0.55);
}

function buildIslandGeometry(isl) {
  const rings = isl.rings, sectors = isl.sectors;
  const vcount = (rings + 1) * sectors;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const hArr = new Float32Array(vcount);
  const fArr = new Float32Array(vcount);

  const cosT = new Float32Array(sectors);
  const sinT = new Float32Array(sectors);
  for (let s = 0; s < sectors; s++) {
    const a = (s / sectors) * TAU;
    cosT[s] = Math.cos(a); sinT[s] = Math.sin(a);
  }

  let p = 0;
  for (let i = 0; i <= rings; i++) {
    const t = ringT(i / rings);
    for (let s = 0; s < sectors; s++) {
      const ang = (s / sectors) * TAU;
      const rr = shoreRadius(isl, ang);
      const x = isl.cx + cosT[s] * rr * t;
      const z = isl.cz + sinT[s] * rr * t;
      islandOne(isl, x, z, _one);
      const y = _one.land;
      pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
      hArr[p / 3] = y;
      fArr[p / 3] = _one.face;
      p += 3;
    }
  }

  const idx = vcount > 65535 ? new Uint32Array(rings * sectors * 6) : new Uint16Array(rings * sectors * 6);
  let k = 0;
  for (let i = 0; i < rings; i++) {
    const r0 = i * sectors, r1 = (i + 1) * sectors;
    for (let s = 0; s < sectors; s++) {
      const sn = (s + 1) % sectors;
      const a = r0 + s, b = r0 + sn, c = r1 + s, d = r1 + sn;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  // --- vertex colour ---------------------------------------------------------
  const nrm = geo.attributes.normal.array;
  for (let v = 0; v < vcount; v++) {
    const x = pos[v * 3], y = hArr[v], z = pos[v * 3 + 2];
    const flat = clamp((nrm[v * 3 + 1] - 0.32) / 0.55, 0, 1);
    const face = fArr[v];

    // Strata tone: one bright/dark step per band, so the cliffs read as layers.
    const bandI = Math.floor(y / isl.band);
    const tone = hash2(bandI * 37 + 11, isl.o | 0);
    const mottle = value2D(x * 0.33 + 5.0, z * 0.33 - 2.0);
    const patch = value2D(x * 0.055 - 3.3, z * 0.055 + 7.1);

    setC(_c3, C_ROCK_LO);
    mixC(_c3, C_ROCK_HI, 0.22 + 0.55 * tone);
    mixC(_c3, C_ROCK_WARM, 0.45 * patch);

    // Moss creeps into the cracks and onto anything not vertical.
    const moss = smoothstep(0.22, 0.70, flat) * (0.45 + 0.55 * patch) * smoothstep(0.4, 3.0, y);
    mixC(_c3, C_MOSS, moss * 0.85);

    // Bright grass shelf on the caps.
    const gm = smoothstep(0.55, 0.86, flat) * smoothstep(3.0, 7.5, y);
    setC(_col2, C_GRASS);
    mixC(_col2, C_GRASS_DK, 0.25 + 0.6 * patch);
    mixC(_c3, _col2, gm);

    // Pale sand where the soft faces meet the water. It has to die off just
    // under the surface — the beach strip is only ever a metre or two deep.
    const sm = smoothstep(3.4, 0.2, y) * smoothstep(0.30, 0.72, flat)
             * (0.25 + 0.75 * face) * smoothstep(-2.2, 0.1, y);
    mixC(_c3, C_SAND, sm * 0.92);

    // Wet, darker rock below the waterline — but not so high up the beach that
    // it eats the pale sand strip, which is half the silhouette.
    mixC(_c3, C_WET, smoothstep(-0.2, -2.8, y) * 0.62 * (1 - 0.6 * sm));

    // Deeper still and it is submerged reef, which the water then tints for us.
    mixC(_c3, C_SUBMERGED, smoothstep(-1.0, -11.0, y) * 0.90);

    const shade = (0.90 + 0.20 * mottle) * (0.86 + 0.14 * flat);
    col[v * 3] = _c3[0] * shade;
    col[v * 3 + 1] = _c3[1] * shade;
    col[v * 3 + 2] = _c3[2] * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

// --- rocks -------------------------------------------------------------------

function makeRockGeometry(salt, detail, squash) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const qx = Math.round(vx * 48), qy = Math.round(vy * 48), qz = Math.round(vz * 48);
    const s = 0.70 + 0.58 * hash3(qx + salt, qy - salt, qz + salt * 3);
    // A second, coarser lump so the silhouette has big flat facets.
    const s2 = 0.88 + 0.30 * hash3(Math.round(vx * 9) + salt, Math.round(vy * 9), Math.round(vz * 9) - salt);
    vx *= s * s2; vy *= s * s2 * squash; vz *= s * s2;
    p.setXYZ(i, vx, vy, vz);

    // The material carries vertexColors for the island meshes, so these need a
    // colour attribute too or they would render black. Bias the tops greener
    // and the flanks browner, the way a shoreline boulder actually looks.
    const up = clamp(vy * 0.5 + 0.5, 0, 1);
    setC(_c3, C_ROCK_LO);
    mixC(_c3, C_ROCK_HI, 0.25 + 0.5 * hash3(qx, qy + 17, qz));
    mixC(_c3, C_MOSS, 0.42 * up * up);
    const sh = 0.90 + 0.22 * hash3(qx + 5, qy, qz - 5);
    col[i * 3] = _c3[0] * sh;
    col[i * 3 + 1] = _c3[1] * sh;
    col[i * 3 + 2] = _c3[2] * sh;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// --- horizon silhouettes -----------------------------------------------------

function makeDistantGeometry() {
  const rings = 9, sectors = 30;
  const vcount = (rings + 1) * sectors;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  let p = 0;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    for (let s = 0; s < sectors; s++) {
      const a = (s / sectors) * TAU;
      // Lumpy plan shape, two or three summits.
      const rr = 1 + 0.20 * Math.cos(a * 2 + 0.7) + 0.11 * Math.cos(a * 3 - 1.9) + 0.07 * Math.cos(a * 5 + 2.6);
      // The angular summit variation has to fade out at the pole or the whole
      // centre ring would sit at different heights on one point.
      const vary = 0.38 * (0.5 + 0.5 * Math.cos(a * 2 - 0.4)) + 0.16 * (0.5 + 0.5 * Math.cos(a * 3 + 2.2));
      const summit = 0.62 + vary * smoothstep(0.0, 0.42, t);
      const prof = Math.pow(smoothstep(1.0, 0.30, t), 0.85);
      const y = summit * prof;
      pos[p] = Math.cos(a) * rr * t;
      pos[p + 1] = y;
      pos[p + 2] = Math.sin(a) * rr * t;
      const g = 0.86 + 0.24 * clamp(y, 0, 1);
      col[p] = g; col[p + 1] = g; col[p + 2] = g;
      p += 3;
    }
  }
  const idx = new Uint16Array(rings * sectors * 6);
  let k = 0;
  for (let i = 0; i < rings; i++) {
    const r0 = i * sectors, r1 = (i + 1) * sectors;
    for (let s = 0; s < sectors; s++) {
      const sn = (s + 1) % sectors;
      idx[k++] = r0 + s; idx[k++] = r0 + sn; idx[k++] = r1 + s;
      idx[k++] = r0 + sn; idx[k++] = r1 + sn; idx[k++] = r1 + s;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// --- module ------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _tint = new THREE.Color();

export function createIslands(opts = {}) {
  const seed = (opts.seed ?? 1) | 0;
  const rng = makeRng((seed ^ 0x151A4D) >>> 0);
  // See TIERS in core/renderer.js — one budget, no tier-name ladder. `lerpQ`
  // maps it onto whatever range a given piece of scatter wants.
  const geo = opts.quality?.geometry ?? 1;
  const t01 = Math.min(1, Math.max(0, (geo - 0.42) / 0.58));
  const lerpQ = (a, b) => Math.round(a + (b - a) * t01);
  const lod = 0.6 + (1.0 - 0.6) * t01;

  const group = new THREE.Group();
  group.name = 'islands';

  const seabedH = (opts.seabed && typeof opts.seabed.seabedHeight === 'function')
    ? opts.seabed.seabedHeight
    : (x, z) => -3 - 0.03 * Math.sqrt(x * x + z * z);

  const geoms = [];

  // --- the rock ------------------------------------------------------------
  const rockMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0.0, flatShading: true,
  });

  for (const isl of ISLANDS) {
    const saveR = isl.rings, saveS = isl.sectors;
    isl.rings = Math.max(24, Math.round(saveR * lod));
    isl.sectors = Math.max(48, Math.round(saveS * lod));
    const geo = buildIslandGeometry(isl);
    isl.rings = saveR; isl.sectors = saveS;
    geoms.push(geo);
    const mesh = new THREE.Mesh(geo, rockMat);
    mesh.name = 'island-' + isl.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // --- boulders and sea stacks ---------------------------------------------
  const rockGeos = [
    makeRockGeometry(7, 1, 0.72),
    makeRockGeometry(23, 1, 0.58),
    makeRockGeometry(61, 1, 0.90),
  ];
  for (const g of rockGeos) geoms.push(g);
  const stackGeo = makeRockGeometry(131, 1, 1.0);
  geoms.push(stackGeo);

  const BOULDERS = lerpQ(54, 96);
  const boulderMesh = new THREE.InstancedMesh(rockGeos[0], rockMat, BOULDERS);
  const boulderMesh2 = new THREE.InstancedMesh(rockGeos[1], rockMat, BOULDERS);
  const boulderMesh3 = new THREE.InstancedMesh(rockGeos[2], rockMat, Math.round(BOULDERS * 0.6));
  const meshes = [boulderMesh, boulderMesh2, boulderMesh3];
  const counts = [0, 0, 0];

  const placeRock = (mesh, i, x, z, sx, sy, sz, tintScale) => {
    const g = seabedH(x, z);
    const l = landHeightAt(x, z);
    const y = (l === -Infinity ? g : Math.max(g, l));
    _e.set(rng.range(-0.22, 0.22), rng.range(0, TAU), rng.range(-0.22, 0.22));
    _q.setFromEuler(_e);
    _v.set(x, y - sy * 0.30, z);
    _sc.set(sx, sy, sz);
    _m4.compose(_v, _q, _sc);
    mesh.setMatrixAt(i, _m4);
    const t = tintScale;
    _tint.setRGB(t * rng.range(0.94, 1.06), t * rng.range(0.94, 1.04), t * rng.range(0.88, 1.0));
    mesh.setColorAt(i, _tint);
  };

  // Around each island's shoreline...
  for (const isl of ISLANDS) {
    const n = Math.round((isl.R / 108) * 34 * (0.6 + 0.4 * t01));
    for (let i = 0; i < n; i++) {
      const ang = rng.range(0, TAU);
      const rr = shoreRadius(isl, ang);
      const t = rng.range(0.94, 1.32);
      const x = isl.cx + Math.cos(ang) * rr * t;
      const z = isl.cz + Math.sin(ang) * rr * t;
      const mi = rng.int(0, 2);
      if (counts[mi] >= meshes[mi].count) continue;
      const s = rng.range(1.1, 3.4) * (isl.R / 90);
      placeRock(meshes[mi], counts[mi]++, x, z, s, s * rng.range(0.55, 1.0), s * rng.range(0.8, 1.25), rng.range(0.85, 1.15));
    }
  }
  // ...and a scatter out on the reef flats, where they break the sand up.
  for (let i = 0, drift = lerpQ(26, 46); i < drift; i++) {
    const a = rng.range(0, TAU);
    const r = 40 + 190 * Math.sqrt(rng.next());
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (isLandAt(x, z)) continue;
    const mi = rng.int(0, 2);
    if (counts[mi] >= meshes[mi].count) continue;
    const s = rng.range(0.8, 2.6);
    placeRock(meshes[mi], counts[mi]++, x, z, s, s * rng.range(0.5, 0.9), s * rng.range(0.8, 1.3), rng.range(0.80, 1.05));
  }

  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    // Park unused instances at a zero scale rather than leaving stale matrices.
    for (let i = counts[mi]; i < m.count; i++) {
      _m4.makeScale(0, 0, 0);
      m.setMatrixAt(i, _m4);
      m.setColorAt(i, _tint.setRGB(1, 1, 1));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
  }

  // Sea stacks: the tall thin ones standing off the headlands.
  const STACKS = lerpQ(8, 15);
  const stackMesh = new THREE.InstancedMesh(stackGeo, rockMat, STACKS);
  for (let i = 0; i < STACKS; i++) {
    const isl = ISLANDS[rng.int(0, ISLANDS.length - 1)];
    const ang = rng.range(0, TAU);
    const rr = shoreRadius(isl, ang);
    const t = rng.range(1.06, 1.40);
    const x = isl.cx + Math.cos(ang) * rr * t;
    const z = isl.cz + Math.sin(ang) * rr * t;
    const bed = seabedH(x, z);
    const hgt = rng.range(7, 19);
    const wid = hgt * rng.range(0.22, 0.42);
    _e.set(rng.range(-0.10, 0.10), rng.range(0, TAU), rng.range(-0.10, 0.10));
    _q.setFromEuler(_e);
    _v.set(x, bed + hgt * 0.34, z);
    _sc.set(wid, hgt * 0.62, wid * rng.range(0.8, 1.25));
    _m4.compose(_v, _q, _sc);
    stackMesh.setMatrixAt(i, _m4);
    const g = rng.range(0.82, 1.10);
    stackMesh.setColorAt(i, _tint.setRGB(g * 1.02, g, g * 0.94));
  }
  stackMesh.instanceMatrix.needsUpdate = true;
  if (stackMesh.instanceColor) stackMesh.instanceColor.needsUpdate = true;
  stackMesh.castShadow = true;
  stackMesh.receiveShadow = true;
  stackMesh.frustumCulled = false;
  group.add(stackMesh);

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED, LAYER.UNDERWATER);
  // The islands run from summit to seabed and their submerged half is tinted
  // nearly black, so unclipped they stood up into the reflected sky as a wall
  // of black along the whole shoreline. Biggest single leak of the lot.
  applyWaterClip(group);

  // --- horizon -------------------------------------------------------------
  const distantGeo = makeDistantGeometry();
  geoms.push(distantGeo);
  const distantMat = new THREE.MeshBasicMaterial({
    vertexColors: true, fog: false, side: THREE.FrontSide,
  });
  const DISTANT = 17;
  const distantMesh = new THREE.InstancedMesh(distantGeo, distantMat, DISTANT);
  for (let i = 0; i < DISTANT; i++) {
    // Spread around the compass, biased toward the open sea to the north.
    const a = (i / DISTANT) * TAU + rng.range(-0.14, 0.14) - Math.PI * 0.5;
    const r = rng.range(1200, 2000);
    const w = rng.range(110, 420);
    const hgt = rng.range(26, 96) * (0.6 + 0.5 * (w / 420));
    _e.set(0, rng.range(0, TAU), 0);
    _q.setFromEuler(_e);
    _v.set(Math.cos(a) * r, -2.0, Math.sin(a) * r);
    _sc.set(w, hgt, w * rng.range(0.7, 1.35));
    _m4.compose(_v, _q, _sc);
    distantMesh.setMatrixAt(i, _m4);
    // Farther silhouettes sit closer to the haze colour.
    const haze = clamp((r - 1150) / 900, 0, 1);
    const g = 1.16 - 0.36 * (1 - haze) - rng.range(0, 0.08);
    distantMesh.setColorAt(i, _tint.setRGB(g, g, g * 1.03));
  }
  distantMesh.instanceMatrix.needsUpdate = true;
  if (distantMesh.instanceColor) distantMesh.instanceColor.needsUpdate = true;
  distantMesh.frustumCulled = false;
  distantMesh.renderOrder = -1;
  group.add(distantMesh);
  setLayers(distantMesh, LAYER.MAIN, LAYER.REFLECTED);
  applyWaterClip(distantMesh);

  // --- env -----------------------------------------------------------------
  const _lift = new THREE.Color();
  const _dist = new THREE.Color();

  return {
    group,

    update() {},

    applyEnv(env) {
      if (!env) return;
      // A whisper of ambient bounce so the cliffs never go pure black at night,
      // tinted by whatever is actually in the sky.
      // Normalised first: the raw night sky colour is so close to black that
      // scaling it by a small number would be indistinguishable from zero.
      _lift.copy(env.ambientSky).lerp(env.fogColor, 0.45);
      const peak = Math.max(_lift.r, _lift.g, _lift.b);
      if (peak > 1e-4) _lift.multiplyScalar(1 / peak);
      rockMat.emissive.copy(_lift).multiplyScalar(0.008 + 0.030 * env.nightFactor);

      // Horizon silhouettes are the fog colour, pushed a little toward the
      // ground tone so they read as land and not as a hole in the sky.
      _dist.copy(env.fogColor);
      _dist.lerp(env.ambientGround, 0.34 * (1 - env.hazeStrength * 0.45));
      distantMat.color.copy(_dist);
    },

    dispose() {
      for (const g of geoms) g.dispose();
      rockMat.dispose();
      distantMat.dispose();
    },

    landHeight: landHeightAt,
    isLand: isLandAt,
    islandFloor,
    islands: ISLANDS,
  };
}
