// The company. Same rig, five silhouettes — in a wordless piece the audience
// has to tell them apart in one frame, in the dark, during lightning.
//
// Each character lives in a file of their own next to this one: a spec for the
// rig, and a wardrobe function that dresses it (shared pieces come from
// wardrobe.js). This file only assembles them, in billing order.

import * as THREE from '../../vendor/three/three.module.min.js';
import { makeChicken } from '../../engine/chicken.js';
import { Actor } from '../../engine/acting.js';
import { TAU, deg } from '../../engine/util.js';
import { spec as rosalinda, wardrobe as dressRosalinda } from './rosalinda.js';
import { spec as esteban, wardrobe as dressEsteban } from './esteban.js';
import { spec as valentina, wardrobe as dressValentina } from './valentina.js';
import { spec as donGallo, wardrobe as dressDonGallo } from './don-gallo.js';
import { spec as ricardo, wardrobe as dressRicardo } from './ricardo.js';
import { spec as pollito } from './pollito.js';

export const CAST_SPECS = { rosalinda, esteban, valentina, donGallo, ricardo, pollito };

// Wardrobe. Anchored to the head group so it inherits every flinch. Pollito
// has no entry, which is why buildCast dresses optionally.
const WARDROBE = {
  rosalinda: dressRosalinda,
  esteban: dressEsteban,
  valentina: dressValentina,
  donGallo: dressDonGallo,
  ricardo: dressRicardo,
};

export function buildCast(scene) {
  const actors = {};
  for (const key of Object.keys(CAST_SPECS)) {
    const rig = makeChicken(CAST_SPECS[key]);
    WARDROBE[key]?.(rig);
    scene.add(rig.root);
    const a = new Actor(rig);
    a.key = key;
    a.role = CAST_SPECS[key].role;
    actors[key] = a;
  }
  return actors;
}

// --- the prop that drives the plot -----------------------------------------

export function makeEgg(size = 1) {
  const g = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xf4e4c8, roughness: 0.55, metalness: 0.02 });
  const geo = new THREE.SphereGeometry(0.055 * size, 20, 16);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y / (0.055 * size)) * 0.5 + 0.5;
    const s = 1 - 0.22 * Math.pow(t, 2.2);       // taper the top into an egg
    pos.setXYZ(i, pos.getX(i) * s, y * 1.32, pos.getZ(i) * s);
  }
  geo.computeVertexNormals();
  const shell = new THREE.Mesh(geo, shellMat);
  shell.castShadow = shell.receiveShadow = true;
  g.add(shell);

  // The crack: two thin dark slabs that scale in when the secret gets out.
  const crackMat = new THREE.MeshStandardMaterial({ color: 0x2a1d12, roughness: 0.9 });
  const cracks = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.004 * size, 0.02 * size, 0.004 * size), crackMat);
    const a = (i / 5) * TAU;
    c.position.set(Math.cos(a) * 0.05 * size, 0.01 * size + (i % 2) * 0.02 * size, Math.sin(a) * 0.05 * size);
    c.rotation.set(0, -a, deg(18 * (i % 2 ? 1 : -1)));
    cracks.add(c);
  }
  cracks.scale.setScalar(0.001);
  g.add(cracks);
  g.userData.cracks = cracks;
  g.userData.shell = shell;
  return g;
}
