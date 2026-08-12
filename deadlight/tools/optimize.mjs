// Turns Tripo's raw output into the GLBs the game ships.
//
//   npm install && node tools/optimize.mjs
//
// Three jobs:
//
//  1. Weight. Raw meshes arrive with 2K PBR texture sets; a dozen of those is
//     more than the whole rest of the game. Textures are resized per role and
//     re-encoded as WebP, which is where nearly all of the saving comes from.
//
//  2. The creature's clips. Each retarget came back as a complete skinned GLB
//     carrying one animation. The rigs are identical across those files, so
//     the clips are copied onto a single base mesh and rewired to its bones by
//     name — one download, five clips, one skeleton.
//
//  3. Measurement. Tripo normalises everything to a unit box with an arbitrary
//     origin, so nothing arrives at a usable scale. Rather than bake a
//     transform (which would mean touching skinned geometry), each mesh's
//     bounds are written to assets/manifest.json and the game normalises with
//     a wrapper transform at load. See src/assets.js.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { copyToDocument, dedup, prune, resample, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';

import { ALL_MESHES, CREATURE } from './assets.manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'assets', 'raw');
const OUT = path.join(ROOT, 'assets');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Texture budget by role. The creature is the only thing the player ever gets
 *  close enough to inspect; the mannequins are second because the whole point
 *  of them is being stared at. Everything else lives in torchlight at four
 *  metres and 512 is generous. */
const TEXTURE_SIZE = { creature: 1024, mannequin: 1024, prop: 512 };

const kb = (n) => `${(n / 1024).toFixed(0)}kb`;

async function sizeOf(file) {
  return (await stat(file)).size;
}

/** Shared clean-up + texture squeeze. */
async function squeeze(doc, size) {
  await doc.transform(
    dedup(),
    // `resample` collapses the constant-value keyframe runs that dominate a
    // retargeted clip; on these it removes roughly half the animation data.
    resample(),
    weld(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [size, size],
      quality: 88,
    }),
    prune({ keepAttributes: false, keepLeaves: false }),
  );
}

/**
 * Take the walk out of the walk cycle.
 *
 * Tripo bakes root displacement into a retargeted clip: `walk` translates the
 * root 1.3 units over 2.4 seconds. The game drives the creature's position
 * itself, so a clip that also moves would slide the creature off its own
 * navigation. The horizontal components of the locomotion root's translation
 * are flattened to their first value here (vertical is left alone — that is
 * the gait's bob, and losing it makes the walk glide).
 *
 * The displacement is measured before it is discarded, because it is worth
 * keeping: it says how fast this animation *thinks* it is moving, which is
 * exactly what the game needs to pick a playback rate that does not make the
 * feet skate. Its direction is worth keeping too — it is the only reliable
 * statement of which way the model faces.
 *
 * Returns { speed, yaw } per clip, in the model's own normalised units.
 */
function derootAnimations(doc) {
  const motion = {};

  for (const anim of doc.getRoot().listAnimations()) {
    const name = anim.getName();
    let best = null;

    for (const channel of anim.listChannels()) {
      if (channel.getTargetPath() !== 'translation') continue;
      const sampler = channel.getSampler();
      const values = sampler.getOutput()?.getArray();
      const times = sampler.getInput()?.getArray();
      if (!values || !times || times.length < 2) continue;

      // Total horizontal travel from first to last key.
      const dx = values[values.length - 3] - values[0];
      const dz = values[values.length - 1] - values[2];
      const travel = Math.hypot(dx, dz);
      if (!best || travel > best.travel) best = { channel, values, times, dx, dz, travel };
    }

    // Below this, what we are looking at is a bone's own sway, not locomotion.
    if (!best || best.travel < 0.15) {
      motion[name] = { speed: 0, yaw: null };
      continue;
    }

    const duration = best.times[best.times.length - 1] - best.times[0];
    motion[name] = {
      speed: +(best.travel / Math.max(duration, 1e-3)).toFixed(4),
      // Yaw that turns the model's travel direction into three.js's -Z
      // forward, so the game never carries a hand-tuned rotation constant.
      yaw: +(Math.PI - Math.atan2(best.dx, best.dz)).toFixed(4),
    };

    // Flatten X and Z, keep Y. Copy first — resample()/dedup() may later fold
    // identical accessors together, and mutating a shared array in place would
    // then quietly deroot clips that were never measured.
    const flat = Float32Array.from(best.values);
    for (let i = 0; i < flat.length; i += 3) {
      flat[i] = best.values[0];
      flat[i + 2] = best.values[2];
    }
    best.channel.getSampler().getOutput().setArray(flat);
  }

  return motion;
}

