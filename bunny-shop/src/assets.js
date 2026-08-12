// Loading and taming the generated models.
//
// Everything in assets/ came out of Tripo, which means arbitrary scale, an
// arbitrary resting orientation and an origin that is wherever the generator
// felt like putting it. `place()` is the one function that hides all of that:
// give it a target height and it hands back a group whose origin is on the
// floor, centred on x/z, facing +z.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const cache = new Map();

export function load(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      new Promise((resolve, reject) => {
        loader.load(`assets/${name}.glb`, resolve, undefined, () => reject(new Error(`missing asset: ${name}`)));
      }),
    );
  }
  return cache.get(name);
}

export async function loadAll(names, onProgress) {
  const out = {};
  let done = 0;
  await Promise.all(
    names.map(async (n) => {
      out[n] = await load(n);
      onProgress?.(++done, names.length);
    }),
  );
  return out;
}

// Measure a model with its own transform applied but ignoring anything we have
// already done to its parent.
function measure(object) {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object);
}

/**
 * Wrap a loaded gltf scene in a group that is normalised to a known size and
 * grounded at y = 0.
 *
 * @param {object} gltf         result of load()
 * @param {object} opts
 * @param {number} opts.height  target height in world units
 * @param {number} [opts.ry]    extra yaw, for models that came out facing away
 * @param {boolean} [opts.clone] deep-clone (needed for anything used twice)
 */
export function place(gltf, { height, ry = 0, clone = false, skinned = false } = {}) {
  const source = gltf.scene;
  const model = clone ? (skinned ? cloneSkinned(source) : source.clone(true)) : source;

  // Yaw is applied before measuring so the bounding box matches the final pose.
  model.rotation.y += ry;

  const box = measure(model);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const scale = height / Math.max(size.y, 1e-4);
  model.scale.multiplyScalar(scale);
  model.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);

  const group = new THREE.Group();
  group.add(model);
  group.userData.size = size.clone().multiplyScalar(scale);
  group.userData.inner = model;

  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // Tripo ships double-sided PBR materials; single-sided renders faster and
    // stops thin leaves and ears from self-shadowing into mush.
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      m.side = THREE.FrontSide;
      m.roughness = Math.min(1, (m.roughness ?? 1) * 0.92 + 0.08);
      if (m.map) m.map.anisotropy = 8;
    }
  });

  return group;
}

// Pull the animation clips out of the per-animation exports and rename them to
// the plain names the game uses ("walk", not "preset_walk_baked_02").
export function clipsFrom(entries) {
  const clips = {};
  for (const [name, gltf] of Object.entries(entries)) {
    const clip = gltf?.animations?.[0];
    if (!clip) continue;
    const copy = clip.clone();
    copy.name = name;
    clips[name] = copy;
  }
  return clips;
}
