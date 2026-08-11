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
import { createTouchControls } from './core/touch.js';
import { LAYER } from './core/layers.js';
import { CLIP, setWaterClip, clipUniforms } from './water/clip.js';
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
import { createTown } from './world/town.js';
import { createLighthouse } from './models/lighthouse.js';
import { createProps } from './models/props.js';
import { createMonster } from './creatures/monster.js';
import { createWildlife } from './creatures/wildlife.js';
import { createBoatController } from './gameplay/boatController.js';
import { createChaseCamera } from './gameplay/chaseCamera.js';
import { createQuest } from './gameplay/quest.js';
import { createHud } from './hud/hud.js';
import { createIntro } from './hud/intro.js';
import { createOceanPanel } from './hud/oceanPanel.js';
import { createFishing } from './gameplay/fishing.js';
import { createShoreLeave } from './gameplay/shoreLeave.js';
import { createFishingHud } from './hud/fishingHud.js';
import { createShoreHud } from './hud/shoreHud.js';
import { createUnderwater } from './world/underwater.js';
import { createWakeFoam } from './water/wakeFoam.js';
import { oceanSettings } from './water/settings.js';
import { createProfiler, installGpuProbe, profileRequested, requestProfileRun } from './core/profile.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
const str = (k, d) => (params.get(k) ?? d);
const flag = (k, d = false) => (params.has(k) ? params.get(k) !== '0' : d);

const SEED = num('seed', 20260807) | 0;
// A phone gets the mobile tier unless the URL says otherwise. Coarse pointer is
// the reliable signal; screen size alone catches a small laptop window too.
const COARSE = typeof matchMedia === 'function'
  && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);
const TIER = str('quality', COARSE ? 'mobile' : 'high');
const START_HOUR = params.has('t') ? num('t', 12)
  : (PRESET_HOURS[str('preset', 'day')] ?? 12);
const FIXED_STEP = params.has('step') ? num('step', 1 / 60) : 0;   // deterministic capture
const DAY_RATE = num('rate', 0);        // hours per second; 0 freezes the sky

const canvas = document.getElementById('gl');

// The node renderer has to request an adapter and a device before it can
// compile anything, so the whole scene is built inside an async boot rather
// than at module scope. `?forcegl=1` runs the same node materials through the
// renderer's WebGL backend, which is also the automatic fallback on a browser
// with no WebGPU adapter.
boot().catch((err) => {
  const el = document.getElementById('boot');
  if (el) {
    el.textContent = 'Salty Fin could not start: ' + (err?.message || err);
    el.style.textTransform = 'none';
    el.style.letterSpacing = '0';
  }
  throw err;
});

async function boot() {
// Both of these have to happen before the renderer asks for a device: the probe
// patches the WebGPU prototypes three is about to call, and timestamp queries
// are a device feature that must be requested at creation time.
const PROFILE = profileRequested();
installGpuProbe();

const { renderer, quality, targets, setSize, makeTarget } = await createRenderer({
  canvas, tier: TIER,
  pixelRatio: params.has('pr') ? num('pr', 1) : undefined,
  forceWebGL: params.get('forcegl') === '1',
  trackTimestamp: PROFILE,
});

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(num('fov', 46), 1, 0.35, 6000);
camera.position.set(0, 8, 16);

const reflectCamera = new THREE.PerspectiveCamera();
reflectCamera.matrixAutoUpdate = false;
reflectCamera.matrixWorldAutoUpdate = false;

const time = createTimeOfDay({ hour: START_HOUR, seed: SEED });
const env = time.env;
time.setRate(DAY_RATE);

const input = createInput(window);
const touch = createTouchControls({
  input,
  onTimePreset: (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code })),
});
const post = createPost({ renderer, targets, makeTarget, quality });

// --- lights -----------------------------------------------------------------

// How far in front of the camera the shadow box sits, and how wide it is. A
// tighter box means sharper shadows; too tight and the far side of the village
// falls out of it. 110 m at 2048 is about 10 cm a texel.
const SHADOW_LEAD = 62;
const SHADOW_EXTENT = 110;
const shadowFocus = new THREE.Vector3();
const shadowFwd = new THREE.Vector3();

