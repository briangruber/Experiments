// Boot, scene assembly, and the frame loop.

import {
  WebGPURenderer, RenderPipeline, RenderTarget, Vector2, Scene, PerspectiveCamera,
  ACESFilmicToneMapping,
} from 'three';
import { pass, screenUV, dot, float, Fn, vec4 } from 'three/tsl';
import { bloom } from '../vendor/BloomNode.js';

import { SCHEMA, PRESETS, VIEWS, defaults, applyPreset } from './params.js';
import { U, setDepthMap, sampleWave, WAKE_POINTS } from './fields.js';
import { buildDepthTexture, updateDepthTexture, terrainHeight } from './terrain.js';
import { createFloor, createSky } from './scene.js';
import { createWater } from './water.js';
import { createPropMaterial, buildStatics, buildBoat } from './props.js';
import { Orbit } from './controls.js';
import { UI } from './ui.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');
const boot = document.getElementById('boot');

const QUALITY = {
  low: { water: 192, floor: 224, depth: 512, ratio: 1.0 },
  medium: { water: 320, floor: 384, depth: 768, ratio: 1.25 },
  high: { water: 448, floor: 512, depth: 1024, ratio: 1.75 },
};
const isPhone = matchMedia('(pointer: coarse)').matches;
const quality = QUALITY[q.get('q') || window.LAGOON_QUALITY] || (isPhone ? QUALITY.medium : QUALITY.high);

const params = structuredClone(defaults);
applyPreset(params, PRESETS[q.get('preset')] ? q.get('preset') : 'Midday Cove');
if (q.has('bloom')) params.bloom = +q.get('bloom');

// ------------------------------------------------------------------- renderer
const renderer = new WebGPURenderer({
  canvas,
  antialias: true,
  forceWebGL: q.get('webgl') === '1',
});
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = params.exposure;
await renderer.init();
const backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl';

const scene = new Scene();
const camera = new PerspectiveCamera(42, 1, 0.3, 2400);
const orbit = new Orbit(camera, canvas);
orbit.goto(VIEWS[q.get('view')] || VIEWS.postcard, true);

// ---------------------------------------------------------------------- world
let depthTex = buildDepthTexture(params.floorDepth, quality.depth);
setDepthMap(depthTex);

const sky = createSky();
let floor = createFloor(params.floorDepth, quality.floor);
const propMaterial = createPropMaterial();
let props = buildStatics(params.floorDepth, propMaterial);
const boat = buildBoat();
boat.material = propMaterial;
const water = createWater(quality.water);
scene.add(sky, floor, props, boat, water);

// ------------------------------------------------------------------ post pass
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode('output');
const bloomPass = bloom(scenePassColor, params.bloom, 0.72, 0.86);
const vignette = Fn(() => {
  const d = screenUV.sub(0.5);
  return float(1.0).sub(U.vignette.mul(dot(d, d)).mul(1.35));
});
const pipeline = new RenderPipeline(renderer);
pipeline.outputNode = vec4(scenePassColor.add(bloomPass).rgb.mul(vignette()), 1.0);
const usePost = q.get('post') !== '0';

// ------------------------------------------------------------------- uniforms
function syncUniforms() {
  const el = params.sunElevation * Math.PI / 180;
  const az = params.sunAzimuth * Math.PI / 180;
  U.sunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  const wa = params.windDir * Math.PI / 180;
  U.wind.value.set(-Math.sin(wa), -Math.cos(wa));

  U.sunColor.value.setRGB(...params.sunColor);
  U.skyColor.value.setRGB(...params.skyColor);
  U.shallow.value.setRGB(...params.shallowColor);
  U.deep.value.setRGB(...params.deepColor);
  U.sandColor.value.setRGB(...params.sandColor);
  U.reefColor.value.setRGB(...params.reefColor);

  for (const k of [
    'clarity', 'turbidity', 'refraction', 'waveHeight', 'waveLength', 'waveSpeed',
    'chop', 'ripple', 'gloss', 'sparkle', 'reflectivity', 'shoreFoam', 'shoreFoamDepth',
    'crestFoam', 'wakeFoam', 'caustics', 'causticScale', 'floorDepth', 'stylize',
    'saturation', 'vignette',
  ]) U[k].value = params[k];

  renderer.toneMappingExposure = params.exposure;
  bloomPass.strength.value = params.bloom;
}
syncUniforms();

