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
const ENTRY = opt('entry', 'demo/main.js');

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
  // `export { a, b };` - a re-export list. Missing this was not a cosmetic gap:
  // stripping the leading `export` left `{ a, b };`, a perfectly valid block
  // statement, so the build succeeded and the names simply never reached the
  // module object. The failure surfaced at runtime as "a is not a function".
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return [...names].filter((n) => /^[A-Za-z0-9_$]+$/.test(n));
}

// `export { x } from './y.js'` re-exports across a module boundary, which this
// bundler has no representation for. Fail the build rather than emit something
// that looks fine and is missing a binding.
function assertNoReExportFrom(id, src) {
  const m = src.match(/^export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"][^'"]+['"]/m);
  if (m) {
    throw new Error(
      `${id}: \`${m[0].trim()}\` is not supported by this bundler.\n` +
      '  Import the binding and re-export it in a separate statement instead.');
  }
}

const modules = new Map();

async function load(id) {
  if (modules.has(id)) return;
  modules.set(id, null);                       // reserve, breaks any cycle
  const src = await readFile(join(ROOT, id), 'utf8');
  assertNoReExportFrom(id, src);
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
  body = body.replace(/^export\s*\{[^}]*\}\s*;\s*$/gm, '');
  body = body.replace(/^export\s+/gm, '');
  body += `\nObject.assign(__x, { ${names.join(', ')} });\n`;
  modules.set(id, { body, deps, names });
  for (const d of deps) await load(d);
}

await load(ENTRY);

const BUILD_ID = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

const runtime = `
(function(){
"use strict";
// Set before any module runs, so it survives a startup failure. If this is
// undefined in the console, the page being served is older than this build.
window.abyssalBuild = ${JSON.stringify(BUILD_ID)};
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
// The host supplies <head>, and a <meta> in the body is not reliably honoured,
// so the viewport is declared from script. Without it a phone lays the page out
// at ~980px, the mobile breakpoints never match, and the desktop control panel
// is scaled down onto the screen covering most of the view.
if (!document.querySelector('meta[name="viewport"]')) {
  var vp = document.createElement('meta');
  vp.name = 'viewport';
  vp.content = 'width=device-width,initial-scale=1,viewport-fit=cover';
  document.head.appendChild(vp);
}
try {
  __req(${JSON.stringify(ENTRY)});
} catch (err) {
  // Kept reachable from the console: a failure that leaves no window.abyssal
  // otherwise gives the reader nothing to report back.
  window.abyssalError = err;
  console.error('Abyssal build ' + window.abyssalBuild + ' failed to start:', err);
  var boot = document.getElementById('boot');
  if (boot) {
    boot.classList.remove('gone');
    boot.innerHTML = '<div class="boot-title">ABYSSAL</div>' +
      '<div class="boot-sub" style="max-width:30rem;text-align:center;line-height:1.7;text-transform:none;letter-spacing:0">' +
      (/WebGL2|EXT_color_buffer_float/i.test(String(err && err.message))
        ? 'This simulator needs WebGL2 with floating-point render targets, which this browser did not provide.' +
          '<br><br>It runs in current Chrome, Edge, Firefox and Safari 16+ on a machine with hardware graphics enabled.'
        : 'Abyssal failed to start.<br><br><span style="font-family:ui-monospace,monospace;font-size:.85em;opacity:.8">' +
          String((err && (err.message || err)) || 'unknown error').replace(/[<>&]/g, '') + '</span>') +
      '<br><br><span style="font-size:.72em;opacity:.45;letter-spacing:.05em">build ' + window.abyssalBuild + '</span>' +
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

const css = await readFile(join(ROOT, 'demo/ui.css'), 'utf8');
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
