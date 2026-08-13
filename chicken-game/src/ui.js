// DOM overlay: two counters, a hover name tag, and the sound toggle.
// Deliberately no running commentary — what the chickens are doing has to be
// legible from the chickens themselves.

export class UI {
  constructor(audio) {
    this.eggs = 0;
    this.weird = 0;
    this.eggEl = document.getElementById('egg-counter');
    this.weirdEl = document.getElementById('weird-counter');
    this.tagEl = document.getElementById('name-tag');
    this.hintEl = document.getElementById('hint');

    const muteBtn = document.getElementById('mute');
    muteBtn.addEventListener('click', () => {
      audio.setMuted(!audio.muted);
      muteBtn.textContent = audio.muted ? '🔇' : '🔊';
      muteBtn.setAttribute('aria-label', audio.muted ? 'Turn sound on' : 'Turn sound off');
      if (!audio.muted) audio.bok();
    });

    // Wired by main.js once the world exists.
    this.onView = () => {};
    this.onDoor = () => {};
    this.onWorm = () => {};
    this.onHawk = () => {};
    this.onFox = () => {};
    this.onRain = () => {};
    this.onMouse = () => {};

    this.viewBtn = document.getElementById('view');
    this.doorBtn = document.getElementById('act-door');
    this.viewBtn.addEventListener('click', () => this.onView());
    this.doorBtn.addEventListener('click', () => this.onDoor());
    document.getElementById('act-worm').addEventListener('click', () => this.onWorm());
    document.getElementById('act-hawk').addEventListener('click', () => this.onHawk());
    document.getElementById('act-fox').addEventListener('click', () => this.onFox());
    document.getElementById('act-mouse').addEventListener('click', () => this.onMouse());
    this.rainBtn = document.getElementById('act-rain');
    this.rainBtn.addEventListener('click', () => this.onRain());

    this.initFullscreen();
  }

  // Which enclosure the local camera is watching. Purely this viewer's
  // choice — it is never shared.
  setView(name) {
    const outside = name === 'yard';
    this.viewBtn.classList.toggle('outside', outside);
    this.viewBtn.setAttribute('aria-label', outside ? 'Go back inside the coop' : 'Go outside to the run');
  }

  // Shown from dusk until dawn while the pop-hole is still open. It is the
  // only warning the player gets, and it is the difference between a quiet
  // night and losing an egg to a fox.
  setDoorWarning(on) {
    if (this._warn === on) return;
    this._warn = on;
    this.doorBtn.classList.toggle('warn', on);
  }

  setRain(on) {
    if (this._rain === on) return;
    this._rain = on;
    this.rainBtn.classList.toggle('on', on);
    this.rainBtn.setAttribute('aria-label', on ? 'Stop the rain' : 'Make it rain');
  }

  setDoor(open) {
    this.doorBtn.classList.toggle('shut', !open);
    this.doorBtn.setAttribute('aria-label', open ? 'Close the pop-hole' : 'Open the pop-hole');
  }

  // Full screen is not available everywhere: an iframe only gets it if the
  // embedding page allows it, and iOS Safari refuses it for anything that is
  // not a <video>. Rather than leave a button that quietly does nothing, it
  // stays hidden unless the API is really there — and hides itself again if a
  // request is refused at runtime.
  initFullscreen() {
    const btn = document.getElementById('fullscreen');
    if (!btn) return;
    const root = document.documentElement;
    const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
    const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
    const allowed = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? false;
    if (!request || !exit || !allowed) return;

    const current = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

    const sync = () => {
      const on = !!current();
      btn.classList.toggle('is-full', on);
      btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Enter full screen');
    };

    this.toggleFullscreen = () => {
      if (current()) {
        Promise.resolve(exit.call(document)).catch(() => {});
      } else {
        // Older WebKit returns undefined instead of a promise.
        Promise.resolve(request.call(root)).catch(() => { btn.hidden = true; });
      }
    };

    btn.hidden = false;
    btn.addEventListener('click', this.toggleFullscreen);
    // Esc and the browser's own control both leave without a click.
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        this.toggleFullscreen();
      }
    });
    sync();
  }

  // Replaced by initFullscreen when the API is available.
  toggleFullscreen() {}

  addWeird() {
    this.weird++;
    this.weirdEl.textContent = `👁 ${this.weird}`;
  }

  addEgg(n = 1) {
    this.eggs += n;
    this.eggEl.textContent = `🥚 ${this.eggs}`;
    this.eggEl.classList.remove('pop');
    void this.eggEl.offsetWidth;   // restart the animation
    this.eggEl.classList.add('pop');
  }

  // The controls line has done its job once the player has used them.
  dismissHint() {
    if (this.hintEl) this.hintEl.classList.add('gone');
  }

  showTag(text, x, y) {
    this.tagEl.style.display = 'block';
    this.tagEl.style.left = `${x}px`;
    this.tagEl.style.top = `${y}px`;
    this.tagEl.textContent = text;
  }

  hideTag() {
    this.tagEl.style.display = 'none';
  }
}
