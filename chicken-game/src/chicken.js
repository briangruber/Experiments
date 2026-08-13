import * as THREE from 'three';
import { clamp, damp, lerp, rand, turnToward, wrapAngle, TAU } from './util.js';
import { pickBehavior, forceBehavior } from './behaviors.js';

// Chickens are built facing +Z: forward = (sin yaw, 0, cos yaw).

const BODY_GEO = new THREE.SphereGeometry(0.22, 10, 8);
const HEAD_GEO = new THREE.SphereGeometry(0.10, 9, 7);
const BEAK_GEO = new THREE.ConeGeometry(0.035, 0.09, 5);
const EYE_GEO = new THREE.SphereGeometry(0.02, 6, 5);
const COMB_GEO = new THREE.BoxGeometry(0.03, 0.055, 0.06);
const WATTLE_GEO = new THREE.BoxGeometry(0.028, 0.055, 0.03);
const WING_GEO = new THREE.SphereGeometry(0.16, 8, 6);
const TAIL_GEO = new THREE.BoxGeometry(0.03, 0.20, 0.06);
const LEG_GEO = new THREE.CylinderGeometry(0.014, 0.014, 0.30, 5);
const FOOT_GEO = new THREE.BoxGeometry(0.09, 0.02, 0.13);

const ORANGE = new THREE.MeshStandardMaterial({ color: 0xd98b2b, flatShading: true, roughness: 0.85 });
const RED = new THREE.MeshStandardMaterial({ color: 0xc23b2e, flatShading: true, roughness: 0.85 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x1c1310, flatShading: true, roughness: 0.6 });

function feathered(color) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 });
}

export class Chicken {
  constructor(name, palette, world) {
    this.name = name;
    this.world = world;
    this.color = palette.body;

    // Personality: how fast she moves and how weird she is willing to get.
    this.speedMul = rand(world.rng, 0.85, 1.2);
    this.weirdMul = rand(world.rng, 0.6, 1.8);

    this.yaw = rand(world.rng, -Math.PI, Math.PI);
    this.move = null;          // { target: Vector3, speed }
    this.hop = null;           // { from, to, t, dur, height }
    this.perch = null;         // roost reference while perched
    this.frozen = false;       // statue mode: skip all animation

    this.gait = 0;             // leg phase
    this.gaitAmp = 0;          // 0 = standing, 1 = walking
    this.sit = 0; this.sitT = 0;           // squat amount (target / current)
    this.flap = 0; this.flapT = 0;         // wing spread
    this.neckPitch = 0; this.neckPitchT = 0;
    this.headTilt = 0; this.headTiltT = 0;
    this.headYaw = 0; this.headYawT = 0;
    this.bodyRoll = 0;         // driven directly by behaviors (dust bath, dizzy)
    this.peckT = 1e9;          // time since last peck started
    this.peckHeight = 0;       // 0 = ground, ~0.35 = feeder trough

    this.bhv = { name: null, def: null, t: 0, dur: 0, data: {}, lastName: null };
    this.cooldowns = {};

    this.root = new THREE.Group();
    this.buildModel(palette);
    this.root.position.set(rand(world.rng, -3, 3), 0, rand(world.rng, -2.5, 3));
    this.root.rotation.y = this.yaw;
  }

  buildModel(palette) {
    const body = feathered(palette.body);
    const accent = feathered(palette.accent);

    this.hips = new THREE.Group();
    this.hips.position.y = 0.32;
    this.root.add(this.hips);

    const bodyMesh = new THREE.Mesh(BODY_GEO, body);
    bodyMesh.scale.set(0.95, 0.85, 1.2);
    bodyMesh.castShadow = true;
    this.hips.add(bodyMesh);

    // Tail: a fan of flat quills angled up and back.
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.10, -0.22);
    for (let i = 0; i < 5; i++) {
      const q = new THREE.Mesh(TAIL_GEO, i % 2 ? accent : body);
      const spread = (i - 2) * 0.16;
      q.position.set(spread * 0.22, 0.055, -0.03 - Math.abs(spread) * 0.05);
      q.rotation.set(-0.8 - Math.abs(spread) * 0.55, spread * 0.5, spread * 0.35);
      q.castShadow = true;
      this.tail.add(q);
    }
    this.hips.add(this.tail);

