// Sky, light, and the Tripo3D props that dress the rooftops.
//
// The generated meshes arrive at an arbitrary scale with an arbitrary origin,
// so each one is measured, scaled to a plausible real-world size and re-seated
// on its own base before being handed to an InstancedMesh — after that a few
// hundred water towers cost one draw call.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { skyTexture, dotTexture } from './textures.js';
import { makeRng } from './util.js';
import { asset } from './assets.js';

export const SUN_DIR = new THREE.Vector3(-0.42, 0.2, 0.88).normalize();

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/** Sky dome, sun flare, fog and lights. */
export function buildSky(scene) {
  const group = new THREE.Group();
  group.name = 'sky';

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(7000, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.renderOrder = -10;
  group.add(dome);

  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(1500, 1500),
    new THREE.MeshBasicMaterial({
      map: dotTexture(), color: 0xffd9a0, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }),
  );
  sun.position.copy(SUN_DIR).multiplyScalar(6000);
  sun.renderOrder = -9;
  group.add(sun);

  scene.fog = new THREE.FogExp2(0x5b4a78, 0.00072);
  scene.add(group);

  const key = new THREE.DirectionalLight(0xffc6a2, 2.1);
  key.position.copy(SUN_DIR).multiplyScalar(500);
  scene.add(key);
  // Bounce from the opposite side keeps the shaded faces from going flat black.
  const fill = new THREE.DirectionalLight(0x6d8dff, 0.9);
  fill.position.set(SUN_DIR.x * -400, 260, SUN_DIR.z * -400);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0x8ba6ff, 0x241c2c, 1.15));

  return { group, dome, sun, key };
}

async function loadKit(url) {
  const gltf = await new GLTFLoader().loadAsync(asset(url));
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error(`no mesh in ${url}`);
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  return { geo, mat: mesh.material };
}

/**
 * Rescale a geometry in place so it stands `height` metres tall, centred on
 * (0, ·, 0) with its base at y = 0.
 */
function normalise(geo, height) {
  geo.computeBoundingBox();
  geo.boundingBox.getSize(_size);
  geo.boundingBox.getCenter(_center);
  const s = height / Math.max(_size.y, 1e-4);
  geo.translate(-_center.x, -geo.boundingBox.min.y, -_center.z);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

const KIT = [
  { name: 'water_tower', file: './assets/water_tower.glb', height: 7.5, jitter: 1.6, weight: 0.4 },
  { name: 'ac_unit', file: './assets/ac_unit.glb', height: 2.6, jitter: 0.7, weight: 1 },
  { name: 'antenna', file: './assets/antenna.glb', height: 14, jitter: 4, weight: 0.35 },
];

/**
 * Scatter rooftop props, mast antennae and aircraft warning lights over the
 * city. Resolves to a group; missing assets degrade to an empty group rather
 * than breaking the scene.
 */
export async function buildProps(city, seed = 21) {
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'props';

  const kits = await Promise.all(KIT.map(async (k) => {
    try {
      const { geo, mat } = await loadKit(k.file);
      return { ...k, geo: normalise(geo, k.height), mat };
    } catch (err) {
      console.warn(`props: ${k.name} unavailable —`, err.message);
      return null;
    }
  }));

  // Decide placements first so each InstancedMesh can be sized exactly.
  const plan = new Map(KIT.map((k) => [k.name, []]));
  for (const spot of city.roofSpots) {
    if (spot.kind === 'mast') {
      plan.get('antenna').push({ x: spot.x, y: spot.y, z: spot.z, s: rng.range(0.8, 1.9), r: rng() * Math.PI * 2 });
      continue;
    }
    const room = spot.size * 0.5 - 3;
    if (room < 1) continue;
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const pick = rng() < 0.22 ? 'water_tower' : rng() < 0.86 ? 'ac_unit' : 'antenna';
      plan.get(pick).push({
        x: spot.x + rng.range(-room, room),
        y: spot.y,
        z: spot.z + rng.range(-room, room),
        s: rng.range(0.75, 1.35),
        r: rng() * Math.PI * 2,
      });
    }
  }

  for (const kit of kits) {
    if (!kit) continue;
    const items = plan.get(kit.name);
    if (!items.length) continue;
    const mesh = new THREE.InstancedMesh(kit.geo, kit.mat, items.length);
    mesh.frustumCulled = false;
    items.forEach((it, i) => {
      _q.setFromAxisAngle(_v.set(0, 1, 0), it.r);
      _m.compose(_v.set(it.x, it.y, it.z), _q, _size.set(it.s, it.s, it.s));
      mesh.setMatrixAt(i, _m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  // Aircraft warning lights on the tall stuff, in three phase groups so the
  // skyline blinks out of step with itself.
  const lightGeo = new THREE.SphereGeometry(0.9, 8, 6);
  const beacons = [0, 1, 2].map((i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2f4a, transparent: true, depthWrite: false });
    const items = city.skyline.filter((_, idx) => idx % 3 === i);
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(lightGeo, mat, items.length);
    mesh.frustumCulled = false;
    items.forEach((b, k) => {
      _m.makeTranslation(b.x, b.h + 1.6, b.z);
      mesh.setMatrixAt(k, _m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return { mesh, mat, phase: i * 0.8 };
  }).filter(Boolean);

  // A couple of airships drifting over downtown, for scale and life.
  const blimps = [];
  try {
    const { geo, mat } = await loadKit('./assets/blimp.glb');
    normalise(geo, 22);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(rng.range(-500, 500), rng.range(210, 330), rng.range(-500, 500));
      group.add(m);
      blimps.push({
        mesh: m,
        radius: rng.range(320, 780),
        speed: rng.range(0.012, 0.026) * (rng.chance(0.5) ? 1 : -1),
        phase: rng() * Math.PI * 2,
        y: m.position.y,
      });
    }
  } catch (err) {
    console.warn('props: blimp unavailable —', err.message);
  }

  group.update = (time) => {
    for (const b of beacons) {
      const pulse = Math.sin(time * 2.1 + b.phase);
      b.mat.opacity = pulse > 0.6 ? 1 : 0.12;
    }
    for (const b of blimps) {
      const a = b.phase + time * b.speed;
      b.mesh.position.set(Math.cos(a) * b.radius, b.y + Math.sin(time * 0.25 + b.phase) * 6, Math.sin(a) * b.radius);
      b.mesh.rotation.y = -a + (b.speed > 0 ? Math.PI : 0);
    }
  };

  return group;
}
