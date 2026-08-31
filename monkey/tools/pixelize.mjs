#!/usr/bin/env node
// Put a generated sheet through fal-ai/image2pixel.
//
//   node tools/pixelize.mjs assets/spriteoff/seedream.png --scale 7 --colors 28
//
// A model asked for pixel art returns something that LOOKS like pixel art and
// is not: soft edges between blocks, hundreds of colours, and no consistent
// grid — the same three faults tools/pixel-grid.mjs found in the background
// plate. image2pixel is a real pixeliser: it detects the grid, snaps to it,
// quantises to a palette and keys the background out.
//
// Doing this to the WHOLE sheet before cutting it into frames is deliberate.
// Pixelising frame by frame would let each frame land on its own grid and pick
// its own palette, which is the sprite-sheet version of eight slightly
// different characters.

import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute, basename, dirname } from 'node:path';
import { ROOT } from './harness.mjs';
import { falRun, fetchBuf } from './fal.mjs';
import { balance, quiesce, settle } from './billing.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const src = args.find((a) => !a.startsWith('--') && /\.(png|jpe?g)$/i.test(a));
if (!src) { console.error('usage: node tools/pixelize.mjs <image> [--scale N] [--colors N]'); process.exit(1); }
const path = isAbsolute(src) ? src : join(ROOT, src);

const buf = await readFile(path);
const input = {
  image_url: 'data:image/png;base64,' + buf.toString('base64'),
  max_colors: +opt('colors', 28),
  transparent_background: true,
  background_mode: 'corners',
  background_tolerance: +opt('tolerance', 32),
  snap_grid: true,
  downscale_method: opt('method', 'dominant'),
  cleanup_jaggy: true,
  trim_borders: false,
};
if (opt('scale', null)) input.scale = +opt('scale');

const before = await quiesce();
const t0 = Date.now();
const out = await falRun('fal-ai/image2pixel', input, 'pixelize');
const url = out.image?.url || out.images?.[0]?.url;
if (!url) { console.error('no image: ' + JSON.stringify(out).slice(0, 400)); process.exit(1); }
const png = await fetchBuf(url);
const dest = join(dirname(path), basename(path).replace(/\.(png|jpe?g)$/i, '') + '.px.png');
await writeFile(dest, png);
const cost = await settle(before, 20000);
console.log(`pixelised -> ${dest.replace(ROOT + '/', '')}  ${(png.length / 1024).toFixed(0)} KB  `
  + `${((Date.now() - t0) / 1000).toFixed(1)}s  $${cost?.toFixed(4) ?? '?'}`);
