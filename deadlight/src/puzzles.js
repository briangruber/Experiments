// The two puzzles.
//
// Both are information puzzles, not fetch quests, and that distinction is the
// whole design. A collectable is carried — once you have it you are done
// thinking, and the level becomes a corridor between pickups. A *number* has
// to be read in one room and used in another, which means the player crosses
// the level while holding something in their head, and everything the dark
// does to them on the way is now interfering with the task instead of merely
// happening near it. Forgetting the code is a real failure state, and the
// panic of re-walking a corridor you already survived to re-read a tag is the
// most reliable fear this game produces.
//
//   BreakerSequence  three switches, thrown in an order printed on a diagram
//                    somewhere else. Wrong order trips the floor and wakes
//                    everything.
//   CodeLock         a four-digit lift code, one digit per ward tag, scattered.
//                    Wrong code sounds an alarm that is heard everywhere.
//
// Both are seeded, so a shared seed is a shared puzzle — chat can hold the
// code for a streamer who lost it.

import * as THREE from 'three';

/** Ward letters used to label tags and breakers. Avoids I and O. */
const LABELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * A modal panel: reading a tag, or entering a code.
 *
 * Keyboard-first on purpose. The game holds pointer lock while it runs, so
 * there is no cursor to click a button with — and releasing the lock to show
 * one would drop the player out of the game every time they read a scrap of
 * paper. The on-screen keys still respond to the mouse for the embedded build,
 * where pointer lock may never have been granted in the first place.
 */
export class PuzzleUI {
  constructor(hud, audio) {
    this.hud = hud;
    this.audio = audio;
    this.open = false;
    this._onKey = null;
    this._resolve = null;
  }

  /** Show a readable document. Resolves when the player closes it. */
  note({ title, lines, footer = 'E · close' }) {
    return this.#show({ title, body: lines.map((l) => `<div class="note-line">${l}</div>`).join(''), footer },
      (event, close) => {
        if (['KeyE', 'Escape', 'Enter', 'Space'].includes(event.code)) close(null);
      });
  }

  /**
   * Digit entry. Resolves with the typed string, or null if abandoned.
   * `length` digits, submitted automatically once full — a player who has
   * typed four digits has committed, and asking them to press enter as well
   * only adds a way to fumble it.
   */
  code({ title, length = 4, footer = 'type the code · Esc · leave' }) {
    let entry = '';
    const render = () => {
      const cells = Array.from({ length }, (_, i) =>
        `<b class="digit${i === entry.length ? ' at' : ''}">${entry[i] ?? '·'}</b>`).join('');
      return `<div class="code-display">${cells}</div>
        <div class="code-pad">${'123456789'.split('').map((d) => `<span data-d="${d}">${d}</span>`).join('')}
        <span class="wide" data-d="0">0</span></div>`;
    };

    return this.#show({ title, body: render(), footer }, (event, close, update) => {
      if (event.code === 'Escape') return close(null);
      if (event.code === 'Backspace') {
        entry = entry.slice(0, -1);
        this.audio?.click(false);
        return update(render());
      }
      const digit = event.key >= '0' && event.key <= '9' ? event.key : null;
      if (!digit || entry.length >= length) return undefined;
      entry += digit;
      this.audio?.click(true);
      update(render());
      if (entry.length === length) setTimeout(() => close(entry), 220);
      return undefined;
    }, (digit, close, update) => {
      // Mouse path, for when there is no pointer lock to fight.
      if (entry.length >= length) return;
      entry += digit;
      this.audio?.click(true);
      update(render());
      if (entry.length === length) setTimeout(() => close(entry), 220);
    });
  }

  #show(content, handleKey, handleClick) {
    if (this.open) this.close();
    this.open = true;
    this.hud.showPanel(content);

    return new Promise((resolve) => {
      const update = (body) => this.hud.updatePanel(body);
      const close = (value) => {
        this._resolve = null;
        this.close();
        resolve(value ?? null);
      };
      // Held so `close()` can settle the promise from outside. The game closes
      // panels on death and on teardown, and a panel torn down without
      // resolving leaves whatever opened it awaiting forever.
      this._resolve = () => resolve(null);

      this._onKey = (event) => {
        // Swallow everything: the player must not walk while reading.
        event.preventDefault();
        event.stopPropagation();
        handleKey(event, close, update);
      };
      window.addEventListener('keydown', this._onKey, true);

      this._onClick = (event) => {
        const digit = event.target?.dataset?.d;
        if (digit && handleClick) handleClick(digit, close, update);
      };
      this.hud.el.panel.addEventListener('click', this._onClick);
      this._close = close;
    });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    if (this._onKey) window.removeEventListener('keydown', this._onKey, true);
    if (this._onClick) this.hud.el.panel.removeEventListener('click', this._onClick);
    this._onKey = null;
    this._onClick = null;
    this.hud.hidePanel();

    // Settle anything still awaiting this panel.
    const pending = this._resolve;
    this._resolve = null;
    pending?.();
  }
}

