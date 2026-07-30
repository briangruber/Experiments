// Golden hour: one low warm sun (backlight, casts the long shadows),
// a warm hemisphere bounce, and a soft peach fill from behind the camera
// so the dock's near faces don't fall to black.

import * as THREE from 'three';
import { PALETTE, FOG } from '../config.js';
import { SUN } from '../shaders/chunks.js';

export function createLighting(scene) {
  scene.fog = new THREE.Fog(PALETTE.fog, FOG.near, FOG.far);

  const hemi = new THREE.HemisphereLight(0xffc9a0, 0x27404f, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffb070, 2.6);
  // Visually the sun sits at SUN (very low); the shadow light is lifted a
  // little so the shadow map stays sane. Nobody can tell at dusk.
  sun.position.copy(SUN).multiplyScalar(150);
  sun.position.y = 32;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -24; cam.right = 24; cam.top = 26; cam.bottom = -12;
  cam.near = 60; cam.far = 260;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xffb490, 0.55);
  fill.position.set(6, 10, 26);
  scene.add(fill);

  return { sun, hemi, fill };
}