const keyLight = new THREE.DirectionalLight(0xffffff, 1);
keyLight.castShadow = quality.shadows;
if (quality.shadows) {
  const s = keyLight.shadow;
  s.mapSize.set(quality.shadowSize, quality.shadowSize);
  s.camera.near = 1; s.camera.far = 620;
  s.camera.left = -SHADOW_EXTENT; s.camera.right = SHADOW_EXTENT;
  s.camera.top = SHADOW_EXTENT; s.camera.bottom = -SHADOW_EXTENT;
  // normalBias is in world metres along the surface normal, so it has to be
  // read against the shadow map's footprint: at 155 m across a 2048 map that is
  // 0.15 m per texel. Half a metre walks the sample clean off a house wall and
  // the village fills with black blobs; 0.05 m is under one texel and the
  // terrain fills with smeared acne instead. One texel is the right answer.
  s.bias = -0.0006; s.normalBias = 0.09; s.radius = 3.0;
  // The shadow camera's projection is built once at construction and three
  // never rebuilds it, so without this the box above is ignored and the light
  // keeps three's default ten-metre frustum — which lands the whole village on
  // the edge of a map that covers a puddle around the boat.
  s.camera.updateProjectionMatrix();
}
const keyTarget = new THREE.Object3D();
scene.add(keyLight, keyTarget);
keyLight.target = keyTarget;

const hemi = new THREE.HemisphereLight(0xffffff, 0x224455, 1);
scene.add(hemi);

// `?shadows=0` turns the shadow map off without dropping to the low tier, so a
// capture can tell a shadow artefact apart from everything else `low` changes.
if (params.get('shadows') === '0') {
  keyLight.castShadow = false;
  renderer.shadowMap.enabled = false;
  quality.shadows = false;
}

const fillLight = new THREE.DirectionalLight(0xffffff, 0.22);
scene.add(fillLight);

// Lights are layer-tested against the camera exactly like meshes are, so a
// light on layer 0 alone drops out of the refraction and reflection passes and
// everything in them renders black. Every light lives on every layer.
for (const l of [keyLight, hemi, fillLight]) l.layers.enableAll();

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
// The town you can walk in: a boardwalk village on piles, out in the shallows,
// at one flat deck height. See world/town.js for why it is not on the island.
const town = build(createTown, { terrain, seed: SEED });
const lighthouse = build(createLighthouse, { terrain });
const props = build(createProps, { terrain });
const water = build(createWater, { terrain });
ctx.water = water;
const boat = build(createBoat);
// The wake, as a few hundred hand-drawn puffs and a stream of prop bubbles
// rather than as a textured ribbon. See water/wakeFoam.js for why a field of
// noise can never stop reading as a stamp.
const wakeFoam = createWakeFoam({ water: () => ctx.water, quality });
scene.add(wakeFoam.group);
const fisher = build(createFisher, { boat });
const monster = build(createMonster, { terrain });
ctx.monster = monster;
const wildlife = build(createWildlife, { terrain });
// Fog, light and suspended matter for when the camera goes under. Not a
// `module` — it is not driven by applyEnv/update like the rest, it runs after
// them as a modifier on what they produced. See world/underwater.js.
const underwater = createUnderwater({
  ctx, scene, seed: SEED, lights: { keyLight, hemi, fillLight },
});
scene.add(underwater.group);

const boatController = createBoatController({ ctx, input, water: () => ctx.water, terrain });
// `?drive=0.9` or `?drive=0.9,0.3` pins the helm for a capture.
if (params.has('drive')) {
  const d = params.get('drive').split(',').map(Number);
  if (Number.isFinite(d[0])) input.setTouchAxes(d[0], Number.isFinite(d[1]) ? d[1] : 0);
}
if (params.has('boat')) {
  const p = params.get('boat').split(',').map(Number);
  if (p.length >= 2 && p.every(Number.isFinite)) {
    boatController.teleport(p[0], p[1], THREE.MathUtils.degToRad(p[2] || 0));
  }
}
const chaseCamera = createChaseCamera({ ctx, camera, input });
const quest = createQuest({ ctx, monster });
ctx.quest = quest;
const fishing = createFishing({
  ctx, scene, input, boat, wildlife, terrain, camera, chaseCamera,
  water: () => ctx.water, seed: SEED,
});
ctx.fishing = fishing;
// Going ashore. Built after the chase rig because it borrows its fov when it
// takes the frame, and after fishing because the two must never both own it.
const shoreLeave = createShoreLeave({ ctx, scene, input, camera, chaseCamera, town, terrain });
ctx.shore = shoreLeave;

