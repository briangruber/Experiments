// The reef — instanced coral, kelp, urchins and rubble.
//
// This is the module that makes the water read as *clear*. The refraction pass
// has nothing interesting to show unless there is a carpet of coral heads and
// dark olive bushes under it (ref/01, ref/02), so everything here lives on
// LAYER.MAIN + LAYER.UNDERWATER.
//
// Seven archetypes, each one InstancedMesh, scattered through a worley/fbm
// clump mask so the reef forms patches with clean sand between them. Nothing is
// placed by guessing a height: every instance asks terrain.seabedHeight().
//
// Two shared MeshStandardNodeMaterials carry the whole reef:
//   matRigid  front-faced, still      brain / table / staghorn / bush / urchin / rubble
//   matSoft   double-sided, swaying   sea fan / kelp
// Both get a cheap caustic ripple folded into the lit result so the reef
// shimmers with the same light the seabed does.

import * as THREE from 'three';
import {
  Fn, uniform, attribute, positionLocal, positionGeometry, positionWorld, normalWorld, float,
  vec2, vec3, vec4, floor, fract, dot, mix, abs, sin, cos, oneMinus, max as tslMax,
  clamp as tslClamp, smoothstep as tslSmoothstep,
} from 'three/tsl';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng, fbm2D, worley2D, smoothstep, clamp } from '../core/rng.js';

// --- module scope scratch (never allocate in update, never in a hot loop) ----

const _m4 = new THREE.Matrix4();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _UP = new THREE.Vector3(0, 1, 0);
const _worley = { d: 0, id: 0 };

const SRGB = THREE.SRGBColorSpace;
const col = (hex) => new THREE.Color().setHex(hex, SRGB);

// --------------------------------------------------------------------- utils

/**
 * Concatenate a list of `{ geo, matrix, color }` into one non-indexed
 * BufferGeometry with position / normal / uv / color. `color` is baked per part
 * so a single instanced draw can still have a lighter tip or a darker base;
 * the per-instance albedo arrives separately through instanceColor.
 */
