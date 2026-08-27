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
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const OUT = resolve(ROOT, opt('out', 'dist/wake-lab.html'));
const PREWARM = +opt('prewarm', 55);

// The module graph is DISCOVERED, not declared.
//
// It used to be a hand-written list of [key, path, deps] triples, and that list
// was wrong twice: once when a new module was added and never listed (the
// specifier survived into the blob, failed to resolve against a blob: URL, and
// showed up as a blank page a long way from this file), and once when an entry
// landed out of dependency order. Both are mechanical facts about the imports,
// so read them from the source instead of restating them.
//
// Vendored three is the one special case: it is minified, ships as two files
// that import each other, and is reached by the bare specifier 'three'.
const ENTRY = 'src/main.js';
const BARE = { three: 'vendor/three/three.module.min.js' };

const IMPORT_RE = /(?:\bfrom|\bimport)\s*["']([^"']+)["']/g;

// Depth-first post-order: a module is emitted only after everything it imports,
// which is exactly the order the Blob URLs have to be created in.
const MODULES = [];
const state = new Map();          // path -> 'visiting' | 'done'
const keyOf = (rel) => rel.replace(/[^a-zA-Z0-9]/g, '_');

async function visit( rel, from ) {

  if ( state.get( rel ) === 'done' ) return;
  if ( state.get( rel ) === 'visiting' ) {
    // An import cycle has no valid Blob creation order, so say so here rather
    // than shipping a bundle whose second module names a URL that does not
    // exist yet.
    throw new Error( `import cycle through ${ rel } (reached from ${ from })` );
  }
  state.set( rel, 'visiting' );

  let src;
  try {
    src = await readFile( resolve( ROOT, rel ), 'utf8' );
  } catch {
    throw new Error( `${ from || ENTRY } imports "${ rel }", which does not exist` );
  }

  const deps = {};
  for ( const [ , spec ] of src.matchAll( IMPORT_RE ) ) {
    let target;
    if ( spec.startsWith( '.' ) ) {
      target = relative( ROOT, resolve( dirname( resolve( ROOT, rel ) ), spec ) );
    } else if ( BARE[ spec ] ) {
      target = BARE[ spec ];
    } else {
      continue;                   // a genuine bare import; nothing to rehost
    }
    await visit( target, rel );
    deps[ spec ] = keyOf( target );
  }

  state.set( rel, 'done' );
  MODULES.push( [ keyOf( rel ), rel, deps ] );

}

await visit( ENTRY, null );

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

// Discovery should make this impossible, which is exactly why it is asserted:
// a module must exist before anything naming it.
const seen = new Set();
for (const [key, path, deps] of MODULES) {
  for (const [spec, target] of Object.entries(deps)) {
    if (!seen.has(target)) {
      console.error(`bundle order is wrong: ${path} imports "${spec}", which is bundled later`);
      process.exit(1);
    }
  }
  seen.add(key);
}
if (!MODULES.some(([key]) => key === keyOf(ENTRY))) {
  console.error(`entry ${ENTRY} is not in the emitted module map`);
  process.exit(1);
}
console.log(`  ${MODULES.length} modules discovered from ${ENTRY}`);

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
boot.src = urls[${literal(keyOf(ENTRY))}];
document.body.appendChild(boot);

// If the page does not come up, SAY WHY.
//
// This used to assume any failure was a missing WebGL context and print exactly
// that, which sent someone off checking hardware acceleration on a machine
// whose WebGL was fine -- the real fault was a module throwing during init.
// A wrong diagnosis is worse than none: it costs the reader the time to
// disprove it. So record what actually went wrong and show that instead.
const failures = [];
addEventListener('error', (e) => {
  failures.push(e.message ? e.message + (e.filename ? '' : '') : String(e.error || e));
}, true);
addEventListener('unhandledrejection', (e) => failures.push('unhandled: ' + (e.reason?.message || e.reason)));

addEventListener('load', () => setTimeout(() => {
  if (window.__ready) return;
  const c = document.getElementById('gl');
  if (c) c.style.display = 'none';
  const gl = (() => {
    try { return !!document.createElement('canvas').getContext('webgl2'); }
    catch { return false; }
  })();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:grid;place-content:center;'
    + 'text-align:left;padding:2rem;color:#7d93a3;font-family:var(--font-num);'
    + 'font-size:0.8rem;line-height:1.6;gap:0.6rem;overflow:auto';
  const say = (t, strong) => {
    const el = document.createElement('p');
    el.textContent = t;
    if (strong) el.style.color = '#cfe2ef';
    box.appendChild(el);
  };
  if (!gl) {
    say('This prototype needs WebGL2.', true);
    say('Try a desktop browser with hardware acceleration enabled.');
  } else {
    say('WebGL2 is available, so this is not a graphics problem —', true);
    say('the prototype failed to start. What went wrong:');
    if (failures.length) for (const f of failures.slice(0, 6)) say('  • ' + f);
    else say('  • no error was reported, which usually means a module never loaded');
  }
  document.body.appendChild(box);
}, 4000));
</script>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out);
console.log(`${OUT}  ${(out.length / 1024 / 1024).toFixed(2)} MB`);
