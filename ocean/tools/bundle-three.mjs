#!/usr/bin/env node
// Bundles the three.js app - including three itself - into one self-contained
// HTML file with no external requests of any kind.
//
//   node tools/bundle-three.mjs --out dist/abyssal-three.html
//
// tools/bundle.mjs does this for the raw-GL demo. This one additionally has to
// inline three, because artifact hosting blocks every external host and the page
// therefore cannot reach a CDN for `three/webgpu` the way three.html does
// through an importmap.
//
// ---------------------------------------------------------------------------
// WHY EACH MODULE GETS ITS OWN FUNCTION SCOPE
//
// Concatenating the modules flat would be a redeclaration error, and not
// hypothetically: the port's own audit found `uDt` exported by both ocean-sim.js
// and spray.js, `uGrain` by both post.js and spray.js, `uWeight` by two more,
// and `vWorld` by two. Each is a distinct uniform that happens to share a name -
// correct as separate modules, fatal in one scope. So every module becomes
// `__defs[id] = function(__x, __req) { ... }` and its exports land on `__x`.
//
// ---------------------------------------------------------------------------
// HOW three ITSELF IS INLINED
//
// three ships as ES modules with a single trailing `export{a as B, c as D}`
// statement. Both builds are rewritten into the same function form:
//
//   three.webgpu.min.js   trailing export -> Object.assign(__x, { B: a, D: c })
//   three.tsl.min.js      additionally has a LEADING
//                         `import{TSL as e}from"three/webgpu"`, which becomes a
//                         __req() destructure
//
// `three` and `three/webgpu` are the same module: the webgpu build re-exports
// the whole core, which is why `import * as THREE from 'three'` and
// `from 'three/webgpu'` can both resolve to it.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = resolve(opt('root', '.'));
const OUT = resolve(opt('out', 'dist/abyssal-three.html'));
const ENTRY = opt('entry', 'demo/three-app.js');
const MIN = !args.includes('--no-min');

const THREE_WEBGPU = 'three/webgpu';
const THREE_TSL = 'three/tsl';
const THREE_CORE = 'three/core';
const ALIASES = { three: THREE_WEBGPU, 'three/webgpu': THREE_WEBGPU, 'three/tsl': THREE_TSL };

// A named-import list, possibly spanning lines. `[^}]*` crosses newlines, so a
// multi-line list matches as one.
const IMPORT_NAMED = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
// `import * as NS from '...'`
const IMPORT_NS = /^\s*import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

function exportedNames(src) {
  const names = new Set();
  // `async` and `function*` both sit between `export` and the name. Missing the
  // async case is not cosmetic: `export async function boot()` then never lands
  // on the module object and the page dies with "boot is not a function" - which
  // is what this bundler did on its third attempt, after the syntax was already
  // clean and the whole of three had loaded.
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
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
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return [...names].filter((n) => /^[A-Za-z0-9_$]+$/.test(n));
}

// `export { x } from './y.js'` has no representation here. Fail loudly rather
// than emit a build that is quietly missing a binding.
function assertNoReExportFrom(id, src) {
  const m = src.match(/^export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"][^'"]+['"]/m);
  if (m) {
    throw new Error(`${id}: re-export from another module is not supported by this bundler\n  ${m[0]}\n` +
      '  Import the binding and re-export it in a separate statement instead.');
  }
}

const modules = new Map();

// ---- three -----------------------------------------------------------------

// Turn EVERY `export{a as B,c as D};` in a three build into an Object.assign
// onto __x.
//
// Not just the trailing one: three.webgpu.min.js has TWO - one near the top
// re-exporting the names it just imported from the core, and one at the end for
// its own. Converting only the last leaves the first as a bare `export` in a
// classic script, which is "Unexpected token 'export'" at load. Measured, after
// this bundler shipped exactly that.
function convertExports(src, what) {
  let count = 0;
  const out = src.replace(/export\s*\{([^}]*)\}\s*;?/g, (_all, names) => {
    count ++;
    const pairs = names.split(',').map((part) => {
      const t = part.trim();
      if (!t) return null;
      const as = t.split(/\s+as\s+/);
      const local = as[0].trim();
      const exported = (as[1] ?? as[0]).trim();
      // `export{ default as X }` would need a different shape; three does not do it.
      return `${JSON.stringify(exported)}: ${local}`;
    }).filter(Boolean);
    return `\nObject.assign(__x, { ${pairs.join(', ')} });\n`;
  });
  if (count === 0) throw new Error(`${what}: no export{...} found - the build layout changed`);
  return out;
}

