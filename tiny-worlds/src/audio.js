// A very small synthesizer. Everything is oscillators with exponential
// decays; no samples, no dependencies. Fails silently anywhere WebAudio is
// unavailable — the game never depends on sound.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});

  let ctx = null;
  let master = null;
  let muted = false;

  function init() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.4;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
    }
  }

  function tone(freq, dur, opts) {
    if (!ctx || muted) return;
    opts = opts || {};
    try {
      const t0 = ctx.currentTime + (opts.delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.glide) osc.frequency.exponentialRampToValueAtTime(opts.glide, t0 + dur);
      const v = opts.vol || 0.12;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(v, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch (e) { /* sound is optional */ }
  }

  const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0];

  const Sound = {
    init,
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.4;
      return muted;
    },
    // collecting a stardust mote
    ping(n) {
      const f = PENTA[n % PENTA.length];
      tone(f, 0.5, { vol: 0.1 });
      tone(f * 2, 0.35, { vol: 0.04, delay: 0.02 });
    },
    // diving into a rift: a long fall
    dive() {
      tone(620, 1.0, { glide: 140, vol: 0.1, type: 'sine' });
      tone(930, 0.9, { glide: 210, vol: 0.05, type: 'triangle', delay: 0.05 });
      for (let i = 0; i < 4; i++) tone(1300 - i * 220, 0.22, { vol: 0.03, delay: 0.1 + i * 0.13 });
    },
    // climbing back out
    surface() {
      tone(180, 0.8, { glide: 520, vol: 0.09 });
      tone(270, 0.7, { glide: 780, vol: 0.045, type: 'triangle', delay: 0.04 });
    },
    // a new world revealed
    discover() {
      tone(659.25, 0.7, { vol: 0.06, delay: 0.35 });
      tone(987.77, 0.9, { vol: 0.05, delay: 0.47 });
    },
    // crossing a scale milestone
    milestone() {
      tone(392, 1.4, { vol: 0.06 });
      tone(493.88, 1.4, { vol: 0.05, delay: 0.12 });
      tone(587.33, 1.6, { vol: 0.05, delay: 0.24 });
    },
    bump() {
      tone(160, 0.25, { glide: 120, vol: 0.07, type: 'triangle' });
    },
  };

  TW.Sound = Sound;
})();
