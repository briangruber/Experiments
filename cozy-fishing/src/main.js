// Dockside — a cozy fishing prototype.
// Bootstraps the stage, the set, and the two systems (fishing, feedback),
// then runs one gentle loop.

import * as THREE from 'three';
import { createStage } from './core/stage.js';
import { createLighting } from './scene/lighting.js';
import { createSky } from './scene/sky.js';
import { createWater } from './scene/water.js';
import { createEffects } from './scene/effects.js';
import { buildSet } from './props/index.js';
import { createFishing } from './systems/fishing.js';
import { createFeedback } from './systems/feedback.js';
import { createAudio } from './systems/audio.js';

const stage = createStage(document.getElementById('scene'));
const { scene, camera } = stage;

createLighting(scene);
createSky(scene);
const water = createWater(scene);
const fx = createEffects(scene, water.heightAt);
const set = buildSet(scene, fx);

const ui = createFeedback();
const audio = createAudio();
ui.onMute(() => audio.toggle());

const fishing = createFishing({
  scene, camera, fisher: set.fisher, water, fx, ui, audio,
});

const clock = new THREE.Clock();
let t = 0;
stage.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  stage.update(dt, t);
  water.update(dt, t);
  fx.update(dt, t);
  set.update(dt, t);
  fishing.update(dt, t);
  stage.render();
  window.__frames = (window.__frames || 0) + 1;
});

setTimeout(() => {
  ui.toast('Evening settles over the harbor.', 'click the water to cast a line');
}, 900);
