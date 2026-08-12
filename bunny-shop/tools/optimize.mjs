#!/usr/bin/env node
// Shrink the generated assets so the shop loads quickly and the folder is a
// reasonable thing to commit.
//
// Two savings dominate:
//
//  * Every animation export ships a full duplicate of the rabbit — mesh,
//    skeleton and 2K textures — when all the game wants is the clip. Animation
//    tracks address nodes by name, so the meshes and textures can go entirely.
//  * The remaining textures are 2K PBR sets for props that are forty pixels
//    tall on screen. They get resized and re-encoded as WebP.
//
//   node tools/optimize.mjs            rewrite assets/ in place
//   node tools/optimize.mjs --dry      report the savings only
//
// Re-running is safe: sources are kept in assets/raw/ and the optimiser always
// works from those.

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets');
const RAW = join(DIR, 'raw');
const DRY = process.argv.includes('--dry');

// Props that are never more than a few dozen pixels tall do not need 1K maps.
const SMALL = /^(carrot|cabbage|strawberry|corn|radish|muffin|bell|crate|basket|sign|plant)\b/;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const mb = (n) => `${(n / 1048576).toFixed(2)}MB`;

/** An animation export: keep the skeleton and the clips, bin the rest. */
async function stripToAnimation(doc) {
  const root = doc.getRoot();
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  await doc.transform(resample(), prune({ keepLeaves: true }), dedup());
}

/** A model we actually draw: keep everything, just make it smaller. */
async function slimModel(doc, name) {
  const size = SMALL.test(name) ? 512 : 1024;
  await doc.transform(
    weld(),
    resample(),
    dedup(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [size, size],
      quality: 82,
    }),
    prune({ keepLeaves: false }),
  );
}

await mkdir(RAW, { recursive: true });

const files = (await readdir(DIR)).filter((f) => f.endsWith('.glb'));
let before = 0;
let after = 0;

for (const file of files.sort()) {
  // Keep a pristine copy the first time we see a file, and always optimise
  // from it so repeated runs never compress an already-compressed texture.
  const raw = join(RAW, file);
  if (!existsSync(raw)) await copyFile(join(DIR, file), raw);

  const src = (await stat(raw)).size;
  before += src;

  const doc = await io.read(raw);
  const isAnimation = /\.(idle|walk|run|jump|hurt|fall|turn|climb)\.glb$/.test(file);

  if (isAnimation) await stripToAnimation(doc);
  else await slimModel(doc, basename(file, '.glb'));

  const out = join(DIR, file);
  if (!DRY) await io.write(out, doc);
  const dst = DRY ? src : (await stat(out)).size;
  after += dst;

  console.log(
    `${file.padEnd(26)} ${mb(src).padStart(8)} -> ${mb(dst).padStart(8)}  ${isAnimation ? 'clip only' : 'textures'}`,
  );
}

console.log(`\ntotal ${mb(before)} -> ${mb(after)} (${(100 - (after / before) * 100).toFixed(0)}% smaller)`);
