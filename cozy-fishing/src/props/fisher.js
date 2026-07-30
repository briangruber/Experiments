// The fisher: a rounded little figure in a beanie, sitting on the dock's end
// with legs dangling, holding the rod. Built facing -z at its own origin
// (seat level); placement in props/index.js.
//
// Runtime API (group.userData.api):
//   rodTip           Object3D at the rod's tip (line attaches here)
//   playCast(onRelease)  wind up, whip, call onRelease at the whip moment
//   setBite(bool)    bend the rod while a fish tugs
//   update(dt, t)

import * as THREE from 'three';
import { definePlaceholder } from './registry.js';
import { matte, sph, cyl, limb } from './parts.js';
import { clamp } from '../core/utils.js';

const SWEATER = 0x37536e;
const SKIN = 0xe8b48e;
const BEANIE = 0x5d8a52;
const PANTS = 0x4a3f3a;
const BOOTS = 0x2e2a28;

definePlaceholder('fisher', () => {
  const g = new THREE.Group();

  // Torso leans as one piece during the cast.
  const torso = new THREE.Group();
  g.add(torso);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.42, 4, 10), matte(SWEATER));
  body.position.y = 0.55;
  body.scale.z = 0.85;
  body.castShadow = true;
  torso.add(body);

  const head = sph(0.23, matte(SKIN), 12, 9);
  head.position.y = 1.12;
  torso.add(head);

  const beanie = sph(0.245, matte(BEANIE), 10, 7);
  beanie.position.y = 1.2;
  beanie.scale.y = 0.75;
  torso.add(beanie);
  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.05, 6, 14), matte(BEANIE));
  brim.rotation.x = Math.PI / 2;
  brim.position.y = 1.12;
  torso.add(brim);
  const pompom = sph(0.075, matte(0xd8cfc0), 7, 5);
  pompom.position.y = 1.4;
  torso.add(pompom);

  // Arms reach forward to the rod grip.
  torso.add(limb([0.3, 0.78, -0.02], [0.34, 0.55, -0.42], 0.085, matte(SWEATER)));
  torso.add(limb([-0.3, 0.78, -0.02], [-0.08, 0.52, -0.34], 0.085, matte(SWEATER)));
  const handR = sph(0.095, matte(SKIN), 7, 5);
  handR.position.set(0.34, 0.53, -0.46);
  torso.add(handR);
  const handL = sph(0.09, matte(SKIN), 7, 5);
  handL.position.set(-0.07, 0.5, -0.38);
  torso.add(handL);

  // Legs dangle over the edge.
  for (const s of [-1, 1]) {
    g.add(limb([s * 0.15, 0.28, -0.1], [s * 0.17, 0.1, -0.5], 0.105, matte(PANTS)));
    g.add(limb([s * 0.17, 0.1, -0.5], [s * 0.18, -0.38, -0.46], 0.085, matte(PANTS)));
    const boot = sph(0.11, matte(BOOTS), 7, 5);
    boot.position.set(s * 0.18, -0.44, -0.52);
    boot.scale.set(1, 0.75, 1.45);
    g.add(boot);
  }

  // Rod, hinged at the right hand.
  const rodGroup = new THREE.Group();
  rodGroup.position.copy(handR.position);
  torso.add(rodGroup);

  const rodGeo = new THREE.CylinderGeometry(0.012, 0.032, 2.5, 6)
    .rotateX(-Math.PI / 2)   // lie along -z
    .translate(0, 0, -1.05); // grip near the hand
  const rod = new THREE.Mesh(rodGeo, matte(0x5a4030));
  rod.castShadow = true;
  rodGroup.add(rod);
  const reel = cyl(0.055, 0.055, 0.05, 8, matte(0x8a6a3a));
  reel.rotation.z = Math.PI / 2;
  reel.position.set(0, -0.09, -0.35);
  rodGroup.add(reel);
  const rodTip = new THREE.Object3D();
  rodTip.position.set(0, 0, -2.28);
  rodGroup.add(rodTip);

  const REST = 0.78;              // resting pitch: tip up, out over the water
  rodGroup.rotation.x = REST;

  let cast = null;                // { t, onRelease, released }
  let biteBend = 0, biteTarget = 0;

  g.userData.api = {
    rodTip,
    playCast(onRelease) { cast = { t: 0, onRelease, released: false }; },
    setBite(on) { biteTarget = on ? 1 : 0; },
    update(dt, t) {
      // Breathing + a slow glance around.
      torso.scale.y = 1 + Math.sin(t * 1.6) * 0.013;
      head.rotation.y = beanie.rotation.y = Math.sin(t * 0.23) * 0.22;

      biteBend = clamp(biteBend + (biteTarget - biteBend) * dt * 10, 0, 1);

      let rodAngle = REST;
      let lean = 0;
      if (cast) {
        cast.t += dt;
        const k = cast.t;
        // Release is time-based, never skippable by a slow frame.
        if (!cast.released && k >= 0.36) {
          cast.released = true;
          cast.onRelease?.();
        }
        if (k < 0.24) {                       // wind up
          const u = k / 0.24;
          rodAngle = REST + u * 0.7;
          lean = u * 0.1;
        } else if (k < 0.38) {                // whip forward
          const u = (k - 0.24) / 0.14;
          rodAngle = REST + 0.7 - u * 1.0;
          lean = 0.1 - u * 0.16;
        } else if (k < 1.1) {                 // settle back
          const u = (k - 0.38) / 0.72;
          rodAngle = REST - 0.3 + u * 0.3;
          lean = -0.06 + u * 0.06;
        } else {
          cast = null;
        }
      }
      rodGroup.rotation.x = rodAngle - biteBend * (0.22 + Math.sin(t * 24) * 0.03);
      torso.rotation.x = lean + Math.sin(t * 1.6) * 0.008;
    },
  };
  return g;
});
