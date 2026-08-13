// The shop's rules: who walks in, what they want, and whether you got it right.

import * as THREE from 'three';
import { place } from './assets.js';
import { Customer } from './bunny.js';
import { BAG, COUNTER, CRATE_X, DOOR, OUTSIDE, QUEUE, RULES, SHELVES, STOCK, STOCK_BY_ID, orderShape } from './config.js';
import { ANTICS, DAY_REVIEWS, EVENTS, SPECIALS, STREAK_LINES, bunnyName, describeOrder, pick, review, say } from './dialogue.js';
import { TWEAKS } from './scene.js';

const rand = (a, b) => a + Math.random() * (b - a);

// A rabbit plus everything the shop knows about it.
class Shopper {
  constructor(body, { special = null } = {}) {
    this.body = body;
    this.special = special;
    this.spec = special ? SPECIALS[special] : null;
    this.name = this.spec ? this.spec.name() : bunnyName();
    this.phase = 'entering';
    this.timer = 0;
    this.order = null;
    this.bagged = new Map();
    this.patience = 1;
    this.patienceMax = 1;
    this.mistakes = 0;
    this.petted = false;
    this.queueIndex = -1;
    this.bubble = null;
    this.nagAt = 0.45;
  }

  get done() {
    return this.phase === 'gone';
  }

  // Everything still owed on this order.
  remaining() {
    if (!this.order) return [];
    return this.order
      .map(({ id, count }) => ({ id, count: count - (this.bagged.get(id) ?? 0) }))
      .filter((r) => r.count > 0);
  }

  complete() {
    return this.order != null && this.remaining().length === 0;
  }
}

export class Game {
  constructor({ scene, gltf, clips, ui, audio, obstacles = [] }) {
    this.scene = scene;
    this.gltf = gltf;
    this.clips = clips;
    this.ui = ui;
    this.audio = audio;
    this.obstacles = obstacles;

    this.shoppers = [];
    this.flyers = [];
    this.bagItems = [];
    this.queue = new Array(RULES.maxQueue).fill(null);

    this.reset();
  }

  reset() {
    for (const s of this.shoppers) s.body.dispose(this.scene);
    this.shoppers.length = 0;
    this.queue.fill(null);
    this.clearBag();

    this.coins = 0;
    this.day = 1;
    this.hearts = RULES.startHearts;
    this.dayClock = RULES.dayLength;
    this.spawnIn = 1.6;
    this.served = 0;
    this.lost = 0;
    this.streak = 0;
    this.best = 0;
    this.petted = 0;
    this.running = false;
    this.over = false;
    this.bellReady = false;
    this.event = null;
    this.lastEvent = null;
    this.eventLeft = 0;
    this.eventIn = rand(...RULES.eventFirst);

    this.ui.setCoins(0);
    this.ui.setDay(1);
    this.ui.setHearts(this.hearts);
    this.ui.setStreak(0);
    this.ui.hideTicket();
    this.ui.clearBubbles();
  }

  start() {
    this.reset();
    this.running = true;
  }

  // ---------------------------------------------------------------- events

  // Whatever the shop is currently going through, or an empty set of modifiers.
  get mods() {
    return this.event ?? {};
  }

  startEvent() {
    const options = EVENTS.filter((e) => e.minDay <= this.day && e.id !== this.lastEvent);
    if (!options.length) return;
    this.event = pick(options);
    this.lastEvent = this.event.id;
    this.eventLeft = this.event.duration;
    this.ui.banner(...this.event.banner);
    this.audio?.event();
  }

  endEvent() {
    const over = this.event?.over;
    this.event = null;
    this.eventIn = rand(...RULES.eventGap);
    if (over) this.ui.banner('Back to normal', over);
  }

  updateEvent(dt) {
    if (this.event) {
      this.eventLeft -= dt;
      if (this.eventLeft <= 0) this.endEvent();
      return;
    }
    this.eventIn -= dt;
    if (this.eventIn <= 0) this.startEvent();
  }

  // ---------------------------------------------------------------- spawning

  spawnGap() {
    const t = Math.pow(RULES.spawnDayFalloff, this.day - 1);
    const scale = this.mods.spawnScale ?? 1;
    const lo = Math.max(RULES.spawnGapFloor[0] * scale, RULES.spawnGapStart[0] * t * scale);
    const hi = Math.max(RULES.spawnGapFloor[1] * scale, RULES.spawnGapStart[1] * t * scale);
    return rand(lo, hi);
  }

  freeQueueSlot() {
    return this.queue.indexOf(null);
  }

