import * as THREE from 'three';
import { clamp, damp, lerp, rand, turnToward, wrapAngle } from './util.js';
import { pickBehavior, forceBehavior } from './behaviors.js';
import { clampToZone } from './zones.js';

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
// Whatever she has caught, held in the beak. Currently only ever a mouse.
const CATCH_MAT = new THREE.MeshStandardMaterial({ color: 0x6b6259, flatShading: true, roughness: 0.9 });
const CATCH_TAIL = new THREE.MeshStandardMaterial({ color: 0xc99a95, flatShading: true, roughness: 0.8 });

function feathered(color) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 });
}

export class Chicken {
  constructor(name, palette, world, opts = {}) {
    this.name = name;
    this.world = world;
    this.color = palette.body;
    this.big = !!opts.big;
    this.chick = !!opts.chick;
    this.rooster = !!opts.rooster;
    this.scale = opts.scale ?? 1;
    this.table = this.big ? 'big' : (this.chick ? 'chick' : 'normal');
    this.rad = 0.3 * this.scale;
    // Chicks exist from the start but stay hidden until a hen hatches them,
    // so world.chickens never changes length and snapshots stay index-stable.
    this.active = !this.chick;
    this.mum = null;
    this.slot = 0;
    // Position in the pecking order; lower is higher-ranking. Assigned at
    // spawn and then genuinely fought over — a standoff can swap two ranks.
    this.rank = opts.rank ?? 99;
    this.rankOf = 1;                       // flock size; set once the flock exists
    this.heldBy = null;                    // actor id, while being carried
    this.holdPos = new THREE.Vector3();
    this.falling = false;                  // let go of, on the way down

    // Personality: how fast she moves and how weird she is willing to get.
    // Bertha is immense, so she is slow and takes long, heavy strides.
    this.speedMul = this.big ? 1 : (this.chick ? rand(world.rng, 1.25, 1.5) : rand(world.rng, 0.85, 1.2));
    this.weirdMul = this.big ? 1 : rand(world.rng, 0.6, 1.8);
    this.gaitRate = this.big ? 3.4 : (this.chick ? 17 : 9);   // tiny legs, high cadence
    this.strut = 0;            // extra chest-out swagger, roosters only

    this.yaw = rand(world.rng, -Math.PI, Math.PI);
    this.move = null;          // { target: Vector3, speed }
    this.hop = null;           // { from, to, t, dur, height }
    this.perch = null;         // roost reference while perched
    this.riding = null;        // chicken being stood on (Bertha)
    this.riders = [];          // chickens standing on this one
    this.zone = 'coop';        // 'coop' or 'yard'; maintained by clampToZone
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
    this.fall = 0; this.fallT = 0;         // knocked over onto her side
    this.legKick = 0;                      // legs bicycling while down
    this.bodyRoll = 0;         // driven directly by behaviors (dust bath, dizzy)
    this.peckT = 1e9;          // time since last peck started
    this.peckHeight = 0;       // 0 = ground, ~0.35 = feeder trough

    this.bhv = { name: null, def: null, t: 0, dur: 0, data: {}, lastName: null };
    this.cooldowns = {};
    this._inExit = false;      // running exit(): forced behaviors get parked
    this._pending = null;      // ...here, and installed by the transition
    this.wet = 0;              // 0 dry, 1 soaked; only rain fills it

    this.root = new THREE.Group();
    this.buildModel(palette);
    this.root.scale.setScalar(this.scale);
    // Height of her back while sitting: hips (0.15) + squashed body radius.
    this.rideHeight = 0.38 * this.scale;
    // Simulation position. The rendered root is interpolated toward it each
    // frame (see render), which is what lets the simulation run at a fixed
    // 30 Hz — a hard requirement for every client agreeing on the world —
    // while still looking smooth on a 120 Hz display.
    this.pos = new THREE.Vector3(rand(world.rng, -3, 3), 0, rand(world.rng, -2.5, 3));
    this.prevPos = this.pos.clone();
    this.prevYaw = this.yaw;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.root.visible = this.active;

    // Thought bubble. Lives in the scene rather than under root so it never
    // inherits the bird's tipping, spinning or squashing.
    this.emoteSprite = new THREE.Sprite(world.fx.emoteMats.dots);
    this.emoteSprite.visible = false;
    this.emoteSprite.renderOrder = 5;
    this.emoteScale = 0.44 * (1 + (this.scale - 1) * 0.3);
    world.scene.add(this.emoteSprite);
    this.emoteT = 0;
    this.emoteDur = 0;
  }

