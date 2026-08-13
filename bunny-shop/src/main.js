// Boot, input and the frame loop.

import * as THREE from 'three';
import { Audio } from './audio.js';
import { clipsFrom, loadAll } from './assets.js';
import { Game } from './game.js';
import * as CONFIG from './config.js';
import { STOCK } from './config.js';
import { createWorld, dressShop, frameCamera } from './scene.js';
import { UI } from './ui.js';

const BUNNIES = ['bunny_round', 'bunny_lanky'];
const ANIMS = ['idle', 'walk', 'jump', 'run', 'hurt'];
const PROPS = ['counter', 'shelf', 'crate', 'sign', 'plant', 'basket', 'bell', 'trenchcoat'];

const canvas = document.querySelector('#stage');
const pad = document.querySelector('#pad');
const { renderer, scene, camera } = createWorld(canvas);

// ----------------------------------------------------------------- layout

// Touch controls appear on anything without a precise pointer, and on any
// window too small to show the counter — a phone on its side is wide but very
// short, so height counts as much as width here.
const coarse = matchMedia('(pointer: coarse)');
const narrow = matchMedia('(max-width: 760px), (max-height: 520px)');

let camHome = camera.position.clone();
let camFocus = new THREE.Vector3(0, 1.15, -0.8);

const useTouch = () => coarse.matches || narrow.matches;

// Short and wide: one row of produce with the bell alongside. Otherwise two
// rows stacked above a full-width bell.
const padWide = () => innerWidth > innerHeight && innerHeight < 560;

function padHeight() {
  if (!useTouch()) return 0;
  return padWide() ? 78 : 176;
}

function applyLayout() {
  const touch = useTouch();
  const root = document.documentElement;
  root.classList.toggle('touch', touch);
  root.classList.toggle('pad-wide', touch && padWide());
  pad.hidden = !touch;
  root.style.setProperty('--pad-h', `${padHeight()}px`);
  resize();
}

function resize() {
  // Size from the canvas box, not the window: on touch layouts the pad has
  // taken a slice of the screen and the 3D view is only what is left.
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h, false);
  ({ eye: camHome, focus: camFocus } = frameCamera(camera, w / h));
}

addEventListener('resize', applyLayout);
addEventListener('orientationchange', applyLayout);
coarse.addEventListener('change', applyLayout);
narrow.addEventListener('change', applyLayout);

const ui = new UI({ camera, canvas });
const audio = new Audio();

applyLayout();

// ------------------------------------------------------------------ load

const names = [
  ...PROPS,
  ...STOCK.map((s) => s.id),
  ...BUNNIES,
  ...BUNNIES.flatMap((b) => ANIMS.map((a) => `${b}.${a}`)),
];

const startBtn = document.querySelector('#start');
const loadNote = document.querySelector('#loadnote');

const gltf = await loadAll(names, (done, total) => {
  loadNote.textContent = `Unpacking rabbits — ${done}/${total}`;
}).catch((err) => {
  loadNote.textContent = `Could not load ${err.message}. Run tools/tripo.mjs to build the assets.`;
  throw err;
});

// Group the animation exports back onto the rig they belong to.
const clips = {};
for (const b of BUNNIES) {
  clips[b] = clipsFrom(Object.fromEntries(ANIMS.map((a) => [a, gltf[`${b}.${a}`]])));
}

const shop = dressShop(scene, gltf);
const game = new Game({ scene, gltf, clips, ui, audio, obstacles: shop.obstacles, clickable: shop.clickable });

startBtn.disabled = false;
startBtn.textContent = 'Open the Shop';
loadNote.textContent = 'Warning: contains rabbits.';

// ----------------------------------------------------------------- input

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;

function setPointer(event) {
  const r = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((event.clientY - r.top) / r.height) * 2 + 1;
}

// What is under the cursor: a counter fixture, or a rabbit.
function hit() {
  raycaster.setFromCamera(pointer, camera);

  const fixtures = raycaster.intersectObjects(shop.clickable, false);
  if (fixtures.length) return { ...fixtures[0].object.userData, distance: fixtures[0].distance };

  for (const s of game.shoppers) {
    const found = raycaster.intersectObject(s.body.root, true);
    if (found.length) return { kind: 'shopper', shopper: s, distance: found[0].distance };
  }
  return null;
}