  spawn() {
    // A free slot is not enough on its own: browsers hold no slot, so without a
    // crowd cap the shop floor fills up with rabbits who never get in line.
    if (this.freeQueueSlot() < 0 || this.shoppers.length >= RULES.maxQueue + 2) return;

    const special = this.rollSpecial();
    const spec = special ? SPECIALS[special] : null;
    const type = spec?.body ?? (Math.random() < 0.62 ? 'bunny_round' : 'bunny_lanky');

    const body = new Customer({
      gltf: this.gltf[type],
      clips: this.clips[type],
      type,
      stack: spec?.build === 'stack',
      sizeScale: spec?.scale ?? 1,
      extras: { trenchcoat: this.gltf.trenchcoat },
    });
    body.setPosition(OUTSIDE.x + rand(-0.5, 0.5), OUTSIDE.z);

    const shopper = new Shopper(body, { special });
    this.scene.add(body.root);
    this.shoppers.push(shopper);

    body.goTo(DOOR.x, DOOR.z + 1.2);
    shopper.phase = 'entering';
    this.audio?.doorbell();
  }

  // At most one special per customer, each gated on the day and its own weight.
  rollSpecial() {
    for (const [id, spec] of Object.entries(SPECIALS)) {
      if (this.day < spec.minDay) continue;
      if (Math.random() < spec.weight) return id;
    }
    return null;
  }

  makeOrder(shopper) {
    const { kinds, most } = orderShape(this.day);
    // A rumour takes an item off every order until it blows over.
    const pool = STOCK.filter((i) => i.id !== this.mods.banItem);
    const items = [];
    for (let i = 0; i < kinds && pool.length; i++) {
      const [item] = pool.splice(Math.floor(Math.random() * pool.length), 1);
      items.push({ id: item.id, count: 1 + Math.floor(Math.random() * most) });
    }

    // A rabbit in a trenchcoat is three rabbits, and shops accordingly. This is
    // the whole payoff of the joke, so it is worth the extra patience it buys.
    if (shopper.special === 'trenchcoat') for (const i of items) i.count *= 3;

    // Whatever the shop has gone mad for this minute ends up in every order.
    const craze = this.mods.forceItem;
    if (craze && !items.some((i) => i.id === craze)) {
      items[Math.floor(Math.random() * items.length)] = { id: craze, count: 1 + Math.floor(Math.random() * most) };
    }
    if (this.mods.orderScale) for (const i of items) i.count *= this.mods.orderScale;

    // The very small one has planned exactly one purchase all week, whatever
    // the rest of the warren is doing.
    if (shopper.special === 'tiny') return [{ id: items[0].id, count: 1 }];

    // The inspector checks the range, not the volume: three different things.
    if (shopper.special === 'inspector') {
      const pool = [...STOCK].sort(() => Math.random() - 0.5).slice(0, 3);
      return pool.map((item) => ({ id: item.id, count: 1 }));
    }

    return items;
  }

  patienceFor(order, shopper) {
    const total = order.reduce((n, i) => n + i.count, 0);
    const base = (RULES.patienceBase + total * RULES.patiencePerItem) * Math.pow(RULES.patienceDayFalloff, this.day - 1);
    return Math.max(12, base * (shopper.spec?.patienceScale ?? 1) * (this.mods.patienceScale ?? 1));
  }

  // ---------------------------------------------------------------- queue

  // Pull everyone forward when a slot opens up.
  compactQueue() {
    const waiting = this.queue.filter(Boolean);
    this.queue.fill(null);
    waiting.forEach((s, i) => {
      this.queue[i] = s;
      if (s.queueIndex !== i) {
        s.queueIndex = i;
        s.body.goTo(QUEUE[i].x, QUEUE[i].z);
        s.phase = i === 0 ? 'approaching' : 'queue';
      }
    });
  }

  joinQueue(shopper) {
    const slot = this.freeQueueSlot();
    if (slot < 0) return false;
    this.queue[slot] = shopper;
    shopper.queueIndex = slot;
    shopper.phase = slot === 0 ? 'approaching' : 'queue';
    shopper.body.goTo(QUEUE[slot].x, QUEUE[slot].z);
    return true;
  }

  leaveQueue(shopper) {
    const i = this.queue.indexOf(shopper);
    if (i >= 0) this.queue[i] = null;
    this.compactQueue();
  }

  get current() {
    return this.queue[0]?.phase === 'counter' ? this.queue[0] : null;
  }

  // ---------------------------------------------------------------- input

