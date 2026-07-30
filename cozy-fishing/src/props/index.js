// Set dressing: spawns every placeholder, places it, wires effects
// (smoke, water-glow streaks), and hands the runtime APIs back to main.

import * as THREE from 'three';
import { spawn } from './registry.js';
import './dock.js';
import './hut.js';
import './boat.js';
import './fisher.js';
import './background.js';
import { DECK_Y } from './dock.js';

const HUT_POS = [-6.4, 0, -9.6];
const HUT_ROT_Y = 0.22;
const BOAT = { pos: [5.0, 0.5, -11.6], rotY: 0.62, tie: [1.72, 1.3, -11.9] };
const FISHER_POS = [0.55, DECK_Y, -11.9];

export function buildSet(scene, fx) {
  const set = new THREE.Group();
  set.name = 'set';

  const dock = spawn('dock');
  const hut = spawn('hut');
  hut.position.set(...HUT_POS);
  hut.rotation.y = HUT_ROT_Y;
  const boat = spawn('boat', BOAT);
  const fisher = spawn('fisher');
  fisher.position.set(...FISHER_POS);
  const background = spawn('background');

  const pieces = [dock, hut, boat, fisher, background];
  set.add(...pieces);
  scene.add(set);
  set.updateMatrixWorld(true);

  // Wire the glow streaks (anchors are local to each piece) and the smoke.
  for (const piece of pieces) {
    for (const a of piece.userData.glowAnchors ?? []) {
      fx.addStreak({ ...a, x: a.x + piece.position.x, z: a.z + piece.position.z });
    }
    if (piece.userData.smokeAnchor) {
      const p = piece.userData.smokeAnchor.clone().add(piece.position);
      fx.addSmoke(p.x, p.y, p.z);
    }
  }

  const updatables = pieces.map((p) => p.userData.api?.update).filter(Boolean);
  return {
    set,
    fisher: fisher.userData.api,
    update(dt, t) { for (const u of updatables) u(dt, t); },
  };
}
