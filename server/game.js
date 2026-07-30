'use strict';

/**
 * BOMB BLOBS — server-authoritative game simulation.
 *
 * One Room = one arena = one shareable code. The room owns every bit of truth:
 * positions, who is holding a bomb, who just got launched into the void.
 * Clients only ever send an intent vector, and get snapshots back.
 */

const TICK = 1 / 60;

const C = {
  ARENA_START: 350,
  ARENA_MIN: 130,
  SHRINK_DELAY: 12,     // seconds of peace before the floor starts closing in
  SHRINK_RATE: 9,       // world units per second

  PLAYER_R: 28,
  ACCEL: 1000,
  DRAG: 4.0,            // v *= e^(-DRAG*dt) → terminal speed ≈ ACCEL/DRAG
  RESTITUTION: 1.35,    // >1 so bumping people is loud and funny
  DASH_IMPULSE: 560,
  DASH_COOLDOWN: 1.6,
  DASH_TIME: 0.22,
  DASH_MASS: 2.5,       // a dashing blob hits like a truck
  PANIC_MULT: 1.15,     // holding a bomb makes you a little bit faster

  BOMB_MIN: 5.5,
  BOMB_MAX: 9.5,
  BOMB_LOCK: 0.7,       // you cannot re-pass the instant you receive it
  BOMB_RESPAWN: 1.3,
  BLAST_R: 145,
  BLAST_FORCE: 780,

  FALL_TIME: 0.55,
  FALL_SPEED: 230,      // you cannot walk off the edge — you have to be thrown
  COUNTDOWN: 3.6,
  ROUND_OVER: 5.5,
  LOBBY_GRACE: 5,       // breathing room to add bots / let friends trickle in

  PICKUP_EVERY: 6,
  PICKUP_MAX: 3,
  PICKUP_R: 16,
  BOOST_TIME: 4,
  BOOST_MULT: 1.7,

  // Elimination is not the end of your round — you become a ghost on the rim.
  GHOST_IN: 46,         // how far outside the floor ghosts hover
  GHOST_OUT: 140,
  ORB_SPEED: 400,
  ORB_LIFE: 2.4,
  ORB_R: 13,
  ORB_FORCE: 360,       // enough to ruin someone's day, slow enough to dodge
  ORB_COOLDOWN: 3,

  SUDDEN_AT: 2,         // alive count that triggers sudden death
  SUDDEN_SHRINK: 2.5,   // shrink-rate multiplier once it does
  SUDDEN_FUSE: 0.55,

  MAX_PLAYERS: 12,
  SNAPSHOT_HZ: 30,
};

/**
 * One is picked per round and announced during the countdown. They exist so
 * that no two rounds feel the same and so a lobby develops in-jokes about the
 * slippery one.
 */
const MODIFIERS = [
  { key: 'normal', name: 'CLASSIC', blurb: 'Straight up.' },
  { key: 'slippery', name: 'BUTTERED FLOOR', blurb: 'Nobody can stop.', drag: 0.45 },
  { key: 'shortfuse', name: 'SHORT FUSE', blurb: 'Think faster.', fuse: 0.5 },
  { key: 'tiny', name: 'CROWDED HOUSE', blurb: 'No room to run.', arena: 0.62 },
  { key: 'double', name: 'DOUBLE TROUBLE', blurb: 'Two bombs. Good luck.', bombs: 2 },
  { key: 'sugar', name: 'SUGAR RUSH', blurb: 'Everything is too fast.', accel: 1.6, dashCd: 0.55 },
];

const COLORS = [
  '#ff4d6d', '#4dd4ff', '#ffd93d', '#7cff6b', '#c77dff',
  '#ff9f45', '#5eead4', '#ff6bd6', '#8ab4ff', '#f8f8f8',
  '#ff5c5c', '#a3e635',
];

