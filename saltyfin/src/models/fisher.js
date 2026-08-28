// The fisher.
//
// One small person sat on the aft thwart, facing the bow, hunched a little into
// the wind. From the concept art we only ever see them from behind or three
// quarters, so the silhouette carries the whole character: the green knit
// beanie with its fat rolled brim, the round hood-bunched shoulders, a mop of
// mid-brown hair under the hat and one mitten resting out by the rod.
//
// Everything is built from squashed spheres, capsules and one lathed torso —
// nothing here is a box that reads as a box — and merged into three
// vertex-coloured draw calls: body (torso, hood, hips, left arm), head (skull,
// hair, hat) and right arm. The legs ride along in the body mesh's buffer but
// live under the root so the feet stay planted while the torso sways.
//
// Rig, root first:
//
//   root ....... parented into boat.group at boat.seat, so the boat's own
//                transform is the only thing moving it in world space
//     legs ..... static; thighs on the thwart, boots on the floorboards
//     lean ..... forward lean, throttle lean, and the lagged roll/trim sway
//       breath . slow vertical swell of the ribcage
//         body
//       neck ... yaw/pitch scan of the head
//         head
//       arm .... right arm, drifting near the rod butt
//
// The sway is the point of the rig: `lean` counter-rotates against ctx.boat.heel
// and trim by the difference between the live value and a smoothed one, so the
// body keeps rolling for a beat after the hull has stopped.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { makeRng, smoothstep, clamp } from '../core/rng.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const TAU = Math.PI * 2;

// --- palette (albedo only; every light in the scene comes from env) ----------

const BEANIE = C(0x5E7A38);
const BEANIE_LT = C(0x74914A);
const BEANIE_DK = C(0x455C26);
const HAIR = C(0x5B3A21);
const HAIR_LT = C(0x6E4726);
const SKIN = C(0xE0A87C);
const SKIN_DK = C(0xC48A61);
const EYE = C(0x2A1D16);
const JACKET = C(0x3F6E99);
const JACKET_DK = C(0x2E5279);
const JACKET_LT = C(0x5386AF);
// Sleeves sit a shade under the body so the arms read as arms against the
// barrel of the jacket instead of melting into it at a distance.
const SLEEVE = C(0x35608A);
const HOOD = C(0x36618A);
const TROUSER = C(0x2C3444);
const TROUSER_LT = C(0x394356);
const BOOT = C(0x2B2119);
const BOOT_SOLE = C(0x191310);

// --- scratch ----------------------------------------------------------------
// Build-time helpers allocate freely; update() below touches none of this.

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
const _mtx = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _tp = new THREE.Vector3();
const _ts = new THREE.Vector3();
const _col = new THREE.Color();
const _tintA = new THREE.Color();
const _tintB = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function xf(px, py, pz, rx, ry, rz, sx, sy, sz) {
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  return _mtx.compose(
    _tp.set(px, py, pz), _q,
    _ts.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz),
  );
}

// --- geometry merger --------------------------------------------------------
// Same shape as the boat's: concatenate primitives into one vertex-coloured
// buffer, keeping each source geometry's own normals so spheres stay smooth.

function Merger() {
  this.pos = [];
  this.nor = [];
  this.col = [];
}

Merger.prototype._push = function _push(geo, matrix, color, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  _m3.getNormalMatrix(matrix);
  const count = g.attributes.position.count;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const lx = p[o], ly = p[o + 1], lz = p[o + 2];
    _v.set(lx, ly, lz).applyMatrix4(matrix);
    this.pos.push(_v.x, _v.y, _v.z);
    _n.set(n[o], n[o + 1], n[o + 2]).applyMatrix3(_m3);
    if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0); else _n.normalize();
    this.nor.push(_n.x, _n.y, _n.z);
    if (fn) {
      _col.copy(color);
      fn(lx, ly, lz, _col);
      this.col.push(_col.r, _col.g, _col.b);
    } else {
      this.col.push(color.r, color.g, color.b);
    }
  }
  if (g !== geo) g.dispose();
  geo.dispose();
  return this;
};

/** Add a primitive, flat-coloured. Consumes (disposes) the geometry. */
Merger.prototype.addGeo = function addGeo(geo, matrix, color) {
  return this._push(geo, matrix, color, null);
};

