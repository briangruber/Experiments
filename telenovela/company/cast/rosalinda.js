// Rosalinda, la inocente. Pale plumage that reads in the dark, a pink flower
// over one ear, and lashes.

import { deg } from '../../engine/util.js';
import { flower, lashes } from './wardrobe.js';

export const spec = {
  name: 'Rosalinda', role: 'la inocente',
  plumage: 0xf2ebdd, accent: 0xfffaf0, comb: 0xdf6079, beak: 0xe8b95f, legs: 0xe0a95a,
  iris: 0xd9a44e, eyeRing: 0xc48a72, size: 1.0, breast: 1.05, rump: 0.9, seed: 3,
};

export function wardrobe(rig) {
  const f = flower(0xe86a8c, 6, 0.03 * rig.size);
  f.position.set(-0.055 * rig.size, 0.055 * rig.size, -0.005 * rig.size);
  f.rotation.set(deg(20), 0, deg(-38));
  rig.propAnchor.add(f);
  for (const e of rig.eyes) e.group.add(lashes(rig.size, 0x4a3320));
}
