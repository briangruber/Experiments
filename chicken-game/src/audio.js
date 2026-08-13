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

  // A sneeze: a sharp burst of noise with a downward tail.
  sneeze() {
    const v = this._env('sawtooth', 900, 0.09, 0.16);
    if (v) v.osc.frequency.exponentialRampToValueAtTime(300, v.t0 + 0.08);
    const t = this._env('square', 420, 0.3, 0.12, 0.07);
    if (t) t.osc.frequency.exponentialRampToValueAtTime(120, t.t0 + 0.28);
  }

  // Hitting something solid: a wooden knock, no pitch to speak of.
  bonk() {
    const v = this._env('square', 210, 0.11, 0.22);
    if (v) v.osc.frequency.exponentialRampToValueAtTime(70, v.t0 + 0.1);
  }

  // Rain, as a loop of filtered noise whose gain follows the downpour.
  setRain(level) {
    if (this.muted || !this.ctx) return;
    if (!this.rainGain) {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      // Slightly smoothed noise reads as rain rather than as static.
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = last * 0.6 + (Math.random() * 2 - 1) * 0.4;
        d[i] = last;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1400;
      filter.Q.value = 0.5;
      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0;
      src.connect(filter).connect(this.rainGain).connect(this.master);
      src.start();
    }
    this.rainGain.gain.setTargetAtTime(level * 0.22, this.ctx.currentTime, 0.6);
  }

  // A mouse: two tiny squeaks right at the top of the range.
  squeak() {
    for (let i = 0; i < 2; i++) {
      const v = this._env('square', 1900, 0.05, 0.05, i * 0.08);
      if (v) v.osc.frequency.exponentialRampToValueAtTime(2600, v.t0 + 0.045);
    }
  }

  // Wingbeats: a soft flutter, for a chicken briefly and unconvincingly
  // airborne.
  flutter() {
    for (let i = 0; i < 4; i++) this._env('triangle', 130 + i * 18, 0.05, 0.05, i * 0.07);
  }

  // Cock-a-doodle-doo, in four syllables with the long fall at the end.
  crow() {
    const notes = [[540, 0.2, 0], [720, 0.17, 0.21], [900, 0.3, 0.4], [680, 0.5, 0.73]];
    for (const [f, d, at] of notes) {
      const v = this._env('sawtooth', f, d, 0.12, at);
      if (v) v.osc.frequency.exponentialRampToValueAtTime(f * 0.72, v.t0 + d);
    }
  }

  // A fox's bark: short, dry and unpleasant.
  foxBark() {
    const v = this._env('sawtooth', 340, 0.22, 0.16);
    if (!v) return;
    v.osc.frequency.exponentialRampToValueAtTime(150, v.t0 + 0.18);
    this._env('square', 260, 0.14, 0.08, 0.26);
  }

  // ---- Big Bertha: everything an octave down and twice as long -----------

  snore(gain = 1) {
    const v = this._env('sawtooth', 62, 1.1, 0.075 * gain);
    if (!v) return;
    v.osc.frequency.linearRampToValueAtTime(48, v.t0 + 0.55);
    v.osc.frequency.linearRampToValueAtTime(70, v.t0 + 1.05);
  }

  berthaGroan(pitch = 1) {
    const v = this._env('sawtooth', 150 * pitch, 0.85, 0.12);
    if (!v) return;
    v.osc.frequency.exponentialRampToValueAtTime(95 * pitch, v.t0 + 0.5);
    v.osc.frequency.exponentialRampToValueAtTime(130 * pitch, v.t0 + 0.8);
  }

  berthaCall() {
    // A cluck pitched down far enough to sound like a warning.
    const v = this._env('triangle', 250, 0.42, 0.2);
    if (v) v.osc.frequency.exponentialRampToValueAtTime(85, v.t0 + 0.38);
    this._env('sawtooth', 70, 0.6, 0.1, 0.1);
  }

  // Footfall: a short low thump with a click of straw on top.
  thud() {
    const v = this._env('sine', 105, 0.24, 0.28);
    if (v) v.osc.frequency.exponentialRampToValueAtTime(38, v.t0 + 0.2);
    this._env('triangle', 190, 0.05, 0.05);
  }
}
