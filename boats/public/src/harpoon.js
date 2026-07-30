import * as THREE from 'three';
import { HARPOON } from '/shared/config.js';
import { waterHeight } from '/shared/waves.js';

// The rope is the game. Everything here exists to make a line between a boat
// and something much larger feel like it is under load.

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** A tube whose vertices we rewrite every frame, so it can sag and snap taut. */
class Rope {
  constructor(color = 0xd9cdb2, radius = 0.06, segments = 26) {
    this.segments = segments;
    this.radial = 4;
    const count = (segments + 1) * this.radial;
    const positions = new Float32Array(count * 3);
    const indices = [];
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < this.radial; j++) {
        const a = i * this.radial + j;
        const b = i * this.radial + ((j + 1) % this.radial);
        const c = a + this.radial;
        const d = b + this.radial;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.geo = geo;
    this.material = new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.radius = radius;
  }

  /** sag 0 = piano wire, 1 = slack coil in the water. */
  update(from, to, sag = 0.2) {
    const pos = this.geo.attributes.position.array;
    const dir = _a.copy(to).sub(from);
    const len = dir.length() || 1;
    dir.multiplyScalar(1 / len);
    // Any vector not parallel to the rope works as a frame reference.
    const up = Math.abs(dir.y) > 0.92 ? _b.set(1, 0, 0) : _b.set(0, 1, 0);
    const side = _c.copy(dir).cross(up).normalize();
    const nrm = new THREE.Vector3().copy(side).cross(dir).normalize();
    let k = 0;
    for (let i = 0; i <= this.segments; i++) {
      const t = i / this.segments;
      const droop = Math.sin(Math.PI * t) * sag * len * 0.16;
      const px = from.x + (to.x - from.x) * t;
      const py = from.y + (to.y - from.y) * t - droop;
      const pz = from.z + (to.z - from.z) * t;
      for (let j = 0; j < this.radial; j++) {
        const a = (j / this.radial) * Math.PI * 2;
        const ox = (side.x * Math.cos(a) + nrm.x * Math.sin(a)) * this.radius;
        const oy = (side.y * Math.cos(a) + nrm.y * Math.sin(a)) * this.radius;
        const oz = (side.z * Math.cos(a) + nrm.z * Math.sin(a)) * this.radius;
        pos[k++] = px + ox;
        pos[k++] = py + oy;
        pos[k++] = pz + oz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

function harpoonMesh(scale = 1) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c3c9, roughness: 0.35, metalness: 0.75, flatShading: true });
  const wood = new THREE.MeshStandardMaterial({ color: 0x7d5f3c, roughness: 0.9, flatShading: true });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 6), wood);
  shaft.rotation.z = Math.PI / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 6), steel);
  head.rotation.z = -Math.PI / 2;
  head.position.x = 1.1;
  for (const side of [-1, 1]) {
    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.34, 4), steel);
    barb.rotation.z = Math.PI / 2 + 0.5 * side;
    barb.position.set(0.86, 0.11 * side, 0);
    g.add(barb);
  }
  const flight = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.02), steel);
  flight.position.x = -0.85;
  g.add(shaft, head, flight);
  g.scale.setScalar(scale);
  return g;
}

