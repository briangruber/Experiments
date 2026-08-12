// The shop's rules: who walks in, what they want, and whether you got it right.

import * as THREE from 'three';
import { place } from './assets.js';
import { Customer } from './bunny.js';
import { BAG, COUNTER, CRATE_X, DOOR, OUTSIDE, QUEUE, RULES, SHELVES, STOCK, STOCK_BY_ID, orderShape } from './config.js';
import { SPECIALS, bunnyName, describeOrder, pick, review, say } from './dialogue.js';
import { TWEAKS } from './scene.js';

const rand = (a, b) => a + Math.random() * (b - a);

// A rabbit plus everything the shop knows about it.
class Shopper {
  constructor(body, { special = null } = {}) {
    this.body = body;
    this.special = special;
    this.name = special ? SPECIALS[special].name() : bunnyName();
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
  constructor({ scene, gltf, clips, ui, audio }) {
    this.scene = scene;
    this.gltf = gltf;
    this.clips = clips;
    this.ui = ui;
    this.audio = audio;

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
    this.running = false;
    this.over = false;
    this.bellReady = false;

    this.ui.setCoins(0);
    this.ui.setDay(1);
    this.ui.setHearts(this.hearts);
    this.ui.hideTicket();
    this.ui.clearBubbles();
  }

  start() {
    this.reset();
    this.running = true;
  }

  // ---------------------------------------------------------------- spawning

  spawnGap() {
    const t = Math.pow(RULES.spawnDayFalloff, this.day - 1);
    const lo = Math.max(RULES.spawnGapFloor[0], RULES.spawnGapStart[0] * t);
    const hi = Math.max(RULES.spawnGapFloor[1], RULES.spawnGapStart[1] * t);
    return rand(lo, hi);
  }

  freeQueueSlot() {
    return this.queue.indexOf(null);
  }

  spawn() {
    // A free slot is not enough on its own: browsers hold no slot, so without a
    // crowd cap the shop floor fills up with rabbits who never get in line.
    if (this.freeQueueSlot() < 0 || this.shoppers.length >= RULES.maxQueue + 2) return;

    // The trenchcoat only shows up once the shop is busy enough to sell it.
    const spec = SPECIALS.trenchcoat;
    const special = this.day >= spec.minDay && Math.random() < spec.weight ? 'trenchcoat' : null;
    // The trenchcoat is a stack of round rabbits; otherwise pick a body type.
    const type = special ? 'bunny_round' : Math.random() < 0.62 ? 'bunny_round' : 'bunny_lanky';

    const body = new Customer({
      gltf: this.gltf[type],
      clips: this.clips[type],
      type,
      special,
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

  makeOrder(shopper) {
    const { kinds, most } = orderShape(this.day);
    const pool = [...STOCK];
    const items = [];
    for (let i = 0; i < kinds && pool.length; i++) {
      const [item] = pool.splice(Math.floor(Math.random() * pool.length), 1);
      items.push({ id: item.id, count: 1 + Math.floor(Math.random() * most) });
    }

    // A rabbit in a trenchcoat is three rabbits, and shops accordingly. This is
    // the whole payoff of the joke, so it is worth the extra patience it buys.
    if (shopper.special === 'trenchcoat') for (const i of items) i.count *= 3;

    return items;
  }

  patienceFor(order) {
    const total = order.reduce((n, i) => n + i.count, 0);
    const base = (RULES.patienceBase + total * RULES.patiencePerItem) * Math.pow(RULES.patienceDayFalloff, this.day - 1);
    return Math.max(12, base);
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
      this.ui.bubble(s, say.wrong(), { mood: 'cross', ttl: 2000 });
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
      if (s) this.ui.bubble(s, pick(['Not yet!', 'I am not finished.', 'Bold of you.']), { ttl: 1400 });
      return;
    }
    this.finishOrder(s);
  }

  clickShopper(shopper) {
    if (shopper.petted || shopper.phase === 'leaving' || shopper.phase === 'gone') return;
    shopper.petted = true;
    shopper.patience = Math.min(shopper.patienceMax, shopper.patience + RULES.petBoost);
    shopper.body.playOnce('jump');
    this.ui.bubble(shopper, say.pet(), { mood: 'happy', ttl: 2600 });
    this.ui.heart(shopper);
    this.audio?.pet();
  }

  // ---------------------------------------------------------------- payment

  finishOrder(s) {
    const fraction = s.patience / s.patienceMax;
    const items = s.order.reduce((n, i) => n + i.count, 0);

    const base = items * RULES.coinPerItem;
    const speed = Math.min(1, fraction / RULES.speedTipWindow);
    const tip = Math.round(RULES.tipMax * speed * Math.max(0, 1 - s.mistakes * 0.34));
    const total = base + tip;

    this.coins += total;
    this.served++;
    this.ui.setCoins(this.coins);
    this.ui.coinBurst(s, total);

    const stars = s.mistakes === 0 && fraction > 0.5 ? 5 : s.mistakes <= 1 && fraction > 0.25 ? 4 : 3;
    const line = s.special ? pick(SPECIALS[s.special].thanks) : review(stars);
    this.ui.bubble(s, line, { mood: 'happy', ttl: 3200 });

    s.body.playOnce('jump');
    s.phase = 'paying';
    s.timer = 1.1;

    this.bellReady = false;
    this.ui.hintBell(false);
    this.ui.hideTicket();
    this.clearBag();
    this.audio?.cash();
  }

  loseCustomer(s) {
    s.phase = 'storming';
    s.timer = 1.0;
    this.lost++;
    this.hearts--;
    this.ui.setHearts(this.hearts);
    this.ui.bubble(s, say.rage(), { mood: 'cross', ttl: 3000 });
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

  update(dt) {
    this.updateFlyers(dt);
    for (const s of this.shoppers) s.body.update(dt);

    if (!this.running) return;

    this.dayClock -= dt;
    this.ui.setClock(this.dayClock / RULES.dayLength);
    if (this.dayClock <= 0) this.nextDay();

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
          this.ui.bubble(s, say.browse(), { mood: 'think', ttl: 3400 });
        }
        break;

      case 'browsing':
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
          this.ui.bubble(s, greet, { ttl: 2000 });
        }
        break;

      case 'greeting':
        if (s.timer <= 0) {
          s.order = this.makeOrder(s);
          s.patienceMax = this.patienceFor(s.order);
          s.patience = s.patienceMax;
          s.phase = 'counter';
          this.ui.setTicket(s);
          const template = s.special ? pick(SPECIALS[s.special].order) : say.order();
          this.ui.bubble(s, template.replace('{order}', describeOrder(s.order, STOCK_BY_ID)), { ttl: 5200 });
        }
        break;

      case 'counter': {
        s.patience -= dt;
        const frac = s.patience / s.patienceMax;
        this.ui.setPatience(frac);

        // One nudge partway down, one closer to the end.
        if (frac <= s.nagAt) {
          s.nagAt = frac <= 0.2 ? -1 : 0.2;
          this.ui.bubble(s, say.impatient(), { mood: 'cross', ttl: 2400 });
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
    this.day++;
    this.dayClock = RULES.dayLength;
    this.ui.setDay(this.day);
    this.ui.banner(`Day ${this.day}`, pick([
      'Word is getting around.',
      'The warren is awake.',
      'More rabbits. Always more rabbits.',
      'Someone left a review. It was mostly kind.',
    ]));
  }

  endGame(reason) {
    this.running = false;
    this.over = true;
    this.ui.gameOver({ reason, coins: this.coins, day: this.day, served: this.served, lost: this.lost });
  }
}
