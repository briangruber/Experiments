// A handful of synthesized sounds — distant surf, plips, a catch chime.
// Everything is built lazily on the first user gesture (autoplay rules).

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.85;
      master.connect(ctx.destination);
      ambience();
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  // Distant surf: looped noise through a slow-breathing lowpass.
  function ambience() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // pinkish noise via leaky integrator
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.03;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.022;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(lp).connect(g).connect(master);
    src.start();
    lfo.start();
  }

  function env(gainNode, peak, attack, decay) {
    const t = ctx.currentTime;
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(peak, t + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(type, f0, f1, dur, peak) {
    if (!ctx || muted) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(f1, ctx.currentTime + dur);
    const g = ctx.createGain();
    env(g, peak, 0.006, dur);
    o.connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.05);
  }

  return {
    ensure,

    // Water swallowing the bobber.
    plip(strength = 1) {
      tone('sine', 520 * Math.pow(strength, 0.3), 160, 0.16 * strength + 0.06, 0.11 * strength);
    },

    // Rod whip.
    whoosh() {
      tone('triangle', 180, 70, 0.18, 0.03);
    },

    // The double-tug of a bite.
    bite() {
      tone('sine', 420, 130, 0.14, 0.14);
      setTimeout(() => tone('sine', 380, 120, 0.14, 0.12), 110);
    },

    // A tiny arpeggio, one note per star (minimum two notes).
    chime(stars) {
      if (!ctx || muted) return;
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      for (let i = 0; i < Math.max(2, Math.min(stars + 1, 5)); i++) {
        setTimeout(() => tone('triangle', notes[i], notes[i], 0.5, 0.05), i * 95);
      }
    },

    toggle() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.85;
      return muted;
    },
  };
}
