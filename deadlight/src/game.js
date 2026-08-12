// The run: objectives, interaction, escalation, and the end of it.
//
// The loop is deliberately old-fashioned — find six fuses, start the
// generator, reach the lift — because the objective is not what makes this
// frightening. What it does is force the player to keep crossing a level that
// gets more hostile every time they succeed. Every fuse raises `pressure`,
// and pressure feeds the creature's speed, the mannequins' stride, and how
// impatient the director is. The player is always making the game worse by
// playing it well, and they can see it happening on the fuse counter.

import * as THREE from 'three';
import { Level } from './level.js';
import { World } from './world.js';
import { Player, EYE_HEIGHT } from './player.js';
import { Creature } from './creature.js';
import { Mannequins } from './mannequins.js';
import { Director } from './director.js';
import { Rng } from './rng.js';

const FUSES_NEEDED = 6;
/** How close, and how centred, the player must be to use something. */
const REACH = 2.6;

export class Game {
  constructor({ renderer, assets, audio, hud }) {
    this.renderer = renderer;
    this.assets = assets;
    this.audio = audio;
    this.hud = hud;

    this.running = false;
    this.over = false;
    this.onEnd = null;

  }

  // ------------------------------------------------------------------ setup

  /** Build a fresh run from `seed`. Returns the scene to render. */
  async start(seed) {
    this.seed = seed;
    this.rng = new Rng(seed);
    // Ambience draws thousands of times a minute at whatever the frame rate
    // happens to be. On the shared stream that would shift every later draw —
    // including where the creature wakes up — so a seed would stop meaning the
    // same run on a different machine. Its own fork keeps the promise honest.
    this.audioRng = this.rng.fork('ambience');

    this.level = new Level(this.rng.fork('level'));
    this.world = new World(this.level, this.rng).build(this.assets);

    // The post chain is bound to a specific scene, so it has to exist before
    // anything that writes to its uniforms — the director, below.
    this.renderer.setScene(this.world.scene);

    this.player = new Player(this.renderer.camera, this.level, this.audio);
    this.player.attach(this.renderer.canvas);

    this.creature = new Creature(this.level, this.player, this.audio, this.rng);
    await this.creature.load(this.assets, this.world.scene);

    this.mannequins = new Mannequins(this.level, this.player, this.audio, this.rng);
    this.mannequins.populate(this.world.scene, this.assets, 9);

    this.director = new Director({
      level: this.level,
      player: this.player,
      world: this.world,
      creature: this.creature,
      mannequins: this.mannequins,
      audio: this.audio,
      post: this.renderer.post,
      hud: this.hud,
      rng: this.rng,
    });

    this.#wireEvents();
    this.#placeObjectives();

    // Spawn facing the middle of the room, which is where the dressing is —
    // opening a run staring at a blank wall reads as a broken level.
    const spawn = this.level.pointInRoom(this.level.startRoom, this.rng, 0.2);
    const centre = this.level.tileToWorld(this.level.startRoom.cx, this.level.startRoom.cy);
    this.player.spawn(spawn, Math.atan2(-(centre.x - spawn.x), -(centre.z - spawn.z)));

    this.stats = {
      seed,
      started: performance.now(),
      peakBpm: 68,
      closest: Infinity,
      fuses: 0,
    };

    this.fusesTaken = 0;
    this.generatorRunning = false;
    this.exitOpen = false;
    this.over = false;
    this.running = true;

    this.hud.setSeed(seed);
    this.hud.setFuses(0, FUSES_NEEDED);
    this.hud.setScares(0);
    this.hud.show();
    this.hud.objective(`Find ${FUSES_NEEDED} fuses. Do not run out of light.`, 7);

    this.renderer.post.calm();
    return this.world.scene;
  }

  #wireEvents() {
    this.creature.onAttack = () => {
      if (this.over) return;
      this.director.jumpscare(this.creature, {
        lethal: true,
        onDone: () => this.#end(false, 'It found you in the dark.'),
      });
    };

    this.creature.onSighted = (distance) => {
      // Seeing it at all is worth a jolt, scaled by how close it is.
      this.director.bump(Math.max(0.15, 0.7 - distance / 30));
      if (distance < 9) this.audio.stinger(0.35);
    };

    this.mannequins.onTouch = (m) => {
      if (this.over) return;
      // Survivable, but it costs the torch — which is far worse than damage,
      // because the player now has to cross the level blind.
      this.player.battery = Math.min(this.player.battery, 0.08);
      this.director.jumpscare(m.object, {
        lethal: false,
        intensity: 1,
        onDone: () => {
          this.hud.objective('It was closer than you left it.', 4);
        },
      });
    };

    this.mannequins.onNoticed = (m, distance) => {
      this.director.bump(Math.max(0.2, 0.85 - distance / 18));
      this.audio.stinger(Math.min(0.55, 0.9 - distance / 24));
    };

