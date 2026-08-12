// The things in the corridors.
//
// One state machine, three profiles. They differ in what wakes them, and that
// is deliberately the only interesting axis — a player learns *senses* far
// faster than they learn stat blocks, and every sense here maps onto a control
// the player is already holding.
//
//   hunter   hears you and sees your torch. The one that patrols.
//   watcher  stands perfectly still until your torch touches it. The torch is
//            the thing you need, which is what makes it work: the light that
//            lets you read the room is also the light that wakes what is in it.
//   crawler  blind. Hunts sound alone, and fast — the only monster that
//            crouching beats outright and running loses to every time.
//
// Between them the player is never safe in one posture. Torch on and moving
// wakes watchers and draws hunters; torch off and running feeds crawlers;
// torch off and crouched is safe and takes all night, which is its own kind of
// pressure once something is already awake.

import * as THREE from 'three';
import { makeAnimated } from './assets.js';

const STATE = {
  DORMANT: 'dormant',
  STILL: 'still',
  PATROL: 'patrol',
  INVESTIGATE: 'investigate',
  WAKING: 'waking',
  HUNT: 'hunt',
  ATTACK: 'attack',
  STAGGER: 'stagger',
};

/**
 * `hearing` is the radius of a player making *full* noise; a crouching player
 * is a fraction of that. `sightLit`/`sightDark` are straight-line ranges with
 * and without the torch — a crawler has neither.
 */
const PROFILES = {
  hunter: {
    hearing: 26,
    sightLit: 21,
    sightDark: 6.5,
    speed: { patrol: 1.15, investigate: 1.9, hunt: 3.5 },
    killRange: 1.5,
    patrols: true,
    voice: { hunt: [1.6, 3.2], idle: [6, 14] },
  },
  watcher: {
    // Deaf and blind until lit. Everything about it is the torch.
    hearing: 0,
    sightLit: 0,
    sightDark: 0,
    speed: { patrol: 0, investigate: 0, hunt: 4.4 },
    killRange: 1.5,
    patrols: false,
    /** How long it keeps coming after losing you, before standing still again. */
    persistence: 11,
    /** Beat between being lit and charging — the scare needs a moment to land. */
    wakeTime: 0.85,
    voice: { hunt: [2.2, 4], idle: [14, 26] },
  },
  crawler: {
    hearing: 38,
    sightLit: 0,
    sightDark: 0,
    speed: { patrol: 1.6, investigate: 3.0, hunt: 5.1 },
    killRange: 1.4,
    patrols: true,
    voice: { hunt: [1.1, 2.2], idle: [5, 11] },
  },
};

export class Monster {
  /** `key` is the asset key; `behaviour` selects a profile. */
  constructor({ key, behaviour, level, player, audio, rng }) {
    this.key = key;
    this.behaviour = behaviour;
    this.profile = PROFILES[behaviour] ?? PROFILES.hunter;

    this.level = level;
    this.player = player;
    this.audio = audio;
    this.rng = rng.fork(`monster:${key}`);

    this.state = STATE.DORMANT;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.aggression = 0;
    this.awareness = 0;

    this.root = null;
    this.mixer = null;
    this.actions = null;
    this.current = null;
    this.currentName = null;

    this.path = [];
    this._repathIn = 0;
    this._stateTime = 0;
    this._target = new THREE.Vector3();
    this._lastSeen = new THREE.Vector3();
    this._home = new THREE.Vector3();
    this._voiceIn = 4;
    this._breathIn = 2;
    this._wasVisible = false;

    this.onAttack = null;
    this.onSighted = null;
    this.onWake = null;
  }

