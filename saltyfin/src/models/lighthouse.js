// The lighthouse.
//
// The one silhouette that appears in every single piece of concept art, so its
// proportions matter more than its detail: a 22 m tapering white tower with two
// broad red bands, a corbelled ring carrying a black-railed gallery, a glazed
// lantern room with heavy astragals, a domed cap and a finial. A keeper's
// cottage in the village's half-timber/stucco language sits at its foot inside a
// low drystone wall.
//
// It stands on the highest reasonably level pad the lighthouse island offers
// near (215, -198) — the pad is solved from `terrain.landHeight` rather than
// hardcoded, and a stone plinth is sunk 4 m into the rock so the tower never
// floats over a facet.
//
// Construction follows the village and the dock: one kit of unit primitives
// stamped into a handful of merged vertex-coloured buffers. Five draw calls for
// the whole station, plus the beam and the lamp glow.
//
// Colour discipline: paint (white, red, stone, slate) is albedo and is authored
// here. Every scrap of *light* comes from env — the lantern's emissive and its
// PointLight ride `env.lighthouseIntensity`, the cottage windows ride
// `env.windowLight`/`env.windowIntensity`, and the beam's opacity is exactly
// `env.beamOpacity`, which is zero by day and 0.34 at night.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// --- binding world layout -----------------------------------------------------

const ISLE_X = 215;
const ISLE_Z = -195;
const SEEK_X = 215;
const SEEK_Z = -199;

// --- the tower ----------------------------------------------------------------

const SHAFT_H = 17.30;
const R_BASE = 2.78;
const R_TOP = 1.84;

/** Slight batter with a touch of entasis — a straight cone reads as a traffic cone. */
const radiusAt = (y) => R_BASE + (R_TOP - R_BASE) * Math.pow(Math.max(0, y) / SHAFT_H, 0.86);

const BANDS = [
  { y0: 0.00, y1: 1.15, hex: 0x8E8B82 },   // rubble stone base course
  { y0: 1.15, y1: 6.20, hex: 0xF2EDE0 },
  { y0: 6.20, y1: 9.40, hex: 0xC03A2E },
  { y0: 9.40, y1: 13.40, hex: 0xF2EDE0 },
  { y0: 13.40, y1: 16.20, hex: 0xC03A2E },
  { y0: 16.20, y1: SHAFT_H, hex: 0xF2EDE0 },
];

// --- palette (albedo only) ----------------------------------------------------

const WHITE = 0xF2EDE0;
const RED = 0xC03A2E;
const STONE = [0x8C8A82, 0x9A968C, 0x7E7C74, 0x93908A];
const IRON = 0x24262A;
const DOME = 0x6B2A22;
const BRASS = 0xC9A24A;
const GLASS_DARK = 0x232B33;
const TIMBER = [0x4A3220, 0x3C2A1B, 0x54381F];
const STUCCO = 0xF3E7CF;
const TILE = 0xB4462E;
const FRAME_WHITE = 0xF7F2E4;
const GLASS_TINT = 0xFFDCA8;
const DOOR_BLUE = 0x2E4C6E;

// --- scratch (module scope; nothing here allocates after build) ----------------

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

/** Accumulates transformed copies of source geometries into flat arrays. */
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

/** A triangular prism: 1 wide in x, 1 tall in y (base at y=0), 1 deep in z. */
function makePrism() {
  const h = 0.5;
  const P = [];
  const N = [];
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) => {
    P.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    N.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };
  tri(-h, 0, h, h, 0, h, 0, 1, h, 0, 0, 1);
  tri(h, 0, -h, -h, 0, -h, 0, 1, -h, 0, 0, -1);
  tri(-h, 0, -h, h, 0, -h, h, 0, h, 0, -1, 0);
  tri(-h, 0, -h, h, 0, h, -h, 0, h, 0, -1, 0);
  const k = 1 / Math.sqrt(1.25);
  tri(h, 0, -h, 0, 1, -h, 0, 1, h, k, 0.5 * k, 0);
  tri(h, 0, -h, 0, 1, h, h, 0, h, k, 0.5 * k, 0);
  tri(-h, 0, h, 0, 1, h, 0, 1, -h, -k, 0.5 * k, 0);
  tri(-h, 0, h, 0, 1, -h, -h, 0, -h, -k, 0.5 * k, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return g;
}

// --- the emissive-window material (same two-line injection as the village) -----

function makeGlowMaterial(uniforms, baseHex) {
  const m = new THREE.MeshStandardMaterial({
    color: C(baseHex), roughness: 0.28, metalness: 0.0, vertexColors: true, fog: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowTime = uniforms.time;
    shader.uniforms.uGlowColor = uniforms.color;
    shader.uniforms.uGlowI = uniforms.intensity;
    shader.vertexShader = 'attribute vec2 aGlow;\nvarying vec2 vGlow;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vGlow = aGlow;',
    );
    shader.fragmentShader = 'uniform float uGlowTime;\nuniform vec3 uGlowColor;\nuniform float uGlowI;\nvarying vec2 vGlow;\n' + shader.fragmentShader.replace(
      'vec3 totalEmissiveRadiance = emissive;',
      `vec3 totalEmissiveRadiance = emissive;
  float gph = vGlow.y;
  float gfl = 1.0 + step(0.001, gph) * (
      0.15 * sin(uGlowTime * (1.6 + gph * 3.1) + gph * 31.0)
    + 0.08 * sin(uGlowTime * (5.7 + gph * 2.3) + gph * 17.0));
  totalEmissiveRadiance += uGlowColor * (uGlowI * vGlow.x * gfl) * vColor.rgb;`,
    );
  };
  return m;
}

