import * as THREE from 'three';
import { clamp, damp, lerp, rand, turnToward, TAU } from './util.js';
import { pickBehavior, forceBehavior } from './behaviors.js';

// Chickens are built facing +Z: forward = (sin yaw, 0, cos yaw).
// A chicken's size is one root scale factor; everything below is authored at
// scale 1 and Big Bertha just runs the same rig scaled up and slowed down.

const BODY_GEO = new THREE.SphereGeometry(0.22, 10, 8);
const HEAD_GEO = new THREE.SphereGeometry(0.10, 9, 7);
const BEAK_GEO = new THREE.ConeGeometry(0.035, 0.09, 5);
const EYE_GEO = new THREE.SphereGeometry(0.02, 6, 5);
const BROW_GEO = new THREE.BoxGeometry(0.062, 0.026, 0.05);
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
  constructor(name, palette, world, opts = {}) {
    this.name = name;
    this.world = world;
    this.color = palette.body;
    this.big = !!opts.big;
    this.scale = opts.scale ?? 1;
    this.table = this.big ? 'big' : 'normal';
    this.rad = 0.3 * this.scale;

    // Personality: how fast she moves and how weird she is willing to get.
    // Bertha is immense, so she is slow and takes long, heavy strides.
    this.speedMul = this.big ? 1 : rand(world.rng, 0.85, 1.2);
    this.weirdMul = this.big ? 1 : rand(world.rng, 0.6, 1.8);
    this.gaitRate = this.big ? 3.4 : 9;

    this.yaw = rand(world.rng, -Math.PI, Math.PI);
    this.move = null;          // { target: Vector3, speed }
    this.hop = null;           // { from, to, t, dur, height }
    this.perch = null;         // roost reference while perched
    this.riding = null;        // chicken being stood on (Bertha)
    this.riders = [];          // chickens standing on this one
    this.frozen = false;       // statue mode: skip all animation

    this.gait = 0;             // leg phase
    this.gaitAmp = 0;          // 0 = standing, 1 = walking
    this.stepSign = 0;         // for footfall detection
    this.sit = 0; this.sitT = 0;           // squat amount (target / current)
    this.flap = 0; this.flapT = 0;         // wing spread
    this.neckPitch = 0; this.neckPitchT = 0;
    this.headTilt = 0; this.headTiltT = 0;
    this.headYaw = 0; this.headYawT = 0;
    this.lid = this.big ? 0.85 : 0;        // eyelid droop
    this.lidT = this.lid;
    this.legTuck = 0; this.legTuckT = 0;   // one-legged standing
    this.bodyRoll = 0;         // driven directly by behaviors (dust bath, dizzy)
    this.peckT = 1e9;          // time since last peck started
    this.peckHeight = 0;       // 0 = ground, ~0.35 = feeder trough

    this.bhv = { name: null, def: null, t: 0, dur: 0, data: {}, lastName: null };
    this.cooldowns = {};

    this.root = new THREE.Group();
    this.buildModel(palette);
    this.root.scale.setScalar(this.scale);
    // Height of her back while sitting: hips (0.15) + squashed body radius.
    this.rideHeight = 0.38 * this.scale;
    this.root.position.set(rand(world.rng, -3, 3), 0, rand(world.rng, -2.5, 3));
    this.root.rotation.y = this.yaw;
  }

  buildModel(palette) {
    const big = this.big;
    const body = feathered(palette.body);
    const accent = feathered(palette.accent);

    this.hips = new THREE.Group();
    this.hips.position.y = 0.32;
    this.root.add(this.hips);

    const bodyMesh = new THREE.Mesh(BODY_GEO, body);
    // Bertha is not a bigger chicken so much as a rounder one.
    if (big) bodyMesh.scale.set(1.22, 1.08, 1.3);
    else bodyMesh.scale.set(0.95, 0.85, 1.2);
    bodyMesh.castShadow = true;
    this.hips.add(bodyMesh);

    // Tail: a fan of flat quills angled up and back.
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.10, big ? -0.28 : -0.22);
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
      w.position.set(side * (big ? 0.22 : 0.17), 0.09, -0.01);
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
    this.neck.position.set(0, 0.10, big ? 0.22 : 0.18);
    this.hips.add(this.neck);

    this.head = new THREE.Group();
    this.head.position.set(0, big ? 0.14 : 0.17, 0.04);
    this.neck.add(this.head);

    const headMesh = new THREE.Mesh(HEAD_GEO, body);
    if (big) headMesh.scale.setScalar(1.15);
    headMesh.castShadow = true;
    this.head.add(headMesh);

    const beak = new THREE.Mesh(BEAK_GEO, ORANGE);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, -0.005, big ? 0.135 : 0.12);
    this.head.add(beak);

    const wattle = new THREE.Mesh(WATTLE_GEO, RED);
    wattle.position.set(0, -0.075, 0.085);
    if (big) wattle.scale.set(1.7, 1.45, 1.6); // a magnificent wattle
    this.head.add(wattle);

    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(COMB_GEO, RED);
      c.position.set(0, 0.095 - i * 0.008, 0.045 - i * 0.052);
      c.rotation.x = -0.25;
      // Bertha's comb has long since flopped over to one side.
      if (big) { c.rotation.z = 0.75; c.position.x = -0.03 - i * 0.004; c.scale.setScalar(1.2); }
      this.head.add(c);
    }

    this.eyes = [];
    this.brows = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(EYE_GEO, DARK);
      eye.position.set(side * 0.082, 0.02, 0.045);
      if (big) eye.scale.setScalar(1.2);
      this.head.add(eye);
      this.eyes.push(eye);
      if (big) {
        // Heavy brows: they ride down over the eye as the lid closes.
        const brow = new THREE.Mesh(BROW_GEO, body);
        brow.position.set(side * 0.085, 0.062, 0.05);
        brow.rotation.z = side * -0.2;
        this.head.add(brow);
        this.brows.push(brow);
      }
    }

    // Legs pivot at the hip; scaling the group folds them when sitting.
    this.legs = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * (big ? 0.11 : 0.08), 0.30, 0.02);
      const bone = new THREE.Mesh(LEG_GEO, ORANGE);
      bone.position.y = -0.15;
      if (big) bone.scale.set(1.7, 1, 1.7); // stout drumsticks
      leg.add(bone);
      const foot = new THREE.Mesh(FOOT_GEO, ORANGE);
      foot.position.set(0, -0.30, 0.035);
      if (big) foot.scale.set(1.4, 1.4, 1.4);
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

  // ---- riding (standing on Big Bertha) -----------------------------------

  mount(host, offset) {
    this.riding = host;
    this.rideOffset = offset;
    host.riders.push(this);
  }

  dismount() {
    const h = this.riding;
    if (!h) return;
    this.riding = null;
    h.riders = h.riders.filter((r) => r !== this);
    const away = new THREE.Vector3(this.pos.x - h.pos.x, 0, this.pos.z - h.pos.z);
    if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    away.normalize().multiplyScalar(1.5).add(this.pos);
    away.y = 0;
    away.x = clamp(away.x, -4.2, 4.2);
    away.z = clamp(away.z, -4.2, 4.2);
    this.startHop(away, 0.55, 0.7);
  }

  // Throws off every passenger — Bertha standing up is not a gentle event.
  buckOff() {
    for (const r of [...this.riders]) {
      r.dismount();
      r.force('panic', { short: true });
    }
  }

  // Clears perch/ride state so a forced behavior starts from the floor.
  comeDown() {
    if (this.perch) {
      this.perch = null;
      const down = this.pos.clone();
      down.y = 0;
      down.z += 0.55;
      this.startHop(down, 0.25, 0.5);
    }
    if (this.riding) this.dismount();
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

    if (this.riding && this.riding.sit < 0.4) {
      // Invariant: nobody stays aboard a host who has stood up, whatever
      // the behavior driving them thinks is happening.
      this.dismount();
    }

    if (this.riding) {
      // Glued to the host's back, rotating with her.
      const h = this.riding;
      const s = Math.sin(h.yaw), c = Math.cos(h.yaw);
      const o = this.rideOffset;
      this.pos.set(
        h.pos.x + o.x * c + o.z * s,
        h.pos.y + h.rideHeight,
        h.pos.z - o.x * s + o.z * c);
      this.animate(dt);
      return;
    }

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
        this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), this.big ? 2.2 : 7, dt);
        const step = Math.min(this.move.speed * this.speedMul * dt, dist);
        let mx = Math.sin(this.yaw) * step, mz = Math.cos(this.yaw) * step;
        for (const other of w.chickens) {
          if (other === this || other.perch || other.riding) continue;
          const minD = this.rad + other.rad;
          const ox = this.pos.x - other.pos.x, oz = this.pos.z - other.pos.z;
          const d2 = ox * ox + oz * oz;
          if (d2 > 0.001 && d2 < minD * minD) {
            // Mass matters: Bertha shoves, and is barely nudged in return.
            const push = other.big && !this.big ? 2.2 : (this.big ? 0.12 : 0.5);
            const d = Math.sqrt(d2);
            mx += (ox / d) * push * dt;
            mz += (oz / d) * push * dt;
          }
        }
        this.pos.x += mx;
        this.pos.z += mz;
        this.gait += this.move.speed * this.speedMul * dt * this.gaitRate;
        this.gaitAmp = damp(this.gaitAmp, 1, 10, dt);
      }
    }
    if (!this.move && !this.hop) this.gaitAmp = damp(this.gaitAmp, 0, 8, dt);

    // Heavy footfalls shake the coop.
    if (this.big && this.gaitAmp > 0.3 && !this.hop) {
      const s = Math.sin(this.gait);
      if (this.stepSign > 0 && s <= 0) w.thud?.(this);
      this.stepSign = s;
    }

    // Keep everyone inside the coop (hops and perches manage their own y).
    if (!this.perch && !this.hop) {
      const lim = 4.35 - (this.rad - 0.3);
      this.pos.x = clamp(this.pos.x, -lim, lim);
      this.pos.z = clamp(this.pos.z, -lim, lim);
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
    this.lid = damp(this.lid, this.lidT, 6, dt);
    this.legTuck = damp(this.legTuck, this.legTuckT, 6, dt);

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

    // Bertha breathes, hugely, and it is audible in the silhouette.
    if (this.big) {
      const breath = Math.sin(this.world.time * 1.15) * 0.03 * (0.35 + this.sit * 0.65);
      this.hips.scale.set(1 + breath, 1 + breath * 0.7, 1 + breath);
    }

    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const swing = Math.sin(g + i * Math.PI) * 0.55 * amp;
      // legTuck folds the right leg up under the body (one-legged standing).
      const tuck = i === 1 ? this.legTuck : 0;
      leg.rotation.x = swing * (1 - this.sit) - tuck * 0.9;
      const fold = (1 - this.sit * 0.8) * (1 - tuck * 0.55);
      leg.scale.y = fold;
      leg.position.y = 0.30 * fold + lerp(0, -0.13, this.sit);
      leg.position.y += bounce;
    }

    // Classic chicken head-bob while walking, plus behavior-driven pose.
    const bob = Math.sin(g * 2) * 0.05 * amp;
    this.neck.position.z = (this.big ? 0.22 : 0.18) + bob;
    const peckPitch = peck * lerp(1.35, 0.55, this.peckHeight);
    this.neck.rotation.x = this.neckPitch + peckPitch + amp * 0.12;
    this.head.rotation.z = this.headTilt;
    this.head.rotation.y = this.headYaw;
    this.head.position.y = (this.big ? 0.14 : 0.17) - peck * lerp(0.10, 0.0, this.peckHeight);

    // Eyelids: squashing the eye reads as a droop at this poly count.
    if (this.lid > 0.001 || this.big) {
      for (const eye of this.eyes) eye.scale.y = Math.max(0.08, (this.big ? 1.2 : 1) * (1 - this.lid * 0.92));
      for (const brow of this.brows) brow.position.y = 0.062 - this.lid * 0.05;
    }

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

// The matriarch. Twice the size, a third the speed, asleep by default, and
// the single most disruptive object in the building when she isn't.
export function spawnBertha(world) {
  const bertha = new Chicken('Big Bertha',
    { body: 0xb8763a, accent: 0x8e5726 }, world, { big: true, scale: 2.05 });
  bertha.pos.set(-2.4, 0, -2.5);
  bertha.sit = bertha.sitT = 1;
  world.scene.add(bertha.root);
  return bertha;
}