  // Show a thought bubble. This is the only way the game explains itself,
  // so behaviors declare an `icon` and it fires on entry.
  showEmote(icon, dur = 2.4) {
    const mat = this.world.fx.emoteMats[icon];
    if (!mat) return;
    this.emoteSprite.material = mat;
    this.emoteT = 0;
    this.emoteDur = dur;
    this.emoteSprite.visible = true;
  }

  updateEmote(dt) {
    const s = this.emoteSprite;
    if (!s.visible) return;
    this.emoteT += dt;
    const k = this.emoteT / this.emoteDur;
    if (k >= 1) { s.visible = false; return; }
    // Pop in, hold, shrink out. Placement happens in render(), against the
    // interpolated transform, so the bubble does not jitter at 30 Hz.
    const pop = k < 0.16 ? Math.sin((k / 0.16) * Math.PI * 0.5) * 1.14
      : k > 0.86 ? (1 - (k - 0.86) / 0.14) : 1;
    const sc = this.emoteScale * Math.max(0, pop);
    s.scale.set(sc, sc, sc);
  }

  buildModel(palette) {
    const big = this.big;
    const body = feathered(palette.body);
    const accent = feathered(palette.accent);

    // The rig carries the whole bird and can be tipped over on its side
    // without disturbing root.position, which stays the ground contact point.
    this.rig = new THREE.Group();
    this.root.add(this.rig);

    this.hips = new THREE.Group();
    this.hips.position.y = 0.32;
    this.rig.add(this.hips);

    const bodyMesh = new THREE.Mesh(BODY_GEO, body);
    // Bertha is not a bigger chicken so much as a rounder one.
    if (big) bodyMesh.scale.set(1.22, 1.08, 1.3);
    else if (this.chick) bodyMesh.scale.set(1.05, 1.0, 1.05); // a round fluffball
    else if (this.rooster) bodyMesh.scale.set(0.92, 0.95, 1.15); // upright, deep chest
    else bodyMesh.scale.set(0.95, 0.85, 1.2);
    bodyMesh.castShadow = true;
    this.hips.add(bodyMesh);

    // Tail: a fan of flat quills angled up and back. A chick's is a stub.
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.10, big ? -0.28 : -0.22);
    for (let i = 0; i < (this.chick ? 2 : (this.rooster ? 7 : 5)); i++) {
      const q = new THREE.Mesh(TAIL_GEO, i % 2 ? accent : body);
      if (this.rooster) {
        // Long sickle feathers arching up and over: the whole silhouette.
        const k = i / 6;
        q.scale.set(1.1, 1.5 + k * 1.2, 1.1);
        q.position.set((i - 3) * 0.035, 0.1 + k * 0.12, -0.02 - k * 0.06);
        q.rotation.set(-1.15 - k * 0.5, (i - 3) * 0.12, (i - 3) * 0.1);
      } else {
        const spread = (i - 2) * 0.16;
        q.position.set(spread * 0.22, 0.055, -0.03 - Math.abs(spread) * 0.05);
        q.rotation.set(-0.8 - Math.abs(spread) * 0.55, spread * 0.5, spread * 0.35);
      }
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

    if (!this.chick) {
      if (this.rooster) {
        // A pair of long wattles, one either side of the beak.
        for (const side of [-1, 1]) {
          const w2 = new THREE.Mesh(WATTLE_GEO, RED);
          w2.position.set(side * 0.03, -0.085, 0.075);
          w2.scale.set(1.1, 1.9, 1.1);
          this.head.add(w2);
        }
      } else {
        const wattle = new THREE.Mesh(WATTLE_GEO, RED);
        wattle.position.set(0, -0.075, 0.085);
        if (big) wattle.scale.set(1.7, 1.45, 1.6); // a magnificent wattle
        this.head.add(wattle);
      }
    }

    for (let i = 0; i < (this.chick ? 0 : (this.rooster ? 5 : 3)); i++) {
      const c = new THREE.Mesh(COMB_GEO, RED);
      if (this.rooster) {
        // Five tall points, tallest in the middle.
        const k = Math.sin((i / 4) * Math.PI);
        c.scale.set(1, 1.4 + k * 1.5, 1.1);
        c.position.set(0, 0.1 + k * 0.03, 0.06 - i * 0.036);
        c.rotation.x = -0.12;
        this.head.add(c);
        continue;
      }
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
      this.rig.add(leg);
    }

    this.root.traverse((o) => { o.userData.chicken = this; });
  }

