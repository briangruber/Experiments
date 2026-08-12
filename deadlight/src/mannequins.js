// The mannequins.
//
// They never move while you are looking at them. That is the entire mechanic,
// and it is worth being precise about why it works: the scare is not the
// movement, because the movement is never witnessed. The scare is the
// *comparison* — the player's memory of where one was against where it is now.
// Everything here exists to make that comparison as sharp as possible.
//
// Consequences that fall out of that:
//   · They must be dead still when observed. Not slowed, not easing to a
//     stop — still. Any residual motion tells the player they are alive and
//     replaces dread with information.
//   · They must move in discrete jumps rather than gliding, so the change is
//     large enough to be certain about. A player who is unsure whether it
//     moved does not get scared, they get annoyed.
//   · They must end each jump facing the player. A mannequin that has closed
//     four metres and is still facing a wall reads as a physics bug.
//
// A dressed mannequin that is never activated is just set decoration, which is
// the point: the player cannot tell which of the ones in this room are live.

import * as THREE from 'three';

/** Contact distance — where a live mannequin reaches the player. */
const TOUCH_RANGE = 1.25;
/**
 * Extra distance it keeps early on, shrinking to nothing as aggression rises.
 *
 * Without this they simply walk into the player, and a first grab twenty
 * seconds into a run teaches the wrong lesson: that the mannequins are a
 * timer rather than a thing you can be careful about. Holding at arm's length
 * through the early game means the player spends that time discovering they
 * move at all, which is the part worth having.
 */
const EARLY_STANDOFF = 2.6;
/** It only stalks inside this radius; beyond it, it is furniture. */
const ACTIVE_RANGE = 19;

export class Mannequins {
  constructor(level, player, audio, rng) {
    this.level = level;
    this.player = player;
    this.audio = audio;
    this.rng = rng.fork('mannequins');
    this.items = [];
    this.onTouch = null;
    this.onNoticed = null;
    /** Scales how far and how often they advance. Raised as the run goes on. */
    this.aggression = 0;
  }

  /**
   * Place `count` of them. `keys` are the mannequin asset keys; the mix is
   * shuffled per room so the same sculpt does not repeat in a sight-line.
   */
  populate(scene, assets, count) {
    const keys = assets.byRole('mannequin');
    if (!keys.length) return this;

    const tiles = this.rng.shuffle(this.level.wallTiles());
    const spawn = this.level.startRoom;

    let placed = 0;
    for (const { tx, ty } of tiles) {
      if (placed >= count) break;
      const p = this.level.tileToWorld(tx, ty);
      // Never in the room the player opens their eyes in.
      if (Math.abs(tx - spawn.cx) < 4 && Math.abs(ty - spawn.cy) < 4) continue;
      // Never within a few metres of another one — a crowd is less
      // frightening than a single figure, because a crowd cannot have moved.
      if (this.items.some((m) => m.object.position.distanceTo(p) < 7)) continue;

      const object = assets.instance(this.rng.pick(keys));
      object.position.copy(p);
      object.rotation.y = this.rng.float(0, Math.PI * 2);
      scene.add(object);

      this.items.push({
        object,
        // Roughly half are live. The rest exist to make the live ones
        // deniable — "that one was always there" has to be true sometimes.
        live: this.rng.bool(0.55),
        cooldown: this.rng.float(0, 2),
        lastSeenAt: p.clone(),
        noticed: false,
        moved: 0,
      });
      placed++;
    }
    return this;
  }

  /** Wake them all up a little. Called as objectives complete. */
  setAggression(value) {
    this.aggression = THREE.MathUtils.clamp(value, 0, 1);
  }

  update(dt) {
    const eye = this.player.eyePosition;

    for (const m of this.items) {
      if (!m.live || !this.player.alive) continue;

      const pos = m.object.position;
      const dist = pos.distanceTo(this.player.position);
      if (dist > ACTIVE_RANGE) continue;

      // The head, not the base — a mannequin whose feet are behind a crate is
      // still being looked at.
      const head = new THREE.Vector3(pos.x, pos.y + 1.5, pos.z);
      const observed = this.player.canSee(head, 1.05);

      if (observed) {
        // Frozen. And if it has visibly changed since the player last had
        // eyes on it, that is a scare — reported once per displacement.
        if (m.moved > 0.9 && !m.noticed) {
          m.noticed = true;
          this.onNoticed?.(m, dist);
        }
        m.lastSeenAt.copy(pos);
        m.moved = 0;
        continue;
      }

      m.noticed = false;
      m.cooldown -= dt;
      if (m.cooldown > 0) continue;

      // Out of sight: jump.
      if (dist <= TOUCH_RANGE) {
        this.audio?.stinger(1);
        this.onTouch?.(m);
        m.live = false;
        continue;
      }

      // How close it is willing to come right now.
      const closest = TOUCH_RANGE + EARLY_STANDOFF * (1 - this.aggression);
      const gap = dist - closest;
      if (gap <= 0) continue;

      const stride = Math.min(gap, this.rng.float(0.9, 1.9) * (0.6 + this.aggression));
      const to = new THREE.Vector3().subVectors(this.player.position, pos).setY(0).normalize();
      const next = pos.clone().addScaledVector(to, stride);

      // Refuse to move through geometry — a mannequin standing inside a wall
      // is the fastest way to break the illusion that these are real objects.
      this.level.collide(next, 0.4);
      if (!this.level.lineOfSight(pos, next)) continue;

      m.moved += next.distanceTo(pos);
      pos.copy(next);
      // Face the player, so the change the player comes back to is unmistakable.
      m.object.rotation.y = Math.atan2(
        this.player.position.x - pos.x,
        this.player.position.z - pos.z,
      );
      m.cooldown = this.rng.float(1.5, 3.2) * (1 - this.aggression * 0.55);
    }
  }

  /** Nearest live mannequin to a point, or null. Used by the director when it
   *  wants to stage something the player is about to turn around and see. */
  nearestLive(point, maxDistance = Infinity) {
    let best = null;
    let bestDist = maxDistance;
    for (const m of this.items) {
      if (!m.live) continue;
      const d = m.object.position.distanceTo(point);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }

  /**
   * Put a live mannequin directly behind the player, just outside touching
   * distance. The director uses this for its most reliable trick: make a
   * noise in front, then be there when the player turns back.
   */
  stageBehind(player, distance = 3.2) {
    const behind = player.forward().multiplyScalar(-distance).add(player.position);
    this.level.collide(behind, 0.5);
    if (!this.level.lineOfSight(player.position, behind)) return null;

    const m = this.nearestLive(player.position, 40);
    if (!m) return null;
    m.object.position.copy(behind);
    m.object.rotation.y = Math.atan2(
      player.position.x - behind.x,
      player.position.z - behind.z,
    );
    m.moved = 99;
    m.noticed = false;
    return m;
  }

  reset() {
    for (const m of this.items) m.object.removeFromParent();
    this.items = [];
    this.aggression = 0;
  }
}