/**
 * Drop nodes that no longer belong to anything.
 *
 * Copying an animation across documents brings its target bones with it, and
 * those become orphans the moment the channels are repointed at the base
 * skeleton. `prune` leaves most of them because they are interior nodes of a
 * hierarchy rather than leaves, so they are collected explicitly: anything not
 * reachable from the default scene goes.
 */
function dropOrphanNodes(doc) {
  const root = doc.getRoot();
  const keep = new Set();
  const visit = (node) => {
    if (!node || keep.has(node)) return;
    keep.add(node);
    node.listChildren().forEach(visit);
  };
  root.getDefaultScene()?.listChildren().forEach(visit);

  let dropped = 0;
  for (const node of root.listNodes()) {
    if (keep.has(node)) continue;
    node.dispose();
    dropped++;
  }
  return dropped;
}

/**
 * Bind-pose bounds of the default scene.
 *
 * Skinned meshes need different treatment, and getting it wrong is subtle
 * enough to be worth spelling out. glTF says the transform of a node that
 * references a skinned mesh **is ignored** — the skin's joints position the
 * geometry, and at bind pose every `globalJoint · inverseBind` is the
 * identity, so bind-pose vertices land exactly at their raw POSITION values.
 * `getBounds` walks the node path anyway and folds in that ignored transform.
 *
 * On this creature the two disagree by half a unit: the `Armature` node sits
 * at y +0.5 and its root bone at −0.49, so they very nearly cancel — for the
 * skin. Trusting the node path put the model's feet half its own height below
 * the floor, and it looked exactly like an animation problem rather than a
 * measurement one.
 *
 * So: skinned primitives are measured from their POSITION accessors, and
 * everything else from the scene graph.
 */
function measure(doc) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  const skinned = [];
  for (const node of root.listNodes()) {
    if (node.getSkin() && node.getMesh()) skinned.push(node.getMesh());
  }

  if (!skinned.length) {
    const { min, max } = getBounds(scene);
    return { min: min.map((v) => +v.toFixed(4)), max: max.map((v) => +v.toFixed(4)) };
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of skinned) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], position.getMin([])[axis]);
        max[axis] = Math.max(max[axis], position.getMax([])[axis]);
      }
    }
  }

  return { min: min.map((v) => +v.toFixed(4)), max: max.map((v) => +v.toFixed(4)) };
}

// ------------------------------------------------------------ static meshes

async function optimizeStatic(entry, role) {
  const src = path.join(RAW, `${entry.key}.glb`);
  if (!existsSync(src)) return null;

  const doc = await io.read(src);
  await squeeze(doc, TEXTURE_SIZE[role]);

  const dest = path.join(OUT, `${entry.key}.glb`);
  await io.write(dest, doc);

  const before = await sizeOf(src);
  const after = await sizeOf(dest);
  console.log(`  ${entry.key.padEnd(14)} ${kb(before)} → ${kb(after)}`);

  return {
    file: `${entry.key}.glb`,
    role,
    height: entry.scale,
    tag: entry.tag ?? null,
    bounds: measure(doc),
  };
}

// --------------------------------------------------------------- creature

/**
 * Fold every retargeted clip onto one skinned mesh.
 *
 * The copied animation arrives pointing at the *source* document's bones, so
 * each channel is repointed at the base bone with the same name. Tripo names
 * joints uniquely (`tripo::Left_Limb_2`, …) and the rigger emits the same
 * hierarchy for every retarget of a given rig, so a name match is exact rather
 * than a guess. A channel whose target cannot be matched is dropped and
 * reported — silently keeping it would leave a track bound to a stray node
 * that the game then animates into the floor.
 */
