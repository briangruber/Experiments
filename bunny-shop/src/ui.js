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

    this.live = new Map(); // shopper -> { el, until, anchor }
    this._v = new THREE.Vector3();
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

  setHearts(n) {
    this.starsEl.textContent = '★'.repeat(Math.max(0, n)) + '☆'.repeat(Math.max(0, 3 - n));
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

  // ---------------------------------------------------------------- ticket

  setTicket(shopper) {
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
  }

  hintBell(on) {
    this.ticket.classList.toggle('ready', on);
  }

  // ---------------------------------------------------------------- bubbles

  bubble(shopper, text, { mood = 'plain', ttl = 3000 } = {}) {
    // Idle chatter is decoration; three overlapping thought bubbles in the
    // middle of the shop is not. The rabbit being served always gets through.
    if (mood === 'think') {
      let thinking = 0;
      for (const [, e] of this.live) if (e.el.classList.contains('think')) thinking++;
      if (thinking >= 2) return;
    }
    this.dropBubble(shopper);

    const el = document.createElement('div');
    el.className = `bubble ${mood}`;
    el.textContent = text;
    this.bubbles.append(el);
    // Let the layout settle before the pop-in, so it scales from its real size.
    requestAnimationFrame(() => el.classList.add('in'));

    this.live.set(shopper, { el, until: performance.now() + ttl });
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

  coinBurst(shopper, amount) {
    this.float(shopper, `+${amount} 🪙`, 'coin');
  }

  heart(shopper) {
    this.float(shopper, '💗', 'love');
  }

  // ---------------------------------------------------------------- frame

  project(world) {
    const v = world.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * r.width,
      y: (-v.y * 0.5 + 0.5) * r.height,
      behind: v.z > 1,
    };
  }

  update() {
    const now = performance.now();
    for (const [shopper, entry] of this.live) {
      if (now > entry.until || shopper.done) {
        this.dropBubble(shopper);
        continue;
      }
      const p = this.project(shopper.body.anchor(this._v));
      entry.el.style.transform = `translate(-50%,-100%) translate(${p.x}px, ${p.y - 14}px)`;
      entry.el.style.opacity = p.behind ? '0' : '';
    }
  }

  // ---------------------------------------------------------------- curtains

  gameOver({ reason, coins, day, served, lost }) {
    const el = $('#gameover');
    $('#over-title').textContent = reason === 'fired' ? 'The Warren Has Spoken' : 'Closed for the Day';
    $('#over-line').textContent =
      reason === 'fired'
        ? 'Three rabbits left unhappy. Word travels fast in a field.'
        : 'A good day. Everyone got a carrot, roughly speaking.';
    $('#over-score').innerHTML = '';
    for (const [label, value] of [
      ['Coins earned', coins],
      ['Days survived', day],
      ['Rabbits served', served],
      ['Rabbits lost', lost],
    ]) {
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