  async load(assets, scene) {
    const rig = await makeAnimated(assets.get(this.key));
    this.root = rig.root;
    this.mixer = rig.mixer;
    this.actions = rig.actions;
    this.meta = rig.meta;

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

  /** Put it in the world. A watcher starts standing still, not patrolling. */
  spawn(position) {
    this.position.copy(position);
    this._home.copy(position);
    this.root.position.copy(position);
    this.root.visible = true;
    this.awareness = 0;
    this.path = [];
    this._repathIn = 0;

    if (this.behaviour === 'watcher') {
      this.#setState(STATE.STILL);
      // Face a random way. It has been standing here a long time.
      this.yaw = this.rng.float(0, Math.PI * 2);
      this.root.rotation.y = this.yaw;
    } else {
      this.#setState(STATE.PATROL);
      this.#pickWanderTarget();
    }
  }

  despawn() {
    if (this.root) this.root.visible = false;
    this.#setState(STATE.DORMANT);
  }

  get active() {
    return this.state !== STATE.DORMANT;
  }

  /** Awake and coming for you — the director and the HUD both ask this. */
  get hunting() {
    return this.state === STATE.HUNT || this.state === STATE.WAKING;
  }

  get distanceToPlayer() {
    return this.position.distanceTo(this.player.position);
  }

  get speed() {
    const boost = 1 + this.aggression * 0.45;
    const s = this.profile.speed;
    switch (this.state) {
      case STATE.HUNT: return s.hunt * boost;
      case STATE.INVESTIGATE: return s.investigate * boost;
      case STATE.PATROL: return s.patrol;
      default: return 0;
    }
  }

  // ---------------------------------------------------------------- senses

  /**
   * Is this monster inside the torch beam right now?
   *
   * The beam is a cone from the camera along its facing, so this is the same
   * question `Player#canSee` answers with a narrower angle — which is exactly
   * right, because the player's torch and the player's gaze are rigidly
   * attached. Being caught in the light is being *looked at*.
   */
  litByTorch(range = 17) {
    if (!this.player.torchOn) return false;
    if (this.distanceToPlayer > range) return false;
    const chest = new THREE.Vector3(this.position.x, this.position.y + 1.2, this.position.z);
    return this.player.canSee(chest, 0.34);
  }

  perceive() {
    const player = this.player;
    if (!player.alive) return 0;
    const dist = this.distanceToPlayer;
    const p = this.profile;

    let heard = 0;
    if (p.hearing > 0) {
      const range = p.hearing * (0.35 + player.noise * 0.65);
      if (dist < range) heard = (1 - dist / range) * (0.3 + player.noise);
    }

    let seen = 0;
    const sightRange = player.torchOn ? p.sightLit : p.sightDark;
    if (sightRange > 0 && dist < sightRange
        && this.level.lineOfSight(this.position, player.position)) {
      seen = (1 - dist / sightRange) * (player.torchOn ? 1 : 0.55);
      this._lastSeen.copy(player.position);
    }

    return Math.min(1, Math.max(heard, seen));
  }

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

    const fill = perception > 0.12 ? perception * (1.1 + this.aggression) : -0.22;
    this.awareness = THREE.MathUtils.clamp(this.awareness + fill * dt, 0, 1);

    this.#think(dt, perception);
    this.#steer(dt);
    this.#animate(dt);
    this.#voice(dt);

    const visible = this.visibleToPlayer && this.distanceToPlayer < 24;
    if (visible && !this._wasVisible) this.onSighted?.(this.distanceToPlayer, this);
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
      case STATE.STILL:
        // A watcher. It does nothing at all until the light finds it.
        if (this.litByTorch()) {
          this.#setState(STATE.WAKING);
          this.#play('lunge', 0.06, THREE.LoopOnce);
          this.audio?.stinger(Math.min(1, 1.1 - dist / 24));
          this.audio?.roar(dist * 0.6);
          this.onWake?.(this, dist);
        }
        break;

      case STATE.WAKING:
        // Head up, and then it moves. The pause is the whole scare.
        if (this._stateTime > this.profile.wakeTime) {
          this.awareness = 1;
          this._lastSeen.copy(this.player.position);
          this.#setState(STATE.HUNT);
        }
        break;

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
          this._target.copy(this.player.position);
          this._repathIn = Math.min(this._repathIn, 0.4);
        } else if (this._stateTime > 9 || (!this.path.length && this._stateTime > 2)) {
          this.#setState(STATE.PATROL);
          this.#pickWanderTarget();
        }
        break;

