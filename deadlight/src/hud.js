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
      tagHave: $('tag-have'),
      tagNeed: $('tag-need'),
      powerHave: $('power-have'),
      powerNeed: $('power-need'),
      letterbox: $('letterbox'),
      cineTitle: $('cine-title'),
      cineSub: $('cine-sub'),
      panel: $('panel'),
      panelTitle: $('panel-title'),
      panelBody: $('panel-body'),
      panelFooter: $('panel-footer'),
      diagnostic: $('diagnostic'),
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
    /** Shown next to the frame rate; see `setBackend`. */
    this._backend = '';
  }

  /**
   * Name the graphics backend on the HUD, permanently.
   *
   * It reads as developer clutter until the day someone says "it's black, I
   * think it's using WebGPU" — and then it is the difference between knowing
   * and guessing, on a device nobody can attach a debugger to. It costs one
   * word in the corner already occupied by the frame rate.
   */
  setBackend(label) {
    this._backend = label ? `${label} · ` : '';
  }

  show() {
    this.el.hud.hidden = false;
  }

  hide() {
    this.el.hud.hidden = true;
    this.setTitle(null);
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

  setTags(have, need) {
    this.el.tagHave.textContent = String(have);
    this.el.tagNeed.textContent = `/${need}`;
  }

  setBreakers(have, need) {
    this.el.powerHave.textContent = String(have);
    this.el.powerNeed.textContent = `/${need}`;
  }

  // ------------------------------------------------------------ cutscenes

  setLetterbox(on, skippable = true) {
    const el = this.el.letterbox;
    el.classList.toggle('no-skip', !skippable);
    // The HUD is the player's instrument panel; during a scripted shot they
    // are not flying. It also stops the gauges colliding with the title.
    this.el.hud.classList.toggle('cine', on);
    if (on) {
      el.hidden = false;
      // One frame between unhiding and adding the class, or the bars have no
      // start state to transition from and simply appear.
      requestAnimationFrame(() => el.classList.add('show'));
    } else {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 560);
    }
  }

  /** Cutscene caption. Passing null clears both lines. */
  setTitle(title, subtitle = null) {
    this.el.cineTitle.textContent = title ?? '';
    this.el.cineSub.textContent = subtitle ?? '';
    this.el.cineTitle.classList.toggle('show', Boolean(title));
    this.el.cineSub.classList.toggle('show', Boolean(subtitle));
  }

  // --------------------------------------------------------- read panel

  showPanel({ title, body, footer }) {
    this.el.panelTitle.textContent = title ?? '';
    this.el.panelBody.innerHTML = body ?? '';
    // HTML, not text: the footer carries the panel's buttons, which are the
    // only way out of a panel on a device with no keyboard.
    this.el.panelFooter.innerHTML = footer ?? '';
    this.el.panel.hidden = false;
  }

  updatePanel(body) {
    this.el.panelBody.innerHTML = body;
  }

  hidePanel() {
    this.el.panel.hidden = true;
  }

  /**
   * Put a rendering failure on screen.
   *
   * Deliberately not a console message: the person who hits this is holding a
   * phone, and the console is not somewhere they can go. Every field here is
   * one they can read back, and together they identify which of the half-dozen
   * causes of "black screen" this actually is.
   *
   * `actions` are the things left to try. A diagnostic with no buttons is a
   * nicer-looking black screen; one with buttons is a way out, and on a phone
   * it is the only way out the player has.
   */
  showDiagnostic(headline, detail, actions = []) {
    const el = this.el.diagnostic;
    if (!el) return;
    el.innerHTML = `<b>${headline}</b>`
      + Object.entries(detail)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `<span>${k}<i>${v}</i></span>`)
        .join('');
    for (const action of actions) {
      if (!action) continue;
      const button = document.createElement('button');
      button.type = 'button';
      if (action.quiet) button.className = 'quiet';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      el.append(button);
    }
    el.hidden = false;
  }

  hideDiagnostic() {
    if (this.el.diagnostic) this.el.diagnostic.hidden = true;
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

  /** The "press E" affordance. Passing null hides it.
   *  `onPrompt` lets the touch layer show its USE button in step. */
  prompt(text) {
    this.onPrompt?.(Boolean(text));
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

    el.fps.textContent = `${this._backend}${state.fps} FPS`;

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
      ['Tags', `${result.tags}/${result.tagsNeeded}`],
      ['Power', result.power ? 'ON' : 'OFF'],
      ['Scares', result.scares],
      ['Peak BPM', Math.round(result.peakBpm)],
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