// --------------------------------------------------------------- breakers

/**
 * Three breakers, one order, printed somewhere else.
 *
 * The diagram is a separate findable object rather than a label on the
 * breakers themselves — that is the entire puzzle. Reading the order and
 * executing it happen in different rooms, and the walk between them is where
 * the game lives.
 */
export class BreakerSequence {
  constructor({ level, assets, scene, rng, ui, audio, hud }) {
    this.level = level;
    this.ui = ui;
    this.audio = audio;
    this.hud = hud;
    this.rng = rng.fork('breakers');

    this.count = 3;
    this.labels = this.rng.shuffle(LABELS.slice(0, 8).split('')).slice(0, this.count);
    /** The order they must be thrown in. */
    this.order = this.rng.shuffle([...this.labels]);
    this.progress = 0;
    this.solved = false;

    this.onSolved = null;
    this.onMistake = null;

    this.interactables = [];
    this._build(assets, scene);
  }

  get orderText() {
    return this.order.join(' → ');
  }

  _build(assets, scene) {
    const rooms = this.rng.shuffle([...this.level.rooms])
      .filter((r) => r !== this.level.startRoom && r !== this.level.exitRoom);

    // Breakers hug walls; a switch panel in the middle of a room is furniture.
    this.labels.forEach((label, i) => {
      const room = rooms[i % rooms.length];
      const spot = this.#wallSpot(room);
      const object = assets.has('breaker')
        ? assets.instance('breaker')
        : new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.15), new THREE.MeshStandardMaterial());
      object.position.copy(spot.position);
      object.rotation.y = spot.facing;
      scene.add(object);

      const glow = new THREE.PointLight(0xff9a3c, 1.3, 4, 2);
      glow.userData.baseIntensity = 1.3;
      glow.position.copy(spot.position);
      scene.add(glow);

      this.interactables.push({
        kind: 'breaker',
        label,
        object,
        glow,
        position: spot.position.clone(),
        get done() { return false; },
        labelFor: () => `throw breaker ${label}`,
        use: () => this.throw(label),
      });
    });

    // The diagram, somewhere else entirely.
    const room = rooms[this.count % rooms.length];
    const spot = this.#wallSpot(room, 1.25);
    const diagram = assets.has('clipboard')
      ? assets.instance('clipboard')
      : new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.03), new THREE.MeshStandardMaterial());
    diagram.position.copy(spot.position);
    diagram.rotation.y = spot.facing;
    scene.add(diagram);

    const glow = new THREE.PointLight(0xffe6a8, 0.9, 3.4, 2);
    glow.userData.baseIntensity = 0.9;
    glow.position.copy(spot.position);
    scene.add(glow);

    this.interactables.push({
      kind: 'diagram',
      object: diagram,
      glow,
      position: spot.position.clone(),
      get done() { return false; },
      labelFor: () => 'read wiring diagram',
      use: () => this.ui.note({
        title: 'MAINTENANCE — SUBLEVEL 3',
        lines: [
          'RESTART ORDER, MAIN BUS:',
          `<b class="big">${this.orderText}</b>`,
          'OUT OF ORDER TRIPS THE FLOOR.',
          'DO NOT IMPROVISE.',
        ],
      }),
    });
  }

  #wallSpot(room, height = 1.15) {
    const tiles = this.rng.shuffle(
      this.level.wallTiles().filter(
        (t) => t.tx >= room.x - 1 && t.tx <= room.x + room.w
          && t.ty >= room.y - 1 && t.ty <= room.y + room.h,
      ),
    );
    const tile = tiles[0];
    if (!tile) {
      return { position: this.level.pointInRoom(room, this.rng).setY(height), facing: 0 };
    }
    const facing = this.level.wallFacing(tile.tx, tile.ty);
    const position = this.level.tileToWorld(tile.tx, tile.ty, height);
    position.x -= Math.sin(facing) * 1.35;
    position.z -= Math.cos(facing) * 1.35;
    return { position, facing };
  }

  /** Throw one breaker. Returns a short message for the HUD. */
  throw(label) {
    if (this.solved) return null;

    if (label === this.order[this.progress]) {
      this.progress++;
      this.audio?.surge(this.progress === this.count);
      if (this.progress >= this.count) {
        this.solved = true;
        this.onSolved?.();
        return null;
      }
      this.hud?.objective(`${this.progress} of ${this.count}. Keep going.`, 3);
      return null;
    }

    // Wrong. Everything resets, and everything hears it.
    this.progress = 0;
    this.audio?.surge(false);
    this.audio?.stinger(0.55);
    this.hud?.objective('Wrong order. The floor tripped.', 4);
    this.onMistake?.();
    return null;
  }
}

