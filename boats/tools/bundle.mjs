#!/usr/bin/env node
// Builds the whole game into one self-contained .html file: three.js, every
// module, the CSS and the markup, with no request to anything at runtime.
//
//   node tools/bundle.mjs --out dist/harpoon-and-hold.html
//
// The point is a file you can email, drop on any static host, or publish as an
// artifact. It has no server to talk to, so it starts in solo mode -- which
// works because shared/sim.js is transport-free and runs happily in the page.
//
// esbuild does the module graph. It is a build-time dependency only; the game
// itself still has none.

import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const OUT = resolve(ROOT, opt('out', 'dist/harpoon-and-hold.html'));

async function esbuild() {
  const local = join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js');
  if (existsSync(local)) return import(local);
  try { return await import('esbuild'); } catch { /* fall through to install */ }
  console.log('installing esbuild (build-time only)…');
  const r = spawnSync('npm', ['install', '--no-save', '--silent', 'esbuild'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('could not install esbuild; run `npm i -D esbuild` in boats/');
  return import(local);
}

const { build } = await esbuild();

// `/shared/x.js` and the bare `three` specifier only mean something to the dev
// server's routing, so teach the bundler the same two rules.
const routes = {
  name: 'harpoon-routes',
  setup(b) {
    b.onResolve({ filter: /^\/shared\// }, (a) => ({ path: join(ROOT, a.path) }));
    b.onResolve({ filter: /^three$/ }, () => ({ path: join(ROOT, 'public/vendor/three.module.min.js') }));
  },
};

const result = await build({
  entryPoints: [join(ROOT, 'public/src/main.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2022'],
  legalComments: 'inline',      // keep three.js's MIT notice in the file
  plugins: [routes],
  write: false,
  logLevel: 'warning',
});

const js = result.outputFiles[0].text;
const css = await readFile(join(ROOT, 'public/styles.css'), 'utf8');
const html = await readFile(join(ROOT, 'public/index.html'), 'utf8');

// Lift the markup out of index.html: everything between <body> and the module
// script tag, which the bundle replaces.
const body = html
  .slice(html.indexOf('<body>') + 6, html.lastIndexOf('<script type="module"'))
  .trim();

const title = 'Harpoon &amp; Hold';
const out = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<title>${title}</title>
<style>
${css}
</style>
${body}
<script>
window.__SOLO_BUILD__ = true;
// A host may inline this file inside <body>, where a viewport meta tag is
// ignored and the page would render at a desktop width on a phone. Setting it
// from script works wherever the markup ended up.
(function () {
  var head = document.head || document.documentElement;
  var m = document.querySelector('meta[name="viewport"]');
  if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'viewport'); head.appendChild(m); }
  m.setAttribute('content', 'width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover');
  if (!document.title) document.title = 'Harpoon & Hold';
})();
</script>
<script>
${js}
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out);
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`wrote ${OUT} (${kb} KB)`);

if (args.includes('--check')) {
  // Cheap sanity: the bundle must not reference anything it cannot load.
  const bad = [];
  if (/src=["']\.?\//.test(out)) bad.push('a src= attribute survived');
  if (/href=["']\.\//.test(out)) bad.push('a stylesheet link survived');
  if (/import\s*\(/.test(js) && !/__SOLO_BUILD__/.test(out)) bad.push('dynamic import left in');
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  console.log('self-contained: no external references');
}

await rm(join(ROOT, 'dist', '.keep'), { force: true });
