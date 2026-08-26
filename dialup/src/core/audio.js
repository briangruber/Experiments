/* Every sound this machine makes is synthesised. There are no samples in
   this prototype — the modem handshake, the startup chime, the beeps, the
   MIDI-ish tunes on the web pages are all oscillators and shaped noise.
   That keeps the folder small and means the dial-up sequence can be as
   long or short as the dialer needs it to be. */

import { VOICE } from '../assets/voice.js';

let ctx = null;
let master = null;
let enabled = true;
const decoded = new Map();

export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  return ctx;
}

export const audioCtx = () => ctx;

/**
 * Stops everything already scheduled. Oscillators queued into the future
 * cannot be un-queued, so the only honest way to cut a handshake short is
 * to throw the bus away and build a new one.
 */
export function panic() {
  if (!ctx) return;
  try { master.disconnect(); } catch {}
  master = ctx.createGain();
  master.gain.value = enabled ? 0.5 : 0;
  master.connect(ctx.destination);
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
}
export const isEnabled = () => enabled;
export function setEnabled(on) {
  enabled = on;
  if (master) master.gain.setTargetAtTime(on ? 0.5 : 0, ctx.currentTime, 0.02);
}
const now = () => (ctx ? ctx.currentTime : 0);

/* ── primitives ──────────────────────────────────────────────────────── */

function env(node, t, attack, hold, release, peak = 1) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.setValueAtTime(Math.max(peak, 0.0002), t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  node.connect(g);
  return g;
}

/** A single shaped oscillator note. */
export function tone(freq, t, dur, {
  type = 'sine', gain = 0.2, attack = 0.005, release = 0.05, dest = null, detune = 0,
} = {}) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = freq; o.detune.value = detune;
  const g = env(o, t, attack, Math.max(dur - attack - release, 0.001), release, gain);
  g.connect(dest || master);
  o.start(t); o.stop(t + dur + release + 0.02);
  return o;
}

let noiseBuf = null;
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  return s;
}

/** Band-passed noise burst — the raw material of hiss, static and carrier. */
export function hiss(t, dur, { f = 1400, q = 1.2, gain = 0.08, dest = null, type = 'bandpass' } = {}) {
  if (!ctx) return null;
  const s = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = type; bp.frequency.value = f; bp.Q.value = q;
  s.connect(bp);
  const g = env(bp, t, 0.02, Math.max(dur - 0.06, 0.01), 0.04, gain);
  g.connect(dest || master);
  s.start(t); s.stop(t + dur + 0.1);
  return { src: s, filter: bp, gain: g };
}

/* ── system sounds ───────────────────────────────────────────────────── */

/** The single POST beep from the PC speaker: a square wave, no envelope to
    speak of, deliberately harsh. */
export function postBeep(when = 0) {
  if (!ctx) return; const t = now() + when;
  tone(1000, t, 0.16, { type: 'square', gain: 0.16, attack: 0.001, release: 0.005 });
}

export function beep(when = 0) {
  if (!ctx) return; const t = now() + when;
  tone(820, t, 0.09, { type: 'square', gain: 0.1, attack: 0.001, release: 0.01 });
}

/** Error: the two-tone "ding" of a modal you did not want. */
export function ding() {
  if (!ctx) return; const t = now();
  tone(880, t, 0.1, { type: 'triangle', gain: 0.18 });
  tone(660, t + 0.09, 0.22, { type: 'triangle', gain: 0.16 });
}

/** Startup chime — four voices swelling into a chord. */
export function startupChime() {
  if (!ctx) return; const t = now() + 0.05;
  const chord = [220, 329.63, 440, 659.25, 880];
  chord.forEach((f, i) => {
    tone(f, t + i * 0.085, 1.5 - i * 0.12,
      { type: 'triangle', gain: 0.075, attack: 0.28, release: 0.9 });
    tone(f * 2, t + i * 0.085, 0.9, { type: 'sine', gain: 0.02, attack: 0.3, release: 0.6 });
  });
  hiss(t, 0.5, { f: 3000, q: 0.6, gain: 0.012, type: 'highpass' });
}

export function shutdownChime() {
  if (!ctx) return; const t = now();
  [880, 659.25, 440, 329.63].forEach((f, i) =>
    tone(f, t + i * 0.13, 0.6, { type: 'triangle', gain: 0.07, attack: 0.02, release: 0.5 }));
}

/** Floppy / hard disk seek: filtered noise clicks. */
export function seek(count = 6, spread = 0.4) {
  if (!ctx) return; const t = now();
  for (let i = 0; i < count; i++) {
    hiss(t + Math.random() * spread, 0.02,
      { f: 2200 + Math.random() * 2600, q: 6, gain: 0.05 });
  }
}

