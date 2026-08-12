// The scare director.
//
// Scares are not placed in the level, they are scheduled. The director watches
// how the run is going and picks a moment, which is the only way to keep a
// short game frightening on a second playthrough: a trigger volume is only
// ever surprising once, but a director that has been waiting for you to walk
// into a dead end with a flat battery is surprising every time.
//
// Three rules do most of the work:
//
//   1. Never scare a frightened player. Fear needs somewhere to fall from, so
//      the director spends most of its time refusing to fire and letting
//      tension bleed off. The gaps are the content.
//   2. Most scares must be harmless. If everything that jumps out can kill,
//      the player stops exploring and starts optimising, and a player who is
//      optimising is not scared. Roughly four in five of these cost nothing.
//   3. Never fire blind. Every scare states where it wants to happen and is
//      skipped if the geometry does not oblige — a mannequin staged inside a
//      wall is a bug the player will correctly read as one.
//
// The `chaos` entry points exist for streamers: they are the same scares,
// triggered by hand, so a moderator can spend channel points on ruining
// somebody's afternoon.

import * as THREE from 'three';

/** Resting heart rate, and the ceiling a scare can push it to. */
const BPM_REST = 68;
const BPM_MAX = 178;

const WHISPERS = [
  'you left the door open',
  "it's still down here",
  'go back',
  "don't turn around",
  'we can hear the light',
  'you were not the first',
  'six is too many',
  'it knows your name now',
  'stay in the dark with us',
  'the lift does not go up',
];

export class Director {
  constructor({ level, player, world, creature, mannequins, audio, post, hud, rng }) {
    this.level = level;
    this.player = player;
    this.world = world;
    this.creature = creature;
    this.mannequins = mannequins;
    this.audio = audio;
    this.post = post;
    this.hud = hud;
    this.rng = rng.fork('director');

    /** 0..1 — the director's read on how frightened the player is now. */
    this.tension = 0;
    /** 0..1 — how far through the run's escalation we are. */
    this.pressure = 0;
    this.heartRate = BPM_REST;

    this.scareCount = 0;
    this.scares = [];
    this._cooldown = 6;
    this._sinceScare = 0;
    this._calm = 0;
    this._whisperBag = this.rng.bag(WHISPERS);

    /** Non-null while a scripted scare owns the camera. */
    this.cinematic = null;
    this._apparition = null;

    this.catalogue = this.#buildCatalogue();
  }

  // -------------------------------------------------------------- catalogue

