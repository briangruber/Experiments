// Island plants — pines, palms, bushes, grass.
//
// The dark conical pine is the dominant silhouette on every island in the
// concept art (ref/01 lighthouse rock, ref/02 ridge line, ref/03 skyline), so
// most of the work here is getting that shape right: a short trunk under three
// to five *drooping* conical tiers, chunky and slightly leaning, in a dark
// blue-green.
//
// Everything is instanced and placed by asking terrain.isLand / landHeight —
// never by guessing. Density follows the ridges, thins on steep ground, and is
// deliberately thinned (not cleared) across the village's south-east terraces
// so models/village.js has room for its houses.
//
// Layers: LAYER.MAIN + LAYER.REFLECTED. Plants are above the waterline, so they
// belong in the reflection target and never in the refraction target.

import * as THREE from 'three';
import {
  Fn, uniform, attribute, positionLocal, positionGeometry,
  clamp as tslClamp, pow, sin, cos,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng, fbm2D, smoothstep, clamp } from '../core/rng.js';

// --- module scope scratch ---------------------------------------------------

const _m4 = new THREE.Matrix4();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _UP = new THREE.Vector3(0, 1, 0);

const SRGB = THREE.SRGBColorSpace;
const col = (hex) => new THREE.Color().setHex(hex, SRGB);

// The binding world layout. Village island, lighthouse island, outer rock.
const ISLANDS = [
  { cx: -150, cz: -60, r: 134, village: true },
  { cx: 215, cz: -195, r: 92, village: false },
  { cx: 340, cz: -70, r: 66, village: false },
];

// --------------------------------------------------------------------- utils

/**
 * Flatten `{ geo, matrix, color, grad }` parts into one non-indexed geometry.
 * `color` bakes a flat albedo into the vertex colours; `grad` ramps between two
 * colours over local height, which is what gives a grass blade a dark root and
 * a sunlit tip out of a single instanced draw.
 */
