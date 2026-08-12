// Loads the generated GLBs and makes them usable.
//
// Tripo normalises every mesh into a unit box with an arbitrary origin, so
// nothing arrives at a usable size, sitting on the floor, or facing a known
// direction. Rather than bake fixes into the geometry (which would mean
// touching skinned vertices), each asset is wrapped in a transform computed
// from the bounds that tools/optimize.mjs measured. The manifest is the
// contract between the two halves.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Give a geometry a tangent attribute if it can have one.
 *
 * Tripo's GLBs carry a normal map but no tangents, and three's node materials
 * need a real `tangent` attribute to read a tangent-space normal map — without
 * one the surface shades black under every light, which is indistinguishable
 * from the level being unlit. glTF's own advice is to generate them when the
 * asset omits them, so that is what happens here.
 *
 * `computeTangents` requires indexed geometry with position, normal and uv,
 * and throws otherwise; a mesh that cannot have tangents is left alone and
 * simply renders without normal detail.
 */
function ensureTangents(geometry) {
  if (!geometry || geometry.attributes.tangent) return;
  const { position, normal, uv } = geometry.attributes;
  if (!geometry.index || !position || !normal || !uv) return;
  try {
    geometry.computeTangents();
  } catch (err) {
    console.warn('could not compute tangents:', err.message);
  }
}

export class AssetLibrary {
  constructor(basePath = './assets/') {
    this.base = basePath;
    this.loader = new GLTFLoader();
    this.manifest = null;
    /** key → { scene, meta, clips } */
    this.entries = new Map();
  }

  /**
   * Load everything in the manifest. `onProgress(done, total, key)` fires per
   * asset — the loading screen is the first thing a viewer sees, so it gets to
   * be honest about what is happening rather than faking a smooth bar.
   */
  async loadAll(onProgress) {
    const res = await fetch(`${this.base}manifest.json`);
    if (!res.ok) {
      throw new Error(
        `assets/manifest.json is missing (${res.status}) — run: npm run assets`,
      );
    }
    this.manifest = await res.json();

    const keys = Object.keys(this.manifest.assets);
    let done = 0;
    // Sequential rather than parallel: a dozen simultaneous GLB parses stall
    // the main thread badly enough that the progress bar stops moving, which
    // reads as a hang.
    for (const key of keys) {
      const meta = this.manifest.assets[key];
      const gltf = await this.loader.loadAsync(`${this.base}${meta.file}`);
      this.entries.set(key, this.#prepare(key, gltf, meta));
      onProgress?.(++done, keys.length, key);
    }
    return this;
  }

  /**
   * Wrap one loaded GLTF so that:
   *   · it is `meta.height` metres tall,
   *   · its base sits on y = 0 and it is centred on x/z,
   *   · it faces −Z (three's forward), using the yaw the optimizer derived
   *     from the direction the walk cycle actually travels.
   */
  #prepare(key, gltf, meta) {
    const inner = gltf.scene;

    const box = meta.bounds
      ? new THREE.Box3(
          new THREE.Vector3(...meta.bounds.min),
          new THREE.Vector3(...meta.bounds.max),
        )
      : new THREE.Box3().setFromObject(inner);

    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const scale = meta.height / Math.max(size.y, 1e-4);

    inner.scale.setScalar(scale);
    inner.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
    if (meta.forwardYaw) inner.rotation.y = meta.forwardYaw;

    const root = new THREE.Group();
    root.name = key;
    root.add(inner);

    // Footprint in world metres, for placement and collision.
    root.userData.footprint = new THREE.Vector2(size.x * scale, size.z * scale);
    root.userData.height = meta.height;

    let skinned = null;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      ensureTangents(o.geometry);
      // Everything in this building has been underwater. Tripo's PBR comes
      // back cleaner than that, so gloss is pulled down across the board and
      // the albedo is pushed toward the level's cold cast.
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.roughness = Math.min(1, (m.roughness ?? 1) * 0.55 + 0.45);
        m.metalness = Math.min(1, (m.metalness ?? 0) * 0.7);
        m.envMapIntensity = 0.18;
        m.shadowSide = THREE.FrontSide;
      }
      if (o.isSkinnedMesh) skinned = o;
    });

    return {
      key,
      meta,
      root,
      skinned,
      clips: gltf.animations ?? [],
    };
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`asset "${key}" was not loaded`);
    return entry;
  }

  /** All asset keys carrying a given manifest tag (see the asset manifest). */
  byTag(tag) {
    return [...this.entries.values()].filter((e) => e.meta.tag === tag).map((e) => e.key);
  }

  byRole(role) {
    return [...this.entries.values()].filter((e) => e.meta.role === role).map((e) => e.key);
  }

  /**
   * An independent copy, ready to place.
   *
   * Static props share geometry and materials through `Object3D.clone`, which
   * is what makes forty dressed props affordable. Skinned meshes cannot be
   * shared that way — a clone needs its own skeleton or every copy plays the
   * same pose — so those go through SkeletonUtils.
   */
  instance(key) {
    const entry = this.get(key);
    const copy = entry.root.clone(true);
    copy.userData.assetKey = key;
    copy.userData.footprint = entry.root.userData.footprint.clone();
    copy.userData.height = entry.root.userData.height;
    return copy;
  }
}

/**
 * A skinned instance with its own mixer and named actions.
 *
 * The clips were retargeted separately and merged by tools/optimize.mjs, so
 * they all drive the same skeleton and cross-fade cleanly.
 */
export async function makeAnimated(entry) {
  const { clone } = await import('three/addons/utils/SkeletonUtils.js');
  const root = clone(entry.root);
  const mixer = new THREE.AnimationMixer(root);

  const actions = new Map();
  for (const clip of entry.clips) {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    actions.set(clip.name, action);
  }

  return { root, mixer, actions, meta: entry.meta };
}
