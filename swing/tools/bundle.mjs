#!/usr/bin/env node
// Fold the whole prototype into one self-contained HTML file.
//
//   node tools/bundle.mjs --out dist/skyline.html
//
// Everything is inlined: three.js, the sources, the stylesheet, and every
// generated mesh as a data URI. The result loads with no network access at all,
// which is what embedding it anywhere with a strict CSP requires.
//
// --body omits the <meta>/<title> preamble, for hosts that supply their own
// document shell and wrap the file in <head>/<body> themselves.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const OUT = opt('out', 'dist/skyline.html');
const BODY_ONLY = has('body');

async function loadEsbuild() {
  const candidates = ['esbuild', process.env.ESBUILD_PATH].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* try next */ }
  }
  throw new Error('esbuild not found; npm i esbuild, or set ESBUILD_PATH');
}

const esbuild = await loadEsbuild();

/** Resolve the bare specifiers the import map handles when served as a folder. */
const vendorPaths = {
  name: 'skyline-vendor',
  setup(build) {
    build.onResolve({ filter: /^three$|^three\/webgpu$/ }, () => ({
      path: join(ROOT, 'vendor/three/three.webgpu.min.js'),
    }));
    build.onResolve({ filter: /^three\/tsl$/ }, () => ({
      path: join(ROOT, 'vendor/three/three.tsl.min.js'),
    }));
    build.onResolve({ filter: /^three\/addons\// }, (a) => ({
      path: join(ROOT, 'vendor/three/addons', a.path.slice('three/addons/'.length)),
    }));
  },
};

const built = await esbuild.build({
  entryPoints: [join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  plugins: [vendorPaths],
  write: false,
});
const script = built.outputFiles[0].text;

// Meshes become data URIs under the same keys src/assets.js looks up.
const ASSETS = ['hero', 'water_tower', 'ac_unit', 'antenna', 'blimp'];
const assetMap = {};
let assetBytes = 0;
for (const name of ASSETS) {
  try {
    const buf = await readFile(join(ROOT, 'assets', `${name}.glb`));
    assetBytes += buf.length;
    assetMap[`./assets/${name}.glb`] = `data:model/gltf-binary;base64,${buf.toString('base64')}`;
  } catch {
    console.warn(`bundle: assets/${name}.glb missing, skipping`);
  }
}

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// Keep the markup, drop everything that reaches for a second file.
let markup = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace(/<link rel="stylesheet"[^>]*>\s*/, '')
  .replace(/<script type="module"[^>]*><\/script>\s*/, '');

if (BODY_ONLY) {
  markup = markup
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<meta[^>]*>\s*/g, '');
}

const out = `${markup.trimEnd()}
<style>
${css}
</style>
<script>window.__SKYLINE_ASSETS=${JSON.stringify(assetMap)};</script>
<script>
${script}
</script>
`;

const dest = join(ROOT, OUT);
await mkdir(dirname(dest), { recursive: true });
await writeFile(dest, out);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(JSON.stringify({
  out: OUT,
  total: mb(Buffer.byteLength(out)),
  script: mb(script.length),
  assets: `${mb(assetBytes)} raw`,
  meshes: Object.keys(assetMap).length,
  bodyOnly: BODY_ONLY,
}, null, 2));
