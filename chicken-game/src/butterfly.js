import * as THREE from 'three';
import { clamp, rand } from './util.js';
import { YARD } from './zones.js';

// A cabbage white doing lazy circuits of the run.
//
// It is simulation state rather than scenery because the chickens react to
// it: where it is has to be the same on every screen, or two viewers watch
// the same hen leap at nothing. It costs one behavior and no collision.
//
// It cannot be caught. That is the point of it.

const WING = new THREE.MeshStandardMaterial({
  color: 0xf6f1e2, flatShading: true, roughness: 0.85, side: THREE.DoubleSide,
});
const BODY = new THREE.MeshStandardMaterial({ color: 0x3a3128, flatShading: true, roughness: 0.9 });

export class Butterfly {
  constructor(world) {
    this.world = world;
    this.active = false;
    this.pos = new THREE.Vector3(0, 1, 9);
    this.prevPos = this.pos.clone();
    this.target = this.pos.clone();
    this.phase = 0;              // wingbeat, advanced by render time
    this.t = 0;
    this.next = 25;              // until it turns up

    this.root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.07, 2, 5), BODY);
    body.rotation.x = Math.PI / 2;
    this.root.add(body);
    this.wings = [];
    for (const side of [-1, 1]) {
      // Wings lie flat and hinge along the body, so they read as wings from
      // above and from the side. Built standing on edge they vanish from
      // every angle but one, which is most of what you see of a butterfly.
      const pivot = new THREE.Group();
      const w = new THREE.Mesh(new THREE.CircleGeometry(0.09, 6), WING);
      w.rotation.x = -Math.PI / 2;
      w.position.x = side * 0.085;
      w.scale.set(1, 1, 0.85);
      pivot.add(w);
      pivot.userData.side = side;
      this.root.add(pivot);
      this.wings.push(pivot);
    }
    this.root.visible = false;
    world.scene.add(this.root);
  }

  // Somewhere in the open part of the run, at about chicken-eye height, which
  // is what makes it worth jumping at.
  reTarget(rng) {
    this.target.set(
      rand(rng, YARD.x0 + 1, YARD.x1 - 1),
      rand(rng, 0.55, 1.25),
      rand(rng, YARD.z0 + 1, YARD.z1 - 1));
  }

  // A chicken has just launched herself at it. It does not appear to notice
  // so much as drift out of the way.
  startle(w) {
    this.reTarget(w.rng);
    this.target.y = clamp(this.target.y + rand(w.rng, 0.3, 0.7), 0.5, 1.7);
    this.t = 0;
  }

  update(dt) {
    const w = this.world;
    this.prevPos.copy(this.pos);

    if (!this.active) {
      this.next -= dt;
      // Only on a dry day. Nothing about a wet dusk suggests butterflies.
      if (this.next <= 0) {
        this.next = rand(w.rng, 45, 120);
        if (w.phase === 'day' && w.weather.rain < 0.2) {
          this.active = true;
          this.t = 0;
          this.pos.set(rand(w.rng, YARD.x0, YARD.x1), 1.4, YARD.z1 - 0.2);
          this.prevPos.copy(this.pos);
          this.reTarget(w.rng);
        }
      }
      return;
    }

    this.t += dt;
    // Rain or nightfall and it is gone; otherwise it drifts off on its own.
    if (this.t > 55 || w.weather.rain > 0.3 || w.phase === 'night') {
      this.active = false;
      this.next = rand(w.rng, 60, 150);
      return;
    }

    // Butterflies do not steer, they wander. Easing toward a target that
    // keeps moving gives the drunken, unhurried path without any physics.
    const d = this.target.clone().sub(this.pos);
    if (d.length() < 0.3 || w.rng() < dt * 0.5) this.reTarget(w.rng);
    d.normalize().multiplyScalar(rand(w.rng, 0.7, 1.1) * dt);
    this.pos.add(d);
    this.pos.y = clamp(this.pos.y, 0.4, 1.9);
    this.pos.x = clamp(this.pos.x, YARD.x0 + 0.3, YARD.x1 - 0.3);
    this.pos.z = clamp(this.pos.z, YARD.z0 + 0.3, YARD.z1 - 0.3);
  }

  render(alpha, frameDt) {
    this.root.visible = this.active;
    if (!this.active) return;
    this.root.position.lerpVectors(this.prevPos, this.pos, alpha);
    // Wingbeat runs on render time: it is scenery, and nothing reads it.
    this.phase += frameDt * 26;
    const flap = Math.sin(this.phase) * 1.15;
    for (const pivot of this.wings) pivot.rotation.z = pivot.userData.side * (0.35 + flap);
    this.root.rotation.y += (Math.sin(this.phase * 0.11) - this.root.rotation.y) * 0.05;
  }
}
