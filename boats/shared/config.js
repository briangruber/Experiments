// The whole game economy lives here. Server and client both import it, so the
// numbers a player sees in the shipwright's window are the numbers the server
// charges them.

export const WORLD = {
  radius: 3200,          // hard edge of the playable sea
  town: { x: 0, z: 0 },
  townRadius: 200,       // inside this you are docked (calm water, no monsters)
  safeRadius: 240,       // monsters will not spawn or hunt inside this
  monsterCap: 46,
  tickRate: 20,          // server simulation hz
  stateRate: 12,         // hz of player state broadcast
};

// Each boat is a step up in every direction, so the choice is always "can I
// afford it yet", never "which is better".
export const BOATS = [
  {
    id: 'rowboat', name: 'Rowboat', price: 0, level: 1,
    hull: 60, crew: 2, speed: 8.5, accel: 5.5, turn: 1.5,
    harpoonDamage: 12, rope: 46, reel: 6.5, hold: 1, length: 4.2,
    blurb: 'Two oars and a prayer. Everyone starts here.',
  },
  {
    id: 'skiff', name: 'Skiff', price: 240, level: 2,
    hull: 145, crew: 3, speed: 11.5, accel: 6.5, turn: 1.35,
    harpoonDamage: 22, rope: 72, reel: 9, hold: 2, length: 6.5,
    blurb: 'A sail, a winch, and enough deck to stand on.',
  },
  {
    id: 'cutter', name: 'Cutter', price: 880, level: 4,
    hull: 300, crew: 5, speed: 14.5, accel: 7.2, turn: 1.2,
    harpoonDamage: 38, rope: 108, reel: 13, hold: 3, length: 9,
    blurb: 'Fast enough to run away. Usually.',
  },
  {
    id: 'whaler', name: 'Whaler', price: 2600, level: 7,
    hull: 560, crew: 8, speed: 16.5, accel: 7.8, turn: 1.05,
    harpoonDamage: 62, rope: 155, reel: 18, hold: 4, length: 12.5,
    blurb: 'Purpose-built: reinforced bow, proper winch, hot food.',
  },
  {
    id: 'brigantine', name: 'Brigantine', price: 7200, level: 11,
    hull: 980, crew: 12, speed: 18.5, accel: 8.2, turn: 0.92,
    harpoonDamage: 98, rope: 215, reel: 25, hold: 5, length: 17,
    blurb: 'Two masts, twelve hands, and a hold that smells of salt.',
  },
  {
    id: 'galleon', name: 'Galleon', price: 19000, level: 16,
    hull: 1650, crew: 18, speed: 20.5, accel: 8.6, turn: 0.82,
    harpoonDamage: 152, rope: 290, reel: 33, hold: 6, length: 23,
    blurb: 'A town that floats. The kraken notices you now.',
  },
  {
    id: 'dreadnought', name: 'Leviathan-Class', price: 46000, level: 22,
    hull: 2600, crew: 26, speed: 23, accel: 9.2, turn: 0.76,
    harpoonDamage: 225, rope: 380, reel: 44, hold: 8, length: 31,
    blurb: 'Built for one purpose. You know which one.',
  },
];

