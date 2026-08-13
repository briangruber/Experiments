import * as THREE from 'three';
import { clamp, rand, turnToward, wrapAngle } from './util.js';
import { COOP } from './zones.js';

// A mouse, in it for the spilled grain under the feeder.
//
// It is not a predator and nothing bad happens if it gets away — it is here
// because chickens are dinosaurs and a flock that spots one stops being a
// flock. The comedy is entirely in the reaction: eight birds who were dozing
// a second ago, converging at a dead sprint on something the size of a plum.
//
// It moves in darts and freezes between them, which is both how a real mouse
// moves and what gives the chickens a chance.

const FUR = new THREE.MeshStandardMaterial({ color: 0x6b6259, flatShading: true, roughness: 0.9 });
const PINK = new THREE.MeshStandardMaterial({ color: 0xc99a95, flatShading: true, roughness: 0.8 });
const BEAD = new THREE.MeshStandardMaterial({ color: 0x14100e, roughness: 0.3 });

export class Mouse {
  constructor(world) {
    this.world = world;
    this.root = new THREE.Group();
    this.build();
    world.scene.add(this.root);

    const rng = world.rng;
    // In under the skirting board, from whichever back corner.
    const side = rng() < 0.5 ? -1 : 1;
    this.pos = new THREE.Vector3(side * (COOP.x1 - 0.12), 0, COOP.z0 + rand(rng, 0.1, 0.9));
    this.prevPos = this.pos.clone();
    this.yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    this.prevYaw = this.yaw;
    this.root.position.copy(this.pos);

    this.phase = 'sneak';
    this.t = 0;
    this.life = 0;
    this.dart = 0;             // >0 while sprinting, <=0 while frozen
    this.target = world.coop.feeder.clone();
    this.done = false;
    this.caught = false;
    this.gait = 0;
    this.spotted = false;
  }

  build() {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 7, 5), FUR);
    body.scale.set(0.85, 0.8, 1.4);
    body.position.y = 0.075;
    body.castShadow = true;
    this.root.add(body);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.08, 0.1);
    this.root.add(this.head);
    const skull = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 5), FUR);
    skull.rotation.x = Math.PI / 2;
    this.head.add(skull);
    for (const s of [-1, 1]) {
      // The ears are most of the silhouette at this size.
      const ear = new THREE.Mesh(new THREE.CircleGeometry(0.042, 7), PINK);
      ear.position.set(s * 0.045, 0.035, -0.015);
      ear.rotation.y = s * 1.1;
      ear.material.side = THREE.DoubleSide;
      this.head.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.011, 5, 4), BEAD);
      eye.position.set(s * 0.028, 0.012, 0.03);
      this.head.add(eye);
    }

    this.tail = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.003, 0.22, 4), PINK);
    this.tail.rotation.x = Math.PI / 2;
    this.tail.position.set(0, 0.07, -0.19);
    this.root.add(this.tail);
  }

  // Straight-line steering, same as everything else in the coop.
  moveToward(target, speed, dt) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.03) return true;
    this.yaw = turnToward(this.yaw, Math.atan2(dx, dz), 9, dt);
    const step = Math.min(speed * dt, dist);
    this.pos.x += Math.sin(this.yaw) * step;
    this.pos.z += Math.cos(this.yaw) * step;
    this.gait += step * 26;
    return dist < 0.2;
  }

  // The nearest chicken bearing down on it, which is what it runs from.
  nearestHunter(w) {
    let best = null, bestD = 99;
    for (const c of w.chickens) {
      if (!c.active || c.zone !== 'coop' || c.perch) continue;
      const d = c.pos.distanceTo(this.pos);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // Being seen is what starts the riot. It spreads by proximity from there,
  // which is why one dozing hen noticing can empty the whole coop.
  raiseAlarm(w, dt) {
    for (const c of w.chickens) {
      if (!c.active || c.big || c.chick || c.zone !== 'coop') continue;
      if (c.bhv.name === 'mouseHunt' || c.bhv.def?.committed) continue;
      const d = c.pos.distanceTo(this.pos);
      const range = this.spotted ? 6.5 : 2.6;
      if (d > range) continue;
      // A perched bird has the best view and the worst dismount.
      if (w.rng() < dt * (this.spotted ? 3.2 : 1.1)) {
        if (!this.spotted) { this.spotted = true; w.audio.squawk(1.4); w.incident(); }
        c.showEmote('bang', 1.6);
        c.force('mouseHunt');
      }
    }
  }

  update(dt) {
    const w = this.world;
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.t += dt;
    this.life += dt;
    this.raiseAlarm(w, dt);
    if (w.rng() < dt * 0.7) w.audio.squeak();

    // Darts and freezes. Frozen, it is much harder to notice and much easier
    // to catch, which is the whole gamble.
    this.dart -= dt;
    if (this.dart < -0.45) this.dart = rand(w.rng, 0.35, 0.9);
    const moving = this.dart > 0;

    const hunter = this.nearestHunter(w);
    const pressed = hunter && hunter.pos.distanceTo(this.pos) < 1.8;
    if (pressed && this.phase !== 'bolt') this.setPhase('bolt');

    switch (this.phase) {
      case 'sneak': {
        if (moving && this.moveToward(this.target, 2.2, dt)) this.setPhase('feed');
        if (this.life > 20) this.setPhase('bolt');
        break;
      }

      case 'feed': {
        // Head down in the spilled grain, oblivious.
        if (this.t > 9) this.setPhase('bolt');
        break;
      }

      case 'bolt': {
        // Away from whoever is closest, toward the nearest wall, and out.
        if (!this.hole) {
          const x = this.pos.x < 0 ? COOP.x0 : COOP.x1;
          this.hole = new THREE.Vector3(x, 0, COOP.z0 + 0.2);
        }
        if (moving && this.moveToward(this.hole, 3.4, dt)) this.done = true;
        // Jinking: a mouse being chased does not run in a straight line.
        if (moving && w.rng() < dt * 4) this.yaw += rand(w.rng, -0.8, 0.8);
        break;
      }
    }

    this.pos.x = clamp(this.pos.x, COOP.x0 - 0.05, COOP.x1 + 0.05);
    this.pos.z = clamp(this.pos.z, COOP.z0 - 0.05, COOP.z1);
    this.animate(dt, moving);
  }

  setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    this.t = 0;
  }

  animate(dt, moving) {
    // A scurry is a blur of legs it does not have; the body bobs instead.
    this.root.position.y = moving ? Math.abs(Math.sin(this.gait)) * 0.012 : 0;
    this.head.rotation.x = this.phase === 'feed' ? 0.6 : Math.sin(this.world.time * 9) * 0.14;
    this.tail.rotation.y = Math.sin(this.gait * 0.35) * 0.5;
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
