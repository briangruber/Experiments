// Ricardo, el gemelo. Esteban's colouring exactly — the twist only lands if
// the audience can see they are the same bird; the eyepatch, the scar and the
// black neckerchief are the only things that separate them.

import * as THREE from '../../vendor/three/three.module.min.js';
import { deg } from '../../engine/util.js';
import { eyepatch, neckerchief } from './wardrobe.js';

export const spec = {
  name: 'Ricardo', role: 'el gemelo',
  plumage: 0xb06a35, accent: 0xd99447, comb: 0xd2333c, beak: 0xdcb057, legs: 0xd6a04c,
  iris: 0xe0a437, eyeRing: 0xa06a44, size: 1.14, rooster: true, sheen: true, sickle: 0x16352b, breast: 1.06, seed: 11,
};

export function wardrobe(rig) {
  const p = eyepatch(rig.size);
  p.position.set(-0.062 * rig.size, 0.028 * rig.size, 0.044 * rig.size);
  p.rotation.y = deg(-46);
  rig.propAnchor.add(p);
  // A scar across the comb, which is as close as a chicken gets to a past.
  const scar = new THREE.Mesh(
    new THREE.BoxGeometry(0.006 * rig.size, 0.05 * rig.size, 0.02 * rig.size),
    new THREE.MeshStandardMaterial({ color: 0x6b2a2a, roughness: 0.6 }),
  );
  scar.position.set(0.05 * rig.size, 0.03 * rig.size, 0.03 * rig.size);
  scar.rotation.z = deg(28);
  rig.propAnchor.add(scar);
  // The same neckerchief as his brother, in black.
  neckerchief(rig, 0x141118);
}