// --------------------------------------------------------------- code lock

/**
 * A four-digit lift code, one digit per ward tag.
 *
 * Each tag names its own position, so they can be found in any order — a
 * puzzle that must be solved in sequence is a corridor, and this level is not
 * one. The tags are readable objects, so the digit lives in the player's head
 * (or in chat) rather than in an inventory.
 */
export class CodeLock {
  constructor({ level, assets, scene, rng, ui, audio, hud }) {
    this.level = level;
    this.ui = ui;
    this.audio = audio;
    this.hud = hud;
    this.rng = rng.fork('code');

    this.length = 4;
    this.code = Array.from({ length: this.length }, () => this.rng.int(0, 9)).join('');
    this.found = new Set();
    this.solved = false;
    this.attempts = 0;

    this.onSolved = null;
    this.onMistake = null;
    this.onTagRead = null;

    this.interactables = [];
    this._build(assets, scene);
  }

  get foundCount() {
    return this.found.size;
  }

  _build(assets, scene) {
    const rooms = this.rng.shuffle([...this.level.rooms])
      .filter((r) => r !== this.level.startRoom);

    for (let i = 0; i < this.length; i++) {
      const room = rooms[i % rooms.length];
      const spot = this.#spot(room);
      const object = assets.has('clipboard')
        ? assets.instance('clipboard')
        : new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.03), new THREE.MeshStandardMaterial());
      object.position.copy(spot.position);
      object.rotation.y = spot.facing;
      scene.add(object);

      const glow = new THREE.PointLight(0x74e0ff, 1.1, 4, 2);
      glow.userData.baseIntensity = 1.1;
      glow.position.copy(spot.position);
      scene.add(glow);

      const ward = LABELS[i];
      const digit = this.code[i];
      this.interactables.push({
        kind: 'tag',
        object,
        glow,
        position: spot.position.clone(),
        get done() { return false; },
        labelFor: () => 'read ward tag',
        use: async () => {
          this.found.add(i);
          this.onTagRead?.(this.found.size, this.length);
          await this.ui.note({
            title: `WARD ${ward} — PATIENT RECORD`,
            lines: [
              'LIFT AUTHORISATION, PARTIAL:',
              `DIGIT <b>${i + 1}</b> OF ${this.length} IS <b class="big">${digit}</b>`,
              'REMAINING DIGITS HELD ON OTHER WARDS.',
            ],
          });
        },
      });
    }
  }

  #spot(room) {
    const tiles = this.rng.shuffle(
      this.level.wallTiles().filter(
        (t) => t.tx >= room.x - 1 && t.tx <= room.x + room.w
          && t.ty >= room.y - 1 && t.ty <= room.y + room.h,
      ),
    );
    const tile = tiles[0];
    if (!tile) {
      return { position: this.level.pointInRoom(room, this.rng).setY(1.2), facing: 0 };
    }
    const facing = this.level.wallFacing(tile.tx, tile.ty);
    const position = this.level.tileToWorld(tile.tx, tile.ty, 1.2);
    position.x -= Math.sin(facing) * 1.3;
    position.z -= Math.cos(facing) * 1.3;
    return { position, facing };
  }

  /** Open the keypad. */
  async enter() {
    if (this.solved) return true;
    const typed = await this.ui.code({
      title: 'LIFT — AUTHORISATION',
      footer: `${this.foundCount}/${this.length} tags read · Esc · leave`,
    });
    if (typed === null) return false;

    this.attempts++;
    if (typed === this.code) {
      this.solved = true;
      this.audio?.chime();
      this.onSolved?.();
      return true;
    }

    // Wrong. The alarm is the punishment, and it is heard everywhere.
    this.audio?.surge(false);
    this.audio?.stinger(0.6);
    this.hud?.objective('Rejected. Something heard that.', 4);
    this.onMistake?.(this.attempts);
    return false;
  }
}