  clickCrate(id) {
    const s = this.current;
    if (!s) return;

    const need = s.order.find((o) => o.id === id);
    const have = s.bagged.get(id) ?? 0;

    if (!need || have >= need.count) {
      s.mistakes++;
      s.patience = Math.max(0, s.patience - RULES.wrongItemPenalty);
      s.body.playOnce('hurt');
      this.ui.bubble(s, s.spec?.wrong ? pick(s.spec.wrong) : say.wrong(), { mood: 'cross', keep: true });
      this.breakStreak();
      this.audio?.wrong();
      this.ui.shakeTicket();
      return;
    }

    s.bagged.set(id, have + 1);
    this.throwToBag(id);
    this.audio?.pop();
    this.ui.setTicket(s);

    if (s.complete()) {
      this.bellReady = true;
      this.ui.hintBell(true);
    }
  }

  clickBell() {
    const s = this.current;
    this.audio?.ding();
    if (!s || !s.complete()) {
      // Ringing early is a legitimate thing to do by accident; the rabbit has
      // opinions about it, but it costs nothing.
      if (s) this.ui.bubble(s, pick(['Not yet!', 'I am not finished.', 'Bold of you.']), { keep: true });
      return;
    }
    this.finishOrder(s);
  }

  clickShopper(shopper) {
    if (shopper.petted || shopper.phase === 'leaving' || shopper.phase === 'gone') return;
    shopper.petted = true;
    this.petted++;
    // The very small one is disproportionately affected by kindness.
    const boost = RULES.petBoost * (shopper.special === 'tiny' ? 2 : 1);
    shopper.patience = Math.min(shopper.patienceMax, shopper.patience + boost);
    shopper.body.playOnce('jump');
    this.ui.bubble(shopper, say.pet(), { mood: 'happy', keep: true });
    this.ui.heart(shopper);
    this.audio?.pet();
  }

  // ---------------------------------------------------------------- payment

  finishOrder(s) {
    const fraction = s.patience / s.patienceMax;
    const items = s.order.reduce((n, i) => n + i.count, 0);
    const clean = s.mistakes === 0;

    if (clean) this.extendStreak();
    else this.breakStreak();

    const base = items * RULES.coinPerItem;
    const speed = Math.min(1, fraction / RULES.speedTipWindow);
    // A run of flawless orders is worth more than any single one of them.
    const runBonus = 1 + Math.min(RULES.streakTipCap, this.streak * RULES.streakTipStep);
    const tip = Math.round(
      RULES.tipMax * speed * Math.max(0, 1 - s.mistakes * 0.34) * runBonus * (s.spec?.tipScale ?? 1) * (this.mods.tipScale ?? 1),
    );
    const total = base + tip;

    this.coins += total;
    this.served++;
    this.ui.setCoins(this.coins);
    this.ui.coinBurst(s, total, s.special === 'tiny' && tip === 0 ? 'and a button' : '');

    const stars = clean && fraction > 0.5 ? 5 : s.mistakes <= 1 && fraction > 0.25 ? 4 : 3;
    const line = s.spec ? pick(s.spec.thanks) : review(stars);
    this.ui.bubble(s, clean || !s.spec?.failLine ? line : s.spec.failLine, { mood: 'happy', keep: true });

    // A flawless inspection buys back a star.
    const reward = clean ? s.spec?.reward : null;
    if (reward?.hearts && this.hearts < RULES.maxHearts) {
      this.hearts = Math.min(RULES.maxHearts, this.hearts + reward.hearts);
      this.ui.setHearts(this.hearts);
      this.ui.banner(...reward.banner);
    }

    s.body.playOnce('jump');
    s.phase = 'paying';
    s.timer = 1.1;

    this.bellReady = false;
    this.ui.hintBell(false);
    this.ui.hideTicket();
    this.clearBag();
    this.audio?.cash();
  }

  // ---------------------------------------------------------------- streak

  extendStreak() {
    this.streak++;
    this.best = Math.max(this.best, this.streak);
    this.ui.setStreak(this.streak);
    const milestone = STREAK_LINES[this.streak];
    if (milestone) {
      this.ui.banner(...milestone);
      this.audio?.fanfare(this.streak);
    }
  }

  breakStreak() {
    if (this.streak >= 5) this.ui.banner('Streak over', `${this.streak} in a row. It was good while it lasted.`);
    this.streak = 0;
    this.ui.setStreak(0);
  }

  loseCustomer(s) {
    this.breakStreak();
    s.phase = 'storming';
    s.timer = 1.0;
    this.lost++;
    this.hearts--;
    this.ui.setHearts(this.hearts);
    this.ui.bubble(s, say.rage(), { mood: 'cross', keep: true });
    this.ui.hideTicket();
    this.clearBag();
    this.bellReady = false;
    this.ui.hintBell(false);
    s.body.playOnce('hurt');
    this.audio?.storm();

    if (this.hearts <= 0) this.endGame('fired');
  }

