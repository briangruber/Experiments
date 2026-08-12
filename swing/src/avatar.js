// The hero.
//
// assets/hero.glb comes out of Tripo3D with a Mixamo-named skeleton but no
// animation clips, so every pose here is authored as a set of *directions*
// rather than joint rotations: for each bone we say where its child should
// point, in character space, and solve the rotation that puts it there. That
// keeps the code independent of whatever bind pose the generator happened to
// produce, and it means the web arm can aim at the real anchor point instead of
// approximating it with a canned animation.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp, damp, smoothstep } from './util.js';
import { loadGLB } from './assets.js';

const HEIGHT = 1.95;                 // metres, hips-to-head normalised

/**
 * Strip the rig's namespace prefix. Tripo names its bones `mixamorig:Hips`, but
 * three's GLTFLoader sanitises node names on the way in and the colon does not
 * survive — so the same bone arrives as `mixamorigHips`. Matching only the
 * colon form silently finds nothing, every aim() bails out, and the character
 * renders in its bind pose with no error anywhere.
 */
const boneKey = (name) => name.replace(/^mixamorig[:_\s]?/i, '');
const CHAIN = [
  ['Spine', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Neck'], ['Neck', 'Head'],
  ['LeftShoulder', 'LeftArm'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
  ['RightShoulder', 'RightArm'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['LeftFoot', 'LeftToeBase'],
  ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'], ['RightFoot', 'RightToeBase'],
];

/**
 * Pose = desired child direction per bone, in character space (+Z forward,
 * +Y up, +X the character's left). Vectors are normalised on use.
 */
const POSES = {
  swing: {
    Spine: [0, 0.94, 0.34], Spine1: [0, 0.96, 0.28], Spine2: [0, 0.97, 0.22],
    Neck: [0, 0.85, 0.5], Head: [0, 0.8, 0.6],
    LeftShoulder: [0.9, 0.4, 0], RightShoulder: [-0.9, 0.4, 0],
    LeftArm: [0.45, 0.86, -0.2], LeftForeArm: [0.3, 0.94, -0.1],
    RightArm: [-0.45, 0.86, -0.2], RightForeArm: [-0.3, 0.94, -0.1],
    LeftUpLeg: [0.16, -0.6, -0.78], LeftLeg: [0.1, -0.35, 0.93],
    RightUpLeg: [-0.16, -0.72, -0.68], RightLeg: [-0.1, -0.5, 0.86],
    LeftFoot: [0, -0.4, 0.9], RightFoot: [0, -0.4, 0.9],
  },
  dive: {
    Spine: [0, 0.99, 0.12], Spine1: [0, 1, 0.05], Spine2: [0, 1, 0],
    Neck: [0, 0.9, 0.42], Head: [0, 0.86, 0.5],
    LeftShoulder: [0.95, 0.1, 0], RightShoulder: [-0.95, 0.1, 0],
    LeftArm: [0.5, -0.3, -0.82], LeftForeArm: [0.42, -0.2, -0.88],
    RightArm: [-0.5, -0.3, -0.82], RightForeArm: [-0.42, -0.2, -0.88],
    LeftUpLeg: [0.1, -0.86, -0.5], LeftLeg: [0.06, -0.94, -0.32],
    RightUpLeg: [-0.1, -0.86, -0.5], RightLeg: [-0.06, -0.94, -0.32],
    LeftFoot: [0, -0.8, 0.6], RightFoot: [0, -0.8, 0.6],
  },
  fall: {
    Spine: [0, 0.97, -0.24], Spine1: [0, 0.98, -0.18], Spine2: [0, 0.99, -0.12],
    Neck: [0, 0.95, 0.3], Head: [0, 0.94, 0.34],
    LeftShoulder: [0.94, 0.34, 0], RightShoulder: [-0.94, 0.34, 0],
    LeftArm: [0.82, 0.5, -0.28], LeftForeArm: [0.6, 0.72, -0.34],
    RightArm: [-0.82, 0.5, -0.28], RightForeArm: [-0.6, 0.72, -0.34],
    LeftUpLeg: [0.34, -0.86, 0.38], LeftLeg: [0.2, -0.66, -0.72],
    RightUpLeg: [-0.34, -0.86, 0.38], RightLeg: [-0.2, -0.66, -0.72],
    LeftFoot: [0, -0.7, 0.7], RightFoot: [0, -0.7, 0.7],
  },
  run: {
    Spine: [0, 0.96, 0.28], Spine1: [0, 0.97, 0.24], Spine2: [0, 0.98, 0.2],
    Neck: [0, 0.92, 0.38], Head: [0, 0.9, 0.44],
    LeftShoulder: [0.95, 0.3, 0], RightShoulder: [-0.95, 0.3, 0],
    LeftArm: [0.24, -0.72, 0.65], LeftForeArm: [0.18, -0.3, 0.94],
    RightArm: [-0.24, -0.72, -0.65], RightForeArm: [-0.18, -0.3, -0.94],
    LeftUpLeg: [0.1, -0.8, 0.6], LeftLeg: [0.06, -0.94, -0.34],
    RightUpLeg: [-0.1, -0.94, -0.34], RightLeg: [-0.06, -0.7, 0.72],
    LeftFoot: [0, -0.5, 0.86], RightFoot: [0, -0.5, 0.86],
  },
  idle: {
    Spine: [0, 1, 0.04], Spine1: [0, 1, 0.03], Spine2: [0, 1, 0.02],
    Neck: [0, 0.98, 0.18], Head: [0, 0.97, 0.22],
    LeftShoulder: [0.97, 0.24, 0], RightShoulder: [-0.97, 0.24, 0],
    LeftArm: [0.34, -0.92, 0.1], LeftForeArm: [0.24, -0.95, 0.16],
    RightArm: [-0.34, -0.92, 0.1], RightForeArm: [-0.24, -0.95, 0.16],
    LeftUpLeg: [0.08, -0.99, 0.06], LeftLeg: [0.05, -0.99, -0.06],
    RightUpLeg: [-0.08, -0.99, 0.06], RightLeg: [-0.05, -0.99, -0.06],
    LeftFoot: [0, -0.35, 0.94], RightFoot: [0, -0.35, 0.94],
  },
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _want = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _box = new THREE.Box3();

export class Avatar {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'avatar';
    this.model = null;
    this.bones = new Map();
    this.rest = new Map();
    this.ready = false;
    this.weights = { swing: 0, dive: 0, fall: 1, run: 0, idle: 0 };
    this.blend = {};                    // bone name → working direction vector
    this.orient = new THREE.Quaternion();
    this.runPhase = 0;
    this.hands = { '-1': new THREE.Vector3(), 1: new THREE.Vector3() };
    for (const [, child] of CHAIN) this.blend[child] = new THREE.Vector3();
    for (const key of Object.keys(POSES.idle)) this.blend[key] = new THREE.Vector3();
  }

  async load(url = './assets/hero.glb') {
    const gltf = await loadGLB(new GLTFLoader(), url);
    const model = gltf.scene;

    model.traverse((o) => {
      if (o.isBone) this.bones.set(boneKey(o.name), o);
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false;          // the skeleton moves far from its bind box
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.roughness = Math.min(m.roughness ?? 1, 0.62);
          m.metalness = Math.max(m.metalness ?? 0, 0.08);
          m.envMapIntensity = 1;
        }
      }
    });

    // Normalise: Tripo exports at an arbitrary scale, and the feet rarely sit at
    // the origin. Scale to a human height and drop the origin to the feet.
    _box.setFromObject(model);
    const size = _box.getSize(new THREE.Vector3());
    const scale = HEIGHT / Math.max(size.y, 1e-3);
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);
    _box.setFromObject(model);
    model.position.y -= _box.min.y;

    this.root.add(model);
    this.model = model;

    for (const [, b] of this.bones) this.rest.set(b.name, b.quaternion.clone());

    // Fail loudly on an unfamiliar rig rather than rendering a bind pose.
    const missing = CHAIN.map(([a]) => a).filter((n) => !this.bones.has(n));
    if (missing.length) {
      console.warn(
        `avatar: ${missing.length} expected bones missing (${missing.slice(0, 4).join(', ')}…). ` +
        `Rig has: ${[...this.bones.keys()].slice(0, 8).join(', ')}…`,
      );
    }
    this.posable = missing.length < CHAIN.length / 2;
    this.ready = this.bones.size > 0;
    if (!this.ready) this.buildStandIn();
    return this;
  }

  /**
   * A blocky figure, used when the mesh cannot be loaded at all. It has no
   * skeleton, so it only takes the body orientation — but a player who can see
   * where they are and which way they are pointing has a game, and one staring
   * at an invisible character does not.
   */
  buildStandIn() {
    if (this.model) return;
    const suit = new THREE.MeshStandardMaterial({ color: 0xc8213f, roughness: 0.55, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.7, metalness: 0.15 });
    const figure = new THREE.Group();
    const part = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.frustumCulled = false;
      figure.add(m);
      return m;
    };
    part(new THREE.CapsuleGeometry(0.28, 0.62, 4, 10), suit, 0, 1.25, 0);
    part(new THREE.SphereGeometry(0.22, 12, 10), suit, 0, 1.82, 0);
    for (const s of [-1, 1]) {
      part(new THREE.CapsuleGeometry(0.1, 0.52, 3, 8), suit, s * 0.34, 1.34, 0);
      part(new THREE.CapsuleGeometry(0.12, 0.66, 3, 8), dark, s * 0.15, 0.5, 0);
    }
    this.root.add(figure);
    this.model = figure;
    this.ready = true;
    this.standIn = true;
    console.warn('avatar: using the procedural stand-in');
  }

  /** Rotate `bone` so the direction to `child` matches a world-space vector. */
  aim(boneName, childName, worldDir, weight = 1) {
    const bone = this.bones.get(boneName), child = this.bones.get(childName);
    if (!bone || !child) return;
    bone.updateWorldMatrix(true, false);
    child.updateWorldMatrix(false, false);
    _a.setFromMatrixPosition(bone.matrixWorld);
    _b.setFromMatrixPosition(child.matrixWorld);
    _dir.subVectors(_b, _a);
    if (_dir.lengthSq() < 1e-8) return;
    _dir.normalize();
    _want.copy(worldDir).normalize();
    _q.setFromUnitVectors(_dir, _want);
    if (weight < 1) _q.slerp(new THREE.Quaternion(), 1 - weight);

    bone.getWorldQuaternion(_pq);
    _q.multiply(_pq);                                  // desired world rotation
    if (bone.parent) {
      bone.parent.getWorldQuaternion(_pq);
      _q.premultiply(_pq.invert());
    }
    bone.quaternion.copy(_q);
    bone.updateMatrixWorld(true);
  }

  /**
   * @param {object} p  player state
   * @param {number} dt seconds
   */
  update(dt, p) {
    if (!this.ready) return;
    const attached = p.web.active;
    const speed = p.speed;

    // ------------------------------------------------------- orientation --
    if (attached) {
      // Hang from the rope: up points along the web, facing follows the arc.
      _up.subVectors(p.web.anchor, p.pos).normalize();
      _fwd.copy(p.vel).addScaledVector(_up, -p.vel.dot(_up));
      if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, 1);
      _fwd.normalize();
    } else if (speed > 3) {
      _fwd.copy(p.vel).normalize();
      this.lastYaw = Math.atan2(-_fwd.x, -_fwd.z);      // remembered for standing still
      _up.set(0, 1, 0).addScaledVector(_fwd, -_fwd.y);
      if (_up.lengthSq() < 1e-4) _up.set(0, 0, 1);
      _up.normalize();
    } else {
      _fwd.set(-Math.sin(this.lastYaw || 0), 0, -Math.cos(this.lastYaw || 0));
      _up.set(0, 1, 0);
    }
    _right.crossVectors(_up, _fwd).normalize();
    _up.crossVectors(_fwd, _right).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _q.setFromRotationMatrix(_m);
    this.orient.slerp(_q, 1 - Math.exp(-(attached ? 12 : 7) * dt));
    this.root.quaternion.copy(this.orient);

    // Hang the body below the hand while swinging — the physics point is the grip.
    const drop = attached ? -1.55 : -1.0;
    this.root.position.copy(p.pos);
    this.root.position.addScaledVector(_up.set(0, 1, 0).applyQuaternion(this.orient), drop);

    // ----------------------------------------------------------- weights --
    const w = this.weights;
    const want = {
      swing: attached ? 1 : 0,
      dive: !attached && p.diving ? 1 : 0,
      fall: !attached && !p.diving && !p.grounded ? 1 : 0,
      run: p.grounded && speed > 1.5 ? 1 : 0,
      idle: p.grounded && speed <= 1.5 ? 1 : 0,
    };
    let total = 0;
    for (const k of Object.keys(w)) {
      w[k] = damp(w[k], want[k], 9, dt);
      total += w[k];
    }
    if (total < 1e-4) { w.fall = 1; total = 1; }

    this.runPhase += dt * clamp(speed, 0, 14) * 1.1;

    // Blend the pose directions, then solve each chain from the root outward.
    for (const [bone] of CHAIN) {
      const v = this.blend[bone];
      if (!v) continue;
      v.set(0, 0, 0);
      for (const k of Object.keys(w)) {
        const d = POSES[k][bone];
        if (d) v.addScaledVector(_a.set(d[0], d[1], d[2]), w[k]);
      }
      v.divideScalar(total);
      if (v.lengthSq() < 1e-6) v.set(0, 1, 0);
    }

    // Leg cycle while running, folded in before the aim pass.
    if (w.run > 0.02) {
      const s = Math.sin(this.runPhase) * w.run;
      const c = Math.cos(this.runPhase) * w.run;
      this.blend.LeftUpLeg.z += s * 0.9; this.blend.LeftUpLeg.y -= Math.abs(s) * 0.2;
      this.blend.RightUpLeg.z -= s * 0.9; this.blend.RightUpLeg.y -= Math.abs(s) * 0.2;
      this.blend.LeftArm.z -= c * 0.7; this.blend.RightArm.z += c * 0.7;
    }
    // Legs stream behind you at speed — cheap, and it sells the wind.
    const stream = smoothstep(20, 70, speed) * (1 - w.run);
    if (stream > 0.01) {
      this.blend.LeftUpLeg.z -= stream * 0.5;
      this.blend.RightUpLeg.z -= stream * 0.5;
      this.blend.LeftLeg.z += stream * 0.3;
      this.blend.RightLeg.z += stream * 0.3;
    }

    for (const [, b] of this.bones) {
      const rest = this.rest.get(b.name);
      if (rest) b.quaternion.copy(rest);
    }
    this.root.updateMatrixWorld(true);

    if (this.standIn) return;                          // no skeleton to solve

    for (const [bone, child] of CHAIN) {
      const v = this.blend[bone];
      if (!v) continue;
      _want.copy(v).applyQuaternion(this.orient);
      this.aim(bone, child, _want);
    }

    // The web arm points at the anchor for real, overriding the blended pose.
    if (attached) {
      const side = p.web.side < 0 ? 'Left' : 'Right';
      _want.subVectors(p.web.anchor, p.pos).normalize();
      this.aim(`${side}Arm`, `${side}ForeArm`, _want, 0.9);
      this.aim(`${side}ForeArm`, `${side}Hand`, _want, 0.95);
    }

    for (const side of [-1, 1]) {
      const hand = this.bones.get(side < 0 ? 'LeftHand' : 'RightHand');
      if (hand) hand.getWorldPosition(this.hands[side]);
      else this.hands[side].copy(p.pos);
    }
  }
}
