#!/usr/bin/env node
// Flatten the prototype into one self-contained HTML file — no module loader,
// no network, nothing to serve.
//
//   node tools/bundle.mjs --out dist/corazon-de-gallina.html
//
// Every module (including the two three.js files) is wrapped in its own
// function scope and handed its imports explicitly, so the minified vendor
// code can't collide with anything and neither can our own top-level names.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'dist/corazon-de-gallina.html');

// Dependency order. Each module may only import from ones above it.
const MODULES = [
  'util.js', 'dialogue.js', 'dialogue-timing.js', 'audio-timing.js',
  'chicken.js', 'acting.js', 'cast.js', 'sets.js',
  'camera.js', 'post.js', 'score.js', 'audio-manifest.js', 'audio.js',
  'assets-manifest.js', 'dressing.js',
  'titles.js', 'weather.js', 'record.js', 'subtitles.js', 'director.js', 'main.js',
];

// Vendor ES modules that sit on top of three and are imported by name from
// src/. Bundled between three and our own code, in this order.
const VENDOR = ['GLTFLoaderDeps.js', 'GLTFLoader.js'];

// Hyphens are legal in filenames and illegal in identifiers.
const modVar = (f) => '__m_' + basename(f, '.js').replace(/[^A-Za-z0-9_$]/g, '_');

// --- ES module statements we need to rewrite --------------------------------
// Only the forms this codebase actually uses; anything else throws rather than
// silently producing a broken bundle.
const RE_NS_IMPORT = /^import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"];?$/gm;
const RE_NAMED_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?$/gm;
const RE_REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?$/gm;
const RE_EXPORT_LIST = /^export\s*\{([^}]*)\};?$/gm;
const RE_EXPORT_DECL = /^export\s+(const|let|var|function|class|async function)\s+/gm;

// "a as b, c" -> [{ from: 'a', to: 'b' }, { from: 'c', to: 'c' }]
function parseSpecifiers(list) {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.split(/\s+as\s+/);
    return m.length === 2 ? { from: m[0].trim(), to: m[1].trim() } : { from: s, to: s };
  });
}

function assertNoStragglers(src, label) {
  const bad = src.match(/^\s*(import|export)\b.*$/gm);
  if (bad) throw new Error(`${label}: unhandled module statement:\n  ${bad.slice(0, 3).join('\n  ')}`);
}

