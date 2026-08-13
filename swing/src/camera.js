// Chase camera.
//
// Two things matter for a swinging game: the camera must not fight the player's
// arc (so it trails on a spring rather than tracking rigidly), and it must
// point where you are going without constant input — after a moment of no
// steering it drifts to line up with velocity, which is what makes one-thumb
// play on a phone work at all.

import * as THREE from 'three';
import { clamp, damp, dampAngle, lerp, smoothstep } from './util.js';

const TURN_RATE = 2.0;                 // radians per second on a held turn key
const PITCH_MIN = -1.15, PITCH_MAX = 0.95;
const FOV_BASE = 62, FOV_FAST = 92;

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, index: -1 };

export class ChaseCamera {
  constructor(camera, city) {
    this.cam = camera;
    this.city = city;
    this.yaw = 0;
    this.pitch = 0.12;
    this.idle = 0;                       // seconds since the player last steered
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.roll = 0;
    this.shake = 0;
    this.fov = FOV_BASE;
    this.dist = 11;
    this.basis = {
      forward: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
      flat: new THREE.Vector3(0, 0, -1),
    };
    this.updateBasis();
  }

  updateBasis() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.basis.forward.set(-sy * cp, sp, -cy * cp).normalize();
    this.basis.flat.set(-sy, 0, -cy).normalize();
    this.basis.right.set(cy, 0, -sy).normalize();
  }

  snap(player) {
    this.yaw = Math.atan2(-player.vel.x, -player.vel.z);
    this.updateBasis();
    this.pos.copy(player.pos).addScaledVector(this.basis.flat, -this.dist).setY(player.pos.y + 4);
    this.look.copy(player.pos);
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
  }

  /**
   * Angles only. Runs *before* the player so a web fired this frame uses the
   * direction the player is looking right now, not last frame's.
   */
  aim(dt, player, input) {
    // Turning has to exist as its own control. Steering used to be a sideways
    // force only, which nudges your path without ever pointing you somewhere —
    // so with the mouse busy firing webs there was no way to turn at all.
    // Positive yaw rotates the heading toward -X, i.e. left, so turning right
    // subtracts.
    // On a rope the carve turns you and the camera follows the velocity it
    // produced; adding a full tank-turn on top would spin the view off the arc.
    // In free air there is nothing to carve against, so the keys get full say.
    const authority = player.web.active ? 0.4 : 1;
    const turned = input.turn ? input.turn * TURN_RATE * authority * dt : 0;
    const moved = Math.abs(input.lookX) + Math.abs(input.lookY) + Math.abs(turned);
    this.yaw += input.lookX - turned;
    this.pitch = clamp(this.pitch + input.lookY, PITCH_MIN, PITCH_MAX);
    this.idle = moved > 0.0005 ? 0 : this.idle + dt;

    const speed = player.speed;
    if (this.idle > 0.55 && speed > 9) {
      const heading = Math.atan2(-player.vel.x, -player.vel.z);
      const pull = smoothstep(9, 45, speed) * smoothstep(0.55, 1.4, this.idle);
      this.yaw = dampAngle(this.yaw, heading, 2.4 * pull, dt);
      // Look slightly down when falling fast so the ground stays in frame.
      const wantPitch = clamp(-player.vel.y / 90, -0.35, 0.3);
      this.pitch = damp(this.pitch, wantPitch, 1.1 * pull, dt);
    }
    this.updateBasis();
  }

  /**
   * Nudge the heading toward a point of interest. Used by one-button play: with
   * no steering control, the course has to come to you a little — but gently
   * enough that a deliberate turn still wins, and never while the player is
   * actively aiming.
   */
  assist(dt, target, player, strength = 1) {
    if (!target || this.idle < 0.35) return;
    const dx = target.x - player.pos.x;
    const dz = target.z - player.pos.z;
    if (dx * dx + dz * dz < 400) return;               // already on top of it
    const want = Math.atan2(-dx, -dz);
    this.yaw = dampAngle(this.yaw, want, 0.9 * strength, dt);
    this.updateBasis();
  }

  update(dt, player) {
    const speed = player.speed;
    // Trail further back the faster you go — speed reads as framing, not numbers.
    const wantDist = 9.5 + smoothstep(0, 70, speed) * 7 + (player.diving ? 2.5 : 0);
    this.dist = damp(this.dist, wantDist, 3, dt);

    _desired.copy(player.pos)
      .addScaledVector(this.basis.forward, -this.dist)
      .addScaledVector(player.up, 2.6);

    // Keep a building from sitting between the camera and the player.
    _v.subVectors(_desired, player.pos);
    const want = _v.length();
    _v.divideScalar(want || 1);
    const hit = this.city.raycast(player.pos, _v, want + 1.2, _hit);
    if (hit && hit.distance > 0.5) _desired.copy(player.pos).addScaledVector(_v, Math.max(2.2, hit.distance - 1.2));
    if (_desired.y < 1.6) _desired.y = 1.6;

    // A stiffer spring when attached: the arc is fast and the camera must keep up.
    const follow = player.web.active ? 11 : 7.5;
    this.pos.x = damp(this.pos.x, _desired.x, follow, dt);
    this.pos.y = damp(this.pos.y, _desired.y, follow * 0.85, dt);
    this.pos.z = damp(this.pos.z, _desired.z, follow, dt);

    // Aim a little ahead of the player along their own velocity.
    _target.copy(player.pos).addScaledVector(player.vel, 0.09);
    _target.y += 1.4;
    this.look.lerp(_target, 1 - Math.exp(-14 * dt));

    this.cam.position.copy(this.pos);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this.look);

    // Bank into the turn using the lateral component of the swing.
    const lateral = player.web.active ? player.vel.dot(this.basis.right) : 0;
    this.roll = damp(this.roll, clamp(-lateral / 120, -0.22, 0.22), 5, dt);
    if (this.roll) this.cam.rotateZ(this.roll);

    if (this.shake > 0.001) {
      this.shake = damp(this.shake, 0, 6, dt);
      const s = this.shake;
      this.cam.position.x += (Math.random() - 0.5) * s;
      this.cam.position.y += (Math.random() - 0.5) * s;
      this.cam.position.z += (Math.random() - 0.5) * s;
    }

    const wantFov = lerp(FOV_BASE, FOV_FAST, smoothstep(14, 95, speed));
    this.fov = damp(this.fov, wantFov, 4, dt);
    if (Math.abs(this.cam.fov - this.fov) > 0.01) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }

  kick(amount) { this.shake = Math.min(1.6, this.shake + amount); }
}
