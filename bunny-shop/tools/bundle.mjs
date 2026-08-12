#!/usr/bin/env node
// Build the whole shop into one HTML file with no external requests at all:
// three.js, the game, the stylesheet and every model, inlined.
//
//   node tools/bundle.mjs
//
// Writes two files that differ only in their wrapper:
//
//   dist/hop-and-shop.html   a complete document, openable from disk
//   dist/artifact.html       the same page without <html>/<head>/<body>, for
//                            hosts that supply their own document skeleton
//
// Models are embedded as base64 and handed to GLTFLoader.parse rather than
// fetched, so the page works under a content policy that blocks every kind of
// network request, data: URIs included.

import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');

const mb = (n) => `${(n / 1048576).toFixed(2)}MB`;

// three.js is vendored rather than installed, so point esbuild at the copy the
// page actually ships with.
const vendoredThree = {
  name: 'vendored-three',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: join(ROOT, 'vendor/three/three.module.js') }));
    build.onResolve({ filter: /^three\/addons\// }, (args) => ({
      path: join(ROOT, 'vendor/three/addons', args.path.slice('three/addons/'.length)),
    }));
  },
};

const built = await esbuild.build({
  entryPoints: [join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  plugins: [vendoredThree],
  write: false,
});
const script = built.outputFiles[0].text;

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');

// Reuse the real markup so the bundle can never drift from index.html. The
// importmap and the module tag are dropped: the bundle replaces both.
const page = await readFile(join(ROOT, 'index.html'), 'utf8');
const body = page
  .slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'))
  .replace(/<script type="module"[^>]*><\/script>/, '')
  .trim();
const favicon = page.match(/<link\s+rel="icon"[\s\S]*?\/>/)?.[0] ?? '';

const glbs = (await readdir(join(ROOT, 'assets'))).filter((f) => f.endsWith('.glb')).sort();
const assets = {};
let raw = 0;
for (const file of glbs) {
  const buf = await readFile(join(ROOT, 'assets', file));
  raw += buf.length;
  assets[file.replace(/\.glb$/, '')] = buf.toString('base64');
}
console.log(`${glbs.length} models, ${mb(raw)} -> ${mb(JSON.stringify(assets).length)} base64`);

const head = `<title>Hop &amp; Shop</title>
${favicon}
<style>${css}</style>`;

// The asset table is megabytes of base64, so it goes after the title — hosts
// that scan the first few kilobytes for a <title> must find one.
const inlined = `<script>window.__ASSETS=${JSON.stringify(assets)}</script>
<script type="module">${script}</script>`;

await mkdir(OUT, { recursive: true });

await writeFile(
  join(OUT, 'hop-and-shop.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
${head}
</head>
<body>
${body}
${inlined}
</body>
</html>
`,
);

await writeFile(join(OUT, 'artifact.html'), `${head}\n${body}\n${inlined}\n`);

for (const f of ['hop-and-shop.html', 'artifact.html']) {
  console.log(`dist/${f.padEnd(20)} ${mb((await stat(join(OUT, f))).size)}`);
}
