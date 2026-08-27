// A stand-in hull. Just enough shape to read as a planing boat from above and
// to give the wake something to be attached to.
//
// The origin sits at the BOW, because that is where the spray arms are born —
// keeping the model and the wake on the same anchor avoids a whole class of
// "why is the V offset?" confusion.

import * as THREE from 'three';
import { get } from './params.js';

export function makeBoat() {
  const group = new THREE.Group();

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);                       // bow point
  shape.bezierCurveTo(0.16, -0.10, 0.42, -0.30, 0.50, -0.55);
  shape.lineTo(0.46, -1.0);                 // transom corner
  shape.lineTo(-0.46, -1.0);
  shape.lineTo(-0.50, -0.55);
  shape.bezierCurveTo(-0.42, -0.30, -0.16, -0.10, 0, 0);

  const hull = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  hull.rotateX(Math.PI / 2);                // shape XY -> world XZ
  hull.translate(0, 0.55, 0);               // sit the deck above the waterline

  const body = new THREE.Mesh(hull, new THREE.MeshStandardMaterial({
    color: 0xe8ecef, roughness: 0.45, metalness: 0.05,
  }));

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.6 }),
  );
  cabin.position.set(0, 0.95, -0.52);

  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.22, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x0d1116, roughness: 0.2, metalness: 0.4 }),
  );
  screen.position.set(0, 1.0, -0.27);

  group.add(body, cabin, screen);
  group.userData.scaleTo = () => {
    const L = get('boat.length'), B = get('boat.beam');
    // Shape is 1 long (bow at z=0, transom at z=-1) and 1 wide.
    group.scale.set(B, Math.min(B, L * 0.34), L);
  };
  group.userData.scaleTo();
  return group;
}
