// Churn — an interactive volumetric fluid tank.
//
// A 3D stable-fluids simulation (GPU, Z-slice atlas) drives a foam density
// field inside a tank of deep water. Rendering: full-res opaque pass
// (paddle), reduced-res volumetric raymarch with a per-frame light volume
// (MRT: inscatter + rgb transmittance), composite, bloom, ACES post.

import * as THREE from '../vendor/three.module.min.js';
import { Fluid } from './fluid.js';
import { Particles } from './particles.js';
import { initChrome } from './chrome.js';
import {
  buildPhysicsPanel, buildScenePanel, buildCodePanel, armBurst,
  gridOverride, particleOverride, tankOverride,
} from './panel.js';
import {
  FS_TRI_VERT, RAYMARCH_VERT, RAYMARCH_FRAG, COMPOSITE_FRAG,
  BRIGHT_FRAG, BLUR_FRAG, POST_FRAG, PADDLE_VERT, PADDLE_FRAG, PROBE_FRAG,
} from './shaders.js';

const QUALITY = {
  low: { N: 64, jacobi: 12, steps: 88, scale: 0.6, ptex: 192 },
  med: { N: 81, jacobi: 18, steps: 116, scale: 0.7, ptex: 288 },
  high: { N: 100, jacobi: 22, steps: 148, scale: 0.8, ptex: 384 },
  ultra: { N: 128, jacobi: 26, steps: 176, scale: 0.85, ptex: 448 },
};

const query = new URLSearchParams(location.search);
// ?view=foam: raw foam density, no lighting and no particles — isolates what
// the solver produced from how it is shaded
const debugFoam = query.get('view') === 'foam';
// ?diag=1: peak foam / peak speed, read back from the GPU into the HUD
const wantProbe = query.get('diag') === '1';
const qName = QUALITY[query.get('q')] ? query.get('q') : 'high';
// ?n= and ?p= override the preset's grid and particle count independently, so
// the two halves of "quality" can be traded off against each other
const Q = { ...QUALITY[qName] };
Q.N = gridOverride(query, Q.N);
const particleTarget = particleOverride(query, Q.ptex * Q.ptex);
Q.ptex = Math.max(16, Math.round(Math.sqrt(particleTarget)));

const params = {
  quality: qName,
  stir: query.get('stir') !== '0',
  stirSpeed: 1.0,
  autoSpin: query.get('spin') === '1',
  spinSpeed: 0.22, // camera orbit, rad/s
  paddleSpin: query.get('pspin') === '1',
  paddleSpinSpeed: Math.min(Math.max(+(query.get('pss') || 0) || 3.0, 0.5), 10), // rad/s
  exposure: 1.25,
  paused: false,
  dtCap: Math.min(Math.max(+(query.get('dtcap') || 0) || 1 / 30, 1 / 240), 0.15),
};

const canvas = document.getElementById('gl');
const boot = document.getElementById('boot');

function fail(msg) {
  boot.querySelector('.boot-sub').textContent = msg;
  boot.classList.add('error');
  throw new Error(msg);
}

// Probe WebGL2 on a throwaway canvas: calling getContext on the real canvas
// would fix its context attributes before WebGLRenderer sets its own.
if (!document.createElement('canvas').getContext('webgl2')) {
  fail('WebGL2 is required and not available in this browser.');
}

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false,
  powerPreference: 'high-performance',
});
renderer.setClearColor(0x000000, 1);
renderer.autoClear = false;
if (!renderer.getContext().getExtension('EXT_color_buffer_float')) {
  fail('This browser cannot render to float textures (EXT_color_buffer_float).');
}

const getDPR = () => Math.min(window.devicePixelRatio || 1, 1.75);
const sunDir = new THREE.Vector3(0.30, -1.0, -0.35).normalize();
// The tank is filled to here, with air above: a real waterline is what makes
// plumes mushroom out along the surface instead of piling into a ceiling.
// The tank is a box inside the [-1,1] grid; everything outside it is solid, so
// resizing it never disturbs the solver's uniform voxel spacing. The waterline
// keeps the same fraction of the tank height whatever the size.
const FILL = 0.72;
let tankHalf = tankOverride(query, 1);
let SURFACE_Y = FILL * tankHalf;

const fluid = new Fluid(renderer, {
  N: Q.N, jacobi: Q.jacobi, lightDir: sunDir, surfaceY: SURFACE_Y, tank: tankHalf,
});
fluid.clear();
const particles = new Particles(renderer, fluid, Q.ptex);

// ----------------------------------------------------------------- camera --

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
const orbit = { az: 0.5, el: 0.30, dist: 3.4 };
function updateCamera() {
  orbit.el = Math.max(-0.55, Math.min(1.25, orbit.el));
  orbit.dist = Math.max(1.7, Math.min(8, orbit.dist));
  const ce = Math.cos(orbit.el);
  camera.position.set(
    Math.sin(orbit.az) * ce * orbit.dist,
    Math.sin(orbit.el) * orbit.dist,
    Math.cos(orbit.az) * ce * orbit.dist);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
}
updateCamera();

