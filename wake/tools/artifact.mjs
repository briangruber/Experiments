#!/usr/bin/env node
// Bundle the whole prototype into one self-contained HTML file for publishing.
//
// There is no build tool here, and three.js ships as two files that import each
// other by relative path — so instead of flattening the module graph, we keep
// it and rehost it: every module becomes a Blob URL, and each module's import
// specifiers are rewritten to point at the URLs of its dependencies. Modules
// are created in dependency order so a URL always exists before it is named.
//
//   node tools/artifact.mjs --out dist/wake-lab.html

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const OUT = resolve(ROOT, opt('out', 'dist/wake-lab.html'));
const PREWARM = +opt('prewarm', 55);

// Dependency order. Each entry lists the specifiers it imports, mapped to the
// key of the module that satisfies them.
const MODULES = [
  ['core',   'vendor/three/three.core.min.js',   {}],
  ['three',  'vendor/three/three.module.min.js', { './three.core.min.js': 'core' }],
  ['params', 'src/params.js',    {}],
  ['noise',  'src/noise.js',     {}],
  ['boat',   'src/boat.js',      { three: 'three', './params.js': 'params' }],
  ['ocean',  'src/ocean.js',     { three: 'three', './params.js': 'params', './noise.js': 'noise' }],
  ['wake',   'src/wakeField.js', { three: 'three', './params.js': 'params', './noise.js': 'noise' }],
  ['ui',     'src/ui.js',        { './params.js': 'params' }],
  ['main',   'src/main.js',      { three: 'three', './params.js': 'params', './wakeField.js': 'wake',
                                   './ocean.js': 'ocean', './boat.js': 'boat', './ui.js': 'ui' }],
];

// A JS string literal safe to sit inside an inline <script>: JSON handles the
// quoting, then `</` is escaped so nothing can close the script tag early, and
// the two line separators JSON leaves raw are escaped too.
const literal = (s) => JSON.stringify(s)
  .replace(/<\//g, '<\\/')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

const sources = [];
for (const [key, path, deps] of MODULES) {
  sources.push({ key, deps, src: await readFile(resolve(ROOT, path), 'utf8') });
}

const css = await readFile(resolve(ROOT, 'src/ui.css'), 'utf8');
const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');

// Body markup only: the artifact host supplies the document skeleton.
const body = html
  .replace(/^[\s\S]*?<link rel="stylesheet"[^>]*>/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

const out = `<title>Boat Wake Lab</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">

<style>
${css}
</style>

${body}

<script>
window.__PREWARM = ${PREWARM};

// Rehost the module graph on Blob URLs, in dependency order.
const SOURCES = [
${sources.map((m) => `  { key: ${literal(m.key)}, deps: ${literal(JSON.stringify(m.deps))}, src: ${literal(m.src)} }`).join(',\n')}
];

const urls = {};
for (const m of SOURCES) {
  const deps = JSON.parse(m.deps);
  const src = m.src.replace(
    /(\\bfrom\\s*|\\bimport\\s*)(["'])([^"']+)\\2/g,
    (all, kw, q, spec) => (deps[spec] ? kw + JSON.stringify(urls[deps[spec]]) : all),
  );
  urls[m.key] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}

const boot = document.createElement('script');
boot.type = 'module';
boot.src = urls.main;
document.body.appendChild(boot);

// WebGL is required, and a silent black canvas is the worst possible failure.
addEventListener('load', () => setTimeout(() => {
  if (window.__ready) return;
  const c = document.getElementById('gl');
  if (c) c.style.display = 'none';
  const p = document.createElement('p');
  p.style.cssText = 'position:fixed;inset:0;display:grid;place-content:center;'
    + 'text-align:center;padding:2rem;color:#7d93a3;font-family:var(--font-num)';
  p.textContent = 'This prototype needs WebGL. Try opening it in a desktop browser '
    + 'with hardware acceleration enabled.';
  document.body.appendChild(p);
}, 4000));
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out);
console.log(`${OUT}  ${(out.length / 1024 / 1024).toFixed(2)} MB`);