// --- the beam -----------------------------------------------------------------
//
// A shell cone rendered additively. The alpha rides |dot(N, V)|, so the shell is
// brightest where it faces the camera — the middle of the projected cone — and
// falls away to nothing at the silhouette. Drawn double-sided, the near and far
// walls add, which is exactly the density profile a real light shaft has and is
// what stops it reading as a hard-edged triangle. `vT` fades it in off the lamp
// and out toward the tip.

const BEAM_VERT = /* glsl */`
uniform float uLen;
varying vec3 vN;
varying vec3 vV;
varying float vT;
void main() {
  vT = clamp(position.z / uLen, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz;
  vN = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying float vT;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  float facing = abs(dot(N, V));
  float core = pow(facing, 1.7);
  float near = smoothstep(0.0, 0.055, vT);
  float far = 1.0 - smoothstep(0.30, 1.0, vT);
  float a = uOpacity * core * near * far;
  gl_FragColor = vec4(uColor * a, a);
}
`;

// The lamp's own halo: the same trick on a sphere, but un-inverted, so the alpha
// peaks dead centre. Small, additive, and the only reason the lantern still
// blooms from four hundred metres away.
const HALO_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz;
  vN = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}
`;

const HALO_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float a = uOpacity * pow(f, 2.6);
  gl_FragColor = vec4(uColor * a, a);
}
`;

// ==============================================================================

