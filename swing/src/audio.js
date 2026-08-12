// Everything you hear is synthesised at runtime — no audio files ship with the
// prototype. Wind is a filtered noise bed whose cutoff and gain ride on speed;
// the rest are one-shot envelopes.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.muted = false;
  }

  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    // Two seconds of noise, looped, is enough for both wind and impacts.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;      // brown-ish, gentler up top
      d[i] = last * 3.2;
    }
    this.noise = buf;

    const wind = ctx.createBufferSource();
    wind.buffer = buf;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();

    this.enabled = true;
  }

  setWind(speed, attached) {
    if (!this.enabled || this.muted) return;
    const t = clamp01((speed - 6) / 90);
    this.windGain.gain.setTargetAtTime(t * t * 0.42, this.ctx.currentTime, 0.12);
    this.windFilter.frequency.setTargetAtTime(320 + t * 1500, this.ctx.currentTime, 0.15);
    this.windFilter.Q.setTargetAtTime(attached ? 1.6 : 0.7, this.ctx.currentTime, 0.2);
  }

  burst({ freq = 900, sweep = 0.3, dur = 0.16, gain = 0.3, type = 'bandpass', q = 4 }) {
    if (!this.enabled || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  tone(freq, { dur = 0.25, gain = 0.16, type = 'triangle', to = null } = {}) {
    if (!this.enabled || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  thwip() { this.burst({ freq: 2600, sweep: 0.18, dur: 0.13, gain: 0.26, q: 6 }); }
  miss() { this.burst({ freq: 700, sweep: 0.5, dur: 0.09, gain: 0.1, q: 2 }); }
  boost() {
    this.burst({ freq: 300, sweep: 5, dur: 0.28, gain: 0.22, q: 1.2 });
    this.tone(180, { dur: 0.3, gain: 0.12, type: 'sawtooth', to: 460 });
  }
  land() { this.burst({ freq: 220, sweep: 0.3, dur: 0.22, gain: 0.3, type: 'lowpass', q: 1 }); }
  scrape() { this.burst({ freq: 1800, sweep: 0.6, dur: 0.1, gain: 0.12, q: 3 }); }
  smack() { this.burst({ freq: 140, sweep: 0.4, dur: 0.34, gain: 0.4, type: 'lowpass', q: 1 }); }
  ring(combo) {
    const base = 520 * Math.pow(1.1225, Math.min(combo, 9));    // climbs a semitone a step
    this.tone(base, { dur: 0.3, gain: 0.15 });
    this.tone(base * 1.5, { dur: 0.22, gain: 0.08, type: 'sine' });
  }
}