export class HarpoonSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} hooks onHit(monsterView, damage, point), onSnap(tether), onSplash(point)
   */
  constructor(scene, hooks = {}) {
    this.scene = scene;
    this.hooks = hooks;
    this.flights = [];   // harpoons in the air
    this.tethers = [];   // ropes with something angry on the end
    this.ropePool = [];
  }

  takeRope() {
    const rope = this.ropePool.pop() || new Rope();
    rope.mesh.visible = true;
    this.scene.add(rope.mesh);
    return rope;
  }

  giveRope(rope) {
    this.scene.remove(rope.mesh);
    if (this.ropePool.length < 8) this.ropePool.push(rope);
    else rope.dispose();
  }

  /** Throw one. `owner` null means it belongs to another player (visual only). */
  fire({ origin, dir, charge, damage, owner = 'me', maxRope = 60 }) {
    const speed = HARPOON.minSpeed + (HARPOON.maxSpeed - HARPOON.minSpeed) * charge;
    const mesh = harpoonMesh(owner === 'me' ? 1 : 0.9);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    const rope = this.takeRope();
    const flight = {
      mesh, rope, owner,
      pos: origin.clone(),
      prev: origin.clone(),
      vel: dir.clone().multiplyScalar(speed),
      origin: origin.clone(),
      damage, charge, maxRope,
      life: 4,
    };
    this.flights.push(flight);
    return flight;
  }

  update(dt, time, ctx) {
    const { monsters, anchor } = ctx;

    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.life -= dt;
      f.prev.copy(f.pos);
      f.vel.y -= HARPOON.gravity * dt;
      _a.copy(f.vel).multiplyScalar(dt);
      f.pos.add(_a);
      f.mesh.position.copy(f.pos);
      // Point it where it is going -- a harpoon that flies sideways looks wrong.
      _b.copy(f.vel).normalize();
      f.mesh.quaternion.setFromUnitVectors(_c.set(1, 0, 0), _b);

      const start = f.owner === 'me' && anchor ? anchor : f.origin;
      f.rope.update(start, f.pos, 0.35);

      let done = false;
      if (f.owner === 'me') {
        for (const view of monsters.values()) {
          if (view.dying) continue;
          const idx = view.hitSegment(f.prev, f.pos, HARPOON.radius * 0.5);
          if (idx < 0) continue;
          this.attach(f, view, idx);
          done = true;
          break;
        }
      }
      if (!done) {
        const wy = waterHeight(f.pos.x, f.pos.z, time);
        if (f.pos.y < wy) {
          this.hooks.onSplash?.(f.pos, 0.7);
          done = true;
        } else if (f.life <= 0 || f.pos.distanceTo(f.origin) > f.maxRope * 1.35) {
          done = true;
        }
      }
      if (done) {
        this.scene.remove(f.mesh);
        disposeGroup(f.mesh);
        this.giveRope(f.rope);
        this.flights.splice(i, 1);
      }
    }

    for (let i = this.tethers.length - 1; i >= 0; i--) {
      const t = this.tethers[i];
      if (!t.view.root.parent || t.view.dying) { this.release(t, 'lost'); continue; }
      const s = t.view.hitSpheresWorld[Math.min(t.sphere, t.view.hitSpheresWorld.length - 1)];
      t.point.copy(s.pos);
      t.stuck.position.copy(s.pos);
      const from = ctx.anchor;
      const dist = from.distanceTo(t.point);
      t.dist = dist;
      const over = dist - t.length;
      const taut = Math.max(0, Math.min(1, over / 6 + 0.15));
      t.rope.update(from, t.point, (1 - taut) * 0.9);
      t.rope.material.color.setHSL(0.09, 0.25, 0.72 - t.strain / 260);
      t.taut = taut;
      t.over = over;
    }
  }

  attach(flight, view, sphereIndex) {
    const point = view.hitSpheresWorld[sphereIndex].pos.clone();
    const existing = this.tethers.find((t) => t.view === view);
    this.hooks.onHit?.(view, flight.damage, point, flight.charge);
    if (existing) {
      // Second hook in the same beast: shortens nothing, but it counts.
      existing.strain = Math.max(0, existing.strain - 12);
      return;
    }
    const stuck = harpoonMesh(1);
    stuck.rotation.y = Math.random() * Math.PI;
    // Kept in world space and repositioned each frame: parenting it to the
    // monster would double-apply that group's transform.
    this.scene.add(stuck);
    const tether = {
      view, sphere: sphereIndex, stuck,
      point, rope: this.takeRope(),
      length: Math.max(14, Math.min(flight.maxRope, point.distanceTo(flight.origin) + 4)),
      maxLength: flight.maxRope,
      strain: 0, dist: 0, taut: 0, over: 0,
    };
    tether.rope.radius = 0.075;
    this.tethers.push(tether);
    this.hooks.onTether?.(tether);
  }

  release(tether, reason = 'cut') {
    const i = this.tethers.indexOf(tether);
    if (i < 0) return;
    this.tethers.splice(i, 1);
    this.giveRope(tether.rope);
    tether.stuck.parent?.remove(tether.stuck);
    disposeGroup(tether.stuck);
    this.hooks.onRelease?.(tether, reason);
  }

  get tether() { return this.tethers[0] || null; }
}

export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

export { Rope };
