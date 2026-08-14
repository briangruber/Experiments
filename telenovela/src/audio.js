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

const BED_GAIN = 0.7;

// Music is the biggest thing to decode, so only the opening bed is eager.
const EAGER = (n) => !n.startsWith('mus-') || n === 'mus-theme';

export class Soundtrack {
  constructor(manifest = AUDIO) {
    this.manifest = manifest;
    this.ctx = null;
    // Offline rendering steps the world faster than real time, so scheduling
    // cannot read ctx.currentTime — it would bunch every cue at zero. When
    // this is set, it is the clock.
    this.virtualNow = null;
    this.ready = false;
    this.failed = false;
    this.enabled = true;
    // Thunder and the stings are transients on top of a loud bed; at 0.9 the
    // sum clipped on impacts, in the export and on the speakers alike.
    this.volume = 0.76;
    this.buffers = new Map();
    this.pending = new Map();
    this.mood = 'silence';
    // One-shots are suppressed while seeking: running the clock forward through
    // a scene fires every cue it passes, and they would all land on the same
    // instant as one pile of thunder.
    this.scheduling = true;
    this.bed = null;          // { name, src, gain } — the one that is sounding
    this.beds = new Set();    // everything still audible, including fade-outs
    this.bedWanted = undefined;
    this.bedGen = 0;
    this.loops = new Map();   // ambience name -> { src, gain, level }
  }

  now() { return this.virtualNow !== null ? this.virtualNow : this.ctx.currentTime; }

  // Render the soundtrack for a deterministic export: an offline context, the
  // same cues, scheduled against a clock the caller advances.
  async openOffline(AudioCtor, seconds, sampleRate = 48000) {
    this.ctx = new AudioCtor(2, Math.ceil(seconds * sampleRate), sampleRate);
    this.virtualNow = 0;
    this.buildGraph();
    await Promise.all(Object.keys(this.manifest).map((n) => this.load(n).catch(() => {})));
    this.ready = true;
    return this.ctx;
  }

  // --- loading --------------------------------------------------------------

  // The single-file build carries its audio as data: URIs, and fetch() on those
  // is a connect-src request — which a strict CSP (the published page, for one)
  // refuses. Decode them in-process instead and keep fetch for real URLs.
  static bytesFromDataUri(url) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('malformed data URI');
    const meta = url.slice(0, comma);
    const body = url.slice(comma + 1);
    if (!/;base64/i.test(meta)) {
      const s = decodeURIComponent(body);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out.buffer;
    }
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  async load(name) {
    if (this.buffers.has(name)) return this.buffers.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const url = this.manifest[name];
    if (!url) return null;
    const p = (async () => {
      let bytes;
      if (url.startsWith('data:')) {
        bytes = Soundtrack.bytesFromDataUri(url);
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${name}: ${res.status}`);
        bytes = await res.arrayBuffer();
      }
      const buf = await this.ctx.decodeAudioData(bytes);
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
    this.ctx = new AC();
    this.buildGraph();

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
    // Anything the director asked for while we were still decoding.
    for (const [name, args] of this._pendingAmbience || []) this.ambience(name, ...args);
    this._pendingAmbience = null;
    return true;
  }

  buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 20; comp.ratio.value = 4.5;
    // Fast enough to catch a thunder crack rather than let its first few
    // milliseconds through at full scale.
    comp.attack.value = 0.002; comp.release.value = 0.22;
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
  }

  // --- music ----------------------------------------------------------------

  startBed(name, buf, fade) {
    const now = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(BED_GAIN, now + Math.max(0.05, fade));
    src.connect(gain).connect(this.musicBus);
    const entry = { name, src, gain };
    src.onended = () => this.beds.delete(entry);
    src.start(now);
    this.beds.add(entry);
    return entry;
  }

  stopBed(entry, fade) {
    const t = this.now();
    entry.gain.gain.cancelScheduledValues(t);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, t);
    entry.gain.gain.linearRampToValueAtTime(0.0001, t + fade);
    try { entry.src.stop(t + fade + 0.05); } catch { /* already stopped */ }
    if (this.bed === entry) this.bed = null;
  }

  setMood(mood, fade = 2) {
    this.mood = mood;
    if (!this.ready) return this;
    const want = MOOD_BED[mood] ?? null;
    // Compare against what was last *asked for*, not what is currently
    // sounding: a bed can be several hundred milliseconds of decoding away from
    // existing, and during that window the old check saw no bed at all and
    // happily started a second copy of the same music. The duplicate was never
    // tracked, so nothing ever stopped it, and the opening theme played on
    // underneath the entire episode.
    if (this.bedWanted === want) return this;
    this.bedWanted = want;
    const gen = ++this.bedGen;

    // Out faster than in. Two different pieces of music crossfading over three
    // seconds is mud; the old cue should be gone by the time the new one lands.
    const out = Math.min(fade, 1.2);
    for (const b of Array.from(this.beds)) this.stopBed(b, out);
    if (!want) return this;

    const begin = (buf) => {
      if (gen !== this.bedGen || !this.ctx) return;   // superseded while decoding
      this.bed = this.startBed(want, buf, fade);
    };
    const cached = this.buffers.get(want);
    if (cached) begin(cached);
    else {
      this.load(want).then(begin).catch(() => {
        // Let a later cue for the same mood try again.
        if (gen === this.bedGen) this.bedWanted = undefined;
      });
    }
    return this;
  }

  // --- looped ambience ------------------------------------------------------

  ambience(name, level, ramp = 1.2) {
    if (!this.ready) { (this._pendingAmbience ||= new Map()).set(name, [level, ramp]); return; }
    let l = this.loops.get(name);
    const t = this.now();
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
    if (!this.ready || !this.enabled || !this.scheduling) return null;
    const buf = this.buffers.get(name);
    if (!buf) { this.load(name).catch(() => {}); return null; }
    const t = this.now() + delay;
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
    const t = this.now() + delay;
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
