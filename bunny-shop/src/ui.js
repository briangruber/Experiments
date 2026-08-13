// The DOM half of the game: the HUD, and the speech bubbles that track rabbits
// around the shop.
//
// Bubbles are DOM rather than sprites so the text stays crisp and wraps like
// text should; every frame their world anchor is projected to screen space.

import * as THREE from 'three';
import { STOCK_BY_ID } from './config.js';

const $ = (sel) => document.querySelector(sel);

export class UI {
  constructor({ camera, canvas }) {
    this.camera = camera;
    this.canvas = canvas;

    this.bubbles = $('#bubbles');
    this.toasts = $('#toasts');
    this.ticket = $('#ticket');
    this.ticketName = $('.ticket-name');
    this.ticketBar = $('.ticket-patience i');
    this.ticketItems = $('.ticket-items');
    this.coinsEl = $('#stat-coins b');
    this.dayEl = $('#stat-day b');
    this.starsEl = $('#stat-stars');

    this.streakEl = $('#stat-streak');
    this.alertEl = $('#alert');
    this.alertWhat = $('.alert-what');
    this.alertCall = $('.alert-call');
    this.alertClock = $('.alert-clock b');
    this.padButtons = [];
    this.padBell = null;

    this.live = new Map(); // shopper -> { el, until, anchor }
    this._v = new THREE.Vector3();
  }

  // The touch pad is built in main.js from the stock list; the UI just drives it.
  bindPad(stockEl, bellEl) {
    this.padButtons = [...stockEl.querySelectorAll('.stock-btn')];
    this.padBell = bellEl;
  }

  // ---------------------------------------------------------------- hud

  setCoins(n) {
    this.coinsEl.textContent = n;
    this.coinsEl.parentElement.classList.remove('bump');
    void this.coinsEl.offsetWidth; // restart the animation
    this.coinsEl.parentElement.classList.add('bump');
  }

  setDay(n) {
    this.dayEl.textContent = `Day ${n}`;
  }

  setStreak(n) {
    this.streakEl.hidden = n < 2;
    this.streakEl.querySelector('b').textContent = n;
  }

  setHearts(n, max = 3) {
    const shown = Math.max(n, max);
    this.starsEl.textContent = '★'.repeat(Math.max(0, n)) + '☆'.repeat(Math.max(0, shown - n));
    this.starsEl.classList.toggle('low', n <= 1);
  }

  setClock(fraction) {
    document.documentElement.style.setProperty('--day', String(Math.max(0, fraction)));
  }

  banner(title, sub) {
    const el = document.createElement('div');
    el.className = 'banner';
    el.innerHTML = `<b></b><span></span>`;
    el.querySelector('b').textContent = title;
    el.querySelector('span').textContent = sub;
    this.toasts.append(el);
    setTimeout(() => el.classList.add('out'), 2400);
    setTimeout(() => el.remove(), 3200);
  }

  // ---------------------------------------------------------------- alerts

  setAlert(what, call) {
    this.alertWhat.textContent = what;
    this.alertCall.textContent = call;
    this.alertClock.style.width = '100%';
    this.alertEl.hidden = false;
    this.alertEl.classList.remove('in');
    void this.alertEl.offsetWidth;
    this.alertEl.classList.add('in');
  }

  setAlertClock(fraction) {
    const pct = Math.max(0, Math.min(1, fraction));
    this.alertClock.style.width = `${pct * 100}%`;
    this.alertEl.classList.toggle('urgent', pct < 0.34);
  }

  clearAlert() {
    this.alertEl.hidden = true;
    this.alertEl.classList.remove('urgent');
  }

  // ---------------------------------------------------------------- ticket

  setTicket(shopper) {
    this.setPad(shopper);
    this.ticket.hidden = false;
    this.ticketName.textContent = shopper.name;
    this.ticketItems.replaceChildren(
      ...shopper.order.map(({ id, count }) => {
        const have = shopper.bagged.get(id) ?? 0;
        const stock = STOCK_BY_ID[id];
        const li = document.createElement('li');
        li.className = have >= count ? 'got' : '';
        li.innerHTML = `<span class="e"></span><span class="n"></span><span class="c"></span>`;
        li.querySelector('.e').textContent = stock.emoji;
        li.querySelector('.n').textContent = count === 1 ? stock.label : stock.plural;
        li.querySelector('.c').textContent = `${have}/${count}`;
        return li;
      }),
    );
  }

  setPatience(fraction) {
    const pct = Math.max(0, Math.min(1, fraction));
    this.ticketBar.style.width = `${pct * 100}%`;
    this.ticketBar.dataset.mood = pct > 0.5 ? 'ok' : pct > 0.22 ? 'warn' : 'bad';
  }

  shakeTicket() {
    this.ticket.classList.remove('shake');
    void this.ticket.offsetWidth;
    this.ticket.classList.add('shake');
  }

  hideTicket() {
    this.ticket.hidden = true;
    this.setPad(null);
  }

