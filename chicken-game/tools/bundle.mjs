#!/usr/bin/env node
// Bundles the ES-module game into one self-contained HTML file.
//
//   node tools/bundle.mjs --root . --out dist/chicken-game.html
//
// Artifact hosting blocks every external request, so nothing may be fetched
// at runtime - not even a sibling .js. Unlike ocean/tools/bundle.mjs this
// does no JS parsing at all: every module becomes a base64 data: URI
// registered in an import map under a bare specifier, and the entry point is
// a one-line dynamic import. That lets the minified three.js build (with its
// own internal `from"./three.core.min.js"` import) pass through untouched
// except for one literal specifier rewrite.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(opt('root', '.'));
const OUT = resolve(opt('out', 'dist/chicken-game.html'));

const dataUri = (src) =>
  'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');

// Local modules import each other as './name.js'; rewrite to the bare
// specifiers the import map defines. Import maps are consulted for bare
// specifiers from any module in the document, data: URLs included -
// relative imports inside a data: module would have no base URL to resolve
// against, which is exactly why the specifiers must become bare.
const rewriteLocal = (src) => src.replace(/from '\.\/([A-Za-z0-9_.-]+\.js)'/g, "from 'game/$1'");

const imports = {};

const core = await readFile(join(ROOT, 'vendor/three.core.min.js'), 'utf8');
imports['three/core'] = dataUri(core);
const wrapper = await readFile(join(ROOT, 'vendor/three.module.min.js'), 'utf8');
imports['three'] = dataUri(wrapper.replaceAll('"./three.core.min.js"', '"three/core"'));

for (const f of await readdir(join(ROOT, 'src'))) {
  if (!f.endsWith('.js')) continue;
  imports[`game/${f}`] = dataUri(rewriteLocal(await readFile(join(ROOT, 'src', f), 'utf8')));
}

// The Artifact wrapper supplies <head>, so the page cannot ship a charset
// meta, and a mis-guessed encoding would garble every emoji in the HUD.
// Emitting pure ASCII makes the page correct under any charset. Module
// sources are safe already: data:;base64 modules always decode as UTF-8.
// Match whole code points (/u), not UTF-16 units: the HUD emoji live in the
// astral planes, and escaping surrogate halves separately yields two invalid
// entities that render as replacement characters.
const NON_ASCII = /[\u0080-\u{10ffff}]/gu;
const escHtml = (s) => s.replace(NON_ASCII, (c) => '&#' + c.codePointAt(0) + ';');
const escCss = (s) => s.replace(NON_ASCII, (c) => '\\' + c.codePointAt(0).toString(16) + ' ');

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// Keep the game's own markup; drop the tags the Artifact wrapper supplies
// and both <script> blocks, which the bundle replaces.
const bodyMarkup = html
  .replace(/<meta[^>]*>/g, '')
  .replace(/<link[^>]*>/g, '')
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<script type="importmap">[\s\S]*?<\/script>/g, '')
  .replace(/<script[^>]*><\/script>/g, '')
  .trim();

const boot = `
// The host supplies <head>, and without a viewport meta a phone lays the
// page out at ~980px and the coop shrinks to a postage stamp.
if (!document.querySelector('meta[name="viewport"]')) {
  const vp = document.createElement('meta');
  vp.name = 'viewport';
  vp.content = 'width=device-width,initial-scale=1,user-scalable=no';
  document.head.appendChild(vp);
}
// Dynamic import so a missing WebGL context (or any startup error) explains
// itself on screen instead of leaving a black rectangle.
import('game/main.js').catch((err) => {
  const t = document.getElementById('ticker');
  if (t) {
    const d = document.createElement('div');
    d.className = 'tick';
    d.style.animation = 'none';
    d.textContent = 'The coop could not open: this browser did not provide WebGL. '
      + 'Current Chrome, Edge, Firefox or Safari with hardware graphics will work. ('
      + (err && err.message ? err.message : err) + ')';
    t.appendChild(d);
  }
  throw err;
});
`;

const page = `<title>Chicken Game</title>
<style>
${escCss(css)}
</style>
${escHtml(bodyMarkup)}
<script type="importmap">
${JSON.stringify({ imports }, null, 1)}
</script>
<script type="module">
${boot}
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`bundled ${Object.keys(imports).length} modules -> ${OUT} (${(page.length / 1024).toFixed(0)} kB)`);
