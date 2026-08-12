// Loads the Tripo-generated GLBs and normalises them into the shapes the rest
// of the game wants: instanceable {geometry, material} pairs sitting on y=0
// with unit height, plus the rigged keeper and its four clips.
//
// Every asset has a procedural stand-in, so the game still runs (and still
// looks deliberate) if a GLB is missing or fails to decode.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const FILES = {
  tree: 'tree.glb',
  crystal: 'crystal.glb',
  house: 'house.glb',
  lantern: 'lantern.glb',
  keeperIdle: 'keeper-idle.glb',
  keeperWalk: 'keeper-walk.glb',
  keeperRun: 'keeper-run.glb',
  keeperJump: 'keeper-jump.glb',
  gloomIdle: 'gloom-idle.glb',
  gloomWalk: 'gloom-walk.glb',
};

// Both Tripo rigs come back facing along their own +X. The scene frames treat
// +Z as forward, so every rigged model gets the same quarter turn.
export const RIG_FACE_OFFSET = -Math.PI / 2;

// Resolved against this module, not the page, so the loader works from any
// entry point (the game, the asset contact sheet, an embed).
const assetUrl = (name) => new URL(`../assets/${name}`, import.meta.url).href;

// The single-file build (tools/bundle.mjs) leaves the models here as base64,
// because a hosted artifact may not fetch anything at all — not even a data:
// URL. Decoding to an ArrayBuffer and parsing it directly touches no network.
const inlined = (name) => globalThis.__TINY_WORLDS_ASSETS?.[name];

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Tripo returns physically-plausible PBR; these worlds want matte clay.
function claySoften(mat) {
  const list = Array.isArray(mat) ? mat : [mat];
  for (const m of list) {
    if (!m) continue;
    m.metalness = 0.0;
    m.roughness = Math.max(0.62, m.roughness ?? 1);
    if (m.map) m.map.anisotropy = 4;
    m.side = THREE.FrontSide;
  }
  return mat;
}

// Flatten a loaded scene into one geometry+material, baked into a frame whose
// origin is the model's footprint centre and whose height is exactly 1.
function bakeToUnit(scene) {
  scene.updateWorldMatrix(true, true);
  let found = null;
  scene.traverse((o) => {
    if (o.isMesh && !found) found = o;
  });
  if (!found) return null;
  const geometry = found.geometry.clone();
  geometry.applyMatrix4(found.matrixWorld);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = new THREE.Vector3();
  bb.getSize(size);
  const s = 1 / Math.max(1e-4, size.y);
  geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geometry.scale(s, s, s);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, material: claySoften(found.material.clone()) };
}

// Same normalisation, but keeping the hierarchy (for props we do not instance).
// `clone` must be false for skinned models: a plain clone severs the bone
// bindings, and this wrapper is the only copy the keeper needs anyway.
function unitObject(scene, { clone = true } = {}) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = 1 / Math.max(1e-4, size.y);
  const inner = clone ? scene.clone(true) : scene;
  inner.traverse((o) => { if (o.isMesh) { o.material = claySoften(o.material.clone()); o.castShadow = true; o.receiveShadow = true; } });
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.scale.setScalar(s);
  const outer = new THREE.Group();
  outer.add(wrap);
  return outer;
}

// ------------------------------------------------------------- fallbacks

const clay = (color, rough = 0.85) => new THREE.MeshStandardMaterial({
  color: new THREE.Color(color), roughness: rough, metalness: 0, flatShading: true,
});

function fallbackTree() {
  const trunk = new THREE.CylinderGeometry(0.055, 0.09, 0.42, 6);
  trunk.translate(0, 0.21, 0);
  const c1 = new THREE.IcosahedronGeometry(0.3, 0); c1.translate(0, 0.62, 0);
  const c2 = new THREE.IcosahedronGeometry(0.22, 0); c2.translate(0.14, 0.48, 0.06);
  const c3 = new THREE.IcosahedronGeometry(0.19, 0); c3.translate(-0.12, 0.52, -0.08);
  // mergeGeometries refuses a mix of indexed and non-indexed inputs, and the
  // polyhedra come back non-indexed.
  const geo = BufferGeometryUtils.mergeGeometries(
    [trunk, c1, c2, c3].map((g) => g.toNonIndexed()), false,
  );
  const colors = [];
  const pos = geo.attributes.position;
  const bark = new THREE.Color(0x7a5a3c).convertSRGBToLinear();
  const leaf = new THREE.Color(0x5fae4e).convertSRGBToLinear();
  for (let i = 0; i < pos.count; i++) {
    const c = pos.getY(i) < 0.4 ? bark : leaf;
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return { geometry: geo, material: clay(0xffffff).clone() };
}

function fallbackRock(seed = 1) {
  const geo = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  // The geometry is non-indexed, so the displacement has to be a function of
  // the vertex *direction*: keying it off the index tears the faces apart.
  const hash = (x, y, z) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = v.clone().normalize();
    const f = 0.74 + hash(Math.round(d.x * 40), Math.round(d.y * 40), Math.round(d.z * 40)) * 0.5;
    pos.setXYZ(i, v.x * f, v.y * f * 0.74, v.z * f);
  }
  geo.translate(0, 0.26, 0);
  geo.computeVertexNormals();
  return { geometry: geo, material: clay(0x8c8880) };
}

