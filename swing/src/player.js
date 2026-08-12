// Swing physics.
//
// The player is a point mass. A web is a one-sided distance constraint: it only
// acts when the rope is taut, which is what makes the motion read as a pendulum
// rather than a rigid arm. Reeling in pulls toward the anchor and ratchets the
// length down, so a well-timed pull on the downswing trades height for speed
// exactly the way angular momentum says it should.

import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep } from './util.js';

const GRAVITY = 26;
const MAX_SPEED = 155;
const AIR_DRAG = 0.0086;             // quadratic: terminal velocity ~55 m/s
const DIVE_DRAG = 0.0032;            // tucked, terminal velocity ~90 m/s
const SWING_THRUST = 26;             // pumping the swing
const AIR_STEER = 15;
const DIVE_ACCEL = 46;
const REEL_ACCEL = 34;
const REEL_MIN = 9;
const ROPE_MAX = 105;
const ROPE_MIN = 8;
const BOOST_IMPULSE = 26;
const BOOST_COOLDOWN = 1.15;
const RADIUS = 1.1;
const RUN_SPEED = 13;
const JUMP = 13.5;

/** Candidate directions for the anchor search, as (yaw°, pitch°) offsets. */
const FAN = [];
for (const pitch of [26, 14, 38, 4, 50]) {
  for (const yaw of [0, 12, -12, 26, -26, 40, -40, 56, -56]) FAN.push([yaw, pitch]);
}

const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, index: -1 };
const _q = new THREE.Quaternion();

export class Player {
  constructor(city) {
    this.city = city;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.contact = new THREE.Vector3();

    this.web = { active: false, side: 1, anchor: new THREE.Vector3(), length: 0, age: 0 };
    this.grounded = false;
    this.diving = false;
    this.boostTimer = 0;
    this.airTime = 0;
    this.speed = 0;
    /** Set for one frame when a web attaches / releases / misses, for FX + audio. */
    this.events = [];
    this.nearMiss = 0;
    this.reeling = false;
    this.missCd = 0;
  }

  reset(x = 0, z = 0) {
    const h = this.city.heightAt(x, z);
    this.pos.set(x, Math.max(h + 40, 90), z);
    this.vel.set(0, 0, -18);
    this.prev.copy(this.pos);
    this.web.active = false;
    this.grounded = false;
    this.airTime = 0;
    this.events.push('respawn');
  }

  /** Look for something to swing from. `side` is -1 for the left hand, +1 right. */
  tryAttach(side, basis) {
    const origin = _tmp.copy(this.pos);
    let best = null, bestScore = -Infinity;

    for (const [yawDeg, pitchDeg] of FAN) {
      // Bias the fan toward the requested hand so the two triggers feel distinct.
      const yaw = THREE.MathUtils.degToRad(yawDeg + side * 10);
      const pitch = THREE.MathUtils.degToRad(pitchDeg);
      _dir.copy(basis.forward);
      _q.setFromAxisAngle(this.up, yaw);
      _dir.applyQuaternion(_q);
      _tan.crossVectors(_dir, this.up).normalize();     // right of this direction
      _q.setFromAxisAngle(_tan, -pitch);
      _dir.applyQuaternion(_q).normalize();

      const hit = this.city.raycast(origin, _dir, ROPE_MAX, _hit);
      if (!hit || hit.distance < 6) continue;

      const dy = hit.point.y - this.pos.y;
      if (dy < 3) continue;                              // must be above, or it is a tether not a swing

      // Prefer anchors that give a long, high arc, roughly where the player aims.
      const heightScore = smoothstep(2, 30, dy) * (1 - 0.4 * smoothstep(70, 120, dy));
      const distScore = 1 - Math.abs(hit.distance - 46) / 90;
      const aimScore = 1 - Math.abs(yawDeg) / 110;
      const sideScore = Math.sign(yawDeg) === side ? 0.12 : 0;
      const score = heightScore * 1.35 + distScore * 0.8 + aimScore * 0.7 + sideScore;

      if (score > bestScore) {
        bestScore = score;
        best = { point: hit.point.clone(), distance: hit.distance };
      }
    }

    if (!best) {
      this.missCd = 0.28;                              // stop re-firing the fan every frame
      this.events.push('miss');
      return false;
    }

    this.web.active = true;
    this.web.side = side;
    this.web.anchor.copy(best.point);
    this.web.length = clamp(best.distance, ROPE_MIN, ROPE_MAX);
    this.web.age = 0;
    // Firing from a rooftop should pull you off it, not leave you standing.
    if (this.grounded) {
      this.grounded = false;
      this.vel.y = Math.max(this.vel.y, 6.5);
      this.pos.y += 0.4;
    }
    this.events.push('attach');
    return true;
  }

