// The lagoon, for the ears. Everything here is synthesized — noise buffers
// filled in JS, oscillators, biquads — because the project ships no assets and
// fetches none, and because a lagoon is mostly broadband hush anyway: filtered
// noise IS the sound of water, not an approximation of it.
//
// The register is COZY. Every level in this file was arrived at by turning it
// down: the first motor was a chainsaw at 0.2, the first gulls a mugging. A
// soundscape you stop noticing after a minute is the goal — it is allowed to
// disappear, it is not allowed to startle.
//
// Three rules, learned from the renderer's version of the same problems:
//
//   1. The graph is built ONCE, at unlock, and never rebuilt. Layers that are
//      silent right now sit at gain 0 with their sources running — starting a
//      source mid-play is the audio equivalent of compiling a pipeline mid-
//      frame. Only the one-shots (gulls, bell) create nodes on demand, and
//      those are a few oscillators every ten seconds.
//   2. Every continuous parameter is moved with setTargetAtTime, which is the
//      one AudioParam verb that composes with being called again next frame.
//      Per-frame linear ramps stack cancel events and click; direct .value
//      writes zipper.
//   3. Nothing here may ever throw. Audio is garnish: a browser with no
//      AudioContext, a sandboxed localStorage, a device that suspends the
//      context behind our back — all of it degrades to silence, never to a
//      broken game.
//
// The context itself is created lazily on the first user gesture, because
// autoplay policy means one created at boot arrives suspended and stays that
// way; the same gesture that starts it also fades the master in, so the world
// swells up rather than switching on.

import { makeRng } from './rng.js';

// A phone speaker is a different instrument. The 0.45 desktop mix that reads
// as "cozy" through laptop speakers is borderline inaudible from a phone held
// at arm's length outdoors — the speaker is tiny, the lapping layer is
// broadband hush that it reproduces worst, and there is no volume slider to
// reach for. So the master runs hotter on coarse pointers.
const TOUCHY = typeof matchMedia === 'function'
  && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);
const MASTER = TOUCHY ? 0.8 : 0.5; // full mix, reached over ~1.5 s at unlock

// The smallest valid WAV there is — 44 bytes of header and one silent sample.
// Playing it through an HTML <audio> element is not decoration: on iOS,
// Web Audio routes through the RINGER channel, so a phone with the mute
// switch on plays nothing however correctly the context was unlocked. An
// HTMLMediaElement that is actually playing flips the audio session to the
// playback category, which ignores the ringer switch — it is the difference
// between "works on my phone" and works on phones.
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
const LP_DAY = 18000;              // master lowpass wide open
const LP_NIGHT = 8000;             // night darkens the whole mix a shade
const LP_UNDER = 320;              // ears full of water
const BELL_RANGE = 70;             // metres from a spot before the harbour rings
const STORAGE_KEY = 'saltyfin-audio';
const GLYPH_ON = '\u{1F50A}';
const GLYPH_OFF = '\u{1F507}';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Same placement grammar as the fps badge below it: a fixed round chip in the
// bottom-left utility corner, data-sf-ui so a tap on it never reaches the
// chase camera.
const CSS = `
#sf-audio { position: fixed; left: 10px; bottom: calc(34px + env(safe-area-inset-bottom));
  z-index: 45; width: 34px; height: 34px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center; padding: 0;
  font: 600 15px/1 ui-sans-serif, system-ui, sans-serif;
  color: rgba(214,236,255,.85); background: rgba(8,20,36,.45);
  border: 1px solid rgba(206,232,255,.2); cursor: pointer;
  -webkit-user-select: none; user-select: none; }
#sf-audio:active { background: rgba(30,52,72,.7); }
`;