// ----------------------------------------------------------------- scenes --

const opaqueScene = new THREE.Scene();

const PADDLE_HALF_BASE = new THREE.Vector3(0.30, 0.05, 0.20);
const paddleHalf = PADDLE_HALF_BASE.clone();
let paddleScale = 1;
const paddleMat = new THREE.ShaderMaterial({
  vertexShader: PADDLE_VERT,
  fragmentShader: PADDLE_FRAG,
  uniforms: { uSunDir: { value: sunDir }, uHover: { value: 0 } },
});
const paddle = new THREE.Mesh(
  new THREE.BoxGeometry(paddleHalf.x * 2, paddleHalf.y * 2, paddleHalf.z * 2), paddleMat);
paddle.position.set(0.45, -0.25, 0.1);
opaqueScene.add(paddle);

const barrelHalf = new THREE.Vector3(0.13, 0.17, 0.13);
const barrelMat = new THREE.ShaderMaterial({
  vertexShader: PADDLE_VERT,
  fragmentShader: PADDLE_FRAG,
  uniforms: { uSunDir: { value: sunDir }, uHover: { value: 0 } },
});
// A pool, so every click drops another barrel and several can be in flight.
const MAX_BARRELS = 6;
const barrelGeo = new THREE.BoxGeometry(barrelHalf.x * 2, barrelHalf.y * 2, barrelHalf.z * 2);
const barrels = Array.from({ length: MAX_BARRELS }, () => {
  const mesh = new THREE.Mesh(barrelGeo, barrelMat);
  mesh.visible = false;
  opaqueScene.add(mesh);
  return {
    mesh,
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    age: 0,
    active: false,
    splashed: false,
    // handed to the solver unchanged each frame, so nothing allocates per step
    desc: { pos: mesh.position, vel: null, radius: 0.16 },
  };
});
for (const b of barrels) b.desc.vel = b.vel;

const edgeScene = new THREE.Scene();
const edges = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
  new THREE.LineBasicMaterial({
    color: new THREE.Color(0.10, 0.22, 0.30),
    transparent: true, opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false,
  }));
edgeScene.add(edges);

// ---------------------------------------------------------- render targets --

let W = 2, H = 2;
const depthTexture = new THREE.DepthTexture(W, H);
depthTexture.type = THREE.UnsignedIntType;
depthTexture.minFilter = THREE.NearestFilter;
depthTexture.magFilter = THREE.NearestFilter;

const opaqueRT = new THREE.WebGLRenderTarget(W, H, {
  type: THREE.HalfFloatType, depthTexture, depthBuffer: true, stencilBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});
const volRT = new THREE.WebGLRenderTarget(W, H, {
  type: THREE.HalfFloatType, count: 2, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});
const compRT = new THREE.WebGLRenderTarget(W, H, {
  type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});
const bloomRT = () => new THREE.WebGLRenderTarget(W, H, {
  type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});
const bloom1 = bloomRT(), bloom2 = bloomRT(), bloom3 = bloomRT(), bloom4 = bloomRT();

// ------------------------------------------------------- fullscreen passes --

