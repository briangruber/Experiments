// A customer: one rabbit, its animation state, and the walk it is currently on.
//
// The generated clips animate in place apart from a little residual drift, so
// the game owns the position and the clips only own the pose.

import * as THREE from 'three';
import { place } from './assets.js';
import { TWEAKS } from './scene.js';

const WALK_SPEED = 1.45;
const RUN_SPEED = 3.1;
const TURN_RATE = 7.0;

// Fur tints. They multiply against a cream or grey model, so they read as
// different rabbits rather than different paint jobs.
const COATS = [
  0xffffff, 0xf3e0c8, 0xd8c0a2, 0xbfa88e, 0x8d7a68, 0xf7d4d0, 0xd6d9e8, 0xcfe0cd, 0xe8d3a8, 0xa89684,
];

const SCARVES = [0xe0664f, 0x6bc4d6, 0xffd166, 0x8fd06a, 0xd694e8, 0xf58fb0];

/**
 * Remove horizontal travel from a baked clip so the rabbit stays under our
 * control, while leaving the vertical bounce that makes a hop look like a hop.
 */
function deroot(clip) {
  const out = clip.clone();
  for (const track of out.tracks) {
    if (!track.name.endsWith('.position')) continue;
    if (!/hip|root|pelvis|armature|bone_?0|spine/i.test(track.name)) continue;
    const v = track.values;
    const x0 = v[0];
    const z0 = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
  return out;
}

export class Customer {
  /**
   * @param {object} spec
   * @param {object} spec.gltf     the rigged base model
   * @param {object} spec.clips    named AnimationClips sharing that rig
   * @param {string} spec.type     'bunny_round' | 'bunny_lanky'
   * @param {object} [spec.coat]   { trenchcoat } for the special customer
   */
  constructor({ gltf, clips, type, special = null, extras = {} }) {
    this.type = type;
    this.special = special;
    this.root = new THREE.Group();
    this.mixers = [];
    this.actions = {};
    this.current = null;

    const height = TWEAKS[type].height * (0.92 + Math.random() * 0.2);
    const tint = new THREE.Color(COATS[Math.floor(Math.random() * COATS.length)]);

    if (special === 'trenchcoat') {
      this.buildTrenchcoat({ gltf, clips, height, extras });
    } else {
      const body = this.buildBody({ gltf, clips, height, tint, primary: true });
      this.root.add(body);
      this.addScarf(body, height);
    }

    this.height = height * (special === 'trenchcoat' ? 2.1 : 1);

    // Movement state.
    this.pos = new THREE.Vector2(0, 0);
    this.target = null;
    this.facing = 0;
    this.wantFacing = 0;
    this.speed = WALK_SPEED;
    this.arrived = true;

    this.play('idle');
  }

  // One rabbit's mesh, with its own materials so it can be tinted.
  buildBody({ gltf, clips, height, tint, primary }) {
    const group = place(gltf, { height, ry: TWEAKS[this.type].ry ?? 0, clone: true, skinned: true });

    group.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.color.multiply(tint);
    });

    const mixer = new THREE.AnimationMixer(group);
    this.mixers.push(mixer);

    // Only the lead rabbit drives the shared action names; the extra bodies in
    // a trenchcoat just loop idle forever.
    const table = primary ? this.actions : {};
    for (const [name, clip] of Object.entries(clips)) {
      const action = mixer.clipAction(deroot(clip), group);
      action.enabled = true;
      if (name === 'jump' || name === 'hurt') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      table[name] = action;
    }
    if (!primary) {
      table.idle?.play();
      table.idle && (table.idle.time = Math.random() * 2);
    }

    group.userData.bodyHeight = height;
    return group;
  }

  // Three rabbits, stacked, in a coat. Nobody suspects a thing.
  buildTrenchcoat({ gltf, clips, height, extras }) {
    const step = height * 0.55;
    for (let i = 0; i < 3; i++) {
      const tint = new THREE.Color(COATS[Math.floor(Math.random() * COATS.length)]);
      const body = this.buildBody({ gltf, clips, height: height * (1 - i * 0.04), tint, primary: i === 0 });
      body.position.y = i * step;
      this.root.add(body);
    }

    if (extras.trenchcoat) {
      const coat = place(extras.trenchcoat, { height: step * 2 + height * 0.55, clone: true });
      coat.position.y = step * 0.32;
      // Widen it slightly so three rabbits actually fit inside the bit.
      coat.scale.x *= 1.18;
      coat.scale.z *= 1.18;
      this.root.add(coat);
    }
  }

  // A knitted ring at the throat — cheap variety that survives any rig.
  addScarf(body, height) {
    if (Math.random() > 0.45) return;
    let neck = null;
    body.traverse((o) => {
      if (!neck && o.isBone && /neck|head/i.test(o.name)) neck = o;
    });
    if (!neck) return;

    const scarf = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.34, 10, 20),
      new THREE.MeshStandardMaterial({ color: SCARVES[Math.floor(Math.random() * SCARVES.length)], roughness: 0.95 }),
    );
    scarf.rotation.x = Math.PI / 2;
    scarf.castShadow = true;
    neck.add(scarf);

    // Bones live deep inside the model's own (large, pre-normalisation) space,
    // so a torus of radius 1 attached to one comes out metres wide. Undo the
    // accumulated scale and size the scarf in world units instead.
    body.updateWorldMatrix(true, true);
    const worldScale = new THREE.Vector3();
    neck.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
    const unit = Math.max(worldScale.x, 1e-6);
    scarf.scale.setScalar((height * 0.075) / unit);
  }

  // ---------------------------------------------------------------- motion

  setPosition(x, z) {
    this.pos.set(x, z);
    this.root.position.set(x, 0, z);
  }

  goTo(x, z, { run = false } = {}) {
    this.target = new THREE.Vector2(x, z);
    this.speed = run ? RUN_SPEED : WALK_SPEED;
    this.arrived = false;
    this.play(run ? 'run' : 'walk');
  }

  faceCamera() {
    this.wantFacing = 0; // +z is toward the shopkeeper
  }

  play(name, fade = 0.25) {
    const next = this.actions[name];
    if (!next || this.current === next) return;
    next.reset();
    next.setEffectiveWeight(1);
    next.fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
  }

  // A one-shot that returns to idle when it finishes.
  playOnce(name) {
    const action = this.actions[name];
    if (!action) return;
    action.reset();
    action.setEffectiveWeight(1);
    action.fadeIn(0.1).play();
    if (this.current && this.current !== action) this.current.fadeOut(0.1);
    this.current = action;

    const mixer = this.mixers[0];
    const done = (e) => {
      if (e.action !== action) return;
      mixer.removeEventListener('finished', done);
      this.current = null;
      this.play('idle', 0.2);
    };
    mixer.addEventListener('finished', done);
  }

  update(dt) {
    if (this.target) {
      const dx = this.target.x - this.pos.x;
      const dz = this.target.y - this.pos.y;
      const dist = Math.hypot(dx, dz);

      if (dist < 0.06) {
        this.target = null;
        this.arrived = true;
        this.play('idle');
      } else {
        const stepLen = Math.min(this.speed * dt, dist);
        this.pos.x += (dx / dist) * stepLen;
        this.pos.y += (dz / dist) * stepLen;
        this.root.position.set(this.pos.x, 0, this.pos.y);
        this.wantFacing = Math.atan2(dx, dz);
      }
    }

    // Shortest-arc turn toward the desired heading.
    let delta = this.wantFacing - this.facing;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.facing += delta * Math.min(1, TURN_RATE * dt);
    this.root.rotation.y = this.facing;

    for (const m of this.mixers) m.update(dt);
  }

  // Where a speech bubble should point.
  anchor(out = new THREE.Vector3()) {
    return out.set(this.root.position.x, this.height * 1.02, this.root.position.z);
  }

  dispose(scene) {
    scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose?.();
      }
    });
  }
}