// `export{A,B}from"<spec>"` - a RE-EXPORT, which is a different statement from
// both an import and a plain export and has to be matched BEFORE either.
//
// three.webgpu.min.js re-exports a long list of core names this way, right after
// importing others from the same file under short aliases. Treating it as a
// plain `export{...}` deletes the braces and leaves a dangling
// `from"./three.core.min.js";` - which is "Unexpected string" at load, and is
// what this bundler shipped on its second attempt. The listed names are NOT the
// locally-bound aliases, they are core's own export names, so they have to be
// read back off the core module object rather than referenced as locals.
function rewriteReExports(src, map, what) {
  const deps = [];
  const out = src.replace(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']\s*;?/g, (_all, names, spec) => {
    const id = map[spec];
    if (!id) throw new Error(`${what}: re-export from unexpected specifier ${JSON.stringify(spec)}`);
    deps.push(id);
    const pairs = names.split(',').map((part) => {
      const t = part.trim();
      if (!t) return null;
      const as = t.split(/\s+as\s+/);
      const local = as[0].trim();
      const exported = (as[1] ?? as[0]).trim();
      return `${JSON.stringify(exported)}: __m.${local}`;
    }).filter(Boolean);
    return `\n{ const __m = __req(${JSON.stringify(id)}); Object.assign(__x, { ${pairs.join(', ')} }); }\n`;
  });
  return { out, deps };
}

// Rewrite every `import{a as b,...}from"<spec>"` in a three build into a __req
// destructure. Driven by what the file actually says rather than by an
// assumption about the layout, because the two layouts differ: the MINIFIED
// three.webgpu.min.js imports from ./three.core.min.js, while the unminified
// three.webgpu.js is self-contained. Getting this wrong emits a page that is
// syntactically fine and dies at load with "Cannot use import statement outside
// a module" - which is exactly what the first build of this bundler did.
function rewriteThreeImports(src, map, what) {
  const deps = [];
  const out = src.replace(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']\s*;?/g, (_all, names, spec) => {
    const id = map[spec];
    if (!id) throw new Error(`${what}: unexpected import from ${JSON.stringify(spec)}`);
    deps.push(id);
    const bind = names.split(',').map((n) => n.trim()).filter(Boolean)
      .map((n) => n.replace(/\s+as\s+/, ': ')).join(', ');
    return `const { ${bind} } = __req(${JSON.stringify(id)});`;
  });
  return { out, deps };
}

async function loadThree() {
  const build = join(ROOT, 'node_modules/three/build');
  const suffix = MIN ? '.min.js' : '.js';
  const specMap = {
    './three.core.min.js': THREE_CORE,
    './three.core.js': THREE_CORE,
    'three/webgpu': THREE_WEBGPU,
  };

  // Only a separate file in the minified layout.
  let core = null;
  try { core = await readFile(join(build, `three.core${suffix}`), 'utf8'); } catch { /* self-contained */ }
  if (core) modules.set(THREE_CORE, { body: convertExports(core, `three.core${suffix}`), deps: [] });

  // Order matters: re-exports first (they are `export{...}from`, which both of
  // the other two patterns would half-match), then imports, then plain exports.
  const prep = async (file, id) => {
    const src = await readFile(join(build, file), 'utf8');
    const re = rewriteReExports(src, specMap, file);
    const im = rewriteThreeImports(re.out, specMap, file);
    modules.set(id, {
      body: convertExports(im.out, file),
      deps: [...new Set([...re.deps, ...im.deps])],
    });
    return im.deps;
  };

  await prep(`three.webgpu${suffix}`, THREE_WEBGPU);
  const tslDeps = await prep(`three.tsl${suffix}`, THREE_TSL);
  if (tslDeps.length === 0) throw new Error(`three.tsl${suffix}: expected an import from "three/webgpu"`);
}

