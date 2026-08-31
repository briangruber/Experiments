#!/usr/bin/env node
// How pixel-art is a sprite sheet, measured rather than squinted at.
//
//   node tools/pixelness.mjs a.png b.png
//
// The room draws at three screen pixels per art pixel. A character sheet whose
// figure is 244 pixels tall is therefore drawn REDUCED, and a reduced sprite is
// smoother than the backdrop it stands in — which is the whole of "she looks
// less pixelated than the scene". The fix is a sheet whose figure is about a
// third of its drawn height, so it is magnified instead.
//
// Two numbers say whether a sheet is really at its stated resolution:
//
//   edge   the share of opaque-ish pixels sitting on a colour step. Native
//          pixel art is nearly all edge at small sizes; a downscale of a large
//          render blurs them into gradients.
//   soft   the share of pixels with partial alpha. Hard-edged art has almost
//          none; a resampled one has a halo of them around every outline.
//
// Neither is a verdict on its own — they are the difference between "this is
// 80px art" and "this is 256px art that has been shrunk to 80px".

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!args.length) { console.error('usage: node tools/pixelness.mjs <sheet.png>...'); process.exit(1); }

const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/tools/sheet-cut.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ready === true);

await page.evaluate(() => {
  window.__pixelness = (url) => new Promise((resolve, reject) => {
    const i = new Image();
    i.onerror = reject;
    i.onload = () => {
      const c = document.createElement('canvas');
      c.width = i.width; c.height = i.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = false;
      x.drawImage(i, 0, 0);
      const d = x.getImageData(0, 0, i.width, i.height).data;
      const at = (px, py) => (py * i.width + px) * 4;
      let opaque = 0, soft = 0, edge = 0, figure = 0;
      const seen = new Set();
      for (let y = 1; y < i.height - 1; y++) for (let px = 1; px < i.width - 1; px++) {
        const a = d[at(px, y) + 3];
        if (a > 0 && a < 250) soft++;
        if (a < 200) continue;
        opaque++; figure++;
        const k = at(px, y);
        seen.add((d[k] >> 3) << 10 | (d[k + 1] >> 3) << 5 | (d[k + 2] >> 3));
        // A colour step against the pixel to the right or below. "Step" is a
        // real jump, not the one-or-two-level drift a gradient makes.
        for (const n of [at(px + 1, y), at(px, y + 1)]) {
          if (d[n + 3] < 200) continue;
          const diff = Math.abs(d[k] - d[n]) + Math.abs(d[k + 1] - d[n + 1]) + Math.abs(d[k + 2] - d[n + 2]);
          if (diff > 40) { edge++; break; }
        }
      }
      resolve({
        w: i.width, h: i.height,
        edge: opaque ? edge / opaque : 0,
        soft: figure ? soft / figure : 0,
        colours: seen.size,
      });
    };
    i.src = url;
  });
});

console.log('  sheet                                    size    edge    soft   colours');
for (const p of args) {
  const bytes = await readFile(isAbsolute(p) ? p : join(ROOT, p));
  const r = await page.evaluate((u) => window.__pixelness(u),
    'data:image/png;base64,' + bytes.toString('base64'));
  console.log(`  ${p.replace('assets/cast/', '').padEnd(38)} ${String(r.w).padStart(4)}px `
    + ` ${(r.edge * 100).toFixed(1).padStart(5)}%  ${(r.soft * 100).toFixed(1).padStart(5)}%  `
    + `${String(r.colours).padStart(6)}`);
}
await browser.close();
await close();
