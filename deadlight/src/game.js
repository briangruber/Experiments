// The run: puzzles, monsters, escalation, and the end of it.
//
// The shape is two objectives that can be pursued in either order, and a third
// that needs both. Power comes from three breakers thrown in an order printed
// on a diagram somewhere else; the lift needs a four-digit code split across
// four ward tags. Neither is a fetch quest — nothing is carried, everything is
// *read*, so the player is always crossing the level holding something in
// their head that the dark is trying to knock out of it.
//
// Three monsters, escalating:
//
//   from the start   watchers, standing still in the dark. Harmless until your
//                    torch finds one, which is the trap: the light that lets
//                    you read a tag is the light that wakes what is beside it.
//   first objective  the hunter. Patrols, hears you, follows.
//   power restored   the crawler. Blind, fast, and it only hears — which flips
//                    every habit the player has built up to that point.

import * as THREE from 'three';
import { Level } from './level.js';
import { World } from './world.js';
import { Player, EYE_HEIGHT } from './player.js';
import { Monster } from './monster.js';
import { Mannequins } from './mannequins.js';
import { Director } from './director.js';
import { Cutscene, introScript, powerScript, escapeScript } from './cutscene.js';
import { BreakerSequence, CodeLock, PuzzleUI } from './puzzles.js';
import { Rng } from './rng.js';

/** How close, and how centred, the player must be to use something. */
const REACH = 2.6;
export class Game {
  constructor({ renderer, assets, audio, hud, quality }) {
    this.renderer = renderer;
    this.assets = assets;
    this.audio = audio;
    this.hud = hud;
    this.quality = quality ?? { mannequins: 8, watchers: 3 };

    this.running = false;
    this.over = false;
    this.onEnd = null;
  }

  // ------------------------------------------------------------------ setup

  async start(seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.audioRng = this.rng.fork('ambience');

    this.level = new Level(this.rng.fork('level'));
    this.world = new World(this.level, this.rng, this.quality).build(this.assets);

    // The post chain is bound to a specific scene, so it has to exist before
    // anything that writes to its uniforms — the director, below.
    this.renderer.setScene(this.world.scene);

    this.player = new Player(this.renderer.camera, this.level, this.audio);
    this.player.attach(this.renderer.canvas);

    await this.#spawnMonsters();

    this.mannequins = new Mannequins(this.level, this.player, this.audio, this.rng);
    this.mannequins.populate(this.world.scene, this.assets, this.quality.mannequins ?? 8);

    this.director = new Director({
      level: this.level,
      player: this.player,
      world: this.world,
      creature: this.hunter,
      mannequins: this.mannequins,
      audio: this.audio,
      post: this.renderer.post,
      hud: this.hud,
      rng: this.rng,
    });

    this.cutscene = new Cutscene({
      camera: this.renderer.camera,
      player: this.player,
      hud: this.hud,
      audio: this.audio,
      post: this.renderer.post,
    });

    this.#buildPuzzles();
    this.#wireEvents();

    const spawn = this.level.pointInRoom(this.level.startRoom, this.rng, 0.2);
    const centre = this.level.tileToWorld(this.level.startRoom.cx, this.level.startRoom.cy);
    this.player.spawn(spawn, Math.atan2(-(centre.x - spawn.x), -(centre.z - spawn.z)));

    this.stats = {
      seed,
      started: performance.now(),
      peakBpm: 68,
      closest: Infinity,
    };

    this.powered = false;
    this.escaped = false;
    this.introPlayed = false;
    this.over = false;
    this.running = true;

    this.hud.setSeed(seed);
    this.hud.setTags(0, this.code.length);
    this.hud.setBreakers(0, this.breakers.count);
    this.hud.setScares(0);
    this.hud.show();

    this.renderer.post.calm();
    return this.world.scene;
  }

  /**
   * Load every monster in the manifest and place the ones that start awake.
   *
   * Watchers are placed now, at level build, because they are *scenery* until
   * the player's torch finds them — a watcher that spawns partway through the
   * run has to appear from somewhere, and there is nowhere for it to appear
   * from that does not give the game away.
   */
  async #spawnMonsters() {
    this.monsters = [];
    const scene = this.world.scene;

    const make = async (key, behaviour) => {
      if (!this.assets.has(key)) return null;
      const monster = new Monster({
        key,
        behaviour,
        level: this.level,
        player: this.player,
        audio: this.audio,
        rng: this.rng,
      });
      await monster.load(this.assets, scene);
      this.monsters.push(monster);
      return monster;
    };

