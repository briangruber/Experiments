// Salty Fin — wiring, the render passes, the frame loop.
//
// Four passes a frame:
//   1. refraction   what the water sees looking down (seabed, coral, monster)
//   2. reflection   what the water sees looking up   (sky, islands, village)
//   3. beauty       everything, into an HDR target
//   4. post         bloom, tonemap, grade
//
// The reflection pass renders with a mirrored camera. Mirroring flips triangle
// winding, so the projection's X row is negated to flip it back and the water
// shader samples that target with a flipped U. See REFLECT_FLIP_U.

import * as THREE from 'three';
import { createRenderer } from './core/renderer.js';
import { createPost } from './core/post.js';
import { createInput } from './core/input.js';
import { LAYER } from './core/layers.js';
import { createTimeOfDay, PRESET_HOURS } from './world/timeOfDay.js';

import { createSky } from './sky/sky.js';
import { createClouds } from './sky/clouds.js';
import { createCelestial } from './sky/celestial.js';
import { createWater } from './water/surface.js';
import { createSeabed } from './terrain/seabed.js';
import { createCoral } from './terrain/coral.js';
import { createIslands } from './terrain/island.js';
import { createVegetation } from './terrain/vegetation.js';
import { createBoat } from './models/boat.js';
import { createFisher } from './models/fisher.js';
import { createVillage } from './models/village.js';
import { createDock } from './models/dock.js';
import { createLighthouse } from './models/lighthouse.js';
import { createProps } from './models/props.js';
import { createMonster } from './creatures/monster.js';
import { createWildlife } from './creatures/wildlife.js';
import { createBoatController } from './gameplay/boatController.js';
import { createChaseCamera } from './gameplay/chaseCamera.js';
import { createQuest } from './gameplay/quest.js';
import { createHud } from './hud/hud.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
const str = (k, d) => (params.get(k) ?? d);
const flag = (k, d = false) => (params.has(k) ? params.get(k) !== '0' : d);

const SEED = num('seed', 20260807) | 0;
const TIER = str('quality', 'high');
const START_HOUR = params.has('t') ? num('t', 12)
  : (PRESET_HOURS[str('preset', 'day')] ?? 12);
const FIXED_STEP = params.has('step') ? num('step', 1 / 60) : 0;   // deterministic capture
const DAY_RATE = num('rate', 0);        // hours per second; 0 freezes the sky

const canvas = document.getElementById('gl');
const { renderer, quality, targets, setSize, makeTarget } = createRenderer({
  canvas, tier: TIER, pixelRatio: params.has('pr') ? num('pr', 1) : undefined,
});
const gl = renderer.getContext();
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(num('fov', 46), 1, 0.35, 6000);
camera.position.set(0, 8, 16);

const reflectCamera = new THREE.PerspectiveCamera();
reflectCamera.matrixAutoUpdate = false;

const time = createTimeOfDay({ hour: START_HOUR, seed: SEED });
const env = time.env;
time.setRate(DAY_RATE);

const input = createInput(window);
const post = createPost({ renderer, targets, makeTarget });

// --- lights -----------------------------------------------------------------

const keyLight = new THREE.DirectionalLight(0xffffff, 1);
keyLight.castShadow = quality.shadows;
if (quality.shadows) {
  const s = keyLight.shadow;
  s.mapSize.set(quality.shadowSize, quality.shadowSize);
  s.camera.near = 1; s.camera.far = 420;
  s.camera.left = -110; s.camera.right = 110; s.camera.top = 110; s.camera.bottom = -110;
  s.bias = -0.0012; s.normalBias = 0.5; s.radius = 2.4;
}
const keyTarget = new THREE.Object3D();
scene.add(keyLight, keyTarget);
keyLight.target = keyTarget;

const hemi = new THREE.HemisphereLight(0xffffff, 0x224455, 1);
scene.add(hemi);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.22);
scene.add(fillLight);

// --- world ------------------------------------------------------------------

const ctx = {
  time: 0, dt: 0, frame: 0,
  scene, camera, renderer, env, quality, input, seed: SEED,
  boat: {
    position: new THREE.Vector3(0, 0, 0),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    heading: 0, speed: 0, throttle: 0, turnRate: 0, heel: 0, trim: 0,
    wakeStrength: 0,
  },
  water: null, terrain: null, monster: null, quest: null,
  cameraUnderwater: 0,
};

