// Every sound here is synthesised at runtime. No assets to load, no licences to
// worry about, and the whole file is smaller than one .wav.

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
  }

  /** Must be called from a user gesture or the browser will not allow sound. */
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.noiseBuffer = this.makeNoise();
    this.startWind();
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  noise({ duration = 0.4, gain = 0.3, freq = 900, q = 1, type = 'bandpass', sweep = 0 }) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    if (sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(60, freq + sweep), this.ctx.currentTime + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
    src.connect(filt).connect(g).connect(this.master);
    src.start();
    src.stop(this.ctx.currentTime + duration + 0.02);
  }

  tone({ freq = 440, to = null, duration = 0.3, gain = 0.2, type = 'sine', delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** Constant sea/wind bed, ducked by nothing -- it is the room tone. */
  startWind() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.value = 0.045;
    src.connect(filt).connect(g).connect(this.master);
    src.start();
    this.windGain = g;
    this.windFilter = filt;
  }

  /** Louder and brighter the faster you go. */
  setSpeed(v) {
    if (!this.windGain) return;
    this.windGain.gain.value = 0.04 + Math.min(v, 1) * 0.075;
    this.windFilter.frequency.value = 380 + Math.min(v, 1) * 700;
  }

  throw_() { this.noise({ duration: 0.28, gain: 0.22, freq: 1600, sweep: -1200, q: 0.7 }); }
  hit() {
    this.noise({ duration: 0.18, gain: 0.35, freq: 260, q: 1.4 });
    this.tone({ freq: 150, to: 60, duration: 0.2, gain: 0.22, type: 'square' });
  }
  splash(strength = 1) {
    this.noise({ duration: 0.3 + strength * 0.2, gain: 0.1 + strength * 0.12, freq: 1400, sweep: -900, q: 0.6 });
  }
  snap() {
    this.tone({ freq: 900, to: 120, duration: 0.35, gain: 0.3, type: 'sawtooth' });
    this.noise({ duration: 0.25, gain: 0.25, freq: 2600, sweep: -2000 });
  }
  winch() { this.noise({ duration: 0.09, gain: 0.07, freq: 520, q: 5 }); }
  hurt() {
    this.noise({ duration: 0.45, gain: 0.4, freq: 180, q: 0.8, sweep: -120 });
    this.tone({ freq: 90, to: 42, duration: 0.5, gain: 0.28, type: 'sawtooth' });
  }
  roar(tier = 0) {
    const base = 118 - tier * 11;
    this.tone({ freq: base, to: base * 0.62, duration: 1.1, gain: 0.3, type: 'sawtooth' });
    this.tone({ freq: base * 1.5, to: base * 0.9, duration: 0.9, gain: 0.14, type: 'triangle' });
    this.noise({ duration: 1.0, gain: 0.16, freq: 300, sweep: -180, q: 0.5 });
  }
  kill() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, duration: 0.5, gain: 0.16, type: 'triangle', delay: i * 0.09 }));
  }
  gold() {
    [1047, 1319, 1568].forEach((f, i) => this.tone({ freq: f, duration: 0.35, gain: 0.14, type: 'sine', delay: i * 0.06 }));
  }
  level() {
    [392, 523, 659, 880].forEach((f, i) => this.tone({ freq: f, duration: 0.7, gain: 0.15, type: 'triangle', delay: i * 0.11 }));
  }
  sink() {
    this.tone({ freq: 220, to: 40, duration: 2.2, gain: 0.3, type: 'sawtooth' });
    this.noise({ duration: 2.0, gain: 0.28, freq: 700, sweep: -650, q: 0.4 });
  }
  /** The little sounds of the dock. Kept quiet — this is the calm half. */
  fish(name) {
    switch (name) {
      case 'cast':
        this.noise({ duration: 0.34, gain: 0.14, freq: 2200, sweep: -1700, q: 0.6 });
        break;
      case 'plop':
        this.tone({ freq: 420, to: 150, duration: 0.14, gain: 0.16, type: 'sine' });
        this.noise({ duration: 0.16, gain: 0.09, freq: 1100, sweep: -600 });
        break;
      case 'nibble':
        this.tone({ freq: 780, to: 640, duration: 0.07, gain: 0.07, type: 'triangle' });
        break;
      case 'bite':
        this.tone({ freq: 300, to: 120, duration: 0.22, gain: 0.2, type: 'sine' });
        this.tone({ freq: 900, duration: 0.08, gain: 0.12, type: 'triangle', delay: 0.02 });
        break;
      case 'hook':
        this.tone({ freq: 220, to: 480, duration: 0.2, gain: 0.2, type: 'sawtooth' });
        break;
      case 'run':
        // The drag giving line: a reel whirring against a fish that wants out.
        this.noise({ duration: 0.7, gain: 0.16, freq: 900, q: 7, sweep: 500 });
        this.tone({ freq: 160, to: 240, duration: 0.5, gain: 0.08, type: 'square' });
        break;
      case 'land':
        this.noise({ duration: 0.3, gain: 0.16, freq: 1500, sweep: -900 });
        [660, 880].forEach((f, i) => this.tone({ freq: f, duration: 0.3, gain: 0.12, type: 'sine', delay: i * 0.08 }));
        break;
      case 'spook':
        this.tone({ freq: 380, to: 180, duration: 0.28, gain: 0.1, type: 'sine' });
        break;
    }
  }

  bell() {
    this.tone({ freq: 784, duration: 1.6, gain: 0.13, type: 'sine' });
    this.tone({ freq: 1176, duration: 1.1, gain: 0.06, type: 'sine' });
  }
}