    this.player.onTorchToggle = (on) => {
      // Turning the torch on is a broadcast. The creature does not need to
      // see it directly — light in a concrete corridor goes everywhere.
      if (on && this.creature.active) this.creature.awareness += 0.25;
    };
  }

  /**
   * Put the fuses, the generator and the lift in the level.
   *
   * Each interactable gets a faint emissive marker. Without one they are
   * indistinguishable from the forty other props in torchlight, and the
   * resulting game is a search rather than a horror.
   */
  #placeObjectives() {
    this.interactables = [];

    // Markers are point lights rather than emissive materials so they cast a
    // little light on what they are attached to — a glowing decal on a black
    // wall reads as a UI element, a lit fusebox reads as an object.
    const marker = (colour, intensity = 1.4) => {
      const light = new THREE.PointLight(colour, intensity, 4.2, 2);
      light.userData.baseIntensity = intensity;
      return light;
    };

    // Fuses.
    const rooms = this.level.fuseRooms.slice(0, FUSES_NEEDED);
    for (let i = 0; i < FUSES_NEEDED; i++) {
      const room = rooms[i % rooms.length];
      const tile = this.rng.shuffle(
        this.level.wallTiles().filter(
          (t) => t.tx >= room.x - 1 && t.tx <= room.x + room.w && t.ty >= room.y - 1 && t.ty <= room.y + room.h,
        ),
      )[0];

      const at = tile
        ? this.level.tileToWorld(tile.tx, tile.ty)
        : this.level.pointInRoom(room, this.rng);

      const object = this.assets.has('fusebox')
        ? this.assets.instance('fusebox')
        : new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.2), new THREE.MeshStandardMaterial());

      object.position.copy(at);
      object.position.y = 1.15;
      if (tile) {
        const facing = this.level.wallFacing(tile.tx, tile.ty);
        object.rotation.y = facing;
        object.position.x -= Math.sin(facing) * 1.35;
        object.position.z -= Math.cos(facing) * 1.35;
      }
      this.world.scene.add(object);

      const glow = marker(0x74e0ff, 1.1);
      glow.position.copy(object.position);
      this.world.scene.add(glow);

      this.interactables.push({
        kind: 'fuse',
        object,
        glow,
        position: object.position.clone(),
        label: 'take fuse',
        done: false,
      });
    }

    // Generator.
    const genAt = this.level.pointInRoom(this.level.generatorRoom, this.rng, 0.2);
    const generator = this.assets.has('generator')
      ? this.assets.instance('generator')
      : new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.8), new THREE.MeshStandardMaterial());
    generator.position.copy(genAt);
    generator.rotation.y = this.rng.float(0, Math.PI * 2);
    this.world.scene.add(generator);

    const genGlow = marker(0xffb04a, 1.6);
    genGlow.position.copy(genAt).setY(1.1);
    this.world.scene.add(genGlow);

    this.interactables.push({
      kind: 'generator',
      object: generator,
      glow: genGlow,
      position: genAt.clone().setY(1),
      label: 'start generator',
      done: false,
    });

    // The lift. Built rather than generated: it has to read as a way *out*
    // at a glance, and nothing in the prop set says "exit".
    const exitAt = this.level.tileToWorld(this.level.exitRoom.cx, this.level.exitRoom.cy);
    const frame = new THREE.Group();
    const jamb = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.7 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.5, 0.16), jamb);
    door.position.y = 1.25;
    frame.add(door);
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.22, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0x0d1a12,
        emissive: 0x1f8f4a,
        emissiveIntensity: 0.35,
        roughness: 0.4,
      }),
    );
    sign.position.set(0, 2.66, 0.1);
    frame.add(sign);
    frame.position.copy(exitAt);
    frame.rotation.y = this.level.wallFacing(this.level.exitRoom.cx, this.level.exitRoom.cy);
    this.world.scene.add(frame);

    const exitGlow = marker(0x2fd06f, 0.55);
    exitGlow.position.copy(exitAt).setY(2.6);
    this.world.scene.add(exitGlow);

    this.exit = { frame, sign, glow: exitGlow };
    this.interactables.push({
      kind: 'exit',
      object: frame,
      glow: exitGlow,
      position: exitAt.clone().setY(1.4),
      label: 'take the lift',
      done: false,
    });
  }

  // ----------------------------------------------------------------- update

  /** One frame. `dt` is clamped by the caller. */
  update(dt) {
    if (!this.running) return;

    this.player.update(dt);
    this.creature.update(dt);
    this.mannequins.update(dt);
    this.director.update(dt);

    this.#updateObjectives(dt);
    this.#updateEscalation();
    this.#updateStats(dt);

    this.world.updateTorch(dt, this.renderer.camera, {
      on: this.player.torchOn,
      battery: this.player.battery,
      // The torch surges during a scare — it is the only light source, so
      // the scare has to be lit by it.
      boost: this.director.cinematic ? 2.1 : 1,
    });
    this.world.updatePracticals(dt, this.director.tension);

    // Sprinting widens the view a little; a jumpscare narrows it hard.
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
    this.hud.blood(
      this.director.cinematic?.lethal ? this.renderer.post.params.blood.value : 0,
    );
  }

  #updateObjectives(dt) {
    const eye = this.player.eyePosition;
    const forward = this.player.forward();

    let best = null;
    let bestScore = 0;
    for (const item of this.interactables) {
      if (item.done) continue;
      if (item.kind === 'generator' && this.fusesTaken < FUSES_NEEDED) continue;
      if (item.kind === 'exit' && !this.generatorRunning) continue;

      const to = new THREE.Vector3().subVectors(item.position, eye);
      const dist = to.length();
      if (dist > REACH) continue;
      to.divideScalar(dist);
      // Must be roughly in front — walking past something should not offer it.
      const facing = to.dot(forward);
      if (facing < 0.45) continue;
      if (facing > bestScore) {
        bestScore = facing;
        best = item;
      }
    }

    // Markers breathe, so they are findable in peripheral vision without ever
    // being bright enough to light the room for free.
    const pulse = 0.75 + Math.sin(performance.now() * 0.003) * 0.25;
    for (const item of this.interactables) {
      if (item.done || !item.glow) continue;
      const visible = !(item.kind === 'generator' && this.fusesTaken < FUSES_NEEDED)
        && !(item.kind === 'exit' && !this.generatorRunning);
      item.glow.visible = visible;
      if (visible) item.glow.intensity = item.glow.userData.baseIntensity * pulse;
    }

    this._focus = best;
    this.hud.prompt(best ? `<kbd>E</kbd> ${best.label}` : null);
  }

  /** Called from the keyboard handler in main.js. */
  interact() {
    const item = this._focus;
    if (!item || item.done || this.over) return;

    if (item.kind === 'fuse') {
      item.done = true;
      item.object.visible = false;
      item.glow.visible = false;
      this.fusesTaken++;
      this.stats.fuses = this.fusesTaken;
      this.audio.chime();
      this.hud.setFuses(this.fusesTaken, FUSES_NEEDED);

      if (this.fusesTaken === 1) {
        // First fuse wakes it up, as far from the player as the level allows.
        this.#wakeCreature();
        this.hud.objective('Something moved on the level below.', 5);
      } else if (this.fusesTaken >= FUSES_NEEDED) {
        this.hud.objective('All six. Get to the generator.', 6);
        this.audio.surge(true);
      } else {
        this.hud.objective(`${FUSES_NEEDED - this.fusesTaken} left.`, 3);
      }
      // Taking a fuse is loud, and it should be.
      this.creature.awareness = Math.min(1, this.creature.awareness + 0.3);
      return;
    }

    if (item.kind === 'generator') {
      item.done = true;
      this.generatorRunning = true;
      this.audio.surge(true);
      this.exit.sign.material.emissiveIntensity = 2.4;
      this.exit.glow.intensity = 2.2;
      this.hud.objective('Power is up. The lift is live — go.', 7);
      // The endgame: it knows exactly where you are now.
      this.creature.aggression = 1;
      this.creature.awareness = 1;
      this.mannequins.setAggression(1);
      this.director.setPressure(1);
      return;
    }

    if (item.kind === 'exit') {
      item.done = true;
      this.audio.chime();
      this.#end(true, 'The doors closed behind you.');
    }
  }

  #wakeCreature() {
    // Furthest room from the player that is still reachable.
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
    const at = best ? this.level.pointInRoom(best, this.rng) : this.player.position.clone();
    this.creature.spawn(at);
    this.audio.roar(24);
  }

  #updateEscalation() {
    const progress = this.fusesTaken / FUSES_NEEDED;
    this.creature.aggression = Math.max(this.creature.aggression, progress);
    this.mannequins.setAggression(progress * 0.9);
    this.director.setPressure(Math.max(this.director.pressure, progress));
  }

  #updateStats(dt) {
    this.stats.peakBpm = Math.max(this.stats.peakBpm, this.director.heartRate);
    if (this.creature.active) {
      this.stats.closest = Math.min(this.stats.closest, this.creature.distanceToPlayer);
    }
  }

  // -------------------------------------------------------------------- end

  #end(won, cause) {
    if (this.over) return;
    this.over = true;
    this.running = false;
    this.player.alive = false;
    this.player.frozen = true;

    const seconds = (performance.now() - this.stats.started) / 1000;
    // The "worst moment" is the scare that landed at the highest tension.
    const worst = [...this.director.scares].sort((a, b) => b.tension - a.tension)[0];

    this.onEnd?.({
      won,
      cause,
      seed: this.seed,
      seconds,
      fuses: this.fusesTaken,
      fusesNeeded: FUSES_NEEDED,
      scares: this.director.scareCount,
      peakBpm: this.stats.peakBpm,
      closest: Number.isFinite(this.stats.closest) ? this.stats.closest : 0,
      topScare: worst ? SCARE_NAMES[worst.name] ?? worst.name : null,
    });
  }

  dispose() {
    this.running = false;
    this.player?.detach();
    this.mannequins?.reset();
    this.world?.dispose();
  }
}

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
};

export { FUSES_NEEDED, EYE_HEIGHT };