const hud = createHud({ ctx, time });
const fishingHud = createFishingHud({ fishing, ctx });
const shoreHud = createShoreHud({ shore: shoreLeave, ctx });
const intro = createIntro({ touch: !!touch.root, backend: quality.backend });
// Sliders for the sea. Built now so `?ocean=1` and the O key work before the
// warm-up finishes; it starts hidden and costs nothing until it is opened.
const oceanPanel = createOceanPanel();
if (params.get('ocean') === '1') oceanPanel.open();

// A live readout of which backend is running and what it actually costs, and a
// tap toggles to the other one and reloads — an artifact URL cannot carry
// ?forcegl=1, so the A/B has to live on the page itself.
const fpsBadge = document.createElement('div');
fpsBadge.id = 'fps';
fpsBadge.dataset.sfUi = '';
fpsBadge.style.cssText = 'position:fixed;left:10px;bottom:calc(10px + env(safe-area-inset-bottom));'
  + 'z-index:45;font:600 10px/1.6 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;'
  + 'text-transform:uppercase;color:rgba(214,236,255,.75);background:rgba(8,20,36,.45);'
  + 'border:1px solid rgba(206,232,255,.2);border-radius:999px;padding:4px 10px;'
  + 'cursor:pointer;-webkit-user-select:none;user-select:none';
fpsBadge.title = 'Ocean settings, renderer, profiler';
fpsBadge.textContent = quality.backend;
document.body.appendChild(fpsBadge);

// On a phone the badge is hidden — the player asked for a HUD that is the radar
// and nothing else — so the radar itself opens the menu. Without this the
// renderer switch and the GPU profiler would be unreachable on the one device
// they were built to diagnose.
const radar = document.querySelector('#hud .sf-mm');
if (radar) {
  radar.style.pointerEvents = 'auto';
  radar.style.cursor = 'pointer';
  radar.title = 'Tap for ocean settings';
  radar.addEventListener('pointerdown', (e) => {
    if (getComputedStyle(fpsBadge).display !== 'none') return;   // desktop: badge owns it
    e.preventDefault();
    fpsBadge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: false }));
  });
}

// Tapping the badge used to switch backend outright. It now opens a two-item
// menu, because the profiler needs a way in and a long-press is a bad gesture
// to hang a diagnostic off on iOS — Safari puts its own selection UI there.
let menu = null;
function closeMenu() { menu?.remove(); menu = null; }
fpsBadge.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (menu) { closeMenu(); return; }
  menu = document.createElement('div');
  menu.dataset.sfUi = '';
  menu.style.cssText = 'position:fixed;left:10px;bottom:calc(40px + env(safe-area-inset-bottom));'
    + 'z-index:60;display:flex;flex-direction:column;gap:6px;'
    + 'font:600 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase';
  const item = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'appearance:none;text-align:left;border:1px solid rgba(206,232,255,.24);'
      + 'background:rgba(8,20,36,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);'
      + 'color:#dceaf7;border-radius:8px;padding:9px 12px;font:inherit';
    b.addEventListener('click', fn);
    return b;
  };
  // First, because it is the one a player has a reason to open twice. The
  // other two are diagnostics that cost a reload.
  menu.appendChild(item('Ocean settings', () => { closeMenu(); oceanPanel.open(); }));
  menu.appendChild(item(
    quality.backend === 'webgpu' ? 'Switch to WebGL' : 'Switch to WebGPU',
    () => {
      try {
        localStorage.setItem('saltyfin-backend', quality.backend === 'webgpu' ? 'webgl' : 'webgpu');
      } catch { /* storage may be sandboxed */ }
      location.reload();
    },
  ));
  // Reloads rather than starting in place: the GPU-timestamp feature has to be
  // requested when the device is created, so a profile has to begin at boot.
  menu.appendChild(item('Run GPU profile', () => { requestProfileRun(); location.reload(); }));
  menu.appendChild(item('Cancel', closeMenu));
  document.body.appendChild(menu);
});
let fpsMark = performance.now() / 1000;
let fpsCount = 0;
let renderCpuMs = 0;

const modules = [
  sky, clouds, celestial, seabed, coral, islands, vegetation,
  village, dock, town, lighthouse, props, water, boat, fisher, monster, wildlife,
  wakeFoam,
];

