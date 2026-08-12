#!/usr/bin/env node
// Bundles the game into one self-contained HTML file — no imports, no fetches,
// models included.
//
//   node tools/bundle.mjs --out dist/tiny-worlds.html
//   node tools/bundle.mjs --out dist/small.html --skip keeper-run.glb
//
// Artifact hosting blocks every external request, so nothing may be loaded at
// runtime: not a sibling .js, not three.js, not a .glb, not even a data: URL
// (fetch to one still goes through connect-src). Each module is wrapped in its
// own function so module scope survives — half a dozen files here declare their
// own `_v` scratch vector — and the models ride along as base64 that
// src/assets.js hands straight to GLTFLoader.parse.
//
// Derived from ocean/tools/bundle.mjs, extended for namespace imports, bare
// specifiers resolved through the import map, and the embedded assets.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripToAnimation, isClipOnly } from './strip-anim.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const multi = (n) => args.reduce((a, v, i) => (v === '--' + n ? [...a, args[i + 1]] : a), []);

const ROOT = resolve(opt('root', resolve(dirname(fileURLToPath(import.meta.url)), '..')));
const OUT = resolve(ROOT, opt('out', 'dist/tiny-worlds.html'));
const ENTRY = opt('entry', 'src/main.js');
const SKIP = new Set(multi('skip'));

// The page's import map, in Node form.
const BARE = { three: 'vendor/three.module.js' };
const ADDONS = 'three/addons/';

const NAMED_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const NAMESPACE_RE = /^\s*import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;

function resolveSpec(spec, fromId) {
  if (BARE[spec]) return BARE[spec];
  if (spec.startsWith(ADDONS)) return `vendor/jsm/${spec.slice(ADDONS.length)}`;
  return relative(ROOT, resolve(dirname(join(ROOT, fromId)), spec)).split('\\').join('/');
}

// `export const A = 1, B = 2;` is legal, so collect every declarator name.
function declaredExports(src) {
  const names = new Set();
  // `export async function` and generators count too — missing the `async`
  // form silently drops the export and the failure surfaces far away, as
  // "loadAssets is not a function".
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
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

  const bind = (names) => names.split(',').map((n) => n.trim()).filter(Boolean)
    .map((n) => n.replace(/\s+as\s+/, ': ')).join(', ');

  let body = src
    .replace(NAMED_RE, (_all, names, spec) => {
      const dep = resolveSpec(spec, id);
      deps.push(dep);
      return `const { ${bind(names)} } = __req(${JSON.stringify(dep)});`;
    })
    .replace(NAMESPACE_RE, (_all, ns, spec) => {
      const dep = resolveSpec(spec, id);
      deps.push(dep);
      return `const ${ns} = __req(${JSON.stringify(dep)});`;
    });

  // `export { a, b as c };` — three.module.js ends with one enormous one.
  const listed = [];
  body = body.replace(EXPORT_LIST_RE, (_all, names) => {
    for (const entry of names.split(',').map((n) => n.trim()).filter(Boolean)) {
      const [local, exported = local] = entry.split(/\s+as\s+/).map((n) => n.trim());
      listed.push(`${JSON.stringify(exported)}: ${local}`);
    }
    return '';
  });

  const declared = declaredExports(body);
  body = body.replace(/^export\s+/gm, '');
  // Modules are functions here, so `import.meta` would be a syntax error. The
  // only use is resolving sibling assets, which the bundle embeds anyway.
  body = body.replace(/import\.meta\.url/g, 'document.baseURI');

  const assigns = [...declared.map((n) => `${JSON.stringify(n)}: ${n}`), ...listed];
  body += `\nObject.assign(__x, { ${assigns.join(', ')} });\n`;

  modules.set(id, { body, deps });
  for (const d of deps) await load(d);
}

await load(ENTRY);

// ------------------------------------------------------------------ assets

