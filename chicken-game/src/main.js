import * as THREE from 'three';
import { clamp, damp, mulberry32, rand, TAU } from './util.js';
import { buildCoop, updateMotes } from './coop.js';
import { spawnFlock, spawnBertha } from './chicken.js';
import { isResumable } from './behaviors.js';
import { FX } from './fx.js';
import { CoopAudio } from './audio.js';
import { UI } from './ui.js';
import { EV, EventQueue, LocalTransport, TICK_DT } from './net.js';
import { DOOR, YARD, bounds, zoneOf } from './zones.js';

const params = new URLSearchParams(location.search);
const seedParam = parseInt(params.get('seed') ?? '', 10);
const SEED = Number.isFinite(seedParam) ? seedParam : (Math.random() * 2 ** 31) | 0;

// Two independent streams. `rng` decides what the coop does and must be drawn
// from identically by every client; `fxRng` only jitters particles, which are
// dropped when a pool is full and so cannot be trusted to stay in step.
// See net.js for the full set of rules this simulation keeps to.
const rng = mulberry32(SEED);
const fxRng = mulberry32(SEED ^ 0x9e3779b9);

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

// Far plane clears the sky dome from anywhere in the yard.
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 160);

// ---- world -----------------------------------------------------------------

const audio = new CoopAudio();
const ui = new UI(audio);
const fx = new FX(scene, fxRng);

// Player input becomes tick-stamped events and is applied inside the tick
// loop. Swapping LocalTransport for a socket-backed one is the whole of the
// client-side change needed to make the coop shared.
const transport = new LocalTransport();
const events = new EventQueue();
transport.onEvent((e) => events.add(e));

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
const WORM_GEO = new THREE.CapsuleGeometry(0.035, 0.2, 3, 6);
const WORM_MAT = new THREE.MeshStandardMaterial({ color: 0xc2707e, roughness: 0.7 });

// The hawk is only ever a shadow on the ground, which is scarier and also
// means there is no bird to model.
const HAWK_MAT = new THREE.MeshBasicMaterial({
  color: 0x0d1408, transparent: true, opacity: 0, depthWrite: false,
});
const hawkShadow = new THREE.Mesh(new THREE.CircleGeometry(1.15, 18), HAWK_MAT);
hawkShadow.rotation.x = -Math.PI / 2;
hawkShadow.scale.set(1, 1, 1.9);
hawkShadow.visible = false;
scene.add(hawkShadow);