/**
 * Add a primitive whose colour is shaded per-vertex by `fn(x, y, z, colour)`,
 * called with the vertex in the primitive's own local space. This is how the
 * knit gets its ribs and the jacket its creases without a shader.
 */
Merger.prototype.addGeoTinted = function addGeoTinted(geo, matrix, color, fn) {
  return this._push(geo, matrix, color, fn);
};

Merger.prototype.build = function build() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
  g.computeBoundingSphere();
  return g;
};

// --- primitives -------------------------------------------------------------

const sph = (r, w, h) => new THREE.SphereGeometry(r, w || 12, h || 8);

function roundedBox(w, h, d, r, seg) {
  const rr = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  const s = seg || 2;
  const g = new THREE.BoxGeometry(w, h, d, s, s, s);
  const p = g.attributes.position;
  const hw = w * 0.5 - rr, hh = h * 0.5 - rr, hd = d * 0.5 - rr;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const cx = Math.max(-hw, Math.min(hw, x));
    const cy = Math.max(-hh, Math.min(hh, y));
    const cz = Math.max(-hd, Math.min(hd, z));
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) p.setXYZ(i, cx + (dx / l) * rr, cy + (dy / l) * rr, cz + (dz / l) * rr);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A capsule whose cylinder runs exactly from `a` to `b`, so the hemispherical
 * caps sit on the joints and read as a shoulder, an elbow, a knee.
 */
function limb(m, a, b, r, color, radial) {
  _a.copy(b).sub(a);
  const len = _a.length();
  if (len < 1e-5) return m;
  _a.divideScalar(len);
  _q.setFromUnitVectors(UP, _a);
  _b.copy(a).addScaledVector(_a, len * 0.5);
  const mtx = new THREE.Matrix4().compose(_b, _q, _c.set(1, 1, 1));
  return m.addGeo(new THREE.CapsuleGeometry(r, len, 4, radial || 10), mtx, color);
}

/** A fingerless mitten: an egg squashed across, long axis down the forearm. */
function mitten(m, wrist, dir, r, color) {
  _a.copy(dir).normalize();
  _q.setFromUnitVectors(UP, _a);
  _b.copy(wrist).addScaledVector(_a, r * 0.55);
  const mtx = new THREE.Matrix4().compose(_b, _q, _c.set(0.92, 1.30, 0.72));
  return m.addGeo(sph(r, 10, 8), mtx, color);
}

const P = (x, y, z) => new THREE.Vector3(x, y, z);

// --- rig constants (all in seat space: y = 0 is the thwart top) -------------

const HIP_Y = 0.100;       // the lean pivot, above the thwart
const HIP_Z = 0.030;
const NECK_Y = 0.456;      // head pivot, in lean space
const NECK_Z = 0.015;
const SH_Y = 0.330;        // shoulder joint, in lean space
const SH_X = 0.170;
const SH_Z = 0.005;
const BASE_LEAN = 0.105;   // radians, leaning into the bow

// ============================================================================

