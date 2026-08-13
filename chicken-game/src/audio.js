// Tiny procedural barnyard: clucks, squawks, and an egg fanfare synthesized
// with plain oscillators. Muted until the user opts in (browser policy makes
// that the sane default anyway).

export class CoopAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = true;
  }

  setMuted(m) {
    this.muted = m;
    if (!m && !this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.3;
      this.master.connect(this.ctx.destination);
    }
    if (!m && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _env(type, freq, dur, gain = 0.2, when = 0) {
    if (this.muted || !this.ctx) return null;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    return { osc, t0 };
  }

  cluck(pitch = 1, when = 0) {
    const v = this._env('triangle', 620 * pitch, 0.09, 0.16, when);
    if (v) v.osc.frequency.exponentialRampToValueAtTime(260 * pitch, v.t0 + 0.08);
  }

  bok(pitch = 1) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.cluck(pitch * (0.92 + Math.random() * 0.16), i * 0.14);
  }

  squawk(pitch = 1) {
    const v = this._env('sawtooth', 480 * pitch, 0.32, 0.1);
    if (!v) return;
    v.osc.frequency.exponentialRampToValueAtTime(900 * pitch, v.t0 + 0.1);
    v.osc.frequency.exponentialRampToValueAtTime(280 * pitch, v.t0 + 0.3);
  }

  fanfare() {
    this.cluck(1.3, 0);
    this._env('triangle', 660, 0.14, 0.14, 0.18);
    this._env('triangle', 880, 0.22, 0.14, 0.3);
  }

  pop() {
    const v = this._env('sine', 300, 0.12, 0.2);
    if (v) v.osc.frequency.exponentialRampToValueAtTime(90, v.t0 + 0.11);
  }
}
