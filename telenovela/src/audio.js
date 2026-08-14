// The soundtrack player. Same public surface as the procedural Score in
// score.js, so the director's cues don't care which one is running — if the
// generated audio can't be loaded, main.js falls back to the synth.
//
// Music beds loop and crossfade; ambience (rain, fountain, night) rides a
// continuous gain; one-shots fire and forget. The announcer ducks the music
// under himself, because of course he does.

import { AUDIO } from './audio-manifest.js';
import { clamp01 } from './util.js';

const MOOD_BED = {
  silence: null,
  theme: 'mus-theme',
  romance: 'mus-romance',
  suspense: 'mus-suspense',
  storm: 'mus-storm',
  tragedy: 'mus-tragedy',
  triumph: 'mus-credits',
  credits: 'mus-credits',
};

// Music is the biggest thing to decode, so only the opening bed is eager.
const EAGER = (n) => !n.startsWith('mus-') || n === 'mus-theme';

export class Soundtrack {
  constructor(manifest = AUDIO) {
    this.manifest = manifest;
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.enabled = true;
    this.volume = 0.9;
    this.buffers = new Map();
    this.pending = new Map();
    this.mood = 'silence';
    this.bed = null;          // { name, src, gain }
    this.loops = new Map();   // ambience name -> { src, gain, level }
  }

  // --- loading --------------------------------------------------------------

  async load(name) {
    if (this.buffers.has(name)) return this.buffers.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const url = this.manifest[name];
    if (!url) return null;
    const p = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(name, buf);
      this.pending.delete(name);
      return buf;
    })();
    this.pending.set(name, p);
    return p;
  }

  async start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return this.ready; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.failed = true; return false; }
    const ctx = this.ctx = new AC();

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 3.2;
    comp.attack.value = 0.005; comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 1;
    this.musicBus.connect(this.master);
    this.duck = ctx.createGain(); this.duck.gain.value = 1;
    this.musicBus.connect(this.duck);
    // musicBus -> duck -> master; the direct connection above is removed so the
    // duck is the only path.
    this.musicBus.disconnect(this.master);
    this.duck.connect(this.master);

    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
    this.ambBus = ctx.createGain(); this.ambBus.gain.value = 1;
    this.ambBus.connect(this.master);
    this.voxBus = ctx.createGain(); this.voxBus.gain.value = 1.15;
    this.voxBus.connect(this.master);

    // A first decode proves the pipeline before anything is promised.
    try {
      await this.load('sfx-sting');
    } catch (e) {
      console.warn('soundtrack unavailable, falling back to the synth:', e.message);
      this.failed = true;
      return false;
    }
    this.ready = true;

    // Everything small up front; music beds arrive as they are asked for.
    for (const name of Object.keys(this.manifest)) {
      if (EAGER(name)) this.load(name).catch(() => {});
    }
    if (this.mood !== 'silence') this.setMood(this.mood, 1.5);
    return true;
  }

  // --- music ----------------------------------------------------------------

  setMood(mood, fade = 2) {
    this.mood = mood;
    if (!this.ready) return this;
    const want = MOOD_BED[mood] ?? null;
    if (this.bed && this.bed.name === want) return this;
    const t = this.ctx.currentTime;

    if (this.bed) {
      const old = this.bed;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0.0001, t + fade);
      try { old.src.stop(t + fade + 0.05); } catch { /* already stopped */ }
      this.bed = null;
    }
    if (!want) return this;

    const startBed = (buf) => {
      // The mood may have moved on while the bed was decoding.
      if (MOOD_BED[this.mood] !== want || !this.ctx) return;
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.7, now + Math.max(0.05, fade));
      src.connect(gain).connect(this.musicBus);
      src.start(now);
      this.bed = { name: want, src, gain };
    };

    const cached = this.buffers.get(want);
    if (cached) startBed(cached);
    else this.load(want).then(startBed).catch(() => {});
    return this;
  }

  // --- looped ambience ------------------------------------------------------

  ambience(name, level, ramp = 1.2) {
    if (!this.ready) return;
    let l = this.loops.get(name);
    const t = this.ctx.currentTime;
    if (!l) {
      const buf = this.buffers.get(name);
      if (!buf) { this.load(name).then(() => this.ambience(name, level, ramp)).catch(() => {}); return; }
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.0001;
      src.connect(gain).connect(this.ambBus);
      src.start(t);
      l = { src, gain };
      this.loops.set(name, l);
    }
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setTargetAtTime(Math.max(0.0001, level), t, ramp / 3);
  }

  setRain(level) { this.ambience('sfx-rain', clamp01(level) * 0.55); }
  setAmbience(level) {
    this.ambience('sfx-night', clamp01(level) * 0.2);
    this.ambience('sfx-fountain', clamp01(level) * 0.16);
  }

  // --- one-shots ------------------------------------------------------------

  play(name, { gain = 1, delay = 0, rate = 1, bus = 'sfx' } = {}) {
    if (!this.ready || !this.enabled) return null;
    const buf = this.buffers.get(name);
    if (!buf) { this.load(name).catch(() => {}); return null; }
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(bus === 'vox' ? this.voxBus : this.sfxBus);
    src.start(t);
    return { src, gain: g, duration: buf.duration / rate };
  }

  sting(kind = 'shock') {
    const map = { shock: 'sfx-sting', reveal: 'sfx-sting-reveal', rise: 'sfx-sting-reveal', small: 'sfx-sting' };
    this.play(map[kind] || 'sfx-sting', { gain: kind === 'small' ? 0.42 : 0.85, rate: kind === 'small' ? 1.35 : 1 });
  }
  thunder(power = 1, delay = 0) { this.play('sfx-thunder', { gain: 0.5 + power * 0.45, delay, rate: 0.92 + power * 0.1 }); }
  slap() { this.play('sfx-slap', { gain: 1 }); }
  heartbeat(power = 1) { this.play('sfx-heartbeat', { gain: 0.6 * power }); }
  crow() { this.play('sfx-crow', { gain: 0.75 }); }
  squawk() { this.play('sfx-squawk', { gain: 0.5, rate: 0.95 + Math.random() * 0.2 }); }
  cluck() { this.play('sfx-cluck', { gain: 0.3, rate: 0.9 + Math.random() * 0.3 }); }
  flap() { this.play('sfx-flap', { gain: 0.45 }); }
  eggCrack() { this.play('sfx-egg-crack', { gain: 0.7 }); }
  peep() { this.play('sfx-peep', { gain: 0.75 }); }
  // The synth had a harp flourish; the sampled score covers that ground with
  // its romance bed, so this is deliberately a no-op rather than a wrong sound.
  harpRun() {}

  // --- the announcer --------------------------------------------------------

  say(name, delay = 0) {
    const shot = this.play(name, { gain: 1, delay, bus: 'vox' });
    if (!shot) { this.load(name).catch(() => {}); return; }
    // Duck the music under him. He is the most important thing in the room and
    // he knows it.
    const t = this.ctx.currentTime + delay;
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.4, t + 0.25);
    g.setValueAtTime(0.4, t + shot.duration);
    g.linearRampToValueAtTime(1, t + shot.duration + 0.7);
  }

  // --- transport ------------------------------------------------------------

  setVolume(v) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.enabled ? v : 0, this.ctx.currentTime, 0.05);
  }
  setEnabled(v) {
    this.enabled = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v ? this.volume : 0, this.ctx.currentTime, 0.08);
  }
  // A tap on the master bus for the video export.
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
}