  release() {
    if (!this.web.active) return;
    this.web.active = false;
    // A release near the bottom of the arc keeps the momentum you earned; add a
    // small kick so letting go always feels like a launch.
    if (this.vel.y > 0) this.vel.y += 2.5;
    this.events.push('release');
  }

  update(dt, input, basis) {
    this.events.length = 0;
    this.prev.copy(this.pos);
    const web = this.web;

    // ------------------------------------------------------------- input --
    this.missCd = Math.max(0, this.missCd - dt);
    if (input.webLeft && !(web.active && web.side === -1) && this.missCd <= 0) {
      if (web.active) this.release();
      this.tryAttach(-1, basis);
    }
    if (input.webRight && !(web.active && web.side === 1) && this.missCd <= 0) {
      if (web.active) this.release();
      this.tryAttach(1, basis);
    }
    if (web.active && !input.webLeft && !input.webRight) this.release();

    this.diving = input.dive && !this.grounded;
    this.reeling = false;
    this.boostTimer = Math.max(0, this.boostTimer - dt);

    if (input.boost) {
      if (this.grounded) {
        this.vel.y = JUMP;
        this.grounded = false;
        this.events.push('jump');
      } else if (this.boostTimer <= 0) {
        _dir.copy(basis.forward).normalize();
        this.vel.addScaledVector(_dir, BOOST_IMPULSE);
        this.vel.y += 5;
        this.boostTimer = BOOST_COOLDOWN;
        this.events.push('boost');
      }
    }

    // ----------------------------------------------------------- dynamics --
    if (this.grounded) {
      this.updateGround(dt, input, basis);
    } else {
      this.vel.y -= GRAVITY * dt;

      if (web.active) {
        web.age += dt;
        _d.subVectors(this.pos, web.anchor);
        const dist = _d.length() || 1e-6;
        _n.copy(_d).divideScalar(dist);

        // Pump: thrust along the tangent, in the direction already travelling.
        _tan.copy(this.vel).addScaledVector(_n, -this.vel.dot(_n));
        if (_tan.lengthSq() > 1e-4) {
          _tan.normalize();
          const align = clamp(_tan.dot(basis.forward), -1, 1);
          this.vel.addScaledVector(_tan, SWING_THRUST * (0.55 + 0.45 * align) * dt);
        }

        // Steer the arc sideways.
        if (input.steer) this.vel.addScaledVector(basis.right, input.steer * AIR_STEER * 0.8 * dt);

        // Reel in — pulls toward the anchor and shortens the rope behind you.
        if (input.reel || input.dive) {
          this.reeling = true;
          this.vel.addScaledVector(_n, -REEL_ACCEL * dt);
          web.length = Math.max(REEL_MIN, Math.min(web.length, dist));
        }
      } else {
        if (input.steer) this.vel.addScaledVector(basis.right, input.steer * AIR_STEER * dt);
        if (this.diving) {
          _dir.copy(basis.forward);
          _dir.y = Math.min(_dir.y, -0.35);
          _dir.normalize();
          this.vel.addScaledVector(_dir, DIVE_ACCEL * dt);
        } else if (input.reel) {
          // Pull up out of a dive: trade speed for lift.
          this.vel.y += 16 * dt;
        }
      }

      // Quadratic drag, tuned by terminal velocity: ~55 m/s upright, ~90 tucked.
      const drag = this.diving ? DIVE_DRAG : AIR_DRAG;
      const sp = this.vel.length();
      if (sp > 0.01) this.vel.addScaledVector(this.vel, -drag * sp * dt);
      this.airTime += dt;
    }

    if (this.vel.lengthSq() > MAX_SPEED * MAX_SPEED) this.vel.setLength(MAX_SPEED);

    // --------------------------------------------------------- integrate --
    this.pos.addScaledVector(this.vel, dt);

    // Rope constraint: taut only, and only ever removes outward velocity.
    if (web.active) {
      _d.subVectors(this.pos, web.anchor);
      const dist = _d.length();
      if (dist > web.length) {
        _n.copy(_d).divideScalar(dist || 1e-6);
        this.pos.copy(web.anchor).addScaledVector(_n, web.length);
        const radial = this.vel.dot(_n);
        if (radial > 0) this.vel.addScaledVector(_n, -radial * 1.002);
      }
      if (dist > ROPE_MAX * 1.4) this.release();          // snapped
    }

    this.collide(dt);
    this.speed = this.vel.length();

    // Track how close the last frame passed to a wall — used for the near-miss bonus.
    this.nearMiss = Math.max(0, this.nearMiss - dt * 2);

    if (this.pos.y < -30) this.reset(this.pos.x, this.pos.z);
    return this;
  }