const fsScene = new THREE.Scene();
const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.BufferAttribute(
  new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const fsMesh = new THREE.Mesh(fsGeo, null);
fsMesh.frustumCulled = false;
fsScene.add(fsMesh);
function fsPass(material, target) {
  fsMesh.material = material;
  renderer.setRenderTarget(target);
  renderer.render(fsScene, fsCamera);
}

// ?diag=1 liveness probe (see PROBE_FRAG): a 16x16 reduction of the foam and
// velocity volumes, read back every few frames. Costs nothing when off.
let probeRT = null, mProbe = null, probePixels = null, probeText = '—';
if (wantProbe) {
  probeRT = new THREE.WebGLRenderTarget(16, 16, {
    type: THREE.FloatType, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  mProbe = new THREE.ShaderMaterial({
    vertexShader: FS_TRI_VERT, fragmentShader: PROBE_FRAG,
    depthTest: false, depthWrite: false,
    uniforms: { uFoam: { value: null }, uVel: { value: null },
      uPrs: { value: null }, uDiv: { value: null } },
  });
  probePixels = new Float32Array(16 * 16 * 4);
}
function readProbe() {
  if (!mProbe) return;
  mProbe.uniforms.uFoam.value = fluid.foamTexture;
  mProbe.uniforms.uVel.value = fluid.vel[0].texture;
  mProbe.uniforms.uPrs.value = fluid.prs[0].texture;
  mProbe.uniforms.uDiv.value = fluid.div.texture;
  fsPass(mProbe, probeRT);
  renderer.readRenderTargetPixels(probeRT, 0, 0, 16, 16, probePixels);
  let mf = 0, mv = 0, mp = 0, md = 0;
  for (let i = 0; i < 16 * 16; i++) {
    mf = Math.max(mf, probePixels[i * 4]);
    mv = Math.max(mv, probePixels[i * 4 + 1]);
    mp = Math.max(mp, probePixels[i * 4 + 2]);
    md = Math.max(md, probePixels[i * 4 + 3]);
  }
  probeText = `${mf.toFixed(3)} / ${mv.toFixed(1)} / p${mp.toFixed(1)} / d${md.toFixed(1)}`;
  renderer.setRenderTarget(null);
}

const volUniforms = {
  uNi: { value: Q.N }, uNf: { value: Q.N },
  uTi: { value: fluid.T }, uAtlas: { value: new THREE.Vector2(fluid.W, fluid.H) },
};
const mRaymarch = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: RAYMARCH_VERT,
  fragmentShader: RAYMARCH_FRAG,
  depthTest: false, depthWrite: false,
  uniforms: {
    ...volUniforms,
    uFoamTex: { value: null },
    uLightTex: { value: null },
    uDepth: { value: depthTexture },
    uInvProjView: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uCamFwd: { value: new THREE.Vector3() },
    uNear: { value: camera.near }, uFar: { value: camera.far },
    uSteps: { value: Q.steps },
    uFrame: { value: 0 },
    uTime: { value: 0 },
    uSurfaceY: { value: SURFACE_Y },
    uTank: { value: tankHalf },
    uChop: { value: 1 },
    uDebugFoam: { value: debugFoam ? 1 : 0 },
    uRipples: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -100, 0)) },
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Vector3(3.6, 3.8, 3.9) },
    uWaterAbsorb: { value: new THREE.Vector3(1.30, 0.50, 0.26) },
    uWaterScatter: { value: new THREE.Vector3(0.020, 0.046, 0.076) },
    uFoamScatter: { value: 7.0 },
    uFoamAbsorb: { value: 0.35 },
    uAmbientTop: { value: new THREE.Vector3(0.11, 0.16, 0.20) },
    uAmbientDeep: { value: new THREE.Vector3(0.008, 0.03, 0.055) },
  },
});
const mComposite = new THREE.ShaderMaterial({
  vertexShader: FS_TRI_VERT, fragmentShader: COMPOSITE_FRAG,
  depthTest: false, depthWrite: false,
  uniforms: {
    uScene: { value: opaqueRT.texture },
    uVolLight: { value: volRT.textures[0] },
    uVolTrans: { value: volRT.textures[1] },
  },
});
const mBright = new THREE.ShaderMaterial({
  vertexShader: FS_TRI_VERT, fragmentShader: BRIGHT_FRAG,
  depthTest: false, depthWrite: false,
  uniforms: { uSrc: { value: compRT.texture }, uThreshold: { value: 0.75 } },
});
const mBlur = new THREE.ShaderMaterial({
  vertexShader: FS_TRI_VERT, fragmentShader: BLUR_FRAG,
  depthTest: false, depthWrite: false,
  uniforms: { uSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
});
const mPost = new THREE.ShaderMaterial({
  vertexShader: FS_TRI_VERT, fragmentShader: POST_FRAG,
  depthTest: false, depthWrite: false,
  uniforms: {
    uSrc: { value: compRT.texture },
    uBloomA: { value: bloom1.texture },
    uBloomB: { value: bloom3.texture },
    uExposure: { value: params.exposure },
    uTime: { value: 0 },
  },
});

function resize() {
  const dpr = getDPR();
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
  if (w === W && h === H) return;
  W = w; H = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  opaqueRT.setSize(w, h);
  const vw = Math.floor(w * Q.scale), vh = Math.floor(h * Q.scale);
  volRT.setSize(vw, vh);
  compRT.setSize(w, h);
  const q2w = Math.max(w >> 2, 2), q2h = Math.max(h >> 2, 2);
  const q3w = Math.max(w >> 3, 2), q3h = Math.max(h >> 3, 2);
  bloom1.setSize(q2w, q2h); bloom2.setSize(q2w, q2h);
  bloom3.setSize(q3w, q3h); bloom4.setSize(q3w, q3h);
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------- interaction --

const raycaster = new THREE.Raycaster();
const pointers = new Map();
const drag = {
  mode: null,         // 'paddle' | 'orbit'
  moved: 0, t0: 0,
  plane: new THREE.Plane(),
  offset: new THREE.Vector3(),
  last: { x: 0, y: 0 },
  pinch: 0,
};
const paddleTarget = paddle.position.clone();
const paddleVel = new THREE.Vector3();
let lastInteract = -10;
let stirPhase = Math.random() * 20;

function pointerRay(e) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

function rayBox(ray) {
  const inv = new THREE.Vector3(1 / ray.direction.x, 1 / ray.direction.y, 1 / ray.direction.z);
  const a = new THREE.Vector3(-1, -1, -1).sub(ray.origin).multiply(inv);
  const b = new THREE.Vector3(1, 1, 1).sub(ray.origin).multiply(inv);
  const lo = a.clone().min(b), hi = a.clone().max(b);
  const t0 = Math.max(lo.x, lo.y, lo.z), t1 = Math.min(hi.x, hi.y, hi.z);
  return t1 > Math.max(t0, 0) ? [Math.max(t0, 0), t1] : null;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    drag.pinch = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    drag.mode = 'pinch';
    return;
  }
  if (pointers.size > 2) return; // extra fingers don't disturb an active pinch
  drag.moved = 0;
  drag.t0 = performance.now();
  drag.last = { x: e.clientX, y: e.clientY };
  pointerRay(e);
  const hit = paddleHidden ? [] : raycaster.intersectObject(paddle, false);
  if (hit.length) {
    drag.mode = 'paddle';
    drag.plane.setFromNormalAndCoplanarPoint(
      camera.getWorldDirection(new THREE.Vector3()).negate(), paddle.position);
    drag.offset.copy(hit[0].point).sub(paddle.position);
    paddleTarget.copy(paddle.position); // don't dart back to the auto-stir path
    lastInteract = clock.elapsedTime;
  } else {
    drag.mode = 'orbit';
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (drag.mode === 'pinch') {
    if (pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (drag.pinch > 0) orbit.dist *= drag.pinch / d;
      drag.pinch = d;
      updateCamera();
    }
    return;
  }
  if (pointers.size > 1) return;
  if (!drag.mode) {
    // hover highlight
    pointerRay(e);
    paddleMat.uniforms.uHover.value =
      !paddleHidden && raycaster.intersectObject(paddle, false).length ? 1 : 0;
    return;
  }
  const dx = e.clientX - drag.last.x, dy = e.clientY - drag.last.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.last = { x: e.clientX, y: e.clientY };
  if (drag.mode === 'orbit') {
    orbit.az -= dx * 0.005;
    orbit.el += dy * 0.005;
    updateCamera();
  } else if (drag.mode === 'paddle') {
    const ray = pointerRay(e);
    const p = new THREE.Vector3();
    if (ray.intersectPlane(drag.plane, p)) {
      paddleTarget.copy(p.sub(drag.offset));
      paddleTarget.clampScalar(-0.66 * tankHalf, 0.66 * tankHalf); // inside the glass
    }
    lastInteract = clock.elapsedTime;
  }
});

function endPointer(e, cancelled) {
  pointers.delete(e.pointerId);
  if (drag.mode === 'pinch') {
    if (pointers.size < 2) drag.mode = null;
    return;
  }
  const quick = !cancelled && performance.now() - drag.t0 < 280 && drag.moved < 8;
  if (quick && drag.mode === 'orbit') {
    const ray = pointerRay(e);
    const t = rayBox(ray);
    if (t) {
      const p = ray.origin.clone().addScaledVector(ray.direction, t[0] + (t[1] - t[0]) * 0.35);
      fluid.burst = { pos: p.clampScalar(-0.92 * tankHalf, 0.92 * tankHalf), vel: 1.4, foam: 0.55 };
      lastInteract = clock.elapsedTime;
    }
  }
  drag.mode = null;
}
canvas.addEventListener('pointerup', (e) => endPointer(e, false));
canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist *= Math.exp(e.deltaY * 0.0012);
  updateCamera();
}, { passive: false });