function fallbackCrystal() {
  const parts = [];
  const spec = [[0, 0.5, 0, 0.16, 1.0], [0.16, 0.34, 0.1, 0.11, 0.68], [-0.14, 0.3, -0.12, 0.1, 0.6]];
  for (const [x, y, z, r, h] of spec) {
    const g = new THREE.ConeGeometry(r, h, 5);
    g.translate(x, y * 1.0, z);
    parts.push(g);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
  return {
    geometry: geo,
    material: new THREE.MeshStandardMaterial({
      color: 0xbfe6ff, roughness: 0.25, metalness: 0.0, flatShading: true,
      emissive: 0x2a5f8f, emissiveIntensity: 0.5,
    }),
  };
}

function fallbackHouse() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.5, 10), clay(0xe6d7bd));
  body.position.y = 0.25;
  const roof = new THREE.Mesh(new THREE.SphereGeometry(0.58, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), clay(0xc4553f));
  roof.position.y = 0.48;
  roof.scale.y = 0.66;
  const door = new THREE.Mesh(new THREE.CircleGeometry(0.14, 12), clay(0x5b3b28));
  door.position.set(0, 0.16, 0.465);
  g.add(body, roof, door);
  return g;
}

function fallbackLantern() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.62, 8), clay(0x9a9384));
  base.position.y = 0.31;
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), clay(0x6e6a60));
  lamp.position.y = 0.78;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.2, 4), clay(0x8b8478));
  cap.position.y = 1.0;
  cap.rotation.y = Math.PI / 4;
  g.add(base, lamp, cap);
  return g;
}

function fallbackKeeper() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.32, 6, 12), clay(0x5f7fbf, 0.9));
  body.position.y = 0.44;
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.29, 14, 12), clay(0x4a68a6, 0.9));
  hood.position.y = 0.82;
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), clay(0xf0cba8, 0.9));
  face.position.set(0, 0.79, 0.14);
  const pack = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), clay(0xd9a441, 0.7));
  pack.position.set(0, 0.55, -0.28);
  g.add(body, hood, face, pack);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const outer = new THREE.Group();
  outer.add(g);
  return outer;
}

// Trees stand on a dormant world before it wakes, and a dormant tree has to
// read as *drained*, not merely dark. Instance colour alone can only multiply,
// so the red channel is repurposed as an "alive" factor and the shader mixes
// the texture toward its own luminance. Meshes without instance colour — the
// Heart's single great tree — are untouched.
function makeRevivable(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #ifdef USE_INSTANCING_COLOR
        {
          float alive = clamp(vColor.r, 0.0, 1.0);
          float grey = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(vec3(grey * 1.35 + 0.07), diffuseColor.rgb, alive);
        }
      #else
        #include <color_fragment>
      #endif`);
  };
  material.customProgramCacheKey = () => 'revivable';
  return material;
}

function fallbackGloom() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 1), clay(0x3a3348, 0.95));
  body.position.y = 0.42;
  body.scale.y = 0.9;
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffb03a, emissiveIntensity: 2, roughness: 0.4 }));
  eye.position.set(0, 0.5, 0.34);
  const footL = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), clay(0x2a2436, 0.95));
  footL.position.set(-0.16, 0.1, 0.04);
  const footR = footL.clone();
  footR.position.x = 0.16;
  g.add(body, eye, footL, footR);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const outer = new THREE.Group();
  outer.add(g);
  return outer;
}

// ---------------------------------------------------------------- loading

export async function loadAssets(onProgress = () => {}) {
  const loader = new GLTFLoader();
  const entries = Object.entries(FILES);
  const loaded = {};
  let done = 0;

  await Promise.all(entries.map(async ([key, name]) => {
    try {
      const embedded = inlined(name);
      loaded[key] = embedded
        ? await loader.parseAsync(base64ToBuffer(embedded), '')
        : await loader.loadAsync(assetUrl(name));
    } catch (err) {
      console.warn(`[assets] ${name} unavailable, using fallback:`, err.message ?? err);
      loaded[key] = null;
    }
    onProgress(++done / entries.length);
  }));

  const out = {};
  out.tree = (loaded.tree && bakeToUnit(loaded.tree.scene)) || fallbackTree();
  makeRevivable(out.tree.material);
  out.crystal = (loaded.crystal && bakeToUnit(loaded.crystal.scene)) || fallbackCrystal();
  out.rock = fallbackRock(7); // no generated rock: procedural boulders read better
  out.house = { object: loaded.house ? unitObject(loaded.house.scene) : fallbackHouse() };
  out.lantern = { object: loaded.lantern ? unitObject(loaded.lantern.scene) : fallbackLantern() };

  // Mesh from the idle file, clips gathered from every retarget of it. Tripo
  // retargets share one skeleton, so the clips are interchangeable.
  const rigged = (files, fallback) => {
    const base = files[0][1];
    if (!base) return { object: fallback(), clips: {}, rigged: false, faceOffset: 0 };
    const object = unitObject(base.scene, { clone: false });
    const clips = {};
    for (const [name, gltf] of files) {
      const clip = gltf?.animations?.[0];
      if (clip) { clip.name = name; clips[name] = clip; }
    }
    object.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    });
    return { object, clips, rigged: true, faceOffset: RIG_FACE_OFFSET };
  };

  out.keeper = rigged([
    ['idle', loaded.keeperIdle], ['walk', loaded.keeperWalk],
    ['run', loaded.keeperRun], ['jump', loaded.keeperJump],
  ], fallbackKeeper);

  out.gloom = rigged([['idle', loaded.gloomIdle], ['walk', loaded.gloomWalk]], fallbackGloom);

  return out;
}
