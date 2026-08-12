// The thing in the corridors.
//
// It is a state machine over whatever Tripo clips survived generation — the
// shipped set is idle, walk and lunge — with one governing idea: it should almost always be somewhere the
// player has just been. A creature that beelines is only frightening once,
// because after the first death the player knows it is coming and simply
// walks away from it. This one investigates, loses the trail, and circles —
// so the player is never sure whether the corridor behind them is empty.
//
// Locomotion speed and playback rate are locked together using the stride
// speed measured off the original root motion (see tools/optimize.mjs), so
// the feet do not skate at any of the speeds aggression puts it through.

import * as THREE from 'three';
import { makeAnimated } from './assets.js';

const STATE = {
  DORMANT: 'dormant',
  PATROL: 'patrol',
  INVESTIGATE: 'investigate',
  HUNT: 'hunt',
  ATTACK: 'attack',
  STAGGER: 'stagger',
};

/** How far it can hear a player making full noise, in metres. */
const HEARING = 26;
/** Straight-line sight range with the torch on, and without. */
const SIGHT_LIT = 21;
const SIGHT_DARK = 6.5;
/** Distance at which it commits to a kill. */
const KILL_RANGE = 1.5;

export class Creature {
  constructor(level, player, audio, rng) {
    this.level = level;
    this.player = player;
    this.audio = audio;
    this.rng = rng.fork('creature');

    this.state = STATE.DORMANT;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    /** 0..1 — raised by objectives completed, drives speed and persistence. */
    this.aggression = 0;
    /** Rises while it can perceive the player; a hunt starts when it fills. */
    this.awareness = 0;

    this.root = null;
    this.mixer = null;
    this.actions = null;
    this.current = null;

    this.path = [];
    this._repathIn = 0;
    this._stateTime = 0;
    this._target = new THREE.Vector3();
    this._lastSeen = new THREE.Vector3();
    this._voiceIn = 4;
    this._breathIn = 2;

    this.onAttack = null;
    this.onSighted = null;
    this._wasVisible = false;
  }

  async load(assets, scene) {
    const rig = await makeAnimated(assets.get('creature'));
    this.root = rig.root;
    this.mixer = rig.mixer;
    this.actions = rig.actions;
    this.meta = rig.meta;

    // Metres travelled per second of clip at this asset's world scale — the
    // measured normalised stride times the scale that got it to `height`.
    const bounds = rig.meta.bounds;
    const modelHeight = bounds ? bounds.max[1] - bounds.min[1] : 1;
    this._scale = rig.meta.height / modelHeight;
    this._clipSpeed = {};
    for (const [name, m] of Object.entries(rig.meta.motion ?? {})) {
      this._clipSpeed[name] = (m.speed ?? 0) * this._scale;
    }

    this.root.visible = false;
    scene.add(this.root);
    this.#play('idle', 0);
    return this;
  }

  spawn(position) {
    this.position.copy(position);
    this.root.position.copy(position);
    this.root.visible = true;
    this.state = STATE.PATROL;
    this.awareness = 0;
    this.path = [];
    this._repathIn = 0;
    this.#pickWanderTarget();
  }

  despawn() {
    if (this.root) this.root.visible = false;
    this.state = STATE.DORMANT;
  }

  get active() {
    return this.state !== STATE.DORMANT;
  }

  get distanceToPlayer() {
    return this.position.distanceTo(this.player.position);
  }

  /** Speed for the current state, in m/s. */
  get speed() {
    const boost = 1 + this.aggression * 0.45;
    switch (this.state) {
      case STATE.HUNT: return 3.5 * boost;
      case STATE.INVESTIGATE: return 1.9 * boost;
      case STATE.PATROL: return 1.15;
      default: return 0;
    }
  }

  // ---------------------------------------------------------------- senses

  /**
   * How strongly it currently perceives the player, 0..1.
   *
   * Sound falls off with distance and needs no line of sight — a sprint two
   * rooms away is still a sprint. Sight needs both a clear line and the torch,
   * which is the whole reason the torch is a liability.
   */
  perceive() {
    const player = this.player;
    if (!player.alive) return 0;
    const dist = this.distanceToPlayer;

    const heardRange = HEARING * (0.35 + player.noise * 0.65);
    const heard = dist < heardRange ? (1 - dist / heardRange) * (0.3 + player.noise) : 0;

    let seen = 0;
    const sightRange = player.torchOn ? SIGHT_LIT : SIGHT_DARK;
    if (dist < sightRange && this.level.lineOfSight(this.position, player.position)) {
      seen = (1 - dist / sightRange) * (player.torchOn ? 1 : 0.55);
      this._lastSeen.copy(player.position);
    }

    return Math.min(1, Math.max(heard, seen));
  }

