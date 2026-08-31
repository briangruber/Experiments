#!/usr/bin/env node
// Turn a generated sprite sheet into an atlas the engine can load.
//
//   node tools/sheet-cut.mjs assets/spriteoff/seedream.px.png --name bonny
//
// docs/asset-pack.md asks for two things that no image model will give you
// reliably: the feet on the same row in every cell, and the figure on the same
// column. Rather than hope, this measures each frame and then rebuilds the
// sheet with both rules enforced — which turns "the model nearly got it right"
// into a usable asset.
//
// The alignment references are the ground (the lowest opaque pixel) and the
// HEAD centre, not the bounding-box centre. In a walk cycle a swinging arm
// moves the bounding box without moving the character, so centring on the box
// makes the figure slide back and forth by a few pixels a stride.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const src = args.find((a) => !a.startsWith('--'));
if (!src) { console.error('usage: node tools/sheet-cut.mjs <sheet.png> [--name key] [--height 48]'); process.exit(1); }
const NAME = opt('name', 'cast');
const TARGET_H = +opt('height', 48);
// image2pixel returns blocks at their original scale — a 16px block in a
// 2040px image. Reducing by the block size with nearest-neighbour turns that
// back into native pixels, which is the only form the engine can draw without
// resampling the art it was given.
const DOWN = +opt('down', 1);
const rel = isAbsolute(src) ? src.replace(ROOT + '/', '') : src;

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/tools/sheet-cut.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ready === true);

const url = `http://localhost:${port}/${rel}`;
const meas = await page.evaluate(([u, o]) => window.__cut(u, o), [url, {
  down: DOWN,
  keyMargin: +opt('keymargin', 28),
  frames: +opt('frames', 8),
}]);

// Slices at the ends of a sheet catch stray artefacts — a few pixels of a
// light bloom, half a figure the model added past the eighth — and a cell
// holding four pixels is worse than no cell. Anything far off the median
// height is not a frame, and saying which were dropped is the difference
// between a filter and a fudge.
const med = [...meas.frames.map((f) => f.h)].sort((a, b) => a - b)[meas.frames.length >> 1];
const kept = [], dropped = [];
meas.frames.forEach((f, i) => (f.h >= med * 0.7 ? kept : dropped).push({ ...f, i }));
if (dropped.length) {
  console.log(`  dropped ${dropped.length} slice(s) as junk: `
    + dropped.map((f) => `#${f.i + 1} (h ${f.h}, median ${med})`).join(', '));
}
await page.evaluate((keep) => {
  window.__state.frames = window.__state.frames.filter((_, i) => keep.includes(i));
}, kept.map((f) => f.i));
meas.frames = kept;
console.log(`${rel}  ${meas.w}x${meas.h}  ->  ${meas.frames.length} frames  [connectivity]`);
const hs = meas.frames.map((f) => f.h);
const bots = meas.frames.map((f) => f.y1);
const spread = (a) => Math.max(...a) - Math.min(...a);
console.log(`  height  ${Math.min(...hs)}–${Math.max(...hs)}px  (spread ${spread(hs)})`);
console.log(`  ground  rows ${Math.min(...bots)}–${Math.max(...bots)}  (spread ${spread(bots)} — this is the bob if left uncorrected)`);
for (const [i, f] of meas.frames.entries()) {
  console.log(`   frame ${String(i + 1).padStart(2)}  x ${String(f.x0).padStart(4)}–${String(f.x1).padStart(4)}  w ${String(f.x1 - f.x0 + 1).padStart(3)}  h ${String(f.h).padStart(3)}  head cx ${f.headCx.toFixed(0)}`);
}

// The cell is sized off the widest and tallest frame, with a little air, and
// the figures are then scaled as a set so the character lands at TARGET_H.
const maxW = Math.max(...meas.frames.map((f) => f.x1 - f.x0 + 1));
const maxH = Math.max(...hs);
const cell = { w: maxW + 8, h: maxH + 8 };
const feetY = cell.h - 4;
const dataUrl = await page.evaluate(([c, o]) => window.__pack(c, o),
  [cell, { cols: meas.frames.length, feetY }]);

await mkdir(join(ROOT, 'assets/cast'), { recursive: true });
const outPng = join(ROOT, `assets/cast/${NAME}-sheet.png`);
await writeFile(outPng, Buffer.from(dataUrl.split(',')[1], 'base64'));

const manifest = {
  cellW: cell.w, cellH: cell.h, cols: meas.frames.length,
  figureH: maxH, feetY,
  clips: { idle: { start: 0, count: 1, fps: 4 }, walk: { start: 0, count: meas.frames.length, fps: 12 } },
  source: rel, targetHeight: TARGET_H,
};
await writeFile(join(ROOT, `assets/cast/${NAME}-sheet.json`), JSON.stringify(manifest, null, 2) + '\n');

await browser.close();
await close();
console.log(`\natlas -> assets/cast/${NAME}-sheet.png  ${cell.w}x${cell.h} cells x ${meas.frames.length}`);
console.log(`manifest -> assets/cast/${NAME}-sheet.json  figureH ${maxH}, feetY ${feetY}`);
