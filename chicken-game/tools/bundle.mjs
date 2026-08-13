#!/usr/bin/env node
// Bundles the ES-module game into one self-contained HTML file.
//
//   node tools/bundle.mjs --root . --out dist/chicken-game.html
//
// Artifact hosting blocks every external request, and its CSP allows inline
// scripts but NOT data: URIs as script sources - an import map of
// base64 modules loads locally yet dies on the real host with "Failed to
// fetch dynamically imported module". So everything becomes one inline
// classic script: each module is wrapped in a function with a tiny require
// shim (the ocean/tools/bundle.mjs approach), extended to also digest the
// minified three.js build, whose entire surface is three statement shapes:
// `import{A as e,...}from"./three.core.min.js"`, a re-export
// `export{A,...}from"./three.core.min.js"`, and a plain `export{e as A,...}`
// (verified counts: no export*, no export declarations, no import.meta, no
// dynamic import in either file - and the files are single lines, so count
// statements with a real regex scan, never `grep -c`).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(opt('root', '.'));
const OUT = resolve(opt('out', 'dist/chicken-game.html'));
const ENTRY = 'src/main.js';

// 'three' is the only bare specifier; everything else is a relative path.
const resolveSpec = (spec, fromId) =>
  spec === 'three'
    ? 'vendor/three.module.min.js'
    : relative(ROOT, resolve(dirname(join(ROOT, fromId)), spec)).split('\\').join('/');

// `a as b` in an import list is `a: b` in a destructure; in an export list
// it's `b: a` in an object literal.
const destructure = (names) => names.split(',').map((n) => n.trim()).filter(Boolean)
  .map((n) => n.replace(/\s+as\s+/, ': ')).join(', ');
const exportObject = (names) => names.split(',').map((n) => n.trim()).filter(Boolean)
  .map((n) => { const [a, b] = n.split(/\s+as\s+/); return b ? `${b}: ${a}` : `${a}: ${a}`; })
  .join(', ');

// `export const A = 1, B = 2;` is legal, so collect every declarator name.
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:function|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+(.+)$/gm)) {
    let depth = 0, cur = '';
    for (const ch of m[1]) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      if (depth === 0 && (ch === '=' || ch === ';')) { if (cur.trim()) names.add(cur.trim()); cur = ''; break; }
      if (depth === 0 && ch === ',') { if (cur.trim()) names.add(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
  }
  return [...names].filter((n) => /^[A-Za-z0-9_$]+$/.test(n));
}

const modules = new Map();

async function load(id) {
  if (modules.has(id)) return;
  modules.set(id, null);                       // reserve, breaks any cycle
  const src = await readFile(join(ROOT, id), 'utf8');
  const deps = [];
  const dep = (spec) => { const d = resolveSpec(spec, id); deps.push(d); return d; };

  let body = src
    // import * as NS from '...';   (the game's `import * as THREE`)
    .replace(/^\s*import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from\s*['"]([^'"]+)['"];?\s*$/gm,
      (_, ns, spec) => `const ${ns} = __req(${JSON.stringify(dep(spec))});`)
    // import { a, b as c } from '...';   (also matches the minified one-liner)
    .replace(/(?:^|\b)import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g,
      (_, names, spec) => `const { ${destructure(names)} } = __req(${JSON.stringify(dep(spec))});`)
    // export * from '...';   (none today, cheap to support)
    .replace(/(?:^|\b)export\s*\*\s*from\s*['"]([^'"]+)['"];?/g,
      (_, spec) => `Object.assign(__x, __req(${JSON.stringify(dep(spec))}));`)
    // export { a, b as c } from '...';   (must run before the plain form,
    // which would otherwise strand the `from"..."` clause as a syntax error)
    .replace(/(?:^|\b)export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g,
      (_, names, spec) => {
        const fields = names.split(',').map((n) => n.trim()).filter(Boolean)
          .map((n) => { const [a, b] = n.split(/\s+as\s+/); return `${b ?? a}: __m.${a}`; })
          .join(', ');
        return `Object.assign(__x, (function (__m) { return { ${fields} }; })(__req(${JSON.stringify(dep(spec))})));`;
      })
    // export { a, b as c };   (the rest of the minified export surface)
    .replace(/(?:^|\b)export\s*\{([^}]*)\};?/g,
      (_, names) => `Object.assign(__x, { ${exportObject(names)} });`);

  // Declaration exports (game sources): strip the keyword, assign at the end.
  const names = exportedNames(body);
  body = body.replace(/^export\s+/gm, '');
  if (names.length) body += `\nObject.assign(__x, { ${names.join(', ')} });\n`;

  modules.set(id, { body, deps });
  for (const d of deps) await load(d);
}

await load(ENTRY);

let js = `(function () {
"use strict";
var __defs = {}, __cache = {};
function __req(id) {
  if (__cache[id]) return __cache[id];
  var x = __cache[id] = {};
  __defs[id](x, __req);
  return x;
}
`;
for (const [id, mod] of modules) {
  js += `\n__defs[${JSON.stringify(id)}] = function (__x, __req) {\n${mod.body}\n};\n`;
}
js += `
// The host supplies <head>, and without a viewport meta a phone lays the
// page out at ~980px and the coop shrinks to a postage stamp.
if (!document.querySelector('meta[name="viewport"]')) {
  var vp = document.createElement('meta');
  vp.name = 'viewport';
  vp.content = 'width=device-width,initial-scale=1,user-scalable=no';
  document.head.appendChild(vp);
}
// A standalone page has no console worth checking, so a missing WebGL
// context (or any startup error) explains itself on screen instead of
// leaving a black rectangle.
try {
  __req(${JSON.stringify(ENTRY)});
} catch (err) {
  var t = document.getElementById('fatal');
  if (t) {
    t.style.display = 'block';
    t.textContent = 'The coop could not open. This usually means WebGL is unavailable; '
      + 'current Chrome, Edge, Firefox or Safari with hardware graphics will work. ('
      + (err && err.message ? err.message : err) + ')';
  }
  throw err;
}
})();
`;

// The Artifact wrapper supplies <head>, so the page cannot ship a charset
// meta, and a mis-guessed encoding would garble every emoji in the HUD.
// Emitting pure ASCII makes the page correct under any charset.
// HTML/CSS escape by code point: the HUD emoji live in the astral planes,
// and escaping surrogate halves separately yields invalid entities. JS
// escapes by UTF-16 unit, which is exactly what \\u escapes encode.
const NON_ASCII_CP = /[\u0080-\u{10ffff}]/gu;
const NON_ASCII_UNIT = /[\u0080-\uffff]/g;
const escHtml = (s) => s.replace(NON_ASCII_CP, (c) => '&#' + c.codePointAt(0) + ';');
const escCss = (s) => s.replace(NON_ASCII_CP, (c) => '\\' + c.codePointAt(0).toString(16) + ' ');
const escJs = (s) => s.replace(NON_ASCII_UNIT, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// A literal </script> in the JS would end the inline script mid-bundle.
// \\/ is an identity escape in strings, templates and regexes, and the
// sequence cannot appear outside one in valid minified code.
if (js.includes('</script')) js = js.replaceAll('</script', '<\\/script');

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

const page = `<title>Chicken Game</title>
<style>
${escCss(css)}
</style>
${escHtml(bodyMarkup)}
<script>
${escJs(js)}
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`bundled ${modules.size} modules -> ${OUT} (${(page.length / 1024).toFixed(0)} kB)`);
