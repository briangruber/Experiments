// The dinghy, the angler in it, and everything that moves in the bay.
//
// The boat is deliberately small against the world - 3.9m of hull under a 12m
// lighthouse - because the reference gets its sense of scale from exactly that
// contrast. Motion is arcadey: quick to turn, slow to stop, and it heels into
// the turn hard enough to be readable from behind.

import { MeshBuilder, uploadMesh, shade } from './geom.js';
import { PAL } from './world.js';
import { mat4, clamp, lerp } from '../src/math.js';

// ---------------------------------------------------------------- transforms
export function trs(pos, yaw, pitch = 0, roll = 0, s = 1) {
  const m = mat4();
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry * Rx * Rz, column-major
  m[0] = (cy * cr + sy * sp * sr) * s;
  m[1] = (cp * sr) * s;
  m[2] = (-sy * cr + cy * sp * sr) * s;
  m[4] = (-cy * sr + sy * sp * cr) * s;
  m[5] = (cp * cr) * s;
  m[6] = (sy * sr + cy * sp * cr) * s;
  m[8] = (sy * cp) * s;
  m[9] = (-sp) * s;
  m[10] = (cy * cp) * s;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
  return m;
}

// Must stay in step with waveAt() in the water shader, or the hull floats in
// the wrong place. Same three swells, same speeds.
export function waveHeight(x, z, t) {
  const k1x = 0.92 * 0.42, k1z = 0.39 * 0.42;
  const k2x = -0.42 * 0.71, k2z = 0.90 * 0.71;
  const k3x = 0.71 * 1.35, k3z = -0.70 * 1.35;
  return Math.sin(x * k1x + z * k1z - t * 1.05) * 0.085
       + Math.sin(x * k2x + z * k2z - t * 1.55) * 0.045
       + Math.sin(x * k3x + z * k3z - t * 2.1) * 0.022;
}