canvas.addEventListener('pointermove', (e) => {
  // A finger has no hover state; tracking it would leave a crate stuck up.
  if (e.pointerType !== 'mouse') return;
  setPointer(e);
  parallax.x = pointer.x;
  parallax.y = pointer.y;
  if (!game.running) return;
  hovered = hit();
  canvas.classList.toggle('pointing', !!hovered);
});

canvas.addEventListener('pointerleave', () => {
  hovered = null;
  parallax.x = 0;
  parallax.y = 0;
});

canvas.addEventListener('pointerdown', (e) => {
  if (!game.running) return;
  e.preventDefault();
  setPointer(e);
  const target = hit();
  if (!target) return;
  if (target.kind === 'crate') game.clickCrate(target.id);
  else if (target.kind === 'bell') game.clickBell();
  else if (target.kind === 'shopper') game.clickShopper(target.shopper);
  else if (target.kind === 'incident') game.solveIncident();
});

// Number keys bag produce without hunting for the crate.
addEventListener('keydown', (e) => {
  if (!game.running) return;
  const n = Number(e.key);
  if (n >= 1 && n <= STOCK.length) game.clickCrate(STOCK[n - 1].id);
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    game.clickBell();
  }
});

// ------------------------------------------------------------- touch pad

const padStock = document.querySelector('#pad-stock');
padStock.replaceChildren(
  ...STOCK.map((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stock-btn';
    btn.dataset.id = item.id;
    btn.innerHTML = `<span class="glyph"></span><span class="label"></span><span class="need"></span>`;
    btn.querySelector('.glyph').textContent = item.emoji;
    btn.querySelector('.label').textContent = item.label;
    btn.addEventListener('click', () => game.running && game.clickCrate(item.id));
    return btn;
  }),
);
ui.bindPad(padStock, document.querySelector('#pad-bell'));

document.querySelector('#pad-bell').addEventListener('click', () => game.running && game.clickBell());

// The alert is the reliable way to deal with an incident: the rabbit causing it
// may be behind a shelf, or off the edge of a phone screen entirely.
document.querySelector('#alert').addEventListener('click', () => game.running && game.solveIncident());

// --------------------------------------------------------------- curtains

startBtn.addEventListener('click', () => {
  audio.resume();
  document.querySelector('#title').hidden = true;
  game.start();
});

document.querySelector('#again').addEventListener('click', () => {
  document.querySelector('#gameover').hidden = true;
  game.start();
});

// ------------------------------------------------------------------ loop

const parallax = { x: 0, y: 0 };
let last = performance.now();
let t = 0;

function frame() {
  // Long frames (a background tab, a stall) must not teleport rabbits.
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  t += dt;

  game.update(dt);
  ui.update();

  // Crates lift a little when you point at them, so the counter feels alive.
  for (const c of shop.crates) {
    const lift = hovered?.kind === 'crate' && hovered.id === c.item.id ? 0.07 : 0;
    c.crate.position.y += (c.home.y + lift - c.crate.position.y) * Math.min(1, dt * 14);
    c.sample.position.y = c.crate.position.y + 0.2;
    c.sample.rotation.y += dt * 0.5;
  }

  // The bell hops when the order is ready to be rung up.
  const bounce = game.bellReady ? Math.abs(Math.sin(t * 6)) * 0.07 : 0;
  shop.bell.position.y = shop.bell.userData.baseY + bounce;

  // A whisper of camera drift toward the cursor. tools/shot.mjs pins the camera
  // when it wants to inspect a particular corner of the shop.
  if (!window.__freezeCamera) {
    camera.position.x += (camHome.x + parallax.x * 0.42 - camera.position.x) * Math.min(1, dt * 2.2);
    camera.position.y += (camHome.y - parallax.y * 0.28 - camera.position.y) * Math.min(1, dt * 2.2);
    camera.lookAt(camFocus);
  } else {
    camera.lookAt(...window.__lookAt);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

shop.bell.userData.baseY = shop.bell.position.y;

// Exposed for tools/shot.mjs and tools/playtest.mjs, which assert on live state.
window.__game = game;
window.__cfg = CONFIG;
window.__shop = shop;
window.__THREE = THREE;

frame();