  // ---- fixed-tick / render split -----------------------------------------

  // Called at the top of every simulation tick: the previous transform is the
  // near end of the interpolation the renderer draws between ticks.
  beginTick() {
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
  }

  // alpha is how far the current frame sits between the last two ticks.
  render(alpha) {
    if (!this.active) return;
    const p = this.root.position;
    p.lerpVectors(this.prevPos, this.pos, alpha);
    this.root.rotation.y = this.prevYaw + wrapAngle(this.yaw - this.prevYaw) * alpha;
    const s = this.emoteSprite;
    if (s.visible) {
      s.position.set(
        p.x,
        p.y + 0.86 * this.scale + 0.26 + Math.sin(this.world.time * 2.4) * 0.02,
        p.z);
    }
  }

  // How high she holds herself, 1 at the top of the pecking order down to 0 at
  // the bottom. Bertha and the chicks are outside the order and stand normally.
  get standing() {
    if (this.big || this.chick || this.rank > this.rankOf) return 0;
    return 1 - (this.rank - 1) / Math.max(1, this.rankOf - 1);
  }

  // Something in her beak. Built the first time it is needed and then kept,
  // since the same hen tends to be the one who catches things.
  showCatch(on) {
    if (!this.catchMesh) {
      if (!on) return;
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), CATCH_MAT);
      m.scale.set(0.8, 0.7, 1.5);
      m.position.set(0, -0.03, 0.2);
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.003, 0.16, 4), CATCH_TAIL);
      tail.rotation.x = Math.PI / 2;
      tail.position.set(0, 0.01, -0.13);
      m.add(tail);
      this.head.add(m);
      this.catchMesh = m;
    }
    this.catchMesh.visible = on;
  }

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

  // Called when a hen hatches this chick.
  hatchAt(mum, slot, at, rng) {
    this.active = true;
    this.root.visible = true;
    this.mum = mum;
    this.slot = slot;
    this.pos.set(at.x + rand(rng, -0.3, 0.3), 0, at.z + rand(rng, 0.15, 0.55));
    this.prevPos.copy(this.pos);
    this.root.position.copy(this.pos);
    this.zone = 'coop';
    this.force('followMum');
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
    if (!this.active) return;
    const w = this.world;
    this.updateEmote(dt); // runs even while frozen, so statues can still think

    // Behavior state machine.
    const b = this.bhv;
    b.t += dt;
    if (!b.def || b.t >= b.dur) this.setNext();
    else b.def.update?.(this, w, dt);

    // Being carried: position comes from HOLD events, nothing else applies.
    if (this.heldBy) {
      this.prevPos.copy(this.pos);
      this.pos.copy(this.holdPos);
      this.animate(dt);
      return;
    }

    if (this.falling) {
      this.pos.y -= 5.5 * dt;
      if (this.pos.y <= 0) {
        this.pos.y = 0;
        this.falling = false;
        w.audio.bonk();
        w.fx.puff(this.pos, 0x9a7f5c);
        for (let i = 0; i < 3; i++) w.fx.feather(this.pos, this.color);
      }
      this.animate(dt);
      return;
    }

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
        // Chicks are exempt from crowd separation in both directions: they
        // scurry between everyone's feet, and letting them shove meant a
        // brood arriving at the pop-hole together pushed each other out of
        // the opening and none of them could get through it.
        for (const other of w.chickens) {
          if (other === this || other.perch || other.riding) continue;
          if (other.chick || this.chick || !other.active) continue;
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

    // Keep everyone inside whichever enclosure they are in (hops and perches
    // manage their own y). This also updates c.zone.
    if (!this.perch && !this.hop) {
      const wasX = this.pos.x, wasZ = this.pos.z;
      clampToZone(this, w);
      const hitWall = this.pos.x !== wasX || this.pos.z !== wasZ;
      if (this.pos.y > 0) this.pos.y = Math.max(0, this.pos.y - 3 * dt);

      // Running flat out into a wall is a bonk, not a gentle stop. The
      // cooldown stops a chicken pinned against a wall bonking every frame.
      this._wallCool = Math.max(0, (this._wallCool ?? 0) - dt);
      if (hitWall && !this.big && this._wallCool <= 0 && this.bhv.name !== 'bonk'
          && this.move && this.move.speed > 1.7) {
        this._wallCool = 3;
        this.force('bonk', { wall: true });
      }
    }

    this.animate(dt);
  }

  animate(dt) {
    if (this.frozen) return; // statue mode: hold the exact pose

    // Smoothed animation channels. These run inside the fixed tick, not at
    // render rate, because behaviors read some of them back (c.sit gates
    // whether anyone may ride Bertha) and a render-rate value would make
    // that decision depend on the viewer's framerate.
    this.sit = damp(this.sit, this.sitT, 8, dt);
    this.flap = damp(this.flap, this.flapT, 10, dt);
    this.neckPitch = damp(this.neckPitch, this.neckPitchT, 10, dt);
    this.headTilt = damp(this.headTilt, this.headTiltT, 8, dt);
    this.headYaw = damp(this.headYaw, this.headYawT, 8, dt);
    this.lid = damp(this.lid, this.lidT, 6, dt);
    this.legTuck = damp(this.legTuck, this.legTuckT, 6, dt);
    this.fall = damp(this.fall, this.fallT, 9, dt);

    // Tipped over: roll the whole rig onto its side and lift it so the body
    // rests on the floor instead of sinking through it.
    this.rig.rotation.z = this.fall * 1.45;
    this.rig.position.y = this.fall * 0.30;

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

    // Standing: a bird high in the pecking order carries herself taller than
    // one at the bottom. Small, but over a flock of eight it is the difference
    // between a crowd and a hierarchy — and it updates when a rank changes
    // hands, so an upset is visible afterwards, not just at the moment.
    this.hips.position.y = lerp(0.32, 0.15, this.sit) + bounce + (inAir ? 0.05 : 0)
      + this.strut * 0.05 + this.standing * 0.035;
    // A strutting rooster carries his chest high and his head back.
    if (this.rooster) this.hips.rotation.x = (this.hips.rotation.x ?? 0) - this.strut * 0.12;
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
      const kick = this.legKick * Math.sin(this.world.time * 13 + i * 2.2) * 0.8;
      leg.rotation.x = swing * (1 - this.sit) - tuck * 0.9 + kick;
      const fold = (1 - this.sit * 0.8) * (1 - tuck * 0.55);
      leg.scale.y = fold;
      leg.position.y = 0.30 * fold + lerp(0, -0.13, this.sit);
      leg.position.y += bounce;
    }

    // Classic chicken head-bob while walking, plus behavior-driven pose.
    const bob = Math.sin(g * 2) * 0.05 * amp;
    this.neck.position.z = (this.big ? 0.22 : 0.18) + bob;
    const peckPitch = peck * lerp(1.35, 0.55, this.peckHeight);
    this.neck.rotation.x = this.neckPitch + peckPitch + amp * 0.12 - this.standing * 0.14;
    this.head.rotation.z = this.headTilt;
    this.head.rotation.y = this.headYaw;
    this.head.position.y = (this.big ? 0.14 : 0.17) - peck * lerp(0.10, 0.0, this.peckHeight);

    // Eyelids: squashing the eye reads as a droop at this poly count.
    if (this.lid > 0.001 || this.big) {
      for (const eye of this.eyes) eye.scale.y = Math.max(0.08, (this.big ? 1.2 : 1) * (1 - this.lid * 0.92));
      for (const brow of this.brows) brow.position.y = 0.062 - this.lid * 0.05;
    }

    // Wings: resting tuck, spread + flutter when flapping. A bird on her side
    // splays both wings — tucked, the upper one reads as a detached blob.
    const flutter = Math.sin(this.world.time * 34 + this.gait) * this.flap;
    const splay = this.fall * (0.5 + Math.sin(this.world.time * 9) * 0.12);
    for (const wing of this.wings) {
      const side = wing.userData.side;
      wing.rotation.z = side * (0.1 + this.flap * 1.15 + flutter * 0.35 + splay);
    }

    // Idle tail wag, faster when excited. A soaked chicken's tail hangs, and
    // the wag goes out of it — the cheapest possible "bedraggled".
    const dry = 1 - this.wet;
    this.tail.rotation.y = Math.sin(this.world.time * 2.6 + this.yaw)
      * (0.12 + this.flap * 0.3) * dry;
    this.tail.rotation.x = this.sit * 0.35 - this.flap * 0.2 + this.wet * 0.55;
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
    const c = new Chicken(name, PALETTES[i % PALETTES.length], world, { rank: i + 2 });
    flock.push(c);
    world.scene.add(c.root);
  }
  return flock;
}