// ---- the app ---------------------------------------------------------------

function resolveSpec(fromId, spec) {
  if (ALIASES[spec]) return ALIASES[spec];
  if (!spec.startsWith('.')) throw new Error(`${fromId}: unresolvable bare specifier ${JSON.stringify(spec)}`);
  return relative(ROOT, resolve(dirname(join(ROOT, fromId)), spec)).split('\\').join('/');
}

async function load(id) {
  if (modules.has(id)) return;
  modules.set(id, null);                       // reserve, breaks any cycle
  const src = await readFile(join(ROOT, id), 'utf8');
  assertNoReExportFrom(id, src);
  const deps = [];

  let body = src.replace(IMPORT_NS, (_all, ns, spec) => {
    const dep = resolveSpec(id, spec);
    deps.push(dep);
    return `const ${ns} = __req(${JSON.stringify(dep)});`;
  });

  body = body.replace(IMPORT_NAMED, (_all, names, spec) => {
    const dep = resolveSpec(id, spec);
    deps.push(dep);
    const bind = names.split(',').map((n) => n.trim()).filter(Boolean)
      .map((n) => n.replace(/\s+as\s+/, ': ')).join(', ');
    return `const { ${bind} } = __req(${JSON.stringify(dep)});`;
  });

  // Anything left is an import form this bundler does not implement. Silence
  // here would ship a page that throws at load with no explanation.
  const leftover = body.match(/^\s*import\s.+$/m);
  if (leftover) throw new Error(`${id}: unsupported import form\n  ${leftover[0].trim()}`);

  const names = exportedNames(body);
  body = body.replace(/^export\s*\{[^}]*\}\s*;\s*$/gm, '');
  body = body.replace(/^export\s+/gm, '');
  body += `\nObject.assign(__x, { ${names.join(', ')} });\n`;
  modules.set(id, { body, deps, names });
  for (const d of deps) if (!modules.has(d)) await load(d);
}

await loadThree();
await load(ENTRY);

// ---- emit ------------------------------------------------------------------

const BUILD_ID = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

let out = `
(function(){
"use strict";
window.abyssalBuild = ${JSON.stringify(BUILD_ID)};
var __defs = {}, __cache = {};
function __req(id){
  if (__cache[id]) return __cache[id];
  var x = __cache[id] = {};
  var d = __defs[id];
  if (!d) throw new Error('missing module: ' + id);
  d(x, __req);
  return x;
}
`;

// three first, so a syntax error in it surfaces before anything else runs.
for (const id of [THREE_CORE, THREE_WEBGPU, THREE_TSL]) {
  if (!modules.has(id)) continue;
  out += `\n__defs[${JSON.stringify(id)}] = function(__x, __req){\n${modules.get(id).body}\n};\n`;
}
for (const [id, mod] of modules) {
  if (id === THREE_CORE || id === THREE_WEBGPU || id === THREE_TSL) continue;
  out += `\n__defs[${JSON.stringify(id)}] = function(__x, __req){\n${mod.body}\n};\n`;
}

out += `
try {
  __req(${JSON.stringify(ENTRY)});
} catch (err) {
  window.abyssalError = err;
  console.error('Abyssal build ' + window.abyssalBuild + ' failed to start:', err);
  var s = document.getElementById('status');
  if (s) { s.className = 'err'; s.textContent = String((err && err.message) || err); }
}
})();
`;

