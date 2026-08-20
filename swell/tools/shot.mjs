#!/usr/bin/env node
// One deterministic frame.
//
//   node tools/shot.mjs --scene hurricane --time 19.5 --out shots/storm.png
//   node tools/shot.mjs --scene golden-hour --set windSpeed=14 --set foamThreshold=-0.4
//
// Exits non-zero on any shader, WebGL or JS error, so it doubles as a smoke test.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, frame } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const many = (n) => argv.reduce((a, v, i) => (v === '--' + n ? [...a, argv[i + 1]] : a), []);

const scene = opt('scene', 'golden-hour');
const time = +opt('time', 19.5);
const width = +opt('w', 1280);
const height = +opt('h', 720);
const out = resolve(ROOT, opt('out', join('shots', `${scene}.png`)));

const knobs = {};
for (const kv of many('set')) {
  const [k, v] = kv.split('=');
  knobs[k] = v.includes(',') ? v.split(',').map(Number) : Number(v);
}
const variants = {};
for (const kv of many('slot')) {
  const [k, v] = kv.split('=');
  variants[k] = v;
}

const h = await open({ width, height, scene });
const r = await frame(h.page, {
  scene, time, width, height,
  knobs: Object.keys(knobs).length ? knobs : undefined,
  variants: Object.keys(variants).length ? variants : undefined,
});
const png = await h.page.screenshot({ type: 'png' });
await h.close();

await mkdir(dirname(out), { recursive: true });
await writeFile(out, png);

const errors = [...new Set([...h.errors, ...r.errors])].filter((e) => !/favicon/i.test(e));
console.log(JSON.stringify({ out, scene, time, width, height, errors }, null, 2));
if (errors.length) process.exit(1);
