// Generated set dressing. The courtyard is built procedurally in sets.js; this
// layer loads the modelled props over the top of it once they arrive, so the
// piece still runs — and still looks like itself — if a single byte of this
// fails to load.
//
// Everything here is deliberately additive or a straight swap of one dumb
// mesh for a better one. Nothing the director or the camera solver depends on
// moves, except the obstacle radii, which are updated to match what is now
// actually standing there.

import * as THREE from '../../vendor/three/three.module.min.js';
import { GLTFLoader } from '../../vendor/three/GLTFLoader.js';
import { clone as cloneSkinned } from '../../vendor/three/GLTFLoaderDeps.js';
import { ASSETS } from './assets-manifest.js';
import { MARKS } from '../sets/courtyard.js';
import { deg } from '../../engine/util.js';

// The bundle inlines these as data: URIs, and the published page's policy
// refuses fetch() — including fetch of a data: URI. Decode in process.
function bytesFromDataUri(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function bytes(url) {
  if (url.startsWith('data:')) return bytesFromDataUri(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

// Normalise a Tripo model: it arrives centred on its own bounding box and
// scaled into a unit cube, which is never where a prop belongs. Returns a
// group whose origin is on the floor at the model's centre.
function grounded(object) {
  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  object.position.set(-centre.x, -box.min.y, -centre.z);
  const g = new THREE.Group();
  g.add(object);
  g.userData.size = box.getSize(new THREE.Vector3());
  return g;
}

function shadows(root, tint = 0.82) {
  root.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = true;
    n.receiveShadow = true;
    // Tripo bakes a lot of contrast into base colour; the courtyard is lit at
    // night and these read a stop or so hot against the procedural stucco.
    // Clones share materials, so tint each material once, not once per copy.
    if (n.material && n.material.color && !n.material.userData.tinted) {
      n.material.color.multiplyScalar(tint);
      n.material.userData.tinted = true;
    }
  });
}

// The pale props need more taking down than the 0.82 house tint: white linen
// and limestone bounce every light in the set and read as blown highlights
// through the bloom.
const TINTS = {
  'stone-well': 0.6,
  'laundry-line': 0.48,
  'papel-picado': 0.78,
};

// --- placement --------------------------------------------------------------
//
// [asset, x, z, yaw, height in metres, y offset]. Height is what the prop
// should measure floor to top; the loader scales uniformly to hit it.
const PROPS = [
  // The fountain the whole first scene is staged around.
  ['fountain', MARKS.fountain.x, MARKS.fountain.z, 24, 1.3, 0],
  // Where Rosalinda would sit, if this were the kind of story where anyone sits.
  ['bench', MARKS.bench.x, MARKS.bench.z, -14, 0.82, 0],
  // A closed door in the right arch, so the courtyard has somewhere it is not
  // possible to leave from. Entrances still come through the centre and left.
  ['door', 2.35, -3.24, 0, 1.45, 0],
  ['jug', 1.42, -2.86, 40, 0.62, 0],
  ['jug', -1.28, 2.62, -25, 0.5, 0],
  ['pot-agave', -2.92, -2.62, 15, 0.86, 0],
  ['pot-agave', 3.42, 1.15, -40, 0.72, 0],
  // Hung off the parapet above the back wall.
  ['bougainvillea', 1.2, -3.12, 0, 1.15, 2.34],
  ['bougainvillea', -3.35, -3.12, 0, 1.0, 2.42],

  // --- second pass: depth layers ---------------------------------------------
  // The well anchors the left side the way the bench anchors the right, deep
  // enough that nobody's blocking ever reaches it. Upstage of the OTS camera
  // positions: at z 0.7 it walked straight into the entrada wide.
  ['stone-well', -3.8, -1.2, 35, 1.6, 0],
  // Papel picado strung below the parapet, over the centre arch — colour in
  // the top of every wide that looks toward the entrances.
  ['papel-picado', 0, -2.95, 0, 2.0, 1.35],
  // Laundry along the left side wall: soft pale fabric to break the stucco.
  ['laundry-line', -4.3, 0.6, 90, 0.85, 0.95],
  // Carved rail run along the parapet above the arches.
  ['balcony-rail', -1.55, -3.42, 90, 0.9, 3.4],
  ['balcony-rail', -0.52, -3.42, 90, 0.9, 3.4],
  ['balcony-rail', 0.52, -3.42, 90, 0.9, 3.4],
  ['balcony-rail', 1.55, -3.42, 90, 0.9, 3.4],
  // Wall lanterns flanking the arches, one practical each — the warm points
  // the hanging lanterns already promise, now on the wall itself.
  ['wall-lantern', 3.55, -3.18, 0, 0.75, 1.55],
  ['wall-lantern', -3.55, -3.18, 0, 0.75, 1.55],
  // Roses climbing the right side wall between its arches.
  ['rose-vine', 4.38, 0.15, -90, 1.9, 0],
  // Floor clutter for foreground edges in reverse shots.
  ['crate-fruit', 1.95, 3.05, 25, 0.5, 0],
  ['crate-fruit', -2.65, 3.3, -35, 0.44, 0],
  ['tile-stack', -4.25, -2.62, 20, 0.55, 0],
];

// Background hens, in the lit room behind the arches. Tripo rigged these onto a
// stock humanoid skeleton, so the walk swings its wings like arms — which is
// invisible at this distance and in this light, and nowhere near good enough
// to put in front of the camera.
const EXTRAS = [
  [-2.15, -4.4, 62, 0.4, 0.0],
  [1.85, -4.6, -108, 0.38, 1.1],
];

// `set` is the state object buildSet returns; its scene graph is set.group.
export async function dressSet(set) {
  // Textures have to arrive through an <img>, not a fetch — see the note in
  // the vendored loader. The published page's policy blocks the other path.
  GLTFLoader.USE_IMAGE_BITMAP = false;
  const loader = new GLTFLoader();
  const cache = new Map();
  const load = async (name) => {
    if (!cache.has(name)) cache.set(name, loader.parseAsync(await bytes(ASSETS[name]), ''));
    return cache.get(name);
  };

  const added = [];
  const mixers = [];

  for (const [name, x, z, yaw, height, y] of PROPS) {
    const gltf = await load(name);
    // Each placement gets its own copy; the cache is only there to avoid
    // parsing the same GLB twice.
    const g = grounded(gltf.scene.clone(true));
    g.scale.setScalar(height / (g.userData.size.y || 1));
    g.position.set(x, y, z);
    g.rotation.y = deg(yaw);
    shadows(g, TINTS[name] ?? 0.82);
    // Linen must not go glossy: any specular from the key reads as a ghost
    // against the dark side wall.
    if (name === 'laundry-line') {
      g.traverse((n) => {
        if (!n.isMesh || !n.material) return;
        n.material.roughness = Math.max(n.material.roughness ?? 1, 0.95);
        n.material.metalness = 0;
      });
    }
    // The wall lanterns are lit practicals: emit through the base colour map,
    // so the amber glass glows and the iron bracket stays iron. Without this
    // the pale glass reads as a dead white rectangle under the cool key.
    if (name === 'wall-lantern') {
      g.traverse((n) => {
        if (!n.isMesh || !n.material || n.material.userData.lit) return;
        n.material.emissiveMap = n.material.map;
        n.material.emissive = new THREE.Color(0xffb168);
        n.material.emissiveIntensity = 0.85;
        n.material.userData.lit = true;
      });
    }
    set.group.add(g);
    added.push({ name, node: g });
  }

  // The wall lanterns are practicals: each gets a small warm point light at
  // its glass, kept modest so the grade stays where the gaffer left it.
  for (const [x, z] of [[3.55, -2.98], [-3.55, -2.98]]) {
    const p = new THREE.PointLight(0xffab52, 1.1, 4.2, 1.9);
    p.position.set(x, 2.0, z);
    set.group.add(p);
  }

  // The animated extras.
  try {
    const gltf = await load('hen-tripo-walk');
    for (const [x, z, yaw, height, offset] of EXTRAS) {
      // Object3D.clone leaves a skinned mesh bound to the ORIGINAL bones, so
      // every copy renders at the source hierarchy's transform — unit scale, at
      // the origin, in front of the lead. This clone rebinds them.
      const hen = grounded(cloneSkinned(gltf.scene));
      hen.scale.setScalar(height / (hen.userData.size.y || 1));
      hen.position.set(x, 0, z);
      hen.rotation.y = deg(yaw);
      shadows(hen);
      set.group.add(hen);
      if (gltf.animations.length) {
        const mixer = new THREE.AnimationMixer(hen);
        const action = mixer.clipAction(gltf.animations[0]);
        // Slowed well down: the clip is a human walk, and at speed the arm
        // swing reads as exactly that.
        action.timeScale = 0.45;
        action.time = offset;
        action.play();
        mixers.push(mixer);
      }
      added.push({ name: 'hen-tripo-walk', node: hen });
    }
  } catch (e) {
    console.warn('background hens skipped:', e.message);
  }

  // Retire the procedural props the modelled ones replace. The fountain's
  // group stays in the graph, because updateSet drives its water shader every
  // frame; only its meshes go.
  for (const m of set.fountain.children) m.visible = false;
  if (set.proceduralBench) set.proceduralBench.visible = false;

  // The camera solver keeps out of solid dressing, and the new fountain is
  // both wider and taller than the one it replaced.
  for (const o of set.obstacles) {
    if (Math.abs(o.x - MARKS.fountain.x) < 0.1 && Math.abs(o.z - MARKS.fountain.z) < 0.1) {
      o.r = 1.45;
      o.top = 1.4;
    }
  }
  set.obstacles.push({ x: -2.92, z: -2.62, r: 0.5, top: 0.9 });
  // The second dressing pass stands new solids in the corners; the camera
  // solver needs to know. The overhead banners and wall pieces are out of its
  // reach already.
  set.obstacles.push(
    { x: -3.8, z: -1.2, r: 0.75, top: 1.7 },     // stone well
    { x: 1.95, z: 3.05, r: 0.45, top: 0.55 },    // crate, downstage right
    { x: -2.65, z: 3.3, r: 0.4, top: 0.5 },      // crate, downstage left
    { x: -4.25, z: -2.62, r: 0.4, top: 0.6 },    // tile stack
  );

  set.dressing = { added, mixers };
  return set.dressing;
}

export function updateDressing(set, dt) {
  if (!set.dressing) return;
  for (const m of set.dressing.mixers) m.update(dt);
}
