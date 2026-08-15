// Don Gallo, el patrón. The biggest bird on the call sheet, a monocle and a
// hat — old money, old grievances.

import { deg } from '../../engine/util.js';
import { monocle, hat } from './wardrobe.js';

export const spec = {
  name: 'Don Gallo', role: 'el patrón',
  plumage: 0x6c6974, accent: 0x9b98a2, comb: 0x9c2b34, beak: 0xc9b27a, legs: 0xb09a63,
  iris: 0xd8c47a, eyeRing: 0x8d8a93, size: 1.32, rooster: true, breast: 1.12, rump: 1.0, sickle: 0x3a3742, seed: 41,
};

export function wardrobe(rig) {
  const m = monocle(rig.size);
  m.position.set(0.062 * rig.size, 0.028 * rig.size, 0.046 * rig.size);
  m.rotation.y = deg(46);
  rig.propAnchor.add(m);
  const h = hat(rig.size, 0x4a3b32);
  h.position.set(0, 0.085 * rig.size, -0.012 * rig.size);
  h.rotation.z = deg(-5);
  rig.propAnchor.add(h);
}