// ---------------------------------------------------------------- boat mesh
export function buildBoat(gl) {
  const m = new MeshBuilder();
  // Open U-section: port gunwale, round the keel, up to starboard. Lofted
  // twice - once outward for the topsides, once inward for the cockpit - with
  // a capped rail between them, so the boat has a real inside to sit in.
  const outer = (s) => [
    [-0.80 * s, 0.52], [-0.76 * s, 0.08], [-0.56 * s, -0.20], [-0.20 * s, -0.32],
    [0.20 * s, -0.32], [0.56 * s, -0.20], [0.76 * s, 0.08], [0.80 * s, 0.52],
  ];
  const inner = (s) => outer(s).map(([x, y]) => [x * 0.88, y * 0.9 + 0.035]);
  const S = [
    { z: -1.95, s: 0.82 }, { z: -1.30, s: 0.96 }, { z: 0.10, s: 1.00 },
    { z: 1.10, s: 0.90 }, { z: 1.70, s: 0.58 }, { z: 2.00, s: 0.10 },
  ];
  const white = shade(PAL.white, -0.02);
  const secs = (f) => S.map((k) => ({ z: k.z, pts: f(k.s) }));

  m.loft(secs(outer), white, { closed: false });
  m.loft(secs(inner), shade(PAL.plankPale, 0.10), { closed: false, flip: true });
  // rail caps along both gunwales
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1];
    const ao = outer(a.s), ai = inner(a.s), bo = outer(b.s), bi = inner(b.s);
    const last = ao.length - 1;
    m.quad([ao[0][0], ao[0][1], a.z], [bo[0][0], bo[0][1], b.z],
      [bi[0][0], bi[0][1], b.z], [ai[0][0], ai[0][1], a.z], PAL.plank);
    m.quad([ai[last][0], ai[last][1], a.z], [bi[last][0], bi[last][1], b.z],
      [bo[last][0], bo[last][1], b.z], [ao[last][0], ao[last][1], a.z], PAL.plank);
  }

  // fore and aft decks close the shell off at both ends
  m.save(); m.translate(0, 0.44, 1.5); m.box(1.1, 0.1, 1.0, PAL.plank); m.restore();
  m.save(); m.translate(0, 0.44, -1.72); m.box(1.3, 0.1, 0.5, PAL.plank); m.restore();

  // planked interior floor
  m.save(); m.translate(0, -0.2, 0); m.box(1.24, 0.08, 3.1, PAL.plank); m.restore();
  const rail = (s, z, len) => {
    for (const side of [-1, 1]) {
      m.save();
      m.translate(side * 0.80 * s, 0.52, z);
      m.rotY(side > 0 ? 0.04 : -0.04);
      m.box(0.14, 0.15, len, PAL.plank);
      m.restore();
    }
  };
  rail(0.99, -0.4, 3.0);
  rail(0.78, 1.35, 0.95);
  // a lower wooden strake along the topsides, the classic two-tone dinghy
  for (const side of [-1, 1]) {
    m.save();
    m.translate(side * 0.79, 0.30, -0.2);
    m.box(0.07, 0.16, 3.5, PAL.plankDark);
    m.restore();
  }
  // transom
  m.save(); m.translate(0, 0.10, -1.95); m.box(1.32, 0.82, 0.14, PAL.plank); m.restore();
  // stem post at the bow
  m.save(); m.translate(0, 0.30, 1.92); m.box(0.16, 0.5, 0.3, PAL.plank); m.restore();

  // thwarts
  for (const z of [-0.75, 0.55]) {
    m.save(); m.translate(0, 0.30, z); m.box(1.42, 0.10, 0.34, PAL.plankPale); m.restore();
  }

  // ---- outboard motor on the transom
  m.save();
  m.translate(0, 0.22, -2.18);
  m.box(0.52, 0.62, 0.46, PAL.metal);
  m.save(); m.translate(0, 0.36, 0); m.box(0.44, 0.14, 0.40, shade(PAL.metal, -0.2)); m.restore();
  m.save(); m.translate(0, -0.36, 0.02); m.box(0.16, 0.5, 0.16, shade(PAL.metal, -0.35)); m.restore();
  m.save(); m.translate(0, -0.78, 0.02);
  m.box(0.14, 0.5, 0.42, shade(PAL.metal, -0.35));
  m.translate(0, -0.2, -0.16); m.box(0.10, 0.22, 0.3, PAL.stoneDark);
  m.restore();
  m.save(); m.translate(0.18, 0.18, 0.28); m.rotZ(0.5); m.box(0.08, 0.08, 0.5, PAL.plankDark); m.restore();
  m.restore();

  // ---- gear: life ring, lantern, tackle boxes, a bucket
  m.save();
  m.translate(0.86, 0.30, -1.45); m.rotY(0.1); m.rotX(Math.PI / 2);
  m.torus(0.30, 0.10, 12, 6, PAL.red);
  m.restore();
  m.save();
  m.translate(0.86, 0.30, -1.45); m.rotY(0.1); m.rotX(Math.PI / 2);
  m.torus(0.30, 0.104, 12, 6, PAL.white, { arc: Math.PI * 0.5 });
  m.save(); m.rotY(Math.PI); m.torus(0.30, 0.104, 12, 6, PAL.white, { arc: Math.PI * 0.5 }); m.restore();
  m.restore();

  m.save(); m.translate(-0.62, 0.44, -1.55);
  m.box(0.10, 0.34, 0.10, PAL.metal);
  m.translate(0, -0.30, 0);
  m.box(0.26, 0.34, 0.26, PAL.lamp, { emis: 1.5 });
  m.translate(0, -0.22, 0); m.box(0.30, 0.09, 0.30, PAL.metal);
  m.restore();

  m.save(); m.translate(-0.34, -0.02, -1.15); m.rotY(0.2);
  m.box(0.5, 0.22, 0.34, PAL.roofTeal);
  m.translate(0, 0.14, 0); m.box(0.52, 0.06, 0.36, shade(PAL.roofTeal, 0.2));
  m.restore();
  m.save(); m.translate(0.30, -0.02, -0.95); m.rotY(-0.3);
  m.box(0.42, 0.2, 0.3, PAL.roofOchre);
  m.restore();
  m.save(); m.translate(-0.42, 0.02, 1.25);
  m.cyl([0.22, 0.25], 0.34, 9, shade(PAL.metal, 0.25));
  m.restore();

  // rod holder on the starboard rail
  m.save(); m.translate(0.62, 0.42, -0.15); m.rotZ(-0.25); m.cyl([0.07, 0.07], 0.3, 7, PAL.metal); m.restore();

  return uploadMesh(gl, m.build());
}

