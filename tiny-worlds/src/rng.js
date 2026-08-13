// Deterministic randomness. Every world is a 32-bit seed; child worlds derive
// their seeds from the parent's, so the whole infinite universe is one number.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});

  // xmur3-style string hash -> u32
  function hash32(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  // Combine two u32s into a new u32 (child-seed derivation).
  function mix(a, b) {
    let h = (a ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ b, 2654435761);
    h ^= h >>> 13;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class RNG {
    constructor(seed) { this.next = mulberry32(seed >>> 0); }
    float() { return this.next(); }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    chance(p) { return this.next() < p; }
    sign() { return this.next() < 0.5 ? -1 : 1; }
    angle() { return this.next() * Math.PI * 2; }
    // entries: [[value, weight], ...]
    weighted(entries) {
      let total = 0;
      for (const e of entries) total += e[1];
      let r = this.next() * total;
      for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
      return entries[entries.length - 1][0];
    }
  }

  TW.hash32 = hash32;
  TW.mix = mix;
  TW.RNG = RNG;
})();
