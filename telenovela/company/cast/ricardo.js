// Ricardo, el gemelo. The SAME bird as Esteban — literally: on the Tripo cast
// he is Esteban's skinned scene reused wholesale, which is the twist made
// flesh. What separates them is palette and wardrobe: where Esteban is copper
// in a red neckerchief, Ricardo is the blue/charcoal recolor (the offline
// remap tools/retexture-cast.mjs bakes into ricardo-body.jpg) with the same
// neckerchief in black, an eyepatch, and a scar — as close as a chicken gets
// to a past. The procedural spec below matches that palette so the fallback
// body and the acting-face overlay (skull shell, lids) sit on the same colour.

import * as THREE from '../../vendor/three/three.module.min.js';
import { deg } from '../../engine/util.js';
import { eyepatch, neckerchief } from './wardrobe.js';

export const spec = {
  name: 'Ricardo', role: 'el gemelo',
  plumage: 0x46536b, accent: 0x5c6c88, comb: 0xd2333c, beak: 0xdcb057, legs: 0xd6a04c,
  iris: 0xe0a437, eyeRing: 0x2e3648, size: 1.14, rooster: true, sheen: true, sickle: 0x141d2e, breast: 1.06, seed: 11,
};

function scarMesh(size) {
  const scar = new THREE.Mesh(
    new THREE.BoxGeometry(0.006 * size, 0.05 * size, 0.02 * size),
    new THREE.MeshStandardMaterial({ color: 0x6b2a2a, roughness: 0.6 }),
  );
  scar.rotation.z = deg(28);
  return scar;
}

export function wardrobe(rig) {
  const p = eyepatch(rig.size);
  p.position.set(-0.062 * rig.size, 0.028 * rig.size, 0.044 * rig.size);
  p.rotation.y = deg(-46);
  rig.propAnchor.add(p);
  // A scar across the comb, which is as close as a chicken gets to a past.
  const scar = scarMesh(rig.size);
  scar.position.set(0.05 * rig.size, 0.03 * rig.size, 0.03 * rig.size);
  rig.propAnchor.add(scar);
  // The same neckerchief as his brother, in black.
  neckerchief(rig, 0x141118);
}

// The same wardrobe on the Tripo body: the acting-face overlay is built at
// rig.faceSize, so the patch covers the overlay's left eye (which sits at
// ±0.055 · faceSize · eyeSpread) and the scar rides the skull shell.
export function dressBoneRig(rig) {
  const fs = rig.faceSize;
  // The overlay's left eye sits at (-0.055·eyeSpread, 0.028, 0.036)·fs,
  // angled 46° outward; the patch lies just past the ball's outer surface
  // along that same normal, or it drowns inside the eye.
  const p = eyepatch(fs);
  p.position.set(-0.075 * fs, 0.028 * fs, 0.059 * fs);
  p.rotation.y = deg(-46);
  rig.faceRoot.add(p);
  const scar = scarMesh(fs);
  scar.position.set(0.055 * fs, 0.045 * fs, 0.05 * fs);
  rig.faceRoot.add(scar);
}