// Modules add their own practicals — the lantern, the dock lamps, the lighthouse
// — and setLayers() on their group will have narrowed those lights to whatever
// layers the geometry wanted. Put every light back on every layer.
function normalizeLights() {
  scene.traverse((o) => { if (o.isLight) o.layers.enableAll(); });
}
normalizeLights();

// A transparent mesh still casts a fully opaque shadow unless it is given an
// alpha-tested depth material, so every glow quad, lamp halo and additive beam
// in the scene was stamping a solid black slab onto the terrain. Nothing that
// does not write depth should cast.
function normalizeShadowCasters() {
  scene.traverse((o) => {
    if (!o.isMesh || !o.castShadow) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const ghost = mats.some((m) => m && (m.transparent === true || m.depthWrite === false));
    if (ghost) o.castShadow = false;
  });
}
normalizeShadowCasters();

// --- passes -----------------------------------------------------------------

// The WebGL build cut the refraction and reflection passes at the waterline
// with renderer.clippingPlanes, which the node renderer does not have. The
// layer split (UNDERWATER / REFLECTED) already does most of that work; what it
// cannot do is trim a mesh that straddles y=0, so water/clip.js hands the node
// materials a plane to discard against instead.
const reflectMatrix = new THREE.Matrix4().makeScale(1, -1, 1);
const tmpMat = new THREE.Matrix4();
const clearColorLinear = new THREE.Color();

function renderRefraction() {
  camera.layers.set(LAYER.UNDERWATER);
  renderer.setRenderTarget(targets.refraction);
  clearColorLinear.copy(env.waterDeep);
  renderer.setClearColor(clearColorLinear, 1);
  // autoClear rather than renderer.clear(): an explicit clear is its own render
  // pass, and on the tile-based GPUs every phone has, an extra pass per target
  // is a full tile load/store round trip. Folding the clear into the pass's
  // load operation is close to free. autoClear stays off globally because the
  // wake sim draws twice into one target and must not clear in between.
  renderer.autoClear = true;
  // Keep only what is under the water. LAYER.UNDERWATER sorts whole objects
  // into this pass but cannot trim one, and the seabed heightfield carries the
  // dry land too — so without the clip the water was sampling hillsides.
  setWaterClip(CLIP.BELOW);
  renderer.render(scene, camera);
  setWaterClip(CLIP.OFF);
  renderer.autoClear = false;
}

function renderReflection() {
  // Deliberately NOT camera.copy(). copy() brings across the real camera's
  // local `matrix` and leaves matrixWorldNeedsUpdate set, and three's render
  // then rebuilds matrixWorld from that local matrix — throwing the mirror away
  // on every frame the camera actually moved. The reflection would look right
  // while standing still and swim as soon as you turned. Both auto-update flags
  // are off (set once at construction) and every matrix is written by hand.
  reflectCamera.fov = camera.fov;
  reflectCamera.aspect = camera.aspect;
  reflectCamera.near = camera.near;
  reflectCamera.far = camera.far;
  tmpMat.copy(reflectMatrix).multiply(camera.matrixWorld);
  reflectCamera.matrixWorld.copy(tmpMat);
  reflectCamera.matrixWorldInverse.copy(tmpMat).invert();
  reflectCamera.matrixWorldNeedsUpdate = false;
  reflectCamera.projectionMatrix.copy(camera.projectionMatrix);
  // Negate the clip-space X row so the mirrored view keeps its winding.
  const e = reflectCamera.projectionMatrix.elements;
  e[0] = -e[0]; e[4] = -e[4]; e[8] = -e[8]; e[12] = -e[12];
  reflectCamera.projectionMatrixInverse.copy(reflectCamera.projectionMatrix).invert();
  reflectCamera.layers.set(LAYER.REFLECTED);

  renderer.setRenderTarget(targets.reflection);
  clearColorLinear.copy(env.skyHorizon);
  renderer.setClearColor(clearColorLinear, 1);
  renderer.autoClear = true;
  // Keep only what is above the water. The mirror is applied to the CAMERA, so
  // positionWorld.y inside this pass is still true world Y and the test needs no
  // sign flip. Reset unconditionally after — nothing downstream wants a clip.
  setWaterClip(CLIP.ABOVE);
  renderer.render(scene, reflectCamera);
  setWaterClip(CLIP.OFF);
  renderer.autoClear = false;
}