const BOT_NAMES = [
  'Blobzilla', 'Sir Pops', 'Kaboomer', 'Wigglesworth', 'Nubbins',
  'The Menace', 'Squishy', 'Doom Bean', 'Mr. Fuse', 'Gel Prince',
];
const BOT_EMOJI = ['🤖', '👾', '🐸', '🦖', '🐙', '🍡', '👻', '🐷'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let nextEntityId = 1;

class Player {
  constructor(id, name, emoji, color, isBot = false) {
    this.id = id;
    this.name = name;
    this.emoji = emoji;
    this.color = color;
    this.bot = isBot;

    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.r = C.PLAYER_R;

    this.alive = false;
    this.ghost = false;
    this.bombT = 0;       // seconds left on the bomb this player is holding
    this.bombLock = 0;
    this.shield = false;
    this.boost = 0;

    this.dashCd = 0;
    this.dashT = 0;
    this.orbCd = 0;
    this.falling = 0;

    this.input = { x: 0, y: 0, dash: false };
    this.face = { x: 0, y: 1 };
    this.aim = null;   // bots only: where the next spook goes

    this.emote = 0;
    this.emoteT = 0;

    this.score = 0;
    this.streak = 0;
    this.passes = 0;
    this.connected = true;

    // bot brain
    this.think = 0;
    this.wander = { x: 0, y: 0 };
  }

  get hasBomb() { return this.bombT > 0; }
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();     // id -> Player
    this.sockets = new Map();     // id -> ws
    this.state = 'lobby';         // lobby | countdown | playing | over
    this.timer = 0;
    this.mod = MODIFIERS[0];
    this.arenaStart = C.ARENA_START;
    this.arena = C.ARENA_START;
    this.elapsed = 0;
    this.sudden = false;
    this.fuseMax = C.BOMB_MAX;
    this.bombRespawn = 0;
    this.pickups = [];
    this.orbs = [];
    this.pickupT = C.PICKUP_EVERY;
    this.events = [];
    this.round = 0;
    this.lastWinner = null;
    this.metaDirty = true;
    this.lobbyT = C.LOBBY_GRACE;
    this.snapAccum = 0;
    this.tick = 0;
    this.emptySince = Date.now();
  }

  /* ---------------------------------------------------------------- roster */

  freeColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) || pick(COLORS);
  }

  add(id, name, emoji, ws) {
    if (this.players.size >= C.MAX_PLAYERS) return null;
    const p = new Player(id, name, emoji, this.freeColor());
    this.players.set(id, p);
    if (ws) this.sockets.set(id, ws);
    this.placeInRing(p);
    // Latecomers watch the current round from the sidelines, then join the next.
    // In the lobby there is no round to interrupt, so they can warm up instead.
    p.alive = this.state === 'lobby' || this.state === 'over';
    this.rosterChanged();
    return p;
  }

  addBot() {
    if (this.players.size >= C.MAX_PLAYERS) return null;
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${this.players.size}`;
    const p = new Player(`bot_${nextEntityId++}`, name, pick(BOT_EMOJI), this.freeColor(), true);
    this.players.set(p.id, p);
    this.placeInRing(p);
    this.rosterChanged();
    return p;
  }

  removeBots() {
    for (const [id, p] of this.players) if (p.bot) this.players.delete(id);
    this.rosterChanged();
  }

  remove(id) {
    this.players.delete(id);
    this.sockets.delete(id);
    this.rosterChanged();
    if (this.humanCount() === 0) this.emptySince = Date.now();
  }

  /** Anyone joining or leaving pushes the auto-start back. */
  rosterChanged() {
    this.metaDirty = true;
    this.lobbyT = C.LOBBY_GRACE;
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  aliveList() {
    return [...this.players.values()].filter((p) => p.alive && p.falling === 0);
  }

  ghostList() {
    return [...this.players.values()].filter((p) => p.ghost);
  }

  placeInRing(p, index = null, total = null) {
    const i = index === null ? (Math.random() * 12) | 0 : index;
    const n = total === null ? 12 : Math.max(total, 2);
    const a = (i / n) * Math.PI * 2;
    const d = this.arena * 0.62;
    p.x = Math.cos(a) * d;
    p.y = Math.sin(a) * d;
    p.vx = 0; p.vy = 0;
    p.face = { x: -Math.cos(a), y: -Math.sin(a) };
  }

  /* ----------------------------------------------------------------- rounds */

  startCountdown() {
    this.round++;
    this.state = 'countdown';
    this.timer = C.COUNTDOWN;

    // Round one is always plain, so nobody's first impression is a gimmick.
    const choices = MODIFIERS.filter((m) => m.key !== this.mod.key && m.key !== 'normal');
    this.mod = this.round === 1 ? MODIFIERS[0] : pick(choices);

    this.arenaStart = C.ARENA_START * (this.mod.arena || 1);
    this.arena = this.arenaStart;
    this.elapsed = 0;
    this.sudden = false;
    this.pickups = [];
    this.orbs = [];
    this.pickupT = C.PICKUP_EVERY;
    this.bombRespawn = 0;
    this.fuseMax = C.BOMB_MAX * (this.mod.fuse || 1);
    this.lastWinner = null;

    const roster = [...this.players.values()].filter((p) => p.connected);
    roster.forEach((p, i) => {
      this.placeInRing(p, i, roster.length);
      p.alive = true;
      p.ghost = false;
      p.bombT = 0;
      p.bombLock = 0;
      p.shield = false;
      p.boost = 0;
      p.dashCd = 0;
      p.dashT = 0;
      p.orbCd = 0;
      p.falling = 0;
      p.passes = 0;
      p.aim = null;
    });
    this.metaDirty = true;
    this.events.push({ e: 'round', n: this.round, mod: this.mod.name, blurb: this.mod.blurb });
  }

  beginPlay() {
    this.state = 'playing';
    this.assignBomb(true);
    if ((this.mod.bombs || 1) > 1 && this.aliveList().length >= 4) this.assignBomb(true);
  }

  /** How many bombs the round wants live at once, given who's left. */
  wantBombs() {
    const alive = this.aliveList().length;
    if (alive < 2) return 0;
    return Math.min(this.mod.bombs || 1, Math.max(1, Math.floor(alive / 2)));
  }

  fuseLength() {
    const alive = this.aliveList().length;
    // The fewer blobs left, the less time you get to think.
    const pressure = alive <= 2 ? C.SUDDEN_FUSE : alive <= 3 ? 0.75 : 1;
    return rand(C.BOMB_MIN, C.BOMB_MAX) * (this.mod.fuse || 1) * pressure;
  }

  assignBomb(initial = false) {
    const free = this.aliveList().filter((p) => !p.hasBomb);
    if (free.length === 0 || this.aliveList().length < 2) return;
    // Prefer whoever is closest to the middle: no cowering on the rim.
    const sorted = free.slice().sort((a, b) => (a.x * a.x + a.y * a.y) - (b.x * b.x + b.y * b.y));
    const target = initial ? pick(free) : sorted[(Math.random() * Math.min(3, sorted.length)) | 0];
    target.bombT = this.fuseLength();
    target.bombLock = C.BOMB_LOCK;
    this.events.push({ e: 'fuse', id: target.id });
  }

  endRound() {
    const alive = this.aliveList();
    this.state = 'over';
    this.timer = C.ROUND_OVER;
    for (const p of this.players.values()) p.bombT = 0;

    // A little colour for the scoreboard moment.
    let mvp = null;
    for (const p of this.players.values()) {
      if (p.passes >= 3 && (!mvp || p.passes > mvp.passes)) mvp = { id: p.id, passes: p.passes };
    }

    if (alive.length === 1) {
      const w = alive[0];
      w.score++;
      w.streak++;
      for (const p of this.players.values()) if (p !== w) p.streak = 0;
      this.lastWinner = w.id;
      this.events.push({ e: 'win', id: w.id, score: w.score, streak: w.streak, mvp });
    } else {
      for (const p of this.players.values()) p.streak = 0;
      this.events.push({ e: 'draw', mvp });
    }
    this.metaDirty = true;
  }

  eliminate(p, how) {
    if (!p.alive) return;
    p.alive = false;
    p.falling = 0;
    p.bombT = 0;
    this.events.push({ e: 'out', id: p.id, how, x: p.x, y: p.y });

    // Straight to the afterlife, where you get to keep playing.
    p.ghost = true;
    p.orbCd = 1.2;
    const d = Math.hypot(p.x, p.y) || 1;
    const band = this.arena + (C.GHOST_IN + C.GHOST_OUT) / 2;
    p.x = (p.x / d) * band;
    p.y = (p.y / d) * band;
    p.vx = 0; p.vy = 0;
    p.face = { x: -p.x / band, y: -p.y / band };
  }

  explodeOn(holder) {
    holder.bombT = 0;
    this.events.push({ e: 'boom', x: holder.x, y: holder.y, id: holder.id });

    for (const q of this.aliveList()) {
      if (q === holder) continue;
      const dx = q.x - holder.x, dy = q.y - holder.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > C.BLAST_R) continue;
      const f = (1 - d / C.BLAST_R) * C.BLAST_FORCE;
      q.vx += (dx / d) * f;
      q.vy += (dy / d) * f;
    }

    if (holder.shield) {
      holder.shield = false;
      this.events.push({ e: 'saved', id: holder.id });
      const a = rand(0, Math.PI * 2);
      holder.vx += Math.cos(a) * C.BLAST_FORCE * 0.6;
      holder.vy += Math.sin(a) * C.BLAST_FORCE * 0.6;
    } else {
      this.eliminate(holder, 'boom');
    }

    this.bombRespawn = C.BOMB_RESPAWN;
  }

  /* ------------------------------------------------------------------- sim */

  update(dt) {
    switch (this.state) {
      case 'lobby':
        this.simulate(dt, false);
        // Auto-start once there is someone to actually fight, but not the
        // instant they arrive — the grace timer resets whenever the roster
        // changes so you can stack up bots or wait for one more friend.
        if (this.players.size >= 2 && this.humanCount() >= 1) {
          this.lobbyT -= dt;
          if (this.lobbyT <= 0) this.startCountdown();
        } else {
          this.lobbyT = C.LOBBY_GRACE;
        }
        break;

      case 'countdown':
        this.timer -= dt;
        this.simulate(dt, false);
        if (this.timer <= 0) this.beginPlay();
        break;

      case 'playing':
        this.elapsed += dt;
        this.simulate(dt, true);
        break;

      case 'over':
        this.timer -= dt;
        this.simulate(dt, false);
        if (this.timer <= 0) {
          if (this.players.size >= 2) this.startCountdown();
          else { this.state = 'lobby'; this.metaDirty = true; }
        }
        break;
    }
  }

  simulate(dt, live) {
    const players = [...this.players.values()];
    const accelMult = this.mod.accel || 1;
    const dragMult = this.mod.drag || 1;
    const dashCdMult = this.mod.dashCd || 1;

    if (live) {
      const rate = C.SHRINK_RATE * (this.sudden ? C.SUDDEN_SHRINK : 1);
      if (this.sudden || this.elapsed > C.SHRINK_DELAY) {
        this.arena = Math.max(C.ARENA_MIN, this.arena - rate * dt);
      }
      this.pickupT -= dt;
      if (this.pickupT <= 0 && this.pickups.length < C.PICKUP_MAX) {
        this.pickupT = C.PICKUP_EVERY;
        const a = rand(0, Math.PI * 2), d = rand(0, this.arena * 0.7);
        this.pickups.push({
          id: nextEntityId++,
          x: Math.cos(a) * d,
          y: Math.sin(a) * d,
          kind: Math.random() < 0.55 ? 'boost' : 'shield',
        });
      }
    }

    for (const p of players) {
      if (p.emoteT > 0) p.emoteT -= dt;
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.dashT > 0) p.dashT -= dt;
      if (p.boost > 0) p.boost -= dt;
      if (p.bombLock > 0) p.bombLock -= dt;
      if (p.orbCd > 0) p.orbCd -= dt;

      if (p.falling > 0) {
        p.falling -= dt;
        p.x += p.vx * dt * 0.3;
        p.y += p.vy * dt * 0.3;
        if (p.falling <= 0) { p.falling = 0; this.eliminate(p, 'fall'); }
        continue;
      }

      if (p.ghost) { this.updateGhost(p, dt, live); continue; }
      if (!p.alive) continue;

      if (p.bot) this.botThink(p, dt, live);

      let ix = p.input.x, iy = p.input.y;
      const mag = Math.hypot(ix, iy);
      if (mag > 1) { ix /= mag; iy /= mag; }
      if (mag > 0.05) p.face = { x: ix / (mag || 1), y: iy / (mag || 1) };

      // Movement is always on — waiting in an empty lobby should still be a toy.
      // Only the hazards (bomb, void, shrinking floor) are gated on `live`.
      const accel = C.ACCEL * accelMult
        * (p.boost > 0 ? C.BOOST_MULT : 1)
        * (p.hasBomb ? C.PANIC_MULT : 1);
      p.vx += ix * accel * dt;
      p.vy += iy * accel * dt;

      if (p.input.dash && p.dashCd <= 0) {
        p.dashCd = C.DASH_COOLDOWN * dashCdMult;
        p.dashT = C.DASH_TIME;
        p.vx += p.face.x * C.DASH_IMPULSE;
        p.vy += p.face.y * C.DASH_IMPULSE;
        this.events.push({ e: 'dash', id: p.id, x: p.x, y: p.y });
      }
      p.input.dash = false;

      const drag = Math.exp(-C.DRAG * dragMult * dt);
      p.vx *= drag;
      p.vy *= drag;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    this.collide(players, live);
    if (live) this.updateOrbs(dt);

    if (live) {
      // pickups
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const pu = this.pickups[i];
        for (const p of players) {
          if (!p.alive || p.falling > 0) continue;
          if (Math.hypot(p.x - pu.x, p.y - pu.y) < p.r + C.PICKUP_R) {
            if (pu.kind === 'boost') p.boost = C.BOOST_TIME;
            else p.shield = true;
            this.events.push({ e: 'grab', id: p.id, kind: pu.kind, x: pu.x, y: pu.y });
            this.pickups.splice(i, 1);
            break;
          }
        }
      }

      // The void. Walking speed alone can never eject you: the rim acts as a
      // bumper unless you are travelling outward fast, which only happens when
      // someone shoves you, a blast throws you, or you dash off like a fool.
      for (const p of players) {
        if (!p.alive || p.falling > 0) continue;
        const d = Math.hypot(p.x, p.y);
        if (d <= this.arena + p.r * 0.35) continue;

        const nx = p.x / d, ny = p.y / d;
        const outward = p.vx * nx + p.vy * ny;
        if (outward < C.FALL_SPEED) {
          const rim = this.arena + p.r * 0.35;
          p.x = nx * rim;
          p.y = ny * rim;
          if (outward > 0) { p.vx -= nx * outward; p.vy -= ny * outward; }
          continue;
        }

        p.falling = C.FALL_TIME;
        this.events.push({ e: 'fall', id: p.id, x: p.x, y: p.y });
        p.bombT = 0;
      }

      // fuses
      for (const p of players) {
        if (!p.alive || p.falling > 0 || !p.hasBomb) continue;
        p.bombT -= dt;
        if (p.bombT <= 0) this.explodeOn(p);
      }

      // keep the right number of bombs in play
      let live_bombs = 0;
      for (const p of players) if (p.alive && p.hasBomb) live_bombs++;
      if (live_bombs < this.wantBombs()) {
        this.bombRespawn -= dt;
        if (this.bombRespawn <= 0) {
          this.assignBomb();
          this.bombRespawn = C.BOMB_RESPAWN;
        }
      }

      if (!this.sudden && this.aliveList().length <= C.SUDDEN_AT && this.state === 'playing') {
        this.sudden = true;
        this.events.push({ e: 'sudden' });
      }

      // Don't crown anyone while a blob is still dropping — the fall is already
      // fatal, but declaring a winner over someone mid-plummet looks wrong, and
      // two simultaneous fallers should resolve as a draw, not a win.
      const dropping = players.some((p) => p.alive && p.falling > 0);
      if (!dropping && this.aliveList().length <= 1 && this.state === 'playing') this.endRound();
    } else {
      // keep everyone on the platform between rounds
      for (const p of players) {
        if (p.ghost) continue;
        const d = Math.hypot(p.x, p.y);
        if (d > this.arena * 0.92) {
          p.x = (p.x / d) * this.arena * 0.92;
          p.y = (p.y / d) * this.arena * 0.92;
          p.vx *= -0.4; p.vy *= -0.4;
        }
      }
    }
  }

  /**
   * Ghosts drift in a band just outside the floor and can fire one spectral orb
   * every few seconds. Getting knocked into the void by someone you eliminated
   * two minutes ago is the best thing that can happen to a lobby.
   */
  updateGhost(p, dt, live) {
    if (p.bot) this.ghostBotThink(p);

    let ix = p.input.x, iy = p.input.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 1) { ix /= mag; iy /= mag; }
    if (mag > 0.05) p.face = { x: ix / (mag || 1), y: iy / (mag || 1) };

    p.vx += ix * C.ACCEL * 0.8 * dt;
    p.vy += iy * C.ACCEL * 0.8 * dt;
    const drag = Math.exp(-C.DRAG * dt);
    p.vx *= drag;
    p.vy *= drag;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // stay in the haunting band
    const d = Math.hypot(p.x, p.y) || 1;
    const lo = this.arena + C.GHOST_IN;
    const hi = this.arena + C.GHOST_OUT;
    if (d < lo || d > hi) {
      const r = clamp(d, lo, hi);
      p.x = (p.x / d) * r;
      p.y = (p.y / d) * r;
      const nx = p.x / r, ny = p.y / r;
      const radial = p.vx * nx + p.vy * ny;
      p.vx -= nx * radial; p.vy -= ny * radial;
    }

    if (live && p.input.dash && p.orbCd <= 0) {
      p.orbCd = C.ORB_COOLDOWN;
      // Bots aim at a target; humans fire wherever they're steering.
      const dir = p.aim || p.face;
      this.orbs.push({
        id: nextEntityId++,
        x: p.x, y: p.y,
        vx: dir.x * C.ORB_SPEED,
        vy: dir.y * C.ORB_SPEED,
        life: C.ORB_LIFE,
        owner: p.id,
        color: p.color,
      });
      this.events.push({ e: 'orb', id: p.id, x: p.x, y: p.y });
    }
    p.input.dash = false;
  }

  updateOrbs(dt) {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.life -= dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;

      if (o.life <= 0) { this.orbs.splice(i, 1); continue; }

      let hit = null;
      for (const p of this.aliveList()) {
        if (Math.hypot(p.x - o.x, p.y - o.y) < p.r + C.ORB_R) { hit = p; break; }
      }
      if (!hit) continue;

      const d = Math.hypot(o.vx, o.vy) || 1;
      hit.vx += (o.vx / d) * C.ORB_FORCE;
      hit.vy += (o.vy / d) * C.ORB_FORCE;
      this.events.push({ e: 'spook', by: o.owner, id: hit.id, x: o.x, y: o.y });
      this.orbs.splice(i, 1);
    }
  }

  collide(players, live) {
    for (let i = 0; i < players.length; i++) {
      const a = players[i];
      if (!a.alive || a.falling > 0) continue;
      for (let j = i + 1; j < players.length; j++) {
        const b = players[j];
        if (!b.alive || b.falling > 0) continue;

        const dx = b.x - a.x, dy = b.y - a.y;
        const minD = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 === 0) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;

        // separate
        const overlap = (minD - d) / 2;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;

        // exchange momentum (dashing blobs weigh more)
        const ma = a.dashT > 0 ? C.DASH_MASS : 1;
        const mb = b.dashT > 0 ? C.DASH_MASS : 1;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = (-(1 + C.RESTITUTION) * vn) / (1 / ma + 1 / mb);
          a.vx -= (imp / ma) * nx; a.vy -= (imp / ma) * ny;
          b.vx += (imp / mb) * nx; b.vy += (imp / mb) * ny;
          const power = Math.abs(vn);
          if (power > 120) this.events.push({ e: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: Math.min(1, power / 700) });
        }

        if (!live) continue;

        // the actual point of the game
        if (a.hasBomb && a.bombLock <= 0 && !b.hasBomb) this.pass(a, b);
        else if (b.hasBomb && b.bombLock <= 0 && !a.hasBomb) this.pass(b, a);
      }
    }
  }

  /** The fuse keeps burning: you inherit whatever time was left on it. */
  pass(from, to) {
    to.bombT = from.bombT;
    from.bombT = 0;
    to.bombLock = C.BOMB_LOCK;
    from.passes++;
    this.events.push({ e: 'pass', from: from.id, to: to.id, x: to.x, y: to.y });
  }

  /* ------------------------------------------------------------------ bots */

  botThink(p, dt, live) {
    p.think -= dt;
    if (p.think > 0) return;
    p.think = 0.12;

    if (!live) { p.input.x = 0; p.input.y = 0; return; }

    const others = this.aliveList().filter((q) => q !== p);
    if (!others.length) { p.input.x = 0; p.input.y = 0; return; }

    let tx = 0, ty = 0;

    if (p.hasBomb) {
      // hunt the closest victim who isn't already holding one
      let best = null, bestD = Infinity;
      for (const q of others) {
        if (q.hasBomb) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best) {
        tx = best.x - p.x; ty = best.y - p.y;
        if (bestD < 130 && p.dashCd <= 0 && p.bombLock <= 0) p.input.dash = true;
      }
    } else {
      const holder = others.find((q) => q.hasBomb);
      if (holder) {
        const d = Math.hypot(holder.x - p.x, holder.y - p.y);
        if (d < 240) {
          tx = p.x - holder.x; ty = p.y - holder.y;
          if (d < 90 && p.dashCd <= 0) p.input.dash = true;
        }
      }
      // drift toward loot, or just mill about
      const loot = this.pickups[0];
      if (!tx && !ty && loot) { tx = loot.x - p.x; ty = loot.y - p.y; }
      if (!tx && !ty) {
        if (Math.random() < 0.25) p.wander = { x: rand(-1, 1), y: rand(-1, 1) };
        tx = p.wander.x; ty = p.wander.y;
      }
    }

    // dodge incoming orbs — ghosts should be a threat, not a death sentence
    for (const o of this.orbs) {
      const dx = p.x - o.x, dy = p.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d > 150) continue;
      tx += (-o.vy / C.ORB_SPEED) * 90;
      ty += (o.vx / C.ORB_SPEED) * 90;
    }

    // never, ever fall off — this overrides everything else
    const dist = Math.hypot(p.x, p.y);
    const edge = this.arena - p.r * 2.5;
    if (dist > edge) {
      const w = clamp((dist - edge) / 60, 0, 1) * 3;
      tx += (-p.x / (dist || 1)) * 100 * w;
      ty += (-p.y / (dist || 1)) * 100 * w;
    }

    const m = Math.hypot(tx, ty) || 1;
    p.input.x = tx / m;
    p.input.y = ty / m;
  }

  /**
   * Dead bots orbit the rim to line up on whoever is closest, then fire.
   * Aim is kept separate from movement: `face` is overwritten by steering every
   * tick, so a bot that aimed with it would shoot wherever it happened to drift.
   */
  ghostBotThink(p) {
    const targets = this.aliveList();
    if (!targets.length) { p.input.x = 0; p.input.y = 0; p.aim = null; return; }

    let best = null, bestD = Infinity;
    for (const q of targets) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = q; }
    }

    // Slide around the ring until we're on the target's side of it.
    const mine = Math.atan2(p.y, p.x);
    const want = Math.atan2(best.y, best.x);
    let diff = want - mine;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const s = clamp(diff * 2, -1, 1);
    p.input.x = -Math.sin(mine) * s;
    p.input.y = Math.cos(mine) * s;

    // Lead the shot slightly, so a moving target isn't a free hit either way.
    const flight = bestD / C.ORB_SPEED;
    const tx = best.x + best.vx * flight * 0.5 - p.x;
    const ty = best.y + best.vy * flight * 0.5 - p.y;
    const m = Math.hypot(tx, ty) || 1;
    p.aim = { x: tx / m, y: ty / m };
    if (p.orbCd <= 0) p.input.dash = true;
  }

  /* --------------------------------------------------------------- network */

  meta() {
    return {
      t: 'meta',
      code: this.code,
      state: this.state,
      round: this.round,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, emoji: p.emoji, color: p.color,
        score: p.score, bot: p.bot,
      })),
    };
  }

  snapshot() {
    let urgent = 0;
    for (const p of this.players.values()) {
      if (p.hasBomb && (urgent === 0 || p.bombT < urgent)) urgent = p.bombT;
    }

    const s = {
      t: 's',
      k: this.tick,
      st: this.state,
      ar: Math.round(this.arena),
      bt: this.state === 'playing' ? urgent : 0,
      bx: this.fuseMax,
      sd: this.sudden ? 1 : 0,
      md: this.mod.name,
      mb: this.mod.blurb,
      mv: [this.mod.accel || 1, this.mod.drag || 1],
      tm: this.state === 'lobby'
        ? (this.players.size >= 2 ? Math.max(0, this.lobbyT) : 0)
        : (this.state === 'countdown' || this.state === 'over' ? Math.max(0, this.timer) : 0),
      w: this.lastWinner,
      p: [],
      u: this.pickups.map((q) => [q.id, Math.round(q.x), Math.round(q.y), q.kind === 'boost' ? 0 : 1]),
      o: this.orbs.map((q) => [q.id, Math.round(q.x), Math.round(q.y), q.color]),
      ev: this.events,
    };

    for (const p of this.players.values()) {
      s.p.push([
        p.id,
        Math.round(p.x), Math.round(p.y),
        Math.round(p.vx), Math.round(p.vy),
        (p.alive ? 1 : 0) | (p.hasBomb ? 2 : 0) | (p.dashT > 0 ? 4 : 0) |
          (p.shield ? 8 : 0) | (p.boost > 0 ? 16 : 0) | (p.falling > 0 ? 32 : 0) |
          (p.ghost ? 64 : 0),
        p.emoteT > 0 ? p.emote : 0,
        Math.round(Math.max(0, 1 - p.dashCd / C.DASH_COOLDOWN) * 100),
        Math.round(p.bombT * 10),
        p.ghost ? Math.round(Math.max(0, 1 - p.orbCd / C.ORB_COOLDOWN) * 100) : 0,
      ]);
    }
    return s;
  }
}

module.exports = { Room, C, TICK, COLORS, MODIFIERS };