const spinBtn = document.getElementById('spin-btn');
const spinPaddleBtn = document.getElementById('spin-paddle-btn');
const stirBtn = document.getElementById('stir-btn');
function syncButtons() {
  spinBtn.classList.toggle('active', params.autoSpin);
  spinBtn.setAttribute('aria-pressed', String(params.autoSpin));
  spinPaddleBtn.classList.toggle('active', params.paddleSpin);
  spinPaddleBtn.setAttribute('aria-pressed', String(params.paddleSpin));
  stirBtn.classList.toggle('active', params.stir);
  stirBtn.setAttribute('aria-pressed', String(params.stir));
}
// The paddle wanders on its own until you touch it; this is what "swirl kicks
// in by itself" is. The physics panel's swirl knob is vorticity confinement and
// does not drive the paddle, so stopping the motion belongs on its own control.
function setStir(v) {
  params.stir = v;
  syncButtons();
}
stirBtn.addEventListener('click', () => setStir(!params.stir));
function toggleSpin() {
  params.autoSpin = !params.autoSpin;
  syncButtons();
}
function togglePaddleSpin() {
  params.paddleSpin = !params.paddleSpin;
  syncButtons();
}
spinBtn.addEventListener('click', toggleSpin);
spinPaddleBtn.addEventListener('click', togglePaddleSpin);
document.getElementById('barrel-btn').addEventListener('click', () => dropBarrel());

// paddle spin rate
const speedSlider = document.getElementById('spin-speed-slider');
const speedVal = document.getElementById('spin-speed-val');
speedSlider.value = params.paddleSpinSpeed;
speedVal.textContent = params.paddleSpinSpeed.toFixed(1);
speedSlider.addEventListener('input', () => {
  params.paddleSpinSpeed = +speedSlider.value;
  speedVal.textContent = params.paddleSpinSpeed.toFixed(1);
  if (!params.paddleSpin) { params.paddleSpin = true; syncButtons(); }
});