const build = (fn, opts) => {
  const m = fn({ ...opts, ctx, env, scene, renderer, quality, seed: SEED, THREE });
  if (m && m.group) scene.add(m.group);
  return m || { group: null, update() {}, applyEnv() {}, dispose() {} };
};

const seabed = build(createSeabed);
const islands = build(createIslands, { seabed });
const terrain = {
  group: null,
  seabedHeight: (x, z) => seabed.seabedHeight(x, z),
  landHeight: (x, z) => islands.landHeight(x, z),
  isLand: (x, z) => islands.isLand(x, z),
  depthAt: (x, z) => Math.max(0, -seabed.seabedHeight(x, z)),
  islands, seabed,
};
ctx.terrain = terrain;

const sky = build(createSky);
const clouds = build(createClouds);
const celestial = build(createCelestial);
const coral = build(createCoral, { terrain });
const vegetation = build(createVegetation, { terrain });
const village = build(createVillage, { terrain });
const dock = build(createDock, { terrain });
const lighthouse = build(createLighthouse, { terrain });
const props = build(createProps, { terrain });
const water = build(createWater, { terrain });
ctx.water = water;
const boat = build(createBoat);
const fisher = build(createFisher, { boat });
const monster = build(createMonster, { terrain });
ctx.monster = monster;
const wildlife = build(createWildlife, { terrain });

const boatController = createBoatController({ ctx, input, water: () => ctx.water, terrain });
const chaseCamera = createChaseCamera({ ctx, camera, input });
const quest = createQuest({ ctx, monster });
ctx.quest = quest;
const hud = createHud({ ctx, time });

const modules = [
  sky, clouds, celestial, seabed, coral, islands, vegetation,
  village, dock, lighthouse, props, water, boat, fisher, monster, wildlife,
];

// --- passes -----------------------------------------------------------------

const REFLECT_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.06);
const REFRACT_PLANE = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.12);
const reflectMatrix = new THREE.Matrix4().makeScale(1, -1, 1);
const tmpMat = new THREE.Matrix4();
const clearColorLinear = new THREE.Color();