// model: how monsterFactory builds it. zone: distance band from town where it
// spawns -- swimming further out is the only way to find the big ones.
export const MONSTERS = [
  {
    id: 'silverfin', name: 'Silverfin Serpent', model: 'serpent', tier: 0,
    hp: 95, speed: 6.2, damage: 7, bite: 0.06, bounty: 95, xp: 45,
    size: 1.6, aggro: 100, reach: 12, slots: 1,
    color: 0x6fa8b8, accent: 0xe8f4f6,
    zone: [WORLD.safeRadius, 700],
  },
  {
    id: 'gulper', name: 'Gulper Eel', model: 'serpent', tier: 1,
    hp: 240, speed: 7.4, damage: 13, bite: 0.10, bounty: 300, xp: 130,
    size: 2.2, aggro: 130, reach: 15, slots: 1,
    color: 0x4a4668, accent: 0xc9a7ff,
    zone: [420, 1150],
  },
  {
    id: 'reefkraken', name: 'Reef Kraken', model: 'kraken', tier: 2,
    hp: 560, speed: 6.0, damage: 22, bite: 0.16, bounty: 860, xp: 340,
    size: 2.7, aggro: 155, reach: 22, slots: 2,
    color: 0xa8443f, accent: 0xf0c08a,
    zone: [700, 1600],
  },
  {
    id: 'ironback', name: 'Ironback Whale', model: 'leviathan', tier: 3,
    hp: 1250, speed: 8.2, damage: 34, bite: 0.14, bounty: 2250, xp: 820,
    size: 3.4, aggro: 175, reach: 26, slots: 2,
    color: 0x50606e, accent: 0x9fb3c2,
    zone: [1050, 2100],
  },
  {
    id: 'abysskraken', name: 'Abyss Kraken', model: 'kraken', tier: 4,
    hp: 2600, speed: 7.0, damage: 52, bite: 0.22, bounty: 5400, xp: 1900,
    size: 4.2, aggro: 200, reach: 34, slots: 3,
    color: 0x2d2b4a, accent: 0x7be0d0,
    zone: [1450, 2600],
  },
  {
    id: 'frost', name: 'Frost Leviathan', model: 'leviathan', tier: 5,
    hp: 5200, speed: 9.4, damage: 78, bite: 0.20, bounty: 12500, xp: 4200,
    size: 5.2, aggro: 230, reach: 42, slots: 4,
    color: 0xbfe4ee, accent: 0x5f9fd8,
    zone: [1900, 3000],
  },
  {
    id: 'maelstrom', name: 'Maelstrom Wyrm', model: 'serpent', tier: 6,
    hp: 12000, speed: 10.5, damage: 120, bite: 0.28, bounty: 31000, xp: 11000,
    size: 7.0, aggro: 310, reach: 55, slots: 5,
    color: 0x1b2340, accent: 0xff8a3d,
    zone: [2400, WORLD.radius],
  },
];

export const MONSTER_BY_ID = Object.fromEntries(MONSTERS.map((m) => [m.id, m]));

export const HARPOON = {
  chargeTime: 0.95,       // seconds to a full-power throw
  minSpeed: 58,
  maxSpeed: 132,
  gravity: 15,
  cooldown: 1.1,
  radius: 3.4,            // fattened hit sphere, scaled by monster size
  strainSnap: 100,
  strainRelief: 16,       // strain bled off per second when the rope is slack
  reelStrain: 9,          // strain per second while cranking the winch
  dragStrain: 0.9,        // strain per second per metre of over-extension,
                          // scaled by how badly the beast outweighs the boat
};

export const CREW = { hireCost: 55, repairPerPoint: 1.6 };

/** What one more hand costs on a given hull. */
export function crewCost(tier) {
  return Math.round(CREW.hireCost * (1 + tier * 0.9));
}

/** Deaths are expensive but never terminal: the widows take a cut, not all of it. */
export const SINK_GOLD_PENALTY = 0.4;

export function xpForLevel(level) {
  // Level 2 at 260xp, then a gentle curve that keeps pace with the bounties.
  return Math.round(180 * Math.pow(level, 1.85));
}

export function levelFromXp(xp) {
  let lvl = 1;
  while (lvl < 40 && xp >= xpForLevel(lvl)) lvl++;
  return lvl;
}

/** Which monsters can appear at a given distance from town. */
export function monstersForDistance(d) {
  return MONSTERS.filter((m) => d >= m.zone[0] && d <= m.zone[1]);
}

/** Speed multiplier for a hold full of dead sea monster. */
export function haulPenalty(slotsUsed, hold) {
  if (!slotsUsed) return 1;
  return Math.max(0.55, 1 - 0.075 * slotsUsed - 0.02 * Math.max(0, slotsUsed - hold));
}