// ---------------------------------------------------------------- the angler
// Built facing +z (forward), seated on the aft thwart. Seen from behind almost
// always, so the silhouette - beanie, hood, shoulders - carries the character.
export function buildAngler(gl) {
  const m = new MeshBuilder();
  const hoodie = '#3f6ea8', hoodieDark = '#33598a', skin = '#e2b48d', hair = '#4a3220', beanie = '#5d8f3f';

  m.save();
  m.translate(0, 0.30, 0);
  // torso, slightly tapered and leaning forward
  m.rotX(-0.10);
  m.box(0.62, 0.66, 0.42, hoodie, { taper: 0.92 });
  // hood bunched at the back of the neck
  m.save(); m.translate(0, 0.36, -0.16); m.rotX(0.4);
  m.ball(0.26, 8, 5, hoodieDark, { squash: 0.72 }); m.restore();
  // Arms: the right one up and out to the rod grip, the left resting on the
  // thwart. Asymmetry is what stops a seated figure reading as a mannequin.
  m.save();
  m.translate(0.30, 0.20, 0.04);
  m.rotZ(-0.55); m.rotX(-0.42);
  m.box(0.18, 0.54, 0.18, hoodie);
  m.save(); m.translate(0, -0.33, 0.0); m.box(0.15, 0.15, 0.15, skin); m.restore();
  m.restore();
  m.save();
  m.translate(-0.32, 0.10, 0.06);
  m.rotZ(0.22); m.rotX(-0.95);
  m.box(0.18, 0.52, 0.18, hoodie);
  m.save(); m.translate(0, -0.32, 0.0); m.box(0.15, 0.15, 0.15, skin); m.restore();
  m.restore();
  // head
  m.save();
  m.translate(0, 0.56, 0.02);
  m.ball(0.21, 9, 6, skin, { squash: 1.02 });
  m.save(); m.translate(0, 0.02, -0.05); m.ball(0.215, 9, 6, hair, { squash: 0.9 }); m.restore();
  m.save(); m.translate(0, 0.08, 0);
  m.ball(0.225, 9, 5, beanie, { squash: 0.86 });
  m.save(); m.translate(0, -0.02, 0); m.cyl([0.235, 0.235], 0.09, 9, shade(beanie, -0.12)); m.restore();
  m.save(); m.translate(0, 0.20, 0); m.ball(0.075, 6, 4, shade(beanie, 0.22)); m.restore();
  m.restore();
  m.restore();
  m.restore();
  return uploadMesh(gl, m.build());
}

export function buildRod(gl) {
  const m = new MeshBuilder();
  // pivots at the butt, points +y; the boat tilts it into place
  m.cyl([0.032, 0.026], 0.28, 6, PAL.plankDark);
  m.save(); m.translate(0, 0.28, 0);
  m.cyl([0.024, 0.006], 2.55, 6, '#2b2b2e');
  m.restore();
  m.save(); m.translate(0.055, 0.20, 0); m.rotZ(Math.PI / 2);
  m.cyl([0.09, 0.09], 0.07, 10, PAL.metal);
  m.restore();
  for (let i = 1; i <= 4; i++) {
    m.save(); m.translate(0, 0.4 + i * 0.5, 0); m.rotX(Math.PI / 2);
    m.torus(0.035, 0.008, 7, 4, PAL.metal); m.restore();
  }
  return uploadMesh(gl, m.build());
}

export function buildBobber(gl) {
  const m = new MeshBuilder();
  m.save(); m.translate(0, 0.06, 0);
  m.ball(0.10, 8, 5, PAL.red);
  m.save(); m.translate(0, -0.07, 0); m.ball(0.101, 8, 4, PAL.white, { squash: 0.6 }); m.restore();
  m.save(); m.translate(0, 0.12, 0); m.cyl([0.012, 0.012], 0.12, 5, PAL.metal); m.restore();
  m.restore();
  return uploadMesh(gl, m.build());
}