    this.hunter = await make('creature', 'hunter');
    this.crawler = await make('crawler', 'crawler');

    // Watchers get one instance each, placed against walls in rooms the player
    // does not start in.
    this.watchers = [];
    const rooms = this.rng.shuffle([...this.level.rooms])
      .filter((r) => r !== this.level.startRoom);
    for (let i = 0; i < (this.quality.watchers ?? 3); i++) {
      const watcher = await make('watcher', 'watcher');
      if (!watcher) break;
      const room = rooms[i % rooms.length];
      watcher.spawn(this.level.pointInRoom(room, this.rng, 0.35));
      this.watchers.push(watcher);
    }
  }

  #buildPuzzles() {
    this.ui = new PuzzleUI(this.hud, this.audio);

    const shared = {
      level: this.level,
      assets: this.assets,
      scene: this.world.scene,
      rng: this.rng,
      ui: this.ui,
      audio: this.audio,
      hud: this.hud,
    };

    this.breakers = new BreakerSequence(shared);
    this.code = new CodeLock(shared);

    this.breakers.onSolved = () => this.#onPower();
    this.breakers.onMistake = () => {
      // A tripped floor is heard everywhere. This is the cost of guessing.
      this.world.blackout(4.5);
      this.#alertAll(1);
      this.director.bump(0.5);
      this.player.shake(0.8);
    };

    this.code.onTagRead = (found, total) => {
      this.hud.setTags(found, total);
      if (found === 1 && !this.hunter?.active) this.#wakeHunter();
      if (found >= total) this.hud.objective('Full code. The lift is on the far side.', 6);
    };
    this.code.onSolved = () => this.#onEscape();
    this.code.onMistake = () => {
      this.#alertAll(0.85);
      this.director.bump(0.45);
    };

    this.#placeLift();

    this.interactables = [
      ...this.breakers.interactables,
      ...this.code.interactables,
      this.lift,
    ];
  }

  /** The lift: built rather than generated, because nothing in the prop set
   *  reads as a way *out* at a glance. */
  #placeLift() {
    const at = this.level.tileToWorld(this.level.exitRoom.cx, this.level.exitRoom.cy);
    const frame = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.7 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.5, 0.16), steel);
    door.position.y = 1.25;
    frame.add(door);

    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.22, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0x0d1a12, emissive: 0x1f8f4a, emissiveIntensity: 0.15, roughness: 0.4,
      }),
    );
    sign.position.set(0, 2.66, 0.1);
    frame.add(sign);

    const facing = this.level.wallFacing(this.level.exitRoom.cx, this.level.exitRoom.cy);
    frame.position.copy(at);
    frame.rotation.y = facing;
    this.world.scene.add(frame);

    // The keypad sits beside the doors, so the thing you type into and the
    // thing it opens are the same object in the player's memory.
    if (this.assets.has('keypad')) {
      const keypad = this.assets.instance('keypad');
      keypad.position.copy(at);
      keypad.position.y = 1.3;
      keypad.position.x += Math.cos(facing) * 1.15;
      keypad.position.z -= Math.sin(facing) * 1.15;
      keypad.rotation.y = facing;
      this.world.scene.add(keypad);
    }

    const glow = new THREE.PointLight(0x2fd06f, 0.7, 5, 2);
    glow.userData.baseIntensity = 0.7;
    glow.position.copy(at).setY(2.5);
    this.world.scene.add(glow);

    this.liftSign = sign;
    this.lift = {
      kind: 'lift',
      object: frame,
      glow,
      position: at.clone().setY(1.4),
      get done() { return false; },
      labelFor: () => (this.powered ? 'enter lift code' : 'lift has no power'),
      use: () => {
        if (!this.powered) {
          this.hud.objective('Dead. The breakers first.', 3);
          return null;
        }
        return this.code.enter();
      },
    };
  }

  #wireEvents() {
    for (const monster of this.monsters) {
      monster.onAttack = (m) => {
        if (this.over) return;
        this.director.jumpscare(m, {
          lethal: true,
          onDone: () => this.#end(false, CAUSES[m.behaviour] ?? CAUSES.hunter),
        });
      };
      monster.onSighted = (distance) => {
        this.director.bump(Math.max(0.15, 0.7 - distance / 30));
        if (distance < 9) this.audio.stinger(0.35);
      };
      monster.onWake = (m, distance) => {
        // A watcher waking is the single loudest moment in the game.
        this.director.bump(1);
        this.player.shake(1.4);
        this.renderer.post.params.aberration.value = 0.04;
        this.hud.objective('It was not a mannequin.', 3);
        this.director.scares.push({ name: 'watcher', at: performance.now(), tension: 1 });
        this.director.scareCount++;
        this.hud.setScares(this.director.scareCount);
      };
    }

    this.mannequins.onTouch = (m) => {
      if (this.over) return;
      this.player.battery = Math.min(this.player.battery, 0.08);
      this.director.jumpscare(m.object, {
        lethal: false,
        onDone: () => this.hud.objective('It was closer than you left it.', 4),
      });
    };

    this.mannequins.onNoticed = (m, distance) => {
      this.director.bump(Math.max(0.2, 0.85 - distance / 18));
      this.audio.stinger(Math.min(0.55, 0.9 - distance / 24));
    };

    this.player.onTorchToggle = (on) => {
      if (on && this.hunter?.active) this.hunter.awareness += 0.25;
    };
  }

  /** Everything awake now knows roughly where the player is. */
  #alertAll(strength = 1) {
    for (const monster of this.monsters) {
      if (!monster.active) continue;
      monster.awareness = Math.min(1, monster.awareness + strength);
      monster._lastSeen?.copy(this.player.position);
    }
    this.audio.stinger(0.5);
  }

  #wakeHunter() {
    if (!this.hunter || this.hunter.active) return;
    const from = this.level.worldToTile(this.player.position);
    const field = this.level.distanceField(from.tx, from.ty);
    let best = null;
    let bestDist = -1;
    for (const room of this.level.rooms) {
      const d = field[room.cy * this.level.w + room.cx];
      if (Number.isFinite(d) && d > bestDist) {
        bestDist = d;
        best = room;
      }
    }
    this.hunter.spawn(best ? this.level.pointInRoom(best, this.rng) : this.player.position.clone());
    this.audio.roar(24);
    this.hud.objective('Something moved on the level below.', 5);
  }

  // ------------------------------------------------------------ act changes

  async #onPower() {
    this.powered = true;
    this.hud.setBreakers(this.breakers.count, this.breakers.count);
    this.liftSign.material.emissiveIntensity = 2.4;
    this.lift.glow.userData.baseIntensity = 2.2;

    await this.cutscene.play(powerScript({
      player: this.player,
      world: this.world,
      audio: this.audio,
      monsters: this.monsters,
    }));
    if (this.over) return;

    // The crawler joins the level the moment the power comes back, as far away
    // as the layout allows — it is fast enough that a close spawn is a death
    // sentence rather than a threat.
    if (this.crawler && !this.crawler.active) {
      const from = this.level.worldToTile(this.player.position);
      const field = this.level.distanceField(from.tx, from.ty);
      const rooms = [...this.level.rooms].sort(
        (a, b) => (field[b.cy * this.level.w + b.cx] ?? 0) - (field[a.cy * this.level.w + a.cx] ?? 0),
      );
      this.crawler.spawn(this.level.pointInRoom(rooms[0], this.rng));
    }
    this.#wakeHunter();

    for (const m of this.monsters) m.aggression = 1;
    this.mannequins.setAggression(1);
    this.director.setPressure(1);
    this.hud.objective('Power is up. The lift needs the code.', 7);
  }

  async #onEscape() {
    if (this.over) return;
    this.escaped = true;
    await this.cutscene.play(escapeScript({
      player: this.player,
      audio: this.audio,
      monsters: this.monsters,
      hud: this.hud,
    }));
    this.#end(true, 'The doors closed behind you.');
  }

  // ----------------------------------------------------------------- update

  update(dt) {
    if (!this.running) return;

    // A cutscene owns the camera and the clock; the world keeps ticking
    // underneath so a monster staged in a shot is genuinely there afterwards.
    if (this.cutscene.active) {
      this.cutscene.update(dt);
      this.player.update(dt);
      for (const m of this.monsters) m.update(dt);
      this.#renderFeedback(dt);
      return;
    }

    // A panel is open: the player is reading, not walking.
    if (this.ui.open) this.player.frozen = true;
    else if (!this.director.cinematic) this.player.frozen = false;

    this.player.update(dt);
    for (const m of this.monsters) m.update(dt);
    this.mannequins.update(dt);
    this.director.update(dt);

    this.#updateInteractables();
    this.#updateStats();
    this.#renderFeedback(dt);
  }

  #renderFeedback(dt) {
    this.world.updateTorch(dt, this.renderer.camera, {
      on: this.player.torchOn,
      battery: this.player.battery,
      boost: this.director.cinematic ? 2.1 : 1,
    });
    this.world.updatePracticals(dt, this.director.tension);

    const fov = this.director.cinematic ? 58 : this.player.running ? 78 : 72;
    this.renderer.setFov(fov, dt);

    this.renderer.post.decay(dt, this.director.tension);
    this.audio.update(dt, this.audioRng);

    this.hud.update(dt, {
      battery: this.player.battery,
      stamina: this.player.stamina,
      heartRate: this.director.heartRate,
      fps: this.renderer.fps,
    });
    this.hud.blood(this.director.cinematic?.lethal ? this.renderer.post.params.blood.value : 0);
  }

  #updateInteractables() {
    const eye = this.player.eyePosition;
    const forward = this.player.forward();

    let best = null;
    let bestScore = 0;
    for (const item of this.interactables) {
      if (item.done) continue;
      const to = new THREE.Vector3().subVectors(item.position, eye);
      const dist = to.length();
      if (dist > REACH) continue;
      to.divideScalar(dist);
      const facing = to.dot(forward);
      if (facing < 0.45) continue;
      if (facing > bestScore) {
        bestScore = facing;
        best = item;
      }
    }

    const pulse = 0.75 + Math.sin(performance.now() * 0.003) * 0.25;
    for (const item of this.interactables) {
      if (!item.glow) continue;
      item.glow.visible = !item.done;
      if (!item.done) item.glow.intensity = (item.glow.userData.baseIntensity ?? 1) * pulse;
    }

    this._focus = best;
    this.hud.prompt(best ? `<kbd>E</kbd> ${best.labelFor()}` : null);
  }

  /** Called from the keyboard handler in main.js. */
  interact() {
    if (this.ui.open || this.cutscene.active || this.over) return;
    const item = this._focus;
    if (!item || item.done) return;
    if (!this.hunter?.active) this.#wakeHunter();
    item.use();
    // Whatever the player just did, they did it out loud.
    for (const m of this.monsters) {
      if (m.active && m.behaviour !== 'watcher') m.awareness = Math.min(1, m.awareness + 0.2);
    }
  }

  #updateStats() {
    this.stats.peakBpm = Math.max(this.stats.peakBpm, this.director.heartRate);
    for (const m of this.monsters) {
      if (m.active) this.stats.closest = Math.min(this.stats.closest, m.distanceToPlayer);
    }
  }

  // -------------------------------------------------------------------- end

  #end(won, cause) {
    if (this.over) return;
    this.over = true;
    this.running = false;
    this.player.alive = false;
    this.player.frozen = true;
    this.ui.close();
    this.cutscene.stop();

    const seconds = (performance.now() - this.stats.started) / 1000;
    const worst = [...this.director.scares].sort((a, b) => b.tension - a.tension)[0];

    this.onEnd?.({
      won,
      cause,
      seed: this.seed,
      seconds,
      tags: this.code.foundCount,
      tagsNeeded: this.code.length,
      power: this.powered,
      scares: this.director.scareCount,
      peakBpm: this.stats.peakBpm,
      closest: Number.isFinite(this.stats.closest) ? this.stats.closest : 0,
      topScare: worst ? SCARE_NAMES[worst.name] ?? worst.name : null,
    });
  }

  /**
   * The opening shot. Called by main.js once the first frame is up.
   *
   * `introPlayed` exists for the capture harness: the cutscene only becomes
   * active once this runs, which is *after* `start()` resolves, so "is a
   * cutscene playing?" answers no during the window between the two and any
   * test that waits on it proceeds straight into the opening shot.
   */
  async playIntro() {
    this.introPlayed = false;
    await this.cutscene.play(introScript({
      level: this.level,
      player: this.player,
      world: this.world,
      audio: this.audio,
      hud: this.hud,
    }));
    this.introPlayed = true;
  }

  dispose() {
    this.running = false;
    this.ui?.close();
    this.cutscene?.stop();
    this.player?.detach();
    this.mannequins?.reset();
    this.world?.dispose();
  }
}

const CAUSES = {
  hunter: 'It found you in the dark.',
  watcher: 'You pointed the light at it.',
  crawler: 'It heard you run.',
};

/** Human-readable names for the report card. */
const SCARE_NAMES = {
  whisper: 'a voice in the dark',
  breath: 'breathing behind you',
  clang: 'something fell',
  blackout: 'the lights went out',
  static: 'the world glitched',
  'mannequin-behind': 'it was behind you',
  apparition: 'it stood in the corridor',
  surge: 'the power surged',
  lunge: 'it charged',
  contact: 'a mannequin reached you',
  caught: 'it caught you',
  watcher: 'one of them was awake',
};

export { EYE_HEIGHT };