  /**
   * Each entry: `weight` is its base likelihood, `test` decides whether the
   * moment suits it, and `run` performs it. `cost` is the cooldown it imposes,
   * so a big scare buys a longer quiet stretch than a small one.
   */
  #buildCatalogue() {
    return [
      {
        name: 'whisper',
        weight: 3,
        cost: 4,
        harmless: true,
        test: () => true,
        run: () => {
          this.audio.whisper();
          this.hud?.whisper(this._whisperBag());
          this.bump(0.12);
        },
      },
      {
        name: 'breath',
        weight: 2.4,
        cost: 5,
        harmless: true,
        test: () => !this.creature?.visibleToPlayer,
        run: () => {
          this.audio.breath();
          this.post.params.aberration.value = 0.02;
          this.bump(0.22);
        },
      },
      {
        name: 'clang',
        weight: 2.6,
        cost: 5,
        harmless: true,
        test: () => true,
        run: () => {
          this.audio.distantClang();
          this.bump(0.16);
        },
      },
      {
        name: 'blackout',
        weight: 2,
        cost: 16,
        harmless: true,
        // Only worth doing where there is light to take away.
        test: () => this.world.practicals.some((p) => p.light.intensity > 0.4),
        run: () => {
          this.audio.surge(false);
          this.world.blackout(this.rng.float(3.5, 7));
          this.post.params.staticNoise.value = 0.5;
          this.post.params.tear.value = 0.04;
          this.bump(0.4);
        },
      },
      {
        name: 'static',
        weight: 1.8,
        cost: 9,
        harmless: true,
        test: () => true,
        run: () => {
          this.audio.stinger(0.4);
          this.post.params.staticNoise.value = 0.75;
          this.post.params.tear.value = 0.13;
          this.post.params.distort.value = 0.28;
          this.player.shake(0.5);
          this.bump(0.35);
        },
      },
      {
        name: 'mannequin-behind',
        weight: 3.4,
        cost: 14,
        harmless: true,
        test: () => this.mannequins.items.some((m) => m.live),
        run: () => {
          const staged = this.mannequins.stageBehind(this.player, this.rng.float(2.6, 3.6));
          if (!staged) return false;
          // The noise is the whole trick: it is in *front*, so the player
          // turns toward it and away from the thing that just arrived.
          this.audio.distantClang();
          this.bump(0.3);
          return true;
        },
      },
      {
        name: 'apparition',
        weight: 2.2,
        cost: 18,
        harmless: true,
        test: () => !this.creature?.active || this.creature.distanceToPlayer > 16,
        run: () => this.#apparition(),
      },
      {
        name: 'surge',
        weight: 1.4,
        cost: 12,
        harmless: true,
        test: () => true,
        run: () => {
          this.audio.surge(true);
          for (const p of this.world.practicals) p.light.intensity = p.base * 3.5;
          this.post.params.exposure.value = 1.5;
          this.bump(0.25);
        },
      },
      {
        name: 'lunge',
        weight: 2.8,
        cost: 22,
        harmless: false,
        // The real one: only when it is already close and behind you.
        test: () =>
          Boolean(this.creature?.active) &&
          this.creature.distanceToPlayer < 13 &&
          !this.creature.visibleToPlayer &&
          this.pressure > 0.3,
        run: () => {
          this.creature.awareness = 1;
          this.audio.roar(this.creature.distanceToPlayer);
          this.post.params.aberration.value = 0.03;
          this.bump(0.55);
        },
      },
    ];
  }

  // ----------------------------------------------------------------- update

  /** `pressure` is set by the game as objectives complete. */
  setPressure(value) {
    this.pressure = THREE.MathUtils.clamp(value, 0, 1);
  }

  /** Raise tension immediately — called by scares and by near-misses. */
  bump(amount) {
    this.tension = Math.min(1, this.tension + amount);
    this.heartRate = Math.min(BPM_MAX, this.heartRate + amount * 70);
    this._calm = 0;
  }

  update(dt) {
    this.#updateTension(dt);
    this.#updateApparition(dt);

    if (this.cinematic) {
      this.#updateCinematic(dt);
      return;
    }

    this._sinceScare += dt;
    this._cooldown -= dt;

    // The director only acts on a calm player. `_calm` is how long the
    // player has been *below* the tension it considers frightened, which is
    // not the same as how long since the last scare — a player still shaking
    // from the last one gets left alone.
    if (this.tension < 0.42) this._calm += dt;
    else this._calm = 0;

    if (this._cooldown > 0 || this._calm < 2.5) return;

    // Impatience: the longer it has been, the more likely each check fires.
    const eagerness = 0.12 + this.pressure * 0.3 + this._sinceScare * 0.035;
    if (!this.rng.bool(Math.min(0.9, eagerness * dt * 8))) return;

    this.fire();
  }

  #updateTension(dt) {
    // Baseline tension from the situation: how close the creature is, whether
    // it is hunting, how dark it is, how much battery is left.
    let situational = this.pressure * 0.22;
    if (this.creature?.active) {
      const d = this.creature.distanceToPlayer;
      situational += Math.max(0, 1 - d / 22) * (this.creature.hunting ? 0.75 : 0.3);
    }
    if (!this.player.torchOn) situational += 0.12;
    if (this.player.battery < 0.2) situational += 0.1;

    // Rise to the situation quickly, fall away from it slowly.
    const target = Math.min(1, situational);
    const rate = target > this.tension ? 1.6 : 0.28;
    this.tension += (target - this.tension) * Math.min(1, rate * dt);

    // Heart rate chases tension, plus exertion from sprinting.
    const exertion = this.player.running ? 26 : 0;
    const wantBpm = BPM_REST + this.tension * (BPM_MAX - BPM_REST) * 0.86 + exertion;
    const bpmRate = wantBpm > this.heartRate ? 2.2 : 0.42;
    this.heartRate += (wantBpm - this.heartRate) * Math.min(1, bpmRate * dt);

    this.audio.setTension(this.tension);
    this.audio.setHeartRate(this.heartRate);
  }

  /**
   * Pick and perform a scare.
   *
   * Weighted by suitability, but with an explicit bias toward harmless ones
   * that only relaxes as the run escalates. `name` forces a specific scare —
   * that is the streamer hook.
   */
  fire(name = null) {
    const pool = this.catalogue.filter((s) => {
      if (name) return s.name === name;
      if (!s.test()) return false;
      if (!s.harmless && this.rng.bool(0.65 - this.pressure * 0.4)) return false;
      return true;
    });
    if (!pool.length) return null;

    const total = pool.reduce((n, s) => n + s.weight, 0);
    let roll = this.rng.float(0, total);
    let chosen = pool[pool.length - 1];
    for (const s of pool) {
      roll -= s.weight;
      if (roll <= 0) {
        chosen = s;
        break;
      }
    }

    // A scare may decline at the last moment (staging failed); treat that as
    // a no-op with a short retry rather than burning the cooldown.
    if (chosen.run() === false) {
      this._cooldown = 1.5;
      return null;
    }

    this._cooldown = chosen.cost * (1.25 - this.pressure * 0.45);
    this._sinceScare = 0;
    this.scareCount++;
    this.scares.push({ name: chosen.name, at: performance.now(), tension: this.tension });
    this.hud?.setScares(this.scareCount);
    return chosen.name;
  }

  // ------------------------------------------------------------- apparition

  /**
   * Put the creature at the end of a sight-line for a moment, then take it
   * away. It is not really there — the creature's own position is untouched —
   * so this can fire while the real one is across the level.
   */
  #apparition() {
    if (!this.creature?.root) return false;

    // Look for a spot straight ahead with a clear line to it.
    const forward = this.player.forward();
    for (const distance of [14, 11, 8, 17]) {
      const spot = this.player.position.clone().addScaledVector(forward, distance);
      const { tx, ty } = this.level.worldToTile(spot);
      if (!this.level.isOpen(tx, ty)) continue;
      if (!this.level.lineOfSight(this.player.position, spot)) continue;

      const ghost = this.creature.root;
      this._apparition = {
        life: this.rng.float(0.7, 1.4),
        wasVisible: ghost.visible,
        home: this.creature.position.clone(),
      };
      ghost.position.copy(this.level.tileToWorld(tx, ty));
      ghost.rotation.y = Math.atan2(
        this.player.position.x - ghost.position.x,
        this.player.position.z - ghost.position.z,
      );
      ghost.visible = true;
      this.audio.roar(distance * 1.3);
      this.bump(0.42);
      return true;
    }
    return false;
  }

  #updateApparition(dt) {
    const a = this._apparition;
    if (!a) return;
    a.life -= dt;
    if (a.life > 0) return;
    // Snap it back to where the real creature actually is.
    const ghost = this.creature.root;
    ghost.position.copy(this.creature.position);
    ghost.visible = this.creature.active;
    this._apparition = null;
  }

  // -------------------------------------------------------------- jumpscare

  /**
   * The full-screen scare. Takes the camera off the player, points it at the
   * thing, and runs a short scripted sequence.
   *
   * `onDone` fires when the sequence ends — the game uses it to decide whether
   * this was a death or a survivable fright.
   */
  jumpscare(target, { lethal = false, onDone = null, intensity = 1 } = {}) {
    if (this.cinematic) return;

    this.player.frozen = true;
    this.audio.stinger(intensity);
    this.audio.roar(0.4);
    this.player.shake(2.2);
    this.scareCount++;
    this.hud?.setScares(this.scareCount);
    this.scares.push({ name: lethal ? 'caught' : 'contact', at: performance.now(), tension: 1 });

    this.heartRate = BPM_MAX;
    this.tension = 1;

    this.cinematic = {
      t: 0,
      duration: lethal ? 2.1 : 1.25,
      target,
      lethal,
      onDone,
    };
  }

  #updateCinematic(dt) {
    const c = this.cinematic;
    c.t += dt;
    const k = Math.min(1, c.t / c.duration);

    // Wrench the view onto it, hard at first then settling.
    const focus = c.target?.position
      ? new THREE.Vector3(c.target.position.x, c.target.position.y + 1.45, c.target.position.z)
      : null;
    if (focus) this.player.lookAt(focus, 0.34);

    const p = this.post.params;
    // Everything peaks in the first fifth of a second and then hangs there.
    const spike = Math.min(1, c.t / 0.16);
    const hold = 1 - k * k;
    p.distort.value = 0.55 * spike * hold;
    p.aberration.value = 0.05 * spike * hold;
    p.staticNoise.value = 0.35 * spike * hold;
    p.desaturate.value = 0.1;
    p.exposure.value = 1 + 0.9 * spike * hold;
    if (c.lethal) p.blood.value = Math.min(0.9, k * 1.4);

    this.hud?.flash(Math.max(0, 0.85 * (1 - c.t / 0.35)));

    if (k >= 1) {
      this.cinematic = null;
      this.player.frozen = false;
      this.hud?.flash(0);
      c.onDone?.(c.lethal);
    }
  }

  /** Named scare triggers for stream interaction. */
  chaos(key) {
    const map = {
      1: 'whisper',
      2: 'blackout',
      3: 'mannequin-behind',
      4: 'apparition',
      5: 'static',
      6: 'lunge',
    };
    const name = map[key];
    if (!name) return null;
    // Bypass cooldown — the moderator paid for this.
    this._cooldown = 0;
    this._calm = 99;
    const entry = this.catalogue.find((s) => s.name === name);
    if (!entry || !entry.test()) return null;
    return this.fire(name);
  }

  reset() {
    this.tension = 0;
    this.pressure = 0;
    this.heartRate = BPM_REST;
    this.scareCount = 0;
    this.scares = [];
    this._cooldown = 6;
    this._sinceScare = 0;
    this._calm = 0;
    this.cinematic = null;
    this._apparition = null;
  }
}
