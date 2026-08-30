#!/usr/bin/env node
// Find the floor line in a generated backdrop, by measurement rather than eye.
//
//   node tools/measure-room.mjs assets/bakeoff/pixel.seedream.jpg
//
// The walk polygons and the scale anchors are authored against wherever the
// water meets the planks, and reading that off a picture by hand is both slow
// and wrong in the last twenty pixels. Water in these plates is blue-dominant
// and the boardwalk is warm, so the transition is a sign change in (R - B)
// that can simply be looked for, column by column.
//
// It reports the line, not the hotspots: what a barrel is cannot be found this
// way, but where the floor starts can, and that is the number everything else
// is measured from.

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ROOT, launch } from './harness.mjs';

const arg = process.argv[2] || 'assets/bakeoff/pixel.seedream.jpg';
const path = isAbsolute(arg) ? arg : join(ROOT, arg);
const COLS = +(process.argv.find((a) => a.startsWith('--cols='))?.slice(7) || 33);

const buf = await readFile(path);
const browser = await launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([uri, cols]) => {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri;
  });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };

  // Warmth: positive over planks and timber, negative over water and sky.
  const warm = (x, y) => { const [r, , b] = at(x, y); return r - b; };

  const line = [];
  for (let i = 0; i < cols; i++) {
    const x = Math.round((i / (cols - 1)) * (c.width - 1));
    // Looking for an unbroken run of warm pixels breaks on the first shadow,
    // a dark plank seam or a coil of rope, and reports the floor as starting
    // near the bottom of the frame. Ask a question that tolerates them
    // instead: the floor starts at the highest line below which the column is
    // overwhelmingly warm. Walking bottom-up with a running count makes that
    // one pass.
    let hits = 0, seen = 0, top = null;
    for (let y = c.height - 1; y >= 0; y--) {
      seen++;
      if (warm(x, y) > 8) hits++;
      if (seen >= 40 && hits / seen >= 0.85) top = y;
    }
    line.push({ x, y: top });
  }

  // The moon is the brightest compact thing in the upper half.
  let moon = { x: 0, y: 0, v: 0 };
  for (let y = 0; y < c.height * 0.5; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      const [r, gg, b] = at(x, y); const v = r + gg + b;
      if (v > moon.v) moon = { x, y, v };
    }
  }
  return { w: c.width, h: c.height, line, moon };
}, ['data:image/jpeg;base64,' + buf.toString('base64'), COLS]);
await browser.close();

const ys = out.line.filter((p) => p.y != null).map((p) => p.y);
const min = Math.min(...ys), max = Math.max(...ys);
console.log(`${arg}  ${out.w}x${out.h}`);
console.log(`floor line: min y ${min}  max y ${max}  spread ${max - min}px`);
console.log(`moon: x ${out.moon.x} y ${out.moon.y}`);
console.log('\ncolumn profile (x -> floor y):');
for (const p of out.line) {
  const bar = p.y == null ? '?' : '#'.repeat(Math.round(((p.y - min) / Math.max(1, max - min)) * 40));
  console.log(`  ${String(p.x).padStart(5)}  ${String(p.y ?? '-').padStart(4)}  ${bar}`);
}
