// Particles, the motion trail and the ground shadow.
//
// Everything here is one InstancedMesh of camera-facing quads. Puffs billboard
// normally; streaks are stretched along their own velocity and only spun about
// that axis, which is what makes the wind lines at 300 km/h read as motion
// rather than confetti.

import * as THREE from 'three';
import { dotTexture } from './textures.js';
import { clamp, smoothstep } from './util.js';

const MAX = 420;
const TRAIL = 40;

const _pos = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _view = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, index: -1 };
const _down = new THREE.Vector3(0, -1, 0);

export class Fx {
  constructor(city) {
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'fx';

    const quad = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: dotTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(quad, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = MAX;
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);

    this.p = Array.from({ length: MAX }, () => ({
      life: 0, max: 1, size: 1, grow: 0, drag: 1, streak: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), col: new THREE.Color(),
    }));
    this.next = 0;
    for (let i = 0; i < MAX; i++) this.mesh.setColorAt(i, _c.setRGB(0, 0, 0));

    // Motion trail: a tapered ribbon through the player's recent positions.
    this.trailPts = Array.from({ length: TRAIL }, () => new THREE.Vector3());
    this.trailFill = 0;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < TRAIL - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    tg.setIndex(idx);
    tg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      color: 0x9fe8ff, transparent: true, opacity: 0.2, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 4;
    this.group.add(this.trail);

    // Blob shadow, so height over a rooftop is readable at a glance.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;
    this.group.add(this.shadow);

    // Aim marker: where the next press would attach. Knowing that before you
    // commit is the difference between timing a swing and guessing at one.
    const ring = new THREE.RingGeometry(0.72, 1, 28);
    this.aim = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: 0x7fe3ff, transparent: true, opacity: 0, depthWrite: false,
      depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.aim.frustumCulled = false;
    this.aim.renderOrder = 6;
    this.group.add(this.aim);
    this.aimShow = 0;
    this.aimPulse = 0;

