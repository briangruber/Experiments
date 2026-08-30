#!/usr/bin/env node
// What pixel grid is a plate actually drawn on?
//
//   node tools/pixel-grid.mjs assets/scene.jpg
//
// Pixel art delivered at 1280x720 is not 1280x720 of information: it is a much
// smaller picture with each pixel painted as a block. Everything drawn ON TOP
// of it has to land on that same grid or it reads as a different medium pasted
// over the art, which is exactly what a smooth vector character does.
//
// Finding the block size is a search, not a guess. For each candidate size the
// image is compared against itself quantised to that grid; the largest size
// that loses almost nothing is the grid the artist drew on.

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ROOT, launch } from './harness.mjs';

const arg = process.argv[2] || 'assets/scene.jpg';
const path = isAbsolute(arg) ? arg : join(ROOT, arg);
const buf = await readFile(path);

const browser = await launch();
const page = await browser.newPage();
const out = await page.evaluate(async (uri) => {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri;
  });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const px = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };

  // Error from snapping every pixel to the value at its block's top-left.
  // A grid the art was drawn on costs almost nothing; a wrong one smears.
  const err = (b) => {
    let sum = 0, n = 0;
    for (let y = 0; y + b <= c.height; y += b * 3) {
      for (let x = 0; x + b <= c.width; x += b * 3) {
        const [r0, g0, b0] = px(x, y);
        for (let dy = 0; dy < b; dy++) {
          for (let dx = 0; dx < b; dx++) {
            const [r, gg, bb] = px(x + dx, y + dy);
            sum += Math.abs(r - r0) + Math.abs(gg - g0) + Math.abs(bb - b0); n += 3;
          }
        }
      }
    }
    return sum / n;
  };
  const rows = [];
  for (let b = 1; b <= 10; b++) rows.push({ b, err: +err(b).toFixed(2) });

  // The block-variance test is defeated by JPEG and by any non-integer
  // downscale, both of which smear block edges into gradients. Run lengths
  // survive better: pixel art holds a colour for a whole block, so the lengths
  // of constant-colour runs along a scanline pile up at multiples of the grid.
  const runs = new Array(33).fill(0);
  for (let y = 4; y < c.height - 4; y += 3) {
    let start = 0;
    for (let x = 1; x < c.width; x++) {
      const [r, g1, b1] = px(x, y), [r2, g2, b2] = px(x - 1, y);
      if (Math.abs(r - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) > 24) {
        const len = x - start;
        if (len >= 1 && len <= 32) runs[len]++;
        start = x;
      }
    }
  }

  // Count distinct colours, coarsely — pixel art is palette art.
  const seen = new Set();
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      const [r, gg, bb] = px(x, y);
      seen.add(((r >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3));
    }
  }
  return { w: c.width, h: c.height, rows, colours: seen.size, runs };
}, 'data:image/jpeg;base64,' + buf.toString('base64'));
await browser.close();

console.log(`${arg}  ${out.w}x${out.h}  ~${out.colours} colours (5-bit buckets)`);
console.log('\nblock  error  (low = the art really is drawn on this grid)');
const base = out.rows[0].err;
for (const r of out.rows) {
  const bar = '#'.repeat(Math.round(r.err / Math.max(0.01, out.rows.at(-1).err) * 40));
  console.log(`  ${String(r.b).padStart(2)}   ${String(r.err).padStart(6)}  ${bar}`);
}
// Where do constant-colour runs pile up? On clean pixel art the histogram
// spikes at the grid and its multiples; on smeared art it still leans.
const total = out.runs.reduce((a, b) => a + b, 0) || 1;
console.log('\nrun length  share  (constant-colour runs along a scanline)');
for (let n = 1; n <= 16; n++) {
  const share = out.runs[n] / total;
  console.log(`  ${String(n).padStart(3)}   ${(share * 100).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(share * 200))}`);
}
// Score each candidate grid by how much of the mass sits on its multiples,
// discounting the fact that bigger grids have fewer multiples to catch.
let best = { g: 1, score: 0 };
for (let g = 2; g <= 8; g++) {
  let on = 0;
  for (let n = g; n <= 32; n += g) on += out.runs[n] || 0;
  const expected = Math.floor(32 / g) / 32;
  const score = (on / total) / expected;
  console.log(`  grid ${g}: ${(on / total * 100).toFixed(1)}% of runs on multiples (lift ${score.toFixed(2)}x)`);
  if (score > best.score) best = { g, score };
}
console.log(`\nbest fit ≈ ${best.g}px  ->  logical room ${Math.round(out.w / best.g)}x${Math.round(out.h / best.g)}  (lift ${best.score.toFixed(2)}x)`);
