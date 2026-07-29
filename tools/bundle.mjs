#!/usr/bin/env node
// Bundles the ES-module app into one self-contained HTML file.
//
//   node tools/bundle.mjs --root . --out dist/abyssal.html
//
// Artifact hosting blocks every external request, so nothing may be fetched at
// runtime - not even a sibling .js. Each module is wrapped in its own function
// so module scope survives (math.js and spray.js both define `smoothstep`, and
// concatenating them flat would be a redeclaration error).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(opt('root', '.'));
const OUT = resolve(opt('out', 'dist/abyssal.html'));
const ENTRY = opt('entry', 'src/main.js');

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

// `export const A = 1, B = 2;` is legal, so collect every declarator name.
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:function|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+(.+)$/gm)) {
    // Only the declarator heads on this line; nested initialisers can contain
    // commas, so stop at the first `=` of each declarator.
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
  let body = src.replace(IMPORT_RE, (_all, names, spec) => {
    const dep = relative(ROOT, resolve(dirname(join(ROOT, id)), spec)).split('\\').join('/');
    deps.push(dep);
    // `a as b` in an import list is `a: b` in a destructure.
    const bind = names.split(',').map((n) => n.trim()).filter(Boolean)
      .map((n) => n.replace(/\s+as\s+/, ': ')).join(', ');
    return `const { ${bind} } = __req(${JSON.stringify(dep)});`;
  });
  const names = exportedNames(body);
  body = body.replace(/^export\s+/gm, '');
  body += `\nObject.assign(__x, { ${names.join(', ')} });\n`;
  modules.set(id, { body, deps, names });
  for (const d of deps) await load(d);
}

await load(ENTRY);

const runtime = `
(function(){
"use strict";
var __defs = {}, __cache = {};
function __req(id){
  if (__cache[id]) return __cache[id];
  var x = __cache[id] = {};
  __defs[id](x, __req);
  return x;
}
`;

let out = runtime;
for (const [id, mod] of modules) {
  out += `\n__defs[${JSON.stringify(id)}] = function(__x, __req){\n${mod.body}\n};\n`;
}
// A standalone page has no console to check, so a missing WebGL2 or float-buffer
// extension has to explain itself on screen instead of leaving a black rectangle.
out += `
try {
  __req(${JSON.stringify(ENTRY)});
} catch (err) {
  var boot = document.getElementById('boot');
  if (boot) {
    boot.classList.remove('gone');
    boot.innerHTML = '<div class="boot-title">ABYSSAL</div>' +
      '<div class="boot-sub" style="max-width:30rem;text-align:center;line-height:1.7;text-transform:none;letter-spacing:0">' +
      'This simulator needs WebGL2 with floating-point render targets, which this browser did not provide.' +
      '<br><br>It runs in current Chrome, Edge, Firefox and Safari 16+ on a machine with hardware graphics enabled.' +
      '</div>';
  }
  throw err;
}
})();
`;

// The Artifact wrapper supplies <head>, so we cannot ship a charset meta and a
// mis-guessed encoding would render "·" as "Â·". Emitting pure ASCII makes the
// page correct under any charset the host picks.
const NON_ASCII = /[\u0080-\uffff]/g;
const escJs   = (s) => s.replace(NON_ASCII, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const escHtml = (s) => s.replace(NON_ASCII, (c) => '&#' + c.charCodeAt(0) + ';');
const escCss  = (s) => s.replace(NON_ASCII, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ');

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// Keep the app's own markup; drop the tags the Artifact wrapper supplies and the
// module <script>, which the bundle replaces.
const bodyMarkup = html
  .replace(/<meta[^>]*>/g, '')
  .replace(/<link[^>]*>/g, '')
  .replace(/<script[^>]*><\/script>/g, '')
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .trim();

const page = `<title>Abyssal &#8212; Real-Time Ocean Simulator</title>
<style>
${escCss(css)}
</style>
${escHtml(bodyMarkup)}
<script>
${escJs(out)}
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`bundled ${modules.size} modules -> ${OUT} (${(page.length / 1024).toFixed(0)} kB)`);