  // ---------------------------------------------------------------- bag

  // Produce arcs from its crate into the basket, then stays there until the
  // order is paid for.
  throwToBag(id) {
    const i = STOCK.findIndex((s) => s.id === id);
    const model = place(this.gltf[id], { ...TWEAKS[id], height: TWEAKS[id].height * 0.8, clone: true });
    const from = new THREE.Vector3(CRATE_X[i], COUNTER.top + 0.4, COUNTER.z - 0.16);
    const n = this.bagItems.length;
    const to = new THREE.Vector3(
      BAG.x + Math.cos(n * 2.4) * 0.1,
      BAG.y + 0.16 + Math.floor(n / 3) * 0.09,
      BAG.z + Math.sin(n * 2.4) * 0.1,
    );

    model.position.copy(from);
    this.scene.add(model);
    this.bagItems.push(model);
    this.flyers.push({
      model,
      from,
      to,
      t: 0,
      dur: 0.42,
      spin: rand(-6, 6),
      arc: rand(0.5, 0.8),
    });
  }

  clearBag() {
    for (const m of this.bagItems) {
      this.scene.remove(m);
      m.traverse((o) => o.isMesh && o.geometry.dispose?.());
    }
    this.bagItems.length = 0;
    this.flyers.length = 0;
  }

  updateFlyers(dt) {
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      f.t += dt / f.dur;
      const t = Math.min(1, f.t);
      f.model.position.lerpVectors(f.from, f.to, t);
      f.model.position.y += Math.sin(t * Math.PI) * f.arc;
      f.model.rotation.y += f.spin * dt;
      f.model.rotation.x = Math.sin(t * Math.PI) * 0.8;
      if (t >= 1) this.flyers.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- loop

  // Shove a rabbit back out of any furniture it has ended up inside, along
  // whichever axis it is least far in. Walking speeds are slow next to the size
  // of a shelf, so this catches everything without needing real pathfinding —
  // and it means a badly placed waypoint can never park a rabbit in a counter.
  separate(body) {
    const r = body.radius;
    const p = body.pos; // Vector2, where y is world z
    let moved = false;

    for (const b of this.obstacles) {
      if (p.x + r <= b.minX || p.x - r >= b.maxX || p.y + r <= b.minZ || p.y - r >= b.maxZ) continue;

      const outLeft = p.x + r - b.minX;
      const outRight = b.maxX - (p.x - r);
      const outNear = p.y + r - b.minZ;
      const outFar = b.maxZ - (p.y - r);
      const least = Math.min(outLeft, outRight, outNear, outFar);

      if (least === outLeft) p.x -= outLeft;
      else if (least === outRight) p.x += outRight;
      else if (least === outNear) p.y -= outNear;
      else p.y += outFar;
      moved = true;
    }

    if (moved) body.root.position.set(p.x, 0, p.y);
  }

  // Push overlapping rabbits apart, half a correction each. Without this a
  // queue in perspective reads as one wide rabbit.
  separateShoppers() {
    for (let i = 0; i < this.shoppers.length; i++) {
      for (let j = i + 1; j < this.shoppers.length; j++) {
        const a = this.shoppers[i].body;
        const b = this.shoppers[j].body;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.y - a.pos.y;
        const want = a.radius + b.radius;
        const d = Math.hypot(dx, dz);
        if (d >= want || d < 1e-4) continue;

        const push = (want - d) / 2;
        const nx = dx / d;
        const nz = dz / d;
        a.pos.x -= nx * push;
        a.pos.y -= nz * push;
        b.pos.x += nx * push;
        b.pos.y += nz * push;
        a.root.position.set(a.pos.x, 0, a.pos.y);
        b.root.position.set(b.pos.x, 0, b.pos.y);
      }
    }
  }

  update(dt) {
    this.updateFlyers(dt);
    for (const s of this.shoppers) s.body.update(dt);
    this.separateShoppers();
    // Furniture wins: resolve rabbit-on-rabbit first, then push the results
    // back out of the fittings so nobody gets shoved into a shelf.
    for (const s of this.shoppers) this.separate(s.body);

    if (!this.running) return;

    this.dayClock -= dt;
    this.ui.setClock(this.dayClock / RULES.dayLength);
    if (this.dayClock <= 0) this.nextDay();

    this.updateEvent(dt);

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      this.spawn();
      this.spawnIn = this.spawnGap();
    }

    for (const s of this.shoppers) this.updateShopper(s, dt);

    // Reap anyone who has left the building.
    for (let i = this.shoppers.length - 1; i >= 0; i--) {
      const s = this.shoppers[i];
      if (!s.done) continue;
      s.body.dispose(this.scene);
      this.ui.dropBubble(s);
      this.shoppers.splice(i, 1);
    }
  }

