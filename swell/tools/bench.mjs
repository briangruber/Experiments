#!/usr/bin/env node
// Frame cost for one selection, across the fixture matrix.
//
//   node tools/bench.mjs
//   node tools/bench.mjs --slot spectrum=sine-sum --slot breaking=slope-threshold
//
// Prints per-scene medians and the total relative to champions.json's reference
// stack. Absolute milliseconds depend entirely on what is rasterising; the ratio
// is the part worth quoting.

import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './browser.mjs';
import { collect } from './harness/collect.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const many = (n) => argv.reduce((a, v, i) => (v === '--' + n ? [...a, argv[i + 1]] : a), []);

const domain = JSON.parse(await readFile(join(ROOT, 'domain.json'), 'utf8'));
const champions = JSON.parse(await readFile(join(ROOT, 'champions.json'), 'utf8'));

const variants = Object.assign({}, champions.reference);
for (const kv of many('slot')) {
  const [k, v] = kv.split('=');
  variants[k] = v;
}

const { width, height } = domain.capture;
const fixtures = domain.fixtures.flatMap((f) => f.times.slice(0, 1).map((t) => ({ scene: f.scene, time: t })));
const h = await open({ width, height, scene: fixtures[0].scene });

const rows = [];
for (const f of fixtures) {
  const a = await collect(h.page, { scene: f.scene, time: f.time, variants, width, height, options: domain.probe });
  rows.push({ scene: f.scene, ms: a.timing.medianMs, p95: a.timing.p95Ms });
  console.log(`  ${f.scene.padEnd(14)} ${a.timing.medianMs.toFixed(1)} ms   p95 ${a.timing.p95Ms.toFixed(1)} ms`);
}
await h.close();

const total = rows.reduce((s, r) => s + r.ms, 0) / rows.length;
console.log(`\n  mean ${total.toFixed(1)} ms at ${width}x${height}`);
console.log(`  selection: ${Object.entries(variants).map(([k, v]) => `${k}=${v}`).join(' ')}`);
