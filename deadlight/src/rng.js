// Seeded randomness.
//
// Every run of DEADLIGHT is reproducible from its seed: layout, fuse
// placement, prop dressing, patrol routes and the scare director's dice all
// pull from streams derived here. That is what makes a seed worth sharing —
// "try 9F4KD, the first fuse room is a nightmare" only means something if the
// room is the same for whoever types it in.
//
// Note that the director draws from its own stream (see `Rng.fork`), so a
// player's choices change *when* scares fire without shifting the layout.

/** mulberry32 — small, fast, and good enough that runs feel unrelated. */
function mulberry32(a) {
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the seed text, so seeds can be words as well as numbers. */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  const s = String(text).toUpperCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seed alphabet without the characters people mis-transcribe (0/O, 1/I). */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A fresh five-character seed, short enough to read aloud on stream. */
export function randomSeed() {
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  }
  return out;
}

export class Rng {
  constructor(seed) {
    this.seed = seed;
    this.next = mulberry32(hashSeed(seed));
  }

  /** A stream that is stable for `label` but independent of this one. */
  fork(label) {
    return new Rng(`${this.seed}:${label}`);
  }

  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(chance = 0.5) {
    return this.next() < chance;
  }

  pick(list) {
    return list[(this.next() * list.length) | 0];
  }

  /** In-place Fisher–Yates. */
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = (this.next() * (i + 1)) | 0;
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  /** Draw from `list` without repeats until it is exhausted, then reshuffle.
   *  Used for whisper lines and scare choice, where a repeat inside a few
   *  seconds reads as a bug rather than as atmosphere. */
  bag(list) {
    let pool = [];
    return () => {
      if (!pool.length) pool = this.shuffle([...list]);
      return pool.pop();
    };
  }
}