// Rebuilding the floor is a second of work, so it only happens when the one
// parameter that changes its shape actually changes, and only once the slider
// has settled.
let floorTimer = 0;
function rebuildFloor() {
  clearTimeout(floorTimer);
  floorTimer = setTimeout(() => {
    updateDepthTexture(depthTex, params.floorDepth);
    const next = createFloor(params.floorDepth, quality.floor);
    scene.remove(floor);
    floor.geometry.dispose();
    floor = next;
    scene.add(floor);
    scene.remove(props);
    props = buildStatics(params.floorDepth, propMaterial);
    scene.add(props);
  }, 260);
}

// ----------------------------------------------------------------------- boat
const wake = Array.from({ length: WAKE_POINTS }, () => ({ x: 0, z: 0, ang: 0, life: 0 }));
let wakeCursor = 0, wakeClock = 0;
const boatState = { phase: 2.1 };

function boatPath(t) {
  return [
    1.5 + Math.cos(t) * 9.5 + Math.sin(t * 2.3) * 1.6,
    1.0 + Math.sin(t) * 6.8 + Math.cos(t * 1.7) * 1.3,
  ];
}

function updateBoat(dt, time) {
  boatState.phase += dt * params.boatSpeed * 0.15;
  const [x, z] = boatPath(boatState.phase);
  const [x2, z2] = boatPath(boatState.phase + 0.01);
  const ang = Math.atan2(z2 - z, x2 - x);

  const w = sampleWave(x, z, time, params);
  boat.position.set(x, w.y - 0.05, z);
  // Forward is +Z in the hull's own frame; heading maps to a Y rotation, and the
  // surface normal supplies pitch and roll so the hull sits in the water rather
  // than on it.
  const heading = Math.atan2(Math.cos(ang), Math.sin(ang));
  boat.rotation.set(0, 0, 0);
  boat.rotation.y = heading;
  const fx = Math.cos(ang), fz = Math.sin(ang);
  boat.rotation.x = (w.nx * fx + w.nz * fz) * 0.75;
  boat.rotation.z = (w.nx * -fz + w.nz * fx) * 0.75 - params.boatSpeed * 0.06;

  // Trail: one point every tenth of a second, dropped at the transom.
  wakeClock += dt;
  const moving = params.boatSpeed > 0.02;
  if (moving && wakeClock > 0.15) {
    wakeClock = 0;
    const p = wake[wakeCursor];
    p.x = x - fx * 1.9; p.z = z - fz * 1.9;
    p.ang = ang; p.life = 1;
    wakeCursor = (wakeCursor + 1) % WAKE_POINTS;
  }
  for (let i = 0; i < WAKE_POINTS; i++) {
    const p = wake[i];
    if (p.life > 0) p.life = Math.max(0, p.life - dt / 5.5);
    U.wake.array[i].set(p.x, p.z, p.ang, p.life);
  }
}

// ------------------------------------------------------------------------- ui
const ui = new UI(document.getElementById('ui'), params, (ev) => {
  if (ev.type === 'preset') {
    applyPreset(params, ev.name);
    syncUniforms();
    rebuildFloor();
    ui.syncAll();
  } else if (ev.type === 'view') {
    orbit.goto(VIEWS[ev.name]);
  } else if (ev.type === 'set') {
    params[ev.key] = ev.value;
    if (ev.key === 'floorDepth') rebuildFloor();
    syncUniforms();
  }
});

