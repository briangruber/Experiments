// Thin DOM layer. The game state is the source of truth; this only reflects it.

import { ST, HOLD_LIMIT, GOAL } from './game.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      coins: $('coins'), hold: $('hold'), goalfill: $('goalfill'), goalnum: $('goalnum'),
      goalmax: $('goalmax'), fight: $('fight'), hookwin: $('hookwin'), fishmark: $('fishmark'),
      progfill: $('progfill'), card: $('card'), cardname: $('cardname'), cardmeta: $('cardmeta'),
      cardswatch: $('cardswatch'), toast: $('toast'), prompt: $('prompt'), fps: $('fps'),
    };
    this.el.goalmax.textContent = GOAL;
    this.lastToast = null;
    this.lastCard = null;
  }

  update(fishing, prompt, fps) {
    const e = this.el;
    e.coins.textContent = fishing.coins;
    e.goalnum.textContent = Math.min(fishing.coins, GOAL);
    e.goalfill.style.width = `${Math.min(100, (fishing.coins / GOAL) * 100)}%`;
    e.hold.textContent = fishing.hold.length;
    e.hold.nextElementSibling.textContent = `/${HOLD_LIMIT} in the hold`;

    if (fishing.state === ST.FIGHT) {
      e.fight.classList.remove('hidden');
      // the gauge runs bottom-up, so flip the normalised positions
      e.hookwin.style.bottom = `${(fishing.hookY - 0.13) * 100}%`;
      e.fishmark.style.bottom = `${fishing.fishY * 100}%`;
      e.progfill.style.height = `${fishing.progress * 100}%`;
    } else {
      e.fight.classList.add('hidden');
    }

    if (fishing.card && fishing.card !== this.lastCard) {
      this.lastCard = fishing.card;
      e.cardname.textContent = fishing.card.name;
      e.cardmeta.textContent = `${fishing.card.weight} kg · ${fishing.card.value} coins`;
      e.cardswatch.style.background = fishing.card.col;
      e.card.classList.remove('hidden');
      clearTimeout(this._cardT);
      this._cardT = setTimeout(() => e.card.classList.add('hidden'), 2600);
    }

    if (fishing.toast && fishing.toast !== this.lastToast) {
      this.lastToast = fishing.toast;
      e.toast.textContent = fishing.toast.text;
      e.toast.className = fishing.toast.good ? 'good' : 'bad';
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => e.toast.classList.add('hidden'), 2200);
    }

    if (prompt) {
      e.prompt.innerHTML = prompt.text;
      e.prompt.classList.remove('hidden');
      e.prompt.classList.toggle('urgent', !!prompt.urgent);
    } else {
      e.prompt.classList.add('hidden');
    }

    e.fps.textContent = fps;
  }
}