      case STATE.HUNT: {
        // A watcher chases what it last knew; a hunter chases you.
        const blind = this.profile.sightLit === 0 && this.profile.hearing === 0;
        this._target.copy(blind ? this._lastSeen : this.player.position);
        if (blind && this.litByTorch()) this._lastSeen.copy(this.player.position);

        if (dist < this.profile.killRange && this.player.alive) {
          this.#setState(STATE.ATTACK);
          this.#play('lunge', 0.08, THREE.LoopOnce);
          this.audio?.roar(0.5);
          this.onAttack?.(this);
        } else if (this.profile.persistence && this._stateTime > this.profile.persistence) {
          // Watcher gives up and becomes furniture again, wherever it got to.
          this._home.copy(this.position);
          this.#setState(STATE.STILL);
        } else if (!this.profile.persistence && this.awareness < 0.18) {
          this._target.copy(this._lastSeen);
          this.#setState(STATE.INVESTIGATE);
        }
        break;
      }

      case STATE.ATTACK:
        if (this._stateTime > 1.4) this.#setState(STATE.STAGGER);
        break;

      case STATE.STAGGER:
        if (this._stateTime > 2.2) {
          this.awareness = 0.3;
          if (this.profile.patrols) {
            this.#setState(STATE.PATROL);
            this.#pickWanderTarget();
          } else {
            this.#setState(STATE.STILL);
          }
        }
        break;

      default:
        break;
    }
  }

  #pickWanderTarget() {
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
    this._repathIn = this.state === STATE.HUNT ? 0.45 : 1.6;
  }

  #steer(dt) {
    const speed = this.speed;
    if (speed <= 0) {
      this.velocity.multiplyScalar(Math.max(0, 1 - 8 * dt));
      // A still watcher turns to face the player once it is awake enough to
      // notice — before that it does not move a muscle.
      if (this.state === STATE.WAKING) this.#faceTarget(this.player.position, dt, 9);
      return;
    }

    this._repathIn -= dt;
    if (this._repathIn <= 0) this.#repath();

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

  #faceTarget(point, dt, rate = 7) {
    const want = Math.atan2(this.position.x - point.x, this.position.z - point.z);
    let delta = want - this.yaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.yaw += delta * Math.min(1, rate * dt);
    this.root.rotation.y = this.yaw;
  }

  // ------------------------------------------------------------- animation

  /**
   * Resolve a wanted animation to one that exists.
   *
   * The clip set is not fixed: a retarget can fail, and some Tripo presets are
   * unusable (see tools/assets.manifest.mjs). Every state names what it wants
   * and falls back through related clips to `idle`, which always exists.
   */
  #resolve(name) {
    const chains = {
      run: ['run', 'walk', 'idle'],
      walk: ['walk', 'run', 'idle'],
      lunge: ['lunge', 'attack', 'scream', 'idle'],
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

    if (this.state === STATE.ATTACK || this.state === STATE.WAKING) {
      // One-shots own the body.
    } else if (this.state === STATE.STILL) {
      // Absolutely motionless. Not a slow idle — still. A watcher that
      // breathes is a watcher the player knows is alive.
      this.mixer.update(0);
      return;
    } else if (this.state === STATE.STAGGER) {
      this.#play('lunge', 0.2);
    } else if (moving < 0.25) {
      this.#play('idle');
    } else if (moving > 2.6) {
      this.#play('run', 0.18);
    } else {
      this.#play('walk', 0.22);
    }

    if (this.current) {
      const clipSpeed = this._clipSpeed[this.currentName] ?? 0;
      this.current.timeScale = clipSpeed > 0.05
        ? THREE.MathUtils.clamp(moving / clipSpeed, 0.35, 3.2)
        : 1;
    }

    this.mixer.update(dt);
  }

  #voice(dt) {
    if (this.state === STATE.STILL) return; // silent, which is worse
    const dist = this.distanceToPlayer;
    const v = this.profile.voice;

    this._voiceIn -= dt;
    if (this._voiceIn <= 0) {
      const range = this.hunting ? v.hunt : v.idle;
      this._voiceIn = this.rng.float(range[0], range[1]);
      if (this.hunting) this.audio?.roar(dist);
      else if (dist < 18 && this.rng.bool(0.5)) this.audio?.roar(dist * 1.6);
    }

    this._breathIn -= dt;
    if (this._breathIn <= 0 && dist < 7 && !this.visibleToPlayer) {
      this._breathIn = this.rng.float(1.4, 3.4);
      this.audio?.breath();
    }
  }
}

export { STATE as MonsterState, PROFILES as MonsterProfiles };