// ---------------------------------------------------------------- fish + gulls
export const SPECIES = [
  { name: 'Herring',      col: '#9fc7d8', belly: '#eef4f6', value: 8,   size: 0.30, rarity: 0.34 },
  { name: 'Mackerel',     col: '#4f8fa8', belly: '#dfeef2', value: 14,  size: 0.36, rarity: 0.26 },
  { name: 'Red Snapper',  col: '#c8503f', belly: '#f0cfc2', value: 26,  size: 0.44, rarity: 0.18 },
  { name: 'Sea Bream',    col: '#d8b45a', belly: '#f5ecd2', value: 38,  size: 0.48, rarity: 0.12 },
  { name: 'Bluefin',      col: '#2f5f9e', belly: '#cfe0f0', value: 70,  size: 0.72, rarity: 0.07 },
  { name: 'Moonfish',     col: '#b58fd0', belly: '#f0e6f7', value: 130, size: 0.62, rarity: 0.03 },
];

export function pickSpecies(rand, depthBonus = 0) {
  // deeper water shifts the roll towards the rare end
  let roll = rand() * (1 - depthBonus * 0.45);
  for (let i = 0; i < SPECIES.length; i++) {
    roll -= SPECIES[i].rarity;
    if (roll <= 0) return SPECIES[i];
  }
  return SPECIES[SPECIES.length - 1];
}

export function buildFish(gl, sp) {
  const m = new MeshBuilder();
  const body = (s) => [[0, 0.30 * s], [0.22 * s, 0.10 * s], [0.20 * s, -0.16 * s], [0, -0.26 * s], [-0.20 * s, -0.16 * s], [-0.22 * s, 0.10 * s]];
  m.loft([
    { z: -0.52, pts: body(0.10) }, { z: -0.34, pts: body(0.55) }, { z: 0.02, pts: body(1.0) },
    { z: 0.34, pts: body(0.78) }, { z: 0.52, pts: body(0.30) },
  ], sp.col);
  // pale belly slab
  m.save(); m.translate(0, -0.2, 0.02); m.box(0.30, 0.10, 0.72, sp.belly); m.restore();
  // tail
  m.save(); m.translate(0, 0, -0.52); m.rotX(Math.PI / 2);
  m.card(0.46, 0.42, shade(sp.col, -0.1));
  m.restore();
  m.save(); m.translate(0, 0.28, 0.02); m.card(0.5, 0.24, shade(sp.col, -0.15)); m.restore();
  for (const side of [-1, 1]) {
    m.save(); m.translate(side * 0.2, -0.02, 0.12); m.rotZ(side * 0.6); m.rotY(side * 0.3);
    m.card(0.22, 0.2, shade(sp.col, -0.05)); m.restore();
  }
  m.save(); m.translate(0.16, 0.10, 0.40); m.ball(0.045, 5, 4, '#141414'); m.restore();
  m.save(); m.translate(-0.16, 0.10, 0.40); m.ball(0.045, 5, 4, '#141414'); m.restore();
  return { mesh: uploadMesh(gl, m.build()), species: sp };
}

export function buildGull(gl) {
  const m = new MeshBuilder();
  m.save();
  m.rotX(-0.06);
  m.loft([
    { z: -0.34, pts: [[0, 0.05], [0.045, 0], [0, -0.05], [-0.045, 0]] },
    { z: -0.1, pts: [[0, 0.12], [0.11, 0], [0, -0.11], [-0.11, 0]] },
    { z: 0.22, pts: [[0, 0.11], [0.10, 0], [0, -0.10], [-0.10, 0]] },
    { z: 0.36, pts: [[0, 0.06], [0.05, 0], [0, -0.05], [-0.05, 0]] },
  ], PAL.white);
  m.save(); m.translate(0, 0.06, 0.34); m.ball(0.10, 7, 5, PAL.white); m.restore();
  m.save(); m.translate(0, 0.04, 0.46); m.rotX(Math.PI / 2); m.cyl([0.035, 0.005], 0.14, 5, '#e8a13c'); m.restore();
  m.save(); m.translate(0, 0.10, -0.16); m.box(0.12, 0.05, 0.3, shade(PAL.stone, -0.1)); m.restore();
  m.restore();
  return uploadMesh(gl, m.build());
}