function mergeGeos(entries) {
  const parts = [];
  let total = 0;
  for (const e of entries) {
    const g = e.geo.index ? e.geo.toNonIndexed() : e.geo.clone();
    if (e.matrix) g.applyMatrix4(e.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push({ g, color: e.color, grad: e.grad });
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const cls = new Float32Array(total * 3);
  let o = 0;
  for (const part of parts) {
    const g = part.g;
    const pa = g.attributes.position;
    const na = g.attributes.normal;
    const ta = g.attributes.uv;
    const n = pa.count;
    pos.set(pa.array.subarray(0, n * 3), o * 3);
    nrm.set(na.array.subarray(0, n * 3), o * 3);
    if (ta) uvs.set(ta.array.subarray(0, n * 2), o * 2);
    if (part.grad) {
      const { a, b, h } = part.grad;
      for (let i = 0; i < n; i++) {
        const t = clamp(pos[(o + i) * 3 + 1] / h, 0, 1);
        cls[(o + i) * 3] = a.r + (b.r - a.r) * t;
        cls[(o + i) * 3 + 1] = a.g + (b.g - a.g) * t;
        cls[(o + i) * 3 + 2] = a.b + (b.b - a.b) * t;
      }
    } else {
      const c = part.color;
      const r = c ? c.r : 1, gg = c ? c.g : 1, bb = c ? c.b : 1;
      for (let i = 0; i < n; i++) {
        cls[(o + i) * 3] = r; cls[(o + i) * 3 + 1] = gg; cls[(o + i) * 3 + 2] = bb;
      }
    }
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setAttribute('color', new THREE.BufferAttribute(cls, 3));
  return out;
}

function ground(geo) {
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function limbMatrix(fx, fy, fz, dx, dy, dz, len, rad, out) {
  _n.set(dx, dy, dz).normalize();
  _qa.setFromUnitVectors(_UP, _n);
  _p.set(fx + _n.x * len * 0.5, fy + _n.y * len * 0.5, fz + _n.z * len * 0.5);
  _s.set(rad, len, rad);
  return out.compose(_p, _qa, _s);
}

// ------------------------------------------------------------------ the pine
//
// One tier is a lathe whose profile falls *below* its own base ring — that is
// what makes the skirt droop instead of reading as a plain cone.

function makePine(rng, tiers, height, radius, needle, trunkColor) {
  const entries = [];
  const trunkH = height * 0.26;
  const trunk = new THREE.CylinderGeometry(radius * 0.10, radius * 0.18, trunkH * 1.8, 6);
  trunk.translate(0, trunkH * 0.9, 0);
  entries.push({ geo: trunk, color: trunkColor });

  const base = trunkH * 0.78;
  const canopy = height - base;
  for (let i = 0; i < tiers; i++) {
    const t = tiers > 1 ? i / (tiers - 1) : 0;
    const y = base + t * canopy * 0.80;
    const r = radius * (1 - 0.70 * t) * rng.range(0.90, 1.10);
    const h = (canopy / tiers) * 1.45;
    const tier = new THREE.LatheGeometry([
      new THREE.Vector2(0.005, h),
      new THREE.Vector2(r * 0.40, h * 0.52),
      new THREE.Vector2(r * 0.78, h * 0.16),
      new THREE.Vector2(r, -h * 0.26),
    ], 7);
    tier.rotateY(rng.range(0, 1.06));
    tier.translate(0, y, 0);
    entries.push({ geo: tier, color: needle.clone().multiplyScalar(0.80 + 0.30 * t) });
  }

  const spire = new THREE.ConeGeometry(radius * 0.19, canopy * 0.34, 6);
  spire.translate(0, base + canopy * 0.88, 0);
  entries.push({ geo: spire, color: needle.clone().multiplyScalar(1.14) });

  const g = mergeGeos(entries);
  for (const e of entries) e.geo.dispose();
  return ground(g);
}

// ------------------------------------------------------------------ the palm

function frondGeo(len, width, droop) {
  const g = new THREE.PlaneGeometry(len, width, 6, 2);
  g.rotateX(-Math.PI / 2);
  g.translate(len * 0.5, 0, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const t = clamp(x / len, 0, 1);
    const w = Math.sin(Math.pow(t, 0.7) * Math.PI * 0.95) * 1.10 + 0.12;
    const nz = z * w;
    const fold = -Math.abs(nz) * 0.45;
    p.setXYZ(i, x, -droop * t * t * len + fold, nz);
  }
  g.computeVertexNormals();
  return g;
}

function makePalm(rng, trunkColor, frondColor) {
  const entries = [];
  const H = rng.range(5.0, 6.4);
  const lean = rng.range(0.9, 1.9);
  const cyl = new THREE.CylinderGeometry(0.78, 1.0, 1.0, 5, 1, true);
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const x0 = lean * t0 * t0, y0 = H * t0;
    const x1 = lean * t1 * t1, y1 = H * t1;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    entries.push({
      geo: cyl,
      matrix: limbMatrix(x0, y0, 0, dx, dy, 0, len, 0.32 * (1 - 0.40 * t0), new THREE.Matrix4()),
      color: trunkColor.clone().multiplyScalar(0.86 + 0.22 * t0),
    });
  }
  const nf = 7;
  for (let i = 0; i < nf; i++) {
    const a = (i / nf) * Math.PI * 2 + rng.range(-0.22, 0.22);
    const pitch = rng.range(0.10, 0.52);
    const f = frondGeo(rng.range(2.0, 2.9), rng.range(0.5, 0.72), rng.range(0.22, 0.42));
    _qa.setFromAxisAngle(_UP, a);
    _qb.setFromAxisAngle(_n.set(0, 0, 1), pitch);
    _qa.multiply(_qb);
    _p.set(lean, H, 0);
    _s.setScalar(1);
    entries.push({
      geo: f,
      matrix: new THREE.Matrix4().compose(_p, _qa, _s),
      color: frondColor.clone().multiplyScalar(0.82 + 0.30 * (i / nf)),
    });
  }
  // a knot of coconuts under the crown
  const nut = new THREE.IcosahedronGeometry(0.17, 0);
  for (let i = 0; i < 3; i++) {
    _p.set(lean + Math.cos(i * 2.1) * 0.22, H - 0.25, Math.sin(i * 2.1) * 0.22);
    _s.setScalar(1);
    entries.push({ geo: nut, matrix: new THREE.Matrix4().compose(_p, _qb.identity(), _s), color: col(0x6E5330) });
  }
  const g = mergeGeos(entries);
  cyl.dispose(); nut.dispose();
  for (const e of entries) if (e.geo !== cyl && e.geo !== nut) e.geo.dispose();
  return ground(g);
}

// ------------------------------------------------------------ bushes + grass

function makeBush(rng, color) {
  const blob = new THREE.IcosahedronGeometry(1, 0);
  const entries = [];
  const lobes = 5;
  for (let i = 0; i < lobes; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.pow(rng.next(), 0.6) * 0.52;
    const h = rng.range(0.20, 0.62);
    _p.set(Math.cos(a) * rr, h, Math.sin(a) * rr);
    const s = rng.range(0.34, 0.58) * (1.2 - h * 0.55);
    _s.set(s * rng.range(0.9, 1.25), s * rng.range(0.7, 1.0), s * rng.range(0.9, 1.25));
    _qb.setFromAxisAngle(_UP, rng.range(0, 6.28));
    entries.push({
      geo: blob,
      matrix: new THREE.Matrix4().compose(_p, _qb, _s),
      color: color.clone().multiplyScalar(0.78 + 0.42 * (h / 0.62)),
    });
  }
  const g = mergeGeos(entries);
  blob.dispose();
  return ground(g);
}

function makeGrass(rng, baseColor, tipColor) {
  const entries = [];
  const blades = 5;
  const H = 0.42;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rng.range(-0.6, 0.6);
    const h = H * rng.range(0.62, 1.0);
    const g = new THREE.PlaneGeometry(0.055, h, 1, 3);
    g.translate(0, h * 0.5, 0);
    const p = g.attributes.position;
    const bend = rng.range(0.10, 0.26);
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), y = p.getY(v);
      const t = clamp(y / h, 0, 1);
      p.setXYZ(v, x * (1 - 0.85 * t * t), y - bend * t * t * 0.35, bend * t * t);
    }
    g.computeVertexNormals();
    g.rotateY(a);
    g.translate(Math.cos(a) * rng.range(0, 0.06), 0, Math.sin(a) * rng.range(0, 0.06));
    entries.push({ geo: g, grad: { a: baseColor, b: tipColor, h } });
  }
  const g = mergeGeos(entries);
  for (const e of entries) e.geo.dispose();
  return ground(g);
}