export function createLighthouse(opts = {}) {
  const terrain = opts.terrain || null;
  const rng = makeRng(((opts.seed || 1) ^ 0x11647E) >>> 0);

  const group = new THREE.Group();
  group.name = 'lighthouse';

  // --- source primitives ----------------------------------------------------
  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const CYL24 = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  const SPH = new THREE.IcosahedronGeometry(0.5, 1);
  const ROCK = new THREE.IcosahedronGeometry(0.5, 0);
  const HEMI = new THREE.SphereGeometry(0.5, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const RAIL = new THREE.TorusGeometry(0.5, 0.021, 6, 32);
  const PRISM = makePrism();
  const SOURCES = [BOX, CYL8, CYL12, CYL24, SPH, ROCK, HEMI, RAIL, PRISM];

  // --- builders -------------------------------------------------------------
  const bSolid = makeBuilder();   // masonry, paint, timber, iron
  const bRoof = makeBuilder();    // cottage tile courses
  const bGlow = makeBuilder([{ name: 'aGlow', size: 2 }]);

  const put = (B, geo, W, x, y, z, sx, sy, sz, rx, ry, rz, color, extra) => {
    compose(_mLocal, x, y, z, sx, sy, sz, rx, ry, rz);
    _mOut.multiplyMatrices(W, _mLocal);
    B.add(geo, _mOut, color, extra);
  };

  // --- terrain queries ------------------------------------------------------

  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return 0;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };

  /** Lowest and highest land over a ring of radius r plus its centre. */
  function pad(x, z, r, out) {
    let lo = landAt(x, z);
    let hi = lo;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const h = landAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    out.lo = lo; out.hi = hi;
    return out;
  }

  const _pad = { lo: 0, hi: 0 };

  // Find the highest reasonably level shelf near the summit. Scoring the *floor*
  // of the pad and penalising its spread finds a terrace rather than the tip of a
  // ridged spike, which is where a keeper would actually have built.
  let TX = SEEK_X;
  let TZ = SEEK_Z;
  let TY = 32;
  {
    let best = -1e9;
    for (let i = -18; i <= 18; i += 1.5) {
      for (let j = -18; j <= 18; j += 1.5) {
        const x = SEEK_X + i;
        const z = SEEK_Z + j;
        pad(x, z, 4.4, _pad);
        if (_pad.lo < -1000) continue;
        const score = _pad.lo - (_pad.hi - _pad.lo) * 1.7;
        if (score > best) { best = score; TX = x; TZ = z; TY = _pad.hi; }
      }
    }
    if (!(TY > -100) || !Number.isFinite(TY)) { TX = SEEK_X; TZ = SEEK_Z; TY = 32; }
  }

  // The bearing the station faces: back down the bay toward the village, which
  // is where the player is and therefore where the door and the windows go.
  const FACE = Math.atan2(-60 - TZ, -150 - TX);
  const faceRotY = Math.atan2(Math.cos(FACE), Math.sin(FACE));

  const BASE_Y = TY + 0.55;

  const Wt = new THREE.Matrix4();
  compose(Wt, TX, BASE_Y, TZ, 1, 1, 1, 0, 0, 0);
  const Wtower = Wt.clone();

  // =========================================================================
  // PLINTH — sunk 4 m so the tower never floats over a rock facet
  // =========================================================================

  {
    const s0 = C(STONE[0]);
    put(bSolid, CYL24, Wtower, 0, -2.0, 0, R_BASE * 2 + 2.6, 4.4, R_BASE * 2 + 2.6, 0, 0, 0, s0);
    put(bSolid, CYL24, Wtower, 0, -0.12, 0, R_BASE * 2 + 2.1, 0.60, R_BASE * 2 + 2.1,
      0, 0, 0, C(STONE[1]));
    put(bSolid, CYL24, Wtower, 0, 0.14, 0, R_BASE * 2 + 1.5, 0.34, R_BASE * 2 + 1.5,
      0, 0, 0, C(STONE[3]));
    // a scatter of boulders tucked against the plinth so it meets the rock
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = R_BASE + 2.1 + rng.range(-0.2, 0.9);
      const bx = TX + Math.cos(a) * r;
      const bz = TZ + Math.sin(a) * r;
      const by = landAt(bx, bz);
      if (by < -100) continue;
      const sc = rng.range(1.0, 2.3);
      put(bSolid, ROCK, Wtower, Math.cos(a) * r, by - BASE_Y + sc * 0.22, Math.sin(a) * r,
        sc, sc * 0.78, sc * rng.range(0.8, 1.2),
        rng.range(0, 1), rng.range(0, 3), rng.range(0, 1), C(STONE[i % STONE.length]));
    }
  }

  // =========================================================================
  // SHAFT — a stack of masonry courses, each a capped drum so the taper reads
  // as coursework rather than as a smooth cone
  // =========================================================================

  for (const band of BANDS) {
    const span = band.y1 - band.y0;
    const n = Math.max(2, Math.round(span / 0.52));
    const step = span / n;
    const base = C(band.hex);
    for (let k = 0; k < n; k++) {
      const yc = band.y0 + (k + 0.5) * step;
      const r = radiusAt(yc);
      const shade = new THREE.Color().copy(base)
        .multiplyScalar(0.975 + 0.05 * ((k * 7 + 3) % 5) / 4);
      // 0.04 of overlap: consecutive caps must not be coplanar or they z-fight.
      put(bSolid, CYL24, Wtower, 0, yc + 0.02, 0, r * 2, step + 0.04, r * 2, 0, 0, 0, shade);
    }
  }

  // a string course capping the stone base
  put(bSolid, CYL24, Wtower, 0, 1.16, 0, radiusAt(1.16) * 2 + 0.26, 0.22,
    radiusAt(1.16) * 2 + 0.26, 0, 0, 0, C(STONE[1]));

  // --- door and shaft windows, all on the bay-facing bearing ----------------

  {
    const dark = C(TIMBER[1]);
    const ca = Math.cos(FACE), sa = Math.sin(FACE);
    const dr = radiusAt(1.2);
    put(bSolid, BOX, Wtower, ca * (dr + 0.06), 1.28, sa * (dr + 0.06),
      1.60, 2.68, 0.34, 0, faceRotY, 0, C(STONE[2]));
    put(bSolid, BOX, Wtower, ca * (dr + 0.20), 1.20, sa * (dr + 0.20),
      1.10, 2.30, 0.16, 0, faceRotY, 0, C(DOOR_BLUE));
    put(bSolid, BOX, Wtower, ca * (dr + 0.28), 1.20, sa * (dr + 0.28),
      0.14, 2.16, 0.06, 0, faceRotY, 0, dark);
    put(bSolid, SPH, Wtower, ca * (dr + 0.30) + sa * 0.36, 1.22, sa * (dr + 0.30) - ca * 0.36,
      0.16, 0.16, 0.16, 0, 0, 0, C(BRASS));
    // threshold slab
    put(bSolid, BOX, Wtower, ca * (dr + 0.55), 0.06, sa * (dr + 0.55),
      1.90, 0.24, 1.10, 0, faceRotY, 0, C(STONE[3]));

    // three slit windows up the stair; the lowest is the watch room and is lit
    const wy = [4.3, 8.2, 12.1];
    for (let i = 0; i < wy.length; i++) {
      const y = wy[i];
      const r = radiusAt(y);
      const twist = (i - 1) * 0.55;      // the stair winds, so the slits spiral
      const a = FACE + twist;
      const cx = Math.cos(a), cz = Math.sin(a);
      const rot = Math.atan2(cx, cz);
      put(bSolid, BOX, Wtower, cx * (r + 0.05), y, cz * (r + 0.05),
        0.86, 1.36, 0.16, 0, rot, 0, C(FRAME_WHITE));
      put(bGlow, BOX, Wtower, cx * (r + 0.13), y, cz * (r + 0.13),
        0.58, 1.06, 0.08, 0, rot, 0, C(GLASS_TINT),
        { aGlow: [i === 0 ? 1.05 : 0.0, i === 0 ? 0.35 : 0.0] });
      put(bSolid, BOX, Wtower, cx * (r + 0.16), y, cz * (r + 0.16),
        0.07, 1.06, 0.05, 0, rot, 0, C(TIMBER[1]));
      put(bSolid, BOX, Wtower, cx * (r + 0.20), y - 0.76, cz * (r + 0.20),
        0.98, 0.14, 0.30, 0, rot, 0, C(STONE[1]));
    }
  }

  // =========================================================================
  // CORBEL RING + GALLERY
  // =========================================================================

  const GALLERY_Y = 17.62;
  {
    const white = C(WHITE);
    const stone = C(STONE[1]);
    // three stepped rings flaring out from the shaft
    const corbels = [
      [16.45, 2.02], [16.82, 2.32], [17.19, 2.66],
    ];
    for (let i = 0; i < corbels.length; i++) {
      const [y, r] = corbels[i];
      put(bSolid, CYL24, Wtower, 0, y, 0, r * 2, 0.40, r * 2, 0, 0, 0,
        i === 1 ? stone : white);
    }
    // little brackets between the corbel and the deck
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      put(bSolid, BOX, Wtower, Math.cos(a) * 2.62, 17.30, Math.sin(a) * 2.62,
        0.30, 0.62, 0.72, 0, Math.atan2(Math.cos(a), Math.sin(a)), 0, stone);
    }
    // gallery deck
    put(bSolid, CYL24, Wtower, 0, GALLERY_Y, 0, 6.20, 0.30, 6.20, 0, 0, 0, stone);
    put(bSolid, CYL24, Wtower, 0, GALLERY_Y + 0.17, 0, 6.30, 0.10, 6.30, 0, 0, 0, C(STONE[3]));

    // black railing: stanchions plus two hoops
    const iron = C(IRON);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      put(bSolid, BOX, Wtower, Math.cos(a) * 2.92, GALLERY_Y + 0.72, Math.sin(a) * 2.92,
        0.09, 1.16, 0.09, 0, 0, 0, iron);
    }
    put(bSolid, RAIL, Wtower, 0, GALLERY_Y + 1.26, 0, 5.90, 5.90, 5.90,
      Math.PI * 0.5, 0, 0, iron);
    put(bSolid, RAIL, Wtower, 0, GALLERY_Y + 0.74, 0, 5.86, 5.86, 5.86,
      Math.PI * 0.5, 0, 0, iron);
    put(bSolid, RAIL, Wtower, 0, GALLERY_Y + 0.32, 0, 5.84, 5.84, 5.84,
      Math.PI * 0.5, 0, 0, iron);
  }

  // =========================================================================
  // LANTERN ROOM
  // =========================================================================

  const LAMP_Y = GALLERY_Y + 1.42;
  {
    const white = C(WHITE);
    const iron = C(IRON);

    // plinth the lantern sits on
    put(bSolid, CYL24, Wtower, 0, GALLERY_Y + 0.22, 0, 4.00, 0.34, 4.00, 0, 0, 0, white);

    // twelve astragals with a mid ring — the glazing bars are the read at
    // distance, so they are deliberately heavy
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      put(bSolid, BOX, Wtower, Math.cos(a) * 1.66, LAMP_Y + 0.10, Math.sin(a) * 1.66,
        0.13, 2.48, 0.18, 0, Math.atan2(Math.cos(a), Math.sin(a)), 0, iron);
    }
    put(bSolid, RAIL, Wtower, 0, LAMP_Y + 0.10, 0, 3.34, 3.34, 3.34, Math.PI * 0.5, 0, 0, iron);
    put(bSolid, RAIL, Wtower, 0, LAMP_Y - 1.05, 0, 3.36, 3.36, 3.36, Math.PI * 0.5, 0, 0, iron);

    // cornice and the domed cap
    put(bSolid, CYL24, Wtower, 0, LAMP_Y + 1.42, 0, 3.96, 0.28, 3.96, 0, 0, 0, iron);
    put(bSolid, CYL24, Wtower, 0, LAMP_Y + 1.60, 0, 3.60, 0.18, 3.60, 0, 0, 0, C(DOME));
    put(bSolid, HEMI, Wtower, 0, LAMP_Y + 1.66, 0, 3.56, 2.30, 3.56, 0, 0, 0, C(DOME));
    // Dome ribs, laid on the surface of the cap. The dome is a 1.78 m hemisphere
    // squashed to a 1.15 m semi-axis, so a rib at radius r sits at
    // y = 1.66 + 1.15 * sqrt(1 - (r/1.78)^2) and leans out by the slope there.
    const domeRib = C(DOME);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = 1.16;
      const k = Math.sqrt(Math.max(0, 1 - (r / 1.78) * (r / 1.78)));
      const y = LAMP_Y + 1.66 + 1.15 * k;
      const slope = Math.atan2(1.15 * r, 1.78 * 1.78 * k);
      put(bSolid, BOX, Wtower, Math.cos(a) * r, y, Math.sin(a) * r,
        0.11, 0.13, 1.70, slope, Math.atan2(Math.cos(a), Math.sin(a)), 0,
        new THREE.Color().copy(domeRib).multiplyScalar(1.25));
    }
    // vent, ball finial and the lightning rod
    put(bSolid, CYL12, Wtower, 0, LAMP_Y + 3.00, 0, 0.64, 0.46, 0.64, 0, 0, 0, iron);
    put(bSolid, SPH, Wtower, 0, LAMP_Y + 3.42, 0, 0.62, 0.62, 0.62, 0, 0, 0, C(BRASS));
    put(bSolid, CYL8, Wtower, 0, LAMP_Y + 4.06, 0, 0.10, 1.00, 0.10, 0, 0, 0, C(BRASS));
    put(bSolid, SPH, Wtower, 0, LAMP_Y + 4.58, 0, 0.16, 0.16, 0.16, 0, 0, 0, C(BRASS));

    // the optic drum, dark by day; its emissive is driven from env
    put(bSolid, CYL12, Wtower, 0, LAMP_Y - 1.16, 0, 1.30, 0.24, 1.30, 0, 0, 0, iron);
  }

  // =========================================================================
  // KEEPER'S COTTAGE + DRYSTONE WALL
  // =========================================================================

  // Pick the flattest shelf a dozen metres off the tower that is not far below
  // it: a keeper's cottage that ends up halfway down a cliff reads as a bug.
  let CA = FACE;
  {
    let best = -1e9;
    for (let i = 0; i < 20; i++) {
      const a = FACE - 1.7 + (3.4 * i) / 19;
      const x = TX + Math.cos(a) * 13.5;
      const z = TZ + Math.sin(a) * 13.5;
      pad(x, z, 4.6, _pad);
      if (_pad.lo < -1000) continue;
      const score = -(_pad.hi - _pad.lo) * 1.4 - Math.abs(_pad.hi - TY) * 0.5;
      if (score > best) { best = score; CA = a; }
    }
  }

  const CX = TX + Math.cos(CA) * 13.5;
  const CZ = TZ + Math.sin(CA) * 13.5;
  const cottageRot = Math.atan2(Math.cos(CA), Math.sin(CA));
  pad(CX, CZ, 4.6, _pad);
  const CY = (_pad.hi > -1000 ? _pad.hi : TY) - 0.25;

  const Wc = new THREE.Matrix4();
  compose(Wc, CX, CY, CZ, 1, 1, 1, 0, cottageRot, 0);
  const Wcot = Wc.clone();

  /** Tile courses on a pitched roof, origin at the ridge-centre of the eave line. */
  function roofCourses(W, halfSpan, halfDepth, rise, tileHex, n) {
    const tile = C(tileHex);
    const dark = C(TIMBER[0]);
    const a = Math.atan2(rise, halfSpan);
    const L = Math.hypot(halfSpan, rise);
    const step = L / n;
    const thick = 0.22;
    const nx = Math.sin(a), ny = Math.cos(a);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const sdist = (i + 0.5) * step;
        const px = sgn * (halfSpan - Math.cos(a) * sdist);
        const py = Math.sin(a) * sdist;
        const off = thick * 0.5 + (i % 2 === 0 ? 0.05 : 0.0);
        const shade = new THREE.Color().copy(tile)
          .multiplyScalar(0.90 + 0.20 * ((i * 7 + side * 3) % 5) / 4);
        put(bRoof, BOX, W, px + sgn * nx * off, py + ny * off, 0,
          step + 0.14, thick, halfDepth * 2, 0, 0, sgn > 0 ? -a : a, shade);
      }
      put(bRoof, BOX, W, sgn * (halfSpan + 0.05), -0.13, 0,
        0.18, 0.32, halfDepth * 2 + 0.1, 0, 0, 0, dark);
    }
    put(bRoof, BOX, W, 0, rise + 0.05, 0, 0.48, 0.24, halfDepth * 2 + 0.20, 0, 0, 0, tile);
    for (let end = 0; end < 2; end++) {
      const z = (end === 0 ? 1 : -1) * (halfDepth + 0.08);
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        put(bRoof, BOX, W, sgn * halfSpan * 0.5, rise * 0.5 + 0.14, z,
          L + 0.18, 0.18, 0.16, 0, 0, sgn > 0 ? -a : a, dark);
      }
    }
  }

  /** A window: frame, sill, muntins, emissive pane. */
  function cottageWindow(W, x, y, z, ww, wh, lit, seed, rot) {
    const frame = C(FRAME_WHITE);
    const dark = C(TIMBER[1]);
    put(bSolid, BOX, W, x, y, z, ww + 0.20, wh + 0.20, 0.10, 0, rot, 0, frame);
    put(bGlow, BOX, W, x, y, z, ww, wh, 0.16, 0, rot, 0, C(GLASS_TINT), { aGlow: [lit, seed] });
    put(bSolid, BOX, W, x, y, z, 0.05, wh, 0.22, 0, rot, 0, dark);
    put(bSolid, BOX, W, x, y, z, ww, 0.05, 0.22, 0, rot, 0, dark);
    put(bSolid, BOX, W, x, y - wh * 0.5 - 0.12, z, ww + 0.40, 0.10, 0.28, 0, rot, 0, frame);
  }

  {
    const stucco = C(STUCCO);
    const dark = C(TIMBER[0]);
    const stone = C(STONE[0]);
    const CW = 7.2, CD = 5.4, CH = 3.05, PLINTH = 0.85;

    put(bSolid, BOX, Wcot, 0, PLINTH * 0.5, 0, CW + 0.36, PLINTH, CD + 0.36, 0, 0, 0, stone);
    put(bSolid, BOX, Wcot, 0, PLINTH + 0.05, 0, CW + 0.50, 0.16, CD + 0.50, 0, 0, 0, C(STONE[3]));
    put(bSolid, BOX, Wcot, 0, PLINTH + CH * 0.5, 0, CW, CH, CD, 0, 0, 0, stucco);

    // Half-timbering on all four faces, the village's language in miniature.
    // The plates and studs are placed in plan (rotated into the face) so the
    // frame wraps the corners instead of four unrelated grids meeting badly.
    for (const [rotY, width, zoff] of [
      [0, CW, CD * 0.5 + 0.05], [Math.PI, CW, -CD * 0.5 - 0.05],
      [Math.PI * 0.5, CD, CW * 0.5 + 0.05], [-Math.PI * 0.5, CD, -CW * 0.5 - 0.05],
    ]) {
      const t = 0.12;
      const y0 = PLINTH;
      const px = Math.sin(rotY) * zoff;
      const pz = Math.cos(rotY) * zoff;
      put(bSolid, BOX, Wcot, px, y0 + 0.09, pz, width, 0.22, t, 0, rotY, 0, dark);
      put(bSolid, BOX, Wcot, px, y0 + CH - 0.11, pz, width, 0.24, t, 0, rotY, 0, dark);
      put(bSolid, BOX, Wcot, px, y0 + CH * 0.54, pz, width, 0.18, t, 0, rotY, 0, dark);
      const studs = Math.max(2, Math.round(width / 1.5));
      for (let i = 0; i <= studs; i++) {
        const u = -width * 0.5 + (width * i) / studs;
        put(bSolid, BOX, Wcot, px + Math.cos(rotY) * u, y0 + CH * 0.5, pz - Math.sin(rotY) * u,
          0.18, CH, t, 0, rotY, 0, dark);
      }
    }

    // roof
    const span = CD * 0.5 + 0.55;
    const halfDepth = CW * 0.5 + 0.55;
    const rise = span * 1.15;
    compose(_mLocal, 0, PLINTH + CH, 0, 1, 1, 1, 0, Math.PI * 0.5, 0);
    const Wr = _mOut.multiplyMatrices(Wcot, _mLocal).clone();
    roofCourses(Wr, span, halfDepth, rise, TILE, 6);
    for (let end = 0; end < 2; end++) {
      const z = (end === 0 ? 1 : -1) * (CW * 0.5 - 0.04);
      put(bSolid, PRISM, Wr, 0, 0, z, CD, rise * (CD / (span * 2)), 0.20, 0, 0, 0, stucco);
    }

    // chimney
    {
      const top = PLINTH + CH + rise * 0.8 + 1.3;
      put(bSolid, BOX, Wcot, -CW * 0.28, top * 0.5 + 0.5, CD * 0.18,
        0.82, top - 0.5, 0.78, 0, 0, 0, C(0x9A5442));
      put(bSolid, BOX, Wcot, -CW * 0.28, top + 0.08, CD * 0.18, 1.06, 0.22, 1.00, 0, 0, 0, stone);
      put(bSolid, CYL8, Wcot, -CW * 0.28, top + 0.40, CD * 0.18, 0.28, 0.50, 0.28,
        0, 0, 0, C(0x53412F));
    }

    // windows: two lit on the bay face, one on each gable
    cottageWindow(Wcot, -1.85, PLINTH + 1.72, CD * 0.5 + 0.10, 0.86, 1.06, 1.05, 0.42, 0);
    cottageWindow(Wcot, 1.85, PLINTH + 1.72, CD * 0.5 + 0.10, 0.86, 1.06, 0.85, 0.0, 0);
    cottageWindow(Wcot, CW * 0.5 + 0.10, PLINTH + 1.68, 0.4, 0.72, 0.92, 0.0, 0, Math.PI * 0.5);
    cottageWindow(Wcot, -CW * 0.5 - 0.10, PLINTH + 1.68, -0.5, 0.72, 0.92, 0.9, 0.7, Math.PI * 0.5);

    // door with a plank hood
    put(bSolid, BOX, Wcot, 0.15, PLINTH + 1.05, CD * 0.5 + 0.08, 1.20, 2.16, 0.14, 0, 0, 0, dark);
    put(bSolid, BOX, Wcot, 0.15, PLINTH + 1.02, CD * 0.5 + 0.15, 0.98, 2.00, 0.10, 0, 0, 0, C(DOOR_BLUE));
    put(bSolid, BOX, Wcot, 0.15, PLINTH + 2.22, CD * 0.5 + 0.36, 1.60, 0.16, 0.72, -0.30, 0, 0, dark);
    put(bSolid, BOX, Wcot, 0.15, PLINTH - 0.36, CD * 0.5 + 0.44, 1.70, 0.30, 0.90, 0, 0, 0, C(STONE[3]));

    // lean-to woodshed and a log pile against the gable
    put(bSolid, BOX, Wcot, CW * 0.5 + 1.05, PLINTH + 0.90, -0.6, 2.10, 1.80, 2.60, 0, 0, 0, C(0x7A5B3A));
    put(bSolid, BOX, Wcot, CW * 0.5 + 1.05, PLINTH + 1.92, -0.6, 2.60, 0.18, 3.00, 0, 0, -0.24, dark);
    for (let i = 0; i < 10; i++) {
      const r = i % 5;
      const c = (i / 5) | 0;
      put(bSolid, CYL8, Wcot, CW * 0.5 + 0.55 + c * 0.34, PLINTH + 0.28 + r * 0.30, -1.55,
        0.30, 1.60, 0.30, Math.PI * 0.5, 0, 0, C(0x6B4E31));
    }
    // a water butt and a crate by the door
    put(bSolid, CYL12, Wcot, -CW * 0.5 + 0.7, PLINTH + 0.52, CD * 0.5 + 0.7,
      0.92, 1.10, 0.92, 0, 0, 0, C(0x7A5B39));
    put(bSolid, CYL12, Wcot, -CW * 0.5 + 0.7, PLINTH + 1.06, CD * 0.5 + 0.7,
      0.96, 0.10, 0.96, 0, 0, 0, C(0x6A6258));
    put(bSolid, BOX, Wcot, -CW * 0.5 + 1.9, PLINTH + 0.28, CD * 0.5 + 0.85,
      0.74, 0.56, 0.74, 0, 0.34, 0, C(0x8A6A44));
  }

  // --- drystone wall, an arc of blocks following the ground -----------------
  {
    const a0 = CA - 1.55;
    const a1 = CA + 1.55;
    const R = 16.5;
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      const x = TX + Math.cos(a) * R;
      const z = TZ + Math.sin(a) * R;
      const y = landAt(x, z);
      if (y < -100 || y < TY - 9.0) continue;
      const rot = Math.atan2(Math.cos(a), Math.sin(a));
      const h = 0.86 + rng.range(-0.10, 0.14);
      put(bSolid, BOX, Wtower, Math.cos(a) * R, y - BASE_Y + h * 0.5, Math.sin(a) * R,
        1.30, h, 0.62, 0, rot, 0, C(STONE[i % STONE.length]));
      if (i % 2 === 0) {
        put(bSolid, BOX, Wtower, Math.cos(a) * R, y - BASE_Y + h + 0.10, Math.sin(a) * R,
          1.10, 0.24, 0.76, 0, rot + rng.range(-0.12, 0.12), 0, C(STONE[(i + 2) % STONE.length]));
      }
    }
  }

  // --- a flagged path from the cottage door to the tower door ---------------
  {
    const dr = radiusAt(1.2) + 1.1;
    const ax = TX + Math.cos(FACE) * dr;
    const az = TZ + Math.sin(FACE) * dr;
    const bx = CX + Math.cos(CA) * -(2.9);
    const bz = CZ + Math.sin(CA) * -(2.9);
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(3, Math.round(len / 1.05));
    const yaw = Math.atan2(dx, dz);
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const x = ax + dx * t;
      const z = az + dz * t;
      const y = landAt(x, z);
      if (y < -100) continue;
      put(bSolid, BOX, Wtower, x - TX, y - BASE_Y + 0.04, z - TZ,
        2.00, 0.26, 1.00, 0, yaw + rng.range(-0.06, 0.06), 0,
        C(STONE[(i + 1) % STONE.length]));
    }
  }

  // =========================================================================
  // ASSEMBLE THE MERGED MESHES
  // =========================================================================

  const uniforms = {
    time: { value: 0 },
    color: { value: new THREE.Color(1, 0.72, 0.36) },
    intensity: { value: 0 },
  };

  const matSolid = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.0, fog: true,
  });
  const matRoof = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.66, metalness: 0.0, fog: true,
  });
  const matGlow = makeGlowMaterial(uniforms, 0x1A1E26);

  const geos = [];
  const mk = (builder, mat, name) => {
    if (builder.empty) return null;
    const g = builder.build();
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };

  mk(bSolid, matSolid, 'lighthouse.solid');
  mk(bRoof, matRoof, 'lighthouse.roof');
  mk(bGlow, matGlow, 'lighthouse.glow');

  // =========================================================================
  // THE LAMP — emissive optic, halo, PointLight
  // =========================================================================

  const lampWorldY = BASE_Y + LAMP_Y;

  const lensMat = new THREE.MeshStandardMaterial({
    color: C(0x2A2620), roughness: 0.14, metalness: 0.25,
    emissive: new THREE.Color(1, 0.85, 0.6), emissiveIntensity: 0.0, fog: true,
  });
  const lensGeo = new THREE.CylinderGeometry(0.86, 0.86, 1.34, 16, 1, false);
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.set(TX, lampWorldY, TZ);
  lens.castShadow = false;
  lens.receiveShadow = false;
  group.add(lens);

  // Fresnel prism rings around the drum — three thin belts that catch the key
  // light by day so the lantern is not a black hole at noon.
  const prismGeo = new THREE.TorusGeometry(0.90, 0.075, 6, 20);
  const prismMat = new THREE.MeshStandardMaterial({
    color: C(0xBFC8CE), roughness: 0.22, metalness: 0.55,
    emissive: new THREE.Color(1, 0.85, 0.6), emissiveIntensity: 0.0, fog: true,
  });
  const prisms = new THREE.Group();
  for (let i = -1; i <= 1; i++) {
    const t = new THREE.Mesh(prismGeo, prismMat);
    t.position.set(TX, lampWorldY + i * 0.44, TZ);
    t.rotation.x = Math.PI * 0.5;
    t.castShadow = false;
    prisms.add(t);
  }
  group.add(prisms);

  // The halo. Alpha peaks dead centre, so it reads as a soft ball of light
  // rather than a sphere, and it is what survives the bloom threshold at 400 m.
  const haloUniforms = {
    uColor: { value: new THREE.Color(1, 0.88, 0.7) },
    uOpacity: { value: 0.0 },
  };
  const haloMat = new THREE.ShaderMaterial({
    uniforms: haloUniforms,
    vertexShader: HALO_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    fog: false,
  });
  const haloGeo = new THREE.SphereGeometry(2.9, 20, 14);
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.set(TX, lampWorldY, TZ);
  halo.castShadow = false;
  halo.renderOrder = 3;
  group.add(halo);

  const lampLight = new THREE.PointLight(0xffe6c0, 0, 62, 2);
  lampLight.position.set(TX, lampWorldY - 0.3, TZ);
  lampLight.castShadow = false;
  group.add(lampLight);

  // =========================================================================
  // THE BEAM — two opposed cones on a slowly turning pivot
  // =========================================================================

  const BEAM_LEN = 210;
  const BEAM_R = 15.5;

  const beamUniforms = {
    uColor: { value: new THREE.Color(1, 0.9, 0.74) },
    uOpacity: { value: 0.0 },
    uLen: { value: BEAM_LEN },
  };
  const beamMat = new THREE.ShaderMaterial({
    uniforms: beamUniforms,
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });

  // ConeGeometry puts its apex at +Y; slide it so the apex is at the origin and
  // then lay it down the +Z axis, which is the axis the shader measures `vT` on.
  const beamGeo = new THREE.ConeGeometry(BEAM_R, BEAM_LEN, 30, 1, true);
  beamGeo.translate(0, -BEAM_LEN * 0.5, 0);
  beamGeo.rotateX(-Math.PI * 0.5);

  const beamPivot = new THREE.Group();
  beamPivot.position.set(TX, lampWorldY, TZ);
  group.add(beamPivot);

  const beams = [];
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(beamGeo, beamMat);
    b.rotation.y = i * Math.PI;
    // a touch of down-tilt so the beam sweeps the sea rather than the sky
    b.rotation.x = -0.045;
    b.castShadow = false;
    b.receiveShadow = false;
    b.renderOrder = 4;
    b.frustumCulled = false;
    beamPivot.add(b);
    beams.push(b);
  }

  // --- layers ---------------------------------------------------------------

  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  lampLight.layers.enableAll();

  // --- state ----------------------------------------------------------------

  const warm = new THREE.Color();
  let spin = 0;
  let lampBase = 0;

  return {
    group,

    /** Where the light actually is, for anything that wants to point at it. */
    info: {
      position: new THREE.Vector3(TX, BASE_Y, TZ),
      lamp: new THREE.Vector3(TX, lampWorldY, TZ),
      height: LAMP_Y + 4.6,
      cottage: new THREE.Vector3(CX, CY, CZ),
    },

    update(ctx) {
      uniforms.time.value = ctx.time;
      // ~16.5 s a revolution. Slow enough to feel like machinery, fast enough
      // that a five-second capture sees it move.
      spin += ctx.dt * 0.38;
      if (spin > Math.PI * 2) spin -= Math.PI * 2;
      beamPivot.rotation.y = spin;

      // The optic breathes very slightly as the lamp rotates past the prisms.
      if (lampBase > 0.001) {
        const f = 0.92 + 0.08 * Math.sin(ctx.time * 1.9);
        lensMat.emissiveIntensity = lampBase * f;
        prismMat.emissiveIntensity = lampBase * 0.42 * f;
      }
    },

    applyEnv(env) {
      const li = env.lighthouseIntensity;

      // Warm white: the practical colour from env, pulled toward env's own white
      // point so the lantern is not the same orange as a cottage window.
      warm.copy(env.windowLight).lerp(env.foamTint, 0.45);

      uniforms.color.value.copy(env.windowLight);
      uniforms.intensity.value = env.windowIntensity;

      lampBase = 0.10 + li * 5.6;
      lensMat.emissive.copy(warm);
      lensMat.emissiveIntensity = lampBase;
      prismMat.emissive.copy(warm);
      prismMat.emissiveIntensity = lampBase * 0.42;

      lampLight.color.copy(warm);
      lampLight.intensity = li * 26.0;
      lampLight.visible = li > 0.02;

      haloUniforms.uColor.value.copy(warm);
      haloUniforms.uOpacity.value = li * 0.55;
      halo.visible = li > 0.02;

      beamUniforms.uColor.value.copy(warm);
      beamUniforms.uOpacity.value = env.beamOpacity;
      for (const b of beams) b.visible = env.beamOpacity > 0.004;
    },

    dispose() {
      for (const g of geos) g.dispose();
      for (const g of SOURCES) g.dispose();
      lensGeo.dispose();
      prismGeo.dispose();
      haloGeo.dispose();
      beamGeo.dispose();
      matSolid.dispose();
      matRoof.dispose();
      matGlow.dispose();
      lensMat.dispose();
      prismMat.dispose();
      haloMat.dispose();
      beamMat.dispose();
    },
  };
}