/** The chunky physical relay of a power switch. */
export function powerClunk() {
  if (!ctx) return; const t = now();
  hiss(t, 0.05, { f: 180, q: 1.5, gain: 0.35, type: 'lowpass' });
  tone(58, t, 0.1, { type: 'sine', gain: 0.28, attack: 0.001, release: 0.06 });
  hiss(t + 0.02, 0.9, { f: 320, q: 0.4, gain: 0.02, type: 'lowpass' }); // fan spin-up
}

/** UI click for buttons that ought to feel mechanical. */
export function click() {
  if (!ctx) return;
  hiss(now(), 0.012, { f: 3200, q: 4, gain: 0.035 });
}

/* ── the modem ───────────────────────────────────────────────────────── */

const DTMF = {
  1: [697, 1209],  2: [697, 1336],  3: [697, 1477],
  4: [770, 1209],  5: [770, 1336],  6: [770, 1477],
  7: [852, 1209],  8: [852, 1336],  9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

/** Off-hook click, then the dial tone (350 + 440 Hz, held). */
export function offHook(t) {
  hiss(t, 0.02, { f: 2000, q: 5, gain: 0.06 });
  const stop = t + 0.9;
  tone(350, t + 0.06, stop - t - 0.06, { gain: 0.045, attack: 0.02, release: 0.02 });
  tone(440, t + 0.06, stop - t - 0.06, { gain: 0.045, attack: 0.02, release: 0.02 });
  return stop;
}

/** Touch-tone a number. Returns the time the last digit ends. */
export function dialDigits(digits, t, digitDur = 0.09, gap = 0.055) {
  let at = t;
  for (const d of String(digits)) {
    const pair = DTMF[d];
    if (!pair) { at += gap; continue; }
    tone(pair[0], at, digitDur, { gain: 0.075, attack: 0.004, release: 0.01 });
    tone(pair[1], at, digitDur, { gain: 0.075, attack: 0.004, release: 0.01 });
    at += digitDur + gap;
  }
  return at;
}

/** North American ring-back: 440 + 480 Hz, two seconds on. */
export function ringback(t, rings = 1) {
  let at = t;
  for (let i = 0; i < rings; i++) {
    tone(440, at, 1.8, { gain: 0.05, attack: 0.02, release: 0.05 });
    tone(480, at, 1.8, { gain: 0.05, attack: 0.02, release: 0.05 });
    at += 1.8 + 1.6;
  }
  return at;
}

/**
 * The handshake, in the order a real V.34 connection made it:
 *   answer tone → V.8 menu warble → the "bong… bong" of probing tones →
 *   the descending scramble → full-rate carrier hiss → silence.
 * Returns the time it ends so the dialer can line the UI up with the sound.
 */
export function handshake(t) {
  let at = t;

  // CNG / answer tone: the flat 2100 Hz whistle of the far end picking up.
  tone(2100, at, 1.4, { gain: 0.055, attack: 0.03, release: 0.08 });
  at += 1.55;

  // V.8 call menu — a fast FSK warble between two tones.
  const warbleEnd = at + 1.1;
  for (let x = at; x < warbleEnd; x += 0.028) {
    tone(Math.random() < 0.5 ? 1080 : 1750, x, 0.03,
      { type: 'sine', gain: 0.05, attack: 0.002, release: 0.004 });
  }
  at = warbleEnd + 0.12;

  // The probing tones. This is the "BONG ... BONG" everyone remembers.
  for (const f of [1800, 1200, 2400, 600]) {
    tone(f, at, 0.3, { type: 'sine', gain: 0.09, attack: 0.008, release: 0.12 });
    tone(f * 1.5, at, 0.3, { type: 'sine', gain: 0.035, attack: 0.008, release: 0.12 });
    at += 0.42;
  }
  at += 0.1;

  // Equaliser training: noise sweeping down through the voice band.
  const sweep = hiss(at, 1.5, { f: 2600, q: 0.9, gain: 0.055 });
  if (sweep) {
    sweep.filter.frequency.setValueAtTime(2800, at);
    sweep.filter.frequency.exponentialRampToValueAtTime(700, at + 1.4);
  }
  // A wobbling carrier riding on top of the sweep.
  for (let x = at; x < at + 1.5; x += 0.06) {
    tone(900 + Math.random() * 1500, x, 0.07,
      { type: 'sawtooth', gain: 0.018, attack: 0.005, release: 0.02 });
  }
  at += 1.6;

  // Full-rate data: wideband hash, the sound of the line finally being used.
  hiss(at, 2.0, { f: 1600, q: 0.35, gain: 0.075 });
  for (let x = at; x < at + 2.0; x += 0.021) {
    tone(500 + Math.random() * 2400, x, 0.024,
      { type: 'square', gain: 0.01, attack: 0.003, release: 0.008 });
  }
  at += 2.1;

  // CONNECT: the speaker cuts out mid-hiss, which is exactly how it went.
  hiss(at, 0.09, { f: 900, q: 0.5, gain: 0.03 });
  return at + 0.12;
}

/** Busy signal, for when the local access number is full. */
export function busySignal(t, cycles = 4) {
  let at = t;
  for (let i = 0; i < cycles; i++) {
    tone(480, at, 0.5, { gain: 0.06 }); tone(620, at, 0.5, { gain: 0.06 });
    at += 1.0;
  }
  return at;
}

/* ── voice-ish service sounds ────────────────────────────────────────── */

/**
 * The service announcer.
 *
 * These are real recordings baked into src/assets/voice.js at 11 kHz
 * 8-bit mono — what a .wav on this machine would have been — rather than
 * the browser's speech synthesiser, which reads them like a railway
 * station. Decoded once and played through the master gain, so the tray
 * mute governs them like everything else.
 */
export function announce(key) {
  if (!enabled || !ctx) return false;
  const uri = VOICE[key];
  if (!uri) return false;

  const play = buf => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g); g.connect(master);
    src.start();
  };

  const cached = decoded.get(key);
  if (cached) { play(cached); return true; }

  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  ctx.decodeAudioData(bytes.buffer,
    buf => { decoded.set(key, buf); play(buf); },
    () => {});
  return true;
}

