#!/usr/bin/env node
// Flattens the prototype into one self-contained HTML file - three, the shaders,
// the panel and its stylesheet - so it can be opened from a filesystem, mailed
// to someone, or dropped into a page that will not let it fetch anything.
//
//   node tools/bundle.mjs --out dist/lagoon.html
//   node tools/bundle.mjs --out dist/lagoon.frag.html --fragment --quality medium
//
// How it works: every module here is an ES module with, at most, one grouped
// import statement and one grouped export statement, which is exactly the shape
// a hundred lines of regex can flatten. Each module becomes an IIFE that returns
// its exports as an object, and each import becomes a destructure of the module
// that came before it. Concatenating the minified builds naively would not work
// - they all use `e`, `t`, `r` at the top level and would collide - and the
// function wrapper is what keeps those scopes apart.
//
// The one thing this is not is a general bundler: it assumes the module graph is
// acyclic, listed below in dependency order, and written in the style used here.
// That is true of this folder, and it means no build tooling to install.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'dist/lagoon.html');
const FRAGMENT = args.includes('--fragment');
const QUALITY = opt('quality', '');

// Dependency order. Each entry maps a module's file to the specifiers other
// modules use to import it.
const MODULES = [
  { file: 'vendor/three.core.min.js', as: ['./three.core.min.js'] },
  { file: 'vendor/three.webgpu.min.js', as: ['three', 'three/webgpu'] },
  { file: 'vendor/three.tsl.min.js', as: ['three/tsl'] },
  { file: 'vendor/BloomNode.js', as: ['../vendor/BloomNode.js'] },
  { file: 'src/terrain.js', as: ['./terrain.js'] },
  { file: 'src/fields.js', as: ['./fields.js'] },
  { file: 'src/scene.js', as: ['./scene.js'] },
  { file: 'src/water.js', as: ['./water.js'] },
  { file: 'src/props.js', as: ['./props.js'] },
  { file: 'src/controls.js', as: ['./controls.js'] },
  { file: 'src/params.js', as: ['./params.js'] },
  { file: 'src/ui.js', as: ['./ui.js'] },
  { file: 'src/main.js', as: [], entry: true },
];

// Anchored to the start of a line: three's addon files carry an example import
// inside a JSDoc block, and an unanchored match happily rewrites the comment.
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm;
// Re-exports, which must be matched before plain export lists or the `from`
// clause is left stranded. three's WebGPU build re-exports the whole core module
// this way, which is why `import { Mesh } from 'three'` resolves at all.
const REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g;
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}\s*;?/g;
const EXPORT_DECL_RE = /export\s+(const|let|var|class|function|async\s+function)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_DEFAULT_RE = /export\s+default\s+/g;

// "a as b, c" -> [[a, b], [c, c]]
const pairs = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = s.split(/\s+as\s+/);
  return m.length === 2 ? [m[0].trim(), m[1].trim()] : [s, s];
});

function flatten(source, varOf) {
  const exported = new Map();          // exported name -> local name
  let out = source;

  out = out.replace(IMPORT_RE, (_, names, spec) => {
    const target = varOf(spec);
    if (!target) throw new Error(`no module registered for specifier "${spec}"`);
    const binds = pairs(names).map(([from, to]) => (from === to ? from : `${from}: ${to}`));
    return `const { ${binds.join(', ')} } = ${target};`;
  });

  out = out.replace(REEXPORT_RE, (_, names, spec) => {
    const target = varOf(spec);
    if (!target) throw new Error(`no module registered for re-export from "${spec}"`);
    for (const [orig, name] of pairs(names)) exported.set(name, `${target}.${orig}`);
    return '';
  });

  out = out.replace(EXPORT_LIST_RE, (_, names) => {
    for (const [local, name] of pairs(names)) exported.set(name, local);
    return '';
  });

  out = out.replace(EXPORT_DECL_RE, (_, kind, name) => {
    exported.set(name, name);
    return `${kind} ${name}`;
  });

  // Nothing here consumes a default export, so it becomes a plain statement.
  out = out.replace(EXPORT_DEFAULT_RE, 'void 0, ');

  const record = [...exported].map(([name, local]) => (name === local ? name : `${name}: ${local}`));
  return { body: out, record };
}

const specToVar = new Map();
const chunks = [];

for (let i = 0; i < MODULES.length; i++) {
  const mod = MODULES[i];
  const varName = `__m${i}`;
  const source = await readFile(join(ROOT, mod.file), 'utf8');
  const { body, record } = flatten(source, (spec) => specToVar.get(spec));
  for (const spec of mod.as) specToVar.set(spec, varName);

  if (mod.entry) {
    // The entry module has top level await, so it gets an async wrapper and the
    // bundle as a whole is a module script.
    chunks.push(`// ---- ${mod.file}\nawait (async () => {\n${body}\n})();`);
  } else {
    chunks.push(`// ---- ${mod.file}\nconst ${varName} = (() => {\n${body}\nreturn { ${record.join(', ')} };\n})();`);
  }
}

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// Reuse the real entry page's markup: everything between the stylesheet link and
// the module script, minus the pieces that only make sense when serving files.
const markup = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<meta[^>]*>\s*/gi, '')
  .replace(/<link[^>]*>\s*/gi, '')
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/i, '')
  .replace(/<script type="module"[^>]*><\/script>\s*/i, '')
  .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
  .trim();

const quality = QUALITY ? `<script>window.LAGOON_QUALITY = ${JSON.stringify(QUALITY)};</script>\n` : '';
const title = 'Lagoon';
const page = `${FRAGMENT ? `<title>${title}</title>\n` : ''}<style>\n${css}</style>
${markup}
${quality}<script type="module">
${chunks.join('\n\n')}
</script>`;

const doc = FRAGMENT ? page : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>${title} — stylised shallow water · three.js WebGPU</title>
</head>
<body>
${page}
</body>
</html>`;

// resolve, not join: an absolute --out should land where it was asked to.
const dest = resolve(ROOT, OUT);
await mkdir(dirname(dest), { recursive: true });
await writeFile(dest, doc);
console.log(`${OUT}  ${(doc.length / 1024 / 1024).toFixed(2)} MB  (${MODULES.length} modules)`);
