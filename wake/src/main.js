import * as THREE from 'three';
import { PARAMS, get, set } from './params.js';
import { WakeField } from './wakeField.js';
import { Ocean } from './ocean.js';
import { makeBoat } from './boat.js';
import { buildUI } from './ui.js';

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0a1017);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xa8c0d8, 1.1));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);

// The Kelvin waves are the finest thing the field has to carry, and at 1024
// over a 340 m window (~0.33 m/texel) their cusp lines visibly stair-step.
// 2048 fixes it, at 4x the memory -- so phones keep the smaller one.
const narrow = matchMedia('(max-width: 720px)').matches;
const wake = new WakeField(renderer, narrow ? 1024 : 2048);
const ocean = new Ocean(wake, 520, 560);
scene.add(ocean.mesh);

const boat = makeBoat();
scene.add(boat);

// --------------------------------------------------------------- boat state --
// Position is the BOW: the arms are born there, so that is the anchor.
const state = { x: 0, z: 0, heading: 0, t: 0, speed: 0 };

// --------------------------------------------------------------------- boot --
const hud = document.getElementById('hud');

function setView(mode) {
  if (mode === 'top') { view.topDown = true; view.pitch = -Math.PI / 2; view.yaw = 0; }
  if (mode === 'chase') { view.topDown = false; view.pitch = -0.42; view.yaw = 0; view.dist = 46; }
  if (mode === 'field') hud.dataset.field = hud.dataset.field === '1' ? '' : '1';
  syncViewButtons();
}

function syncViewButtons() {
  for (const b of hud.querySelectorAll('[data-view]')) {
    const m = b.dataset.view;
    b.classList.toggle('on', m === 'field' ? hud.dataset.field === '1'
                           : m === 'top' ? view.topDown : !view.topDown);
  }
}

for (const b of hud.querySelectorAll('[data-view]'))
  b.addEventListener('click', () => setView(b.dataset.view));

for (const b of hud.querySelectorAll('[data-zoom]'))
  b.addEventListener('click', () => zoomBy(b.dataset.zoom === 'in' ? 0.72 : 1.38));

// On a phone the rail covers most of the screen, so the canvas gets it first.
if (narrow) document.body.classList.add('rail-closed');

const railToggle = document.getElementById('rail-toggle');
railToggle?.addEventListener('click', () => {
  const closed = document.body.classList.toggle('rail-closed');
  railToggle.setAttribute('aria-expanded', String(!closed));
});
railToggle?.setAttribute('aria-expanded', String(!narrow));

// Cost defaults follow the device; both stay editable in the Performance group.
if (narrow || devicePixelRatio > 2.5) {
  set('quality.renderScale', 1);
  set('quality.oceanDetail', 260);
} else {
  set('quality.renderScale', Math.min(devicePixelRatio, 2));
}
const ui = buildUI(document.getElementById('ui'), {
  onChange: () => boat.userData.scaleTo(),
});

// ------------------------------------------------------------------- camera --
// Straight down by default, because that is the view the reference is shot from
// and the only one where the wake's geometry is unambiguous.
const view = { pitch: -Math.PI / 2, yaw: 0, dist: 155, topDown: true, follow: true };

// Camera input. One pointer orbits, two pinch to zoom and twist the heading —
// on a phone there is no wheel, so pinch is the only way to get the whole wake
// in frame, and without it the view is stuck wherever it started.
const pointers = new Map();
let pinch = null;

const zoomBy = (f) => { view.dist = THREE.MathUtils.clamp(view.dist * f, 6, 1400); };

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = null;
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    view.yaw -= (e.clientX - prev.x) * 0.005;
    view.pitch = THREE.MathUtils.clamp(view.pitch - (e.clientY - prev.y) * 0.005, -Math.PI / 2, -0.03);
    view.topDown = false;
    syncViewButtons();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const span = Math.hypot(a.x - b.x, a.y - b.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (pinch) {
      if (pinch.span > 1) zoomBy(pinch.span / Math.max(span, 1));
      let d = ang - pinch.ang;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      view.yaw += d;
    }
    pinch = { span, ang };
  }
});

const release = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
addEventListener('pointerup', release);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomBy(Math.exp(e.deltaY * 0.0012));
}, { passive: false });

// Double-tap / double-click reframes, so a lost view is always one gesture away.
canvas.addEventListener('dblclick', () => setView('top'));