    this.windAccum = 0;
  }

  /**
   * Park the aim marker on a candidate grip. It is scaled by distance to hold a
   * constant size on screen, so a grip 90 m away reads as clearly as one at 20.
   */
  setAim(grip, camera, dt, ready) {
    this.aimShow = clamp(this.aimShow + (grip && ready ? dt * 7 : -dt * 9), 0, 1);
    if (this.aimShow <= 0.001) { this.aim.visible = false; return; }
    this.aim.visible = true;
    if (grip) {
      this.aim.position.copy(grip.point).addScaledVector(grip.normal, 0.35);
      _pos.copy(grip.point).add(grip.normal);
      this.aim.lookAt(_pos);
      camera.getWorldPosition(_view);
      const dist = this.aim.position.distanceTo(_view);
      this.aim.userData.scale = clamp(dist * 0.028, 0.5, 3.2);
    }
    this.aimPulse += dt * 3.4;
    const beat = 1 + Math.sin(this.aimPulse) * 0.07;
    this.aim.scale.setScalar((this.aim.userData.scale || 1) * beat * this.aimShow);
    this.aim.material.opacity = 0.75 * this.aimShow;
  }

  spawn(pos, vel, opts = {}) {
    const p = this.p[this.next];
    this.next = (this.next + 1) % MAX;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.max = opts.life ?? 0.6;
    p.life = p.max;
    p.size = opts.size ?? 1;
    p.grow = opts.grow ?? 0;
    p.drag = opts.drag ?? 2.5;
    p.streak = opts.streak ?? 0;
    p.col.set(opts.color ?? 0xffffff);
    return p;
  }

  burst(pos, count, opts = {}) {
    const spread = opts.spread ?? 6;
    for (let i = 0; i < count; i++) {
      _pos.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar(spread * (0.4 + Math.random() * 0.6));
      if (opts.dir) _pos.addScaledVector(opts.dir, spread * 0.9);
      this.spawn(pos, _pos, opts);
    }
  }

  /** Wind streaks past the camera; density and length ride on speed. */
  wind(dt, player, camera) {
    const t = smoothstep(28, 95, player.speed);
    if (t <= 0.01) return;
    this.windAccum += dt * t * 70;
    const n = Math.floor(this.windAccum);
    this.windAccum -= n;
    for (let i = 0; i < n; i++) {
      _pos.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar(4 + Math.random() * 11)
        .add(player.pos)
        .addScaledVector(player.vel, 0.16);
      _axis.copy(player.vel).multiplyScalar(-0.25);
      this.spawn(_pos, _axis, {
        life: 0.22 + Math.random() * 0.16,
        size: 0.28,
        streak: 3.5 + t * 9,
        drag: 0.4,
        color: 0xbfe4ff,
      });
    }
  }

  update(dt, player, camera) {
    // ------------------------------------------------------------ particles --
    camera.getWorldPosition(_view);
    for (let i = 0; i < MAX; i++) {
      const p = this.p[i];
      if (p.life <= 0) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      p.life -= dt;
      p.pos.addScaledVector(p.vel, dt);
      p.vel.addScaledVector(p.vel, -clamp(p.drag * dt, 0, 1));
      if (p.grow) p.vel.y += p.grow * dt;

      const k = clamp(p.life / p.max, 0, 1);
      const size = p.size * (1 + (1 - k) * 1.4);

      if (p.streak > 0) {
        _axis.copy(p.vel);
        if (_axis.lengthSq() < 1e-6) _axis.set(0, 1, 0);
        _axis.normalize();
        _fwd.subVectors(_view, p.pos).normalize();
        _right.crossVectors(_axis, _fwd);
        if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
        _right.normalize();
        _fwd.crossVectors(_right, _axis).normalize();
        _m.makeBasis(_right, _axis, _fwd);
        _m.scale(_s.set(size, size * p.streak * k, size));
        _m.setPosition(p.pos);
      } else {
        _q.copy(camera.quaternion);
        _m.compose(p.pos, _q, _s.set(size, size, size));
      }
      this.mesh.setMatrixAt(i, _m);
      const f = k * k;
      this.mesh.setColorAt(i, _c.copy(p.col).multiplyScalar(f));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.wind(dt, player, camera);

    // ---------------------------------------------------------------- trail --
    for (let i = TRAIL - 1; i > 0; i--) this.trailPts[i].copy(this.trailPts[i - 1]);
    this.trailPts[0].copy(player.pos);
    if (this.trailFill < TRAIL) this.trailFill++;

    const arr = this.trail.geometry.attributes.position.array;
    const wide = smoothstep(12, 70, player.speed);
    for (let i = 0; i < TRAIL; i++) {
      const a = this.trailPts[Math.min(i, this.trailFill - 1)];
      const b = this.trailPts[Math.min(i + 1, this.trailFill - 1)];
      _axis.subVectors(b, a);
      if (_axis.lengthSq() < 1e-8) _axis.set(0, 0, 1);
      _axis.normalize();
      _fwd.subVectors(_view, a).normalize();
      // Pinch the ribbon shut at the head as well as the tail. Starting it at
      // full width on the player's own position drapes a translucent sheet over
      // the character — from a chase camera that reads as having no character at
      // all, which is exactly how it was reported.
      const t = i / TRAIL;
      const taper = Math.min(1, i / 5) * (1 - t) * (1 - t);
      _right.crossVectors(_axis, _fwd);
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
      _right.normalize().multiplyScalar(taper * (0.16 + wide * 0.5));
      const o = i * 6;
      arr[o] = a.x - _right.x; arr[o + 1] = a.y - _right.y; arr[o + 2] = a.z - _right.z;
      arr[o + 3] = a.x + _right.x; arr[o + 4] = a.y + _right.y; arr[o + 5] = a.z + _right.z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.material.opacity = 0.07 + wide * 0.2;

    // --------------------------------------------------------------- shadow --
    const hit = this.city.raycast(player.pos, _down, 260, _hit);
    const drop = hit ? hit.distance : (player.pos.y > 0 ? player.pos.y : 0);
    if (drop < 200) {
      const fade = 1 - smoothstep(30, 180, drop);
      this.shadow.visible = fade > 0.02;
      this.shadow.position.set(player.pos.x, player.pos.y - drop + 0.12, player.pos.z);
      const r = 1.2 + drop * 0.055;
      this.shadow.scale.setScalar(r);
      this.shadow.material.opacity = 0.4 * fade;
    } else {
      this.shadow.visible = false;
    }
  }

  reset() {
    for (const p of this.p) p.life = 0;
    this.trailFill = 0;
  }
}