async function optimizeCreature() {
  const clips = Object.keys(CREATURE.animations);
  const baseName = clips.find((c) => existsSync(path.join(RAW, `${CREATURE.key}_${c}.glb`)));
  if (!baseName) {
    console.warn('  creature: no animated source found, skipping');
    return null;
  }

  const doc = await io.read(path.join(RAW, `${CREATURE.key}_${baseName}.glb`));
  doc.getRoot().listAnimations()[0]?.setName(baseName);

  const bonesByName = new Map();
  for (const node of doc.getRoot().listNodes()) {
    if (node.getName()) bonesByName.set(node.getName(), node);
  }

  const merged = [baseName];
  let rawBytes = await sizeOf(path.join(RAW, `${CREATURE.key}_${baseName}.glb`));

  for (const name of clips) {
    if (name === baseName) continue;
    const src = path.join(RAW, `${CREATURE.key}_${name}.glb`);
    if (!existsSync(src)) continue;
    rawBytes += await sizeOf(src);

    const from = await io.read(src);
    const anim = from.getRoot().listAnimations()[0];
    if (!anim) {
      console.warn(`  creature: ${name} has no animation, skipping`);
      continue;
    }

    const map = copyToDocument(doc, from, [anim]);
    const copied = map.get(anim);
    copied.setName(name);

    let dropped = 0;
    for (const channel of copied.listChannels()) {
      const target = channel.getTargetNode();
      const match = target && bonesByName.get(target.getName());
      if (match) channel.setTargetNode(match);
      else {
        channel.dispose();
        dropped++;
      }
    }
    if (dropped) console.warn(`  creature: ${name} dropped ${dropped} unmatched channel(s)`);
    merged.push(name);
  }

  // The copies dragged in each source's own scene and mesh; prune inside
  // squeeze() drops everything the surviving animations and scene do not use.
  const root = doc.getRoot();
  for (const scene of root.listScenes()) {
    if (scene !== root.getDefaultScene()) scene.dispose();
  }

  // Each copy also brought its own Buffer, and a GLB may only have one. Move
  // every accessor onto the base document's buffer and drop the strays —
  // otherwise this fails at write time with "GLB must have 0–1 buffers".
  const buffer = root.listBuffers()[0];
  for (const accessor of root.listAccessors()) accessor.setBuffer(buffer);
  for (const stray of root.listBuffers()) {
    if (stray !== buffer) stray.dispose();
  }

  const orphans = dropOrphanNodes(doc);
  if (orphans) console.log(`  ${''.padEnd(14)} dropped ${orphans} orphan node(s)`);

  const motion = derootAnimations(doc);
  await squeeze(doc, TEXTURE_SIZE.creature);

  const dest = path.join(OUT, `${CREATURE.key}.glb`);
  await io.write(dest, doc);

  const after = await sizeOf(dest);
  console.log(`  ${CREATURE.key.padEnd(14)} ${kb(rawBytes)} (${merged.length} files) → ${kb(after)}`);
  console.log(`  ${''.padEnd(14)} clips: ${doc.getRoot().listAnimations().map((a) => a.getName()).join(', ')}`);

  const clipNames = doc.getRoot().listAnimations().map((a) => a.getName());
  // Facing is whatever the locomotion clips agree on; idle and scream have no
  // travel to derive it from.
  const yaws = clipNames.map((n) => motion[n]?.yaw).filter((y) => y !== null && y !== undefined);

  return {
    file: `${CREATURE.key}.glb`,
    role: 'creature',
    height: CREATURE.scale,
    clips: clipNames,
    motion,
    forwardYaw: yaws.length ? +(yaws.reduce((a, b) => a + b, 0) / yaws.length).toFixed(4) : 0,
    bounds: measure(doc),
  };
}

// ----------------------------------------------------------------- driver

async function main() {
  if (!existsSync(RAW) || !(await readdir(RAW)).length) {
    throw new Error('assets/raw is empty — run tools/generate.mjs first');
  }
  await mkdir(OUT, { recursive: true });

  const manifest = { generator: 'tripo v3', assets: {} };
  console.log('optimizing…');

  for (const entry of ALL_MESHES) {
    const role = entry.key.startsWith('mannequin') ? 'mannequin' : 'prop';
    const meta = await optimizeStatic(entry, role);
    if (meta) manifest.assets[entry.key] = meta;
    else console.warn(`  ${entry.key.padEnd(14)} missing, skipped`);
  }

  const creature = await optimizeCreature();
  if (creature) manifest.assets[CREATURE.key] = creature;

  // Carry the Tripo task ids through so a shipped asset can be traced back to
  // the prompt and job that produced it.
  const statePath = path.join(OUT, 'generation.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    for (const [key, meta] of Object.entries(manifest.assets)) {
      meta.taskId = state.entries?.[key]?.taskId ?? null;
    }
  }

  await writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  let total = 0;
  for (const meta of Object.values(manifest.assets)) total += await sizeOf(path.join(OUT, meta.file));
  console.log(`\n${Object.keys(manifest.assets).length} assets · ${(total / 1024 / 1024).toFixed(2)} MB total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
