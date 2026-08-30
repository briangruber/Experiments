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
const EXPORT_DECL = /^export\s+(?:(const|let|var)\s+|(?:async\s+)?(function\*?|class)\s+(\w+))/;

// `export const A = 1, B = 2;` declares two names, and a regex that captures
// only the first silently drops the second — the module still loads, the
// missing binding reads as undefined, and the failure surfaces somewhere else
// entirely as NaN. (It did: ROOM_H went missing, every y coordinate became NaN
// and hit testing stopped working while the game still rendered.) So the
// declarator list is scanned properly, tracking depth so commas inside an
// array or call are not mistaken for separators.
function declaredNames(rest) {
  const names = [];
  let depth = 0, quote = null, start = 0;
  const take = (chunk) => {
    const m = chunk.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (m) names.push(m[1]);
  };
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) { if (c === quote && rest[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { take(rest.slice(start, i)); start = i + 1; }
    else if (c === ';' && depth === 0) { take(rest.slice(start, i)); start = rest.length; break; }
  }
  if (start < rest.length) take(rest.slice(start));
  return names;
}

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
      if (m[1]) names.push(...declaredNames(line.slice(m[0].length)));
      else names.push(m[3]);
      out.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (/^export\s/.test(line)) throw new Error(`${id}: unsupported export form: ${line.trim()}`);

    out.push(line);
  }

  // Assigned in one go at the end of the body, so function and class
  // declarations hoist normally and consts are past their dead zone.
  if (names.length) out.push(`Object.assign(__x, { ${names.join(', ')} });`);

  const declared = (source.match(/^export\s/gm) || []).length;
  if (declared && !names.length) throw new Error(`${id}: ${declared} export statements but no names captured`);

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
// The backdrop is a video now, and it is the biggest thing in the bundle by
// far. Inline it anyway: a published page has no folder to stream from.
for (const [key, file, mime] of [
  ['sceneVideo', 'assets/scene.mp4', 'video/mp4'],
  ['sceneStill', 'assets/scene.jpg', 'image/jpeg'],
]) {
  const p = join(ROOT, file);
  if (NO_PLATE || !(await exists(p))) continue;
  assets[key] = await dataUri(p, mime);
  assetBytes += (await stat(p)).size;
}

// Baked character atlases and their manifests. The manifest is inlined as an
// object rather than a URL: a published page cannot fetch a sibling file, and
// the atlas is useless without the frame table.
const castDir = join(ROOT, 'assets/cast');
if (!NO_PLATE && (await exists(castDir))) {
  const cast = {};
  for (const f of (await readdir(castDir)).filter((f) => f.endsWith('-sheet.png'))) {
    const key = f.replace('-sheet.png', '');
    const manifestPath = join(castDir, `${key}-sheet.json`);
    if (!(await exists(manifestPath))) continue;
    cast[key] = {
      sheet: await dataUri(join(castDir, f), 'image/png'),
      manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    };
    assetBytes += (await stat(join(castDir, f))).size;
  }
  if (Object.keys(cast).length) assets.cast = cast;
}

const propDir = join(ROOT, 'assets/props');
if (!NO_PLATE && (await exists(propDir))) {
  // Only the props the room still draws. The rest are painted into the
  // backdrop now and would be dead weight in the page.
  const KEEP = new Set(['cup']);
  const props = {};
  for (const f of (await readdir(propDir)).filter((f) => f.endsWith('.png') && KEEP.has(f.slice(0, -4)))) {
    props[f.slice(0, -4)] = await dataUri(join(propDir, f), 'image/png');
    assetBytes += (await stat(join(propDir, f))).size;
  }
  if (Object.keys(props).length) assets.props = props;
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
  .replace('/*ASSETS*/', `window.__ASSETS = ${JSON.stringify({ ...assets, sceneClosedLoop: true })};`)
  .replace('/*GAME_JS*/', script);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
console.log(`${modules.size} modules, ${(assetBytes / 1024 / 1024).toFixed(2)} MB of assets`);
console.log(`bundle -> ${OUT.replace(ROOT + '/', '')}  ${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB`);