const shell = await readFile(join(ROOT, opt('html', 'demo/three-shell.html')), 'utf8');
// The settings panel is the classic demo's UI, and its stylesheet rides along:
// a <link> would 404 inside a standalone artifact, so it is inlined at the
// marker (which sits before the shell's own <style>, letting the shell win).
//
// Inlined SANITIZED, not verbatim - ui.css also carries the CLASSIC shell's
// chrome, and two of those rules are live grenades on this page:
//   - it styles #hud (the old demo's readout), and this shell's instrument
//     panel shares that id - its `pointer-events:none` made the Settings
//     button unclickable, measured as "canvas intercepts pointer events";
//   - .brand uses backdrop-filter, which this shell REMOVED because Chromium
//     and WebKit refuse to composite a WebGPU canvas under one (see the
//     comment block in three-shell.html).
// So: every declaration of backdrop-filter goes, and every top-level rule
// whose selector reaches for the old shell's chrome (#hud, #boot,
// #panel-toggle, .panel-hidden, bare html/body/canvas) goes. Media queries
// are kept but sanitized by the same rule.
export function sanitizeUiCss(css) {
	// COMMENTS GO FIRST, and this is load-bearing rather than tidiness. Both
	// passes below read raw text: the at-rule test is `header.trim()
	// .startsWith('@')`, and a comment sitting immediately before `@media`
	// makes that false - so the whole media query fell through to the
	// TOP-LEVEL branch, which emits `selector + '{' + body + '}'` VERBATIM and
	// sanitizes nothing inside it. Measured: ui.css's phone block is preceded
	// by exactly such a comment, so its `#hud{left:12px;bottom:...}` reached
	// the artifact intact, and against this shell's own `top:14px` that gave
	// #hud both anchors - a fixed box stretched to the full viewport, which
	// is why minimising the panel on a phone still buried the sea (reported
	// twice with screenshots). The selector pass has the same weakness from
	// the other side: keepParts() splits on ',' and a comment's own commas
	// become bogus "selector parts" that are always kept.
	css = css.replace(/\/\*[\s\S]*?\*\//g, '');
	css = css.replace(/backdrop-filter\s*:[^;}]*;?/g, '');
	const OWNED = /(#hud|#boot|#panel-toggle|\.panel-hidden)\b/;
	const BARE = /^\s*(html|body|canvas)\s*$/;
	// Filter PER SELECTOR PART, never per rule: `#ui.hidden, body.panel-hidden
	// #ui { ... }` must keep its #ui.hidden half - dropping the whole rule left
	// the panel permanently visible, full-screen under the phone media query,
	// eating every click on the page.
	const keepParts = (sel) => sel.split(',').filter((s) => !OWNED.test(s) && !BARE.test(s.trim()));
	let out = '', i = 0;
	while (i < css.length) {
		const open = css.indexOf('{', i);
		if (open < 0) { out += css.slice(i); break; }
		const header = css.slice(i, open);
		let depth = 1, j = open + 1;
		while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
		const body = css.slice(open + 1, j - 1);
		if (header.trim().startsWith('@')) {
			// at-rule: sanitize its (flat) inner rules by the same test
			out += header + '{' + body.replace(/([^{}]+)\{[^{}]*\}/g, (rule, sel, o, whole) => {
				const kept = keepParts(sel);
				return kept.length ? kept.join(',') + rule.slice(sel.length) : '';
			}) + '}';
		} else {
			const kept = keepParts(header);
			if (kept.length) out += kept.join(',') + '{' + body + '}';
		}
		i = j;
	}
	return out;
}
const uiCss = sanitizeUiCss(await readFile(join(ROOT, 'demo/ui.css'), 'utf8'));
const html = shell
	.replace('/*__UI_CSS__*/', () => uiCss.replaceAll('</', '<\\/'))
	.replace('/*__BUNDLE__*/', () => out);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`bundled ${modules.size} modules -> ${relative(process.cwd(), OUT)}  (${kb(html.length)})`);
console.log(`  three            ${kb([THREE_CORE, THREE_WEBGPU, THREE_TSL].filter((i) => modules.has(i)).reduce((a, i) => a + modules.get(i).body.length, 0))}`);
console.log(`  app              ${kb([...modules].filter(([i]) => i !== THREE_CORE && i !== THREE_WEBGPU && i !== THREE_TSL)
  .reduce((a, [, m]) => a + m.body.length, 0))}`);
console.log(`  build id         ${BUILD_ID}`);