// The paddle can be taken out of the tank entirely: hidden and uncoupled, so
// the water is left to whatever the barrels and bursts do to it.
const hidePaddleBtn = document.getElementById('hide-paddle-btn');
let paddleHidden = false;
function setPaddleHidden(v) {
  paddleHidden = v;
  paddle.visible = !v;
  hidePaddleBtn.classList.toggle('active', v);
  hidePaddleBtn.setAttribute('aria-pressed', String(v));
  spinPaddleBtn.disabled = v;
  speedSlider.disabled = v;
  if (v) {
    paddleVel.set(0, 0, 0);
    paddleAngVel.set(0, 0, 0);
  }
}
hidePaddleBtn.addEventListener('click', () => setPaddleHidden(!paddleHidden));

buildPhysicsPanel(fluid.physics);
function setTank(v) {
  tankHalf = v;
  SURFACE_Y = FILL * tankHalf;
  fluid.tank = tankHalf;
  fluid.surfaceY = SURFACE_Y;
  mRaymarch.uniforms.uTank.value = tankHalf;
  mRaymarch.uniforms.uSurfaceY.value = SURFACE_Y;
  edges.scale.setScalar(tankHalf);
  paddleTarget.clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
  paddle.position.clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
}

buildScenePanel({
  gridN: Q.N,
  particleCount: particles.count,
  tankHalf,
  onTank: setTank,
  paddleScale,
  onPaddleScale: (v) => {
    paddleScale = v;
    // the geometry is authored once, so the mesh scales and the solver's
    // half-extents follow; extractRotation drops the scale, so the rigid-body
    // coupling is unaffected
    paddleHalf.copy(PADDLE_HALF_BASE).multiplyScalar(v);
    paddle.scale.setScalar(v);
    paddle.updateMatrixWorld();
  },
});
setTank(tankHalf);   // apply ?tank= to the glass, surface and clamps
buildCodePanel(() => ({
  backend: 'WebGL2', N: Q.N, jacobi: Q.jacobi, particleCount: particles.count,
  tankHalf, paddleScale, physics: fluid.physics,
}));
syncButtons();
initChrome({ backend: 'WebGL2' }); // hide-ui, fullscreen, backend switch

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { dropBarrel(); e.preventDefault(); }
  else if (e.code === 'KeyO') toggleSpin();
  else if (e.code === 'KeyR') togglePaddleSpin();
  else if (e.code === 'KeyX') setPaddleHidden(!paddleHidden);
  else if (e.code === 'KeyB') dropBarrel();
  else if (e.code === 'KeyC') fluid.clear();
  else if (e.code === 'KeyP') params.paused = !params.paused;
  else if (e.code === 'KeyQ') {
    const names = Object.keys(QUALITY);
    const q = new URLSearchParams(location.search);
    q.set('q', names[(names.indexOf(params.quality) + 1) % names.length]);
    if (params.stir) q.delete('stir'); else q.set('stir', '0');
    location.search = `?${q}`;
  }
});

// -------------------------------------------------------------- gpu timers --

// GPU timer with CPU fallback: CPU wall time always fills the readout, and
// real GPU query results overwrite it whenever they resolve (they may never
// resolve on software renderers).
class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.ms = {};
    this.gpuLive = false;
  }
  begin(name) {
    this.cpu = performance.now();
    this.name = name;
    if (!this.ext) return;
    this.query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
  }
  end() {
    const name = this.name;
    if (!this.gpuLive) {
      this.ms[name] = (this.ms[name] ?? 0) * 0.9 + (performance.now() - this.cpu) * 0.1;
    }
    if (!this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ name, query: this.query });
    while (this.pending.length > 8) this.gl.deleteQuery(this.pending.shift().query);
  }
  poll() {
    if (!this.ext) return;
    while (this.pending.length) {
      const { name, query } = this.pending[0];
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      if (!this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        const ns = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
        this.ms[name] = this.gpuLive ? (this.ms[name] ?? 0) * 0.8 + (ns / 1e6) * 0.2 : ns / 1e6;
        this.gpuLive = true;
      }
      this.gl.deleteQuery(query);
      this.pending.shift();
    }
  }
}
const timer = new GpuTimer(renderer.getContext());

// --------------------------------------------------------------------- hud --

const statEls = {};
for (const el of document.querySelectorAll('[data-k]')) statEls[el.dataset.k] = el;
const fpsCounter = { frames: 0, t: performance.now() / 1000, fps: 0 };