// The rooster: taller than the hens, mostly tail and comb, and convinced the
// coop would fall apart without him.
export function spawnRooster(world) {
  const r = new Chicken('Reginald',
    { body: 0x2b3a44, accent: 0xb0641e }, world, { rooster: true, scale: 1.26, rank: 1 });
  r.pos.set(1.4, 0, 1.2);
  r.prevPos.copy(r.pos);
  r.root.position.copy(r.pos);
  world.scene.add(r.root);
  return r;
}

// A brood, created hidden at startup and revealed when a hen hatches them.
// Keeping the population fixed means world.chickens is index-stable, which
// snapshots and the determinism fingerprint both rely on.
export function spawnChicks(world, count) {
  const chicks = [];
  for (let i = 0; i < count; i++) {
    const k = new Chicken(`Chick ${i + 1}`,
      { body: 0xf5dc90, accent: 0xe3c264 }, world, { chick: true, scale: 0.42 });
    chicks.push(k);
    world.scene.add(k.root);
  }
  return chicks;
}

// The matriarch. Twice the size, a third the speed, asleep by default, and
// the single most disruptive object in the building when she isn't.
export function spawnBertha(world) {
  const bertha = new Chicken('Big Bertha',
    { body: 0xb8763a, accent: 0x8e5726 }, world, { big: true, scale: 2.05, rank: 0 });
  bertha.pos.set(-2.4, 0, -2.5);
  bertha.prevPos.copy(bertha.pos);
  bertha.root.position.copy(bertha.pos);
  bertha.sit = bertha.sitT = 1;
  world.scene.add(bertha.root);
  return bertha;
}
