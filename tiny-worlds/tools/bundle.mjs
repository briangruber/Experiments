#!/usr/bin/env node
// Bundle the game into one self-contained HTML file (all scripts inlined).
//
//   node tools/bundle.mjs --out dist/tiny-worlds.html
//
// There is no build step or minification — the sources are simply inlined in
// place of their <script src> tags, so the bundle stays readable.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--out');
const OUT = i >= 0 ? args[i + 1] : 'dist/tiny-worlds.html';

let html = await readFile(join(ROOT, 'index.html'), 'utf8');

const tags = [...html.matchAll(/<script src="([^"]+)"><\/script>\s*/g)];
if (!tags.length) throw new Error('no <script src> tags found in index.html');

let scripts = '';
for (const m of tags) {
  const src = await readFile(join(ROOT, m[1]), 'utf8');
  scripts += '<script>\n' + src + '</script>\n';
  html = html.replace(m[0], '');
}
html = html.replace('</body>', scripts + '</body>');

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await writeFile(join(ROOT, OUT), html);
console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(1)} kB, ${tags.length} scripts inlined)`);
