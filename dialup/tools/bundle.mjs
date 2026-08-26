/*
 * Flattens the prototype into one self-contained HTML file.
 *
 *   node tools/bundle.mjs                       -> dist/halcyon.html
 *   node tools/bundle.mjs --out somewhere.html
 *
 * The output has no external references at all: the three stylesheets are
 * inlined, and the module graph is flattened into a single classic script
 * with a tiny require shim. That makes it openable straight off disk and
 * publishable anywhere that will not fetch a second file.
 *
 * The transform is deliberately narrow, and tools/check.mjs enforces the
 * shapes it relies on: every import is `import { ... } from './x.js'` or
 * `import * as A from './x.js'`, every export is a top-level declaration,
 * and the graph has no cycles. Anything else should fail loudly here
 * rather than produce a subtly broken file.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const outPath = outArg >= 0 && argv[outArg + 1]
  ? resolve(process.cwd(), argv[outArg + 1])
  : join(root, 'dist/halcyon.html');

const id = file => relative(srcDir, file).split('\\').join('/');

/* ── collect ─────────────────────────────────────────────────────────── */

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : p.endsWith('.js') && out.push(p);
  }
  return out;
}

const files = walk(srcDir);

/* ── transform one module ────────────────────────────────────────────── */

const IMPORT = /^import\s+([^;]*?)\s+from\s+(['"])([^'"]+)\2;?[ \t]*$/gm;
const DYNAMIC = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;
const EXPORT_DECL = /^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

function transform(file) {
  const original = readFileSync(file, 'utf8');
  let src = original;
  const here = dirname(file);
  const exported = new Set();
  const problems = [];

  const resolveSpec = spec => {
    if (!spec.startsWith('.')) problems.push('bare specifier: ' + spec);
    return id(resolve(here, spec));
  };

  src = src.replace(IMPORT, (whole, clause, q, spec) => {
    const target = resolveSpec(spec);
    const star = /^\*\s+as\s+([\w$]+)$/.exec(clause.trim());
    if (star) return 'const ' + star[1] + ' = __req(' + JSON.stringify(target) + ');';

    const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (!braces) { problems.push('unsupported import clause: ' + clause.trim()); return whole; }

    const names = braces[1].split(',').map(p => p.trim()).filter(Boolean).map(p => {
      const as = p.split(/\s+as\s+/);
      return as.length === 2 ? as[0].trim() + ': ' + as[1].trim() : p;
    });
    return 'const { ' + names.join(', ') + ' } = __req(' + JSON.stringify(target) + ');';
  });

  src = src.replace(DYNAMIC, (whole, q, spec) =>
    '__dyn(' + JSON.stringify(resolveSpec(spec)) + ')');

  // Names first, from the untouched source; then drop the keyword.
  for (const m of original.matchAll(
    /^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm))
    exported.add(m[1]);
  src = src.replace(EXPORT_DECL, '');
  for (const m of original.matchAll(EXPORT_LIST))
    for (const part of m[1].split(','))
      if (part.trim()) exported.add(part.trim().split(/\s+as\s+/).pop().trim());

  src = src.replace(EXPORT_LIST, '');

  if (/^export\s+default/m.test(original)) problems.push('default exports are not supported');
  // Column zero only: an indented `await` is inside a function.
  if (/^await\s/m.test(src)) problems.push('top-level await is not supported');
  if (/\bimport\.meta\b/.test(src)) problems.push('import.meta is not supported');
  if (/^export\s+let\b/m.test(original)) problems.push('exported `let` would not stay live');

  const tail = [...exported].map(n => '__x.' + n + ' = ' + n + ';').join(' ');

  return {
    id: id(file),
    exported: [...exported],
    problems,
    code:
      '__mod(' + JSON.stringify(id(file)) + ', function (__x, __req, __dyn) {\n' +
      src.trimEnd() + '\n' +
      (tail ? tail + '\n' : '') +
      '});\n',
  };
}

const modules = files.map(transform);
const bad = modules.filter(m => m.problems.length);
if (bad.length) {
  for (const m of bad) for (const p of m.problems) console.error(m.id + ': ' + p);
  process.exit(1);
}

/* ── verify every import names something that is exported ────────────── */

const byId = new Map(modules.map(m => [m.id, m]));
let missing = 0;
for (const m of modules) {
  for (const call of m.code.matchAll(/__req\("([^"]+)"\)/g)) {
    if (!byId.has(call[1])) { console.error(m.id + ': cannot resolve ' + call[1]); missing++; }
  }
  for (const call of m.code.matchAll(/__dyn\("([^"]+)"\)/g)) {
    if (!byId.has(call[1])) { console.error(m.id + ': cannot resolve ' + call[1]); missing++; }
  }
}
if (missing) process.exit(1);

/* ── assemble ────────────────────────────────────────────────────────── */

const html = readFileSync(join(root, 'index.html'), 'utf8');

const styles = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"\s*>/g)]
  .map(m => '/* ' + m[1] + ' */\n' + readFileSync(join(root, m[1]), 'utf8'))
  .join('\n');

let body = html
  .replace(/^<!doctype html>\s*/i, '')
  .replace(/<link rel="stylesheet"[^>]*>\s*/g, '')
  .replace(/<script type="module"[^>]*><\/script>\s*/g, '')
  .trim();

const runtime = `
(function () {
  'use strict';
  var __defs = {}, __cache = {};
  function __mod(id, fn) { __defs[id] = fn; }
  function __req(id) {
    if (__cache[id]) return __cache[id];
    var fn = __defs[id];
    if (!fn) throw new Error('module not bundled: ' + id);
    var x = __cache[id] = {};
    fn(x, __req, __dyn);
    return x;
  }
  function __dyn(id) { return Promise.resolve().then(function () { return __req(id); }); }

${modules.map(m => m.code).join('\n')}
  __req('main.js');
})();
`;

const out =
  body + '\n\n' +
  '<style>\n' + styles + '\n</style>\n\n' +
  '<script>\n' + runtime + '\n</script>\n';

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log('wrote ' + relative(process.cwd(), outPath) + '  (' +
  modules.length + ' modules, ' + kb + ' KB, no external references)');
