#!/usr/bin/env node
// Build the single-file artifact: inlines src/ui.css and an esbuild bundle of
// src/boot.js (three.js and both backends included) into one self-contained
// HTML page, since the artifact host allows no external requests.
//
//   node tools/bundle.mjs [--out ../churn-artifact.html]
//
// Requires esbuild via npx. The page keeps index.html's markup verbatim minus
// the <link>, the importmap and the module <script>, which the inlined copies
// replace.

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'churn-artifact.html');

const { stdout: js } = await run('npx', [
  '--yes', 'esbuild@0.24.0', 'src/boot.js',
  '--bundle', '--format=esm', '--minify', '--legal-comments=none',
], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

const css = await readFile(resolve(ROOT, 'src/ui.css'), 'utf8');
let html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
html = html
  .replace(/<link rel="stylesheet"[^>]*>\s*/, '')
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace(/<script type="module"[^>]*><\/script>\s*/, '')
  .replace(/<meta charset="utf-8">\s*/, '');

const page = `<title>Churn</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
${css.trim()}
</style>
${html.trim()}
<script type="module">
${js}
</script>
`;
await writeFile(OUT, page);
console.log(`${OUT}  ${(page.length / 1e6).toFixed(2)} MB`);
