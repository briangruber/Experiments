// The wooden dock: planks with a little hand-laid jitter, pilings with wet
// waterline bands, sagging rope rails, a lantern post, and clutter.
// Runs down the z axis from z=+6 (under the camera) to z=-12.4 (the end).
// Deck surface sits at y = 1.0.

import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { rand, pick } from '../core/utils.js';
import { definePlaceholder } from './registry.js';
import { matte, glow, box, cyl, sph, rope, contactShadow } from './parts.js';

export const DECK_Y = 1.0;
export const DOCK_HALF_W = 1.6;
export const DOCK_END_Z = -12.4;

definePlaceholder('dock', () => {
  const g = new THREE.Group();
  const wood = PALETTE.wood;
  const plankMats = [matte(wood.light), matte(wood.mid), matte(0xa56b40)];

  // Planks.
  for (let z = 6; z > DOCK_END_Z; z -= 0.58) {
    const p = box(DOCK_HALF_W * 2, 0.12, 0.5, pick(plankMats));
    p.position.set(rand(-0.02, 0.02), DECK_Y - 0.06 + rand(-0.012, 0.012), z);
    p.rotation.y = rand(-0.015, 0.015);
    g.add(p);
  }
  // End cap plank.
  const cap = box(DOCK_HALF_W * 2 + 0.2, 0.14, 0.24, matte(wood.dark));
  cap.position.set(0, DECK_Y - 0.05, DOCK_END_Z + 0.05);
  g.add(cap);

  // Pilings + wet band, both sides; remember tops for the rope rails.
  const postTops = { left: [], right: [] };
  for (let z = 5.5; z > DOCK_END_Z; z -= 2.9) {
    for (const side of [-1, 1]) {
      const x = side * (DOCK_HALF_W + 0.12);
      const post = cyl(0.15, 0.17, 3.0, 8, matte(wood.mid));
      post.position.set(x + rand(-0.03, 0.03), -0.2, z + rand(-0.05, 0.05));
      post.rotation.z = rand(-0.02, 0.02) * side;
      g.add(post);
      const capSph = sph(0.16, matte(wood.dark), 8, 6);
      capSph.position.set(post.position.x, 1.32, post.position.z);
      g.add(capSph);
      const wet = cyl(0.165, 0.175, 0.5, 8, matte(0x4a3a2e));
      wet.position.set(post.position.x, 0.12, post.position.z);
      g.add(wet);
      postTops[side < 0 ? 'left' : 'right'].push([post.position.x, 1.3, post.position.z]);
    }
  }
  const ropeMat = matte(PALETTE.wood.rope);
  g.add(rope(postTops.left, 0.035, ropeMat, 0.22));
  g.add(rope(postTops.right, 0.035, ropeMat, 0.22));

  // Lantern post at the end, hanging its lamp out over the water.
  const lantern = new THREE.Group();
  lantern.position.set(1.45, DECK_Y, -11.5);
  const pole = cyl(0.05, 0.06, 1.75, 7, matte(wood.dark));
  pole.position.y = 0.85;
  lantern.add(pole);
  const arm = box(0.62, 0.06, 0.06, matte(wood.dark));
  arm.position.set(0.26, 1.7, 0);
  lantern.add(arm);
  const cage = cyl(0.16, 0.13, 0.1, 6, matte(0x3a2c22));
  cage.position.set(0.5, 1.62, 0);
  lantern.add(cage);
  const bulb = sph(0.105, glow(PALETTE.lantern, 3.2), 8, 6, false);
  bulb.position.set(0.5, 1.52, 0);
  lantern.add(bulb);
  const light = new THREE.PointLight(0xffb060, 5, 10, 2);
  light.position.set(0.5, 1.5, 0);
  lantern.add(light);
  g.add(lantern);

  // Clutter: crate, bucket, coiled rope.
  const crate = box(0.66, 0.5, 0.66, matte(wood.mid));
  crate.position.set(-1.0, DECK_Y + 0.25, -10.3);
  crate.rotation.y = 0.3;
  g.add(crate);
  const lid = box(0.7, 0.06, 0.7, matte(wood.dark));
  lid.position.set(-1.0, DECK_Y + 0.52, -10.3);
  lid.rotation.y = 0.3;
  g.add(lid);
  const bucket = cyl(0.2, 0.15, 0.34, 9, matte(PALETTE.paint.trim));
  bucket.position.set(-1.14, DECK_Y + 0.17, -9.55);
  g.add(bucket);
  for (let i = 0; i < 2; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.26 - i * 0.03, 0.06, 6, 14), ropeMat);
    coil.rotation.x = -Math.PI / 2;
    coil.position.set(1.05, DECK_Y + 0.05 + i * 0.09, -6.4);
    coil.castShadow = true;
    g.add(coil);
  }

  // Grounding shadow on the water along the dock's length.
  const shadow = contactShadow(2.6, 10.5, 0.12);
  shadow.position.set(0, 0.26, -3.4);
  g.add(shadow);

  // Streak from the lantern onto the water beside the dock.
  g.userData.glowAnchors = [{ x: 1.95, z: -11.5, color: PALETTE.lantern, w: 0.5, len: 5 }];

  g.userData.api = {
    update(dt, t) {
      light.intensity = 5 * (1 + 0.07 * Math.sin(t * 13.7) + 0.05 * Math.sin(t * 7.3));
      bulb.material.emissiveIntensity = 3.2 + 0.3 * Math.sin(t * 11.3);
    },
  };
  return g;
});