function renderRefraction() {
  camera.layers.set(LAYER.UNDERWATER);
  renderer.clippingPlanes = [REFRACT_PLANE];
  renderer.setRenderTarget(targets.refraction);
  clearColorLinear.copy(env.waterDeep);
  renderer.setClearColor(clearColorLinear, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
  renderer.clippingPlanes = [];
}

function renderReflection() {
  reflectCamera.copy(camera);
  reflectCamera.matrixAutoUpdate = false;
  tmpMat.copy(reflectMatrix).multiply(camera.matrixWorld);
  reflectCamera.matrixWorld.copy(tmpMat);
  reflectCamera.matrixWorldInverse.copy(tmpMat).invert();
  reflectCamera.projectionMatrix.copy(camera.projectionMatrix);
  // Negate the clip-space X row so the mirrored view keeps its winding.
  const e = reflectCamera.projectionMatrix.elements;
  e[0] = -e[0]; e[4] = -e[4]; e[8] = -e[8]; e[12] = -e[12];
  reflectCamera.projectionMatrixInverse.copy(reflectCamera.projectionMatrix).invert();
  reflectCamera.layers.set(LAYER.REFLECTED);

  renderer.clippingPlanes = [REFLECT_PLANE];
  renderer.setRenderTarget(targets.reflection);
  clearColorLinear.copy(env.skyHorizon);
  renderer.setClearColor(clearColorLinear, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, reflectCamera);
  renderer.clippingPlanes = [];
}

function renderBeauty() {
  camera.layers.set(LAYER.MAIN);
  renderer.setRenderTarget(targets.scene);
  clearColorLinear.copy(env.fogColor);
  renderer.setClearColor(clearColorLinear, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
}

// --- loop -------------------------------------------------------------------

let lastEnvVersion = -1;
let width = 1, height = 1;

function resize() {
  const w = Math.max(2, window.innerWidth);
  const h = Math.max(2, window.innerHeight);
  const b = setSize(w, h);
  width = b.width; height = b.height;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.resize(width, height);
  if (water.setTargets) {
    water.setTargets({
      refraction: targets.refraction,
      refractionDepth: targets.refraction.depthTexture,
      reflection: targets.reflection,
      sceneDepth: targets.scene.depthTexture,
      resolution: new THREE.Vector2(width, height),
    });
  }
  hud.resize?.(w, h);
}
window.addEventListener('resize', resize);
resize();

function applyEnvToLights() {
  keyLight.position.copy(env.keyDir).multiplyScalar(220);
  keyLight.color.copy(env.keyColor);
  keyLight.intensity = env.keyIntensity;
  keyTarget.position.set(0, 0, 0);
  fillLight.position.set(-env.keyDir.x * 160, 90, -env.keyDir.z * 160);
  fillLight.color.copy(env.ambientSky);
  fillLight.intensity = 0.18 + 0.22 * env.dayFactor;
  hemi.color.copy(env.ambientSky);
  hemi.groundColor.copy(env.ambientGround);
  hemi.intensity = env.ambientIntensity;
  scene.fog = scene.fog || new THREE.Fog(0x000000, 1, 2);
  scene.fog.color.copy(env.fogColor);
  scene.fog.near = env.fogNear;
  scene.fog.far = env.fogFar;
}

let clockSeconds = 0;
let lastNow = performance.now() / 1000;
let running = true;
let frames = 0;

function frame() {
  if (!running) return;
  requestAnimationFrame(frame);

  const now = performance.now() / 1000;
  let dt = FIXED_STEP > 0 ? FIXED_STEP : Math.min(0.05, Math.max(0, now - lastNow));
  lastNow = now;
  clockSeconds += dt;

  ctx.dt = dt;
  ctx.time = clockSeconds;
  ctx.frame = frames;

  time.update(dt);
  if (time.version !== lastEnvVersion) {
    lastEnvVersion = time.version;
    applyEnvToLights();
    for (const m of modules) m.applyEnv?.(env);
    chaseCamera.applyEnv?.(env);
    hud.applyEnv?.(env);
  }

  boatController.update(ctx);
  chaseCamera.update(ctx);
  camera.updateMatrixWorld(true);

  for (const m of modules) m.update?.(ctx);
  quest.update(ctx);
  hud.update(ctx);

  // Keep the key light's shadow box on the boat so the village and the dinghy
  // both get a shadow map worth having.
  keyLight.position.copy(env.keyDir).multiplyScalar(220).add(ctx.boat.position);
  keyTarget.position.copy(ctx.boat.position);
  keyTarget.updateMatrixWorld(true);

  const surfaceY = ctx.water?.sampleHeight ? ctx.water.sampleHeight(camera.position.x, camera.position.z, ctx.time) : 0;
  ctx.cameraUnderwater = THREE.MathUtils.clamp((surfaceY - camera.position.y) * 1.5, 0, 1);

  if (quality.reflections) renderReflection();
  renderRefraction();
  renderBeauty();
  post.render(env, {
    time: ctx.time,
    underwater: ctx.cameraUnderwater,
    underwaterTint: env.waterMid,
  });
  renderer.setRenderTarget(null);

  input.endFrame();
  frames++;
  api.frames = frames;
}

// --- keys -------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.code === 'BracketLeft') time.glideTo(time.hour - 2, 1.2);
  if (e.code === 'BracketRight') time.glideTo(time.hour + 2, 1.2);
  if (e.code === 'Digit1') time.glideTo('day', 1.5);
  if (e.code === 'Digit2') time.glideTo('golden', 1.5);
  if (e.code === 'Digit3') time.glideTo('sunset', 1.5);
  if (e.code === 'Digit4') time.glideTo('night', 1.5);
  if (e.code === 'KeyT') time.setRate(time.rate === 0 ? 0.35 : 0);
});

// --- public handle for the capture harness ----------------------------------

const api = {
  THREE, scene, camera, renderer, ctx, env, time, quality, post,
  modules: {
    sky, clouds, celestial, seabed, coral, islands, vegetation, village, dock,
    lighthouse, props, water, boat, fisher, monster, wildlife, hud, quest,
    boatController, chaseCamera,
  },
  frames: 0,
  ready: false,
  setHour(h) { time.set(h); },
  setBoat(x, z, heading) { boatController.teleport(x, z, heading); },
  setCamera(spec) { chaseCamera.setSpec(spec); },
  hideHud() { document.getElementById('hud')?.classList.add('hidden'); },
  showHud() { document.getElementById('hud')?.classList.remove('hidden'); },
  stop() { running = false; },
};
window.saltyfin = api;

const boot = document.getElementById('boot');
if (boot) boot.remove();

applyEnvToLights();
for (const m of modules) m.applyEnv?.(env);
hud.applyEnv?.(env);
api.ready = true;
requestAnimationFrame(frame);
