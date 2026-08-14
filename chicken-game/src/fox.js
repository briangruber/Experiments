import * as THREE from 'three';
import { clamp, damp, rand, turnToward, wrapAngle } from './util.js';
import { DOOR, YARD, COOP } from './zones.js';

// The fox. Comes at night, and what it gets depends entirely on whether the
// pop-hole was shut in time.
//
//   door open  — it walks straight in, takes an egg if there is one, and the
//                whole coop comes apart
//   door shut  — it prowls the run, menaces anyone who was left outside, and
//                leaves empty-handed
//
// Nothing dies. It steals eggs and ruins everyone's night, which is enough.

const RUSSET = new THREE.MeshStandardMaterial({ color: 0xb85c26, flatShading: true, roughness: 0.9 });
const PALE = new THREE.MeshStandardMaterial({ color: 0xe8dccb, flatShading: true, roughness: 0.9 });
const SOOT = new THREE.MeshStandardMaterial({ color: 0x241a14, flatShading: true, roughness: 0.7 });
const EYE = new THREE.MeshStandardMaterial({ color: 0xf5d76a, flatShading: true, roughness: 0.4 });

export const FOX_PHASES = ['arrive', 'prowl', 'enter', 'hunt', 'leave'];

export class Fox {
  constructor(world) {
    this.world = world;
    this.root = new THREE.Group();
    this.build();
    world.scene.add(this.root);

    // Comes in over the back fence, from whichever side.
    const rng = world.rng;
    this.pos = new THREE.Vector3(rand(rng, YARD.x0 + 1, YARD.x1 - 1), 0, YARD.z1 + 1.9);
    this.prevPos = this.pos.clone();
    this.yaw = Math.PI;
    this.prevYaw = this.yaw;
    this.root.position.copy(this.pos);

    this.phase = 'arrive';
    this.t = 0;
    this.life = 0;
    this.target = new THREE.Vector3(this.pos.x, 0, YARD.z1 - 1.2);
    this.carrying = null;     // an egg, once it has one
    this.crossing = false;
    this.gait = 0;
    this.done = false;        // ready to be removed
    this.scared = 0;          // how hard it is currently backing off
  }