function mergeGeos(entries) {
  const parts = [];
  let total = 0;
  for (const e of entries) {
    const g = e.geo.index ? e.geo.toNonIndexed() : e.geo.clone();
    if (e.matrix) g.applyMatrix4(e.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push({ g, color: e.color });
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
    const c = part.color;
    const r = c ? c.r : 1, gg = c ? c.g : 1, b = c ? c.b : 1;
    for (let i = 0; i < n; i++) {
      cls[(o + i) * 3] = r; cls[(o + i) * 3 + 1] = gg; cls[(o + i) * 3 + 2] = b;
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

/** Drop a geometry so its lowest point sits exactly on y = 0. */
function ground(geo) {
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Matrix that lays a unit +Y cylinder from `from` along `dir` for `len`. */
function limbMatrix(fx, fy, fz, dx, dy, dz, len, rad, out) {
  _n.set(dx, dy, dz).normalize();
  _qa.setFromUnitVectors(_UP, _n);
  _p.set(fx + _n.x * len * 0.5, fy + _n.y * len * 0.5, fz + _n.z * len * 0.5);
  _s.set(rad, len, rad);
  return out.compose(_p, _qa, _s);
}

// ------------------------------------------------------------- archetype geo

function makeBrain(rng) {
  const src = new THREE.SphereGeometry(1, 11, 7);
  const g = src;
  const p = g.attributes.position;
  const ox = rng.range(-40, 40), oz = rng.range(-40, 40);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const u = Math.atan2(z, x);
    const v = Math.asin(clamp(y, -1, 1));
    const warp = fbm2D(u * 1.4 + ox, v * 1.4 + oz, 3);
    const wrinkle = Math.sin(u * 7.5 + warp * 4.5) * Math.cos(v * 4.5 + warp * 2.5);
    const r = 1 + 0.085 * wrinkle + 0.055 * fbm2D(x * 1.9 + ox, z * 1.9 - oz, 2);
    const yy = Math.max(y, -0.12);
    p.setXYZ(i, x * r, yy * r * 0.60, z * r);
  }
  g.computeVertexNormals();
  const out = mergeGeos([{ geo: g, color: new THREE.Color(1, 1, 1) }]);
  src.dispose();
  return ground(out);
}

function makeTable(rng) {
  const light = new THREE.Color(1.0, 0.98, 0.94);
  const dark = new THREE.Color(0.62, 0.60, 0.58);
  const stalk = new THREE.CylinderGeometry(0.19, 0.28, 0.62, 7);
  stalk.translate(0, 0.31, 0);
  const plate = new THREE.CylinderGeometry(1.0, 0.68, 0.17, 13);
  const pp = plate.attributes.position;
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    const wob = 1 + 0.09 * Math.sin(a * 5 + rng.range(0, 0.4)) + 0.05 * Math.sin(a * 9);
    const dome = y > 0 ? 0.10 * (1 - Math.min(1, r)) : 0;
    pp.setXYZ(i, x * wob, y + dome, z * wob);
  }
  plate.computeVertexNormals();
  plate.translate(0, 0.68, 0);
  const g = mergeGeos([
    { geo: stalk, color: dark },
    { geo: plate, color: light },
  ]);
  stalk.dispose(); plate.dispose();
  return ground(g);
}

function makeStaghorn(rng) {
  const seg = new THREE.CylinderGeometry(0.70, 1.0, 1.0, 5, 1, true);
  const blob = new THREE.OctahedronGeometry(1, 0);
  const entries = [];
  const light = new THREE.Color(1.0, 0.97, 0.92);
  const mid = new THREE.Color(0.80, 0.78, 0.76);

  const trunkLen = 0.42, trunkRad = 0.165;
  entries.push({ geo: seg, matrix: limbMatrix(0, 0, 0, 0, 1, 0, trunkLen, trunkRad, new THREE.Matrix4()), color: mid });

  const forks = 3;
  for (let i = 0; i < forks; i++) {
    const a = (i / forks) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const tilt = rng.range(0.42, 0.72);
    const dx = Math.cos(a) * Math.sin(tilt), dz = Math.sin(a) * Math.sin(tilt), dy = Math.cos(tilt);
    const len = rng.range(0.30, 0.44);
    const rad = trunkRad * rng.range(0.78, 0.92);
    entries.push({ geo: seg, matrix: limbMatrix(0, trunkLen, 0, dx, dy, dz, len, rad, new THREE.Matrix4()), color: mid });
    const bx = dx * len, by = trunkLen + dy * len, bz = dz * len;
    for (let j = 0; j < 2; j++) {
      const a2 = a + (j === 0 ? -0.7 : 0.7) + rng.range(-0.25, 0.25);
      const t2 = rng.range(0.25, 0.55);
      const ex = Math.cos(a2) * Math.sin(t2), ez = Math.sin(a2) * Math.sin(t2), ey = Math.cos(t2);
      const l2 = rng.range(0.22, 0.34);
      const r2 = rad * rng.range(0.74, 0.88);
      entries.push({ geo: seg, matrix: limbMatrix(bx, by, bz, ex, ey, ez, l2, r2, new THREE.Matrix4()), color: light });
      _p.set(bx + ex * l2, by + ey * l2, bz + ez * l2);
      _s.setScalar(r2 * rng.range(1.6, 2.2));
      entries.push({ geo: blob, matrix: new THREE.Matrix4().compose(_p, _qb.identity(), _s), color: light });
    }
  }
  const g = mergeGeos(entries);
  seg.dispose(); blob.dispose();
  return ground(g);
}

function makeBush(rng) {
  const blob = new THREE.IcosahedronGeometry(1, 0);
  const entries = [];
  const base = new THREE.CylinderGeometry(0.42, 0.55, 0.20, 8);
  base.translate(0, 0.10, 0);
  entries.push({ geo: base, color: new THREE.Color(0.55, 0.55, 0.52) });
  const lobes = 6;
  for (let i = 0; i < lobes; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = rng.range(0, 0.44) ** 0.7;
    const h = rng.range(0.14, 0.62);
    _p.set(Math.cos(a) * rr, h, Math.sin(a) * rr);
    const s = rng.range(0.25, 0.46) * (1.25 - h * 0.7);
    _s.set(s * rng.range(0.9, 1.3), s * rng.range(0.75, 1.15), s * rng.range(0.9, 1.3));
    _qb.setFromAxisAngle(_UP, rng.range(0, 6.28));
    const shade = 0.70 + 0.30 * (h / 0.62);
    entries.push({
      geo: blob,
      matrix: new THREE.Matrix4().compose(_p, _qb, _s),
      color: new THREE.Color(shade, shade * 1.02, shade * 0.96),
    });
  }
  const g = mergeGeos(entries);
  blob.dispose(); base.dispose();
  return ground(g);
}

function makeFan(rng) {
  const g = new THREE.PlaneGeometry(1, 1, 7, 6);
  const p = g.attributes.position;
  const twist = rng.range(-0.2, 0.2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const t = clamp(y + 0.5, 0, 1);
    const w = Math.sin(Math.pow(t, 0.8) * Math.PI * 0.86) * 0.92 + 0.10;
    const scallop = 1 + 0.13 * Math.sin(t * 11.0) + 0.07 * Math.sin(x * 14.0);
    const nx = x * w * scallop;
    const nz = 0.20 * Math.sin(t * 1.9) + 0.16 * nx * nx + twist * nx * t;
    p.setXYZ(i, nx, t, nz);
  }
  g.computeVertexNormals();
  const out = mergeGeos([{ geo: g, color: new THREE.Color(1, 1, 1) }]);
  g.dispose();
  return ground(out);
}

/** One tapered ribbon along +Y, base at the origin. */
function bladeGeo(height, width, segs, curveX, curveZ, taper) {
  const g = new THREE.PlaneGeometry(width, height, 1, segs);
  g.translate(0, height * 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const t = clamp(y / height, 0, 1);
    const w = 1 - taper * Math.pow(t, 1.35);
    p.setXYZ(i, x * w + curveX * t * t, y - Math.abs(curveX * t * t) * 0.25, curveZ * t * t);
  }
  g.computeVertexNormals();
  return g;
}

function makeKelp(rng) {
  const entries = [];
  const blades = 6;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const h = rng.range(0.62, 1.0);
    const b = bladeGeo(h, rng.range(0.11, 0.19), 4, Math.cos(a) * rng.range(0.10, 0.32), Math.sin(a) * rng.range(0.10, 0.32), 0.68);
    const off = rng.range(0.02, 0.13);
    b.rotateY(a + rng.range(-0.6, 0.6));
    b.translate(Math.cos(a) * off, 0, Math.sin(a) * off);
    const tipShade = 0.72 + 0.36 * (h / 1.0);
    entries.push({ geo: b, color: new THREE.Color(tipShade, tipShade * 1.05, tipShade * 0.82) });
  }
  const g = mergeGeos(entries);
  for (const e of entries) e.geo.dispose();
  return ground(g);
}

function makeUrchin(rng) {
  const body = new THREE.IcosahedronGeometry(0.5, 0);
  const spike = new THREE.ConeGeometry(0.05, 1.0, 3, 1, true);
  const entries = [{ geo: body, color: new THREE.Color(0.55, 0.52, 0.6) }];
  const N = 11;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + 0.5) / N * 1.35;         // biased to the upper hemisphere
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * 2.399963 + rng.range(-0.2, 0.2);
    const dx = Math.cos(a) * r, dz = Math.sin(a) * r;
    entries.push({
      geo: spike,
      matrix: limbMatrix(dx * 0.42, y * 0.42, dz * 0.42, dx, Math.max(0.12, y), dz, 0.46, 1, new THREE.Matrix4()),
      color: new THREE.Color(0.9, 0.88, 1.0),
    });
  }
  const g = mergeGeos(entries);
  body.dispose(); spike.dispose();
  return ground(g);
}