// wings are separate so they can flap
export function buildGullWing(gl, side) {
  const m = new MeshBuilder();
  m.save();
  m.translate(side * 0.06, 0, 0);
  for (let i = 0; i < 3; i++) {
    m.save();
    m.translate(side * (0.1 + i * 0.16), -i * 0.012, -i * 0.03);
    m.rotY(side * -0.12 * i);
    m.box(0.2, 0.03, 0.30 - i * 0.06, i === 2 ? shade(PAL.stone, -0.25) : PAL.white);
    m.restore();
  }
  m.restore();
  return uploadMesh(gl, m.build());
}

// ---------------------------------------------------------------- boat physics
export class Boat {
  constructor(x, z, yaw) {
    this.x = x; this.z = z; this.yaw = yaw;
    this.speed = 0; this.turn = 0;
    this.heel = 0; this.pitch = 0;
    this.y = 0;
    this.throttle = 0;
    this.wakePhase = 0;
    this.maxSpeed = 11.5;
  }

  update(dt, input, world, t) {
    const accel = input.forward > 0 ? 9.0 : (input.forward < 0 ? -5.5 : 0);
    const boost = input.boost ? 1.45 : 1;
    this.throttle = lerp(this.throttle, input.forward * boost, 1 - Math.exp(-dt * 3.2));
    this.speed += accel * boost * dt;
    // quadratic drag gives a soft top end and a long, satisfying coast-down
    this.speed -= this.speed * Math.abs(this.speed) * 0.028 * dt * 3.0;
    this.speed -= this.speed * 0.55 * dt;
    this.speed = clamp(this.speed, -4.2, this.maxSpeed * boost);

    const steerAuthority = clamp(Math.abs(this.speed) / 4.2, 0.12, 1) * (this.speed < 0 ? -1 : 1);
    const targetTurn = -input.turn * 1.5 * steerAuthority;
    this.turn = lerp(this.turn, targetTurn, 1 - Math.exp(-dt * 4.5));
    this.yaw += this.turn * dt;

    let nx = this.x + Math.sin(this.yaw) * this.speed * dt;
    let nz = this.z + Math.cos(this.yaw) * this.speed * dt;

    for (const o of world.obstacles) {
      const dx = nx - o.x, dz = nz - o.z;
      const d = Math.hypot(dx, dz);
      const rr = o.r + 1.5;
      if (d < rr && d > 1e-4) {
        nx = o.x + (dx / d) * rr;
        nz = o.z + (dz / d) * rr;
        this.speed *= 0.55;
      }
    }
    const lim = 300;
    this.x = clamp(nx, -lim, lim); this.z = clamp(nz, -lim, lim);

    // ride the swell: sample fore and aft for pitch, port and starboard for heel
    const f = 1.6, s = 0.8;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const hC = waveHeight(this.x, this.z, t);
    const hF = waveHeight(this.x + fx * f, this.z + fz * f, t);
    const hA = waveHeight(this.x - fx * f, this.z - fz * f, t);
    const hP = waveHeight(this.x - fz * s, this.z + fx * s, t);
    const hS = waveHeight(this.x + fz * s, this.z - fx * s, t);

    this.y = hC + 0.02;
    const wavePitch = Math.atan2(hF - hA, f * 2);
    const waveHeel = Math.atan2(hS - hP, s * 2);
    // planing trim: bow lifts under power, hull heels outboard in a turn
    const trim = -clamp(this.speed / this.maxSpeed, 0, 1) * 0.14 - this.throttle * 0.03;
    const heelTarget = clamp(this.turn * this.speed * 0.055, -0.42, 0.42) + waveHeel;
    this.pitch = lerp(this.pitch, wavePitch + trim, 1 - Math.exp(-dt * 6));
    this.heel = lerp(this.heel, heelTarget, 1 - Math.exp(-dt * 5));

    this.wakePhase += Math.abs(this.speed) * dt;
  }

  get forward() { return [Math.sin(this.yaw), 0, Math.cos(this.yaw)]; }

  // Local -> world for attachment points (rod butt, seats, bow eye).
  matrix(scale = 1) {
    return trs([this.x, this.y, this.z], this.yaw, this.pitch, this.heel, scale);
  }

  localToWorld(p) {
    const m = this.matrix();
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
  }
}
