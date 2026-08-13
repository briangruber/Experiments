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
    this.pointer = el('ring-pointer');
    this.pointerDist = el('ring-pointer').querySelector('b');
    this.coach = el('coach');
    this.coachText = el('coach-text');
    this.pipL = el('pip-l');
    this.pipR = el('pip-r');

    this.last = { speed: -1, score: -1, combo: -1, alt: -1, fps: -1, ret: '', pips: '', ringDist: -1, coach: undefined };
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

  /**
   * Point at the next ring when it is off screen. `ndc` is the ring in clipped
   * device coordinates and `behind` says the camera is facing away from it —
   * without that flag a target behind you projects to the wrong edge entirely.
   */
  setRingPointer(ndc, behind, metres, w, h) {
    if (!ndc) { this.pointer.hidden = true; return; }
    let x = ndc.x, y = ndc.y;
    if (behind) { x = -x; y = -y; }
    const onScreen = !behind && Math.abs(x) < 0.86 && Math.abs(y) < 0.82;
    if (onScreen) { this.pointer.hidden = true; return; }

    // Push the direction out to the screen edge, keeping its angle.
    const scale = 0.86 / Math.max(Math.abs(x), Math.abs(y) * 0.95, 1e-3);
    x *= scale; y *= scale;
    const px = (x * 0.5 + 0.5) * w;
    const py = (0.5 - y * 0.5) * h;
    const angle = Math.atan2(-y, x) + Math.PI / 2;
    this.pointer.hidden = false;
    this.pointer.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) rotate(${angle}rad)`;
    const d = Math.round(metres);
    if (d !== this.last.ringDist) {
      this.last.ringDist = d;
      this.pointerDist.firstChild.nodeValue = String(d);
    }
  }

  /** One line of coaching, or null to clear it. */
  setCoach(html) {
    if (html === this.last.coach) return;
    this.last.coach = html;
    if (!html) { this.coach.hidden = true; return; }
    this.coach.hidden = false;
    this.coachText.innerHTML = html;
    // Restart the entry animation.
    this.coach.style.animation = 'none';
    void this.coach.offsetWidth;
    this.coach.style.animation = '';
  }

  /** In one-button play the hand pips mean nothing; hide them. */
  setSimple(simple) {
    this.simple = simple;
    this.pipL.style.display = simple ? 'none' : '';
    this.pipR.style.display = simple ? 'none' : '';
  }

  /** Light the hand pips for the sides that currently have something to grab. */
  setSides(left, right) {
    if (this.simple) return;
    const key = `${left}${right}`;
    if (key === this.last.pips) return;
    this.last.pips = key;
    this.pipL.classList.toggle('on', left);
    this.pipR.classList.toggle('on', right);
  }
}
