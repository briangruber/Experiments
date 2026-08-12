// Shop geometry and game tuning, in one place so the scene, the customers and
// the rules can't drift apart.

// ---------------------------------------------------------------- room
// The camera looks down the +z axis from the shopkeeper's side. The counter
// runs left-to-right across the foreground; customers stand behind it, and the
// shop floor and front door recede into -z.
export const ROOM = {
  width: 13.6,
  depth: 12,
  height: 5.2,
  zFront: 5.0, // behind the camera-side counter
  zBack: -7.0, // the back wall, with the door in it
};

export const COUNTER = {
  z: 3.1,
  top: 0.94,
  width: 10.4,
  depth: 1.5,
};

// Where the served customer stands, and the spots behind them in the queue.
// The line curves back into the shop rather than stacking straight back, so
// five rabbits read as a queue instead of one rabbit with depth. QUEUE[0] is
// the service position — whoever stands there is the customer being served.
export const QUEUE = [
  { x: 2.9, z: 1.45 },
  { x: 3.5, z: -0.7 },
  { x: 3.2, z: -2.7 },
  { x: 2.1, z: -4.3 },
  { x: 0.5, z: -5.2 },
];

export const DOOR = { x: -4.6, z: ROOM.zBack + 0.06 };
export const OUTSIDE = { x: -4.6, z: ROOM.zBack - 2.5 };

// Shelves along the back and left of the shop, with the loitering spots that
// belong to each one. Browsing is pure theatre, but it is most of the charm.
export const SHELVES = [
  { pos: { x: -5.2, z: -5.9 }, ry: 0, browse: { x: -5.2, z: -4.4 } },
  { pos: { x: -1.4, z: -5.9 }, ry: 0, browse: { x: -1.4, z: -4.4 } },
  { pos: { x: 2.4, z: -5.9 }, ry: 0, browse: { x: 2.4, z: -4.4 } },
  { pos: { x: -6.9, z: -2.4 }, ry: Math.PI / 2, browse: { x: -5.4, z: -2.4 } },
  { pos: { x: -6.9, z: 0.6 }, ry: Math.PI / 2, browse: { x: -5.4, z: 0.6 } },
];

// ---------------------------------------------------------------- stock
// Order matters: it is the left-to-right order of the crates on the counter,
// and the number keys 1-6 select them.
export const STOCK = [
  { id: 'carrot', label: 'Carrot', plural: 'Carrots', emoji: '🥕', tint: 0xff9a3c },
  { id: 'cabbage', label: 'Cabbage', plural: 'Cabbages', emoji: '🥬', tint: 0x8fd06a },
  { id: 'strawberry', label: 'Strawberry', plural: 'Strawberries', emoji: '🍓', tint: 0xff5f6d },
  { id: 'corn', label: 'Corn', plural: 'Corn', emoji: '🌽', tint: 0xffd45e },
  { id: 'radish', label: 'Radish', plural: 'Radishes', emoji: '🔴', tint: 0xff6b8a },
  { id: 'muffin', label: 'Muffin', plural: 'Muffins', emoji: '🧁', tint: 0xc79bff },
];

export const STOCK_BY_ID = Object.fromEntries(STOCK.map((s) => [s.id, s]));

// Crates sit on the counter top, evenly spaced across the left of it. The bag
// and the bell live on the right, next to whoever is being served.
export const CRATE_X = STOCK.map((_, i) => -4.6 + i * 1.2);
export const BAG = { x: 2.05, y: COUNTER.top, z: COUNTER.z - 0.15 };
export const BELL = { x: 4.2, y: COUNTER.top, z: COUNTER.z - 0.1 };

// ---------------------------------------------------------------- rules
export const RULES = {
  dayLength: 105, // seconds of trading per day
  maxQueue: QUEUE.length,
  startHearts: 3,
  maxHearts: 5, // a flawless inspection can buy one back

  // Patience only burns while a customer is actually at the counter waiting to
  // be served — browsing and queueing are free, so the shop stays relaxed.
  patienceBase: 30,
  patiencePerItem: 5.5,
  patienceDayFalloff: 0.93, // multiplier per day

  spawnGapStart: [3.2, 5.4],
  spawnGapFloor: [1.5, 2.6],
  spawnDayFalloff: 0.9,

  petBoost: 7, // seconds of patience returned by one pet
  wrongItemPenalty: 4.5, // seconds burned for bagging the wrong thing

  coinPerItem: 3,
  tipMax: 12, // full tip for a fast, flawless order
  speedTipWindow: 0.55, // fraction of patience left that still earns a full tip
  streakTipStep: 0.12, // extra tip per flawless order in a row
  streakTipCap: 1.2, // ...up to this much again on top
};

// How many distinct items and how many of each, as the days get busier.
export function orderShape(day) {
  const kinds = Math.min(4, 1 + Math.floor((day - 1) / 2 + Math.random() * 1.4));
  const most = Math.min(4, 1 + Math.floor(Math.random() * (1 + day * 0.5)));
  return { kinds, most: Math.max(1, most) };
}
