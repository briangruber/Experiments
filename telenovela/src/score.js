// The orchestra. Everything is synthesised at runtime: nylon guitar, tremolo
// strings, the organ sting, thunder, rain, and one heartbeat. A telenovela
// without music is just poultry.

const A4 = 440;
const mtof = (m) => A4 * Math.pow(2, (m - 69) / 12);

// Andalusian cadence, i–VII–VI–V, the sound of every balcony ever filmed.
const PROGRESSIONS = {
  theme: [[57, 60, 64], [55, 59, 62], [53, 57, 60], [52, 56, 59]],
  romance: [[53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67], [57, 60, 64, 67]],
  suspense: [[40, 47, 52], [40, 47, 53], [41, 48, 53], [40, 47, 52]],
  tragedy: [[45, 52, 57], [43, 50, 55], [41, 48, 53], [40, 47, 56]],
  storm: [[38, 45, 50], [38, 45, 51], [39, 46, 51], [38, 45, 50]],
  triumph: [[53, 57, 60], [55, 59, 62], [57, 60, 64], [57, 60, 64]],
};

const MOODS = {
  silence: { bpm: 80, prog: 'theme', pad: 0, guitar: 0, arp: [], tremolo: 0 },
  theme: { bpm: 96, prog: 'theme', pad: 0.5, guitar: 0.55, arp: [0, 1, 2, 1, 0, 2, 1, 2], tremolo: 0.15 },
  romance: { bpm: 68, prog: 'romance', pad: 0.62, guitar: 0.34, arp: [0, 2, 3, 2], tremolo: 0.1, harp: true },
  suspense: { bpm: 112, prog: 'suspense', pad: 0.5, guitar: 0.1, arp: [0], tremolo: 0.85 },
  tragedy: { bpm: 58, prog: 'tragedy', pad: 0.66, guitar: 0.28, arp: [0, 1, 2, 1], tremolo: 0.3, solo: true },
  storm: { bpm: 120, prog: 'storm', pad: 0.7, guitar: 0, arp: [], tremolo: 1.0 },
  triumph: { bpm: 84, prog: 'triumph', pad: 0.6, guitar: 0.45, arp: [0, 1, 2, 1], tremolo: 0.2 },
};

export class Score {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.mood = 'silence';
    this.moodGain = 0;
    this.beat = 0;
    this.nextNoteTime = 0;
    this.bar = 0;
    this.volume = 0.85;
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 3.6;
    comp.attack.value = 0.006; comp.release.value = 0.28;
    this.master.connect(comp).connect(ctx.destination);

