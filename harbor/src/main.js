import * as THREE from 'three';
import { createSky, createLights, HORIZON_COLOR, FOG_DENSITY } from './sky.js';
import { createOcean, createSeabed, createReefProps } from './water.js';
import { createWorld, createGulls } from './world.js';
import { createBoat, updateBoat } from './boat.js';
import { createWake } from './wake.js';
import { createInput } from './input.js';

const canvas = document.getElementById('gl');
const boot = document.getElementById('boot');
const hint = document.getElementById('hint');
const speedEl = document.getElementById('speed');

const isMobile = matchMedia('(pointer: coarse)').matches || innerWidth < 800;
const quality = {
  oceanSegments: isMobile ? 128 : 200,
  oceanHalf: isMobile ? 1600 : 2200,
  seabedSegments: isMobile ? 72 : 100,
  reefCount: isMobile ? 100 : 180,
  shadows: !isMobile,
  shadowMap: isMobile ? 1024 : 2048,
  dpr: Math.min(devicePixelRatio || 1, isMobile ? 1.5 : 2),
};

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !isMobile,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(quality.dpr);
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = quality.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(HORIZON_COLOR.clone(), FOG_DENSITY);
scene.background = HORIZON_COLOR.clone();

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.35, 6000);

const sky = createSky({ segments: isMobile ? 32 : 48 });
scene.add(sky.mesh);

const ocean = createOcean({
  segments: quality.oceanSegments,
  half: quality.oceanHalf,
  detail: isMobile ? 4 : 6,
});
scene.add(ocean.mesh);

const lights = createLights(scene, {
  shadows: quality.shadows,
  shadowMap: quality.shadowMap,
  shadowSpan: 160,
});

const seabed = createSeabed({ segments: quality.seabedSegments });
scene.add(seabed.mesh);
scene.add(createReefProps({ count: quality.reefCount }));

const world = createWorld();
scene.add(world.group);

const gulls = createGulls({ count: isMobile ? 7 : 12, centre: new THREE.Vector3(20, 0, 120) });
scene.add(gulls.mesh);

const boat = createBoat();
boat.x = world.spawn.x;
boat.z = world.spawn.z;
boat.heading = world.spawn.heading;
boat.root.position.set(boat.x, 0, boat.z);
boat.root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
scene.add(boat.root);

const wake = createWake();
scene.add(wake.mesh);

const input = createInput(canvas);

// Chase camera: sit behind the little motorboat looking toward the harbour.
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const desired = new THREE.Vector3();

function updateCamera(dt) {
  const yaw = boat.heading + input.lookYaw;
  const pitch = input.lookPitch;
  const dist = input.zoom;
  const fx = Math.sin(boat.heading);
  const fz = Math.cos(boat.heading);

  desired.set(
    boat.x - Math.sin(yaw) * dist * Math.cos(pitch),
    boat.y + 3.2 + Math.sin(pitch) * dist * 0.9,
    boat.z - Math.cos(yaw) * dist * Math.cos(pitch)
  );
  // Bias a little higher when looking at the town.
  desired.y = Math.max(desired.y, boat.y + 2.4);

  const lerp = 1 - Math.exp(-dt * 5.5);
  camPos.lerp(desired, lerp);
  camTarget.set(
    boat.x + fx * 4.5,
    boat.y + 1.4,
    boat.z + fz * 4.5
  );
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener('resize', resize);

let time = 0;
let last = performance.now();
let hintTimer = 0;
let ready = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;

  if (!ready) return;

  updateBoat(boat, input, dt, time);
  updateCamera(dt);
  wake.update(boat, dt);
  ocean.update(time, camera);
  seabed.update(time, camera);
  sky.update(time);
  gulls.update(time);
  lights.follow(boat.x, boat.z);

  // Soft bob of waterline props is already in wave sampling.
  renderer.render(scene, camera);

  const knots = Math.abs(boat.speed) * 1.94;
  speedEl.textContent = `${knots.toFixed(1)} kn`;

  hintTimer += dt;
  if (hintTimer > 8 && !hint.classList.contains('fade')) hint.classList.add('fade');
}

requestAnimationFrame(frame);

// Let the first frames allocate GPU resources before revealing.
requestAnimationFrame(() => {
  // Warm start: place camera looking at the postcard composition.
  input.lookYaw = 0.08;
  input.lookPitch = 0.18;
  input.zoom = 13;
  camPos.set(boat.x - Math.sin(boat.heading) * 13, boat.y + 5, boat.z - Math.cos(boat.heading) * 13);
  camera.position.copy(camPos);
  camera.lookAt(boat.x, boat.y + 1.2, boat.z + 4);
  updateBoat(boat, input, 0.016, 0);
  ocean.update(0, camera);
  seabed.update(0, camera);
  renderer.render(scene, camera);
  ready = true;
  boot.classList.add('hide');
  setTimeout(() => boot.remove(), 700);
});
