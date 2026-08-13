// Small synthesised sound kit. No audio files — every noise in the shop is a
// couple of oscillators and an envelope, which keeps the prototype to one
// folder and lets the sounds be tuned in code.

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Browsers only allow this after a gesture, so the title screen calls it.
  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 0.32;
      this.bus.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** One enveloped oscillator. */
  tone(freq, { at = 0, dur = 0.16, type = 'sine', gain = 0.5, to = null, curve = 'exp' } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      else osc.frequency.linearRampToValueAtTime(to, t0 + dur);
    }

    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.015, dur * 0.2));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(env).connect(this.bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered noise, for anything percussive. */
  noise({ dur = 0.12, gain = 0.25, freq = 1200, q = 1 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const frames = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.value = gain;

    src.connect(filter).connect(env).connect(this.bus);
    src.start(t0);
  }

  // ---------------------------------------------------------------- cues

  doorbell() {
    this.tone(1318, { dur: 0.5, type: 'sine', gain: 0.22 });
    this.tone(1760, { at: 0.09, dur: 0.55, type: 'sine', gain: 0.17 });
  }

  pop() {
    this.tone(420, { dur: 0.1, type: 'triangle', gain: 0.4, to: 780 });
    this.noise({ dur: 0.05, gain: 0.12, freq: 2400 });
  }

  ding() {
    this.tone(2093, { dur: 0.7, type: 'sine', gain: 0.3 });
    this.tone(3136, { dur: 0.5, type: 'sine', gain: 0.12 });
  }

  cash() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, { at: i * 0.06, dur: 0.26, type: 'triangle', gain: 0.3 }));
    this.noise({ dur: 0.18, gain: 0.1, freq: 3000 });
  }

  wrong() {
    this.tone(196, { dur: 0.22, type: 'sawtooth', gain: 0.2, to: 130 });
  }

  pet() {
    this.tone(660, { dur: 0.22, type: 'sine', gain: 0.28, to: 1180 });
    this.tone(880, { at: 0.1, dur: 0.24, type: 'sine', gain: 0.16, to: 1320 });
  }

  // Climbs a little with each streak milestone, so eight in a row sounds like
  // more of an achievement than three.
  fanfare(step) {
    const root = 392 * Math.pow(2, Math.min(4, Math.floor(step / 4)) / 12);
    [0, 4, 7, 12].forEach((semi, i) =>
      this.tone(root * Math.pow(2, semi / 12), { at: i * 0.075, dur: 0.4, type: 'triangle', gain: 0.26 }),
    );
  }

  // Something is happening to the shop: a little rising three-note flourish.
  event() {
    [523, 698, 880].forEach((f, i) =>
      this.tone(f, { at: i * 0.11, dur: 0.5, type: 'sine', gain: 0.24 }),
    );
    this.tone(1760, { at: 0.33, dur: 0.6, type: 'sine', gain: 0.1 });
  }

  storm() {
    this.tone(330, { dur: 0.4, type: 'square', gain: 0.16, to: 110 });
    this.noise({ dur: 0.3, gain: 0.14, freq: 500 });
  }
}