  /** Is the creature inside the player's view and unobstructed? */
  get visibleToPlayer() {
    return this.player.canSee(
      new THREE.Vector3(this.position.x, this.position.y + 1.3, this.position.z),
      0.85,
    );
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    if (!this.root) return;

    if (this.state === STATE.DORMANT) {
      this.mixer?.update(dt);
      return;
    }

    this._stateTime += dt;
    const perception = this.perceive();

    // Awareness fills fast and drains slowly: it loses the player reluctantly.
    const fill = perception > 0.12 ? perception * (1.1 + this.aggression) : -0.22;
    this.awareness = THREE.MathUtils.clamp(this.awareness + fill * dt, 0, 1);

    this.#think(dt, perception);
    this.#steer(dt);
    this.#animate(dt);
    this.#voice(dt);

    // Fire the "you have seen it" hook on the transition only, so the game
    // does not re-scare every frame it stays on screen.
    const visible = this.visibleToPlayer && this.distanceToPlayer < 24;
    if (visible && !this._wasVisible) this.onSighted?.(this.distanceToPlayer);
    this._wasVisible = visible;
  }

  #setState(next) {
    if (this.state === next) return;
    this.state = next;
    this._stateTime = 0;
    this._repathIn = 0;
  }

  #think(dt, perception) {
    const dist = this.distanceToPlayer;

    switch (this.state) {
      case STATE.PATROL:
        if (this.awareness > 0.55) {
          this.#setState(STATE.HUNT);
          this.audio?.roar(dist);
        } else if (perception > 0.15) {
          this._target.copy(this.player.position);
          this.#setState(STATE.INVESTIGATE);
        } else if (!this.path.length) {
          this.#pickWanderTarget();
        }
        break;

      case STATE.INVESTIGATE:
        if (this.awareness > 0.7) {
          this.#setState(STATE.HUNT);
          this.audio?.roar(dist);
        } else if (perception > 0.2) {
          // Keep updating the guess while it can still hear something.
          this._target.copy(this.player.position);
          this._repathIn = Math.min(this._repathIn, 0.4);
        } else if (this._stateTime > 9 || (!this.path.length && this._stateTime > 2)) {
          this.#setState(STATE.PATROL);
          this.#pickWanderTarget();
        }
        break;

      case STATE.HUNT:
        this._target.copy(this.player.position);
        if (dist < KILL_RANGE && this.player.alive) {
          this.#setState(STATE.ATTACK);
          this.#play('attack', 0.08, THREE.LoopOnce);
          this.audio?.roar(0.5);
          this.onAttack?.();
        } else if (this.awareness < 0.18) {
          // Lost it. Go to where it was last, not to where it is.
          this._target.copy(this._lastSeen);
          this.#setState(STATE.INVESTIGATE);
        }
        break;

      case STATE.ATTACK:
        if (this._stateTime > 1.4) this.#setState(STATE.STAGGER);
        break;

      case STATE.STAGGER:
        // A beat of nothing after a kill or a scare, so the player gets a
        // moment to understand what happened before it moves again.
        if (this._stateTime > 2.2) {
          this.awareness = 0.3;
          this.#setState(STATE.PATROL);
          this.#pickWanderTarget();
        }
        break;

      default:
        break;
    }
  }

  #pickWanderTarget() {
    // Prefer somewhere far from where it already is, biased toward the
    // player's half of the level so patrols do not drift into a dead corner
    // and stay there for the whole run.
    const rooms = this.level.rooms;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 6; i++) {
      const room = this.rng.pick(rooms);
      const p = this.level.pointInRoom(room, this.rng);
      const fromMe = p.distanceTo(this.position);
      const fromPlayer = p.distanceTo(this.player.position);
      const score = fromMe * 0.6 - Math.abs(fromPlayer - 14) * 0.5 + this.rng.float(0, 4);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    this._target.copy(best);
    this.#repath();
  }

  #repath() {
    this.path = this.level.path(this.position, this._target);
    // Re-path more often while hunting; a stale path in a chase is a creature
    // running into a wall.
    this._repathIn = this.state === STATE.HUNT ? 0.45 : 1.6;
  }

  #steer(dt) {
    const speed = this.speed;
    if (speed <= 0) {
      this.velocity.multiplyScalar(Math.max(0, 1 - 8 * dt));
      return;
    }

    this._repathIn -= dt;
    if (this._repathIn <= 0) this.#repath();

    // Drop waypoints as they are reached; the path is a queue.
    while (this.path.length && this.path[0].distanceTo(this.position) < 0.7) {
      this.path.shift();
    }
    if (!this.path.length) {
      if (this.state === STATE.PATROL) this.#pickWanderTarget();
      this.velocity.multiplyScalar(Math.max(0, 1 - 8 * dt));
      return;
    }

    const step = new THREE.Vector3().subVectors(this.path[0], this.position);
    step.y = 0;
    const len = step.length();
    if (len > 0.001) step.divideScalar(len);

    this.velocity.lerp(step.multiplyScalar(speed), Math.min(1, 6 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.level.collide(this.position, 0.42);

    // Face travel, but turn at a finite rate so it leans into corners.
    const moving = Math.hypot(this.velocity.x, this.velocity.z);
    if (moving > 0.15) {
      const want = Math.atan2(-this.velocity.x, -this.velocity.z);
      let delta = want - this.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.yaw += delta * Math.min(1, 7 * dt);
    }

    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;
  }

  // ------------------------------------------------------------- animation

  /**
   * Resolve a wanted animation to one that actually exists.
   *
   * The clip set is not fixed: a retarget can fail, and some Tripo presets
   * are not usable at all (see the note in tools/assets.manifest.mjs — the
   * shipped creature has no `run` clip because `preset:run` retargets to a
   * superman dive). Rather than encode that in the AI, every state names what
   * it wants and falls back through related clips to `idle`, which always
   * exists. Playback rate is matched to ground speed either way, so a
   * creature running on the walk cycle moves its legs at the right rate.
   */
  #resolve(name) {
    const chains = {
      run: ['run', 'walk', 'idle'],
      walk: ['walk', 'run', 'idle'],
      attack: ['attack', 'lunge', 'scream', 'idle'],
      scream: ['scream', 'lunge', 'attack', 'idle'],
      idle: ['idle', 'walk'],
    };
    for (const candidate of chains[name] ?? [name, 'idle']) {
      if (this.actions?.has(candidate)) return candidate;
    }
    return null;
  }

  #play(wanted, fade = 0.25, loop = THREE.LoopRepeat) {
    const name = this.#resolve(wanted);
    const action = name ? this.actions.get(name) : null;
    if (!action || action === this.current) return;
    action.reset();
    action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    action.clampWhenFinished = loop === THREE.LoopOnce;
    action.fadeIn(fade);
    this.current?.fadeOut(fade);
    this.current = action;
    this.currentName = name;
    action.play();
  }

  #animate(dt) {
    const moving = Math.hypot(this.velocity.x, this.velocity.z);

    if (this.state === STATE.ATTACK) {
      // Let the one-shot finish.
    } else if (this.state === STATE.STAGGER) {
      this.#play('scream', 0.2);
    } else if (moving < 0.25) {
      this.#play('idle');
    } else if (moving > 2.6) {
      this.#play('run', 0.18);
    } else {
      this.#play('walk', 0.22);
    }

    // Match playback to ground speed so the stride lands where the feet are.
    // The upper clamp is deliberately generous: with no `run` clip, a hunting
    // creature is a walk cycle played fast, and that is the only thing selling
    // the speed.
    if (this.current) {
      const clipSpeed = this._clipSpeed[this.currentName] ?? 0;
      this.current.timeScale = clipSpeed > 0.05
        ? THREE.MathUtils.clamp(moving / clipSpeed, 0.35, 3.2)
        : 1;
    }

    this.mixer.update(dt);
  }

  #voice(dt) {
    const dist = this.distanceToPlayer;

    this._voiceIn -= dt;
    if (this._voiceIn <= 0) {
      this._voiceIn = this.state === STATE.HUNT
        ? this.rng.float(1.6, 3.2)
        : this.rng.float(6, 14);
      if (this.state === STATE.HUNT) this.audio?.roar(dist);
      else if (dist < 18 && this.rng.bool(0.5)) this.audio?.roar(dist * 1.6);
    }

    // Close and behind: breathing, dry, with no reverb — it should sound like
    // it is nearer than the room allows.
    this._breathIn -= dt;
    if (this._breathIn <= 0 && dist < 7 && !this.visibleToPlayer) {
      this._breathIn = this.rng.float(1.4, 3.4);
      this.audio?.breath();
    }
  }
}

export { STATE as CreatureState };