export function createFisher(opts = {}) {
  const rng = makeRng(((opts.seed | 0) ^ 0x3f15be) >>> 0);
  const boat = opts.boat || null;

  const root = new THREE.Group();
  root.name = 'fisher';

  // Sit on the boat's own seat anchor rather than a guessed number, offset a
  // hand's width to port so the rod arm has somewhere to go.
  const seat = (boat && boat.seat) ? boat.seat : P(0, 0.358, 1.05);
  root.position.set(seat.x - 0.030, seat.y, seat.z);

  const geometries = [];
  const materials = [];
  const track = (g) => { geometries.push(g); return g; };

  const jit = (base, amt) => base.clone().multiplyScalar(1 + (rng.next() - 0.5) * amt);

  // ---- rig ----------------------------------------------------------------

  const lean = new THREE.Group();
  lean.position.set(0, HIP_Y, HIP_Z);
  root.add(lean);

  const breath = new THREE.Group();
  lean.add(breath);

  const neck = new THREE.Group();
  neck.position.set(0, NECK_Y, NECK_Z);
  lean.add(neck);

  const arm = new THREE.Group();
  arm.position.set(SH_X, SH_Y, SH_Z);
  lean.add(arm);

  // ---- body: jacket, hood, hips, left arm ---------------------------------

  const bm = new Merger();

  // Torso — a lathe, squashed front-to-back so the shoulders are broader than
  // they are deep. Bottom to top: haunch, waist, chest, shoulder line, neck.
  {
    const prof = [
      [0.205, -0.085], [0.216, -0.010], [0.203, 0.080], [0.192, 0.175],
      [0.194, 0.265], [0.203, 0.345], [0.190, 0.395], [0.140, 0.432],
      [0.098, 0.452],
    ];
    const pts = prof.map((p) => new THREE.Vector2(p[0], p[1]));
    bm.addGeoTinted(
      new THREE.LatheGeometry(pts, 18),
      xf(0, 0, 0, 0, 0, 0, 1, 1, 0.80),
      JACKET,
      (x, y, z, col) => {
        // Soft vertical creases in the shell, a darker hem, and a wash of shade
        // up under the hood where the fabric bunches.
        const th = Math.atan2(z, x);
        const f = Math.abs(((th / TAU) * 7 % 1 + 1) % 1 - 0.5) * 2;
        col.multiplyScalar(0.955 + 0.075 * f);
        col.lerp(JACKET_DK, smoothstep(0.06, -0.09, y) * 0.55);
        col.lerp(JACKET_DK, smoothstep(0.30, 0.44, y) * 0.35);
        col.lerp(JACKET_LT, smoothstep(0.10, 0.30, y) * smoothstep(0.02, 0.17, -z) * 0.16);
      },
    );
  }

  // Haunch: closes the bottom of the lathe and reads as the seated backside,
  // blue at the belt and dark trouser where it meets the thwart.
  bm.addGeoTinted(sph(0.190, 14, 10), xf(0, -0.055, 0.010, 0, 0, 0, 1.08, 0.62, 1.00), JACKET_DK,
    (x, y, z, col) => { col.lerp(TROUSER, smoothstep(0.02, -0.10, y)); });

  // Jacket hem.
  bm.addGeo(new THREE.TorusGeometry(0.196, 0.028, 5, 20), xf(0, -0.014, 0.006, Math.PI / 2, 0, 0, 1, 0.84, 1), JACKET_DK);

  // Round hunched back and shoulder caps.
  bm.addGeo(sph(0.145, 12, 8), xf(0, 0.312, 0.078, 0, 0, 0, 1.14, 0.86, 0.72), jit(JACKET, 0.06));
  for (let s = -1; s <= 1; s += 2) {
    bm.addGeo(sph(0.100, 12, 8), xf(s * SH_X, SH_Y, SH_Z, 0, 0, 0, 1.0, 0.95, 0.88), jit(JACKET, 0.05));
  }

  // Neck stub — almost entirely swallowed by the collar, but it stops daylight
  // showing through when the head turns.
  bm.addGeo(new THREE.CylinderGeometry(0.058, 0.064, 0.14, 10), xf(0, 0.400, 0.012), SKIN_DK);

  // The hood, bunched: a fat roll around the neck, a bundle at the nape and a
  // drape lying across the upper back.
  bm.addGeo(new THREE.TorusGeometry(0.126, 0.062, 6, 18), xf(0, 0.424, 0.014, Math.PI / 2, 0, 0, 1.04, 0.94, 1.0), HOOD);
  bm.addGeo(sph(0.135, 12, 8), xf(0, 0.412, 0.136, 0.18, 0, 0, 1.10, 0.72, 0.80), jit(HOOD, 0.06));
  bm.addGeo(sph(0.120, 12, 8), xf(0, 0.298, 0.172, -0.22, 0, 0, 1.26, 0.86, 0.55), jit(HOOD, 0.06));

  // Left arm: hanging down, forearm across the thigh.
  {
    const sh = P(-SH_X, SH_Y, SH_Z);
    const el = P(-0.212, 0.130, -0.055);
    const hd = P(-0.170, 0.040, -0.240);
    limb(bm, sh, el, 0.075, jit(SLEEVE, 0.05));
    limb(bm, el, hd, 0.064, jit(SLEEVE, 0.05));
    bm.addGeo(new THREE.TorusGeometry(0.060, 0.017, 4, 12),
      xf(hd.x + 0.010, hd.y + 0.024, hd.z + 0.052, 1.30, 0, 0.25), JACKET_DK);
    mitten(bm, hd, _v.copy(hd).sub(el), 0.070, jit(TROUSER_LT, 0.06));
  }

  // ---- legs (root space; the feet stay planted while the torso sways) ------
  // Their own buffer, hung off the root rather than the lean pivot — the boots
  // have to stay flat on the floorboards no matter what the body does.

  const lm = new Merger();
  for (let s = -1; s <= 1; s += 2) {
    const hip = P(s * 0.106, 0.070, 0.020);
    const knee = P(s * 0.124, 0.048, -0.395);
    const ankle = P(s * 0.130, -0.190, -0.470);
    limb(lm, hip, knee, 0.080, jit(TROUSER, 0.07));
    lm.addGeo(sph(0.082, 10, 8), xf(knee.x, knee.y, knee.z, 0, 0, 0, 1.0, 1.0, 1.05), jit(TROUSER_LT, 0.06));
    limb(lm, knee, ankle, 0.068, jit(TROUSER, 0.07));
    // trouser cuff over the boot
    lm.addGeo(new THREE.TorusGeometry(0.062, 0.020, 4, 12),
      xf(ankle.x, ankle.y - 0.006, ankle.z - 0.010, 1.42, 0, 0), TROUSER_LT);
    // boot
    lm.addGeo(roundedBox(0.128, 0.092, 0.250, 0.042, 3), xf(s * 0.130, -0.220, -0.548, 0.04, s * 0.05, 0), BOOT);
    lm.addGeo(sph(0.063, 10, 8), xf(s * 0.130, -0.208, -0.648, 0, 0, 0, 1.0, 0.72, 0.85), BOOT);
    lm.addGeo(roundedBox(0.132, 0.030, 0.256, 0.012, 2), xf(s * 0.130, -0.252, -0.550), BOOT_SOLE);
  }

  // ---- right arm (own pivot, so the mitten can drift by the rod) ----------

  const am = new Merger();
  {
    const sh = P(0, 0, 0);
    const el = P(0.175, -0.100, 0.070);
    const hd = P(0.415, -0.245, 0.115);
    limb(am, sh, el, 0.075, jit(SLEEVE, 0.05));
    limb(am, el, hd, 0.064, jit(SLEEVE, 0.05));
    _a.copy(hd).sub(el).normalize();
    am.addGeo(new THREE.TorusGeometry(0.060, 0.017, 4, 12),
      (() => {
        _q.setFromUnitVectors(UP, _a);
        return new THREE.Matrix4().compose(
          _b.copy(hd).addScaledVector(_a, -0.052), _q, _c.set(1, 1, 1),
        ).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      })(),
      JACKET_DK);
    mitten(am, hd, _a, 0.070, jit(TROUSER_LT, 0.06));
  }

  // ---- head: skull, face, hair, beanie ------------------------------------

  const hm = new Merger();

  // Skull and jaw. Slightly oversized head, chin tucked toward the collar.
  hm.addGeo(sph(0.118, 16, 12), xf(0, 0.150, 0, 0, 0, 0, 1.00, 1.10, 1.06), SKIN);
  hm.addGeo(sph(0.082, 12, 10), xf(0, 0.078, -0.030, 0, 0, 0, 0.92, 0.80, 0.98), SKIN);
  hm.addGeo(sph(0.024, 8, 6), xf(0, 0.138, -0.118, 0, 0, 0, 0.85, 0.85, 1.15), SKIN);
  for (let s = -1; s <= 1; s += 2) {
    hm.addGeo(sph(0.032, 8, 6), xf(s * 0.116, 0.138, 0.010, 0, 0, 0, 0.45, 1.0, 0.80), SKIN_DK);
    // Eyes are all but flush — from behind and three quarters they only ever
    // catch the edge of the cheek, and a proud bead would read as a bug.
    hm.addGeo(sph(0.022, 8, 6), xf(s * 0.052, 0.163, -0.100, 0, s * 0.12, 0, 0.90, 1.05, 0.35), EYE);
  }

  // Hair: one mass at the nape, wedges over the ears, loose chunks at the neck
  // and a short fringe peeking out under the brim.
  {
    const H = () => jit(rng.chance(0.4) ? HAIR_LT : HAIR, 0.14);
    hm.addGeo(sph(0.105, 12, 8), xf(0, 0.078, 0.085, -0.10, 0, 0, 1.20, 0.80, 0.74), H());
    for (let s = -1; s <= 1; s += 2) {
      hm.addGeo(sph(0.062, 10, 8), xf(s * 0.110, 0.100, 0.018, 0, 0, s * 0.10, 0.68, 1.00, 1.05), H());
      hm.addGeo(sph(0.048, 8, 6), xf(s * 0.072, 0.032, 0.092, 0.2, 0, 0, 1.10, 0.80, 0.90), H());
      hm.addGeo(sph(0.042, 8, 6), xf(s * 0.078, 0.150, -0.074, 0, 0, s * 0.2, 1.35, 0.42, 0.72), H());
    }
    hm.addGeo(sph(0.055, 10, 8), xf(0, 0.030, 0.090, 0.24, 0, 0, 1.30, 0.70, 0.85), H());
  }

  // The beanie. This is the character, so it gets the most geometry: a rolled
  // brim of eighteen knit ribs over a torus core, a soft crown with radiating
  // ribs painted into the vertex colours, and a slouch that flops aft.
  {
    hm.addGeo(new THREE.TorusGeometry(0.122, 0.034, 7, 22),
      xf(0, 0.200, 0.008, Math.PI / 2, 0, 0, 1.02, 1.06, 1.0), BEANIE_DK);

    const RIBS = 18;
    for (let i = 0; i < RIBS; i++) {
      const ang = (i / RIBS) * TAU;
      const odd = i % 2 === 1;
      const rad = odd ? 0.131 : 0.135;
      hm.addGeo(
        roundedBox(0.030, 0.088, 0.046, 0.011, 2),
        xf(
          Math.cos(ang) * rad * 1.02, 0.200, Math.sin(ang) * rad * 1.06,
          0, Math.PI / 2 - ang, 0,
        ),
        odd ? BEANIE : BEANIE_LT,
      );
    }

    hm.addGeoTinted(sph(0.132, 16, 12), xf(0, 0.222, 0.010, 0, 0, 0, 1.02, 0.90, 1.06), BEANIE,
      (x, y, z, col) => {
        const th = Math.atan2(z, x);
        const f = Math.abs(((th / TAU) * 10 % 1 + 1) % 1 - 0.5) * 2;
        col.multiplyScalar(0.930 + 0.130 * f);
        col.lerp(BEANIE_DK, smoothstep(-0.02, -0.10, y) * 0.7);
        col.lerp(BEANIE_LT, smoothstep(0.06, 0.13, y) * 0.20);
      });
    hm.addGeo(sph(0.088, 12, 10), xf(0, 0.290, 0.056, -0.20, 0, 0, 0.95, 0.72, 1.05), BEANIE);
    hm.addGeo(sph(0.030, 8, 6), xf(0, 0.328, 0.046, 0, 0, 0, 1.0, 0.82, 1.0), BEANIE_LT);
  }

  // ---- meshes -------------------------------------------------------------

  const cloth = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.86, metalness: 0.0,
  });
  materials.push(cloth);

  const bodyMesh = new THREE.Mesh(track(bm.build()), cloth);
  const headMesh = new THREE.Mesh(track(hm.build()), cloth);
  const armMesh = new THREE.Mesh(track(am.build()), cloth);
  const legMesh = new THREE.Mesh(track(lm.build()), cloth);
  for (const m of [bodyMesh, headMesh, armMesh, legMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  breath.add(bodyMesh);
  neck.add(headMesh);
  arm.add(armMesh);
  root.add(legMesh);

  setLayers(root, LAYER.MAIN, LAYER.REFLECTED);

  const parented = !!(boat && boat.group);
  if (parented) boat.group.add(root);

  // ---- state (every value below is scalar; update allocates nothing) ------

  let lagHeel = 0;
  let lagTrim = 0;
  let leanExtra = 0;
  let headYaw = 0;
  let headPitch = 0;
  let armDrift = 0;

  const api = {
    group: parented ? null : root,

    /** Head pivot, boat-local — handy if anything ever wants to look at it. */
    headAnchor: P(seat.x - 0.030, seat.y + HIP_Y + NECK_Y + 0.15, seat.z + HIP_Z + NECK_Z),

    applyEnv(env) {
      // Albedo is authored above; what env decides here is the cast. At night
      // the jacket must not stay a daylight blue, so the whole material tints
      // toward the ambient sky, then picks up a little of the boat lantern's
      // warmth — the practical is sat 0.7 m off the fisher's left elbow.
      _tintA.copy(env.ambientSky);
      const ma = Math.max(_tintA.r, _tintA.g, _tintA.b, 1e-4);
      _tintA.multiplyScalar(1 / ma);
      _tintB.copy(env.windowLight);
      const mb = Math.max(_tintB.r, _tintB.g, _tintB.b, 1e-4);
      _tintB.multiplyScalar(1 / mb);

      const n = clamp(env.nightFactor, 0, 1);
      const lamp = clamp(env.lanternIntensity, 0, 1);
      cloth.color.setRGB(1, 1, 1);
      cloth.color.lerp(_tintA, 0.13 * n);
      cloth.color.lerp(_tintB, 0.09 * lamp);
      cloth.roughness = 0.86 - 0.05 * n;
    },

    update(ctx) {
      const b = ctx.boat;
      const t = ctx.time;
      const dt = ctx.dt;

      // --- sway ------------------------------------------------------------
      // The hull's attitude is applied to the boat group; the fisher is a child
      // of it, so counter-rotating by (live - lagged) leaves the body sitting
      // at the lagged attitude. Soft body, a beat behind the boat.
      const k = Math.min(1, dt * 2.7);
      lagHeel += (b.heel - lagHeel) * k;
      lagTrim += (b.trim - lagTrim) * k;

      // --- lean ------------------------------------------------------------
      const push = clamp(b.throttle, 0, 1) * 0.085
        + Math.min(1, Math.abs(b.speed) / 7) * 0.035;
      leanExtra += (push - leanExtra) * Math.min(1, dt * 1.6);

      lean.rotation.set(
        -BASE_LEAN - leanExtra + (b.trim - lagTrim) * 0.55
          + Math.sin(t * 0.47 + 0.6) * 0.008,
        Math.sin(t * 0.29) * 0.012 - b.turnRate * 0.06,
        (lagHeel - b.heel) * 0.62 + b.turnRate * 0.09
          + Math.sin(t * 0.37 + 2.2) * 0.010,
        'YXZ',
      );

      // --- breathing -------------------------------------------------------
      const br = Math.sin(t * 0.92) * 0.013 + Math.sin(t * 1.87 + 1.1) * 0.0045;
      breath.scale.set(1 + br * 0.40, 1 + br, 1 + br * 0.55);
      neck.position.y = NECK_Y * (1 + br);
      arm.position.y = SH_Y * (1 + br);

      // --- head: mostly still, with an occasional slow scan of the water ---
      const w = Math.sin(t * 0.117) * 0.62 + Math.sin(t * 0.071 + 2.1) * 0.38;
      const aw = Math.abs(w);
      const gate = smoothstep(0.55, 0.95, aw);
      const yawTarget = (w < 0 ? -1 : 1) * gate * 0.60 + Math.sin(t * 0.41 + 0.3) * 0.035;
      const pitchTarget = -0.045 + gate * 0.055 + Math.sin(t * 0.53) * 0.018;
      const hk = Math.min(1, dt * 1.7);
      headYaw += (yawTarget - headYaw) * hk;
      headPitch += (pitchTarget - headPitch) * hk;
      neck.rotation.set(
        headPitch - leanExtra * 0.45,
        headYaw,
        (lagHeel - b.heel) * 0.30 - headYaw * 0.10,
        'YXZ',
      );

      // --- rod arm ---------------------------------------------------------
      const drift = Math.sin(t * 0.61) * 0.020 + Math.sin(t * 1.13 + 0.9) * 0.008;
      armDrift += (drift - armDrift) * Math.min(1, dt * 3.0);
      arm.rotation.set(
        armDrift + leanExtra * 0.35,
        Math.sin(t * 0.44 + 1.7) * 0.018,
        -armDrift * 0.7 - (lagHeel - b.heel) * 0.25,
        'YXZ',
      );
    },

    dispose() {
      if (root.parent) root.parent.remove(root);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
      materials.length = 0;
      root.clear();
    },
  };

  return api;
}