function updateHud() {
  const vramMiB = Math.round((fluid.bytes + particles.bytes +
    (W * H * 8) * 3 + (W * H * 8 * Q.scale * Q.scale) * 2) / (1 << 20));
  if (statEls.backend) statEls.backend.textContent = 'WebGL2';
  statEls.res.textContent = `${W} × ${H}`;
  statEls.grid.textContent = `${Q.N}³ · ${(Q.N ** 3 / 1e6).toFixed(2)} M voxels`;
  const unit = timer.gpuLive ? 'GPU' : 'CPU';
  statEls.simLabel.textContent = `Simulate, ${unit}`;
  statEls.renLabel.textContent = `Render, ${unit}`;
  statEls.sim.textContent = timer.ms.sim ? `${timer.ms.sim.toFixed(2)} ms` : '—';
  statEls.ren.textContent = timer.ms.render ? `${timer.ms.render.toFixed(2)} ms` : '—';
  statEls.parts.textContent = `${(particles.count / 1000).toFixed(1)} K`;
  statEls.fps.textContent = fpsCounter.fps ? fpsCounter.fps.toFixed(1) : '—';
  if (statEls.fpsBadge) statEls.fpsBadge.textContent = fpsCounter.fps
    ? fpsCounter.fps.toFixed(fpsCounter.fps < 10 ? 1 : 0) : '—';
  statEls.vram.textContent = `${vramMiB} MiB`;
  if (wantProbe) { readProbe(); statEls.vram.textContent += `  ·  foam/vel ${probeText}`; }
  statEls.stir.textContent = paddleHidden
    ? 'paddle off'
    : (params.stir ? 'auto' : 'manual') + (params.paddleSpin ? ' + spin' : '');
}

// -------------------------------------------------------------------- loop --

// Manual clock: capped dt is also what accumulates into elapsed time, so the
// simulation clock stays consistent when frames are slow (or dtcap is raised
// for headless captures).
const clock = {
  last: performance.now() / 1000,
  elapsedTime: 0,
  rawDelta: 0, // uncapped wall-clock dt, for camera motion that ignores pause/warp
  getDelta(paused) {
    const now = performance.now() / 1000;
    this.rawDelta = Math.min(now - this.last, 0.1);
    const dt = paused ? 0 : Math.min(now - this.last, params.dtCap);
    this.last = now;
    this.elapsedTime += dt;
    return dt;
  },
};
let frames = 0;
const seedBursts = [
  { t: 0.15, pos: new THREE.Vector3(-0.30, -0.45, 0.05), vel: 1.2, foam: 0.5 },
  { t: 0.45, pos: new THREE.Vector3(0.35, -0.25, 0.30), vel: 1.0, foam: 0.4 },
  { t: 0.80, pos: new THREE.Vector3(0.05, -0.55, -0.30), vel: 1.3, foam: 0.45 },
];

const prevPaddle = paddle.position.clone();
const instVel = new THREE.Vector3();
const rotMat3 = new THREE.Matrix3();
const rotMat4 = new THREE.Matrix4();
const paddleAngVel = new THREE.Vector3();
const prevQuat = paddle.quaternion.clone();
const dQuat = new THREE.Quaternion();
const angInst = new THREE.Vector3();
let spinAngle = 0;
const paddleState = {
  on: true, pos: paddle.position, vel: paddleVel, angVel: paddleAngVel,
  half: paddleHalf, rot: rotMat3,
};

function updatePaddle(dt, t) {
  if (paddleHidden) {
    // keep the trackers current so re-showing it doesn't spike the velocity
    prevPaddle.copy(paddle.position);
    prevQuat.copy(paddle.quaternion);
    paddleVel.set(0, 0, 0);
    paddleAngVel.set(0, 0, 0);
    fluid.paddle = null;
    return;
  }
  const stirring = params.stir && (t - lastInteract > 4 || lastInteract < 0);
  if (stirring && drag.mode !== 'paddle') {
    const s = stirPhase + t * params.stirSpeed;
    paddleTarget.set(
      0.55 * Math.sin(0.62 * s + 1.0),
      -0.12 + 0.42 * Math.sin(0.47 * s + 2.1),
      0.55 * Math.sin(0.83 * s + 4.0));
    if (!params.paddleSpin) {
      paddle.rotation.set(
        0.55 * Math.sin(0.50 * s),
        0.35 * s,
        0.45 * Math.sin(0.71 * s + 1.0));
    }
  }
  if (params.paddleSpin) {
    // paddle-wheel mode: the blade turns end-over-end about a horizontal
    // axle (like a paddle-boat motor), sweeping down through the water and
    // driving a directional current
    spinAngle += dt * params.paddleSpinSpeed;
    paddle.rotation.set(spinAngle, 0.35, 0.0);
  }
  const k = 1 - Math.exp(-dt * (drag.mode === 'paddle' ? 20 : 6));
  paddle.position.lerp(paddleTarget, k);
  paddle.updateMatrixWorld();

  instVel.copy(paddle.position).sub(prevPaddle).divideScalar(Math.max(dt, 1e-4));
  paddleVel.lerp(instVel, 1 - Math.exp(-dt * 12));
  prevPaddle.copy(paddle.position);

  // angular velocity measured from the quaternion delta, so tumbling and
  // spinning both transfer rotational momentum into the fluid
  dQuat.copy(prevQuat).invert().premultiply(paddle.quaternion);
  if (dQuat.w < 0) { dQuat.x *= -1; dQuat.y *= -1; dQuat.z *= -1; dQuat.w *= -1; }
  const half = Math.min(Math.acos(Math.min(dQuat.w, 1)), 1.5);
  const sinHalf = Math.sin(half);
  if (sinHalf > 1e-5 && dt > 1e-4) {
    angInst.set(dQuat.x, dQuat.y, dQuat.z).divideScalar(sinHalf)
      .multiplyScalar(2 * half / dt).clampLength(0, 12);
  } else {
    angInst.set(0, 0, 0);
  }
  paddleAngVel.lerp(angInst, 1 - Math.exp(-dt * 12));
  prevQuat.copy(paddle.quaternion);

  rotMat4.extractRotation(paddle.matrixWorld);
  rotMat3.setFromMatrix4(rotMat4).transpose(); // world -> local
  fluid.paddle = paddleState;
}