function makeRubble(rng) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  const ox = rng.range(-30, 30);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1 + 0.34 * fbm2D(x * 1.6 + ox, z * 1.6 - ox, 2) + 0.16 * fbm2D(y * 2.2, x * 2.2, 2);
    p.setXYZ(i, x * d, y * d * 0.62, z * d);
  }
  g.computeVertexNormals();
  const out = mergeGeos([{ geo: g, color: new THREE.Color(1, 1, 1) }]);
  g.dispose();
  return ground(out);
}

// ------------------------------------------------------------------ palettes
// Olive and forest greens dominate — that is what ref/01 actually shows —
// with accents of dusty rose, ochre, teal and muted purple. Everything here is
// read through several metres of water, which eats red first, so the albedo is
// biased warm on purpose.

// The vivid entries are a deliberate minority, not a recolour. The instance
// picker is uniform over each array, so one hot swatch in six paints ~17% of
// that archetype and leaves the rest doing the structural work — which is what
// a real reef looks like from above: olive and ochre, punctuated. Every added
// colour is one a soft coral or an encrusting plate actually is (magenta and
// violet gorgonians, coral pink, the aqua tips on staghorn), and they are
// concentrated in the archetypes that live SHALLOW, because that is where the
// water has not yet eaten the red out of them.
const PALETTE = {
  brain: [0xA0714E, 0xAC8259, 0x94665F, 0x9A7846, 0x866E48, 0x6E7A4C, 0xA87C66,
    0xC25A6E, 0xB8734E],
  table: [0xA6824C, 0x95764D, 0x8A6C3E, 0x7C824A, 0x976E52, 0xC08A5E],
  staghorn: [0x8E6C72, 0x7A6478, 0xA07C5E, 0x5E8478, 0x6E7A4A, 0x8A7060,
    0xB86E90, 0x5FA6A0],
  bush: [0x466833, 0x3A5A2A, 0x55702F, 0x2C4A2A, 0x44603A, 0x5C7638, 0x33502A, 0x4E6A2C,
    0x8A4E7A, 0x6E9A3C],
  fan: [0x8E6062, 0x745C76, 0x8E7046, 0x5E7E78, 0x86605A,
    0xC2447E, 0x8E4CA8, 0xD2685A, 0x3E9E9A],
  kelp: [0x3E5C2C, 0x314C28, 0x486A30, 0x2A4226, 0x536E33],
  urchin: [0x40304A, 0x33283C, 0x482E44, 0x2A2434],
  rubble: [0x847A6A, 0x746C60, 0x8E8070, 0x6C6A5E, 0x7E765E],
};

