import * as THREE from 'three';
import { clamp, damp, mulberry32, rand, TAU } from './util.js';
import { buildCoop, updateMotes } from './coop.js';
import { spawnFlock, spawnBertha } from './chicken.js';
import { FX } from './fx.js';
import { CoopAudio } from './audio.js';
import { UI } from './ui.js';

const params = new URLSearchParams(location.search);
const seed = parseInt(params.get('seed') ?? '', 10);
const rng = mulberry32(Number.isFinite(seed) ? seed : (Math.random() * 2 ** 31) | 0);

// ---- renderer / scene ------------------------------------------------------

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x120c07);

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);

// ---- world -----------------------------------------------------------------

const audio = new CoopAudio();
const ui = new UI(audio);
const fx = new FX(scene, rng);

let shakeAmt = 0;      // camera shake, decays every frame
let bulbSwing = 0;     // how hard the hanging bulb is swinging
let calmTime = 0;      // seconds since the last incident
let signDays = 0;

const EGG_GEO = new THREE.SphereGeometry(0.075, 9, 7);
EGG_GEO.scale(0.82, 1, 0.82);
const EGG_MAT = new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.55 });
const GOLD_MAT = new THREE.MeshStandardMaterial({
  color: 0xe0a233, roughness: 0.22, metalness: 0.7, emissive: 0x2e1c04,
});

const world = {
  scene, camera, rng, ui, audio, fx,
  time: 0,
  chickens: [],
  eggs: [],
  bertha: null,
  coop: null,

  spawnEgg(pos) {
    const golden = rng() < 0.1;
    const egg = new THREE.Mesh(EGG_GEO, golden ? GOLD_MAT : EGG_MAT);
    egg.position.set(pos.x, 0.055, pos.z);
    egg.rotation.set(rand(rng, -0.2, 0.2), rand(rng, 0, TAU), rand(rng, -0.2, 0.2));
    egg.castShadow = true;
    // Eggs are laid with a bit of momentum and roll until they settle.
    egg.userData = {
      egg: true, golden,
      vel: new THREE.Vector3(rand(rng, -0.55, 0.55), 0, rand(rng, -0.55, 0.55)),
    };
    scene.add(egg);
    world.eggs.push(egg);
    if (golden) for (let i = 0; i < 5; i++) fx.puff(pos, 0xffd88a);
  },

  shake(amount) {
    shakeAmt = Math.min(0.5, shakeAmt + amount);
    bulbSwing = Math.min(0.16, bulbSwing + amount * 0.5);
  },

  // Big Bertha put a foot down.
  thud(c) {
    world.shake(0.11);
    fx.puff(c.pos, 0x9a7f5c);
    audio.thud();
  },

  // Something happened. The sign goes back to zero, as it always does.
  incident() {
    calmTime = 0;
    if (signDays !== 0) { signDays = 0; world.coop.drawSign(0); }
  },
};

world.coop = buildCoop(scene, rng);
const flock = spawnFlock(world, 7);
world.bertha = spawnBertha(world);
world.chickens = [...flock, world.bertha];

// ---- lights ----------------------------------------------------------------

scene.add(new THREE.HemisphereLight(0xffe2b8, 0x3a2c1c, 0.55));