  updateShopper(s, dt) {
    const b = s.body;
    s.timer -= dt;

    switch (s.phase) {
      case 'entering':
        if (b.arrived) {
          // Browse first if there is anywhere to browse, otherwise straight to
          // the back of the queue.
          if (Math.random() < 0.75) {
            const shelf = pick(SHELVES);
            b.goTo(shelf.browse.x + rand(-0.4, 0.4), shelf.browse.z + rand(-0.3, 0.3));
            s.phase = 'walking-to-shelf';
          } else if (!this.joinQueue(s)) {
            s.phase = 'loitering';
            s.timer = 2;
          }
        }
        break;

      case 'walking-to-shelf':
        if (b.arrived) {
          s.phase = 'browsing';
          s.timer = rand(2.6, 6.0);
          b.wantFacing = Math.PI; // face the shelf
          this.ui.bubble(s, say.browse(), { mood: 'think' });
        }
        break;

      case 'browsing':
        // Rabbits left alone for a few seconds do something unprompted. It is
        // the cheapest possible life in a shop that is mostly a queue.
        if (Math.random() < RULES.anticChance * dt) {
          const bit = pick(ANTICS);
          b.playOnce(bit.anim);
          this.ui.bubble(s, bit.line, { mood: bit.anim === 'jump' ? 'happy' : 'cross' });
        }
        if (s.timer <= 0) {
          if (!this.joinQueue(s)) {
            s.timer = rand(1.5, 3);
          }
        }
        break;

      case 'loitering':
        if (s.timer <= 0 && !this.joinQueue(s)) s.timer = 2;
        break;

      case 'queue':
        // Waiting further back costs nothing; they just shuffle and wait.
        break;

      case 'approaching':
        if (b.arrived) {
          b.faceCamera();
          s.phase = 'greeting';
          s.timer = 1.15;
          const greet = s.special ? pick(SPECIALS[s.special].greet) : say.greet();
          this.ui.bubble(s, greet, { keep: true });
        }
        break;

      case 'greeting':
        if (s.timer <= 0) {
          s.order = this.makeOrder(s);
          s.patienceMax = this.patienceFor(s.order, s);
          s.patience = s.patienceMax;
          s.phase = 'counter';
          this.ui.setTicket(s);
          const template = s.special ? pick(SPECIALS[s.special].order) : say.order();
          this.ui.bubble(s, template.replace('{order}', describeOrder(s.order, STOCK_BY_ID)), { ttl: 6500, keep: true });
        }
        break;

      case 'counter': {
        s.patience -= dt;
        const frac = s.patience / s.patienceMax;
        this.ui.setPatience(frac);

        // One nudge partway down, one closer to the end.
        if (frac <= s.nagAt) {
          s.nagAt = frac <= 0.2 ? -1 : 0.2;
          this.ui.bubble(s, say.impatient(), { mood: 'cross', keep: true });
        }
        if (s.patience <= 0) this.loseCustomer(s);
        break;
      }

      case 'paying':
        if (s.timer <= 0) {
          this.leaveQueue(s);
          s.phase = 'leaving';
          b.goTo(DOOR.x, DOOR.z - 1.5);
        }
        break;

      case 'storming':
        if (s.timer <= 0) {
          this.leaveQueue(s);
          s.phase = 'leaving';
          b.goTo(DOOR.x, DOOR.z - 1.5, { run: true });
        }
        break;

      case 'leaving':
        if (b.arrived) s.phase = 'gone';
        break;
    }
  }

  nextDay() {
    // The day's own numbers make the joke, so the banner is written from them.
    const summary = pick(DAY_REVIEWS)(this);
    this.day++;
    this.dayClock = RULES.dayLength;
    this.ui.setDay(this.day);
    this.ui.banner(`Day ${this.day}`, summary);
  }

  endGame(reason) {
    this.running = false;
    this.over = true;
    this.ui.gameOver({
      reason,
      line:
        reason === 'fired'
          ? 'Three rabbits left unhappy. Word travels fast in a field.'
          : 'A good day. Everyone got a carrot, roughly speaking.',
      rows: [
        ['Coins earned', this.coins],
        ['Days survived', this.day],
        ['Rabbits served', this.served],
        ['Rabbits lost', this.lost],
        ['Rabbits petted', this.petted],
        ['Best clean run', this.best],
      ],
    });
  }
}
