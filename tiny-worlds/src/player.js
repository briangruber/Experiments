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

const COYOTE = 0.12;
// How far the ground may fall away beneath a running keeper before they are
// genuinely airborne rather than just going downhill.
const STICK = 0.42;
// Steepness (1 - cos) past which the ground is a cliff, not a hill.
const MAX_STAND = 0.46;
// World units one full cycle of the walk clip carries the keeper. Everything
// about foot plant follows from this number, and it is not free to choose: it
// has to be the distance the clip's own feet travel per cycle, which is the
// root motion that src/assets.js strips out — 1.58 units on this rig. Set it
// higher and the planted foot slides forward under the keeper; lower and it
// drags back. It read as 3.0 while the clip still carried its root motion,
// because half the apparent travel was the model sliding, not the feet.
const STRIDE = 1.58;
// Clips that play once and hold their last frame rather than looping. Looping
// them restarts the pose mid-air: the fall clip's ends are a full quaternion
// and a half apart, so it lurched every three seconds of descent.
const ONE_SHOT = new Set(['jump', 'fall', 'hurt']);
const BUFFER = 0.16;

export class Player {
  constructor(assets) {
    this.root = new THREE.Group();
    this.height = 1.5;
    this.radius = 0.34;

    this.model = assets.keeper.object;
    this.model.scale.setScalar(this.height);
    // Tripo's rig faces along its own +X — the bbox is wider across Z (shoulder
    // to shoulder) than it is deep. The root frame below treats +Z as forward,
    // so turn the model a quarter turn to match. Verified by rendering the
    // keeper at fixed angles: tools/assets.html?rot=-1.5708 shows its face.
    this.model.rotation.y = assets.keeper.faceOffset ?? 0;
    this.root.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [name, clip] of Object.entries(assets.keeper.clips)) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      if (ONE_SHOT.has(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
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
    this.invuln = 0;
    // Overridable so the harness can sweep it against measured foot skate.
    this.stride = STRIDE;
  }

  // Knocked off your feet: a shove along the surface plus real air, and a
  // moment of mercy so a meteor and a gloom cannot bill you twice for one
  // mistake.
  knock(pushWorld, strength = 1) {
    if (this.invuln > 0 || !this.planet) return false;
    _v.copy(pushWorld).transformDirection(_m.copy(this.planet.group.matrixWorld).invert());
    _v.addScaledVector(this.up, -_v.dot(this.up));
    if (_v.lengthSq() < 1e-6) _v.copy(this.facing);
    _v.normalize();
    // A stumble, not a launch. This used to throw the keeper about six units
    // backwards, so a gloom trailing you turned the walk into "forward, hurled
    // back, forward, hurled back" every few seconds.
    this.vel.addScaledVector(_v, 3.2 + 1.8 * strength);
    this.vel.addScaledVector(this.up, 3.6 + 1.2 * strength);
    this.grounded = false;
    this.airTime = 0.2;
    this.squash = 1.25;
    this.invuln = 1.9;
    this.hurtTime = 0.7;
    return true;
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

  // Ease one clip's weight toward a target. Actions all stay playing; only
  // their weights move, which is what makes the transitions seamless.
  blend(name, target, dt, rate = 9) {
    const action = this.actions[name];
    if (!action) return;
    const w = damp(action.getEffectiveWeight(), target, rate, dt);
    // A one-shot that has already played out sits clamped on its last frame,
    // so re-entering the state has to rewind it.
    if (target > 0.5 && w < 0.05 && ONE_SHOT.has(name)) action.reset();
    action.setEffectiveWeight(w < 0.002 ? 0 : w);
    if (w > 0.002 && !action.isRunning()) action.play();
    // `current` is only a label now, for the debug panel and the harness.
    if (target > 0.5) this.current = name;
  }

  // Kept for the flight, which wants one pose held outright.
  setAnim(name, fade = 0.18) {
    if (!this.actions[name]) return;
    for (const [key, action] of Object.entries(this.actions)) {
      action.setEffectiveWeight(key === name ? 1 : 0);
      if (key === name && !action.isRunning()) action.play();
    }
    this.current = name;
  }

  // `moveWorld` is the desired direction in world space; we bring it into the
  // planet's frame so a spinning world does not drag the controls with it.
  update(dt, { moveWorld, jump, freeze = false }) {
    const planet = this.planet;
    if (!planet) return;
    const def = planet.def;

    this.up.copy(this.local).normalize();

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
      // Platformer hang: lighter on the way up than on the way down, which
      // makes a leap feel deliberate instead of ballistic. And a hard pull
      // back if anything ever throws the keeper properly clear of the world.
      const g = def.gravity ?? 24;
      const rising = radial > 0;
      const far = Math.max(0, this.local.length() / planet.def.radius - 1.9);
      const gravity = g * (rising ? (def.hang ?? 0.86) : 1.06) * (1 + far * 4);
      this.vel.copy(_v).addScaledVector(this.up, radial - gravity * dt);

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
    } else if (wasGrounded && r - floor < STICK && this.vel.dot(this.up) <= 0.5) {
      // Stick to the ground over small drops. Terrain this detailed falls away
      // faster than gravity can follow at running speed, so without this the
      // keeper leaves the surface on every crest — a few centimetres of hop per
      // frame that reads as a stutter, and flickers the walk animation into the
      // jump one. The upward-velocity test keeps a real jump out of it.
      this.local.copy(this.up).multiplyScalar(floor);
      this.vel.addScaledVector(this.up, -this.vel.dot(this.up));
      this.grounded = true;
    } else {
      this.grounded = this.landOnIslet(r, dt) || false;
    }

    // Faces steeper than this cannot be stood on: the keeper slides. Without it
    // they walk straight up cliffs, and being shoved into one leaves them
    // buried, snapped back to the surface every frame — which is the jitter
    // that reads as being stuck.
    if (this.grounded) {
      planet.normalAt(this.up, _n);
      const steep = 1 - clamp(_n.dot(this.up), 0, 1);
      if (steep > MAX_STAND) {
        // Downhill is the part of the surface normal that points sideways.
        _v.copy(_n).addScaledVector(this.up, -_n.dot(this.up));
        if (_v.lengthSq() > 1e-6) {
          _v.normalize();
          const slide = (def.gravity ?? 24) * (steep - MAX_STAND) * 2.2;
          this.vel.addScaledVector(_v, slide * dt);
        }
        this.sliding = true;
      } else {
        this.sliding = false;
      }
    } else {
      this.sliding = false;
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

    this.invuln = Math.max(0, this.invuln - dt);
    // Blink while the mercy window is open.
    const hidden = this.invuln > 0 && Math.floor(this.invuln * 12) % 2 === 0;
    if (this.model.visible === hidden) this.model.visible = !hidden;

    this.squash = damp(this.squash, 1, 9, dt);
    const sq = this.height * this.squash;
    this.model.scale.set(this.height / Math.sqrt(this.squash), sq, this.height / Math.sqrt(this.squash));

    // Lean into a turn and into acceleration. Costs nothing and is most of the
    // difference between a model sliding around and one that is running.
    _v.copy(this.vel).addScaledVector(this.up, -this.vel.dot(this.up));
    const turn = _r.crossVectors(this.up, this.facing).dot(_v) / Math.max(1, this.speed);
    this.lean = damp(this.lean ?? 0, clamp(-turn * 0.5, -0.42, 0.42), 7, dt);
    this.pitch = damp(this.pitch ?? 0, clamp(this.speed / (def.moveSpeed ?? 6.5), 0, 1.4) * 0.1, 5, dt);
    this.model.rotation.z = this.lean;
    this.model.rotation.x = this.pitch;

    // ---- animation
    //
    // Blended by speed rather than switched at thresholds. Crossfading on a
    // threshold pops every time you brush past it — dead obvious when you are
    // running just under the walk/run line — and it cannot express the middle.
    const base = def.moveSpeed ?? 6.5;
    const airborne = !this.grounded && this.airTime > 0.14;
    const rising = this.vel.dot(this.up) > 0.5;
    this.hurtTime = Math.max(0, (this.hurtTime ?? 0) - dt);
    const reeling = this.hurtTime > 0 && !!this.actions.hurt;

    const jog = clamp((this.speed - 0.6) / (base * 0.9), 0, 1);
    const ground = reeling || airborne ? 0 : 1;
    this.blend('idle', ground * (1 - jog), dt);
    // One locomotion cycle, played at whatever rate the ground demands. The
    // run clip is not blended in: its first and last frames are a third of a
    // quaternion apart, so it popped once per cycle, and cross-blending two
    // cycles whose feet are out of phase is its own kind of mush.
    this.blend('walk', ground * jog, dt);
    // Rising and falling look nothing alike, so they are separate clips: the
    // takeoff holds while you climb, and the fall takes over past the apex.
    // Faster in than out, so a jump reads immediately but a landing settles.
    this.blend('jump', reeling ? 0 : (airborne && rising ? 1 : 0), dt, 16);
    this.blend('fall', reeling ? 0 : (airborne && !rising ? 1 : 0), dt, 11);
    this.blend('hurt', reeling ? 1 : 0, dt, 18);

    // Play rate from stride, not from a guessed multiplier. One cycle of the
    // clip should carry the keeper STRIDE units, so the rate is however many
    // cycles per second that speed needs. The old code ran the clip at 1.15x
    // while the keeper crossed six units a second: the legs cycled about five
    // times too slowly for the ground going by, which is what "the walk does
    // not fit the motion" looks like.
    const cycle = this.actions.walk?.getClip().duration ?? 1;
    const cadence = clamp((this.speed / (this.stride ?? STRIDE)) * cycle, 0.35, 9);
    this.actions.walk?.setEffectiveTimeScale(cadence);
    this.mixer.update(dt);

    if (this.grounded && this.speed > 0.5) {
      this.stepTimer -= dt * clamp(this.speed / base, 0.5, 2);
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