// ------------------------------------------------------------------- shading

// The wind sway. This used to be an injection into `begin_vertex`; on the node
// renderer it is the material's `positionNode`.
//
// One wrinkle the GLSL did not have: by the time `positionNode` is evaluated the
// instance transform has *already* been folded into `positionLocal`, so the
// object-space quantities the sway needs are no longer there. Three small
// per-instance attributes carry them instead — `aVegOrigin` is the instance's
// world x/z (the phase decorrelator that used to be `instanceMatrix[3].xyz`),
// and `aVegAxisX` / `aVegAxisZ` are instanceMatrix's X and Z columns, so the
// displacement still rides the instance's own yaw, tilt and scale exactly as it
// did when it was added before the matrix multiply.
function decorateVegMaterial(mat, uni, swayHeight, swayAmp) {
  const uVegSwayH = uniform(swayHeight);
  const uVegSwayAmp = uniform(swayAmp);

  mat.positionNode = Fn(() => {
    const origin = attribute('aVegOrigin', 'vec2');

    // Amplitude is scaled by height above the instance base, so trunks and root
    // clumps stay planted while the canopy moves.
    const vegH = tslClamp(positionGeometry.y.div(uVegSwayH), 0, 1);
    const vegAmp = pow(vegH, 1.7).mul(uVegSwayAmp).mul(uni.uVegWind);
    const vegPh = uni.uVegTime.mul(1.10)
      .add(origin.x.mul(0.085)).add(origin.y.mul(0.127)).toVar();
    const vegGust = sin(
      uni.uVegTime.mul(0.29).add(origin.x.mul(0.011)).add(origin.y.mul(0.009)),
    ).mul(0.38).add(0.62);
    const k = vegAmp.mul(vegGust).mul(0.75).toVar();

    const dx = sin(vegPh).add(sin(vegPh.mul(2.7).add(1.3)).mul(0.40)).mul(k);
    const dz = cos(vegPh.mul(0.83)).mul(0.55).add(sin(vegPh.mul(2.1)).mul(0.28)).mul(k);

    return positionLocal
      .add(attribute('aVegAxisX', 'vec3').mul(dx))
      .add(attribute('aVegAxisZ', 'vec3').mul(dz));
  })();
}