export function createAudio(opts = {}) {
  const water = opts.water || (() => null);
  const camera = opts.camera || null;
  const spots = Array.isArray(opts.spots) ? opts.spots : [];
  const rng = makeRng(0x0C0A57);

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { update() {}, applyEnv() {}, cue() {}, setLineTension() {}, dispose() {} };
  }

  let ac = null;          // AudioContext, once the first gesture arrives
  let dead = false;       // no context available: every method is a no-op
  let muted = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === '0'; } catch { /* sandboxed */ }

  // From applyEnv, read every update. The gull/cricket gates and the night
  // lowpass live in update() rather than here because they blend with the
  // underwater duck, and one place doing the mixing beats two disagreeing.
  let day = 1;
  let night = 0;

  let sub = 0;            // smoothed submergence, 0 surface .. 1 under
  let motorGate = 0;      // smoothed |throttle| >= 0.05, ~0.3 s
  let nextGull = -1;
  let nextBell = -1;
  let wasNear = false;

  // Node handles and their movers, filled in by unlock().
  let masterGain, masterLP, gullBus;
  let mvLap, mvMotorG, mvMotorF, mvPutter, mvWind, mvGull, mvCricket, mvBub, mvCut;
  const loops = [];       // the always-running sources, for dispose()

  // A mover is setTargetAtTime plus a memory of the last target, so a value
  // that has not changed writes nothing: sixty timeline events a second per
  // param is exactly the event-list churn setTargetAtTime was chosen to avoid.
  const mover = (param, tc) => {
    let last = NaN;
    return (v) => {
      if (Math.abs(v - last) < 1e-4 + Math.abs(last) * 0.004) return;
      last = v;
      param.setTargetAtTime(v, ac.currentTime, tc);
    };
  };

  // Looped noise, built rather than fetched. `soften` runs a one-pole lowpass
  // over the samples as they are written (~350 Hz at 48 k), which turns hiss
  // into the dull slosh a hull actually makes; the x3.2 puts back the RMS the
  // pole ate. The tail is crossfaded into the head so the 4 s loop has no
  // seam tick — a click every four seconds is a metronome, and you cannot
  // unhear a metronome.
  function makeNoise(seconds, soften) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const w = rng.next() * 2 - 1;
      if (soften) { y += (w - y) * 0.045; d[i] = y * 3.2; } else d[i] = w * 0.5;
    }
    const F = Math.floor(ac.sampleRate * 0.05);
    for (let i = 0; i < F; i++) {
      const t = i / F;
      d[i] = d[i] * t + d[len - F + i] * (1 - t);
    }
    return buf;
  }

  function loopSource(buf) {
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    loops.push(src);
    return src;
  }

  function biquad(type, freq, q) {
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    return f;
  }

  const gain = (v) => { const g = ac.createGain(); g.gain.value = v; return g; };

  // An LFO into a gain PARAM: the param's own value is the resting point and
  // the oscillator sums onto it, so base 0.82 + depth 0.18 breathes 0.64..1.
  function lfo(hz, depth, param) {
    const o = ac.createOscillator();
    o.frequency.value = hz;
    const d = gain(depth);
    o.connect(d);
    d.connect(param);
    o.start();
    loops.push(o);
    return o;
  }

  const chain = (...nodes) => {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  };

  function panner(v) {
    if (!ac.createStereoPanner) return gain(1);      // old Safari: centred is fine
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-0.9, Math.min(0.9, v));
    return p;
  }

  function unlock() {
    if (dead) return;
    // Re-entry is the POINT, not an accident. iOS grants user activation on
    // touchend/click, not touchstart — so the first gesture event we hear may
    // create a context that resume() cannot yet start, and a later event in
    // the same tap (or the next tap) has to be able to finish the job. The
    // old version returned early whenever `ac` existed, which stranded a
    // suspended context forever: that is the "no sound on mobile" bug.
    if (ac) {
      if (ac.state !== 'running') ac.resume().catch(() => {});
      masterGain.gain.setTargetAtTime(muted ? 0 : MASTER, ac.currentTime, 0.5);
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { dead = true; return; }
      ac = new AC();

      // master: everything -> gain -> lowpass -> out. The lowpass at the END
      // is what makes night and submersion feel global for one param each.
      masterGain = gain(0);
      masterLP = biquad('lowpass', LP_DAY);
      chain(masterGain, masterLP, ac.destination);
      mvCut = mover(masterLP.frequency, 0.18);

      const soft = loopSource(makeNoise(4, true));    // lapping, bubbles
      const white = loopSource(makeNoise(4, false));  // wind, crickets

      // LAPPING — the floor of the whole mix, the sound of being on water at
      // all. The 0.23 Hz wobble is the swell period; without it the loop is a
      // steady hiss and reads as tape, with it the water breathes.
      const lapAM = gain(0.82);
      lfo(0.23, 0.18, lapAM.gain);
      const lapGain = gain(0);
      soft.connect(biquad('bandpass', 340, 0.9)).connect(lapAM);
      chain(lapAM, lapGain, masterGain);
      mvLap = mover(lapGain.gain, 0.25);

      // MOTOR — a small four-stroke at walking pace, not an outboard at full
      // chat. The chug is the putter LFO amplitude-modulating a triangle that
      // the lowpass has already rounded off; depth 0.45 on base 0.55 lets each
      // beat nearly die between fires, which is what putter means.
      const motorOsc = ac.createOscillator();
      motorOsc.type = 'triangle';
      motorOsc.frequency.value = 62;
      motorOsc.start();
      loops.push(motorOsc);
      const motorAM = gain(0.55);
      const putter = lfo(7, 0.45, motorAM.gain);
      const motorGain = gain(0);
      chain(motorOsc, biquad('lowpass', 480), motorAM, motorGain, masterGain);
      mvMotorG = mover(motorGain.gain, 0.12);
      mvMotorF = mover(motorOsc.frequency, 0.10);
      mvPutter = mover(putter.frequency, 0.15);

      // WIND — only exists above ~4 kn, squared so it arrives late and soft.
      const windGain = gain(0);
      chain(white, biquad('highpass', 900), windGain, masterGain);
      mvWind = mover(windGain.gain, 0.3);

      // GULLS route through a bus so the underwater duck catches a cry that is
      // already in flight — you cannot un-schedule an envelope, but you can
      // close the door it comes through.
      gullBus = gain(1);
      gullBus.connect(masterGain);
      mvGull = mover(gullBus.gain, 0.1);

      // CRICKETS — a single patient insect somewhere ashore. Narrowband from
      // white noise is quiet by construction (Q 16 keeps a sliver of the
      // spectrum), hence the x4 makeup ahead of the 0.02 layer gain; the
      // 4.6 Hz sine pulse is the chirp train.
      const cricketAM = gain(0.5);
      lfo(4.6, 0.5, cricketAM.gain);
      const cricketGain = gain(0);
      chain(white, biquad('bandpass', 4300, 16), gain(4), cricketAM, cricketGain, masterGain);
      mvCricket = mover(cricketGain.gain, 0.4);

      // BUBBLES — the underwater bed. Slow AM on already-soft noise; the
      // burble is the modulation, not the noise.
      const bubAM = gain(0.62);
      lfo(0.45, 0.38, bubAM.gain);
      const bubGain = gain(0);
      chain(soft, biquad('lowpass', 480), bubAM, bubGain, masterGain);
      mvBub = mover(bubGain.gain, 0.15);

      // Some browsers still hand a fresh context back suspended even inside a
      // gesture; resume is idempotent and free when it is already running.
      if (ac.state !== 'running') ac.resume().catch(() => {});
      masterGain.gain.setTargetAtTime(muted ? 0 : MASTER, ac.currentTime, 0.5);
    } catch {
      dead = true;
      ac = null;
    }
  }

  // --- one-shots -------------------------------------------------------------

  // A cry is a sawtooth swooping 1250 -> 820 Hz through a resonant bandpass:
  // the swoop is the gull, the bandpass is the distance. Two or three to a
  // phrase because a lone cry sounds like a sound effect and four is a squabble.
  function gullCry() {
    const t0 = ac.currentTime + 0.03;
    const n = rng.int(2, 3);
    const pan = panner(rng.range(-0.8, 0.8));
    pan.connect(gullBus);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.25;
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(1250, t);
      o.frequency.exponentialRampToValueAtTime(820, t + 0.28);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
      chain(o, biquad('bandpass', 1400, 4), g, pan);
      o.start(t);
      o.stop(t + 0.34);
      if (i === n - 1) o.onended = () => { try { pan.disconnect(); } catch { /* torn down */ } };
    }
  }

  // Two detuned sines are the cheapest thing that reads as bronze — the beat
  // between 620 and 933 is the shimmer a single sine cannot fake. tc 0.54
  // puts the tail at ~-40 dB by 2.5 s.
  function ringBell(pan) {
    const t = ac.currentTime + 0.02;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.04, t + 0.008);
    g.gain.setTargetAtTime(0, t + 0.02, 0.54);
    const p = panner(pan);
    chain(g, p, masterGain);
    const parts = [[620, 1], [933, 0.6]];
    for (let i = 0; i < parts.length; i++) {
      const o = ac.createOscillator();
      o.frequency.value = parts[i][0];
      chain(o, gain(parts[i][1]), g);
      o.start(t);
      o.stop(t + 3.5);
      if (i === parts.length - 1) o.onended = () => { try { p.disconnect(); } catch { /* torn down */ } };
    }
  }

  // Which way the bell is, in the listener's frame: dot of the flat bearing
  // against the camera's world right axis (column 0 of matrixWorld — unit
  // length, the rig never scales).
  function bearingPan(spot) {
    if (!camera || !camera.matrixWorld || !camera.position) return 0;
    const e = camera.matrixWorld.elements;
    const dx = spot.x - camera.position.x;
    const dz = spot.z - camera.position.z;
    const len = Math.hypot(dx, dz) || 1;
    return (dx * e[0] + dz * e[2]) / len;
  }

  // --- harpoon cues ----------------------------------------------------------
  // Fire-and-forget voices for the tug-of-war, same discipline as the gulls
  // and the bell: a few nodes made on demand, envelopes scheduled up front,
  // the terminal node disconnected when the longest source ends. All of them
  // sit UNDER the soundscape - the drama is on screen, the audio just nods.

  // One-shots need noise as well as sine; a half-second buffer built once is
  // cheaper than a fresh one per cue, and makeNoise's seam crossfade is
  // harmless on a single pass. loop=true so any cue length is safe.
  let cueNoiseBuf = null;
  function noiseShot(t, dur) {
    if (!cueNoiseBuf) cueNoiseBuf = makeNoise(0.5, false);
    const src = ac.createBufferSource();
    src.buffer = cueNoiseBuf;
    src.loop = true;
    src.start(t);
    src.stop(t + dur);
    return src;
  }

  // A soft mechanical thunk (the bow arm slapping home) under an airy whoosh:
  // bandpassed noise whose band falls with the spear.
  function cueHarpoonFire() {
    const t = ac.currentTime + 0.02;
    const o = ac.createOscillator();
    o.frequency.value = 90;
    const og = ac.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.08, t + 0.008);
    og.gain.setTargetAtTime(0, t + 0.02, 0.05);
    chain(o, og, masterGain);
    o.start(t);
    o.stop(t + 0.3);
    const n = noiseShot(t, 0.3);
    const bp = biquad('bandpass', 2400, 1.2);
    bp.frequency.setValueAtTime(2400, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.09, t + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    chain(n, bp, ng, masterGain);
    n.onended = () => { try { og.disconnect(); ng.disconnect(); } catch { /* torn down */ } };
  }

  // A wet deep thunk: the 65 Hz pluck is the hit, the lowpassed noise is the
  // water closing over it.
  function cueHarpoonHit() {
    const t = ac.currentTime + 0.02;
    const o = ac.createOscillator();
    o.frequency.value = 65;
    const og = ac.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    og.gain.setTargetAtTime(0, t + 0.03, 0.11);
    chain(o, og, masterGain);
    o.start(t);
    o.stop(t + 0.6);
    const n = noiseShot(t, 0.55);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.07, t + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    chain(n, biquad('lowpass', 900), ng, masterGain);
    o.onended = () => { try { og.disconnect(); ng.disconnect(); } catch { /* torn down */ } };
  }

  // A bright crack, then the cut end singing down an octave and a half as it
  // whips away. The twang is a quiet sine so it stings without startling.
  function cueLineSnap() {
    const t = ac.currentTime + 0.02;
    const n = noiseShot(t, 0.08);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.11, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    chain(n, biquad('highpass', 2500), ng, masterGain);
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(900, t + 0.02);
    o.frequency.exponentialRampToValueAtTime(200, t + 0.37);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.045, t + 0.04);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    chain(o, og, masterGain);
    o.start(t + 0.02);
    o.stop(t + 0.45);
    o.onended = () => { try { ng.disconnect(); og.disconnect(); } catch { /* torn down */ } };
  }

  // The leviathan, heard through the hull: two detuned sines wandering slowly
  // between about 70 and 130 Hz under a lowpass, swelling in and sighing out.
  // Enormous and sad, not scary - the lowpass and the slow attack do both.
  function cueLevGroan() {
    const t = ac.currentTime + 0.02;
    const dur = rng.range(2.5, 4);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + dur * 0.35);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.16);
    const lp = biquad('lowpass', 260);
    chain(lp, g, masterGain);
    const f0 = rng.range(70, 85);
    const f1 = rng.range(112, 130);
    const parts = [[1, 1], [1.033, 0.7]];
    for (let i = 0; i < parts.length; i++) {
      const o = ac.createOscillator();
      o.frequency.setValueAtTime(f0 * parts[i][0], t);
      o.frequency.linearRampToValueAtTime(f1 * parts[i][0], t + dur * 0.55);
      o.frequency.linearRampToValueAtTime(f0 * 1.12 * parts[i][0], t + dur);
      chain(o, gain(parts[i][1]), lp);
      o.start(t);
      o.stop(t + dur + 1);
      if (i === parts.length - 1) o.onended = () => { try { g.disconnect(); } catch { /* torn down */ } };
    }
  }

  // The creature gives up: the harbour bell's voice - detuned sine pair,
  // fast strike, long tc tail - walking up three notes at well under the
  // bell's weight. Relief, not fanfare.
  function cueVictory() {
    const t0 = ac.currentTime + 0.03;
    const out = gain(1);
    out.connect(masterGain);
    const notes = [523, 659, 784];
    for (let k = 0; k < notes.length; k++) {
      const t = t0 + k * 0.3;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.025, t + 0.008);
      g.gain.setTargetAtTime(0, t + 0.02, 0.4);
      g.connect(out);
      const parts = [[notes[k], 1], [notes[k] * 1.505, 0.6]];
      for (let i = 0; i < parts.length; i++) {
        const o = ac.createOscillator();
        o.frequency.value = parts[i][0];
        chain(o, gain(parts[i][1]), g);
        o.start(t);
        o.stop(t + 2.5);
        if (k === notes.length - 1 && i === parts.length - 1) {
          o.onended = () => { try { out.disconnect(); } catch { /* torn down */ } };
        }
      }
    }
  }

  // Public: named one-shots for the harpoon fight. Not unlocked yet means the
  // moment has passed - a cue played late is worse than a cue not played, so
  // nothing is ever queued. Unknown names are silently nothing (rule 3).
  function cue(name) {
    if (!ac || dead || muted || ac.state !== 'running') return;
    try {
      if (name === 'harpoonFire') cueHarpoonFire();
      else if (name === 'harpoonHit') cueHarpoonHit();
      else if (name === 'lineSnap') cueLineSnap();
      else if (name === 'levGroan') cueLevGroan();
      else if (name === 'victory') cueVictory();
    } catch { /* silence over stack traces, always */ }
  }

  // --- the rope --------------------------------------------------------------
  // A tensioned line is a small bowed instrument: narrowband noise is the
  // fibre creak, an LFO drifting the resonance keeps it groaning instead of
  // humming, and a lowpassed underlayer whose cutoff climbs with tension
  // gives danger a pitch. Built lazily on the first real pull, then it idles
  // at gain 0 forever, like every other layer in the graph. Seven persistent
  // nodes, all stopped by the same loops[] sweep at dispose.
  let creakBuilt = false;
  let mvCreak, mvCreakLow, mvCreakF;
  function buildCreak() {
    const src = loopSource(makeNoise(2, false));
    const bp = biquad('bandpass', 650, 7);
    lfo(0.83, 210, bp.frequency);        // resonance wanders ~440..860 Hz
    const cg = gain(0);
    chain(src, bp, cg, masterGain);
    mvCreak = mover(cg.gain, 0.08);
    const lp = biquad('lowpass', 320);
    const lg = gain(0);
    chain(src, lp, lg, masterGain);
    mvCreakLow = mover(lg.gain, 0.08);
    mvCreakF = mover(lp.frequency, 0.12);
    creakBuilt = true;
  }

  // Public: line tension 0..1 from the harpoon module. Below the floor the
  // gains settle to 0 and the voice runs silent, exactly like the movers.
  function setLineTension(v) {
    if (!ac || dead) return;
    try {
      v = clamp01(+v || 0);
      if (!creakBuilt) {
        if (v <= 0.01) return;
        buildCreak();
      }
      const on = v <= 0.01 ? 0 : v;
      mvCreak(on * 0.055);
      mvCreakLow(on * on * 0.05);
      mvCreakF(320 + v * 340);           // 320 -> 660: the pitch of danger
    } catch { /* silence over stack traces, always */ }
  }

  // --- the mute chip ---------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const btn = document.createElement('button');
  btn.id = 'sf-audio';
  btn.setAttribute('data-sf-ui', '');
  btn.textContent = muted ? GLYPH_OFF : GLYPH_ON;
  btn.title = 'Sound on/off';
  document.body.appendChild(btn);

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem(STORAGE_KEY, m ? '0' : '1'); } catch { /* sandboxed */ }
    btn.textContent = m ? GLYPH_OFF : GLYPH_ON;
    // Fade rather than suspend: a suspended context resumes with a pop, and a
    // master at 0 costs nothing worth chasing.
    if (ac) masterGain.gain.setTargetAtTime(m ? 0 : MASTER, ac.currentTime, 0.25);
  }
  const onBtn = (e) => { e.preventDefault(); setMuted(!muted); };
  btn.addEventListener('click', onBtn);

  // The iOS ringer-switch bypass: a silent looping <audio> element, started
  // inside a real gesture. See SILENT_WAV. Kept playing for the life of the
  // page — it is one decoded sample on loop, and stopping it hands the session
  // back to the ringer.
  let htmlKick = null;
  function kickPlayback() {
    try {
      if (!htmlKick) {
        htmlKick = document.createElement('audio');
        htmlKick.setAttribute('playsinline', '');
        htmlKick.loop = true;
        htmlKick.src = SILENT_WAV;
      }
      const pr = htmlKick.play();
      if (pr && pr.catch) pr.catch(() => {});
    } catch { /* an <audio> that will not play is just absent */ }
  }

  // The unlock gestures. NOT once-handlers, and covering the activation set
  // rather than three guesses at it: iOS counts touchend and click, Chrome
  // counts pointerdown and keydown, and the first version listened to
  // touchstart — which iOS does NOT count for audio — with { once: true },
  // so a phone's very first tap consumed the listener while the context
  // stayed suspended, permanently. These stay attached until everything is
  // demonstrably running, then remove themselves.
  const GESTURES = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'];
  const onGesture = () => {
    unlock();
    kickPlayback();
    if (ac && ac.state === 'running' && htmlKick && !htmlKick.paused) {
      for (const g of GESTURES) window.removeEventListener(g, onGesture);
    }
  };
  for (const g of GESTURES) window.addEventListener(g, onGesture, { passive: true });
  // iOS suspends (or "interrupts") the context when the tab backgrounds and
  // does not always bring it back; a visible tab with a non-running context is
  // the one state worth poking.
  const onVis = () => {
    if (!document.hidden && ac && ac.state !== 'running') ac.resume().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVis);

  // --- per frame -------------------------------------------------------------

  function update(ctx) {
    if (!ac || dead) return;
    try {
      const t = ctx.time || 0;
      const dt = Math.min(0.1, Math.max(0.0001, ctx.dt || 0.016));
      const boat = ctx.boat || {};
      const speed = Math.abs(boat.speed || 0);

      // Submergence is computed here rather than trusted from ctx: the module
      // contract is water()/camera in, sound out, and the flag main.js keeps
      // for the post pass has its own shaping.
      let subT = 0;
      const w = water();
      if (w && w.sampleHeight && camera && camera.position) {
        subT = camera.position.y < w.sampleHeight(camera.position.x, camera.position.z, t) ? 1 : 0;
      }
      sub += (subT - sub) * (1 - Math.exp(-dt / 0.25));

      // Lapping fades as speed rises — under way, the hull noise and wind own
      // the mix and the shoreline slosh belongs to being stopped.
      mvLap(0.16 / (1 + speed * 0.25));

      // The gate smooths in JS at ~0.3 s so blipping the throttle swells the
      // motor instead of clicking it.
      motorGate += ((Math.abs(boat.throttle || 0) >= 0.05 ? 1 : 0) - motorGate)
        * (1 - Math.exp(-dt / 0.3));
      mvMotorG(motorGate * (0.06 + 0.05 * Math.min(1, speed / 9)));
      mvMotorF(62 + speed * 7);
      mvPutter(7 + speed * 1.1);

      mvWind(0.10 * clamp01((speed - 4) / 10) ** 2 * (1 - sub));

      // Ducks and beds driven by submergence.
      mvGull(1 - sub);
      mvBub(0.05 * sub);
      // Crickets duck under too: the shore has no business being audible from
      // under the lagoon, nightFactor or not.
      mvCricket(0.02 * night * (1 - sub));

      // One lowpass carries both moods: night darkens the top end a shade,
      // going under closes it to a murmur.
      const surf = LP_DAY + (LP_NIGHT - LP_DAY) * night;
      mvCut(surf + (LP_UNDER - surf) * sub);

      // One-shots only when there is a running clock to schedule against and
      // someone to hear them.
      if (ac.state === 'running' && !muted) {
        if (day > 0.35 && sub < 0.5) {
          if (nextGull < 0) nextGull = t + rng.range(4, 12);
          if (t >= nextGull) { gullCry(); nextGull = t + rng.range(9, 26); }
        }

        if (spots.length && boat.position) {
          let nearest = null;
          let best = BELL_RANGE * BELL_RANGE;
          for (const s of spots) {
            const dx = s.x - boat.position.x;
            const dz = s.z - boat.position.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < best) { best = d2; nearest = s; }
          }
          // A first ring shortly after arriving, then the slow cadence: on the
          // full 40-70 s clock a short visit could come and go unrung, and the
          // bell is the harbour saying hello.
          if (nearest && !wasNear) nextBell = t + rng.range(8, 18);
          if (nearest && t >= nextBell) {
            ringBell(bearingPan(nearest));
            nextBell = t + rng.range(40, 70);
          }
          wasNear = !!nearest;
        }
      }
    } catch { /* silence over stack traces, always */ }
  }

  function applyEnv(env) {
    if (!env) return;
    day = env.dayFactor ?? day;
    night = env.nightFactor ?? night;
  }

  function dispose() {
    try {
      for (const g of GESTURES) window.removeEventListener(g, onGesture);
      if (htmlKick) { try { htmlKick.pause(); } catch { /* fine */ } htmlKick = null; }
      document.removeEventListener('visibilitychange', onVis);
      btn.removeEventListener('click', onBtn);
      btn.remove();
      style.remove();
      for (const s of loops) { try { s.stop(); } catch { /* already stopped */ } }
      loops.length = 0;
      if (ac) ac.close().catch(() => {});
      ac = null;
      dead = true;
    } catch { /* never throw, even on the way out */ }
  }

  return { update, applyEnv, cue, setLineTension, dispose };
}