// ------------------------------------------------------------------- shading

// core/glsl.js's hash12 / vnoise, as node graphs. Identical constants, so the
// ripple lands in exactly the same places it did in GLSL.
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

const reefCaustic = Fn(([p, t]) => {
  const a = vnoise(p.add(vec2(t.mul(0.055), t.mul(-0.041))));
  const b = vnoise(p.mul(1.63).add(vec2(t.mul(-0.047), t.mul(0.062))));
  const v = oneMinus(tslClamp(abs(a.sub(b)).mul(3.4), 0, 1)).toVar();
  return v.mul(v).mul(v);
});

// The GLSL used to reach `instanceMatrix` directly; `positionNode` runs after
// the node renderer has already folded the instance transform into
// `positionLocal`, so the three things the sway needs out of that matrix ride
// along as per-instance attributes instead. `aReefOrigin` is the instance's
// world x/z (the phase decorrelator), `aReefAxisX` / `aReefAxisZ` are the
// matrix's X and Z columns, which is what carries the instance's yaw, tilt and
// scale into the displacement exactly as the multiply used to.
// --- the surface itself ------------------------------------------------------
//
// Coral has no usable UVs. The merged geometry does carry a `uv` attribute, but
// mergeGeos concatenates each source primitive's own untransformed 0..1 set with
// no atlas, so all three staghorn branches occupy the same square — a uv-based
// texture would compile happily and look wrong, which is the worst kind of
// wrong. And there is no per-head identifier on the six rigid archetypes:
// instanceColor is already spent on the albedo.
//
// So the texture is procedural, in GEOMETRY space. `positionGeometry` is the
// raw attribute — before the sway displaces it and before the instance matrix
// is folded in — so it is stable, it is free, and it is the same field on every
// head of an archetype. That last part sounds like a flaw and is not: two brain
// corals with identical corallites are indistinguishable at any distance you
// ever see them from, whereas a WORLD-space field would make neighbouring heads
// share a pattern where they overlap, which reads as a smear across both.
//
// Three sines multiplied is a lumpy periodic lattice for the price of three
// transcendentals — no hash, no texture fetch, no gradient noise. Two octaves of
// it at an irrational ratio give the coarse corallite bumps and the fine pitting
// between them, and the ratio keeps the beat frequency far longer than any head.
const uReefFreq = uniform(6.0);
const uReefFine = uniform(2.73);
const uReefAmp = uniform(1.5);

