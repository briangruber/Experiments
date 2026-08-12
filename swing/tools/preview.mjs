#!/usr/bin/env node
// Render generated meshes to a PNG contact sheet, so a model can be judged
// before it is wired into the game.
//
//   node tools/preview.mjs --out shots/heroes.png hero_a hero_b
//
// Each model gets a row: front, three-quarter and side, framed to its own
// bounding box and lit the way the game lights it.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'shots/preview.png');
const POSE = opt('pose', '');
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--pose');
if (!names.length) { console.error('usage: preview.mjs [--out file.png] <name> [name…]'); process.exit(2); }

const CELL = 300;
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; background:#12151d; font:600 12px/1 ui-monospace,Menlo,monospace; color:#8ea2c6; }
  .row { display:flex; align-items:center; }
  .name { width:110px; padding-left:14px; letter-spacing:.08em; }
  canvas { display:block; }
</style>
<div id="sheet"></div>
<script type="importmap">
{"imports":{"three":"/vendor/three/three.webgpu.min.js","three/webgpu":"/vendor/three/three.webgpu.min.js","three/tsl":"/vendor/three/three.tsl.min.js","three/addons/":"/vendor/three/addons/"}}
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { Avatar } from '/src/avatar.js';

const NAMES = __NAMES__;
const POSE = __POSE__;

/** Fake just enough player state to drive the avatar's pose solver. */
function fakePlayer(kind) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const base = {
    pos: V(0, 0, 0), vel: V(0, 0, 14), speed: 14, grounded: false, diving: false,
    web: { active: false, side: 1, anchor: V(0, 0, 0) },
  };
  if (kind === 'swing') {
    base.web = { active: true, side: 1, anchor: V(14, 26, 10) };
    base.vel = V(4, -6, 22); base.speed = 24;
  } else if (kind === 'dive') {
    base.diving = true; base.vel = V(0, -40, 30); base.speed = 50;
  } else if (kind === 'run') {
    base.grounded = true; base.vel = V(0, 0, 9); base.speed = 9;
  } else if (kind === 'idle') {
    base.grounded = true; base.vel = V(0, 0, 0); base.speed = 0;
  }
  return base;
}
const CELL = __CELL__;
const VIEWS = [[0, 0], [Math.PI * 0.3, 0], [Math.PI * 0.6, 0], [Math.PI, 0]];
const sheet = document.getElementById('sheet');

// One renderer per model, three viewports across a single canvas. Copying out
// of a shared canvas between renders reads a swapped buffer and yields three
// identical frames, so each view is scissored into its own strip instead.
for (const name of NAMES) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('div');
  label.className = 'name';
  label.textContent = name;
  row.appendChild(label);
  sheet.appendChild(row);

  let model = null;
  let avatar = null;
  if (POSE) {
    // Drive the real Avatar class so the contact sheet shows what the game
    // shows, bind pose included or not.
    avatar = new Avatar();
    try {
      await avatar.load('/assets/' + name + '.glb');
    } catch (err) {
      label.textContent = name + ' \u2014 failed: ' + err.message;
      continue;
    }
    const p = fakePlayer(POSE);
    for (let i = 0; i < 40; i++) avatar.update(1 / 30, p);   // let the blend settle
    model = avatar.root;

    // How far did each bone actually move off its bind pose? A solver that is
    // silently doing nothing looks exactly like a T-pose.
    window.__POSE_DEBUG = window.__POSE_DEBUG || {};
    const deltas = {};
    for (const [boneName] of avatar.constructor.CHAIN || []) { /* noop */ }
    for (const [key, bone] of avatar.bones) {
      const rest = avatar.rest.get(bone.name);
      if (!rest) continue;
      const dot = Math.min(1, Math.abs(bone.quaternion.dot(rest)));
      deltas[key] = +(2 * Math.acos(dot) * 180 / Math.PI).toFixed(1);
    }
    window.__POSE_DEBUG[name] = {
      bones: avatar.bones.size,
      ready: avatar.ready,
      standIn: !!avatar.standIn,
      blendSample: avatar.blend.LeftArm ? avatar.blend.LeftArm.toArray().map((v) => +v.toFixed(2)) : null,
      movedDegrees: deltas,
    };
  } else {
    try {
      const gltf = await new GLTFLoader().loadAsync('/assets/' + name + '.glb');
      model = gltf.scene;
    } catch (err) {
      label.textContent = name + ' \u2014 failed';
      continue;
    }
  }

  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true, alpha: false });
  await renderer.init();
  renderer.setSize(CELL * VIEWS.length, CELL, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x12151d, 1);
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  row.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x3a3550, 2.0));
  const key = new THREE.DirectionalLight(0xfff0e0, 3.0);
  key.position.set(-3, 4, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb0ff, 1.8);
  rim.position.set(4, 2, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(3, -1, 4);
  scene.add(fill);

  model.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });
  const pivot = new THREE.Group();
  pivot.add(model);
  scene.add(pivot);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  const cam = new THREE.PerspectiveCamera(35, 1, radius * 0.01, radius * 40);
  const dist = radius / Math.tan((35 * Math.PI / 180) / 2) * 1.2;

  // Orbit the camera rather than rotating the subject: a skinned mesh does not
  // reliably follow a parent transform, and a still that silently shows the same
  // angle three times is worse than no contact sheet at all.
  for (let i = 0; i < VIEWS.length; i++) {
    const yaw = VIEWS[i][0];
    cam.position.set(centre.x + Math.sin(yaw) * dist, centre.y, centre.z + Math.cos(yaw) * dist);
    cam.lookAt(centre.x, centre.y, centre.z);
    renderer.setViewport(i * CELL, 0, CELL, CELL);
    renderer.setScissor(i * CELL, 0, CELL, CELL);
    await renderer.renderAsync(scene, cam);
  }
}
window.__PREVIEW_READY = true;
</script>`;

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE.replace('__NAMES__', JSON.stringify(names)).replace('__CELL__', String(CELL)).replace('__POSE__', JSON.stringify(POSE)));
      return;
    }
    const path = join(ROOT, url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.css': 'text/css' }[extname(path)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--use-gl=angle', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 110 + CELL * 4, height: CELL * names.length + 8 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__PREVIEW_READY === true, null, { timeout: 180000 });

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await page.screenshot({ path: join(ROOT, OUT), type: 'png', timeout: 120000 });
const debug = await page.evaluate(() => window.__POSE_DEBUG || null).catch(() => null);
await browser.close();
server.close();
console.log(JSON.stringify({ out: OUT, models: names, debug, errors }, null, 2));
if (errors.length) process.exit(1);