// ------------------------------------------------------------------ barrel --

// Impact ripples: a tiny ring buffer the surface shader reads as expanding
// rings (xz centre, start time, strength).
let rippleNext = 0;
function addRipple(x, z, strength) {
  const r = mRaymarch.uniforms.uRipples.value[rippleNext % 4];
  rippleNext++;
  r.set(x, z, clock.elapsedTime % 512, strength);
}

const explosionQueue = [];
const lastBlast = { pos: new THREE.Vector3(), until: -1 };
const liveBarrels = [];   // reused array of descriptors for the solver

function dropBarrel() {
  // reuse a free slot, or recycle the oldest one if all six are busy
  let b = barrels.find((x) => !x.active);
  if (!b) b = barrels.reduce((a, x) => (x.age > a.age ? x : a), barrels[0]);
  b.active = true;
  b.age = 0;
  b.splashed = false;
  b.mesh.position.set((Math.random() - 0.5) * 1.2 * tankHalf, 0.95 * tankHalf,
    (Math.random() - 0.5) * 1.2 * tankHalf);
  b.mesh.rotation.set(Math.random() * 0.5, Math.random() * 6.28, Math.random() * 0.5);
  b.vel.set((Math.random() - 0.5) * 0.2, -2.3, (Math.random() - 0.5) * 0.2);
  b.spin.set(1.1, 0.4, 0.8);
  b.mesh.visible = true;
}

function updateBarrels(dt, t) {
  liveBarrels.length = 0;
  for (const b of barrels) {
    if (!b.active) continue;
    b.age += dt;
    const p = b.mesh.position;
    const wasAbove = p.y > SURFACE_Y;

    // falls freely through the air gap, then meets real drag in the water
    b.vel.y -= (wasAbove ? 6.0 : 1.8) * dt;
    b.vel.multiplyScalar(Math.exp(-dt * (wasAbove ? 0.15 : 2.3)));
    p.addScaledVector(b.vel, dt);
    p.x = Math.max(-0.8, Math.min(0.8, p.x));
    p.z = Math.max(-0.8, Math.min(0.8, p.z));
    b.mesh.rotation.x += b.spin.x * dt;
    b.mesh.rotation.y += b.spin.y * dt;
    b.mesh.rotation.z += b.spin.z * dt;
    b.mesh.updateMatrixWorld();

    if (wasAbove && p.y <= SURFACE_Y && !b.splashed) {
      // breaking the surface: an air cavity punched in at the waterline, plus
      // the ring of waves running out from the impact
      b.splashed = true;
      explosionQueue.push(
        { pos: new THREE.Vector3(p.x, SURFACE_Y - 0.05, p.z), vel: 0.55, up: -1.2, foam: 0.35, radius: 0.20 },
        { pos: new THREE.Vector3(p.x, SURFACE_Y - 0.15, p.z), vel: 0.28, up: 0.5, foam: 0.2, radius: 0.16 },
      );
      addRipple(p.x, p.z, 1.0);
    }

    if (p.y < -0.5 || b.age > 2.2) {
      // implode, then blow: a suck inward, then a radial+upward blast with a
      // huge foam release that buoyancy turns into the erupting column
      b.active = false;
      b.mesh.visible = false;
      const q = p.clone();
      // implosion, then the blast — and the blast seeds a vortex ring that
      // widens as it rises, which is what rolls the cap into a mushroom
      explosionQueue.push(
        { pos: q, vel: -2.0, up: -0.3, foam: 0.0, radius: 0.42 },
        { pos: q, vel: -1.2, up: 0.0, foam: 0.18, radius: 0.36 },
        { pos: q, vel: 3.2, up: 1.2, foam: 0.42, radius: 0.36, ring: 2.6, ringR: 0.28 },
        { pos: q, vel: 1.8, up: 0.9, foam: 0.24, radius: 0.44, ring: 2.0, ringR: 0.36 },
        { pos: q, vel: 0.9, up: 0.6, foam: 0.14, radius: 0.52, ring: 1.4, ringR: 0.44 },
      );
      lastBlast.pos.copy(q);
      lastBlast.until = t + 1.6;
      addRipple(q.x, q.z, 1.3);
      continue;
    }

    if (p.y < SURFACE_Y) liveBarrels.push(b.desc); // no wake while still in air
  }
  fluid.barrels = liveBarrels;
}

