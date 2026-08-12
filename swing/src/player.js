// Swing physics.
//
// The player is a point mass. A web is a one-sided distance constraint: it only
// acts when the rope is taut, which is what makes the motion read as a pendulum
// rather than a rigid arm. Reeling in pulls toward the anchor and ratchets the
// length down, so a well-timed pull on the downswing trades height for speed
// exactly the way angular momentum says it should.

import * as THREE from 'three';
import { clamp, damp, smoothstep } from './util.js';

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
const STREET_CLEAR = 14;             // no web anchors below this height

/**
 * Candidate directions for the anchor search, as (yaw°, pitch°) offsets from the
 * player's *horizontal* heading. Measuring from the horizon rather than from the
 * camera's forward vector matters: while diving you are looking almost straight
 * down, and a fan hung off that direction can only ever find the street.
 */
const PITCHES = [28, 16, 40, 6, 54, 68];

/**
 * Yaw offsets are measured *outward* from the heading, on the firing hand's own
 * side — the right trigger sweeps to your right, the left trigger to your left.
 * A small negative entry lets each hand reach a little across the centre line so
 * a grip dead ahead is still catchable, but the bulk of the cone is committed to
 * one side. That commitment is the whole control scheme: the hand you press is
 * the side you swing around.
 *
 * Note the sign. Rotating the heading about +Y by a positive angle turns it
 * toward −X, while `basis.right` is +X, so an outward angle becomes a rotation
 * of `-side * outward`.
 */
const OUTWARD = [-8, 6, 20, 34, 50, 68];
const FAN = [];
for (const pitch of PITCHES) {
  for (const out of OUTWARD) FAN.push([out, pitch]);
}
/**
 * Fallback sweep, used only when the hand's own cone comes up empty: behind, and
 * across to the other side. Standing with your nose against a facade every
 * forward ray hits it a couple of metres out and there is nothing to grab, while
 * a perfectly good tower sits behind you. Players read that as the web being
 * broken, so widen the search rather than make them turn on the spot.
 */
