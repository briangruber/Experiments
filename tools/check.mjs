/*
 * Static checks that never open a browser.
 *
 *   1. every .js under src/ parses as an ES module
 *   2. every relative import resolves to a file that exists
 *   3. every symbol imported by name is actually exported there
 *   4. no stray control characters (they survive editors and break regexes)
 *   5. index.html references only files that exist
 *   6. advisory: class names built in JS that no stylesheet declares
 *
 * Run: node tools/check.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const note = (file, msg) => problems.push(relative(root, file) + ': ' + msg);

// Control characters other than tab and newline.
const CTRL = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]');

/* Import scanning runs on comment-free source: a doc comment that shows
   an example import should not be mistaken for a real one. Only block
   comments and whole-line `//` are removed, so a 'http://...' inside a
   string survives. */
const decomment = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = walk(join(root, 'src')).concat(
  readdirSync(join(root, 'tools'))
    .filter(f => f.endsWith('.mjs'))
    .map(f => join(root, 'tools', f)));

/* ── 1 & 4: parse, and look for control characters ──────────────────── */

const exportsOf = new Map();

for (const f of files) {
  const src = readFileSync(f, 'utf8');

  const line = src.split('\n').findIndex(l => CTRL.test(l));
  if (line >= 0) note(f, 'control character on line ' + (line + 1));

  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    note(f, 'syntax error\n    ' +
      String(e.stderr || e).split('\n').slice(0, 6).join('\n    '));
  }

  const names = new Set();
  const decl = /^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(decl)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(','))
      if (part.trim()) names.add(part.trim().split(/\s+as\s+/).pop().trim());
  if (/^export\s+default/m.test(src)) names.add('default');
  exportsOf.set(f, names);
}

/* ── 2 & 3: imports resolve, and name something that exists ─────────── */

for (const f of files) {
  const src = decomment(readFileSync(f, 'utf8'));
  const re = /import\s+(?:([\w$*\s{},\n]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(f), spec);
    if (!existsSync(target)) { note(f, 'import not found: ' + spec); continue; }

    const braces = /\{([^}]*)\}/.exec(m[1] || '');
    const have = exportsOf.get(target);
    if (!braces || !have) continue;
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !have.has(name))
        note(f, 'imports { ' + name + ' } from ' + spec + ', which does not export it');
    }
  }
}

/* ── imports that are never used ────────────────────────────────────── */

for (const f of files) {
  const src = decomment(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/^import\s+([^'"]+?)\s+from\s+['"][^'"]+['"];?$/gm)) {
    const clause = m[1];
    const names = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces)
      for (const part of braces[1].split(','))
        if (part.trim()) names.push(part.trim().split(/\s+as\s+/).pop().trim());
    const star = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (star) names.push(star[1]);
    const dflt = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
    if (dflt && !clause.trim().startsWith('{')) names.push(dflt[1]);

    const body = src.slice(0, m.index) + src.slice(m.index + m[0].length);
    for (const name of names) {
      const used = new RegExp('(?<![\\w$.])' + name.replace(/[$]/g, '\\$&') + '(?![\\w$])');
      if (!used.test(body)) note(f, 'imports ' + name + ' but never uses it');
    }
  }
}

/* ── 5: index.html references ───────────────────────────────────────── */

const htmlPath = join(root, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
for (const m of html.matchAll(/(?:src|href)="(\.[^"]+)"/g))
  if (!existsSync(resolve(root, m[1]))) note(htmlPath, 'references missing file ' + m[1]);

/* ── 6: advisory class check ────────────────────────────────────────── */

const css = readdirSync(join(root, 'src/style'))
  .map(f => readFileSync(join(root, 'src/style', f), 'utf8')).join('\n');
const declared = new Set([...css.matchAll(/\.(-?[a-z][\w-]*)/gi)].map(m => m[1]));
const used = new Set();
for (const f of files)
  for (const m of readFileSync(f, 'utf8').matchAll(/h\('([a-z]+)((?:[.#][\w-]+)+)'/g))
    for (const c of m[2].split(/(?=[.#])/)) if (c[0] === '.') used.add(c.slice(1));
const orphan = [...used].filter(c => !declared.has(c)).sort();
if (orphan.length) console.log('note: classes with no CSS rule -', orphan.join(', '));

/* ── verdict ────────────────────────────────────────────────────────── */

if (problems.length) {
  console.error('\n' + problems.length + ' problem(s):\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('ok - ' + files.length + ' modules parse, imports resolve');
