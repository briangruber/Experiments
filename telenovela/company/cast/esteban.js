// Esteban, el galán. A copper rooster with a sheen and a red neckerchief —
// the neckerchief matters, because his twin wears the same one in black.

import { neckerchief } from './wardrobe.js';

export const spec = {
  name: 'Esteban', role: 'el galán',
  plumage: 0xb06a35, accent: 0xd99447, comb: 0xd2333c, beak: 0xdcb057, legs: 0xd6a04c,
  iris: 0xe0a437, eyeRing: 0xa06a44, size: 1.14, rooster: true, sheen: true, sickle: 0x16352b, breast: 1.06, seed: 11,
};

export function wardrobe(rig) { neckerchief(rig, 0xc4342f); }