/** Fallback jingle used when speech is unavailable (or as its bed). */
export function mailFanfare() {
  if (!ctx) return; const t = now();
  [523.25, 659.25, 783.99].forEach((f, i) =>
    tone(f, t + i * 0.1, 0.5, { type: 'triangle', gain: 0.09, attack: 0.01, release: 0.35 }));
}

/** The door-opening / door-closing swing of somebody entering a chat room. */
export function doorOpen() {
  if (!ctx) return; const t = now();
  const o = tone(300, t, 0.28, { type: 'sine', gain: 0.055, attack: 0.01, release: 0.12 });
  if (o) o.frequency.exponentialRampToValueAtTime(700, t + 0.26);
  hiss(t, 0.3, { f: 700, q: 0.8, gain: 0.012 });
}
export function doorClose() {
  if (!ctx) return; const t = now();
  const o = tone(700, t, 0.26, { type: 'sine', gain: 0.05, attack: 0.01, release: 0.12 });
  if (o) o.frequency.exponentialRampToValueAtTime(280, t + 0.24);
  hiss(t + 0.18, 0.08, { f: 240, q: 1.4, gain: 0.05, type: 'lowpass' });
}

/** Instant-message arrival. Two clean notes, unmistakeable across a house. */
export function imChime() {
  if (!ctx) return; const t = now();
  tone(1046.5, t, 0.13, { type: 'sine', gain: 0.12, attack: 0.004, release: 0.09 });
  tone(1318.5, t + 0.11, 0.3, { type: 'sine', gain: 0.11, attack: 0.004, release: 0.22 });
}

export function buddyIn() {
  if (!ctx) return; const t = now();
  const o = tone(520, t, 0.2, { type: 'square', gain: 0.035, attack: 0.005, release: 0.1 });
  if (o) o.frequency.setValueAtTime(780, t + 0.09);
}
export function buddyOut() {
  if (!ctx) return; const t = now();
  const o = tone(780, t, 0.2, { type: 'square', gain: 0.03, attack: 0.005, release: 0.1 });
  if (o) o.frequency.setValueAtTime(430, t + 0.09);
}

export function goodbyeChime() {
  if (!ctx) return; const t = now();
  [659.25, 523.25, 392].forEach((f, i) =>
    tone(f, t + i * 0.12, 0.45, { type: 'triangle', gain: 0.08, attack: 0.01, release: 0.3 }));
}

/* ── the tiny sequencer behind every "MIDI" on the fake web ──────────── */

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "C4", "F#3", "-" (rest) → Hz, or 0. */
export function noteHz(n) {
  if (!n || n === '-') return 0;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
  if (!m) return 0;
  let semi = NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * Math.pow(2, (semi - 9) / 12 + (Number(m[3]) - 4));
}

/**
 * Loops a little tracker pattern with a General-MIDI-ish square/triangle
 * voice. Returns a handle with .stop(). Deliberately cheap and tinny.
 */
export function playTune(tune, { bpm = 120, gain = 0.045, loop = true } = {}) {
  if (!ctx || !enabled) return { stop() {} };
  const beat = 60 / bpm;
  let stopped = false, timer = null;
  const voices = tune.voices || [{ notes: tune.notes || [], type: 'square' }];
  const len = Math.max(...voices.map(v => v.notes.length));

  const round = () => {
    if (stopped) return;
    const t0 = now() + 0.06;
    voices.forEach(v => {
      const step = (v.step || 1) * beat;
      v.notes.forEach((n, i) => {
        const f = noteHz(n);
        if (!f) return;
        tone(f, t0 + i * step, step * 0.82, {
          type: v.type || 'square',
          gain: (v.gain ?? 1) * gain,
          attack: 0.006, release: step * 0.3,
        });
      });
    });
    if (!loop) return;
    timer = setTimeout(round, len * beat * 1000);
  };
  round();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