const reefSurface = Fn(([p, freq, soft]) => {
  const q = p.mul(freq).mul(uReefFreq).toVar();
  // The coarse lattice. Slightly different frequency per axis so the lumps are
  // not a cubic grid — a cubic grid reads instantly as a checkerboard.
  const a = sin(q.x).mul(sin(q.y.mul(1.31).add(1.7))).mul(sin(q.z.mul(0.92).add(3.1))).toVar();
  const r = q.mul(uReefFine).toVar();
  const b = sin(r.x.add(0.9)).mul(sin(r.y.mul(1.19))).mul(sin(r.z.mul(1.07).add(2.2))).toVar();

  // Soft corals are FIBROUS, not pitted: a blade or a fan is ribbed along its
  // length. Same cost, one different combination — the vertical term is kept
  // and the two lateral ones are collapsed into a single fine rib.
  const fib = sin(q.y.mul(3.4)).mul(0.5).add(sin(q.x.add(q.z).mul(1.6)).mul(0.5)).toVar();
  const lumps = mix(a.mul(0.62).add(b.mul(0.38)), fib, soft).toVar();

  // Deep pits go slightly BLUER as well as darker, because a pit is shaded by
  // its own walls and what reaches it is the water's own light, not the sun's.
  const shade = lumps.mul(0.5).add(0.5).sub(0.5).mul(uReefAmp).add(0.5).toVar();
  return vec3(
    float(0.72).add(shade.mul(0.46)),
    float(0.75).add(shade.mul(0.40)),
    float(0.84).add(shade.mul(0.26)),
  );
});

function decorateReefMaterial(mat, uni, sway) {
  // Frequency in cycles per metre of GEOMETRY space. The archetypes are built at
  // roughly life size before instancing, so 26 puts a corallite about 12 cm
  // across on a brain head and the fine octave at 4 cm — which is coarse for a
  // real coral and right for one that is usually eight metres away through
  // water. Soft corals get a longer rib.
  mat.colorNode = reefSurface(positionGeometry, sway ? 0.58 : 1.0, sway ? 1.0 : 0.0);

  if (sway) {
    mat.positionNode = Fn(() => {
      const origin = attribute('aReefOrigin', 'vec2');
      const reefAmp = tslSmoothstep(0.03, 1.0, positionGeometry.y).mul(uni.uReefSway);
      const reefPh = uni.uReefTime.mul(0.85)
        .add(origin.x.mul(0.29)).add(origin.y.mul(0.21)).toVar();
      return positionLocal
        .add(attribute('aReefAxisX', 'vec3').mul(sin(reefPh).mul(reefAmp).mul(0.17)))
        .add(attribute('aReefAxisZ', 'vec3').mul(sin(reefPh.mul(1.41).add(1.7)).mul(reefAmp).mul(0.13)));
    })();
  }

  // The shimmer multiplies the *lit* colour and has to land before fog, which is
  // where `#include <opaque_fragment>` used to put it. `setupOutput` is the node
  // material's fog hook, so wrapping it drops the caustic in at the same point
  // in the chain rather than on top of the fogged result.
  const causticGain = Fn(() => {
    const reefUp = tslClamp(normalWorld.y.mul(0.5).add(0.5), 0, 1).toVar();
    reefUp.mulAssign(reefUp);
    const reefFade = tslSmoothstep(-19.0, -1.5, positionWorld.y);
    const reefC = reefCaustic(positionWorld.xz.mul(0.42), uni.uReefTime);
    return uni.uCausticColor
      .mul(reefC.mul(uni.uCausticStrength).mul(reefUp).mul(reefFade))
      .add(1.0);
  })();

  const superSetupOutput = mat.setupOutput.bind(mat);
  mat.setupOutput = (builder, outputNode) =>
    superSetupOutput(builder, vec4(outputNode.rgb.mul(causticGain), outputNode.a));
}

// ---------------------------------------------------------------- the module