// `?nopost=1` renders the beauty pass straight to the canvas, which separates a
// scene problem from a post problem in one capture.
const NOPOST = params.get('nopost') === '1';

// The node renderer has no preserveDrawingBuffer, so anything that reads the
// canvas after the frame has ended gets a cleared buffer. `?capture=1` mirrors
// the finished frame into a 2D canvas from inside the render loop — the same
// task as the draw, which is the only moment the pixels exist — and that canvas
// sits under the HUD so an ordinary page screenshot picks up both.
const CAPTURE = params.get('capture') === '1';
let grab = null;
if (CAPTURE) {
  grab = document.createElement('canvas');
  grab.id = 'grab';
  grab.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:5';
  document.body.insertBefore(grab, document.getElementById('hud'));
  grab.ctx = grab.getContext('2d');
}

// A debug view must never be mistakable for a real frame, so `?show=` labels
// itself. Outside the HUD, so hideHud() leaves it on a capture.
if (post.showing) {
  const tag = document.createElement('div');
  tag.id = 'showtag';
  tag.textContent = 'debug · targets.' + post.showing;
  tag.style.cssText = 'position:fixed;top:8px;left:8px;z-index:50;pointer-events:none;'
    + 'font:600 10px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;'
    + 'color:#ffd27a;background:rgba(8,20,36,.7);'
    + 'border:1px solid rgba(255,210,122,.5);border-radius:6px;padding:5px 8px';
  document.body.appendChild(tag);
}

function mirrorFrame() {
  if (!grab) return;
  if (grab.width !== canvas.width || grab.height !== canvas.height) {
    grab.width = canvas.width; grab.height = canvas.height;
  }
  grab.ctx.drawImage(canvas, 0, 0);
}

function renderBeauty(toScreen = NOPOST) {
  camera.layers.set(LAYER.MAIN);
  renderer.setRenderTarget(toScreen ? null : targets.scene);
  clearColorLinear.copy(env.fogColor);
  renderer.setClearColor(clearColorLinear, 1);
  renderer.autoClear = true;
  renderer.render(scene, camera);
  renderer.autoClear = false;
}

// Aim the shadow box at what the camera is looking at, not at the boat. On the
// chase camera those are the same place, but an establishing shot of the village
// puts the town 150 m off the boat — half outside the frustum, where its casters
// get culled and the ones that survive smear across the terrain.
//
// A function rather than inline in frame() because the boot warm-up has to run
// it too: it decides which casters the shadow camera can see, and a warm-up that
// skips it renders the shadow map from the wrong place and compiles the wrong
// depth materials.
function aimShadowBox() {
  camera.getWorldDirection(shadowFwd);
  shadowFocus.copy(camera.position).addScaledVector(shadowFwd, SHADOW_LEAD);
  shadowFocus.y = THREE.MathUtils.clamp(shadowFocus.y, 0, 45);
  // Snap to whole shadow texels so the map does not crawl as the camera moves.
  const texel = (SHADOW_EXTENT * 2) / quality.shadowSize;
  shadowFocus.x = Math.round(shadowFocus.x / texel) * texel;
  shadowFocus.z = Math.round(shadowFocus.z / texel) * texel;
  keyLight.position.copy(env.keyDir).multiplyScalar(260).add(shadowFocus);
  keyTarget.position.copy(shadowFocus);
  keyTarget.updateMatrixWorld(true);
}