const FAN_WIDE = [];
for (const pitch of PITCHES) {
  for (const out of [88, 110, 140, 170, -30, -55, -85]) FAN_WIDE.push([out, pitch]);
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
    this.wallTime = 0;
    this.markPos = new THREE.Vector3();
    this.markTime = 0;
  }

  reset(x = 0, z = 0) {
    const h = this.city.heightAt(x, z);
    this.pos.set(x, Math.max(h + 40, 90), z);
    this.vel.set(0, 0, -18);
    this.prev.copy(this.pos);
    this.markPos.copy(this.pos);
    this.markTime = 0;
    this.web.active = false;
    this.grounded = false;
    this.airTime = 0;
    this.events.push('respawn');
  }

  /**
   * Sweep one fan of candidate directions and return the best anchor found.
   * `side` is -1 for the left hand, +1 for the right.
   */
  searchFan(fan, side, basis) {
    const origin = _tmp.copy(this.pos);
    let best = null, bestScore = -Infinity;

    for (const [outDeg, pitchDeg] of fan) {
      // Outward angle on the firing hand's side, converted to a heading rotation.
      const yaw = THREE.MathUtils.degToRad(-side * outDeg);
      const pitch = THREE.MathUtils.degToRad(pitchDeg);
      _dir.copy(basis.flat);
      _q.setFromAxisAngle(this.up, yaw);
      _dir.applyQuaternion(_q);
      // `_tan` is the axis to pitch about: right of the heading. Rotating by
      // +pitch about it tilts the ray up, which is the whole point of the fan —
      // with the sign flipped it quietly searches the pavement instead.
      _tan.crossVectors(_dir, this.up).normalize();
      _q.setFromAxisAngle(_tan, pitch);
      _dir.applyQuaternion(_q).normalize();

      const hit = this.city.raycast(origin, _dir, ROPE_MAX, _hit);
      if (!hit || hit.distance < 8) continue;

      // No grips down in the gutter: a rope tied near the pavement cannot carry
      // a swing over it no matter where you are hanging from.
      if (hit.point.y < STREET_CLEAR) continue;

      // The anchor has to be above you — though the further out it is, the more
      // slack that rule gets, because you will have fallen well below it by the
      // time the rope pulls taut. Up close it has to be genuinely overhead, or
      // it is a tether rather than a swing.
      const dy = hit.point.y - this.pos.y;
      if (dy < Math.max(6 - 0.28 * hit.distance, -0.12 * hit.distance)) continue;

      // How far below the roofline the anchor sits. This is the single most
      // important term: a grip halfway down a flat facade swings you straight
      // into that same facade, while one at the parapet carries you over the
      // top of the building. Sample just inside the surface so a hit exactly on
      // the face still resolves to the building it belongs to.
      _n.copy(hit.point).addScaledVector(hit.normal, -0.5);
      const belowRoof = Math.max(0, this.city.heightAt(_n.x, _n.z) - hit.point.y);
      const clearScore = 1 - smoothstep(2, 26, belowRoof);

      // Prefer anchors that give a long, high arc, roughly where the player aims.
      const heightScore = smoothstep(-8, 55, dy) * (1 - 0.3 * smoothstep(80, 130, dy));
      const distScore = 1 - Math.abs(hit.distance - 46) / 90;
      // Favour a grip out to the side over one dead ahead: that is what bends the
      // arc around the building and makes the two triggers read differently.
      const spreadScore = 1 - Math.abs(outDeg - 30) / 90;
      const topScore = hit.normal.y > 0.5 ? 0.5 : 0;      // straight onto a roof
      const score = clearScore * 1.6 + heightScore * 1.2 + distScore * 0.8
        + spreadScore * 0.9 + topScore;

      if (score > bestScore) {
        bestScore = score;
        best = { point: hit.point.clone(), distance: hit.distance, score };
      }
    }
    return best;
  }

  /**
   * What this hand would grab right now, without firing. The HUD uses it to
   * light the side pips, so the mapping between trigger and direction is
   * visible before you commit to it.
   */
  probe(side, basis) {
    return this.searchFan(FAN, side, basis) || this.searchFan(FAN_WIDE, side, basis);
  }

  /**
   * Fire whichever hand has the better grip. One-button play rests entirely on
   * this: the player says "swing", and the side is chosen for them by the same
   * scoring the two triggers use, so the arc still bends around a building
   * rather than into it.
   */
  tryAttachAuto(basis) {
    const left = this.probe(-1, basis);
    const right = this.probe(1, basis);
    if (!left && !right) {
      this.missCd = 0.28;
      this.events.push('miss');
      return false;
    }
    const pickRight = !left || (right && right.score >= left.score);
    return this.attachTo(pickRight ? right : left, pickRight ? 1 : -1);
  }

  /** Fire a web: the hand's own cone first, then the wide sweep. */
  tryAttach(side, basis) {
    const best = this.probe(side, basis);

    if (!best) {
      this.missCd = 0.28;                              // stop re-firing the fan every frame
      this.events.push('miss');
      return false;
    }
    return this.attachTo(best, side);
  }

  /** Commit to an anchor the search already chose. */
  attachTo(best, side) {
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
    if (input.simple) {
      if (input.web && !web.active && this.missCd <= 0) this.tryAttachAuto(basis);
      if (!input.web && web.active) this.release();
    }
    if (input.webLeft && !(web.active && web.side === -1) && this.missCd <= 0) {
      if (web.active) this.release();
      this.tryAttach(-1, basis);
    }
    if (input.webRight && !(web.active && web.side === 1) && this.missCd <= 0) {
      if (web.active) this.release();
      this.tryAttach(1, basis);
    }
    if (!input.simple && web.active && !input.webLeft && !input.webRight) this.release();

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
      // Rope floor: if the arc would drag through the pavement, ratchet the
      // rope shorter so the next pass bottoms out above the street instead of
      // grinding along it.
      if (this.pos.y < 9) {
        web.length = Math.max(REEL_MIN, Math.min(web.length, this.pos.distanceTo(web.anchor)));
      }
      if (dist > ROPE_MAX * 1.4) this.release();          // snapped
    }

    this.collide(dt);

    // A web that is dragging you along a wall is a deadlock: the constraint
    // pulls you in, the collision push-out shoves you back, and the pair of them
    // cancel every metre of progress. Let it snap instead.
    if (web.active && this.wallTime > 0.3) {
      this.release();
      this.pos.addScaledVector(this.contact, 0.6);
      this.missCd = 0.2;
      this.events.push('snap');
    }

    // General deadlock guard. A constraint and a collision push-out can cancel
    // each other exactly, leaving the player with plenty of velocity and no
    // movement at all; nothing about a real swing keeps you inside a two-metre
    // box for half a second, so drop the web and let gravity sort it out.
    this.markTime += dt;
    if (this.markTime >= 0.5) {
      if (web.active && this.pos.distanceTo(this.markPos) < 2) {
        this.release();
        this.missCd = 0.25;
        this.events.push('snap');
      }
      this.markPos.copy(this.pos);
      this.markTime = 0;
    }

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

    // A web always wins over standing: touching down mid-swing should drag you
    // back off the surface, never park you there holding a rope.
    const canGround = !this.web.active;

    // Street level. Friction has to be expressed as a rate, not a per-frame
    // multiplier: at 60 Hz a flat 0.9 is a factor of 10^-3 per second, which
    // silently welds the player to the tarmac.
    if (this.pos.y < RADIUS) {
      this.pos.y = RADIUS;
      this.contact.set(0, 1, 0);
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = canGround;
      const k = Math.exp(-(canGround ? 2.4 : 0.5) * dt);
      this.vel.x *= k; this.vel.z *= k;
      this.wallTime = 0;
      return;
    }

    if (!hits) {
      this.wallTime = 0;
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
      const k = Math.exp(-(canGround ? 1.8 : 0.4) * dt);
      this.vel.x *= k; this.vel.z *= k;
      this.grounded = canGround;
      this.wallTime = 0;
      this.airTime = 0;
    } else {
      // Wall: shave off the component into the surface and keep sliding. The
      // speed penalty is proportional to how hard you hit, so grazing a facade
      // is nearly free — otherwise a glancing touch while swinging past applies
      // a flat penalty every frame it lasts, and pins you to the wall.
      if (into < 0) {
        this.vel.addScaledVector(this.contact, -into);
        const impact = -into;
        if (impact > 5) {
          this.vel.multiplyScalar(clamp(1 - impact / 110, 0.55, 0.99));
          this.events.push(impact > 26 ? 'smack' : 'scrape');
        }
      }
      this.wallTime += dt;
      this.grounded = false;
    }
  }
}