// ---------------------------------------------------------------- the module

export function createVegetation(opts = {}) {
  const group = new THREE.Group();
  group.name = 'vegetation';

  const terrain = opts.terrain;
  const uni = { uVegTime: uniform(0), uVegWind: uniform(1) };

  if (!terrain || typeof terrain.isLand !== 'function' || typeof terrain.landHeight !== 'function') {
    return { group, update() {}, applyEnv() {}, dispose() {} };
  }

  const seed = (opts.seed | 0) || 20260807;
  const rng = makeRng((seed ^ 0x7E9E7A) >>> 0);
  const tierName = (opts.quality && opts.quality.tier) || 'high';
  const q = tierName === 'low' ? 0.40 : tierName === 'med' ? 0.68 : 1.0;

  const isLand = terrain.isLand;
  const landHeight = terrain.landHeight;

  /** landHeight, but only where there really is land. */
  function probe(x, z) {
    if (!isLand(x, z)) return null;
    const h = landHeight(x, z);
    return Number.isFinite(h) ? h : null;
  }

  // The village terraces down the island's south-east face between roughly 6 m
  // and 40 m. Thin the planting there rather than clearing it — the concept art
  // still has trees threaded between the houses.
  function villageThin(x, z, y) {
    const dx = x + 150, dz = z + 60;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return 1;
    const ux = dx / d, uz = dz / d;
    const face = Math.max(ux * 0.72 + uz * 0.69, ux * 0.97 - uz * 0.24);
    const wedge = smoothstep(0.30, 0.80, face);
    const band = smoothstep(4, 8, y) * (1 - smoothstep(34, 46, y));
    const near = 1 - smoothstep(72, 118, d);
    return 1 - 0.76 * wedge * band * near;
  }

  // --- candidate scatter ----------------------------------------------------

  const pineC = [];
  const bushC = [];
  const grassC = [];
  const palmC = [];
  let landHits = 0;

  let regions = ISLANDS;

  function scan(step) {
    for (const isl of regions) {
      for (let gz = isl.cz - isl.r; gz <= isl.cz + isl.r; gz += step) {
        for (let gx = isl.cx - isl.r; gx <= isl.cx + isl.r; gx += step) {
          const x = gx + (rng.next() - 0.5) * step;
          const z = gz + (rng.next() - 0.5) * step;
          if (Math.hypot(x - isl.cx, z - isl.cz) > isl.r) continue;
          if (!isLand(x, z)) continue;
          const y = landHeight(x, z);
          if (!Number.isFinite(y) || y < 0.55) continue;
          landHits++;

          const e = 1.8;
          const hxp = probe(x + e, z), hxn = probe(x - e, z);
          const hzp = probe(x, z + e), hzn = probe(x, z - e);
          let edge = 0;
          if (hxp === null) edge++;
          if (hxn === null) edge++;
          if (hzp === null) edge++;
          if (hzn === null) edge++;
          const sx = ((hxp === null ? y : hxp) - (hxn === null ? y : hxn)) / (2 * e);
          const sz = ((hzp === null ? y : hzp) - (hzn === null ? y : hzn)) / (2 * e);
          const slope = Math.hypot(sx, sz);
          const edgeF = Math.min(1, edge * 0.5);

          const thin = isl.village ? villageThin(x, z, y) : 1;
          const flat = 1 - smoothstep(0.46, 0.82, slope);
          // Pines hang on to ground that a bush would slide off.
          const treeFlat = 1 - smoothstep(0.48, 0.84, slope);
          const ridge = smoothstep(6, 34, y);
          const stand = fbm2D(x * 0.031 + 7.7, z * 0.031 - 3.1, 3) * 0.5 + 0.5;

          const r0 = rng.next(), r1 = rng.next(), r2 = rng.next(), r3 = rng.next();

          // Palms: the sandy cove on the village island's south shore. They
          // cluster round the cove and only straggle along the rest of the
          // southern beach, never up the hill.
          if (isl.village && y > 0.6 && y < 7.5 && slope < 0.66) {
            const cove = 1 - smoothstep(26, 78, Math.hypot(x + 150, z - 24));
            const beach = (z > -30 && edgeF > 0.2) ? 1 - smoothstep(2.5, 6.5, y) : 0;
            const pp = 0.70 * Math.max(cove, beach * 0.22) * (0.45 + 0.55 * edgeF);
            if (rng.next() < pp) { palmC.push(x, y, z, r0, r1, r2, r3); continue; }
          }

          const pineP = 0.34 * treeFlat * smoothstep(2.0, 8, y) * (0.38 + 0.95 * ridge)
            * smoothstep(0.20, 0.58, stand) * thin;
          if (rng.next() < pineP) { pineC.push(x, y, z, r0, r1, r2, r3); continue; }

          const bushP = 0.14 * flat * smoothstep(0.9, 4, y) * (0.45 + 0.70 * (1 - stand)) * thin;
          if (rng.next() < bushP) { bushC.push(x, y, z, r0, r1, r2, r3); continue; }

          const grassP = 0.52 * (1 - smoothstep(0.56, 0.96, slope)) * (0.50 + 0.90 * edgeF)
            * (0.55 + 0.45 * thin);
          if (rng.next() < grassP) grassC.push(x, y, z, r0, r1, r2, r3);
        }
      }
    }
  }

  scan(2.6);
  if (landHits === 0) {
    // The three discs above are the binding layout, but if the island module
    // put its land somewhere else entirely, find it rather than plant nothing.
    regions = [{ cx: 20, cz: -110, r: 520, village: false }];
    scan(4.2);
  }

  function shuffleTake(list, cap) {
    const n = list.length / 7;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      for (let k = 0; k < 7; k++) {
        const t = list[i * 7 + k]; list[i * 7 + k] = list[j * 7 + k]; list[j * 7 + k] = t;
      }
    }
    list.length = Math.min(list.length, cap * 7);
    return list.length / 7;
  }

  shuffleTake(pineC, Math.round(560 * q));
  shuffleTake(bushC, Math.round(320 * q));
  shuffleTake(grassC, Math.round(860 * q));
  shuffleTake(palmC, Math.round(24 * q));

  // --- materials ------------------------------------------------------------

  const matTree = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.94, metalness: 0,
    side: THREE.DoubleSide, fog: true, dithering: true,
  });
  const matUnder = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.96, metalness: 0,
    side: THREE.DoubleSide, fog: true, dithering: true,
  });
  decorateVegMaterial(matTree, uni, 9.0, 0.19);
  decorateVegMaterial(matUnder, uni, 0.45, 0.055);

  // --- geometry -------------------------------------------------------------

  const TRUNK = col(0x4C382A);
  const NEEDLE = [col(0x24422F), col(0x1C3A31), col(0x2C4A2E)];

  const pineGeos = [
    makePine(rng, 5, 10.5, 3.15, NEEDLE[0], TRUNK),  // tall ridge pine
    makePine(rng, 4, 7.6, 2.70, NEEDLE[1], TRUNK),   // the workhorse
    makePine(rng, 3, 5.0, 2.30, NEEDLE[2], TRUNK),   // stunted, exposed
  ];
  const pineShare = [0.28, 0.42, 0.30];
  const palmGeo = makePalm(rng, col(0x6E5A3E), col(0x4E7C3A));
  const bushGeo = makeBush(rng, col(0x466B33));
  const grassGeo = makeGrass(rng, col(0x35502A), col(0x7A9445));

  // --- instancing -----------------------------------------------------------

  const meshes = [];

  /**
   * Lay a bucket of candidates down as instanced meshes. `variants` lets one
   * bucket feed several geometries (the three pine silhouettes).
   */
  function place(list, variants, share, material, cfg) {
    const n = list.length / 7;
    if (n < 1) return;
    const counts = new Array(variants.length).fill(0);
    const pickOf = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = list[i * 7 + 3];
      let acc = 0, v = variants.length - 1;
      for (let k = 0; k < variants.length; k++) {
        acc += share[k];
        if (r <= acc) { v = k; break; }
      }
      pickOf[i] = v;
      counts[v]++;
    }
    const built = variants.map((geo, k) =>
      counts[k] > 0 ? new THREE.InstancedMesh(geo, material, counts[k]) : null);
    const cursor = new Array(variants.length).fill(0);

    // What the sway shader needs out of each instance matrix; see
    // decorateVegMaterial.
    const swayO = counts.map((c) => (c > 0 ? new Float32Array(c * 2) : null));
    const swayX = counts.map((c) => (c > 0 ? new Float32Array(c * 3) : null));
    const swayZ = counts.map((c) => (c > 0 ? new Float32Array(c * 3) : null));

    for (let i = 0; i < n; i++) {
      const o = i * 7;
      const x = list[o], y = list[o + 1], z = list[o + 2];
      const r1 = list[o + 4], r2 = list[o + 5], r3 = list[o + 6];
      const v = pickOf[i];
      const mesh = built[v];
      if (!mesh) continue;

      // Lean with the ground, but only part way — a pine on a slope still
      // reaches for the sky.
      const e = 2.0;
      const hxp = probe(x + e, z), hxn = probe(x - e, z);
      const hzp = probe(x, z + e), hzn = probe(x, z - e);
      const sx = ((hxp === null ? y : hxp) - (hxn === null ? y : hxn)) / (2 * e);
      const sz = ((hzp === null ? y : hzp) - (hzn === null ? y : hzn)) / (2 * e);
      _n.set(-sx * cfg.tilt, 1, -sz * cfg.tilt).normalize();
      _qa.setFromUnitVectors(_UP, _n);
      _qb.setFromAxisAngle(_UP, r1 * Math.PI * 2);
      _qa.multiply(_qb);

      const s = cfg.sMin + (cfg.sMax - cfg.sMin) * Math.pow(r2, cfg.bias || 1);
      _p.set(x, y - cfg.sink * s, z);
      _s.set(s * (1 + (r3 - 0.5) * cfg.wobble), s * (1 + (r2 - 0.5) * cfg.wobble * 0.7), s * (1 + (r1 - 0.5) * cfg.wobble));
      _m4.compose(_p, _qa, _s);

      const idx = cursor[v]++;
      mesh.setMatrixAt(idx, _m4);

      const me = _m4.elements;
      swayO[v][idx * 2] = me[12]; swayO[v][idx * 2 + 1] = me[14];
      swayX[v][idx * 3] = me[0]; swayX[v][idx * 3 + 1] = me[1]; swayX[v][idx * 3 + 2] = me[2];
      swayZ[v][idx * 3] = me[8]; swayZ[v][idx * 3 + 1] = me[9]; swayZ[v][idx * 3 + 2] = me[10];

      // instanceColor is a tint on top of the baked vertex albedo, so the same
      // geometry gives a stand of trees that are not all the identical green.
      const t = (r3 - 0.5);
      _c.setRGB(
        clamp(1 + t * cfg.hue + (r2 - 0.5) * cfg.value, 0.55, 1.35),
        clamp(1 - t * cfg.hue * 0.35 + (r2 - 0.5) * cfg.value, 0.55, 1.35),
        clamp(1 - t * cfg.hue * 0.9 + (r2 - 0.5) * cfg.value, 0.55, 1.35),
      );
      mesh.setColorAt(idx, _c);
    }

    for (let k = 0; k < built.length; k++) {
      const mesh = built[k];
      if (!mesh) { variants[k].dispose(); continue; }
      mesh.geometry.setAttribute('aVegOrigin', new THREE.InstancedBufferAttribute(swayO[k], 2));
      mesh.geometry.setAttribute('aVegAxisX', new THREE.InstancedBufferAttribute(swayX[k], 3));
      mesh.geometry.setAttribute('aVegAxisZ', new THREE.InstancedBufferAttribute(swayZ[k], 3));
      mesh.count = cursor[k];
      mesh.name = cfg.name + '-' + k;
      mesh.castShadow = !!cfg.castShadow;
      mesh.receiveShadow = !!cfg.receiveShadow;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      meshes.push(mesh);
    }
  }

  place(pineC, pineGeos, pineShare, matTree, {
    name: 'pine', tilt: 0.30, sMin: 0.72, sMax: 1.35, bias: 1.15, sink: 0.28,
    wobble: 0.16, hue: 0.12, value: 0.18, castShadow: true, receiveShadow: true,
  });
  place(palmC, [palmGeo], [1], matTree, {
    name: 'palm', tilt: 0.22, sMin: 0.80, sMax: 1.25, sink: 0.20,
    wobble: 0.12, hue: 0.10, value: 0.14, castShadow: true, receiveShadow: true,
  });
  place(bushC, [bushGeo], [1], matUnder, {
    name: 'bush', tilt: 0.55, sMin: 0.60, sMax: 1.45, bias: 1.2, sink: 0.16,
    wobble: 0.28, hue: 0.14, value: 0.22, castShadow: true, receiveShadow: true,
  });
  place(grassC, [grassGeo], [1], matUnder, {
    name: 'grass', tilt: 0.85, sMin: 0.70, sMax: 1.60, sink: 0.06,
    wobble: 0.30, hue: 0.10, value: 0.26, castShadow: false, receiveShadow: false,
  });

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);

  // --- module surface -------------------------------------------------------

  return {
    group,

    update(ctx) {
      uni.uVegTime.value = ctx.time;
    },

    applyEnv(env) {
      // Foliage should not crush to pure black under the moon; lift it with a
      // trace of the sky's own ambient rather than an invented colour.
      const e = 0.018 + 0.055 * env.nightFactor;
      matTree.emissive.copy(env.ambientSky).multiplyScalar(e);
      matUnder.emissive.copy(env.ambientSky).multiplyScalar(e * 1.2);
      matTree.emissiveIntensity = 1;
      matUnder.emissiveIntensity = 1;
      // Calmer air at dawn and after dark, a working breeze in the afternoon.
      uni.uVegWind.value = 0.55 + 0.55 * env.dayFactor;
    },

    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.dispose();
        group.remove(m);
      }
      meshes.length = 0;
      matTree.dispose();
      matUnder.dispose();
    },
  };
}
