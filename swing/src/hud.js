// HUD. Only touches the DOM when a value actually changes — at 120 Hz the
// string formatting is otherwise the most expensive thing on the main thread.

const el = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = el('hud');
    this.speed = el('stat-speed');
    this.speedValue = this.speed.querySelector('b');
    this.score = el('score-value');
    this.combo = el('combo');
    this.comboX = el('combo-x');
    this.comboBar = el('combo-bar').querySelector('u');
    this.alt = el('tape-alt');
    this.fps = el('tape-fps');
    this.feed = el('feed');
    this.reticle = el('reticle');
    this.pipL = el('pip-l');
    this.pipR = el('pip-r');

    this.last = { speed: -1, score: -1, combo: -1, alt: -1, fps: -1, ret: '', pips: '' };
    this.frames = 0;
    this.acc = 0;
    this.visible = true;
  }

  show(on) {
    this.root.hidden = !on;
  }

  toggle() {
    this.visible = !this.visible;
    this.root.style.opacity = this.visible ? '1' : '0';
  }

  say(text, big = false) {
    const d = document.createElement('div');
    d.textContent = text;
    if (big) d.className = 'big';
    this.feed.appendChild(d);
    setTimeout(() => d.remove(), 1500);
    while (this.feed.children.length > 5) this.feed.firstChild.remove();
  }

  update(dt, player, rings) {
    const kmh = Math.round(player.speed * 3.6);
    if (kmh !== this.last.speed) {
      this.last.speed = kmh;
      this.speedValue.textContent = kmh;
      this.speed.classList.toggle('fast', kmh > 190);
    }

    if (rings.score !== this.last.score) {
      this.last.score = rings.score;
      this.score.textContent = rings.score.toLocaleString();
    }

    const showCombo = rings.combo > 1;
    if (showCombo !== !this.combo.hidden || rings.combo !== this.last.combo) {
      this.combo.hidden = !showCombo;
      this.last.combo = rings.combo;
      this.comboX.textContent = `x${rings.combo}`;
    }
    if (showCombo) this.comboBar.style.transform = `scaleX(${Math.max(0, rings.comboLeft / 5)})`;

    const alt = Math.round(player.pos.y);
    if (alt !== this.last.alt) {
      this.last.alt = alt;
      this.alt.innerHTML = `${alt}<span>m</span>`;
    }

    this.acc += dt;
    this.frames++;
    if (this.acc >= 0.5) {
      const f = Math.round(this.frames / this.acc);
      if (f !== this.last.fps) { this.last.fps = f; this.fps.textContent = `${f} fps`; }
      this.acc = 0;
      this.frames = 0;
    }
  }

  /** `state` is '', 'live' (anchor in range) or 'held' (swinging). */
  setReticle(state) {
    if (state === this.last.ret) return;
    this.last.ret = state;
    this.reticle.className = state;
  }

  /** Light the hand pips for the sides that currently have something to grab. */
  setSides(left, right) {
    const key = `${left}${right}`;
    if (key === this.last.pips) return;
    this.last.pips = key;
    this.pipL.classList.toggle('on', left);
    this.pipR.classList.toggle('on', right);
  }
}