function renderPost() {
  post.render(env, {
    time: ctx.time,
    underwater: ctx.cameraUnderwater,
    underwaterTint: env.waterMid,
  });
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
    fishing.applyEnv?.(env);
  }

  boatController.update(ctx);
  // Fishing may take the camera. It runs before the chase rig rather than
  // after so only one of them ever writes the transform in a frame — two rigs
  // fighting over it is a jitter nobody can debug from a screenshot.
  fishing.update(ctx);
  shoreLeave.update(ctx);
  if (!fishing.state.ownsCamera && !shoreLeave.ownsCamera) chaseCamera.update(ctx);
  camera.updateMatrixWorld(true);

  for (const m of modules) m.update?.(ctx);
  quest.update(ctx);
  hud.update(ctx);
  fishingHud.update();
  shoreHud.update();

  // Aim the shadow box at what the camera is looking at, not at the boat. On
  // the chase camera those are the same place, but an establishing shot of the
  // village puts the town 150 m off the boat — half outside the frustum, where
  // its casters get culled and the ones that survive smear across the terrain.
  aimShadowBox();

  const surfaceY = ctx.water?.sampleHeight ? ctx.water.sampleHeight(camera.position.x, camera.position.z, ctx.time) : 0;
  ctx.cameraUnderwater = THREE.MathUtils.clamp((surfaceY - camera.position.y) * 1.5, 0, 1);
  // After applyEnvToLights and after the camera has moved: this is a modifier
  // on the preset's own lights and fog, so it has to run once both are final.
  underwater.update(env, ctx.cameraUnderwater, ctx.time);
  post.underwater?.update({
    camera, env, amount: ctx.cameraUnderwater, time: ctx.time,
    water: ctx.water, surfaceY,
  });

  // While a profile is running the ladder owns the frame: it hands back the
  // rung to draw and we draw exactly that, so the timings compare like with
  // like instead of with whatever the real frame happens to be doing.
  const override = profiler ? profiler.step(now * 1000) : null;

  const renderStart = performance.now();
  if (override) {
    override();
  } else {
    if (quality.reflections) renderReflection();
    renderRefraction();
    renderBeauty();
    if (!NOPOST) renderPost();
    renderer.setRenderTarget(null);
  }
  // `?show=reflection|refraction|scene` overwrites the canvas with one pass's
  // target. It runs after the whole frame, so every pass draws exactly as it
  // normally would and what lands on screen is the buffer its consumer sampled
  // — and it must sit BEFORE mirrorFrame(), or `?capture=1` grabs the composite
  // that this just painted over.
  post.showDebugTarget?.(env);
  renderCpuMs += performance.now() - renderStart;
  mirrorFrame();

  fpsCount++;
  if (now - fpsMark >= 0.5) {
    // fps and the main-thread cost of encoding the frame, side by side. The
    // pair is the diagnosis: low fps with low cpu means the GPU is the wall
    // (the render scale lever helps); low fps with high cpu means the encode
    // path is (it will not).
    fpsBadge.textContent = quality.backend
      + ' \u00b7 ' + Math.round(fpsCount / (now - fpsMark)) + ' fps'
      + ' \u00b7 cpu ' + Math.round(renderCpuMs / fpsCount) + 'ms';
    fpsMark = now; fpsCount = 0; renderCpuMs = 0;
  }

  input.endFrame();
  frames++;
  api.frames = frames;
  if (frames % 120 === 1) normalizeLights();   // catches lights added late
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
  THREE, scene, camera, reflectCamera, renderer, ctx, env, time, quality, post, targets,
  clip: clipUniforms,
  town,
  shore: shoreLeave,
  // The same object the panel drives, so a capture can pin a look without
  // touching a slider: saltyfin.ocean.set('reflect', 0.4).
  ocean: oceanSettings,
  oceanPanel,
  // The underwater screen-space pass, so a capture can sweep its uniforms
  // without a reload. Tuning this by rebuilding is eight minutes a value.
  uw: post.underwater,
  // The capture harness has no thumbs: ?fish=1 casts on load, and these drive
  // the beats so a screenshot can be taken at any of them.
  fish: {
    start: (instant) => fishing.start(instant),
    stop: () => fishing.stop(),
    press: () => fishing.press(),
    hold: (v) => fishing.setHold(v),
    jig: (v) => fishing.setJig(v),
    // Step the minigame without rendering. Under a software rasteriser the
    // capture harness gets about a frame a second, so a test that needs two
    // hundred frames of fish behaviour is otherwise a three-minute run.
    tick(seconds, dt = 1 / 60) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        ctx.time += dt;
        ctx.dt = dt;
        // The real ctx, not a stub: the surfacing branch hands control back to
        // the chase rig, which reads the whole thing.
        fishing.update(ctx);
      }
    },
    state: fishing.state,
  },
  lights: { keyLight, hemi, fillLight },
  modules: {
    sky, clouds, celestial, seabed, coral, islands, vegetation, village, dock,
    lighthouse, props, water, boat, fisher, monster, wildlife, hud, quest,
    boatController, chaseCamera, fishing, underwater, wakeFoam,
  },
  frames: 0,
  ready: false,
  setHour(h) {
    time.set(h);
    // Push it through immediately. The frame loop normally does this when
    // time.version changes, but a capture stops the loop and draws on demand —
    // without this every deferred-render shot came back lit at the boot hour.
    lastEnvVersion = time.version;
    applyEnvToLights();
    for (const m of modules) m.applyEnv?.(env);
    chaseCamera.applyEnv?.(env);
    hud.applyEnv?.(env);
    fishing.applyEnv?.(env);
  },
  setBoat(x, z, heading) { boatController.teleport(x, z, heading); },
  /**
   * Hold the helm from outside. The capture harness has no hands, so without
   * this every screenshot is of a boat sitting still — and a boat sitting still
   * has no wake, which is most of what the water is supposed to be doing.
   */
  drive(fwd = 0, turn = 0) { input.setTouchAxes(fwd, turn); },
  setCamera(spec) { chaseCamera.setSpec(spec); },
  hideHud() {
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('touch')?.classList.add('hidden');
    fpsBadge.style.display = 'none';
    oceanPanel.close();
    const fishGo = document.getElementById('sf-fish-go');
    if (fishGo) fishGo.style.display = 'none';
    intro.dismiss?.();
    document.getElementById('intro')?.remove();
  },
  showHud() {
    document.getElementById('hud')?.classList.remove('hidden');
    document.getElementById('touch')?.classList.remove('hidden');
    fpsBadge.style.display = '';
    const fishGo = document.getElementById('sf-fish-go');
    if (fishGo) fishGo.style.display = '';
  },
  stop() { running = false; },
  /**
   * One frame, on demand, with the loop stopped. A capture that wants to
   * photograph a specific beat of the fishing minigame has to step the sim
   * with fish.tick() and then draw — and under a software rasteriser the real
   * loop delivers about one frame a second, so waiting for rAF between steps
   * moves the state on before the shutter opens.
   */
  /**
   * Advance the whole simulation without drawing the four big passes, then draw
   * one frame. A wake needs the boat to have BEEN somewhere — the trail is laid
   * down over seconds of travel — and under a software rasteriser a real-time
   * capture gets about a dozen frames in fifteen seconds, which is half a metre
   * of boat. The module loop still runs, so the wake's own GPU sim steps.
   */
  simulate(seconds, dt = 1 / 60) {
    const n = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) {
      ctx.dt = dt;
      ctx.time += dt;
      ctx.frame = frames++;
      boatController.update(ctx);
      fishing.update(ctx);
      if (!fishing.state.ownsCamera && !shoreLeave.ownsCamera) chaseCamera.update(ctx);
      camera.updateMatrixWorld(true);
      for (const m of modules) m.update?.(ctx);
      quest.update(ctx);
      input.endFrame();
    }
    api.renderFrame();
  },
  renderFrame() {
    camera.updateMatrixWorld(true);
    aimShadowBox();
    const sY = ctx.water?.sampleHeight
      ? ctx.water.sampleHeight(camera.position.x, camera.position.z, ctx.time) : 0;
    ctx.cameraUnderwater = THREE.MathUtils.clamp((sY - camera.position.y) * 1.5, 0, 1);
    underwater.update(env, ctx.cameraUnderwater, ctx.time);
    post.underwater?.update({
      camera, env, amount: ctx.cameraUnderwater, time: ctx.time,
      water: ctx.water, surfaceY: sY,
    });
    if (quality.reflections) renderReflection();
    renderRefraction();
    renderBeauty();
    if (!NOPOST) renderPost();
    renderer.setRenderTarget(null);
    hud.update(ctx);
    fishingHud.update();
  shoreHud.update();
    mirrorFrame();
  },
};
window.saltyfin = api;

