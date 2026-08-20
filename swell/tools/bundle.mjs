#!/usr/bin/env node
// Flatten the prototype into one file you can open with a double click.
//
//   node tools/bundle.mjs --out dist/swell.html
//   node tools/bundle.mjs --out dist/fragment.html --fragment
//
// This is a bundler for *this* module graph, not a general one. It handles the
// three import forms and two export forms the project actually uses, and errors
// out on anything else rather than emitting something subtly wrong. Both
// vendored three.js files happen to use a single trailing `export { ... }`
// block, which is why they need no special case.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(ROOT, opt('out', 'dist/swell.html'));
const FRAGMENT = args.includes('--fragment');

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_BLOCK_RE = /^export\s*\{([\s\S]*?)\}\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;

const id = (abs) => relative(ROOT, abs).split('\\').join('/');

async function loadModule(abs, graph) {
  const key = id(abs);
  if (graph.has(key)) return key;
  graph.set(key, null);                       // reserve, so a cycle is visible
  let src = await readFile(abs, 'utf8');
  const deps = [];
  const exports = new Set();

  if (/^export\s+default/m.test(src)) throw new Error(`${key}: default exports are not supported`);
  if (/^export\s+\*/m.test(src)) throw new Error(`${key}: re-exports are not supported`);

  src = src.replace(IMPORT_RE, (_, clause, spec) => {
    if (!spec.startsWith('.')) throw new Error(`${key}: bare import "${spec}" cannot be bundled`);
    const depAbs = resolve(dirname(abs), spec);
    deps.push(depAbs);
    const c = clause.trim();
    const star = c.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (star) return `const ${star[1]} = __req(${JSON.stringify(id(depAbs))});`;
    const named = c.match(/^\{([\s\S]*)\}$/);
    if (named) {
      // `{ a, b as c }` is already valid destructuring once `as` becomes `:`.
      const inner = named[1].split(',').map((x) => x.trim()).filter(Boolean)
        .map((x) => x.replace(/\s+as\s+/, ': ')).join(', ');
      return `const { ${inner} } = __req(${JSON.stringify(id(depAbs))});`;
    }
    throw new Error(`${key}: unsupported import clause "${c}"`);
  });

  src = src.replace(EXPORT_DECL_RE, (_, kind, name) => { exports.add(name); return `${kind} ${name}`; });
  src = src.replace(EXPORT_BLOCK_RE, (_, names) => {
    for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [local, exported] = n.split(/\s+as\s+/).map((x) => x.trim());
      exports.add(exported || local);
      if (exported && exported !== local) exports.add(`${exported}:${local}`);
    }
    return '';
  });

  for (const d of deps) await loadModule(d, graph);

  const assigns = [...exports].map((e) => {
    const [name, local] = e.includes(':') ? e.split(':') : [e, e];
    return `  __e[${JSON.stringify(name)}] = ${local};`;
  }).join('\n');

  graph.set(key, `__m[${JSON.stringify(key)}] = function (__e) {\n${src}\n${assigns}\n};`);
  return key;
}

const graph = new Map();
const entry = await loadModule(resolve(ROOT, 'src/main.js'), graph);

const runtime = `
(function () {
'use strict';
const __m = {}, __c = {};
function __req(k) {
  if (k in __c) return __c[k];
  const e = {};
  __c[k] = e;
  __m[k](e);
  return e;
}
${[...graph.values()].join('\n')}
__req(${JSON.stringify(entry)});
})();
`;

const css = await readFile(join(ROOT, 'src/ui.css'), 'utf8');
let html = await readFile(join(ROOT, 'index.html'), 'utf8');
// Function replacers, not string ones. A string replacement treats `$'` as
// "everything after the match", and three.js builds a regex out of the literal
// '$' - which silently splices the tail of the document into the middle of the
// bundle and produces a syntax error 50,000 lines from the cause.
html = html
  .replace('<link rel="stylesheet" href="src/ui.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="src/main.js"></script>', () => `<script>\n${runtime}\n</script>`);

if (FRAGMENT) {
  // Everything between <body> and </body>, plus the styles, for hosts that
  // supply their own document skeleton.
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
  html = `<title>${title}</title>\n${style}\n${body}`;
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`${relative(ROOT, OUT)}  ${(html.length / 1048576).toFixed(2)} MB  ${graph.size} modules`);
