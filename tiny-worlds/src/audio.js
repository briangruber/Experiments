// Everything you hear is synthesised at runtime — no audio files, no loading.
// A drifting pad per world, plus short envelopes for the moments that matter.

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export class Audio {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.chimeIndex = 0;
  }

  // Browsers only allow this after a gesture, so main calls it on first input.
  start() {
    if (this.ready) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(this.ctx.destination);

    this.padGain = this.ctx.createGain();
    this.padGain.gain.value = 0.0;
    this.padFilter = this.ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 0.8;
    this.padGain.connect(this.padFilter).connect(this.master);

    this.padOscs = [1, 1.5, 2, 3.007].map((mult, i) => {
      const o = this.ctx.createOscillator();
      o.type = i % 2 ? 'sine' : 'triangle';
      o.frequency.value = 110 * mult;
      const g = this.ctx.createGain();
      g.gain.value = [0.5, 0.22, 0.16, 0.07][i];
      o.connect(g).connect(this.padGain);
      o.start();
      return { osc: o, mult, gain: g };
    });

    // Slow filter drift so the pad never sits still.
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();

    this.noiseBuffer = this.makeNoise();
    this.ready = true;
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : 0.85, this.ctx.currentTime + 1.5);
    this.padGain.gain.linearRampToValueAtTime(0.16, this.ctx.currentTime + 3);
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 1.2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ready) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(m ? 0 : 0.85, this.ctx.currentTime + 0.25);
  }

  // Each world gets its own root note and colour.
  setWorld(index, { dark = false } = {}) {
    if (!this.ready) return;
    const roots = [110, 98, 130.81, 82.41, 146.83];
    const root = roots[index % roots.length];
    const t = this.ctx.currentTime;
    for (const p of this.padOscs) p.osc.frequency.linearRampToValueAtTime(root * p.mult, t + 2.5);
    this.padFilter.frequency.linearRampToValueAtTime(dark ? 380 : 760, t + 2.5);
    this.chimeIndex = 0;
  }

  env(node, { attack = 0.005, decay = 0.4, peak = 0.3 } = {}) {
    const t = this.ctx.currentTime;
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  tone(freq, { type = 'sine', decay = 0.5, peak = 0.25, detune = 0, delay = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012 + decay);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.1);
  }

  noise({ decay = 0.3, peak = 0.2, type = 'lowpass', freq = 900, sweepTo = null, delay = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + decay + 0.05);
  }

  // Collecting sparks walks up a pentatonic scale, so a full world is a phrase.
  collect(index, total) {
    const step = PENTA[Math.min(PENTA.length - 1, index)];
    const base = 523.25 * Math.pow(2, step / 12);
    this.tone(base, { type: 'triangle', decay: 0.55, peak: 0.22 });
    this.tone(base * 2, { type: 'sine', decay: 0.35, peak: 0.09, delay: 0.02 });
    if (index + 1 === total) this.tone(base * 1.5, { type: 'sine', decay: 1.2, peak: 0.14, delay: 0.12 });
  }

  jump() { this.noise({ decay: 0.18, peak: 0.06, type: 'bandpass', freq: 700, sweepTo: 1800 }); }

  land(strength = 0.5) {
    this.noise({ decay: 0.16, peak: 0.05 + strength * 0.13, type: 'lowpass', freq: 420 });
    this.tone(70 + strength * 40, { type: 'sine', decay: 0.16, peak: 0.06 + strength * 0.1 });
  }

  step() { this.noise({ decay: 0.06, peak: 0.02, type: 'bandpass', freq: 1400 }); }

  bloom() {
    if (!this.ready || this.muted) return;
    [261.63, 329.63, 392, 523.25, 659.25].forEach((f, i) => {
      this.tone(f, { type: 'sine', decay: 2.6 - i * 0.2, peak: 0.13, delay: i * 0.16 });
    });
    this.noise({ decay: 2.2, peak: 0.05, type: 'lowpass', freq: 300, sweepTo: 2600 });
  }

  launch() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 1.6);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(4200, t + 1.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 2.4);
    this.noise({ decay: 2.0, peak: 0.08, type: 'bandpass', freq: 500, sweepTo: 3000 });
  }

  arrive() {
    this.noise({ decay: 0.5, peak: 0.14, type: 'lowpass', freq: 900, sweepTo: 200 });
    this.tone(130.81, { type: 'sine', decay: 1.0, peak: 0.12 });
  }

  hurt() {
    this.noise({ decay: 0.35, peak: 0.16, type: 'lowpass', freq: 1400, sweepTo: 180 });
    this.tone(180, { type: 'square', decay: 0.22, peak: 0.09 });
    this.tone(120, { type: 'sawtooth', decay: 0.3, peak: 0.07, delay: 0.04 });
  }

  impact() {
    this.noise({ decay: 0.7, peak: 0.22, type: 'lowpass', freq: 900, sweepTo: 90 });
    this.tone(54, { type: 'sine', decay: 0.6, peak: 0.2 });
    this.tone(96, { type: 'triangle', decay: 0.3, peak: 0.08, delay: 0.02 });
  }

  stomp() {
    this.noise({ decay: 0.22, peak: 0.12, type: 'bandpass', freq: 900, sweepTo: 2600 });
    this.tone(320, { type: 'triangle', decay: 0.25, peak: 0.12 });
    this.tone(640, { type: 'sine', decay: 0.18, peak: 0.06, delay: 0.05 });
  }

  finale() {
    if (!this.ready || this.muted) return;
    [261.63, 311.13, 392, 466.16, 523.25, 622.25, 783.99].forEach((f, i) => {
      this.tone(f, { type: 'triangle', decay: 3.4 - i * 0.25, peak: 0.11, delay: i * 0.28 });
      this.tone(f * 2, { type: 'sine', decay: 2.0, peak: 0.05, delay: i * 0.28 + 0.05 });
    });
  }
}