applyEnvToLights();
for (const m of modules) m.applyEnv?.(env);
hud.applyEnv?.(env);
fishing.applyEnv?.(env);

// Compile every pipeline the scene will ever need, before the first frame.
//
// A material's pipeline is built the first time it is actually drawn, and in
// three's WebGPU backend that call is synchronous — createRenderPipelineAsync
// exists but is only reached from compileAsync. So a material that first
// appears mid-way through a time-of-day glide compiles *during* the glide and
// stalls it. Measured on the way from noon to night: one frame of 9.5 seconds
// at hour 16.6 as two fragment programs were built, another at 19.9. Sampling
// the endpoints finds nothing, because the objects involved are not visible at
// noon or at night — only somewhere in between. That is why the freeze was
// specific to transitions that pass through the afternoon: golden, sunset and
// night sit within three hours of each other and cross nothing new.
//
// Rather than guess which hours matter, force everything visible and compile
// against each pass. Visibility is the only thing gating these materials, and
// the render target has to be bound first because the pipeline cache key
// carries the context's colour and depth format — PassNode.compileAsync does
// the same thing for the same reason. The three water targets share one
// context, so one binding covers all of them; the canvas is the second.
async function warmUpClock() {
  const hour0 = time.hour;
  const bootEl = document.getElementById('boot');
  try {
    // Whole hours, not compileAsync. compileAsync only reaches the materials a
    // camera can see and never touches the shadow depth materials, and the
    // shadow map is most of what changes here: the sun swings through a huge
    // arc between noon and dusk, and each new angle pulls casters the shadow
    // camera has never drawn before into its frustum. Rendering real frames is
    // the only warm-up that produces exactly the render objects, contexts and
    // cache keys the real frames will ask for.
    for (let h = 0; h < 24; h += 1) {
      time.set(h);
      applyEnvToLights();
      for (const m of modules) m.applyEnv?.(env);
      camera.updateMatrixWorld(true);
      aimShadowBox();
      if (quality.reflections) renderReflection();
      renderRefraction();
      renderBeauty();
      renderPost();
      // Yield between hours. Twenty-four frames back to back is a second on a
      // phone and much longer while the shaders are still compiling, and a
      // wholly blocked main thread means no loading screen and a browser that
      // thinks the page has hung.
      if (bootEl) bootEl.textContent = 'Warming shaders ' + Math.round((h + 1) / 24 * 100) + '%';
      await new Promise((r) => requestAnimationFrame(r));
    }
  } catch (err) {
    // Never let the warm-up stop the game starting. Worst case without it is
    // the stall it exists to remove.
    console.warn('clock warm-up skipped:', err?.message || err);
  } finally {
    renderer.setRenderTarget(null);
    time.set(hour0);
    applyEnvToLights();
    for (const m of modules) m.applyEnv?.(env);
    hud.applyEnv?.(env);
    fishing.applyEnv?.(env);
  }
}
// `?warm=0` skips it, so a capture can measure what it is actually buying.
if (params.get('warm') !== '0') await warmUpClock();