const world = {
  scene, camera, rng, ui, audio, fx,
  seed: SEED,
  tick: 0,           // simulation clock; the only time the world agrees on
  time: 0,           // tick * TICK_DT, kept for animation phases
  chickens: [],
  eggs: [],
  nextEggId: 1,      // eggs need stable ids so "collected" is sendable
  bertha: null,
  coop: null,

  // Where the audience is standing, as shared world state. One entry per
  // connected viewer; chickens pick which one to fixate on. Seeded with the
  // default camera spot so a chicken can stare at you on the very first tick,
  // before any WATCH event has been sent.
  watchers: [{ id: 'local', pos: new THREE.Vector3(2.6, 1.7, -3.3) }],
  audienceFallback: new THREE.Vector3(2.6, 1.7, -3.3),

  // Shared world state a viewer can change.
  door: { open: true },
  worm: null,                     // { pos, taken, mesh }
  hawk: { active: false, t: 0 },

  dropWorm(x, z) {
    if (world.worm) world.clearWorm();
    const mesh = new THREE.Mesh(WORM_GEO, WORM_MAT);
    mesh.position.set(x, 0.045, z);
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    scene.add(mesh);
    world.worm = { pos: new THREE.Vector3(x, 0, z), taken: false, mesh };
    // Everyone outside drops what they are doing.
    for (const c of world.chickens) {
      if (c.big || c.zone !== 'yard') continue;
      c.force('chaseWorm');
    }
  },

  takeWorm(c) {
    if (!world.worm || world.worm.taken) return;
    world.worm.taken = true;
    fx.puff(world.worm.pos, 0xc2707e);
    world.clearWorm();
  },

  clearWorm() {
    if (!world.worm) return;
    scene.remove(world.worm.mesh);
    world.worm = null;
  },

  spawnEgg(pos) {
    const golden = rng() < 0.1;
    const egg = new THREE.Mesh(EGG_GEO, golden ? GOLD_MAT : EGG_MAT);
    egg.position.set(pos.x, 0.055, pos.z);
    egg.rotation.set(rand(rng, -0.2, 0.2), rand(rng, 0, TAU), rand(rng, -0.2, 0.2));
    egg.castShadow = true;
    // Eggs are laid with a bit of momentum and roll until they settle.
    egg.userData = {
      egg: true, golden, id: world.nextEggId++,
      vel: new THREE.Vector3(rand(rng, -0.55, 0.55), 0, rand(rng, -0.55, 0.55)),
    };
    scene.add(egg);
    world.eggs.push(egg);
    if (golden) for (let i = 0; i < 5; i++) fx.puff(pos, 0xffd88a);
  },

  removeEgg(egg) {
    const i = world.eggs.indexOf(egg);
    if (i < 0) return false;
    world.eggs.splice(i, 1);
    scene.remove(egg);
    return true;
  },

  // A few hundred bytes describing what the coop currently looks like: enough
  // for a late joiner to arrive mid-scene, and the drift correction that makes
  // lockstep safe across browsers whose Math.sin differs in the last bit.
  snapshot() {
    return {
      tick: world.tick,
      chickens: world.chickens.map((c) => [
        +c.pos.x.toFixed(3), +c.pos.y.toFixed(3), +c.pos.z.toFixed(3),
        +c.yaw.toFixed(3), c.bhv.name,
      ]),
      eggs: world.eggs.map((e) => [
        e.userData.id, +e.position.x.toFixed(2), +e.position.z.toFixed(2),
        e.userData.golden ? 1 : 0,
      ]),
    };
  },

  applySnapshot(snap) {
    world.tick = snap.tick;
    world.time = snap.tick * TICK_DT;
    snap.chickens.forEach(([x, y, z, yaw, bhv], i) => {
      const c = world.chickens[i];
      if (!c) return;
      c.pos.set(x, y, z);
      c.prevPos.copy(c.pos);
      c.yaw = c.prevYaw = yaw;
      const target = isResumable(bhv) ? bhv : (c.big ? 'bigSettle' : 'wander');
      if (c.bhv.name !== target) c.force(target);
    });
    for (const egg of [...world.eggs]) world.removeEgg(egg);
    for (const [id, x, z, golden] of snap.eggs) {
      world.spawnEgg(new THREE.Vector3(x, 0, z));
      const egg = world.eggs[world.eggs.length - 1];
      egg.userData.id = id;
      egg.userData.vel.set(0, 0, 0);
      egg.material = golden ? GOLD_MAT : EGG_MAT;
      egg.userData.golden = !!golden;
    }
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

scene.add(new THREE.HemisphereLight(0xffe2b8, 0x4a3a24, 0.62));

// The coop's door wall faces away from the sun, so from the run it would
// otherwise read as a black slab. This stands in for light bouncing off the
// sky; no shadows, so it costs almost nothing.
const skyFill = new THREE.DirectionalLight(0xbed8ee, 0.7);
skyFill.position.set(-3, 5, 14);
scene.add(skyFill);

// Sun coming in through the window on the +X wall.
const sun = new THREE.DirectionalLight(0xffe0a8, 2.4);
sun.position.set(9.5, 5.5, -1.9);
sun.target.position.set(0.6, 0, -0.3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 2;
sun.shadow.camera.far = 30;
sun.shadow.camera.left = -7.5; sun.shadow.camera.right = 7.5;
sun.shadow.camera.top = 7.5; sun.shadow.camera.bottom = -7.5;
sun.shadow.bias = -0.002;
scene.add(sun, sun.target);

// Keeping the sun's direction fixed while moving what it points at lets one
// shadow map serve both enclosures.
const SUN_OFFSET = new THREE.Vector3(8.9, 5.5, -1.6);
const SUN_FOCUS = {
  coop: new THREE.Vector3(0.6, 0, -0.3),
  yard: new THREE.Vector3(0, 0, 9.2),
};

// Warm bulb hanging mid-coop.
const bulbLight = new THREE.PointLight(0xffd9a0, 14, 14, 1.8);
bulbLight.position.copy(world.coop.bulbPos);
bulbLight.castShadow = true;
bulbLight.shadow.mapSize.set(512, 512);
bulbLight.shadow.bias = -0.004;
scene.add(bulbLight);

// ---- camera orbit (constrained to the inside of the coop) ------------------

// Two places to stand. Which one you are watching from is yours alone — it
// is not shared state — but the position you end up at is published as a
// WATCH event, so the chickens know whether you are indoors or out.
const VIEWS = {
  coop: {
    target: new THREE.Vector3(0, 0.9, -0.2), theta: 2.45, phi: 1.22, r: 4.4,
    rMin: 1.4, rMax: 5.6,
    box: { x: [-4.55, 4.55], y: [0.35, 3.8], z: [-4.55, 4.55] },
  },
  yard: {
    target: new THREE.Vector3(-0.4, 0.7, 8.9), theta: 0.16, phi: 1.03, r: 8.2,
    rMin: 2.5, rMax: 11,
    box: { x: [-7.2, 7.2], y: [0.4, 6.5], z: [5.3, 16.4] },
  },
};

const orbit = {
  view: 'coop',
  target: VIEWS.coop.target.clone(),
  targetT: VIEWS.coop.target.clone(),
  theta: 2.45, phi: 1.22, r: 4.4,
  thetaT: 2.45, phiT: 1.22, rT: 4.4,
  lastInput: -10,
};

function setView(name) {
  const v = VIEWS[name];
  if (!v || orbit.view === name) return;
  orbit.view = name;
  orbit.targetT.copy(v.target);
  orbit.thetaT = v.theta;
  orbit.phiT = v.phi;
  orbit.rT = v.r;
  orbit.lastInput = world.time;
  ui.setView(name);
}

function applyCamera(dt) {
  // Idle drift: after a while the camera slowly circles the coop on its own.
  if (world.time - orbit.lastInput > 10) orbit.thetaT += dt * 0.03;

  orbit.theta = damp(orbit.theta, orbit.thetaT, 10, dt);
  orbit.phi = damp(orbit.phi, orbit.phiT, 10, dt);
  orbit.r = damp(orbit.r, orbit.rT, 8, dt);
  // Switching views flies the anchor across rather than cutting.
  orbit.target.lerp(orbit.targetT, 1 - Math.exp(-4.5 * dt));

  const sp = Math.sin(orbit.phi);
  camera.position.set(
    orbit.target.x + orbit.r * sp * Math.sin(orbit.theta),
    orbit.target.y + orbit.r * Math.cos(orbit.phi),
    orbit.target.z + orbit.r * sp * Math.cos(orbit.theta));
  const box = VIEWS[orbit.view].box;
  camera.position.x = clamp(camera.position.x, box.x[0], box.x[1]);
  camera.position.y = clamp(camera.position.y, box.y[0], box.y[1]);
  camera.position.z = clamp(camera.position.z, box.z[0], box.z[1]);

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

  // Picking is local — a raycast is meaningless on another machine — so it
  // resolves to an index or a coordinate, and only that goes into the event.
  const chickenHit = raycaster.intersectObjects(world.chickens.map((c) => c.root), true)[0];
  if (chickenHit) {
    const c = chickenHit.object.userData.chicken;
    transport.send(EV.POKE, { chicken: world.chickens.indexOf(c) }, world.tick);
    return;
  }

  const eggHit = raycaster.intersectObjects(world.eggs)[0];
  if (eggHit) {
    transport.send(EV.COLLECT, { egg: eggHit.object.userData.id }, world.tick);
    return;
  }

  // The bulb is asking to be swung at, hanging there like that.
  if (raycaster.intersectObject(world.coop.bulbRig, true)[0]) {
    transport.send(EV.BULB, {}, world.tick);
    return;
  }

  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(floorPlane, p)) {
    const b = bounds(zoneOf(p.z));
    if (p.x > b.x0 - 1 && p.x < b.x1 + 1 && p.z > b.z0 - 1 && p.z < b.z1 + 1) {
      transport.send(EV.SEEDS, {
        x: +clamp(p.x, b.x0 + 0.25, b.x1 - 0.25).toFixed(3),
        z: +clamp(p.z, b.z0 + 0.25, b.z1 - 0.25).toFixed(3),
      }, world.tick);
    }
  }
});

// ---- events ----------------------------------------------------------------
// Applied inside the tick loop, never straight from the input handler. Every
// client runs this same function on the same event at the same tick.

function applyEvent(e) {
  switch (e.type) {
    case EV.SEEDS: {
      const patch = fx.seeds(new THREE.Vector3(e.x, 0, e.z));
      audio.cluck(0.8);
      const patchZone = zoneOf(patch.pos.z);
      for (const c of flock) {
        if (c.zone !== patchZone) continue;   // she cannot smell through a wall
        if (c.pos.distanceTo(patch.pos) < 6 && rng() < 0.85 && c.bhv.name !== 'panic') {
          c.force('seedRush', { patch });
        }
      }
      // Sometimes it is enough to wake the matriarch, which changes everything.
      const b = world.bertha;
      if (b && patchZone === 'coop' && b.bhv.name !== 'bigSeedRush' && rng() < 0.5) {
        b.force('seedRush', { patch });
      }
      break;
    }

    case EV.POKE: {
      const c = world.chickens[e.chicken];
      if (!c) break;
      if (c.big) { c.force('bigGlare'); break; } // she does not startle. she notices.
      c.force('panic', { short: true });
      c.startHop(c.pos.clone(), 0.35, 0.4);
      audio.squawk(1.2);
      break;
    }

    case EV.WATCH: {
      let watcher = world.watchers.find((x) => x.id === e.id);
      if (!watcher) {
        watcher = { id: e.id, pos: new THREE.Vector3() };
        world.watchers.push(watcher);
        // Keep the list sorted by id so every client iterates it identically.
        world.watchers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      watcher.pos.set(e.x, e.y, e.z);
      break;
    }

    case EV.LEAVE: {
      const i = world.watchers.findIndex((x) => x.id === e.id);
      if (i >= 0 && world.watchers.length > 1) world.watchers.splice(i, 1);
      break;
    }

    case EV.BULB: {
      bulbSwing = 0.2;
      audio.bonk();
      for (const c of flock) {
        if (c.zone !== 'coop') continue;
        if (rng() < 0.6) c.force('lookAt', { at: { pos: world.coop.bulbPos }, up: true });
      }
      break;
    }

    case EV.DOOR: {
      const open = !!e.open;
      if (world.door.open === open) break;
      world.door.open = open;
      ui.setDoor(open);
      audio.bonk();
      // Anyone mid-doorway notices immediately; clampToZone shoves them clear.
      for (const c of flock) {
        if (Math.abs(c.pos.z - 5) < 1.4 && rng() < 0.8) c.showEmote('question', 2.2);
      }
      break;
    }

    case EV.WORM: {
      world.dropWorm(e.x, e.z);
      audio.cluck(1.3);
      break;
    }

    case EV.HAWK: {
      world.hawk.active = true;
      world.hawk.t = 0;
      world.incident();
      audio.squawk(0.55);
      for (const c of flock) c.force('hawkPanic');
      break;
    }

    case EV.COLLECT: {
      const egg = world.eggs.find((x) => x.userData.id === e.egg);
      if (!egg) break;                       // someone else got there first
      const { golden } = egg.userData;
      const at = egg.position.clone();
      world.removeEgg(egg);
      for (let i = 0; i < (golden ? 8 : 1); i++) fx.puff(at, golden ? 0xffd88a : 0xf2ead8);
      // The egg leaving is shared; the point for it belongs to whoever tapped.
      if (e.actor === transport.actor) {
        if (golden) { ui.addEgg(5); audio.fanfare(); } else { ui.addEgg(); audio.pop(); }
      } else if (golden) {
        audio.fanfare();
      } else {
        audio.pop();
      }
      break;
    }
  }
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const v = VIEWS[orbit.view];
  orbit.rT = clamp(orbit.rT * (1 + Math.sign(e.deltaY) * 0.09), v.rMin, v.rMax);
  orbit.lastInput = world.time;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY);
    const v = VIEWS[orbit.view];
    if (pinchDist > 0) orbit.rT = clamp(orbit.rT * (pinchDist / d), v.rMin, v.rMax);
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

// ---- viewer controls -------------------------------------------------------

ui.onView = () => {
  ui.dismissHint();
  setView(orbit.view === 'coop' ? 'yard' : 'coop');
};
ui.onDoor = () => {
  ui.dismissHint();
  transport.send(EV.DOOR, { open: !world.door.open }, world.tick);
};
ui.onWorm = () => {
  ui.dismissHint();
  // Somewhere in the open part of the run, away from the doorway scuffle.
  transport.send(EV.WORM, {
    x: +rand(rng, YARD.x0 + 1.2, YARD.x1 - 1.2).toFixed(2),
    z: +rand(rng, 7.2, YARD.z1 - 1).toFixed(2),
  }, world.tick);
};
ui.onHawk = () => {
  ui.dismissHint();
  transport.send(EV.HAWK, {}, world.tick);
};
ui.setView(orbit.view);
ui.setDoor(world.door.open);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'v' || e.key === 'V') ui.onView();
});