  // On a phone the produce buttons carry the counts, which is what lets the
  // touch layout drop the itemised receipt off the screen entirely.
  setPad(shopper) {
    for (const btn of this.padButtons) {
      const want = shopper?.order?.find((o) => o.id === btn.dataset.id);
      const have = shopper?.bagged.get(btn.dataset.id) ?? 0;
      btn.classList.toggle('wanted', !!want);
      btn.classList.toggle('filled', !!want && have >= want.count);
      btn.querySelector('.need').textContent = want ? `${have}/${want.count}` : '';
    }
  }

  hintBell(on) {
    this.ticket.classList.toggle('ready', on);
    this.padBell?.classList.toggle('ready', on);
  }

  // ---------------------------------------------------------------- bubbles

  /**
   * Show a line above a rabbit.
   *
   * `ttl` is a floor, not the answer: a bubble should be up long enough to read,
   * and the order lines run to twenty words. The time on screen is derived from
   * the length of the line and only raised by the caller's minimum.
   */
  bubble(shopper, text, { mood = 'plain', ttl = 0, keep = false } = {}) {
    const words = text.trim().split(/\s+/).length;
    // ~3.3 words a second, plus a beat to notice it appeared and a beat to
    // finish on. Generous on purpose — a joke you only half-read is not a joke.
    const readable = 1500 + words * 300;
    ttl = Math.max(ttl, Math.min(readable, 11000));

    // Idle chatter is decoration; a wall of overlapping bubbles is not. Lines
    // now stay up long enough to read, which makes crowding much easier, so
    // background rabbits get one bubble between them and the served rabbit —
    // marked `keep` — always gets through.
    if (!keep) {
      if (document.documentElement.classList.contains('touch')) return;
      let background = 0;
      for (const [, e] of this.live) if (!e.keep) background++;
      if (background >= 1) return;
    }
    this.dropBubble(shopper);

    const el = document.createElement('div');
    el.className = `bubble ${mood}`;
    el.textContent = text;
    this.bubbles.append(el);
    // Let the layout settle before the pop-in, so it scales from its real size.
    requestAnimationFrame(() => el.classList.add('in'));

    this.live.set(shopper, { el, keep, until: performance.now() + ttl });
  }

  dropBubble(shopper) {
    const entry = this.live.get(shopper);
    if (!entry) return;
    this.live.delete(shopper);
    entry.el.classList.remove('in');
    setTimeout(() => entry.el.remove(), 220);
  }

  clearBubbles() {
    for (const [, e] of this.live) e.el.remove();
    this.live.clear();
    this.toasts.replaceChildren();
    this.clearAlert();
  }

  // A floating bit of text that rises from a rabbit and fades.
  float(shopper, text, cls) {
    const el = document.createElement('div');
    el.className = `float ${cls}`;
    el.textContent = text;
    this.bubbles.append(el);

    const p = this.project(shopper.body.anchor(this._v));
    el.style.transform = `translate(-50%,-50%) translate(${p.x}px, ${p.y}px)`;
    requestAnimationFrame(() => el.classList.add('go'));
    setTimeout(() => el.remove(), 1300);
  }

  coinBurst(shopper, amount, note = '') {
    this.float(shopper, note ? `+${amount} 🪙 ${note}` : `+${amount} 🪙`, 'coin');
  }

  heart(shopper) {
    this.float(shopper, '💗', 'love');
  }

  // ---------------------------------------------------------------- frame

  project(world) {
    const v = world.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + (v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-v.y * 0.5 + 0.5) * r.height,
      behind: v.z > 1,
    };
  }

  update() {
    const now = performance.now();
    const placed = [];

    for (const [shopper, entry] of this.live) {
      if (now > entry.until || shopper.done) {
        this.dropBubble(shopper);
        continue;
      }

      const p = this.project(shopper.body.anchor(this._v));
      const w = entry.el.offsetWidth;
      const h = entry.el.offsetHeight;
      let y = p.y - 14;

      // Two rabbits standing near each other would otherwise print one bubble
      // on top of the other; lift the later one clear.
      for (const q of placed) {
        if (Math.abs(q.x - p.x) > (q.w + w) / 2) continue;
        if (y - h < q.y && y > q.y - q.h) y = q.y - q.h - 6;
      }
      placed.push({ x: p.x, y, w, h });

      entry.el.style.transform = `translate(-50%,-100%) translate(${p.x}px, ${y}px)`;
      entry.el.style.opacity = p.behind ? '0' : '';
    }
  }

  // ---------------------------------------------------------------- curtains

  gameOver({ reason, line, rows }) {
    const el = $('#gameover');
    $('#over-title').textContent = reason === 'fired' ? 'The Warren Has Spoken' : 'Closed for the Day';
    $('#over-line').textContent = line;
    $('#over-score').innerHTML = '';
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `<span></span><b></b>`;
      row.querySelector('span').textContent = label;
      row.querySelector('b').textContent = value;
      $('#over-score').append(row);
    }
    el.hidden = false;
  }
}
