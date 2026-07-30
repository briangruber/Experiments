// The catch table and a placeholder fish. Weights are relative; stars are
// pure ceremony. A real model per species can drop in via buildFish later.

import * as THREE from 'three';
import { matte, sph, cone } from './parts.js';

export const SPECIES = [
  { name: 'an Old Boot', weight: 10, stars: 0, color: 0x6b5a4a,
    flavor: 'the sea keeps its secrets.' },
  { name: 'a Teal Minnow', weight: 30, stars: 1, color: 0x3fa8a0,
    flavor: 'small, quick, extremely smug.' },
  { name: 'a Harbor Perch', weight: 22, stars: 1, color: 0x8fae5e,
    flavor: 'a dockside regular.' },
  { name: 'a Cedar Bass', weight: 14, stars: 2, color: 0xb0703f,
    flavor: 'smells faintly of the sawmill.' },
  { name: 'a Sunset Snapper', weight: 10, stars: 2, color: 0xe8825e,
    flavor: 'it glows like the hour it was named for.' },
  { name: 'a Moonfin Koi', weight: 6, stars: 3, color: 0xcfd8ec,
    flavor: 'pale as lantern-light.' },
  { name: 'a Gilded Koi', weight: 3, stars: 4, color: 0xf2c14e, sparkle: true,
    flavor: 'scales like coins. keep it? always.' },
  { name: 'The Dockfather', weight: 1, stars: 5, color: 0x4a5a8f, sparkle: true,
    flavor: 'so the stories were true.' },
];

export function pickSpecies() {
  let r = Math.random() * SPECIES.reduce((s, f) => s + f.weight, 0);
  for (const f of SPECIES) { if ((r -= f.weight) <= 0) return f; }
  return SPECIES[1];
}

// Little fish, nose toward -x. (The Old Boot also gets a fish placeholder —
// the joke lands in the text.)
export function buildFish(species) {
  const g = new THREE.Group();
  const mat = matte(species.color, species.sparkle
    ? { emissive: species.color, emissiveIntensity: 0.5 } : {});

  const body = sph(0.17, mat, 9, 7, false);
  body.scale.set(1.7, 1, 0.6);
  g.add(body);

  const tail = cone(0.13, 0.24, 4, mat, false);
  tail.rotation.z = -Math.PI / 2;
  tail.position.set(0.36, 0, 0);
  tail.scale.z = 0.45;
  g.add(tail);

  const fin = cone(0.07, 0.16, 4, mat, false);
  fin.position.set(-0.02, 0.17, 0);
  fin.rotation.z = 0.4;
  fin.scale.z = 0.4;
  g.add(fin);

  const eyeMat = matte(0x201812);
  for (const s of [-1, 1]) {
    const eye = sph(0.028, eyeMat, 5, 4, false);
    eye.position.set(-0.2, 0.045, s * 0.095);
    g.add(eye);
  }
  return g;
}