const toggle = document.getElementById('panel-toggle');
const setPanel = (open) => {
  document.body.classList.toggle('panel-open', open);
  toggle.setAttribute('aria-expanded', String(open));
};
toggle.addEventListener('click', () => setPanel(!document.body.classList.contains('panel-open')));
setPanel(!isPhone && q.get('ui') !== '0');

addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') document.body.classList.toggle('capture');
  const views = Object.keys(VIEWS);
  const n = +e.key;
  if (n >= 1 && n <= views.length) orbit.goto(VIEWS[views[n - 1]]);
});

// ----------------------------------------------------------------------- loop
const offscreen = q.get('offscreen') === '1';
function draw() {
  if (usePost) pipeline.render();
  else renderer.render(scene, camera);
}

// Renders one frame into a texture and hands it back as a PNG data URL. Used by
// tools/shot.mjs; it is also the only way to get a picture out of a WebGPU
// context that is not allowed to reach a canvas.
async function capture() {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const rt = new RenderTarget(size.x, size.y);
  renderer.setRenderTarget(rt);
  draw();
  const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size.x, size.y);
  renderer.setRenderTarget(null);

  const cv = document.createElement('canvas');
  cv.width = size.x; cv.height = size.y;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size.x, size.y);
  const flip = backend === 'webgl';         // GL reads bottom-up, WebGPU top-down
  const row = size.x * 4;
  for (let y = 0; y < size.y; y++) {
    const src = (flip ? size.y - 1 - y : y) * row;
    img.data.set(px.subarray(src, src + row), y * row);
  }
  ctx.putImageData(img, 0, 0);
  rt.dispose();
  return cv.toDataURL('image/png');
}

let adaptive = 1;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality.ratio) * adaptive);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const fpsEl = document.getElementById('hud-fps');
let last = performance.now(), frames = 0, fpsAcc = 0, fpsCount = 0, clock = 0;

function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  clock += dt;
  U.time.value = clock;

  orbit.update(dt);
  updateBoat(dt, clock);

  // Headless Chromium hands out a WebGPU device but loses it the moment
  // anything is presented to a canvas, so the capture harness runs the loop
  // with drawing switched off and pulls frames through capture() instead.
  if (!offscreen) draw();

  frames++;
  fpsAcc += dt; fpsCount++;
  if (fpsAcc > 0.5) {
    const fps = fpsCount / fpsAcc;
    fpsEl.textContent = `${fps.toFixed(0)} fps \u00b7 ${backend}`;
    // Give back resolution when there is headroom, take it when there is not.
    if (fps < 26 && adaptive > 0.62) { adaptive = Math.max(0.62, adaptive - 0.08); resize(); }
    else if (fps > 52 && adaptive < 1) { adaptive = Math.min(1, adaptive + 0.04); resize(); }
    fpsAcc = 0; fpsCount = 0;
  }
  if (window.lagoon) window.lagoon.frames = frames;
  if (frames === 2) boot.classList.add('gone');
}

renderer.setAnimationLoop(frame);

// ---------------------------------------------------------------------- handle
window.lagoon = {
  params, camera, orbit, renderer, scene, backend, frames: 0, capture,
  views: VIEWS, presets: PRESETS, schema: SCHEMA,
  heightAt: (x, z) => terrainHeight(x, z, params.floorDepth),
  set(key, value) {
    // Colours arrive as hex from the tools and as linear triples from the UI.
    if (typeof value === 'string' && value[0] === '#') {
      value = [1, 3, 5].map((i) => (parseInt(value.slice(i, i + 2), 16) / 255) ** 2.2);
    }
    if (key === 'preset') { applyPreset(params, value); rebuildFloor(); }
    else if (key === 'view') { orbit.goto(VIEWS[value], true); return; }
    else params[key] = value;
    syncUniforms();
    ui.syncAll();
  },
};
