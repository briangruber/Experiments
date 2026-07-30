// The fisher's hut on stilts, left of the dock, with a glowing round window,
// a teal gable roof, and a lazy thread of chimney smoke.
// Built around its own origin (platform center, water level y=0);
// placement happens in props/index.js. Local +x points toward the dock.

import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { definePlaceholder } from './registry.js';
import { matte, glow, box, cyl, prism, sph, contactShadow } from './parts.js';

definePlaceholder('hut', () => {
  const g = new THREE.Group();
  const wood = PALETTE.wood;

  // Stilts + platform.
  for (const [x, z] of [[-1.9, -1.5], [1.9, -1.5], [-1.9, 1.5], [1.9, 1.5]]) {
    const s = cyl(0.13, 0.15, 2.6, 7, matte(wood.dark));
    s.position.set(x, -0.3, z);
    g.add(s);
  }
  const platform = box(4.6, 0.16, 3.9, matte(wood.mid));
  platform.position.y = 0.92;
  g.add(platform);

  // Walkway planks joining the dock (dock edge is ~4.4 local x away).
  for (let i = 0; i < 5; i++) {
    const p = box(0.5, 0.1, 1.1, matte(i % 2 ? wood.light : wood.mid));
    p.position.set(2.55 + i * 0.52, 0.95, 0.2);
    p.rotation.y = (i % 2 ? 1 : -1) * 0.02;
    g.add(p);
  }

  // Walls, door (facing the dock), windows.
  const walls = box(3.2, 2.2, 2.8, matte(0xa06844));
  walls.position.y = 2.1;
  g.add(walls);

  const door = box(0.1, 1.4, 0.78, matte(wood.dark));
  door.position.set(1.62, 1.72, 0.55);
  g.add(door);
  const knob = sph(0.045, matte(0xd8b060), 6, 5, false);
  knob.position.set(1.7, 1.7, 0.28);
  g.add(knob);

  // Round window on the camera-facing wall — the cozy glow.
  const winZ = 1.41;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.055, 6, 16), matte(wood.dark));
  rim.position.set(0.55, 2.35, winZ);
  g.add(rim);
  const pane = new THREE.Mesh(
    new THREE.CircleGeometry(0.32, 16), glow(PALETTE.glowWindow, 2.2)
  );
  pane.position.set(0.55, 2.35, winZ + 0.001);
  g.add(pane);
  const winLight = new THREE.PointLight(0xffbe78, 3, 8, 2);
  winLight.position.set(0.55, 2.3, winZ + 0.4);
  g.add(winLight);

  // Small square window by the door.
  const pane2 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.4), glow(PALETTE.glowWindow, 1.8));
  pane2.position.set(1.61, 2.5, -0.5);
  pane2.rotation.y = Math.PI / 2;
  g.add(pane2);

  // Roof: gable ridge running x (so the triangle faces the dock), overhung.
  const roof = prism(3.4, 1.5, 4.0, matte(PALETTE.paint.roof));
  roof.rotation.y = Math.PI / 2;
  roof.position.y = 3.18;
  g.add(roof);
  const ridge = box(4.1, 0.1, 0.16, matte(wood.dark));
  ridge.position.y = 4.7;
  g.add(ridge);

  // Chimney; smoke is attached by props/index.js via effects.addSmoke.
  const chimney = box(0.34, 0.95, 0.34, matte(0x6b5044));
  chimney.position.set(-0.85, 4.35, -0.6);
  g.add(chimney);
  const chimCap = box(0.44, 0.08, 0.44, matte(wood.dark));
  chimCap.position.set(-0.85, 4.85, -0.6);
  g.add(chimCap);
  g.userData.smokeAnchor = new THREE.Vector3(-0.85, 4.95, -0.6);

  const shadow = contactShadow(2.9, 2.4, 0.13);
  shadow.position.y = 0.27;
  g.add(shadow);

  // Window glow smearing on the water (local coords; index.js offsets them).
  g.userData.glowAnchors = [
    { x: 0.55, z: 2.0, color: PALETTE.glowWindow, w: 0.55, len: 5.5 },
  ];

  return g;
});
