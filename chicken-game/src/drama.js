// Who has it in for whom.
//
// The coop was always a melodrama; it just had no memory. A hen shoved off
// the feed went back to pecking as though nothing had happened, and the same
// two birds never became a feud. This is the memory: a directed affinity from
// every chicken to every other, nudged by things that actually happen to
// them, and fed back into what they choose to do next.
//
// Directed rather than mutual on purpose. A hen can nurse a grudge against
// a bird who has not noticed her existence, which is both true to chickens
// and the single most reliable engine of soap opera ever devised.
//
// This is simulation state: it changes what chickens do, so it must be
// identical on every screen. Only ticks may touch it.

// What each thing that can happen between two chickens is worth. The wronged
// party's feeling moves a lot; the wrongdoer barely registers it, which is
// how grudges become one-sided.
export const SLIGHTS = {
  displaced: -0.30,     // shoved off the food
  shovedOffRoost: -0.34,
  evictedFromNest: -0.40,
  lostStandoff: -0.22,
  deposed: -0.55,       // she took my place in the order
  chased: -0.12,
  stolenWorm: -0.26,
};

export const KINDNESSES = {
  bathedTogether: 0.20,
  roostedTogether: 0.12,
  followed: 0.18,       // joined her conga, copied her, came when called
  defended: 0.42,       // she saw off the fox for me
  fedBy: 0.30,          // he called me over to food
};

const MAX = 2.5;

export class Relationships {
  constructor(n) {
    this.n = n;
    this.a = new Float32Array(n * n);
  }

  // How `from` feels about `to`. Negative is a grudge.
  get(from, to) {
    if (from === to) return 0;
    return this.a[from * this.n + to];
  }

  set(from, to, v) {
    if (from === to) return;
    this.a[from * this.n + to] = Math.max(-MAX, Math.min(MAX, v));
  }

  adjust(from, to, delta) {
    this.set(from, to, this.get(from, to) + delta);
  }

  // Something happened to `victim` because of `actor`. The victim takes it to
  // heart; the actor thinks a little less of someone they just walked over,
  // which is how a one-sided grudge turns into a two-sided feud.
  slight(actor, victim, kind) {
    const d = SLIGHTS[kind] ?? -0.2;
    this.adjust(victim, actor, d);
    this.adjust(actor, victim, d * 0.25);
  }

  kindness(giver, receiver, kind) {
    const d = KINDNESSES[kind] ?? 0.1;
    this.adjust(receiver, giver, d);
    this.adjust(giver, receiver, d * 0.5);
  }

  // Feelings fade. Without this every pair ends up at the extremes within an
  // hour and nothing that happens afterwards means anything.
  decay(dt) {
    // Slow: fast decay wipes out the history the flock starts with before a
    // viewer has watched long enough to see it matter.
    const k = Math.exp(-dt / 900);      // ~15 minutes to fall by 1/e
    for (let i = 0; i < this.a.length; i++) this.a[i] *= k;
  }

  // The bird this one most wants to have words with, and the one she would
  // rather sit next to. Both used to bias behavior choice.
  worst(from, among) {
    let best = null, v = -0.4;          // below this it is not worth acting on
    for (const o of among) {
      const f = this.get(from, o.index);
      if (f < v) { v = f; best = o; }
    }
    return best;
  }

  best(from, among) {
    let bestO = null, v = 0.35;
    for (const o of among) {
      const f = this.get(from, o.index);
      if (f > v) { v = f; bestO = o; }
    }
    return bestO;
  }

  // Everything, for the snapshot. Quantised: a joiner needs the shape of the
  // feuds, not the last bit of it.
  serialize() {
    return Array.from(this.a, (v) => Math.round(v * 100));
  }

  load(rows) {
    if (!rows || rows.length !== this.a.length) return;
    for (let i = 0; i < this.a.length; i++) this.a[i] = rows[i] / 100;
  }
}

// A flock has history before you turn up.
//
// Left to build itself from nothing, the web took ten minutes to produce a
// single alliance — long after anybody had stopped watching — and standoffs
// in the meantime were between birds with no feelings about each other at
// all. Seeding it means the drama is legible in the first minute, and the
// emergent side then modifies a story instead of having to invent one.
//
// Pairs of inseparables, and everybody with somebody she cannot stand.
export function seedRelationships(flock, rng, rel) {
  const order = [...flock];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i + 1 < order.length; i += 2) {
    const a = order[i], b = order[i + 1];
    rel.set(a.index, b.index, 1.4);
    rel.set(b.index, a.index, 1.4);
  }
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    const partner = order[i ^ 1];
    const foes = order.filter((o) => o !== a && o !== partner);
    if (!foes.length) continue;
    const foe = foes[Math.floor(rng() * foes.length)];
    rel.adjust(a.index, foe.index, -1.1);
  }
}
