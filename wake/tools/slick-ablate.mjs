#!/usr/bin/env node
// Is the slick doing ANYTHING? Two identical frames, one with the slick and the
// calm switched off, one with both hard on, diffed. If the wake region is
// unchanged the effect is not reaching the water and no amount of slider is
// going to help.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const CAM = opt('cam', '-0.9,2.6,90');

const shot = (out, sets) => execFileSync('node', [
  resolve(ROOT, 'tools/shot.mjs'), '--out', out, '--w', '640', '--h', '440',
  '--wait', '5', '--prewarm', '40', '--set', 'boat.speed=16', '--cam', CAM,
  ...sets.flatMap((s) => ['--set', s]),
], { cwd: ROOT, stdio: 'inherit' });

shot('shots/slick-off.png', ['surface.slick=0', 'surface.calm=0']);
shot('shots/slick-on.png',  ['surface.slick=2', 'surface.calm=1',
                             'surface.slickRef=0.02', 'surface.slickReach=8']);

// Raw pixel diff via the PNG decoder playwright already ships.
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const b = await chromium.launch();
const page = await b.newPage();
const load = async (p) => 'data:image/png;base64,' + (await readFile(resolve(ROOT, p))).toString('base64');
const [a, c] = [await load('shots/slick-off.png'), await load('shots/slick-on.png')];
const r = await page.evaluate(async ([u1, u2]) => {
  const get = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
  const [i1, i2] = [await get(u1), await get(u2)];
  const cv = document.createElement('canvas');
  cv.width = i1.width; cv.height = i1.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(i1, 0, 0); const d1 = g.getImageData(0, 0, cv.width, cv.height).data;
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(i2, 0, 0); const d2 = g.getImageData(0, 0, cv.width, cv.height).data;
  let sum = 0, max = 0, n = 0, moved = 0;
  for (let i = 0; i < d1.length; i += 4) {
    const dl = Math.abs((d1[i] * 0.299 + d1[i+1] * 0.587 + d1[i+2] * 0.114)
                      - (d2[i] * 0.299 + d2[i+1] * 0.587 + d2[i+2] * 0.114));
    sum += dl; max = Math.max(max, dl); n++; if (dl > 2) moved++;
  }
  return { meanDiff: sum / n, maxDiff: max, pctMoved: 100 * moved / n };
}, [a, c]);
await b.close();
console.log(JSON.stringify(r, null, 2));
console.log(r.pctMoved < 1
  ? '\nVERDICT: the slick is not reaching the water. Under 1% of pixels moved.'
  : `\nVERDICT: the slick IS applying -- ${r.pctMoved.toFixed(1)}% of pixels moved, max ${r.maxDiff.toFixed(0)}/255.`);