// ---- main loop -------------------------------------------------------------

let nextAmbient = 2;

// Two chickens running flat out into each other both go down. Only pairs
// where at least one is sprinting count, so a crowded feeder stays peaceful.
function chickenCollisions() {
  const list = world.chickens;
  const busy = (c) => c.big || c.riding || c.perch || c.hop
    || c.bhv.name === 'bonk' || c.bhv.def?.tough;
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

// One simulation tick. Always exactly TICK_DT of coop time — never a
// wall-clock delta — so every client advances the world identically.
function tick() {
  const due = events.drain(world.tick);
  if (due) for (const e of due) applyEvent(e);

  for (const c of world.chickens) c.beginTick();
  world.time += TICK_DT;
  for (const c of world.chickens) c.update(TICK_DT);
  chickenCollisions();
  rollEggs(TICK_DT);
  fx.reapPatches();

  // The hawk's pass is simulation state so every client sees the shadow in
  // the same place at the same moment.
  if (world.hawk.active) {
    world.hawk.t += TICK_DT;
    if (world.hawk.t > 5) world.hawk.active = false;
  }
  // An unclaimed worm is fair game until someone gets it.
  if (world.worm && !world.worm.taken) {
    world.worm.age = (world.worm.age ?? 0) + TICK_DT;
    if (world.worm.age > 45) world.clearWorm();   // it got away
  }

  // The sign counts up in calm and is reset by the first thing that happens.
  calmTime += TICK_DT;
  if (calmTime > 14) {
    calmTime = 0;
    signDays++;
    world.coop.drawSign(signDays);
  }

  nextAmbient -= TICK_DT;
  if (nextAmbient <= 0) {
    nextAmbient = rand(rng, 2.5, 7);
    audio.bok(rand(rng, 0.85, 1.25));
  }

  world.tick++;
}

// Everything the viewer sees but the world does not depend on: particles,
// the swinging bulb, the camera. Runs at display rate with a real delta, and
// draws chickens interpolated between the last two ticks.
function render(alpha, frameDt) {
  for (const c of world.chickens) c.render(alpha);
  fx.update(frameDt, world.time);
  updateMotes(world.coop, world.time);

  // The door swings; the state it swings toward is shared, the swing is not.
  doorAngle = damp(doorAngle, world.door.open ? -1.9 : 0, 7, frameDt);
  world.coop.doorPivot.rotation.y = doorAngle;

  if (world.worm) world.worm.mesh.rotation.y = Math.sin(world.time * 7) * 0.5;

  // Hawk shadow: a long ellipse sweeping the run.
  const hk = world.hawk;
  hawkShadow.visible = hk.active;
  if (hk.active) {
    const k = hk.t / 5;
    hawkShadow.position.set(
      YARD.x0 - 2 + k * ((YARD.x1 - YARD.x0) + 4),
      0.02,
      6.2 + Math.sin(k * Math.PI) * 4.2);
    HAWK_MAT.opacity = Math.sin(Math.min(1, k * 1.2) * Math.PI) * 0.5;
  }

  // The bulb hums along with a barely-there flicker, and swings when the
  // floor gets hit. The point light rides with it so the shadows swing too.
  bulbSwing = Math.max(0, bulbSwing - frameDt * 0.045);
  const rig = world.coop.bulbRig;
  rig.rotation.z = Math.sin(world.time * 3.1) * bulbSwing;
  rig.rotation.x = Math.cos(world.time * 2.7) * bulbSwing * 0.7;
  rig.updateMatrixWorld();
  world.coop.bulbMesh.getWorldPosition(bulbLight.position);
  bulbLight.intensity = 14 * (1 + Math.sin(world.time * 11) * 0.02 + Math.sin(world.time * 3.7) * 0.015);

  // One shadow map cannot cover coop and run at a useful resolution, so it
  // follows whichever one this viewer is looking at.
  const focus = orbit.view === 'yard' ? SUN_FOCUS.yard : SUN_FOCUS.coop;
  sun.target.position.lerp(focus, 1 - Math.exp(-3 * frameDt));
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  sun.target.updateMatrixWorld();

  applyCamera(frameDt);
  renderer.render(scene, camera);
}

const MAX_CATCHUP = 8;   // a backgrounded tab must not try to replay an hour
let watchTimer = 0;      // seconds until this viewer republishes its position
let doorAngle = -1.9;    // rendered swing of the pop-hole door

const handle = {
  frames: 0, world, camera, renderer, orbit, transport, events,
  // Stops the display loop from advancing the simulation, so a test (or a
  // future server-driven client) can decide exactly when ticks happen.
  paused: false,
  // Advance exactly n ticks. Used by the test harness and by a late joiner
  // replaying an event log.
  step(n) { for (let i = 0; i < n; i++) tick(); },
  // Draw without simulating — the property the determinism test leans on.
  renderFrame(dt = 1 / 60, alpha = 1) { render(alpha, dt); },
  // Inject an event as if a player had made it, for tests and for a future
  // server pushing another viewer's action into this client.
  send(type, payload) { return transport.send(type, payload, world.tick); },
  setView,
  snapshot: () => world.snapshot(),
  applySnapshot: (s) => world.applySnapshot(s),
};
window.chickenGame = handle;

let acc = 0;
let prev = performance.now();
renderer.setAnimationLoop((now) => {
  // Clamp below as well: the first frame's timestamp can predate `prev`.
  const frameDt = clamp((now - prev) / 1000, 0, 0.25);
  prev = now;
  let ran = 0;
  if (!handle.paused) {
    acc += frameDt;
    while (acc >= TICK_DT && ran < MAX_CATCHUP) { tick(); acc -= TICK_DT; ran++; }
    if (ran === MAX_CATCHUP) acc = 0; // gave up catching up; do not spiral

    // Publish where this viewer is looking from, about once a second and
    // rounded to centimetres. Chickens read watchers, never the live camera,
    // so this is the one path by which moving your own view reaches the
    // simulation — and it is an ordinary event, identical on every client.
    watchTimer -= frameDt;
    if (watchTimer <= 0) {
      watchTimer = 1;
      const p = camera.position;
      transport.send(EV.WATCH, {
        id: transport.actor,
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      }, world.tick);
    }
  }

  render(clamp(acc / TICK_DT, 0, 1), frameDt);
  handle.frames++;
});
