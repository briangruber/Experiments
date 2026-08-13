// Chase camera for a walkable sphere.
//
// The orbit direction is kept as a world-space unit vector and parallel-
// transported whenever the player's up changes. That avoids the yaw/pitch
// singularity you hit the moment someone runs over a pole — which, on a world
// this small, is about every eight seconds.

import * as THREE from 'three';
import { clamp, damp } from './noise.js';

const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _target = new THREE.Vector3();
const _v = new THREE.Vector3();

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.orbit = new THREE.Vector3(0, 0.45, 1).normalize();
    this.up = new THREE.Vector3(0, 1, 0);
    this.prevUp = this.up.clone();
    this.distance = 20;
    this.targetDistance = 20;
    this.minDistance = 5.0;
    this.maxDistance = 46;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.initialised = false;
    this.shake = 0;
    this.clearDistance = this.distance;
  }

  // Direction the player should treat as "forward" for input, in world space.
  forwardOn(up, out = new THREE.Vector3()) {
    out.copy(this.orbit).negate();
    out.addScaledVector(up, -out.dot(up));
    if (out.lengthSq() < 1e-6) out.set(1, 0, 0).cross(up);
    return out.normalize();
  }

  update(dt, { target, up, moveDir, look, zoom, autoFollow = true, followStrength = 1, heightOffset = 1.15 }) {
    // Parallel-transport the orbit vector along the change in up.
    if (!up.equals(this.prevUp)) {
      _q.setFromUnitVectors(this.prevUp, up);
      this.orbit.applyQuaternion(_q).normalize();
      this.prevUp.copy(up);
    }

    if (look && (look.x || look.y)) {
      _q.setFromAxisAngle(up, -look.x * 0.006);
      this.orbit.applyQuaternion(_q);
      _right.crossVectors(up, this.orbit).normalize();
      const pitch = Math.acos(clamp(this.orbit.dot(up), -1, 1));
      const delta = clamp(look.y * 0.005, -0.6, 0.6);
      const next = clamp(pitch - delta, 0.42, 1.85);
      _q.setFromAxisAngle(_right, pitch - next);
      this.orbit.applyQuaternion(_q).normalize();
    }

    if (zoom) this.targetDistance = clamp(this.targetDistance * (1 + zoom * 0.11), this.minDistance, this.maxDistance);
    this.distance = damp(this.distance, this.targetDistance, 6, dt);

    // Drift behind the player when they run forward, unless they are steering
    // the view. `followStrength` falls to zero for a pure strafe: chasing one
    // turns the input frame under the player and they circle instead of going
    // anywhere.
    if (autoFollow && followStrength > 0.01 && moveDir && moveDir.lengthSq() > 0.01) {
      _desired.copy(moveDir).negate();
      _desired.addScaledVector(up, this.orbit.dot(up) - _desired.dot(up));
      _desired.normalize();
      const t = 1 - Math.exp(-0.9 * followStrength * dt);
      this.orbit.lerp(_desired, t).normalize();
    }

    // Keep the orbit off the pole of the local frame.
    const pitch = Math.acos(clamp(this.orbit.dot(up), -1, 1));
    if (pitch < 0.42 || pitch > 1.85) {
      _right.crossVectors(up, this.orbit).normalize();
      _q.setFromAxisAngle(_right, pitch - clamp(pitch, 0.42, 1.85));
      this.orbit.applyQuaternion(_q).normalize();
    }

    _target.copy(target).addScaledVector(up, heightOffset);
    // The terrain clamp is part of where the camera wants to be, not a
    // correction applied to it afterwards.
    const reach = Math.min(this.distance, this.clearDistance ?? this.distance);
    _desired.copy(_target).addScaledVector(this.orbit, reach);

    if (!this.initialised) {
      this.pos.copy(_desired);
      this.look.copy(_target);
      this.initialised = true;
    } else {
      this.pos.lerp(_desired, 1 - Math.exp(-9 * dt));
      this.look.lerp(_target, 1 - Math.exp(-14 * dt));
    }

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 1.6);
      const s = this.shake * this.shake * 0.35;
      _v.set(Math.sin(dt * 91 + this.pos.x * 13), Math.cos(dt * 77 + this.pos.y * 11), Math.sin(dt * 63)).multiplyScalar(s);
      this.pos.add(_v);
    }

    this.camera.position.copy(this.pos);
    this.camera.up.copy(up);
    this.camera.lookAt(this.look);
  }

  // Keep the ground out from between the camera and the keeper.
  //
  // The old version shoved the camera radially outward the instant it clipped,
  // and wrote the result back into the smoothing state — so the next frame
  // pulled it straight back into the hill and the view buzzed. This walks in
  // along the orbit instead, finds the furthest point that is clear, and eases
  // to it: the camera slides over a ridge rather than fighting it.
  // Only measures. Applying the result here — writing camera.position after
  // update() had already placed it — meant that the frame the obstruction
  // cleared, the camera snapped from the clamped point back to `pos`, which
  // had gone on smoothing somewhere else entirely. Walking past a run of
  // ridges did that over and over: the view lurched backwards, recovered, and
  // lurched again. update() now places the camera at the clamped distance
  // itself, so what is measured and what is rendered are the same number.
  measureClearance(planet, dt = 0.016) {
    if (!planet || !this.initialised) return;
    const MARGIN = 0.85;
    const STEPS = 6;
    let free = this.distance;
    for (let i = 0; i <= STEPS; i++) {
      const d = this.distance * (1 - i / STEPS) + this.minDistance * (i / STEPS);
      _v.copy(this.look).addScaledVector(this.orbit, d);
      planet.group.worldToLocal(_v);
      const dir = _desired.copy(_v).normalize();
      if (_v.length() > planet.groundRadius(dir) + MARGIN) { free = d; break; }
      free = d;
    }
    // Snap in fast so a ridge never crosses the view; ease back out slowly so
    // clearing it does not fling the camera.
    const rate = free < this.clearDistance ? 26 : 3.5;
    this.clearDistance = damp(this.clearDistance ?? free, free, rate, dt);
  }

  snap() { this.initialised = false; this.clearDistance = this.targetDistance; }
}
