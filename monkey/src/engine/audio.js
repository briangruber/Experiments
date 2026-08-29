// Voice playback, and the durations that come with it.
//
// The useful half of this module is not the playing — it is that a recorded
// line knows how long it is. Before any clip exists, a line's duration is
// guessed from its length, and the guess is always slightly wrong in a way
// that makes the comic timing feel off. Once tools/voices.mjs has measured the
// clips, the same line plays for exactly as long as it takes to say, and the
// subtitle matches. Writing to a real clock instead of an estimated one is
// most of what recording early buys you.
//
// Everything degrades to silence: no manifest, no clip, or a browser that
// refuses to autoplay all leave the game working with estimated timings.

export class Voice {
  constructor(base = './assets/voice/') {
    this.base = base;
    this.manifest = null;
    this.cache = new Map();
    this.current = null;
    this.muted = false;
  }

  async load() {
    try {
      const res = await fetch(this.base + 'manifest.json');
      if (!res.ok) return false;
      this.manifest = await res.json();
      return true;
    } catch { return false; }
  }

  has(id) { return !!this.manifest?.lines?.[id]; }

  // Returns the measured length in seconds, or null so callers fall back to
  // their own estimate.
  duration(id) { return this.manifest?.lines?.[id]?.dur ?? null; }

  play(id) {
    if (this.muted || !this.has(id)) return null;
    this.stop();
    let a = this.cache.get(id);
    if (!a) {
      a = new Audio(this.base + id + '.mp3');
      a.preload = 'auto';
      this.cache.set(id, a);
    }
    a.currentTime = 0;
    a.play().catch(() => {});   // autoplay policy, not an error worth surfacing
    this.current = a;
    return a;
  }

  stop() {
    if (this.current) { this.current.pause(); this.current = null; }
  }
}
