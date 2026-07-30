#!/usr/bin/env node
// Flattens Salty Fin Bay into one self-contained HTML file.
//
//   node tools/harbor-bundle.mjs --out dist/salty-fin-bay.html
//
// The prototype is ES modules across ten files plus the shared WebGL layer,
// which is the right shape to work in and the wrong shape to hand someone. This
// concatenates the modules in dependency order, strips the import/export
// plumbing (one script scope, so every top-level name has to stay unique),
// inlines the stylesheet, and emits a page that needs nothing from the network.
//
// Deliberately not a general bundler: it assumes side-effect-free module bodies
// in a known order and `export const/function/class` declarations only, which is
// all this project uses. It checks both assumptions and refuses to guess.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'dist/salty-fin-bay.html');

// Dependency order, shallowest first.
const MODULES = [
  'src/math.js', 'src/gl.js',
  'harbor/geom.js', 'harbor/shaders.js', 'harbor/render.js', 'harbor/world.js',
  'harbor/boat.js', 'harbor/game.js', 'harbor/ui.js', 'harbor/main.js',
];

// Drops `import ... ;` statements (including the multi-line ones) and the
// `export ` keyword from declarations.
function strip(src, file) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^import\s/.test(line)) {
      while (!/;\s*$/.test(lines[i]) && i < lines.length - 1) i++;
      continue;
    }
    if (/^export\s*\{/.test(line) || /^export\s+default\b/.test(line) || /^export\s+\*/.test(line)) {
      throw new Error(`${file}: re-export and default-export forms are not supported by this bundler`);
    }
    line = line.replace(/^export\s+(?=(const|let|var|function|class)\b)/, '');
    out.push(line);
  }
  return out.join('\n');
}

const seen = new Map();
const bodies = [];
for (const file of MODULES) {
  const src = await readFile(join(ROOT, file), 'utf8');
  const stripped = strip(src, file);
  // One shared scope means a duplicated top-level name would silently shadow
  // or throw at load; catch it here instead of in the browser.
  for (const m of stripped.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seen.has(name)) {
      throw new Error(`top-level name "${name}" declared in both ${seen.get(name)} and ${file}`);
    }
    seen.set(name, file);
  }
  bodies.push(`// ---------------------------------------------------------------- ${file}\n${stripped}`);
}

const css = await readFile(join(ROOT, 'harbor/style.css'), 'utf8');
const html = await readFile(join(ROOT, 'harbor/index.html'), 'utf8');

// Keep the markup, drop the tags that only make sense for the served version.
const markup = html
  .replace(/<meta[^>]*>\n?/g, '')
  .replace(/<title>[\s\S]*?<\/title>\n?/g, '')
  .replace(/<link[^>]*>\n?/g, '')
  .replace(/<script[^>]*><\/script>\n?/g, '')
  .trim();

// A template literal containing "</script>" would close the tag early. Nothing
// in the shaders does today, but a future one might.
const js = bodies.join('\n\n').replace(/<\/script/gi, '<\\/script');

const page = `<title>Salty Fin Bay</title>

<style>
${css}
/* Embedded in a panel rather than a tab: the canvas is fixed, so the document
   needs a height of its own or it collapses to nothing. */
html, body { min-height: 100vh; }
</style>

${markup}

<script type="module">
${js}
</script>
`;

await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
await writeFile(join(ROOT, OUT), page);
console.log(JSON.stringify({
  out: OUT,
  modules: MODULES.length,
  topLevelNames: seen.size,
  bytes: page.length,
}, null, 2));
