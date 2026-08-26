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

/* `export const A = 1, B = 2` declares two exports, not one. Split the
   declarator list at depth zero so both are seen — the naive regex takes
   only the first, which is the sort of thing that produces a bundle that
   parses and then throws. */
const RESERVED = new Set(('break case catch class const continue debugger default ' +
  'delete do else export extends finally for function if import in instanceof new ' +
  'return super switch this throw try typeof var void while with yield let static ' +
  'await null true false not and or of as from').split(' '));

function exportedNames(rawSrc) {
  // Comments first: a declarator list is split on commas, and a trailing
  // line comment containing one ("0 is a position, not a falsehood") will
  // otherwise be read as another exported name.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const names = new Set();
  for (const m of src.matchAll(
    /^export\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/gm))
    names.add(m[1]);

  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([\s\S]*?);\s*$/gm)) {
    let depth = 0, part = '';
    const flush = () => {
      const n = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
      if (n && !RESERVED.has(n[1])) names.add(n[1]);
      part = '';
    };
    for (const ch of m[1]) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { flush(); continue; }
      part += ch;
    }
    flush();
  }

  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const p of m[1].split(','))
      if (p.trim()) names.add(p.trim().split(/\s+as\s+/).pop().trim());

  if (/^export\s+default/m.test(src)) names.add('default');
  return names;
}

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

  exportsOf.set(f, exportedNames(src));
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

/* ── used, but never imported ───────────────────────────────────────────
   Full scope analysis is out of scope here, but the common mistake has a
   cheap signature: a file uses a name that some *other* module in the tree
   exports, and does not import it. That is almost always a forgotten
   import rather than a coincidence. */

const allExports = new Map();          // name -> [files that export it]
for (const [file, names] of exportsOf)
  for (const n of names) {
    if (n === 'default' || n === 'open') continue;   // too common to be a signal
    if (!allExports.has(n)) allExports.set(n, []);
    allExports.get(n).push(file);
  }

for (const f of files) {
  const src = decomment(readFileSync(f, 'utf8'));
  const mine = exportsOf.get(f) || new Set();

  const imported = new Set();
  for (const m of src.matchAll(/import\s+([^'"]+?)\s+from\s+['"][^'"]+['"]/g)) {
    const braces = /\{([^}]*)\}/.exec(m[1]);
    if (braces)
      for (const part of braces[1].split(','))
        if (part.trim()) imported.add(part.trim().split(/\s+as\s+/).pop().trim());
    const star = /\*\s+as\s+([\w$]+)/.exec(m[1]);
    if (star) imported.add(star[1]);
  }

  // Names this file binds for itself: declarations, arrow and function
  // parameters, object keys, and method shorthands. Miss one of these and
  // every Promise callback named `resolve` looks like a missing import.
  const declared = new Set();
  const bind = (re, g = 1) => {
    for (const m of src.matchAll(re)) {
      if (!m[g]) continue;
      for (const part of m[g].split(',')) {
        const n = part.trim().replace(/^\.\.\./, '').split(/[\s=:]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
      }
    }
  };
  bind(/(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  bind(/(?:^|[\s(,[])([A-Za-z_$][\w$]*)\s*=>/g);          // arrow with one param
  bind(/\(([^)]*)\)\s*=>/g);                             // arrow parameter list
  bind(/\bfunction\s*\*?\s*[\w$]*\s*\(([^)]*)\)/g);    // function parameters
  bind(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm);    // method shorthand
  bind(/([A-Za-z_$][\w$]*)\s*:/g);                        // object keys and labels
  bind(/(?:const|let|var)\s*\{([^}]*)\}/g);              // destructured object
  bind(/(?:const|let|var)\s*\[([^\]]*)\]/g);             // destructured array

  for (const [name, from] of allExports) {
    if (from.includes(f) || imported.has(name) || declared.has(name) || mine.has(name)) continue;
    const used = new RegExp('(?<![\\w$.])' + name + '\\s*\\(');
    if (used.test(src))
      note(f, 'calls ' + name + '() but never imports it (exported by ' +
        relative(root, from[0]) + ')');
  }
}

/* ── generated art keys actually exist ──────────────────────────────────
   `ART.rev_map` is a property access, so renaming a key in the generator
   fails silently at build time and loudly at run time. Check it here. */

const artPath = join(root, 'src/assets/art.js');
if (existsSync(artPath)) {
  const art = readFileSync(artPath, 'utf8');
  const have = new Set([...art.matchAll(/^  ([a-z_0-9]+):/gm)].map(m => m[1]));
  for (const f of files) {
    for (const m of decomment(readFileSync(f, 'utf8')).matchAll(/\bART\.([a-z_0-9]+)/g))
      if (!have.has(m[1]))
        note(f, 'uses ART.' + m[1] + ', which tools/gen-assets.mjs does not produce');
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