    // A generated hall. Long enough to feel like a courtyard at night.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 2.4);
    this.wet = ctx.createGain(); this.wet.gain.value = 0.34;
    this.reverb.connect(this.wet).connect(this.master);

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0;
    this.musicBus.connect(this.master); this.musicBus.connect(this.reverb);
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master); this.sfxBus.connect(this.reverb);

    // Rain bed: pink-ish noise through a bandpass, level driven by the weather.
    this.noiseBuf = this.noise(4);
    const rain = ctx.createBufferSource();
    rain.buffer = this.noiseBuf; rain.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'bandpass'; rf.frequency.value = 2200; rf.Q.value = 0.5;
    const rf2 = ctx.createBiquadFilter(); rf2.type = 'highpass'; rf2.frequency.value = 500;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    rain.connect(rf).connect(rf2).connect(this.rainGain).connect(this.master);
    this.rainGain.connect(this.reverb);
    rain.start();

    this.nextNoteTime = ctx.currentTime + 0.1;
    this.ready = true;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  impulse(dur, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 200 ? i / 200 : 1);
      }
    }
    return buf;
  }

  noise(dur) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    return buf;
  }

  setMood(mood, fade = 2) {
    if (!MOODS[mood]) return this;
    this.mood = mood;
    if (!this.ready) return this;
    const g = this.musicBus.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(mood === 'silence' ? 0 : 0.5, t + fade);
    return this;
  }

  setRain(level) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.rainGain.gain.cancelScheduledValues(t);
    this.rainGain.gain.setTargetAtTime(level * 0.16, t, 0.8);
  }

  setVolume(v) {
    this.volume = v;
    if (this.ready) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  // --- voices ---------------------------------------------------------------

  env(node, t, a, d, s, r, peak = 1, sustain = 0.6) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak * sustain), t + a + d);
    g.setValueAtTime(Math.max(0.0002, peak * sustain), t + a + d + s);
    g.exponentialRampToValueAtTime(0.0001, t + a + d + s + r);
  }

  // Nylon guitar: a bright pluck that dies fast.
  pluck(midi, t, gain = 0.3, dur = 1.4) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const out = ctx.createGain();
    out.connect(this.musicBus);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 7, t);
    lp.frequency.exponentialRampToValueAtTime(f * 1.6, t + dur * 0.6);
    lp.Q.value = 0.8;
    lp.connect(out);
    for (const [ratio, amp, type] of [[1, 1, 'triangle'], [2.01, 0.34, 'sine'], [3.02, 0.14, 'sine']]) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * amp, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(lp);
      o.start(t); o.stop(t + dur + 0.05);
    }
    // Fingernail click.
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.playbackRate.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.25, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = f * 4;
    n.connect(nf).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.08);
  }

  // Bowed strings with tremolo. The tremolo is the suspense.
  strings(midi, t, dur, gain = 0.12, tremolo = 0.2) {
    const ctx = this.ctx, f = mtof(midi);
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.musicBus);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = f * 6; lp.Q.value = 0.5;
    lp.connect(out);
    for (const det of [-6, 0, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f * Math.pow(2, det / 1200);
      const g = ctx.createGain(); g.gain.value = 0.33;
      o.connect(g).connect(lp);
      o.start(t); o.stop(t + dur + 0.4);
      // Vibrato.
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2 + Math.random();
      const la = ctx.createGain(); la.gain.value = f * 0.004;
      lfo.connect(la).connect(o.frequency);
      lfo.start(t); lfo.stop(t + dur + 0.4);
    }
    this.env(out, t, 0.35, 0.2, dur * 0.5, dur * 0.5, gain, 0.75);
    if (tremolo > 0.02) {
      const trem = ctx.createOscillator();
      trem.frequency.value = 9 + tremolo * 8;
      const ta = ctx.createGain(); ta.gain.value = gain * tremolo * 0.8;
      trem.connect(ta).connect(out.gain);
      trem.start(t); trem.stop(t + dur + 0.4);
    }
  }

  pad(chord, t, dur, gain = 0.06) {
    for (const m of chord) this.strings(m, t, dur, gain, MOODS[this.mood].tremolo);
  }

  // The sting. Three brass-organ hits, the last one held and shaking.
  sting(kind = 'shock') {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.01;
    const notes = kind === 'reveal' ? [[45, 0, 0.34], [45, 0.26, 0.34], [40, 0.52, 1.9]]
      : kind === 'small' ? [[52, 0, 0.5]]
        : kind === 'rise' ? [[45, 0, 0.2], [48, 0.16, 0.2], [52, 0.32, 0.2], [57, 0.48, 1.6]]
          : [[47, 0, 0.3], [47, 0.24, 0.3], [41, 0.48, 2.2]];
    for (const [m, off, dur] of notes) {
      const f = mtof(m);
      const out = ctx.createGain();
      out.connect(this.sfxBus);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(f * 14, t + off);
      lp.frequency.exponentialRampToValueAtTime(f * 3, t + off + dur);
      lp.connect(out);
      for (const [ratio, amp, type] of [[0.5, 0.5, 'sine'], [1, 1, 'sawtooth'], [2, 0.4, 'square'], [3, 0.22, 'sawtooth']]) {
        const o = ctx.createOscillator();
        o.type = type; o.frequency.value = f * ratio;
        const g = ctx.createGain(); g.gain.value = amp * 0.16;
        o.connect(g).connect(lp);
        o.start(t + off); o.stop(t + off + dur + 0.1);
        if (dur > 1) { // the held note wobbles
          const lfo = ctx.createOscillator(); lfo.frequency.value = 6.4;
          const la = ctx.createGain(); la.gain.value = f * ratio * 0.012;
          lfo.connect(la).connect(o.frequency);
          lfo.start(t + off + 0.2); lfo.stop(t + off + dur + 0.1);
        }
      }
      out.gain.setValueAtTime(0.0001, t + off);
      out.gain.exponentialRampToValueAtTime(0.9, t + off + 0.012);
      out.gain.exponentialRampToValueAtTime(0.0001, t + off + dur);
    }
  }

  thunder(power = 1, delay = 0) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.35;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 * power, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 2.4);
    lp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55 * power, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.18 * power, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t); src.stop(t + 3.4);
    // Sub rumble under it.
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(48, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 2.6);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.32 * power, t + 0.1);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 3);
  }

  slap() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.playbackRate.value = 1.8;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.12);
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t); src.stop(t + 0.25);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.14);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(og).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.24);
  }

  heartbeat(power = 1) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [off, amp] of [[0, 1], [0.26, 0.72]]) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(74, t + off);
      o.frequency.exponentialRampToValueAtTime(38, t + off + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.45 * amp * power, t + off + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.3);
      o.connect(g).connect(this.master);
      o.start(t + off); o.stop(t + off + 0.34);
    }
  }

  // A rooster crow, synthesised. Two glides and a rasp.
  crow() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.16;
    out.connect(this.sfxBus);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = o.frequency;
    f.setValueAtTime(520, t);
    f.exponentialRampToValueAtTime(880, t + 0.12);
    f.exponentialRampToValueAtTime(700, t + 0.36);
    f.exponentialRampToValueAtTime(1020, t + 0.5);
    f.exponentialRampToValueAtTime(380, t + 1.0);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.05);
    g.gain.setValueAtTime(0.8, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(bp).connect(g).connect(out);
    o.start(t); o.stop(t + 1.2);
  }

  harpRun(up = true) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    const scale = [57, 60, 62, 64, 67, 69, 72, 76, 79];
    for (let i = 0; i < scale.length; i++) {
      const m = up ? scale[i] : scale[scale.length - 1 - i];
      this.pluck(m + 12, t + i * 0.055, 0.1, 1.6);
    }
  }

  // --- sequencer ------------------------------------------------------------

  schedule() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const m = MOODS[this.mood];
    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      const spb = 60 / m.bpm;
      const t = this.nextNoteTime;
      const chord = PROGRESSIONS[m.prog][this.bar % 4];
      if (this.beat === 0 && m.pad > 0) {
        this.pad(chord, t, spb * 4 * 0.98, 0.055 * m.pad);
        if (m.solo && this.bar % 2 === 0) {
          // A lone violin line over the tragedy.
          this.strings(chord[0] + 24, t + spb, spb * 2, 0.05, 0.12);
        }
      }
      if (m.guitar > 0 && m.arp.length) {
        const idx = m.arp[this.beat % m.arp.length];
        const note = chord[idx % chord.length] + (idx >= chord.length ? 12 : 0);
        this.pluck(note + 12, t, 0.2 * m.guitar, spb * 2.2);
        if (this.beat % 4 === 0) this.pluck(chord[0] - 12, t, 0.24 * m.guitar, spb * 3);
      }
      if (this.mood === 'storm' && this.beat % 2 === 0) {
        // Timpani.
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(70, t);
        o.frequency.exponentialRampToValueAtTime(44, t + 0.3);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g).connect(this.musicBus);
        o.start(t); o.stop(t + 0.55);
      }
      this.nextNoteTime += spb;
      this.beat = (this.beat + 1) % 4;
      if (this.beat === 0) this.bar++;
    }
  }

  // Cues the sampled soundtrack covers with recordings. The synth has no
  // convincing version of a chick peeping, so it stays quiet rather than
  // playing something that isn't the sound.
  squawk() {}
  cluck() {}
  flap() {}
  eggCrack() {}
  peep() {}
  say() {}
  setAmbience() {}

  captureStream() {
    if (!this.ctx) return null;
    if (!this._capture) {
      this._capture = this.ctx.createMediaStreamDestination();
      this.master.connect(this._capture);
    }
    return this._capture.stream;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setEnabled(v) {
    this.enabled = v;
    if (this.ready) this.master.gain.setTargetAtTime(v ? this.volume : 0, this.ctx.currentTime, 0.08);
  }
}
