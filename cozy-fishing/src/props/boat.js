// A little rowboat, cream hull with a cedar gunwale, tied to a dock piling
// and bobbing on the shared wave field.
// opts: { pos: [x,y,z], rotY, tie: [x,y,z] world point of the piling top }

import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { definePlaceholder } from './registry.js';
import { matte, box, rope, contactShadow } from './parts.js';
import { waveHeight } from '../shaders/chunks.js';

definePlaceholder('boat', ({ pos = [4.5, 0.42, -9.9], rotY = 0.5, tie } = {}) => {
  const g = new THREE.Group();

  // The bobbing part.
  const bob = new THREE.Group();
  bob.position.set(...pos);
  bob.rotation.y = rotY;
  g.add(bob);

  const hullMat = matte(PALETTE.paint.hull);
  const hull = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    hullMat
  );
  hull.scale.set(2.35, 0.95, 1.1);
  hull.castShadow = true;
  bob.add(hull);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.09, 6, 22).rotateX(Math.PI / 2), matte(PALETTE.wood.mid)
  );
  rim.scale.set(2.35, 1, 1.1);
  rim.castShadow = true;
  bob.add(rim);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(0.96, 20).rotateX(-Math.PI / 2), matte(0x3c2f26)
  );
  floor.scale.set(2.35, 1, 1.1);
  floor.position.y = -0.35;
  bob.add(floor);

  for (const x of [-0.8, 0.75]) {
    const bench = box(0.5, 0.08, Math.sqrt(1 - (x / 2.35) ** 2) * 2.05, matte(PALETTE.wood.light));
    bench.position.set(x, -0.05, 0);
    bob.add(bench);
  }

  // An oar laid across the rims.
  const oar = new THREE.Group();
  const shaft = box(2.1, 0.055, 0.055, matte(PALETTE.wood.light));
  oar.add(shaft);
  const blade = box(0.5, 0.03, 0.2, matte(PALETTE.wood.mid));
  blade.position.x = 1.25;
  oar.add(blade);
  oar.position.set(0.1, 0.12, 0.1);
  oar.rotation.y = Math.PI / 2 - 0.25;   // laid across the beam
  oar.children.forEach((c) => { c.castShadow = true; });
  bob.add(oar);

  // Mooring rope from the bow (local -x) back to the piling. Static — the
  // boat only drifts a few centimetres around it.
  if (tie) {
    g.updateMatrixWorld();
    const bowWorld = bob.localToWorld(new THREE.Vector3(-2.15, 0.28, 0));
    g.add(rope(
      [tie, [bowWorld.x, bowWorld.y, bowWorld.z]], 0.04, matte(PALETTE.wood.rope), 0.5
    ));
  }

  const shadow = contactShadow(2.9, 1.7, 0.16);
  shadow.position.set(pos[0], 0.27, pos[2]);
  shadow.rotation.y = rotY;
  g.add(shadow);

  const baseY = pos[1];
  g.userData.api = {
    update(dt, t) {
      const h = waveHeight(pos[0], pos[2], t);
      const hBow = waveHeight(pos[0] - 2 * Math.cos(rotY), pos[2] + 2 * Math.sin(rotY), t);
      bob.position.y = baseY + h * 0.8;
      bob.rotation.z = (hBow - h) * 0.35 + Math.sin(t * 0.7) * 0.015;
      bob.rotation.x = Math.sin(t * 0.53 + 1.2) * 0.02;
    },
  };
  return g;
});