// Sun coming in through the window on the +X wall.
const sun = new THREE.DirectionalLight(0xffe0a8, 2.4);
sun.position.set(9.5, 5.5, -1.9);
sun.target.position.set(0.6, 0, -0.3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 2;
sun.shadow.camera.far = 20;
sun.shadow.camera.left = -6; sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6; sun.shadow.camera.bottom = -6;
sun.shadow.bias = -0.002;
scene.add(sun, sun.target);

// Warm bulb hanging mid-coop.
const bulbLight = new THREE.PointLight(0xffd9a0, 14, 14, 1.8);
bulbLight.position.copy(world.coop.bulbPos);
bulbLight.castShadow = true;
bulbLight.shadow.mapSize.set(512, 512);
bulbLight.shadow.bias = -0.004;
scene.add(bulbLight);

// ---- camera orbit (constrained to the inside of the coop) ------------------

const orbit = {
  target: new THREE.Vector3(0, 0.9, -0.2),
  theta: 2.45, phi: 1.22, r: 4.4,
  thetaT: 2.45, phiT: 1.22, rT: 4.4,
  lastInput: -10,
};

function applyCamera(dt) {
  // Idle drift: after a while the camera slowly circles the coop on its own.
  if (world.time - orbit.lastInput > 10) orbit.thetaT += dt * 0.03;

  orbit.theta = damp(orbit.theta, orbit.thetaT, 10, dt);
  orbit.phi = damp(orbit.phi, orbit.phiT, 10, dt);
  orbit.r = damp(orbit.r, orbit.rT, 8, dt);

  const sp = Math.sin(orbit.phi);
  camera.position.set(
    orbit.target.x + orbit.r * sp * Math.sin(orbit.theta),
    orbit.target.y + orbit.r * Math.cos(orbit.phi),
    orbit.target.z + orbit.r * sp * Math.cos(orbit.theta));
  camera.position.x = clamp(camera.position.x, -4.55, 4.55);
  camera.position.z = clamp(camera.position.z, -4.55, 4.55);
  camera.position.y = clamp(camera.position.y, 0.35, 3.8);

  // Footfall shake, applied before lookAt so the whole view jolts.
  shakeAmt = Math.max(0, shakeAmt - dt * 0.85);
  if (shakeAmt > 0.001) {
    const t = world.time;
    camera.position.x += Math.sin(t * 47.3) * shakeAmt * 0.085;
    camera.position.y += Math.sin(t * 61.7) * shakeAmt * 0.105;
    camera.position.z += Math.cos(t * 53.1) * shakeAmt * 0.085;
  }
  camera.lookAt(orbit.target);
}

// ---- input -----------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragging = false;
let dragDist = 0;
let lastX = 0, lastY = 0;
let pinchDist = 0;

function setNDC(e) {
  pointerNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
}

canvas.addEventListener('pointerdown', (e) => {
  ui.dismissHint();
  dragging = true;
  dragDist = 0;
  lastX = e.clientX; lastY = e.clientY;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    orbit.thetaT -= dx * 0.0055;
    orbit.phiT = clamp(orbit.phiT + dy * 0.004, 0.62, 1.52);
    orbit.lastInput = world.time;
  } else {
    // Hover: show the chicken's name.
    setNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hit = raycaster.intersectObjects(world.chickens.map((c) => c.root), true)[0];
    if (hit) {
      const c = hit.object.userData.chicken;
      const p = c.pos.clone().add(new THREE.Vector3(0, 0.85 * c.scale, 0)).project(camera);
      ui.showTag(c.name, (p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight);
      canvas.classList.add('pointing');
    } else {
      ui.hideTag();
      canvas.classList.remove('pointing');
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const wasDragging = dragging;
  dragging = false;
  if (!wasDragging || dragDist > 9) return; // a touch "tap" is never pixel-perfect
  // A click, not a drag: poke a chicken, collect an egg, or toss seeds.
  setNDC(e);
  raycaster.setFromCamera(pointerNDC, camera);

  const chickenHit = raycaster.intersectObjects(world.chickens.map((c) => c.root), true)[0];
  if (chickenHit) {
    const c = chickenHit.object.userData.chicken;
    if (c.big) {
      c.force('bigGlare'); // she does not startle. she notices.
      return;
    }
    c.force('panic', { short: true });
    c.startHop(c.pos.clone(), 0.35, 0.4);
    audio.squawk(1.2);
    return;
  }

  const eggHit = raycaster.intersectObjects(world.eggs)[0];
  if (eggHit) {
    const egg = eggHit.object;
    scene.remove(egg);
    world.eggs.splice(world.eggs.indexOf(egg), 1);
    if (egg.userData.golden) {
      ui.addEgg(5);
      audio.fanfare();
      for (let i = 0; i < 8; i++) fx.puff(egg.position, 0xffd88a);
    } else {
      ui.addEgg();
      audio.pop();
      fx.puff(egg.position, 0xf2ead8);
    }
    return;
  }

  // The bulb is asking to be swung at, hanging there like that.
  const bulbHit = raycaster.intersectObject(world.coop.bulbRig, true)[0];
  if (bulbHit) {
    bulbSwing = 0.2;
    audio.bonk();
    for (const c of flock) {
      if (rng() < 0.6) c.force('lookAt', { at: { pos: world.coop.bulbPos }, up: true });
    }
    return;
  }

  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(floorPlane, p) && Math.abs(p.x) < 4.6 && Math.abs(p.z) < 4.6) {
    p.x = clamp(p.x, -4.2, 4.2);
    p.z = clamp(p.z, -4.2, 4.2);
    const patch = fx.seeds(p);
    audio.cluck(0.8);
    for (const c of flock) {
      if (c.pos.distanceTo(p) < 5.5 && rng() < 0.85 && c.bhv.name !== 'panic') {
        c.force('seedRush', { patch });
      }
    }
    // Sometimes it is enough to wake the matriarch, which changes everything.
    const b = world.bertha;
    if (b && b.bhv.name !== 'bigSeedRush' && rng() < 0.5) b.force('seedRush', { patch });
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.rT = clamp(orbit.rT * (1 + Math.sign(e.deltaY) * 0.09), 1.4, 5.6);
  orbit.lastInput = world.time;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY);
    if (pinchDist > 0) orbit.rT = clamp(orbit.rT * (pinchDist / d), 1.4, 5.6);
    pinchDist = d;
    orbit.lastInput = world.time;
  }
}, { passive: true });
canvas.addEventListener('touchend', () => { pinchDist = 0; });

// ---- resize ----------------------------------------------------------------

let laidOut = false;
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);

  // A portrait phone has a narrow horizontal field of view, so the default
  // desktop framing leaves the flock tiny in the middle of a lot of floor.
  // Start closer and more level there. Only once — after that it is the
  // player's camera, and a device rotation should not snatch it back.
  if (!laidOut) {
    laidOut = true;
    if (innerWidth < innerHeight) {
      orbit.r = orbit.rT = 3.05;
      orbit.phi = orbit.phiT = 1.31;
      orbit.target.y = 0.8;
    }
  }
}
addEventListener('resize', resize);
resize();