// The minified vendor files are three very long lines, so their import/export
// statements sit mid-line and line-anchored matching never sees them. Pull them
// out by brace matching instead.
function cutBraceStatements(src, keyword) {
  const found = [];
  const re = new RegExp(`\\b${keyword}\\s*\\{`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error(`unbalanced ${keyword} braces`);
    const list = src.slice(open + 1, i);
    // Consume an optional `from "..."` and the terminating semicolon.
    let j = i + 1;
    let from = null;
    const tail = src.slice(j, j + 200);
    const fm = tail.match(/^\s*from\s*(['"])([^'"]+)\1/);
    if (fm) { from = fm[2]; j += fm[0].length; }
    if (src[j] === ';') j++;
    found.push({ list, from });
    out += src.slice(last, m.index);
    last = j;
    re.lastIndex = j;
  }
  out += src.slice(last);
  return { src: out, found };
}

// --- vendor: three.js -------------------------------------------------------
// three.module.min.js imports from and re-exports three.core.min.js. Give each
// its own closure and wire the two together by hand.
async function bundleThree() {
  const coreSrc = await readFile(join(ROOT, 'vendor/three/three.core.min.js'), 'utf8');
  const modSrc = await readFile(join(ROOT, 'vendor/three/three.module.min.js'), 'utf8');

  // The core is a leaf: strip its export list and return it as an object.
  const core = cutBraceStatements(coreSrc, 'export');
  if (core.found.length !== 1) throw new Error(`three.core: expected 1 export list, got ${core.found.length}`);
  const coreExports = parseSpecifiers(core.found[0].list);
  const coreBody = core.src;

  // The module pulls names out of the core, re-exports a slice of them, and
  // adds its own.
  const modImports = cutBraceStatements(modSrc, 'import');
  if (modImports.found.length !== 1) throw new Error('three.module: expected 1 import list');
  const imported = parseSpecifiers(modImports.found[0].list);
  const modExports = cutBraceStatements(modImports.src, 'export');
  const reexported = modExports.found.filter((f) => f.from).flatMap((f) => parseSpecifiers(f.list));
  const own = modExports.found.filter((f) => !f.from);
  if (own.length !== 1) throw new Error(`three.module: expected 1 own export list, got ${own.length}`);
  const ownExports = parseSpecifiers(own[0].list);
  const modBody = modExports.src;

  const asObj = (specs, src) => specs.map((s) => `${JSON.stringify(s.to)}:${src(s)}`).join(',');

  return `
const __three_core = (function(){
${coreBody}
return {${asObj(coreExports, (s) => s.from)}};
})();
const THREE = (function(){
const {${imported.map((s) => `${s.from}:${s.to}`).join(',')}} = __three_core;
${modBody}
return Object.assign({${reexported.map((s) => `${JSON.stringify(s.to)}:__three_core[${JSON.stringify(s.from)}]`).join(',')}}, {${asObj(ownExports, (s) => s.from)}});
})();
`;
}

// The soundtrack, as base64. This is what makes the single file self-contained
// rather than merely single: without it the page loads and plays silently.
async function audioManifestModule() {
  const { readdir } = await import('node:fs/promises');
  let files = [];
  try {
    files = (await readdir(join(ROOT, 'audio'))).filter((f) => f.endsWith('.mp3')).sort();
  } catch {
    console.warn('no audio/ directory — bundling without the soundtrack');
  }
  const entries = [];
  let bytes = 0;
  for (const f of files) {
    const buf = await readFile(join(ROOT, 'audio', f));
    bytes += buf.length;
    entries.push(`${JSON.stringify(basename(f, '.mp3'))}:"data:audio/mpeg;base64,${buf.toString('base64')}"`);
  }
  console.error(`  audio: ${files.length} clips, ${(bytes / 1048576).toFixed(2)} MB`);
  return `export const AUDIO = {${entries.join(',\n')}};
export const AUDIO_NAMES = Object.keys(AUDIO);`;
}

// The props, as base64, for the same reason as the soundtrack: the published
// page's policy refuses fetch(), so nothing can be loaded at run time.
async function assetManifestModule() {
  const { readdir } = await import('node:fs/promises');
  const { ASSET_NAMES } = await import(new URL('../src/assets-manifest.js', import.meta.url));
  let present = [];
  try {
    present = (await readdir(join(ROOT, 'assets'))).filter((f) => f.endsWith('.glb'));
  } catch {
    console.warn('no assets/ directory — bundling without the modelled props');
  }
  const entries = [];
  let bytes = 0;
  for (const name of ASSET_NAMES) {
    if (!present.includes(`${name}.glb`)) {
      console.error(`  assets: ${name}.glb missing, skipped`);
      continue;
    }
    const buf = await readFile(join(ROOT, 'assets', `${name}.glb`));
    bytes += buf.length;
    entries.push(`${JSON.stringify(name)}:"data:model/gltf-binary;base64,${buf.toString('base64')}"`);
  }
  console.error(`  assets: ${entries.length} props, ${(bytes / 1048576).toFixed(2)} MB`);
  return `export const ASSETS = {${entries.join(',\n')}};
export const ASSET_NAMES = Object.keys(ASSETS);`;
}

// --- our own modules --------------------------------------------------------
async function bundleModule(file, dir = 'src') {
  const src = file === 'audio-manifest.js' ? await audioManifestModule()
    : file === 'assets-manifest.js' ? await assetManifestModule()
      : await readFile(join(ROOT, dir, file), 'utf8');
  const exported = [];
  let body = src
    // `import * as THREE` — THREE is already a top-level binding in the bundle.
    .replace(RE_NS_IMPORT, (_, name) => (name === 'THREE' ? '' : (() => {
      throw new Error(`${file}: unexpected namespace import ${name}`);
    })()))
    .replace(RE_NAMED_IMPORT, (_, list, from) => {
      const dep = basename(from);
      const specs = parseSpecifiers(list);
      const bind = (v) => `const {${specs.map((s) => `${s.from}:${s.to}`).join(',')}} = ${v};`;
      // three itself is the top-level THREE binding.
      if (dep === 'three.module.min.js') return bind('THREE');
      if (VENDOR.includes(dep)) return bind(modVar(dep));
      if (!MODULES.includes(dep)) throw new Error(`${file}: imports unknown module ${from}`);
      if (MODULES.indexOf(dep) >= MODULES.indexOf(file)) {
        throw new Error(`${file}: imports ${dep}, which is not bundled before it`);
      }
      return bind(modVar(dep));
    })
    .replace(RE_EXPORT_LIST, (_, list) => {
      for (const s of parseSpecifiers(list)) exported.push(s);
      return '';
    })
    .replace(RE_EXPORT_DECL, (_, kw) => {
      // Record the declared name, then drop the `export` keyword.
      return `${kw} `;
    });

  // Names declared with `export const foo` were stripped above; find them again
  // from the original source so the closure returns them.
  for (const m of src.matchAll(/^export\s+(?:const|let|var|function|class|async function)\s+(\w+)/gm)) {
    exported.push({ from: m[1], to: m[1] });
  }
  assertNoStragglers(body, file);

  const ret = exported.length
    ? `return {${exported.map((s) => `${JSON.stringify(s.to)}:${s.from}`).join(',')}};`
    : 'return {};';
  return `const ${modVar(file)} = (function(){\n${body}\n${ret}\n})();\n`;
}

// --- page -------------------------------------------------------------------
const [three, css, html] = await Promise.all([
  bundleThree(),
  readFile(join(ROOT, 'src/ui.css'), 'utf8'),
  readFile(join(ROOT, 'index.html'), 'utf8'),
]);

const mods = [];
for (const f of VENDOR) mods.push(await bundleModule(f, 'vendor/three'));
for (const f of MODULES) mods.push(await bundleModule(f));

const markup = html
  .replace(/^\s*<meta[^>]*>\s*$/gm, '')
  .replace(/^\s*<link[^>]*ui\.css[^>]*>\s*$/gm, '')
  .replace(/^\s*<script[^>]*main\.js[^>]*><\/script>\s*$/gm, '')
  .trim();

// Escape every non-ASCII character so the file survives being served without
// an explicit charset — markup as numeric entities, script as \uXXXX (valid in
// strings, template literals and regexes alike). The CSS is ASCII already.
const entities = (s) => s.replace(/[^\x00-\x7F]/g, (c) => `&#x${c.codePointAt(0).toString(16)};`);
const jsEscapes = (s) => s.replace(/[^\x00-\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The <title> keeps its real accents (a charset meta covers it); escaping it
// would leave entity text in the browser tab if anything read it raw.
const titleTag = markup.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '';
const escapedMarkup = entities(markup.replace(titleTag, '@@TITLE@@')).replace('@@TITLE@@', titleTag);

const page = `<meta charset="utf-8">
${escapedMarkup}

<style>
${css.trim()}
</style>

<script>
"use strict";
(function(){
${jsEscapes(three)}
${jsEscapes(mods.join('\n'))}
})();
</script>
`;

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await writeFile(join(ROOT, OUT), page);
console.log(JSON.stringify({
  out: OUT,
  bytes: page.length,
  mb: +(page.length / 1048576).toFixed(2),
  modules: MODULES.length + VENDOR.length,
}, null, 2));
