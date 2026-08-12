// Every sound in DEADLIGHT is synthesised at runtime.
//
// No audio files ship with the game. That is partly a size decision and partly
// a design one: a stinger built from oscillators can be *aimed*. Its pitch,
// length and brightness are arguments, so the scare director can hand the
// creature a different scream when it is eight metres away than when it is
// against the player's face, and the two are recognisably the same throat.
//
// Layout:
//   master → compressor → destination
//   sends:  reverb (convolver, generated impulse) and a dry path
//
// The compressor matters more than usual here. A jump scare is a 30 dB jump
// on someone wearing headphones at a level they chose during a quiet corridor,
// and limiting is the difference between frightening and harmful.

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.tension = 0;
    this.muted = false;
    this._bpm = 68;
    this._nextBeat = 0;
    this._nextAmbient = 0;
  }

  /** Must be called from a user gesture — browsers will not start audio
   *  without one. Safe to call repeatedly. */
  async unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const { ctx } = this;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.22;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.limiter);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.#impulse(2.9, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.34;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);

    this.#startDrone();
    this.ready = true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.9;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Route a node to both the dry master and the reverb send. */
  #wet(node, send = 1) {
    node.connect(this.master);
    if (send > 0) {
      const g = this.ctx.createGain();
      g.gain.value = send;
      node.connect(g);
      g.connect(this.reverbSend);
    }
  }

  /**
   * A decaying-noise impulse response. A real room measurement would be
   * better, but this is a concrete basement — the thing that sells it is a
   * long, dark, slightly early-reflected tail, and noise shaped by an
   * exponential does that in four lines.
   */
  #impulse(seconds, decay) {
    const { ctx } = this;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Sparse early reflections over a smooth tail.
        const early = i % 2011 < 3 ? 2.2 : 1;
        data[i] = (Math.random() * 2 - 1) * (1 - t) ** decay * early;
      }
    }
    return buf;
  }

  /** White noise, one second, reused by every noise-based voice. */
  #noiseBuffer() {
    if (this._noise) return this._noise;
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }

  #noiseSource(loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.#noiseBuffer();
    src.loop = loop;
    return src;
  }

  // ------------------------------------------------------------- ambience

  /**
   * The bed: two detuned sub oscillators plus filtered noise, all of it
   * modulated by `tension`. It never stops, which is what makes the moments
   * it swells register as a warning rather than as a cue.
   */
  #startDrone() {
    const { ctx } = this;

    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    this.#wet(this.droneGain, 0.5);

    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 220;
    this.droneFilter.Q.value = 3;
    this.droneFilter.connect(this.droneGain);

    for (const [freq, detune] of [[41.2, -7], [61.7, 5], [82.4, 11]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = 0.3;
      osc.connect(g).connect(this.droneFilter);
      osc.start();
    }

    // Air: the building's own hiss.
    const air = this.#noiseSource(true);
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 480;
    airFilter.Q.value = 0.6;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0.03;
    air.connect(airFilter).connect(this.airGain);
    this.#wet(this.airGain, 0.6);
    air.start();

    // Slow wobble on the filter so the drone is never quite static.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain).connect(this.droneFilter.frequency);
    lfo.start();

    this.droneGain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 4);
  }

  /**
   * `t` in 0..1 — how close the game thinks the player is to being caught.
   * Drives the drone, the heartbeat and how often the building makes noise.
   */
  setTension(t) {
    this.tension = clamp01(t);
    if (!this.ready) return;
    const now = this.now;
    const g = 0.1 + this.tension * 0.3;
    this.droneGain.gain.setTargetAtTime(g, now, 0.6);
    this.droneFilter.frequency.setTargetAtTime(180 + this.tension * 620, now, 0.8);
    this.airGain.gain.setTargetAtTime(0.025 + this.tension * 0.05, now, 1.2);
  }

  setHeartRate(bpm) {
    this._bpm = bpm;
  }

  /**
   * Called every frame. Schedules the heartbeat and the occasional
   * building noise. Both are deliberately driven from here rather than from
   * setInterval so they stop dead when the game is paused.
   */
  update(dt, rng) {
    if (!this.ready || this.muted) return;
    const now = this.now;

    if (now >= this._nextBeat) {
      // Above resting rate the heart is audible; below it, it is not.
      const audible = clamp01((this._bpm - 78) / 70);
      if (audible > 0.02) this.#heartbeat(audible);
      this._nextBeat = now + 60 / Math.max(40, this._bpm);
    }

    if (now >= this._nextAmbient) {
      const gap = 5 + (rng?.float(0, 9) ?? Math.random() * 9) - this.tension * 3;
      this._nextAmbient = now + Math.max(1.6, gap);
      const roll = rng?.next() ?? Math.random();
      if (roll < 0.34) this.drip();
      else if (roll < 0.62) this.creak();
      else if (roll < 0.82) this.distantClang();
      else this.pipeGroan();
    }
  }

  #heartbeat(level) {
    const { ctx } = this;
    const t = this.now;
    // Two thumps: lub, then a quieter dub a fifth of a second later.
    for (const [offset, gain, freq] of [[0, 1, 58], [0.19, 0.62, 48]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(freq * 1.6, t + offset);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t + offset + 0.11);
      g.gain.setValueAtTime(0.0001, t + offset);
      g.gain.exponentialRampToValueAtTime(0.34 * level * gain, t + offset + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.2);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t + offset);
      osc.stop(t + offset + 0.26);
    }
  }

  // --------------------------------------------------------------- one-shots

  /** Filtered noise burst — the basis of steps, drips and impacts. */
  #burst({ freq, q = 1, type = 'bandpass', gain = 0.2, attack = 0.004, decay = 0.12, send = 0.5, delay = 0 }) {
    if (!this.ready || this.muted) return;
    const { ctx } = this;
    const t = this.now + delay;
    const src = this.#noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(filter).connect(g);
    this.#wet(g, send);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  /** Footstep. Wet concrete, so there is a slap as well as a scuff. */
  step({ running = false, crouching = false } = {}) {
    const level = crouching ? 0.05 : running ? 0.19 : 0.11;
    this.#burst({ freq: 150 + Math.random() * 90, q: 0.7, gain: level, decay: 0.09, send: 0.35 });
    this.#burst({ freq: 2100 + Math.random() * 900, q: 1.4, gain: level * 0.4, decay: 0.05, send: 0.5, delay: 0.012 });
  }

  drip() {
    if (!this.ready) return;
    const { ctx } = this;
    const t = this.now;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = ctx.createGain();
    const f = 900 + Math.random() * 1400;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.35, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g);
    this.#wet(g, 1.1);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  creak() {
    if (!this.ready) return;
    const { ctx } = this;
    const t = this.now;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700 + Math.random() * 500;
    filter.Q.value = 14;
    const g = ctx.createGain();
    const base = 90 + Math.random() * 60;
    osc.frequency.setValueAtTime(base, t);
    // Slow, uneven rise: the sound of weight shifting onto old timber.
    osc.frequency.linearRampToValueAtTime(base * 1.5, t + 0.5);
    osc.frequency.linearRampToValueAtTime(base * 1.32, t + 0.9);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    osc.connect(filter).connect(g);
    this.#wet(g, 0.9);
    osc.start(t);
    osc.stop(t + 1.1);
  }

  distantClang() {
    this.#burst({ freq: 380 + Math.random() * 300, q: 9, gain: 0.09, decay: 0.9, send: 1.4 });
    this.#burst({ freq: 1500, q: 12, gain: 0.04, decay: 0.6, send: 1.4, delay: 0.02 });
  }

  pipeGroan() {
    if (!this.ready) return;
    const { ctx } = this;
    const t = this.now;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.linearRampToValueAtTime(41, t + 2.2);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    osc.connect(g);
    this.#wet(g, 0.8);
    osc.start(t);
    osc.stop(t + 2.5);
  }

  /** Torch toggle. Small, dry and mechanical — no reverb, so it reads as
   *  being in the player's hands rather than in the room. */
  click(on = true) {
    this.#burst({ freq: on ? 2600 : 1900, q: 3, gain: 0.09, attack: 0.001, decay: 0.03, send: 0 });
  }

  /** Fuse collected. The one unambiguously good sound in the game. */
  chime() {
    if (!this.ready) return;
    const { ctx } = this;
    const t = this.now;
    [523.25, 784, 1046.5].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * 0.055;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
      osc.connect(g);
      this.#wet(g, 0.9);
      osc.start(at);
      osc.stop(at + 0.8);
    });
  }

  /** Electrical hit — used when power comes back and when it fails. */
  surge(up = true) {
    if (!this.ready) return;
    const { ctx } = this;
    const t = this.now;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(up ? 200 : 4000, t);
    filter.frequency.exponentialRampToValueAtTime(up ? 4000 : 120, t + 0.8);
    const g = ctx.createGain();
    osc.frequency.value = 60;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    osc.connect(filter).connect(g);
    this.#wet(g, 0.7);
    osc.start(t);
    osc.stop(t + 1.2);
    this.#burst({ freq: 3000, q: 0.7, gain: 0.1, decay: 0.35, send: 0.8 });
  }

  // ---------------------------------------------------------------- scares

  /**
   * The stinger.
   *
   * A cluster of detuned sawtooths swept upward through a resonant bandpass,
   * over a noise crash and a sub drop. `intensity` scales level and brightness
   * together — a distant one is not just a quiet one, it is duller.
   */
  stinger(intensity = 1) {
    if (!this.ready || this.muted) return;
    const { ctx } = this;
    const t = this.now;
    const level = clamp01(intensity);

    const bus = ctx.createGain();
    bus.gain.value = 0.5 * level;
    this.#wet(bus, 0.8);

    const shaper = ctx.createWaveShaper();
    shaper.curve = this.#distortionCurve(120 + level * 260);
    shaper.connect(bus);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(700 + level * 500, t);
    band.frequency.exponentialRampToValueAtTime(2600 + level * 2600, t + 0.16);
    band.Q.value = 3.5;
    band.connect(shaper);

    for (const detune of [-24, -7, 4, 13, 27]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(233, t);
      osc.frequency.exponentialRampToValueAtTime(880, t + 0.1);
      osc.frequency.exponentialRampToValueAtTime(760, t + 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      osc.connect(g).connect(band);
      osc.start(t);
      osc.stop(t + 0.7);
    }

    // Sub drop underneath — felt more than heard, and the reason a stinger
    // lands in the chest on headphones.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.4 * level, t + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    sub.connect(subGain);
    subGain.connect(this.master);
    sub.start(t);
    sub.stop(t + 1.2);

    this.#burst({ freq: 5200, q: 0.5, gain: 0.3 * level, attack: 0.002, decay: 0.4, send: 0.7 });
  }

  /**
   * The creature's voice. Lower and wetter than the stinger, with a formant
   * sweep so it reads as a throat rather than as an instrument.
   * `distance` in metres dulls and quietens it.
   */
  roar(distance = 2) {
    if (!this.ready || this.muted) return;
    const { ctx } = this;
    const t = this.now;
    const near = clamp01(1 - distance / 22);
    if (near <= 0.01) return;

    const bus = ctx.createGain();
    bus.gain.value = 0.42 * near;
    this.#wet(bus, 0.5 + (1 - near) * 1.1);

    const shaper = ctx.createWaveShaper();
    shaper.curve = this.#distortionCurve(60 + near * 140);
    shaper.connect(bus);

    // Two formants: the vowel of it.
    for (const [f, q, gain] of [[420, 7, 0.5], [1180, 9, 0.3]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(74, t);
      osc.frequency.exponentialRampToValueAtTime(52, t + 0.75);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.setValueAtTime(f, t);
      band.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.8);
      band.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
      osc.connect(band).connect(g).connect(shaper);
      osc.start(t);
      osc.stop(t + 1.0);
    }

    // Breath.
    this.#burst({ freq: 900 * near + 200, q: 0.8, gain: 0.16 * near, attack: 0.05, decay: 0.7, send: 1.0 });
  }

  /** Dry, close breathing — used when the creature is behind the player and
   *  has not been seen yet. Intentionally *not* sent to reverb, so it sounds
   *  like it is inside the player's personal space. */
  breath() {
    this.#burst({ freq: 620, q: 1.6, gain: 0.09, attack: 0.09, decay: 0.34, send: 0.05 });
    this.#burst({ freq: 300, q: 2.2, gain: 0.05, attack: 0.14, decay: 0.4, send: 0.05, delay: 0.42 });
  }

  /** A whisper: noise shaped into sibilance. */
  whisper() {
    this.#burst({ freq: 2400 + Math.random() * 1800, q: 2.4, gain: 0.055, attack: 0.06, decay: 0.42, send: 1.3 });
    this.#burst({ freq: 800, q: 3, gain: 0.03, attack: 0.1, decay: 0.5, send: 1.3, delay: 0.2 });
  }

  #distortionCurve(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    return curve;
  }
}
