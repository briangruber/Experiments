// The objective: a chain of rings threaded between the towers, always laid out
// ahead of wherever the player is heading. Collecting one inside the combo
// window multiplies the next, so the interesting line is the fast one, not the
// safe one.
//
// Detection is a segment/disc test against the player's motion for the frame,
// so a ring cannot be missed by flying through it faster than the frame rate.

import * as THREE from 'three';
import { makeRng, clamp } from './util.js';

const CHAIN = 9;
const RADIUS = 9;
const COMBO_TIME = 5.0;
const SPACING = [70, 130];

const _v = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Rings {
  constructor(city, seed = 4) {
    this.city = city;
    this.rng = makeRng(seed);
    this.group = new THREE.Group();
    this.group.name = 'rings';

    const geo = new THREE.TorusGeometry(RADIUS, 0.42, 10, 40);
    const halo = new THREE.RingGeometry(RADIUS - 0.5, RADIUS + 0.5, 40);

    this.items = [];
    for (let i = 0; i < CHAIN; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0d2b33, emissive: new THREE.Color(0x38d8ff), emissiveIntensity: 3.2,
        roughness: 0.35, metalness: 0.2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const glow = new THREE.Mesh(halo, new THREE.MeshBasicMaterial({
        color: 0x9beeff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
      }));
      mesh.add(glow);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.items.push({ mesh, mat, pos: new THREE.Vector3(), normal: new THREE.Vector3(), alive: false, spin: 0 });
    }

    this.score = 0;
    this.combo = 1;
    this.comboLeft = 0;
    this.best = 0;
    this.collected = 0;
    this.events = [];
    this.cursor = 0;                  // index of the next ring in the chain
    this.strayTime = 0;               // how long the course has been out of reach
  }

  /** Lay a fresh chain starting ahead of the player, along their heading. */
  layChain(player) {
    const rng = this.rng;
    _fwd.copy(player.vel);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1) _fwd.set(rng.range(-1, 1), 0, rng.range(-1, 1));
    _fwd.normalize();

    let x = player.pos.x + _fwd.x * 120;
    let z = player.pos.z + _fwd.z * 120;
    let heading = Math.atan2(_fwd.x, _fwd.z);
    const half = this.city.half - 120;

    for (let i = 0; i < CHAIN; i++) {
      // Wander the course so it curves through the blocks instead of running straight.
      heading += rng.range(-0.42, 0.42);
      const step = rng.range(SPACING[0], SPACING[1]);
      x += Math.sin(heading) * step;
      z += Math.cos(heading) * step;
      // Steer back inside the city if the course wanders off the edge.
      if (Math.abs(x) > half || Math.abs(z) > half) {
        heading = Math.atan2(-x, -z) + rng.range(-0.5, 0.5);
        x = clamp(x, -half, half);
        z = clamp(z, -half, half);
      }

      // Sit the ring just above whatever it is over. A course strung at a fixed
      // high altitude looks good on paper and is unreachable in practice: the
      // swing lives a little above the rooftops, so the rings have to as well.
      const ground = this.city.heightAt(x, z);
      const y = clamp(ground + rng.range(14, 34), 34, 125);

      const item = this.items[i];
      item.pos.set(x, y, z);
      item.normal.set(Math.sin(heading), 0, Math.cos(heading)).normalize();
      item.alive = true;
      item.spin = rng.range(0, Math.PI);
      item.mesh.position.copy(item.pos);
      item.mesh.visible = true;
      _q.setFromUnitVectors(_v.set(0, 0, 1), item.normal);
      item.mesh.quaternion.copy(_q);
    }
    this.cursor = 0;
  }

  /** Closest point on the chain the player should be heading for. */
  get target() {
    for (let i = this.cursor; i < this.items.length; i++) {
      if (this.items[i].alive) return this.items[i];
    }
    return null;
  }

  update(dt, player, time) {
    this.events.length = 0;

    if (this.comboLeft > 0) {
      this.comboLeft -= dt;
      if (this.comboLeft <= 0) {
        this.comboLeft = 0;
        this.combo = 1;
      }
    }

    let remaining = 0;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item.alive) continue;
      remaining++;

      const next = i === this.cursor;
      item.mesh.rotation.z = item.spin + time * 0.5;
      // The next ring in the chain burns gold so the line ahead is unambiguous.
      const wantColor = next ? 0xffc247 : 0x38d8ff;
      item.mat.emissive.setHex(wantColor);
      item.mat.emissiveIntensity = next ? 4.2 + Math.sin(time * 5) * 0.9 : 2.6;

      // Segment/disc test against this frame's motion.
      _seg.subVectors(player.pos, player.prev);
      _rel.subVectors(player.prev, item.pos);
      const denom = _seg.dot(item.normal);
      if (Math.abs(denom) < 1e-6) continue;
      const t = -_rel.dot(item.normal) / denom;
      if (t < 0 || t > 1) continue;
      _v.copy(player.prev).addScaledVector(_seg, t).sub(item.pos);
      if (_v.length() > RADIUS + 1.2) continue;

      this.take(item, player, i);
      remaining--;
    }

    // If the run has wandered away from the course, lay a fresh one ahead
    // rather than leaving the objective stranded on the far side of the city.
    const target = this.target;
    if (target && player.pos.distanceTo(target.pos) > 520) this.strayTime += dt;
    else this.strayTime = 0;

    if (!remaining || this.strayTime > 6) {
      this.layChain(player);
      this.strayTime = 0;
    }

    // Advance the cursor past anything already taken.
    while (this.cursor < this.items.length && !this.items[this.cursor].alive) this.cursor++;
    if (this.cursor >= this.items.length) this.cursor = this.items.findIndex((i) => i.alive);
    if (this.cursor < 0) this.cursor = 0;
  }

  take(item, player, index) {
    item.alive = false;
    item.mesh.visible = false;
    this.collected++;

    const speedBonus = Math.round(player.speed * 1.6);
    const gained = Math.round((100 + speedBonus) * this.combo);
    this.score += gained;
    this.best = Math.max(this.best, this.score);

    if (this.comboLeft > 0) this.combo = Math.min(9, this.combo + 1);
    this.comboLeft = COMBO_TIME;

    this.events.push({ type: 'ring', points: gained, combo: this.combo, pos: item.pos, index });
  }

  award(points, label) {
    this.score += Math.round(points * this.combo);
    this.events.push({ type: 'bonus', points: Math.round(points * this.combo), label });
  }

  reset() {
    this.score = 0;
    this.combo = 1;
    this.comboLeft = 0;
    this.collected = 0;
  }
}
