// The keeper. Lives in a planet's local space, walks on a sphere, and has no
// idea the ground under them is a noise function.
//
// Gravity is radial, "up" is wherever you happen to be standing, and the model
// leans into the terrain normal without the physics ever leaving the sphere.

import * as THREE from 'three';
import { clamp, lerp, damp } from './noise.js';

const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _target = new THREE.Vector3();
const _m = new THREE.Matrix4();
const YUP = new THREE.Vector3(0, 1, 0);

const COYOTE = 0.12;
const BUFFER = 0.16;

export class Player {
  constructor(assets) {
    this.root = new THREE.Group();
    this.height = 1.15;
    this.radius = 0.34;

    this.model = assets.keeper.object;
    this.model.scale.setScalar(this.height);
    // Tripo's rig faces -Z; the frame below treats +Z as forward.
    this.model.rotation.y = Math.PI;
    this.root.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [name, clip] of Object.entries(assets.keeper.clips)) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.setEffectiveWeight(name === 'idle' ? 1 : 0);
      action.play();
      this.actions[name] = action;
    }
    this.current = 'idle';

    // The lantern the keeper carries: the only light on the dark world.
    this.lantern = new THREE.PointLight(0xffcf8a, 0, 22, 1.5);
    this.lantern.position.set(0, 0.9, -0.15);
    this.root.add(this.lantern);

    this.local = new THREE.Vector3(0, 1, 0);
    this.vel = new THREE.Vector3();
    this.facing = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.grounded = false;
    this.airTime = 0;
    this.jumpBuffer = 0;
    this.squash = 1;
    this.speed = 0;
    this.onLand = null;
    this.onJump = null;
    this.onStep = null;
    this.stepTimer = 0;
    this.platform = null;
  }

  attachTo(planet, dir, { lift = 0 } = {}) {
    if (this.planet && this.planet.group !== planet.group) this.planet.group.remove(this.root);
    this.planet = planet;
    planet.group.add(this.root);
    this.local.copy(dir).normalize().multiplyScalar(planet.groundRadius(dir) + lift);
    this.up.copy(dir).normalize();
    this.vel.set(0, 0, 0);
    // Face along the local surface rather than whatever the last world left us.
    _tangent.set(0, 1, 0);
    if (Math.abs(this.up.y) > 0.9) _tangent.set(1, 0, 0);
    this.facing.crossVectors(_tangent, this.up).normalize();
    this.grounded = lift <= 0.01;
    this.lantern.intensity = planet.def.dark ? 11 : 0;
    this.syncTransform();
  }

  worldPosition(out = new THREE.Vector3()) {
    out.copy(this.local);
    return this.planet ? this.planet.group.localToWorld(out) : out;
  }

  worldUp(out = new THREE.Vector3()) {
    out.copy(this.up);
    return this.planet ? out.transformDirection(this.planet.group.matrixWorld) : out;
  }

  setAnim(name, fade = 0.18) {
    if (this.current === name || !this.actions[name]) return;
    const next = this.actions[name];
    next.reset().play().setEffectiveTimeScale(next.timeScale || 1).fadeIn(fade);
    this.actions[this.current]?.fadeOut(fade);
    this.current = name;
  }

  // `moveWorld` is the desired direction in world space; we bring it into the
  // planet's frame so a spinning world does not drag the controls with it.
  update(dt, { moveWorld, jump, freeze = false }) {
    const planet = this.planet;
    if (!planet) return;
    const def = planet.def;

    this.up.copy(this.local).normalize();
    const groundR = planet.groundRadius(this.up);

    if (!freeze) {
      _tangent.copy(moveWorld);
      if (_tangent.lengthSq() > 1e-6) {
        _tangent.transformDirection(_m.copy(planet.group.matrixWorld).invert());
        _tangent.addScaledVector(this.up, -_tangent.dot(this.up));
        if (_tangent.lengthSq() > 1e-6) _tangent.normalize();
      } else {
        _tangent.set(0, 0, 0);
      }

      const wanted = (def.moveSpeed || 6.5) * (this.sprint ? 1.5 : 1);
      _target.copy(_tangent).multiplyScalar(wanted);

      // Split velocity into radial (gravity's business) and tangential (ours).
      const radial = this.vel.dot(this.up);
      _v.copy(this.vel).addScaledVector(this.up, -radial);
      const grip = this.grounded ? (def.grip ?? 14) : 2.2;
      _v.x = damp(_v.x, _target.x, grip, dt);
      _v.y = damp(_v.y, _target.y, grip, dt);
      _v.z = damp(_v.z, _target.z, grip, dt);
      this.vel.copy(_v).addScaledVector(this.up, radial - (def.gravity ?? 24) * dt);

      this.jumpBuffer = jump ? BUFFER : Math.max(0, this.jumpBuffer - dt);
      const canJump = this.grounded || this.airTime < COYOTE;
      if (this.jumpBuffer > 0 && canJump) {
        this.jumpBuffer = 0;
        this.airTime = COYOTE;
        this.grounded = false;
        const rv = this.vel.dot(this.up);
        this.vel.addScaledVector(this.up, (def.jumpSpeed ?? 11) - rv);
        this.squash = 0.78;
        this.onJump?.();
      }

      this.local.addScaledVector(this.vel, dt);
    }

    // ---- ground contact
    this.up.copy(this.local).normalize();
    const r = this.local.length();
    const floor = planet.groundRadius(this.up);
    const wasGrounded = this.grounded;
    this.grounded = false;
    this.platform = null;

    if (r <= floor) {
      this.local.copy(this.up).multiplyScalar(floor);
      const radial = this.vel.dot(this.up);
      if (radial < 0) this.vel.addScaledVector(this.up, -radial);
      this.grounded = true;
    } else {
      this.grounded = this.landOnIslet(r, dt) || false;
    }

    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.18) {
        this.squash = clamp(1 - Math.min(0.4, this.fallSpeed / 40), 0.6, 1);
        this.onLand?.(Math.min(1, this.fallSpeed / 22));
      }
      this.airTime = 0;
      this.fallSpeed = 0;
    } else {
      this.airTime += dt;
      this.fallSpeed = Math.max(this.fallSpeed ?? 0, -this.vel.dot(this.up));
    }

    // ---- orientation
    _v.copy(this.vel).addScaledVector(this.up, -this.vel.dot(this.up));
    this.speed = _v.length();
    if (this.speed > 0.35) {
      _v.normalize();
      this.facing.lerp(_v, 1 - Math.exp(-11 * dt));
      this.facing.addScaledVector(this.up, -this.facing.dot(this.up));
      if (this.facing.lengthSq() > 1e-6) this.facing.normalize();
    }

    // Stand along the terrain normal, but only most of the way: fully aligned
    // looks like the model is glued to a polygon, radial looks like it floats.
    planet.normalAt(this.up, _n);
    _f.copy(this.up).lerp(_n, this.grounded ? 0.55 : 0.12).normalize();
    this.syncTransform(_f);

    this.squash = damp(this.squash, 1, 9, dt);
    const sq = this.height * this.squash;
    this.model.scale.set(this.height / Math.sqrt(this.squash), sq, this.height / Math.sqrt(this.squash));

    // ---- animation
    const moving = this.speed > 0.5;
    if (!this.grounded && this.airTime > 0.14) this.setAnim('jump', 0.12);
    else if (moving && this.speed > (def.moveSpeed ?? 6.5) * 1.12) this.setAnim('run');
    else if (moving) this.setAnim('walk');
    else this.setAnim('idle', 0.25);

    const cadence = clamp(this.speed / (def.moveSpeed ?? 6.5), 0.55, 1.9);
    if (this.actions.walk) this.actions.walk.setEffectiveTimeScale(cadence * 1.15);
    if (this.actions.run) this.actions.run.setEffectiveTimeScale(clamp(cadence, 0.8, 1.5));
    this.mixer.update(dt);

    if (this.grounded && moving) {
      this.stepTimer -= dt * cadence;
      if (this.stepTimer <= 0) { this.stepTimer = 0.34; this.onStep?.(this.speed); }
    }
  }

  // Bobbing platforms: forgiving disc-on-top collision, with the platform's
  // own vertical motion handed to the player so they ride it.
  landOnIslet(r, dt) {
    const islets = this.planet.islets;
    if (!islets) return false;
    for (const islet of islets) {
      const top = islet.y + islet.thickness * 0.5;
      const angle = this.up.angleTo(islet.dir);
      if (angle * islet.y > islet.radius * 0.94) continue;
      const radial = this.vel.dot(this.up);
      if (r <= top + 0.12 && r > top - 0.85 && radial <= (islet.vy ?? 0) + 0.5) {
        this.local.copy(this.up).multiplyScalar(top);
        this.vel.addScaledVector(this.up, (islet.vy ?? 0) - radial);
        this.platform = islet;
        return true;
      }
    }
    return false;
  }

  syncTransform(upOverride) {
    _n.copy(upOverride || this.up);
    _f.copy(this.facing).addScaledVector(_n, -this.facing.dot(_n));
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1).cross(_n);
    _f.normalize();
    _r.crossVectors(_n, _f).normalize();
    _m.makeBasis(_r, _n, _f);
    this.root.quaternion.setFromRotationMatrix(_m);
    this.root.position.copy(this.local);
  }

  // Used by the flight between worlds, which drives position directly.
  setLocal(pos, up) {
    this.local.copy(pos);
    this.up.copy(up).normalize();
    this.syncTransform();
  }
}