const keys = new Set();
const STEER_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown']);

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  // Arrows would scroll the page out from under the canvas.
  if (STEER_KEYS.has(k)) e.preventDefault();
  if (k === 't') setView('top');
  if (k === 'h') document.body.classList.toggle('hide-ui');
  if (k === 'f') setView('field');
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ----------------------------------------------------------------- wake view --
// A small inset showing the raw field texture, so it is obvious whether an odd
// look is coming from the wake maths or from the water shading.
const fieldScene = new THREE.Scene();
const fieldCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fieldQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { uTex: { value: wake.rt.texture } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }',
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D uTex;
    void main(){
      vec4 t = texture2D(uTex, vUv);
      // white = surface foam, teal = subsurface bubbles, dim red = displacement
      vec3 c = vec3(clamp(t.r, 0.0, 1.5)) * 0.8;
      c += vec3(0.0, 0.55, 0.62) * clamp(t.a, 0.0, 1.5) * 0.75;
      c.r += clamp(abs(t.g) * 0.9, 0.0, 0.5) * 0.35;
      gl_FragColor = vec4(pow(c, vec3(0.85)), 1.0);
    }`,
}));
fieldScene.add(fieldQuad);

// URL overrides: ?arms.angle=18&boat.speed=15 — handy for headless captures.
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k.includes('.')) set(k, v);
  else if (k === 'cam') { const [p, y, d] = v.split(',').map(Number); view.pitch = p; view.yaw = y; view.dist = d; view.topDown = false; }
}

const viewport = { w: 1, h: 1 };   // CSS pixels

function resize() {
  const w = Math.max(innerWidth, 1), h = Math.max(innerHeight, 1);
  viewport.w = w; viewport.h = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// --------------------------------------------------------------------- loop --
let last = performance.now();
let fpsAcc = 0, fpsN = 0;
let lastScale = -1;

// Sim is stepped independently of rendering, so a slow (or headless) frame rate
// shortens the wake rather than silently rewinding the boat.
function stepSim(dt) {
  state.t += dt;

  // Up/down arrows work the throttle rather than setting a speed: they move the
  // target, the hull's own inertia does the rest, and the slider follows so the
  // panel never disagrees with the boat.
  const rate = get('boat.throttleRate') * dt;
  let throttle = 0;
  if (keys.has('arrowup')) throttle += rate;
  if (keys.has('arrowdown')) throttle -= rate;
  if (throttle !== 0) {
    const lim = PARAMS.boat.speed;
    set('boat.speed', Math.max(lim.min, Math.min(lim.max, get('boat.speed') + throttle)));
    ui.refresh();
  }

  let target = get('boat.speed');
  let turn = get('boat.turnRate') * Math.PI / 180;

  const hard = keys.has('shift') ? get('boat.hardTurn') : 1;
  const steer = get('boat.steerRate') * Math.PI / 180 * hard;
  if (keys.has('arrowleft') || keys.has('a')) turn -= steer;
  if (keys.has('arrowright') || keys.has('d')) turn += steer;
  if (keys.has('w')) target *= 1.6;
  if (keys.has('s')) target *= 0.35;

  // The slider is a target, not the speed. A hull cannot step from rest to
  // planing in one frame, and if it does the wake it emits steps with it --
  // which is what puts a straight cut across the water behind.
  const a = get('boat.accel') * dt;
  state.speed += Math.sign(target - state.speed) * Math.min(a, Math.abs(target - state.speed));

  state.heading += turn * dt;
  const hx = Math.sin(state.heading), hz = Math.cos(state.heading);
  state.x += hx * state.speed * dt;
  state.z += hz * state.speed * dt;
  wake.pushSample(state.x, state.z, hx, hz, state.t, state.speed);
  return { hx, hz };
}

// ?prewarm=90 — run 90 seconds of boat before the first frame, so a capture (or
// a reload mid-tuning) starts with a full-length wake instead of a stub.
const PREWARM = +(new URLSearchParams(location.search).get('prewarm') ?? NaN) || window.__PREWARM || 0;
for (let i = 0; i < PREWARM * 30; i++) stepSim(1 / 30);

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const { hx, hz } = stepSim(dt);
  boat.position.set(state.x, 0, state.z);
  boat.rotation.y = state.heading;
  // Centre the field a little astern: that is where the wake actually is.
  wake.focus(state.x - hx * get('field.extent') * 0.28, state.z - hz * get('field.extent') * 0.28);
  wake.update(state.t);

  // Camera: chase from behind and above, or straight down.
  const cy = Math.sin(-view.pitch), cr = Math.cos(-view.pitch);
  const yaw = view.topDown ? state.heading : state.heading + view.yaw;
  const off = new THREE.Vector3(-Math.sin(yaw) * cr, cy, -Math.cos(yaw) * cr).multiplyScalar(view.dist);
  const look = new THREE.Vector3(state.x - hx * view.dist * 0.16, 0, state.z - hz * view.dist * 0.16);
  camera.position.copy(look).add(off);
  camera.up.set(0, 1, 0);
  camera.lookAt(look);

  const sd = new THREE.Vector3(
    Math.cos(get('ocean.sunElev') * Math.PI / 180) * Math.sin(get('ocean.sunAzim') * Math.PI / 180),
    Math.sin(get('ocean.sunElev') * Math.PI / 180),
    Math.cos(get('ocean.sunElev') * Math.PI / 180) * Math.cos(get('ocean.sunAzim') * Math.PI / 180),
  );
  sun.position.copy(sd).multiplyScalar(200).add(boat.position);
  sun.target.position.copy(boat.position);
  sun.target.updateMatrixWorld();

  const scale = Math.min(devicePixelRatio, get('quality.renderScale'));
  if (scale !== lastScale) { lastScale = scale; renderer.setPixelRatio(scale); resize(); }
  ocean.setDetail(get('quality.oceanDetail'));

  ocean.update(state.t, camera.position, state.x, state.z, wake);

  renderer.setViewport(0, 0, viewport.w, viewport.h);
  renderer.setScissorTest(false);
  renderer.render(scene, camera);

  if (hud.dataset.field === '1') {
    const s = Math.round(Math.min(viewport.w, viewport.h) * 0.3);
    const m = 12;
    renderer.setScissorTest(true);
    renderer.setViewport(m, m, s, s);
    renderer.setScissor(m, m, s, s);
    renderer.render(fieldScene, fieldCam);
    renderer.setScissorTest(false);
  }

  fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++;
  if (fpsN >= 30) {
    hud.querySelector('#fps').textContent = `${Math.round(fpsAcc / fpsN)} fps`;
    fpsAcc = 0; fpsN = 0;
  }
  window.__ready = true;
}
requestAnimationFrame(frame);

// Expose for the headless capture harness.
window.__wake = { PARAMS, set, get, state, view, renderer, wake, ocean, stepSim };