const assetDir = join(ROOT, 'assets');
const files = (await readdir(assetDir)).filter((f) => f.endsWith('.glb') && !SKIP.has(f));
// keeper-rig.glb is the intermediate the retargets were built from; the game
// never loads it, so it does not belong in a single-file build.
const used = files.filter((f) => f !== 'keeper-rig.glb');
const assetEntries = [];
let assetBytes = 0;
let strippedBytes = 0;
for (const f of used) {
  const raw = await readFile(join(assetDir, f));
  // Clip-only retargets ship as keyframes alone; their mesh and textures are a
  // duplicate of the idle model's and would roughly double the page.
  const buf = isClipOnly(f) ? stripToAnimation(raw) : raw;
  assetBytes += raw.length;
  strippedBytes += buf.length;
  assetEntries.push(`${JSON.stringify(f)}: "${buf.toString('base64')}"`);
}

// ------------------------------------------------------------------- page

let out = `
(function(){
"use strict";
var __defs = {}, __cache = {};
function __req(id){
  if (__cache[id]) return __cache[id];
  var x = __cache[id] = {};
  __defs[id](x, __req);
  return x;
}
globalThis.__TINY_WORLDS_ASSETS = {
${assetEntries.join(',\n')}
};
`;

// The entry is emitted async because main.js uses top-level await (it awaits
// the assets, then yields between planets so the loading bar can paint) and a
// plain function wrapper makes that a syntax error. Nothing imports the entry,
// so nothing has to wait on it; a non-entry module using top-level await would
// need a full async require chain and is not supported here.
for (const [id, mod] of modules) {
  const async = id === ENTRY ? 'async ' : '';
  out += `\n__defs[${JSON.stringify(id)}] = ${async}function(__x, __req){\n${mod.body}\n};\n`;
}

out += `
// The host supplies <head>, and a <meta> in the body is not reliably honoured,
// so the viewport is declared from script. Without it a phone lays the page out
// at ~980px and every mobile breakpoint misses.
if (!document.querySelector('meta[name="viewport"]')) {
  var vp = document.createElement('meta');
  vp.name = 'viewport';
  vp.content = 'width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover';
  document.head.appendChild(vp);
}
function __fail(err) {
  var boot = document.getElementById('loading');
  if (boot) {
    boot.classList.remove('gone');
    boot.innerHTML = '<div id="loading-title">Tiny Worlds</div>' +
      '<div id="loading-sub" style="max-width:30rem;text-align:center;line-height:1.8;' +
      'text-transform:none;letter-spacing:0">This game needs WebGL, which this browser did not ' +
      'provide. It runs in current Chrome, Edge, Firefox and Safari on a machine with hardware ' +
      'graphics enabled.</div>';
  }
  console.error(err);
}
try {
  var __main = __defs[${JSON.stringify(ENTRY)}]({}, __req);
  if (__main && typeof __main.then === 'function') __main.catch(__fail);
} catch (err) {
  __fail(err);
  throw err;
}
})();
`;

// The Artifact wrapper supplies <head>, so we cannot ship a charset meta and a
// mis-guessed encoding would render an em dash as "\u00e2\u0080\u0094". Emitting
// pure ASCII makes the page correct under whatever charset the host picks.
const NON_ASCII = /[\u0080-\uffff]/g;
const escJs = (s) => s.replace(NON_ASCII, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const escHtml = (s) => s.replace(NON_ASCII, (c) => '&#' + c.charCodeAt(0) + ';');
const escCss = (s) => s.replace(NON_ASCII, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ');

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// Keep the game's own markup; drop the tags the wrapper supplies and every
// script, which the bundle replaces.
const bodyMarkup = html
  .replace(/<!doctype html>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<meta[^>]*>/g, '')
  .replace(/<link[^>]*>/g, '')
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .trim();

const page = `<title>Tiny Worlds</title>
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
console.log(`bundled ${modules.size} modules + ${used.length} models `
  + `(${(assetBytes / 1e6).toFixed(1)} MB raw, ${(strippedBytes / 1e6).toFixed(1)} MB after stripping `
  + `clip-only retargets) -> ${relative(ROOT, OUT)} (${(page.length / 1e6).toFixed(2)} MB)`);