const boot = document.getElementById('boot');
if (boot) boot.remove();

// `?fish=1` drops straight into the jig for a capture; `?fish=cast` plays
// the whole stop-and-dive so the transition can be photographed too.
if (params.has('fish') && params.get('fish') !== '0') fishing.start(params.get('fish') !== 'cast');

// `?shore=1` moors and steps ashore on load, so a capture can photograph the
// quay without driving there. It teleports the boat to the berth first,
// because `dock()` refuses unless you are actually near it — and a debug hook
// that bypasses the rule it is meant to exercise tests nothing.
if ((params.get('shore') || '').match(/^(1|walk:)/)) {
  const b = new THREE.Vector3();
  town.berthWorld(b);
  boatController.teleport(b.x, b.z, town.yaw);
  shoreLeave.update({ ...ctx, dt: 0 });
  shoreLeave.dock();
  for (let i = 0; i < 120; i++) shoreLeave.update({ ...ctx, dt: 1 / 60 });
  // `?shore=walk:8` then strolls inland for eight seconds, which is how a
  // capture photographs the stair without a pair of hands on the keyboard.
  const walkFor = /^walk:([\d.]+)$/.exec(params.get('shore') || '');
  if (walkFor) {
    shoreLeave.setWalkAxes(0, 1);
    const n = Math.round(Number(walkFor[1]) * 60);
    for (let i = 0; i < n; i++) shoreLeave.update({ ...ctx, dt: 1 / 60 });
    shoreLeave.setWalkAxes(0, 0);
  }
}

api.ready = true;

const profiler = createProfiler({
  renderer, quality, targets, makeTarget,
  passes: {
    reflection: renderReflection,
    refraction: renderRefraction,
    beauty: renderBeauty,
    post: renderPost,
  },
});
api.profiler = profiler;
if (PROFILE) {
  // Two seconds of ordinary play first. Every pipeline in the scene compiles
  // on the frame its material is first drawn, and profiling that would only
  // ever measure the compiler.
  intro.dismiss?.();
  setTimeout(() => profiler.start(), 2000);
}

requestAnimationFrame(frame);
}