function frame() {
  requestAnimationFrame(frame);
  resize();
  const dt = clock.getDelta(params.paused);
  const t = clock.elapsedTime;

  if (params.autoSpin && drag.mode !== 'orbit' && drag.mode !== 'pinch') {
    orbit.az += clock.rawDelta * params.spinSpeed;
    updateCamera();
  }

  while (seedBursts.length && seedBursts[0].t <= t) {
    const b = seedBursts.shift();
    if (!fluid.burst) fluid.burst = b;
  }

  if (!params.paused) {
    updatePaddle(dt, t);
    updateBarrels(dt, t);
    if (!fluid.burst && explosionQueue.length) {
      // scale on arming, so the sliders affect explosions already queued
      fluid.burst = armBurst(explosionQueue.shift(), fluid.physics);
    }
    timer.begin('sim');
    // wrapped time keeps float hash/noise inputs precise over long sessions
    fluid.step(dt, t % 512);
    // bubble sparkle follows the action: the sinking barrel, then its blast
    // site, otherwise the paddle (tip speed counts when spinning in place)
    let emitter = paddle.position;
    let effSpeed = paddleHidden
      ? 0 : Math.max(paddleVel.length(), paddleAngVel.length() * 0.28);
    const diving = barrels.find((b) => b.active && b.mesh.position.y < SURFACE_Y);
    if (diving) {
      emitter = diving.mesh.position;
      effSpeed = Math.max(diving.vel.length(), 0.6);
    } else if (t < lastBlast.until) {
      emitter = lastBlast.pos;
      effSpeed = 2.0;
    }
    particles.step(dt, t % 512, emitter, effSpeed);
    timer.end();
  }

  timer.begin('render');
  // opaque
  renderer.setRenderTarget(opaqueRT);
  renderer.clear(true, true);
  renderer.render(opaqueScene, camera);

  // volume
  const u = mRaymarch.uniforms;
  u.uFoamTex.value = fluid.foamTexture;
  u.uLightTex.value = fluid.lightTexture;
  u.uInvProjView.value.copy(camera.projectionMatrix)
    .multiply(camera.matrixWorldInverse).invert();
  u.uCamPos.value.copy(camera.position);
  camera.getWorldDirection(u.uCamFwd.value);
  u.uFrame.value = frames % 64;
  u.uTime.value = t % 512;
  u.uChop.value = fluid.physics.chop;
  fsPass(mRaymarch, volRT);

  // composite + tank edges + bubble sparkle
  fsPass(mComposite, compRT);
  renderer.setRenderTarget(compRT);
  renderer.render(edgeScene, camera);
  // the foam view is meant to show the solver's output alone
  if (!debugFoam) particles.draw(camera, H);

  // bloom
  fsPass(mBright, bloom1);
  mBlur.uniforms.uSrc.value = bloom1.texture;
  mBlur.uniforms.uDir.value.set(1 / Math.max(bloom1.width, 2), 0);
  fsPass(mBlur, bloom2);
  mBlur.uniforms.uSrc.value = bloom2.texture;
  mBlur.uniforms.uDir.value.set(0, 1 / Math.max(bloom2.height, 2));
  fsPass(mBlur, bloom1);
  mBlur.uniforms.uSrc.value = bloom1.texture;
  mBlur.uniforms.uDir.value.set(1 / Math.max(bloom3.width, 2), 0);
  fsPass(mBlur, bloom4);
  mBlur.uniforms.uSrc.value = bloom4.texture;
  mBlur.uniforms.uDir.value.set(0, 1 / Math.max(bloom4.height, 2));
  fsPass(mBlur, bloom3);

  // post
  mPost.uniforms.uTime.value = t;
  mPost.uniforms.uExposure.value = params.exposure;
  fsPass(mPost, null);
  timer.end();
  timer.poll();

  frames++;
  window.water.frames = frames;
  fpsCounter.frames++;
  const wall = performance.now() / 1000; // real time, not the capped sim clock
  if (wall - fpsCounter.t > 0.5) {
    fpsCounter.fps = fpsCounter.frames / (wall - fpsCounter.t);
    fpsCounter.frames = 0;
    fpsCounter.t = wall;
    updateHud();
  }
  if (frames === 3) boot.classList.add('hidden');
}

// ------------------------------------------------------------------ handle --

window.water = {
  params, fluid, orbit, frames: 0,
  burst(x, y, z, foam = 0.5, vel = 1.2) {
    fluid.burst = { pos: new THREE.Vector3(x, y, z).clampScalar(-0.92 * tankHalf, 0.92 * tankHalf), vel, foam };
  },
  paddleTo(x, y, z) {
    paddleTarget.set(x, y, z).clampScalar(-0.66 * tankHalf, 0.66 * tankHalf);
    lastInteract = clock.elapsedTime;
  },
  dropBarrel,
  physics: fluid.physics,
  setPaddleHidden: (v) => setPaddleHidden(v),
  isPaddleHidden: () => paddleHidden,
  camera(az, el, dist) {
    orbit.az = az; orbit.el = el; orbit.dist = dist;
    updateCamera();
  },
  clear: () => fluid.clear(),
};

resize();
updateCamera();
requestAnimationFrame(frame);