  build() {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 9, 7), RUSSET);
    body.scale.set(0.78, 0.72, 1.6);
    body.position.y = 0.34;
    body.castShadow = true;
    this.root.add(body);

    // Chest and belly in pale fur.
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), PALE);
    belly.scale.set(0.7, 0.45, 1.35);
    belly.position.set(0, 0.24, 0.02);
    this.root.add(belly);

    // Head: a wedge with a long snout, which is the whole silhouette.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.44, 0.3);
    this.root.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), RUSSET);
    skull.scale.set(0.82, 0.82, 0.95);
    skull.castShadow = true;
    this.head.add(skull);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 5), RUSSET);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -0.025, 0.17);
    this.head.add(snout);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.028, 5, 4), SOOT);
    nose.position.set(0, -0.025, 0.29);
    this.head.add(nose);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.15, 4), RUSSET);
      ear.position.set(side * 0.075, 0.14, -0.01);
      ear.rotation.z = side * 0.22;
      ear.castShadow = true;
      this.head.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 5, 4), EYE);
      eye.position.set(side * 0.072, 0.028, 0.085);
      this.head.add(eye);
    }

    // The tail is most of what reads at a distance.
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.36, -0.32);
    this.root.add(this.tail);
    const brush = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), RUSSET);
    brush.scale.set(0.85, 0.85, 1.9);
    brush.position.z = -0.2;
    brush.castShadow = true;
    this.tail.add(brush);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.085, 7, 5), PALE);
    tip.position.z = -0.4;
    this.tail.add(tip);

    this.legs = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(sx * 0.11, 0.28, sz * 0.2);
        const shin = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.28, 0.055), SOOT);
        shin.position.y = -0.14;
        shin.castShadow = true;
        leg.add(shin);
        leg.userData.phase = (sx * sz > 0) ? 0 : Math.PI;
        this.legs.push(leg);
        this.root.add(leg);
      }
    }

    // Held in the jaws on the way out.
    this.eggMesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.55 }));
    this.eggMesh.scale.set(0.82, 1, 0.82);
    this.eggMesh.position.set(0, -0.06, 0.3);
    this.eggMesh.visible = false;
    this.head.add(this.eggMesh);
  }

  get inCoop() { return this.pos.z < 5; }

  // Straight-line steering, same as the chickens use.
  moveToward(target, speed, dt) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return true;
    this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), 4.5, dt);
    const step = Math.min(speed * dt, dist);
    this.pos.x += Math.sin(this.yaw) * step;
    this.pos.z += Math.cos(this.yaw) * step;
    this.gait += step * 7;
    return dist < 0.35;
  }

  // Keep it out of the walls. It may roam beyond the fence while arriving and
  // leaving, which is how it gets in and out.
  containment() {
    const p = this.pos;
    if (p.z < DOOR.band.z0) {
      p.x = clamp(p.x, COOP.x0, COOP.x1);
      p.z = clamp(p.z, COOP.z0, DOOR.band.z1);
    } else if (p.z <= DOOR.band.z1) {
      p.x = clamp(p.x, DOOR.x - DOOR.halfWidth + 0.05, DOOR.x + DOOR.halfWidth - 0.05);
    } else {
      p.x = clamp(p.x, YARD.x0 - 1.5, YARD.x1 + 1.5);
      p.z = clamp(p.z, DOOR.band.z1, YARD.z1 + 3);
    }
  }

  // Everyone who can see it wants to be somewhere else.
  terrorize(w, dt, radius) {
    for (const c of w.chickens) {
      if (!c.active || c.big) continue;
      if (c.rooster) continue;          // he does not run; see guardFox
      if (c.zone !== (this.inCoop ? 'coop' : 'yard')) continue;
      if (c.pos.distanceTo(this.pos) > radius) continue;
      if (c.bhv.name === 'flee' || c.bhv.name === 'foxFlee') continue;
      if (w.rng() < dt * 3.5) {
        c.force('foxFlee', { from: this });
        if (w.rng() < 0.4) w.audio.squawk(rand(w.rng, 0.8, 1.5));
      }
    }
  }

  update(dt) {
    const w = this.world;
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.t += dt;
    this.life += dt;
    this.scared = Math.max(0, this.scared - dt);

    // A hen with chicks will see it off, and so will a shout from the viewer.
    if (this.scared > 0 && this.phase !== 'leave') this.setPhase('leave');
    // It never lingers.
    if (this.life > 52 && this.phase !== 'leave') this.setPhase('leave');

    switch (this.phase) {
      case 'arrive': {
        if (this.moveToward(this.target, 1.5, dt)) {
          this.setPhase(w.door.open ? 'enter' : 'prowl');
        }
        break;
      }

      case 'prowl': {
        // Door shut. Work the run instead, and hope somebody was left out.
        this.terrorize(w, dt, 4.5);
        const victim = this.nearestChicken(w, 'yard');
        const aim = victim ? victim.pos : this.target;
        this.moveToward(aim, 1.9, dt);
        if (!victim && this.moveToward(this.target, 1.9, dt) && w.rng() < dt * 0.6) {
          this.target.set(rand(w.rng, YARD.x0 + 1, YARD.x1 - 1), 0, rand(w.rng, 6.5, YARD.z1 - 0.6));
        }
        // If someone opens the door mid-prowl, it takes the invitation.
        if (w.door.open && this.t > 3) this.setPhase('enter');
        if (this.t > 22) this.setPhase('leave');
        break;
      }

      case 'enter': {
        if (!w.door.open) { this.setPhase('prowl'); break; }
        this.terrorize(w, dt, 4);
        const stage = this.inCoop ? DOOR_IN : DOOR_OUT;
        const beyond = this.inCoop ? DOOR_OUT : DOOR_IN;
        if (!this.crossing && this.pos.distanceTo(stage) < 0.6) this.crossing = true;
        this.moveToward(this.crossing ? beyond : stage, 1.8, dt);
        if (this.inCoop) this.setPhase('hunt');
        break;
      }

      case 'hunt': {
        this.terrorize(w, dt, 6);
        const egg = w.eggs[0];
        if (egg) {
          const at = new THREE.Vector3(egg.position.x, 0, egg.position.z);
          if (this.moveToward(at, 2.1, dt)) {
            w.removeEgg(egg);
            this.carrying = true;
            this.eggMesh.visible = true;
            w.audio.pop();
            // Somebody left the door open, and here is the consequence.
            w.director?.beat('foxTookEgg', this.nearestChicken(w, 'coop'));
            this.setPhase('leave');
          }
        } else {
          // No eggs. Chase whoever is nearest until it gets bored.
          const victim = this.nearestChicken(w, 'coop');
          if (victim) this.moveToward(victim.pos, 2.2, dt);
          if (this.t > 14) this.setPhase('leave');
        }
        break;
      }

      case 'leave': {
        // Out through the door if it is inside, then away over the fence.
        if (this.inCoop) {
          if (!w.door.open) {
            // Shut in. It panics in the corner until someone opens up.
            this.terrorize(w, dt, 6);
            this.moveToward(DOOR_IN, 1.6, dt);
            break;
          }
          const stage = DOOR_IN, beyond = DOOR_OUT;
          if (!this.leaving && this.pos.distanceTo(stage) < 0.6) this.leaving = true;
          this.moveToward(this.leaving ? beyond : stage, 2.4, dt);
        } else {
          this.moveToward(new THREE.Vector3(this.pos.x, 0, YARD.z1 + 3), 2.6, dt);
          if (this.pos.z > YARD.z1 + 2.6) this.done = true;
        }
        break;
      }
    }

    this.containment();
    this.animate(dt);
  }

  setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    this.t = 0;
    this.crossing = false;
    this.leaving = false;
  }

  nearestChicken(w, zone) {
    let best = null, bestD = 7;
    for (const c of w.chickens) {
      if (!c.active || c.big || c.zone !== zone) continue;
      const d = c.pos.distanceTo(this.pos);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  animate(dt) {
    const trot = Math.sin(this.gait);
    for (const leg of this.legs) {
      leg.rotation.x = Math.sin(this.gait + leg.userData.phase) * 0.6;
    }
    this.root.position.y = Math.abs(trot) * 0.02;
    // Low and slinking, tail streaming behind.
    this.tail.rotation.y = Math.sin(this.world.time * 3.4) * 0.28;
    this.tail.rotation.x = -0.25 + Math.sin(this.world.time * 2.1) * 0.1;
    this.head.rotation.x = this.carrying ? 0.18 : Math.sin(this.world.time * 1.6) * 0.06;
  }

  render(alpha) {
    this.root.position.x = this.prevPos.x + (this.pos.x - this.prevPos.x) * alpha;
    this.root.position.z = this.prevPos.z + (this.pos.z - this.prevPos.z) * alpha;
    this.root.rotation.y = this.prevYaw + wrapAngle(this.yaw - this.prevYaw) * alpha;
  }

  dispose() {
    this.world.scene.remove(this.root);
  }
}

const DOOR_IN = new THREE.Vector3(DOOR.inside.x, 0, DOOR.inside.z);
const DOOR_OUT = new THREE.Vector3(DOOR.outside.x, 0, DOOR.outside.z);