// ---- main loop -------------------------------------------------------------

let nextAmbient = 2;

// Two chickens running flat out into each other both go down. Only pairs
// where at least one is sprinting count, so a crowded feeder stays peaceful.
function chickenCollisions() {
  const list = world.chickens;
  const busy = (c) => c.big || c.riding || c.perch || c.hop || c.bhv.name === 'bonk';
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (busy(a)) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (busy(b)) continue;
      if (!(a.move?.speed > 1.7) && !(b.move?.speed > 1.7)) continue;
      const reach = a.rad + b.rad - 0.1;
      if (a.pos.distanceToSquared(b.pos) < reach * reach) {
        a.force('bonk', { from: b });
        b.force('bonk', { from: a });
        break; // a is on the floor now; stop pairing her up
      }
    }
  }
}

function rollEggs(dt) {
  for (const egg of world.eggs) {
    const v = egg.userData.vel;
    if (!v || v.lengthSq() < 1e-5) continue;
    egg.position.x = clamp(egg.position.x + v.x * dt, -4.25, 4.25);
    egg.position.z = clamp(egg.position.z + v.z * dt, -4.25, 4.25);
    egg.rotation.x += v.z * dt * 7;
    egg.rotation.z -= v.x * dt * 7;
    v.multiplyScalar(Math.max(0, 1 - dt * 2.6));
    if (v.lengthSq() < 1e-4) v.set(0, 0, 0);
  }
}

function step(dt) {
  world.time += dt;
  for (const c of world.chickens) c.update(dt);
  chickenCollisions();
  rollEggs(dt);
  fx.update(dt, world.time);
  updateMotes(world.coop, world.time);

  // The bulb hums along with a barely-there flicker, and swings when the
  // floor gets hit. The point light rides with it so the shadows swing too.
  bulbSwing = Math.max(0, bulbSwing - dt * 0.045);
  const rig = world.coop.bulbRig;
  rig.rotation.z = Math.sin(world.time * 3.1) * bulbSwing;
  rig.rotation.x = Math.cos(world.time * 2.7) * bulbSwing * 0.7;
  rig.updateMatrixWorld();
  world.coop.bulbMesh.getWorldPosition(bulbLight.position);
  bulbLight.intensity = 14 * (1 + Math.sin(world.time * 11) * 0.02 + Math.sin(world.time * 3.7) * 0.015);

  // The sign counts up in calm and is reset by the first thing that happens.
  calmTime += dt;
  if (calmTime > 14) {
    calmTime = 0;
    signDays++;
    world.coop.drawSign(signDays);
  }

  nextAmbient -= dt;
  if (nextAmbient <= 0) {
    nextAmbient = rand(rng, 2.5, 7);
    audio.bok(rand(rng, 0.85, 1.25));
  }
}

const handle = {
  frames: 0, world, camera, renderer, orbit,
  // Fast-forward hook for the test harness.
  step(n, dt = 1 / 30) { for (let i = 0; i < n; i++) step(dt); },
};
window.chickenGame = handle;

let prev = performance.now();
renderer.setAnimationLoop((now) => {
  // Clamp below as well: the first frame's timestamp can predate `prev`.
  const dt = clamp((now - prev) / 1000, 0, 0.05);
  prev = now;
  step(dt);
  applyCamera(dt);
  renderer.render(scene, camera);
  handle.frames++;
});
