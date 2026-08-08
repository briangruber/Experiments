#!/usr/bin/env node
// Bundles the game into one self-contained HTML fragment.
//
//   node tools/bundle.mjs --out dist/saltyfin.html
//
// Artifact hosting blocks every external request, so nothing may be fetched at
// runtime — not even a sibling .js. Each module is wrapped in its own function
// so module scope survives; concatenating them flat would collide (several
// modules define `C`, `_v`, `TAU`).
//
// three.js comes in as the CommonJS build, which is the only single-file one:
// the ESM build is split across three.module.js and three.core.js, and merging
// two minified module scopes into one risks a top-level name collision. The CJS
// file is self-contained and only needs a four-line `module.exports` shim.
//
// The output is a FRAGMENT, not a document: the Artifact host supplies
// <!doctype>, <html>, <head> and <body>.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(opt('root', join(HERE, '..')));
const OUT = resolve(opt('out', join(ROOT, 'dist/saltyfin.html')));
const ENTRY = opt('entry', 'src/main.js');
const THREE_CJS = resolve(opt('three', join(ROOT, 'vendor/three/three.cjs')));

const NAMED_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const NS_RE = /^\s*import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

/** `export const A = 1, B = 2;` is legal, so collect every declarator name. */
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

  const specToId = (spec, fromId) => {
    if (spec === 'three') return 'three';
    return relative(ROOT, resolve(dirname(join(ROOT, fromId)), spec)).split('\\').join('/');
  };

  let body = src.replace(NS_RE, (_all, name, spec) => {
    const dep = specToId(spec, id);
    deps.push(dep);
    return `const ${name} = __req(${JSON.stringify(dep)});`;
  });

  body = body.replace(NAMED_RE, (_all, names, spec) => {
    const dep = specToId(spec, id);
    deps.push(dep);
    // `a as b` in an import list is `a: b` in a destructure.
    const bind = names.split(',').map((n) => n.trim()).filter(Boolean)
      .map((n) => n.replace(/\s+as\s+/, ': ')).join(', ');
    return `const { ${bind} } = __req(${JSON.stringify(dep)});`;
  });

  // `export { a, b as c };` — collect the outward names, then drop the statement.
  const names = exportedNames(body);
  const reexport = [];
  body = body.replace(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm, (_all, list) => {
    for (const part of list.split(',')) {
      const [local, exported] = part.split(/\s+as\s+/).map((t) => t.trim());
      if (local) reexport.push(exported ? `${exported}: ${local}` : local);
    }
    return '';
  });
  const leftover = body.match(/^\s*(import|export)\s+.*$/gm)
    ?.filter((l) => !/^\s*export\s+(function|class|const|let|var)\s/.test(l));
  if (leftover?.length) throw new Error(`${id}: unsupported module syntax\n  ${leftover.join('\n  ')}`);

  body = body.replace(/^export\s+/gm, '');
  body += `\nObject.assign(__x, { ${[...names, ...reexport].join(', ')} });\n`;
  modules.set(id, { body, deps: [...new Set(deps)], names });
  for (const d of deps) if (d !== 'three') await load(d);
}

await load(ENTRY);

const threeSrc = await readFile(THREE_CJS, 'utf8');
const css = await readFile(join(ROOT, 'src/hud/hud.css'), 'utf8');

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
// three ships a single-file CommonJS build; give it the two globals it expects.
__defs["three"] = function(__x, __req){
  var module = { exports: __x }, exports = __x;
${threeSrc}
  if (module.exports !== __x) Object.assign(__x, module.exports);
};
`;

let out = runtime;
for (const [id, mod] of modules) {
  if (!mod) continue;
  out += `\n__defs[${JSON.stringify(id)}] = function(__x, __req){\n${mod.body}\n};\n`;
}

out += `
// The host supplies <head>, and a <meta> in the body is not reliably honoured,
// so the viewport is declared from script. Without it a phone lays the page out
// at ~980px and every touch target lands in the wrong place.
if (!document.querySelector('meta[name="viewport"]')) {
  var vp = document.createElement('meta');
  vp.name = 'viewport';
  vp.content = 'width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no';
  document.head.appendChild(vp);
}
try {
  __req(${JSON.stringify(ENTRY)});
} catch (err) {
  var boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = '<div style="max-width:26rem;text-align:center;line-height:1.7;' +
      'text-transform:none;letter-spacing:0;padding:2rem">' +
      '<b style="letter-spacing:.2em;text-transform:uppercase">Salty Fin</b><br><br>' +
      'This needs WebGL2 with floating-point render targets, which this browser did not provide.' +
      '<br><br>It runs in current Chrome, Edge, Firefox and Safari 16+.</div>';
  }
  throw err;
}
})();
`;

// The Artifact wrapper supplies <head>, so we cannot ship a charset meta and a
// mis-guessed encoding would render an em dash as garbage. Pure ASCII is correct
// under whatever charset the host picks.
const NON_ASCII = /[\u0080-\uffff]/g;
const escJs = (s) => s.replace(NON_ASCII, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const escCss = (s) => s.replace(NON_ASCII, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ');

const page = `<title>Salty Fin</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #05070f;
  overscroll-behavior: none; }
#gl { display: block; width: 100vw; height: 100vh; touch-action: none; }
#boot { position: fixed; inset: 0; display: grid; place-items: center; z-index: 60;
  font: 500 13px/1.6 ui-sans-serif, system-ui, sans-serif; letter-spacing: .18em;
  text-transform: uppercase; color: #7fa8c8; background: #05070f; }
${escCss(css)}
</style>
<canvas id="gl"></canvas>
<div id="hud" aria-hidden="true"></div>
<div id="boot">Salty Fin</div>
<script>
${escJs(out)}
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`bundled ${[...modules.values()].filter(Boolean).length} modules + three -> ${OUT} (${(page.length / 1024).toFixed(0)} kB)`);
