#!/usr/bin/env node
// Fold the prototype into one self-contained HTML file.
//
//   node tools/bundle.mjs                       # -> dist/monkey.html
//   node tools/bundle.mjs --out dist/x.html --no-voice
//
// The output has no doctype, <html>, <head> or <body> wrapper, so it can be
// opened directly in a browser *and* published as an artifact, which wraps it
// itself. One artefact, both uses.
//
// The modules are ES modules and stay written as ES modules; this walks the
// import graph and rewrites each one into a registry entry. That is a smaller
// and far more predictable thing than a general bundler: every import in this
// codebase is a static named or namespace import of a relative path, so the
// two rewrites below cover all of them, and anything they do not cover throws
// rather than silently emitting broken code.
//
// Assets are inlined as data URIs because a published page has no folder to
// fetch from. src/main.js and src/engine/audio.js read window.__ASSETS when it
// is present, so nothing here has to rewrite paths inside the source.

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, posix } from 'node:path';
import { ROOT } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = join(ROOT, opt('out', 'dist/monkey.html'));
const NO_VOICE = args.includes('--no-voice');
const NO_PLATE = args.includes('--no-plate');

const SRC = join(ROOT, 'src');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// --- module graph -----------------------------------------------------------

const IMPORT_NAMED = /^import\s+\{([^}]*)\}\s+from\s+'([^']+)';?\s*$/;
const IMPORT_STAR = /^import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)';?\s*$/;
const EXPORT_DECL = /^export\s+(?:(const|let|var)\s+(\w+)|(function\*?|class)\s+(\w+))/;

const modules = new Map();

async function collect(id) {
  if (modules.has(id)) return;
  const source = await readFile(join(SRC, id), 'utf8');
  const deps = [];
  const names = [];
  const out = [];

  for (const line of source.split('\n')) {
    let m = line.match(IMPORT_NAMED);
    if (m) {
      const dep = posix.normalize(posix.join(posix.dirname(id), m[2]));
      deps.push(dep);
      // `a, b as c` is valid in both syntaxes with only the separator changed.
      const binding = m[1].split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/\s+as\s+/, ': ')).join(', ');
      out.push(`const { ${binding} } = __req(${JSON.stringify(dep)});`);
      continue;
    }
    m = line.match(IMPORT_STAR);
    if (m) {
      const dep = posix.normalize(posix.join(posix.dirname(id), m[2]));
      deps.push(dep);
      out.push(`const ${m[1]} = __req(${JSON.stringify(dep)});`);
      continue;
    }
    if (/^import\s/.test(line)) throw new Error(`${id}: unsupported import form: ${line.trim()}`);

    m = line.match(EXPORT_DECL);
    if (m) {
      names.push(m[2] || m[4]);
      out.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (/^export\s/.test(line)) throw new Error(`${id}: unsupported export form: ${line.trim()}`);

    out.push(line);
  }

  // Assigned in one go at the end of the body, so function and class
  // declarations hoist normally and consts are past their dead zone.
  if (names.length) out.push(`Object.assign(__x, { ${names.join(', ')} });`);

  modules.set(id, { id, body: out.join('\n'), deps });
  for (const d of deps) await collect(d);
}

await collect('main.js');

// --- assets -----------------------------------------------------------------

const dataUri = async (path, mime) => `data:${mime};base64,${(await readFile(path)).toString('base64')}`;

const assets = {};
let assetBytes = 0;
const platePath = join(ROOT, 'assets/dock-plate.png');
if (!NO_PLATE && (await exists(platePath))) {
  assets.plate = await dataUri(platePath, 'image/png');
  assetBytes += (await stat(platePath)).size;
}
const voiceDir = join(ROOT, 'assets/voice');
if (!NO_VOICE && (await exists(join(voiceDir, 'manifest.json')))) {
  const manifest = JSON.parse(await readFile(join(voiceDir, 'manifest.json'), 'utf8'));
  const clips = {};
  for (const f of (await readdir(voiceDir)).filter((f) => f.endsWith('.mp3'))) {
    clips[f.slice(0, -4)] = await dataUri(join(voiceDir, f), 'audio/mpeg');
    assetBytes += (await stat(join(voiceDir, f))).size;
  }
  assets.voice = { manifest, clips };
}

// --- emit -------------------------------------------------------------------

const entry = modules.get('main.js');
const others = [...modules.values()].filter((m) => m.id !== 'main.js');

const script = `
const __mods = {};
const __def = (id, fn) => { __mods[id] = { fn, exports: null }; };
const __req = (id) => {
  const m = __mods[id];
  if (!m) throw new Error('missing module ' + id);
  if (!m.exports) { m.exports = {}; m.fn(m.exports, __req); }
  return m.exports;
};

${others.map((m) => `__def(${JSON.stringify(m.id)}, function (__x, __req) {\n${m.body}\n});`).join('\n\n')}

// main.js uses top-level await, so the entry runs as an async IIFE rather than
// as a registry entry — nothing imports it.
(async function () {
${entry.body}
}());
`;

// The bundle gets its own chrome rather than src/ui.css: a page embedded in a
// column is a different presentation problem from a full-window app, and the
// game only needs #stage and #fatal to exist.
const page = (await readFile(join(ROOT, 'tools/page.html'), 'utf8'))
  .replace('/*ASSETS*/', `window.__ASSETS = ${JSON.stringify(assets)};`)
  .replace('/*GAME_JS*/', script);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`${modules.size} modules, ${(assetBytes / 1024 / 1024).toFixed(2)} MB of assets`);
console.log(`bundle -> ${OUT.replace(ROOT + '/', '')}  ${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB`);