  updateGround(dt, input, basis) {
    _dir.set(0, 0, 0);
    if (input.throttle) _dir.addScaledVector(basis.forward, input.throttle);
    if (input.steer) _dir.addScaledVector(basis.right, input.steer);
    _dir.y = 0;
    if (_dir.lengthSq() > 1e-4) {
      _dir.normalize().multiplyScalar(RUN_SPEED);
      this.vel.x = damp(this.vel.x, _dir.x, 9, dt);
      this.vel.z = damp(this.vel.z, _dir.z, 9, dt);
    } else {
      this.vel.x = damp(this.vel.x, 0, 11, dt);
      this.vel.z = damp(this.vel.z, 0, 11, dt);
    }
    this.vel.y -= GRAVITY * dt;
    this.airTime = 0;
  }

  collide(dt) {
    const hits = this.city.resolve(this.pos, RADIUS + 0.4, this.contact);

    // Street level.
    if (this.pos.y < RADIUS) {
      this.pos.y = RADIUS;
      this.contact.set(0, 1, 0);
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      this.vel.x *= 0.9; this.vel.z *= 0.9;
      return;
    }

    if (!hits) {
      // Leaving a ledge: stay grounded only while something is underfoot.
      if (this.grounded && this.pos.y - this.city.heightAt(this.pos.x, this.pos.z) > RADIUS + 0.6) {
        this.grounded = false;
      }
      return;
    }

    const into = this.vel.dot(this.contact);
    const landing = this.contact.y > 0.55;

    if (landing) {
      if (into < 0) {
        if (this.web.active && into < -22) this.release();
        this.vel.addScaledVector(this.contact, -into);   // stop the descent
        if (this.airTime > 0.35 && -into > 12) this.events.push('land');
      }
      this.vel.x *= 0.92; this.vel.z *= 0.92;
      this.grounded = true;
      this.airTime = 0;
    } else {
      // Wall: shave off the component into the surface but keep sliding, so a
      // clipped corner costs speed instead of ending the run.
      if (into < 0) {
        this.vel.addScaledVector(this.contact, -into * 1.15);
        this.vel.multiplyScalar(0.86);
        if (-into > 26) this.events.push('smack');
        else this.events.push('scrape');
      }
      this.grounded = false;
    }
  }
}