    // Wings pivot at the shoulder so flapping rotates them outward.
    this.wings = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(side * 0.17, 0.09, -0.01);
      const mesh = new THREE.Mesh(WING_GEO, accent);
      mesh.scale.set(0.28, 0.72, 1.05);
      mesh.position.set(side * 0.045, -0.09, -0.02);
      mesh.castShadow = true;
      w.add(mesh);
      w.userData.side = side;
      this.wings.push(w);
      this.hips.add(w);
    }

    // Neck pivot: rotation.x throws the head forward/down for pecking.
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.10, 0.18);
    this.hips.add(this.neck);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.17, 0.04);
    this.neck.add(this.head);

    const headMesh = new THREE.Mesh(HEAD_GEO, body);
    headMesh.castShadow = true;
    this.head.add(headMesh);

    const beak = new THREE.Mesh(BEAK_GEO, ORANGE);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, -0.005, 0.12);
    this.head.add(beak);

    const wattle = new THREE.Mesh(WATTLE_GEO, RED);
    wattle.position.set(0, -0.075, 0.085);
    this.head.add(wattle);

    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(COMB_GEO, RED);
      c.position.set(0, 0.095 - i * 0.008, 0.045 - i * 0.052);
      c.rotation.x = -0.25;
      this.head.add(c);
    }

    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(EYE_GEO, DARK);
      eye.position.set(side * 0.082, 0.02, 0.045);
      this.head.add(eye);
    }

    // Legs pivot at the hip; scaling the group folds them when sitting.
    this.legs = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.08, 0.30, 0.02);
      const bone = new THREE.Mesh(LEG_GEO, ORANGE);
      bone.position.y = -0.15;
      leg.add(bone);
      const foot = new THREE.Mesh(FOOT_GEO, ORANGE);
      foot.position.set(0, -0.30, 0.035);
      foot.castShadow = true;
      leg.add(foot);
      this.legs.push(leg);
      this.root.add(leg);
    }

    this.root.traverse((o) => { o.userData.chicken = this; });
  }

  get pos() { return this.root.position; }

  // ---- behavior plumbing -------------------------------------------------

  setNext() { pickBehavior(this, this.world); }
  force(name, data) { forceBehavior(this, this.world, name, data); }

  // ---- movement helpers used by behaviors --------------------------------

  walkTo(target, speed) {
    this.move = { target: target.clone ? target.clone() : new THREE.Vector3(target.x, 0, target.z), speed };
  }

  stop() { this.move = null; }

  arrived(dist = 0.18) {
    return !this.move || this.pos.distanceToSquared(this.move.target) < dist * dist;
  }

  facePoint(p, dt, rate = 5) {
    const yaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
    this.yaw = turnToward(this.yaw, yaw, rate, dt);
  }

  doPeck(height = 0) {
    if (this.peckT > 0.38) { this.peckT = 0; this.peckHeight = height; return true; }
    return false;
  }

  startHop(to, height, dur) {
    this.hop = { from: this.pos.clone(), to: to.clone(), t: 0, dur, height };
    this.move = null;
  }

  // Clears any perch/hop state so a forced behavior starts from the floor.
  comeDown() {
    if (this.perch) {
      this.perch = null;
      const down = this.pos.clone();
      down.y = 0;
      down.z += 0.55;
      this.startHop(down, 0.25, 0.5);
    }
    this.sitT = 0;
  }

  // ---- per-frame update --------------------------------------------------

  update(dt) {
    const w = this.world;

    // Behavior state machine.
    const b = this.bhv;
    b.t += dt;
    if (!b.def || b.t >= b.dur) this.setNext();
    else b.def.update?.(this, w, dt);

    // Ballistic hop (roost mounts, startles, jump scares).
    if (this.hop) {
      const h = this.hop;
      h.t = Math.min(h.t + dt, h.dur);
      const k = h.t / h.dur;
      this.pos.lerpVectors(h.from, h.to, k);
      this.pos.y += Math.sin(k * Math.PI) * h.height;
      this.flapT = Math.max(this.flapT, 0.8);
      if (h.t >= h.dur) { this.pos.copy(h.to); this.hop = null; }
    } else if (this.move && !this.frozen) {
      // Steer toward the target, walk forward, gentle separation from flockmates.
      const t = this.move.target;
      const dx = t.x - this.pos.x, dz = t.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.12) {
        this.move = null;
      } else {
        this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), 7, dt);
        const step = Math.min(this.move.speed * this.speedMul * dt, dist);
        let mx = Math.sin(this.yaw) * step, mz = Math.cos(this.yaw) * step;
        for (const other of w.chickens) {
          if (other === this || other.perch) continue;
          const ox = this.pos.x - other.pos.x, oz = this.pos.z - other.pos.z;
          const d2 = ox * ox + oz * oz;
          if (d2 > 0.001 && d2 < 0.35 * 0.35) {
            const d = Math.sqrt(d2);
            mx += (ox / d) * 0.5 * dt;
            mz += (oz / d) * 0.5 * dt;
          }
        }
        this.pos.x += mx;
        this.pos.z += mz;
        this.gait += this.move.speed * this.speedMul * dt * 9;
        this.gaitAmp = damp(this.gaitAmp, 1, 10, dt);
      }
    }
    if (!this.move && !this.hop) this.gaitAmp = damp(this.gaitAmp, 0, 8, dt);

    // Keep everyone inside the coop (hops and perches manage their own y).
    if (!this.perch && !this.hop) {
      this.pos.x = clamp(this.pos.x, -4.35, 4.35);
      this.pos.z = clamp(this.pos.z, -4.35, 4.35);
      if (this.pos.y > 0) this.pos.y = Math.max(0, this.pos.y - 3 * dt);
    }

    this.animate(dt);
  }

  animate(dt) {
    if (this.frozen) return; // statue mode: hold the exact pose

    this.root.rotation.y = this.yaw;

    // Smoothed animation channels.
    this.sit = damp(this.sit, this.sitT, 8, dt);
    this.flap = damp(this.flap, this.flapT, 10, dt);
    this.neckPitch = damp(this.neckPitch, this.neckPitchT, 10, dt);
    this.headTilt = damp(this.headTilt, this.headTiltT, 8, dt);
    this.headYaw = damp(this.headYaw, this.headYawT, 8, dt);

    // Peck: one quick dive of the neck, then recover.
    this.peckT += dt;
    let peck = 0;
    if (this.peckT < 0.34) {
      const k = this.peckT / 0.34;
      peck = Math.sin(Math.min(1, k * 1.35) * Math.PI);
    }

    const g = this.gait, amp = this.gaitAmp;
    const bounce = Math.abs(Math.sin(g)) * 0.035 * amp;
    const inAir = this.hop !== null;

    this.hips.position.y = lerp(0.32, 0.15, this.sit) + bounce + (inAir ? 0.05 : 0);
    this.hips.rotation.z = this.bodyRoll;
    this.hips.rotation.x = peck * 0.22 - this.flap * 0.1 - this.sit * 0.08;

    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const swing = Math.sin(g + i * Math.PI) * 0.55 * amp;
      leg.rotation.x = swing * (1 - this.sit);
      const fold = 1 - this.sit * 0.8;
      leg.scale.y = fold;
      leg.position.y = 0.30 * fold + lerp(0, -0.13, this.sit);
      leg.position.y += bounce;
    }

    // Classic chicken head-bob while walking, plus behavior-driven pose.
    const bob = Math.sin(g * 2) * 0.05 * amp;
    this.neck.position.z = 0.18 + bob;
    const peckPitch = peck * lerp(1.35, 0.55, this.peckHeight);
    this.neck.rotation.x = this.neckPitch + peckPitch + amp * 0.12;
    this.head.rotation.z = this.headTilt;
    this.head.rotation.y = this.headYaw;
    this.head.position.y = 0.17 - peck * lerp(0.10, 0.0, this.peckHeight);

    // Wings: resting tuck, spread + flutter when flapping.
    const flutter = Math.sin(this.world.time * 34 + this.gait) * this.flap;
    for (const wing of this.wings) {
      const side = wing.userData.side;
      wing.rotation.z = side * (0.1 + this.flap * 1.15 + flutter * 0.35);
    }

    // Idle tail wag, faster when excited.
    this.tail.rotation.y = Math.sin(this.world.time * 2.6 + this.yaw) * (0.12 + this.flap * 0.3);
    this.tail.rotation.x = this.sit * 0.35 - this.flap * 0.2;
  }
}

const NAMES = [
  'Henrietta', 'Nugget', 'Butternut', 'Kevin', 'Waffles', 'Gladys',
  'Sir Clucksalot', 'Omelette', 'Pickles', 'Dorothy', 'Meatball', 'Francine',
];

const PALETTES = [
  { body: 0xe8e2d4, accent: 0xd6ccb6 },  // white leghorn
  { body: 0x9c4f21, accent: 0x7a3a16 },  // rhode island red
  { body: 0xd99a45, accent: 0xb87c30 },  // buff orpington
  { body: 0x3a3f4a, accent: 0x2a2d35 },  // black australorp
  { body: 0x8d8d94, accent: 0x6e6e76 },  // barred rock
  { body: 0x8a6a4f, accent: 0x6d5138 },  // brown hen
  { body: 0xcbb79a, accent: 0xa8916f },  // cream
];

export function spawnFlock(world, count) {
  const names = [...NAMES];
  const flock = [];
  for (let i = 0; i < count; i++) {
    const ni = Math.floor(world.rng() * names.length);
    const name = names.splice(ni, 1)[0];
    const c = new Chicken(name, PALETTES[i % PALETTES.length], world);
    flock.push(c);
    world.scene.add(c.root);
  }
  return flock;
}
