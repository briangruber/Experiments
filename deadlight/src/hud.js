// HUD and the end-of-run report.
//
// Written straight to the DOM rather than drawn into the scene. That is the
// right call for a streamed game: DOM text stays crisp through a 480p
// transcode in a way that a texture-mapped in-world HUD does not, and the
// numbers a viewer is watching — heart rate, fuses left — are exactly the ones
// that must survive the worst connection in chat.

const $ = (id) => document.getElementById(id);

/** How long a whisper line stays legible. */
const WHISPER_MS = 3600;

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'),
      crosshair: $('crosshair'),
      battery: $('gauge-battery'),
      batteryBar: $('gauge-battery').querySelector('i'),
      stamina: $('gauge-stamina'),
      staminaBar: $('gauge-stamina').querySelector('i'),
      heart: $('hud-heart'),
      bpm: $('bpm-value'),
      fuseHave: $('fuse-have'),
      fuseNeed: $('fuse-need'),
      scares: $('scare-count'),
      objective: $('objective'),
      lookhint: $('lookhint'),
      prompt: $('prompt'),
      subtitle: $('subtitle'),
      seed: $('seed-value'),
      fps: $('fps'),
      flash: $('flash'),
      blood: $('blood'),
      report: $('report'),
      verdict: $('report-verdict'),
      cause: $('report-cause'),
      grid: $('report-grid'),
      top: $('report-top'),
    };

    this._whisperTimer = 0;
    this._objectiveTimer = 0;
    this._flash = 0;
    this._blood = 0;
  }

  show() {
    this.el.hud.hidden = false;
  }

  hide() {
    this.el.hud.hidden = true;
    this.el.flash.style.opacity = '0';
    this.el.blood.style.opacity = '0';
  }

  /** Tell the player how to look around when pointer lock was refused. */
  setLookMode(locked) {
    this.el.lookhint.hidden = locked;
  }

  setSeed(seed) {
    this.el.seed.textContent = seed;
  }

  setFuses(have, need) {
    this.el.fuseHave.textContent = String(have);
    this.el.fuseNeed.textContent = `/${need}`;
  }

  setScares(n) {
    this.el.scares.textContent = String(n);
  }

  /** A line of objective text, shown for a few seconds. */
  objective(text, seconds = 5) {
    this.el.objective.textContent = text;
    this.el.objective.classList.add('show');
    this._objectiveTimer = seconds;
  }

  whisper(text) {
    this.el.subtitle.textContent = text;
    this.el.subtitle.classList.add('show');
    this._whisperTimer = WHISPER_MS / 1000;
  }

  /** The "press E" affordance. Passing null hides it. */
  prompt(text) {
    if (!text) {
      this.el.prompt.classList.remove('show');
      this.el.crosshair.classList.remove('hot');
      return;
    }
    this.el.prompt.innerHTML = text;
    this.el.prompt.classList.add('show');
    this.el.crosshair.classList.add('hot');
  }

  /** White screen wash, 0..1. Set directly by the director during a scare. */
  flash(value) {
    this._flash = Math.max(this._flash, value);
    if (value === 0) this._flash = 0;
  }

  blood(value) {
    this._blood = value;
  }

  update(dt, state) {
    const el = this.el;

    el.batteryBar.style.transform = `scaleX(${state.battery.toFixed(3)})`;
    el.battery.classList.toggle('low', state.battery < 0.25);
    el.staminaBar.style.transform = `scaleX(${state.stamina.toFixed(3)})`;

    const bpm = Math.round(state.heartRate);
    el.bpm.textContent = String(bpm);
    // Drive the CSS pulse from the real rate, so the icon and the number can
    // never disagree.
    el.heart.style.setProperty('--beat', `${(60 / Math.max(40, bpm)).toFixed(3)}s`);
    el.heart.classList.toggle('panic', bpm > 140);

    el.fps.textContent = `${state.fps} FPS`;

    // Washes decay here rather than in CSS so a scare can drive them per
    // frame without fighting a transition.
    this._flash = Math.max(0, this._flash - dt * 3.4);
    el.flash.style.opacity = this._flash.toFixed(3);
    el.blood.style.opacity = (this._blood ?? 0).toFixed(3);

    if (this._objectiveTimer > 0) {
      this._objectiveTimer -= dt;
      if (this._objectiveTimer <= 0) el.objective.classList.remove('show');
    }
    if (this._whisperTimer > 0) {
      this._whisperTimer -= dt;
      if (this._whisperTimer <= 0) el.subtitle.classList.remove('show');
    }
  }

  // ------------------------------------------------------------- the report

  /**
   * End-of-run card.
   *
   * This is the screenshot. It is built to be paused on and posted, so it
   * leads with the seed — the one number that lets somebody else attempt the
   * same run — and names the scare that did the most damage.
   */
  showReport(result) {
    const el = this.el;
    el.verdict.textContent = result.won ? 'YOU GOT OUT' : 'YOU DIED';
    el.verdict.classList.toggle('win', result.won);
    el.cause.textContent = result.cause;

    const cells = [
      ['Seed', result.seed],
      ['Time', formatTime(result.seconds)],
      ['Fuses', `${result.fuses}/${result.fusesNeeded}`],
      ['Scares', result.scares],
      ['Peak BPM', Math.round(result.peakBpm)],
      ['Closest', `${result.closest.toFixed(1)}m`],
    ];
    el.grid.innerHTML = cells
      .map(([k, v]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('');

    el.top.innerHTML = result.topScare
      ? `worst moment · <b>${result.topScare}</b>`
      : 'not a single flinch. suspicious.';

    el.report.hidden = false;
  }

  hideReport() {
    this.el.report.hidden = true;
  }
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
