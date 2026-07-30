// What lives in the water, at what depth, and how hard it fights.
//
// Fishing is the game's on-ramp: it is calm, it pays badly, and it buys your
// first real boat. The fight numbers are the interesting part -- `runs` is how
// often it bolts, `power` is how fast tension climbs while it does, and
// `stamina` is how long it can keep that up.

export const FISH = [
  // ---- the lagoon: what you catch off the dock in your first ten minutes
  {
    id: 'sprat', name: 'Silver Sprat', water: 'lagoon', weight: 6,
    kg: [0.1, 0.5], perKg: 14, runs: 0.5, power: 0.5, stamina: 2.4,
    color: 0xc9d8e0, blurb: 'Barely a mouthful. Good practice.',
  },
  {
    id: 'bream', name: 'Copper Bream', water: 'lagoon', weight: 5,
    kg: [0.4, 1.8], perKg: 20, runs: 0.8, power: 0.8, stamina: 3.6,
    color: 0xc98a4a, blurb: 'Fights above its weight in the shallows.',
  },
  {
    id: 'wrasse', name: 'Reef Wrasse', water: 'lagoon', weight: 3,
    kg: [0.8, 3.2], perKg: 26, runs: 1.1, power: 1.0, stamina: 4.5,
    color: 0x3fa08c, blurb: 'Runs for the coral the moment it feels the hook.',
  },
  {
    id: 'crab', name: 'Kelder Crab', water: 'lagoon', weight: 2,
    kg: [0.3, 1.4], perKg: 34, runs: 0.2, power: 1.4, stamina: 2.0,
    color: 0xb8503f, blurb: 'Does not run. Simply refuses to come up.',
  },
  // ---- past the reef
  {
    id: 'mackerel', name: 'Blue Mackerel', water: 'shelf', weight: 5,
    kg: [0.6, 2.6], perKg: 30, runs: 1.6, power: 1.2, stamina: 5,
    color: 0x4a7fb8, blurb: 'Fast, and knows it.',
  },
  {
    id: 'snapper', name: 'Gold Snapper', water: 'shelf', weight: 3,
    kg: [1.5, 7], perKg: 42, runs: 1.2, power: 1.6, stamina: 7,
    color: 0xd9a13c, blurb: 'The fish the market actually wants.',
  },
  {
    id: 'ray', name: 'Shelf Ray', water: 'shelf', weight: 2,
    kg: [3, 14], perKg: 38, runs: 0.6, power: 2.2, stamina: 9,
    color: 0x8a7f6e, blurb: 'Like winching up a wet carpet that hates you.',
  },
  // ---- open water, from the boat
  {
    id: 'tuna', name: 'Longfin Tuna', water: 'deep', weight: 4,
    kg: [8, 45], perKg: 58, runs: 2.2, power: 2.4, stamina: 13,
    color: 0x2f6f92, blurb: 'Will empty your reel if you let it.',
  },
  {
    id: 'lantern', name: 'Lantern Fish', water: 'deep', weight: 2,
    kg: [0.4, 2.2], perKg: 130, runs: 1.8, power: 1.4, stamina: 6,
    color: 0x7be0d0, blurb: 'Came up from somewhere with no light at all.',
  },
  {
    id: 'oarfish', name: 'Oarfish', water: 'deep', weight: 1,
    kg: [20, 90], perKg: 74, runs: 2.6, power: 3.2, stamina: 18,
    color: 0xc0c6d8, blurb: 'Nine feet of silver ribbon. Sailors call it a warning.',
  },
];

export const FISH_BY_ID = Object.fromEntries(FISH.map((f) => [f.id, f]));

/** Which water you are fishing, by distance from town. */
export function waterAt(distance) {
  if (distance < 240) return 'lagoon';
  if (distance < 700) return 'shelf';
  return 'deep';
}

/** Pick a species for a cast, weighted by how common it is in that water. */
export function rollSpecies(water, random = Math.random) {
  const pool = FISH.filter((f) => f.water === water);
  const total = pool.reduce((a, f) => a + f.weight, 0);
  let roll = random() * total;
  for (const f of pool) {
    roll -= f.weight;
    if (roll <= 0) return f;
  }
  return pool[pool.length - 1];
}

/** Bigger fish are rarer: the size roll is biased small and has a long tail. */
export function rollWeight(species, random = Math.random) {
  const [lo, hi] = species.kg;
  const t = Math.pow(random(), 2.1);
  return +(lo + (hi - lo) * t).toFixed(2);
}

export function fishValue(species, kg) {
  // A trophy is worth more per kilo than the same weight of small ones.
  const [lo, hi] = species.kg;
  const size = (kg - lo) / Math.max(0.001, hi - lo);
  return Math.max(1, Math.round(kg * species.perKg * (1 + size * 0.5)));
}

/** How many fish fit in the basket, whatever boat you are in. */
export const BASKET = 24;
