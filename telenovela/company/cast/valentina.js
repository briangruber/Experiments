// Valentina, la villana. Near-black plumage, a blood-red flower, a mantilla,
// and the same lashes as the ingénue — darker.

import { deg } from '../../engine/util.js';
import { flower, shawl, lashes } from './wardrobe.js';

export const spec = {
  name: 'Valentina', role: 'la villana',
  plumage: 0x2b2331, accent: 0x4b3452, comb: 0xb52436, beak: 0x4a3d3a, legs: 0x8a6a52,
  iris: 0xe06a44, eyeRing: 0x7d5a66, size: 1.02, breast: 0.97, rump: 0.95, seed: 23,
};

export function wardrobe(rig) {
  const f = flower(0x9c1728, 5, 0.034 * rig.size);
  f.position.set(0.06 * rig.size, 0.045 * rig.size, -0.01 * rig.size);
  f.rotation.set(deg(14), 0, deg(46));
  rig.propAnchor.add(f);
  // A black lace mantilla trailing off the back of the skull.
  const v = shawl(rig.size * 0.9, 0x191221);
  v.position.set(0, 0.05 * rig.size, -0.075 * rig.size);
  v.rotation.set(deg(24), 0, 0);
  rig.propAnchor.add(v);
  for (const e of rig.eyes) e.group.add(lashes(rig.size, 0x150e18));
}