export function createCoral(opts = {}) {
  const group = new THREE.Group();
  group.name = 'coral';

  const terrain = opts.terrain;
  const uni = {
    uReefTime: uniform(0),
    uCausticColor: uniform(new THREE.Color(0.5, 0.8, 0.85)),
    uCausticStrength: uniform(0.55),
    uReefSway: uniform(1),
  };

  if (!terrain || typeof terrain.seabedHeight !== 'function') {
    return { group, update() {}, applyEnv() {}, dispose() {} };
  }

  const seed = (opts.seed | 0) || 20260807;
  const rng = makeRng((seed ^ 0x5c07a1) >>> 0);
  // The instance-count budget, straight off the tier. See TIERS in
  // core/renderer.js for why this is a number and not a tier-name ladder.
  const q = opts.quality?.geometry ?? 1;

  const H = terrain.seabedHeight;
  const onLand = typeof terrain.isLand === 'function' ? terrain.isLand : () => false;

  // --- masks ----------------------------------------------------------------

  // Worley cells ~19 m across give the reef its patchy structure; the fbm on
  // top breaks the cell edges up so the patches do not read as a lattice.
  function reefMask(x, z) {
    worley2D(x * 0.052 + 13.7, z * 0.052 - 5.1, _worley);
    const patch = 1 - smoothstep(0.20, 0.70, _worley.d);
    const grain = fbm2D(x * 0.072 + 41.3, z * 0.072 - 17.9, 3) * 0.5 + 0.5;
    const fine = fbm2D(x * 0.27 - 8.4, z * 0.27 + 3.6, 2) * 0.5 + 0.5;
    return clamp(patch * 0.66 + grain * 0.52 + fine * 0.18 - 0.36, 0, 1);
  }

  // Densest where the camera actually is: around the origin, with a second
  // lobe hugging the village shore and the dock.
  function reefRadial(x, z) {
    const a = 1 - smoothstep(115, 240, Math.hypot(x, z - 6));
    const b = 0.92 * (1 - smoothstep(55, 165, Math.hypot(x + 108, z - 4)));
    return Math.max(a, b);
  }

  // Coral wants 1.5–6 m of water; thin past 12 m, gone in the deep.
  function depthWeight(d) {
    if (d < 0.55) return 0;
    return smoothstep(0.55, 1.6, d)
      * (1 - 0.68 * smoothstep(6, 15, d))
      * (1 - smoothstep(17, 33, d));
  }

  const band = (d, a, b) => smoothstep(a - 0.5, a + 1.1, d) * (1 - smoothstep(b - 2.6, b + 0.6, d));

  // --- archetypes -----------------------------------------------------------

  const ARCH = [
    { key: 'bush', geo: makeBush(rng), soft: false, budget: 640, w: 1.70, dMin: 0.8, dMax: 13, sMin: 0.85, sMax: 2.40, sink: 0.18, tilt: 0.55, flat: 0.30 },
    { key: 'brain', geo: makeBrain(rng), soft: false, budget: 330, w: 0.86, dMin: 1.0, dMax: 10, sMin: 0.70, sMax: 1.90, sink: 0.26, tilt: 0.70, flat: 0.22 },
    { key: 'staghorn', geo: makeStaghorn(rng), soft: false, budget: 320, w: 0.82, dMin: 1.2, dMax: 11, sMin: 0.95, sMax: 2.10, sink: 0.12, tilt: 0.45, flat: 0.25 },
    { key: 'table', geo: makeTable(rng), soft: false, budget: 130, w: 0.28, dMin: 2.2, dMax: 13, sMin: 0.75, sMax: 1.65, sink: 0.10, tilt: 0.40, flat: 0.18 },
    { key: 'kelp', geo: makeKelp(rng), soft: true, budget: 305, w: 0.78, dMin: 2.0, dMax: 12, sMin: 1.15, sMax: 2.90, sink: 0.08, tilt: 0.30, flat: 0.35 },
    // dMin was 3.0, which put every sea fan outside the lagoon — the fans are
    // the most saturated thing on the reef and none of them were anywhere the
    // player swims. 1.8 m still keeps them off the bar and out of the surf.
    { key: 'fan', geo: makeFan(rng), soft: true, budget: 330, w: 0.62, dMin: 1.8, dMax: 17, sMin: 0.95, sMax: 2.10, sink: 0.06, tilt: 0.35, flat: 0.20 },
    { key: 'urchin', geo: makeUrchin(rng), soft: false, budget: 195, w: 0.44, dMin: 0.8, dMax: 13, sMin: 0.40, sMax: 0.88, sink: 0.12, tilt: 0.60, flat: 0.20 },
    { key: 'rubble', geo: makeRubble(rng), soft: false, budget: 320, w: 0.78, dMin: 0.6, dMax: 30, sMin: 0.45, sMax: 2.05, sink: 0.34, tilt: 0.85, flat: 0.45 },
  ];
  for (const a of ARCH) {
    a.budget = Math.max(12, Math.round(a.budget * q));
    a.geo.computeBoundingBox();
    a.height = Math.max(0.15, a.geo.boundingBox.max.y);
    a.palette = PALETTE[a.key].map(col);
    a.list = [];
    a.count = 0;
  }

  // --- candidate scatter ----------------------------------------------------

  const STEP = 2.6;
  const cand = [];                      // flat x, z triplets with the seabed y
  for (let gz = -252; gz <= 218; gz += STEP) {
    for (let gx = -262; gx <= 262; gx += STEP) {
      const x = gx + (rng.next() - 0.5) * STEP;
      const z = gz + (rng.next() - 0.5) * STEP;
      const rad = reefRadial(x, z);
      if (rad <= 0.02) continue;
      if (rng.next() > rad * reefMask(x, z) * 0.9) continue;
      if (onLand(x, z)) continue;
      const y = H(x, z);
      if (!Number.isFinite(y)) continue;
      const w = depthWeight(-y);
      if (w <= 0 || rng.next() > w) continue;
      cand.push(x, z, y);
    }
  }

  // Fisher-Yates on triples: the buckets fill from a spatially unbiased
  // sample, so hitting a budget does not leave one corner of the bay bare.
  for (let i = cand.length / 3 - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    for (let k = 0; k < 3; k++) {
      const t = cand[i * 3 + k]; cand[i * 3 + k] = cand[j * 3 + k]; cand[j * 3 + k] = t;
    }
  }

  // --- bucket assignment ----------------------------------------------------

  const weights = new Float64Array(ARCH.length);
  let open = ARCH.length;
  for (let i = 0; i < cand.length && open > 0; i += 3) {
    const x = cand[i], z = cand[i + 1], y = cand[i + 2];
    const d = -y;
    let sum = 0;
    for (let a = 0; a < ARCH.length; a++) {
      const A = ARCH[a];
      const w = A.count >= A.budget ? 0 : A.w * band(d, A.dMin, A.dMax);
      weights[a] = w;
      sum += w;
    }
    if (sum <= 1e-6) continue;
    let r = rng.next() * sum;
    let pick = -1;
    for (let a = 0; a < ARCH.length; a++) { r -= weights[a]; if (r <= 0) { pick = a; break; } }
    if (pick < 0) continue;

    const A = ARCH[pick];
    let s = A.sMin + (A.sMax - A.sMin) * Math.pow(rng.next(), 1.35);
    // Nothing may breach the surface: shrink first, drop the instance if that
    // would make it a speck.
    const headroom = (-0.30 - y) / A.height;
    if (headroom < A.sMin * 0.55) continue;
    s = Math.min(s, headroom);

    A.list.push(x, y - A.sink * s, z, s, rng.next(), rng.next(), rng.next(), rng.next());
    A.count++;
    if (A.count === A.budget) open--;
  }

  // --- materials ------------------------------------------------------------

  const matRigid = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.86, metalness: 0.0,
    flatShading: false, side: THREE.FrontSide, fog: true, dithering: true,
  });
  const matSoft = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0,
    side: THREE.DoubleSide, fog: true, dithering: true,
  });
  decorateReefMaterial(matRigid, uni, false);
  decorateReefMaterial(matSoft, uni, true);

  // --- build the instanced meshes ------------------------------------------

  const CURRENT_YAW = 0.42;   // the sea fans all face roughly across this
  const meshes = [];
  for (const A of ARCH) {
    const n = A.list.length / 8;
    if (n < 1) { A.geo.dispose(); continue; }
    const mesh = new THREE.InstancedMesh(A.geo, A.soft ? matSoft : matRigid, n);
    mesh.name = 'coral-' + A.key;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;

    // Only the swaying archetypes need the instance-matrix crib sheet.
    const swayO = A.soft ? new Float32Array(n * 2) : null;
    const swayX = A.soft ? new Float32Array(n * 3) : null;
    const swayZ = A.soft ? new Float32Array(n * 3) : null;

    for (let i = 0; i < n; i++) {
      const o = i * 8;
      const x = A.list[o], y = A.list[o + 1], z = A.list[o + 2], s = A.list[o + 3];
      const r0 = A.list[o + 4], r1 = A.list[o + 5], r2 = A.list[o + 6], r3 = A.list[o + 7];

      // Sit into the seabed rather than on top of an imaginary plane.
      const e = 0.9;
      const hx = (H(x - e, z) - H(x + e, z)) / (2 * e);
      const hz = (H(x, z - e) - H(x, z + e)) / (2 * e);
      _n.set(hx * A.tilt, 1, hz * A.tilt).normalize();
      _qa.setFromUnitVectors(_UP, _n);
      const yaw = A.key === 'fan' ? CURRENT_YAW + (r0 - 0.5) * 0.9 : r0 * Math.PI * 2;
      _qb.setFromAxisAngle(_UP, yaw);
      _qa.multiply(_qb);

      _p.set(x, y, z);
      const squash = 1 - A.flat * (r1 - 0.5);
      _s.set(s * (1 + (r2 - 0.5) * 0.22), s * squash, s * (1 + (r3 - 0.5) * 0.22));
      _m4.compose(_p, _qa, _s);
      mesh.setMatrixAt(i, _m4);

      if (swayO) {
        const me = _m4.elements;
        swayO[i * 2] = me[12]; swayO[i * 2 + 1] = me[14];
        swayX[i * 3] = me[0]; swayX[i * 3 + 1] = me[1]; swayX[i * 3 + 2] = me[2];
        swayZ[i * 3] = me[8]; swayZ[i * 3 + 1] = me[9]; swayZ[i * 3 + 2] = me[10];
      }

      // Per-instance albedo: pick from the archetype palette, jitter in HSL,
      // then bias warm because the water eats red long before it eats blue.
      _c.copy(A.palette[Math.min(A.palette.length - 1, Math.floor(r1 * A.palette.length))]);
      _c.offsetHSL((r2 - 0.5) * 0.055, (r3 - 0.5) * 0.18, (r0 - 0.5) * 0.12);
      _c.r = Math.min(1, _c.r * 1.10);
      _c.b = _c.b * 0.94;
      mesh.setColorAt(i, _c);
    }
    if (swayO) {
      A.geo.setAttribute('aReefOrigin', new THREE.InstancedBufferAttribute(swayO, 2));
      A.geo.setAttribute('aReefAxisX', new THREE.InstancedBufferAttribute(swayX, 3));
      A.geo.setAttribute('aReefAxisZ', new THREE.InstancedBufferAttribute(swayZ, 3));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    meshes.push(mesh);
    A.list.length = 0;
  }

  setLayers(group, LAYER.MAIN, LAYER.UNDERWATER);

  // --- module surface -------------------------------------------------------

  return {
    group,
    // The surface-texture knobs, so a capture can sweep them without a rebuild.
    tex: { uReefFreq, uReefFine, uReefAmp },

    update(ctx) {
      uni.uReefTime.value = ctx.time;
    },

    applyEnv(env) {
      // The shimmer on the coral is the same light the seabed gets: the key
      // light seen through shallow water. Never a hardcoded turquoise.
      uni.uCausticColor.value.copy(env.waterShallow).lerp(env.keyColor, 0.45);
      uni.uCausticStrength.value = env.causticStrength * 0.62;
      uni.uReefSway.value = 0.75 + 0.25 * env.dayFactor;

      // A whisper of in-scattered water colour so the reef never goes to pure
      // black under the moon.
      const e = 0.035 + 0.085 * env.nightFactor;
      matRigid.emissive.copy(env.waterScatter).multiplyScalar(e * 0.7);
      matSoft.emissive.copy(env.waterScatter).multiplyScalar(e);
      matRigid.emissiveIntensity = 1;
      matSoft.emissiveIntensity = 1;
    },

    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.dispose();
        group.remove(m);
      }
      meshes.length = 0;
      matRigid.dispose();
      matSoft.dispose();
    },
  };
}
