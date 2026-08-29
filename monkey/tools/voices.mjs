#!/usr/bin/env node
// Record the cast, and measure what came back.
//
//   node tools/voices.mjs --dry
//   node tools/voices.mjs
//   node tools/voices.mjs --only offer-2 --force
//   node tools/voices.mjs --measure-only
//   node tools/voices.mjs --voices           # what this account can cast from
//
// The measuring pass is the part that earns its keep. A recorded line has a
// real length, and until the game knows it, every subtitle either outlasts its
// own audio or gets cut off — and comic timing, which is the entire genre, is
// unjudgeable. Writing the measured durations back into a manifest means the
// writer hears the joke at the speed the player will hear it, months before
// any human actor is booked.
//
// Each clip carries a hash of the text and voice settings it was made from, so
// a re-run only re-records lines whose words actually changed. Nothing here
// re-spends on a line that is already correct on disk.

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const { LINES, VOICE_CAST } = await import(new URL('../src/game/lines.js', import.meta.url));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const MEASURE_ONLY = args.includes('--measure-only');
const ONLY = opt('only', null);

const OUT = join(ROOT, 'assets/voice');
const MANIFEST = join(OUT, 'manifest.json');
const MODEL = 'eleven_multilingual_v2';
const FMT = 'mp3_44100_128';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// Voice ids are per-account, not global. A voice id copied from documentation
// 404s on a library that does not include it, and the error arrives halfway
// through a recording run — so make the roster easy to look at first.
if (args.includes('--voices')) {
  const res = await fetch('https://api.elevenlabs.io/v1/voices?page_size=100', {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  const { voices } = await res.json();
  for (const v of voices) {
    const l = v.labels || {};
    console.log(`${v.voice_id}  ${(l.gender || '?').padEnd(7)} ${(l.age || '?').padEnd(11)} ${(l.descriptive || '?').padEnd(14)} ${v.name}`);
  }
  process.exit(0);
}

const settings = (v) => ({
  stability: v.stability, similarity_boost: 0.75, style: v.style, speed: v.speed, use_speaker_boost: true,
});
const hashOf = (id) => {
  const l = LINES[id], v = VOICE_CAST[l.who];
  return createHash('sha256').update(JSON.stringify({ text: l.text, voice: v.voice, model: MODEL, settings: settings(v) })).digest('hex').slice(0, 16);
};

async function tts(id) {
  const l = LINES[id], v = VOICE_CAST[l.who];
  if (!v) throw new Error(`${id}: no voice cast for "${l.who}"`);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${v.voice}?output_format=${FMT}`;
  const body = JSON.stringify({ text: l.text, model_id: MODEL, voice_settings: settings(v) });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body,
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      const w = 2 ** attempt * 1000;
      console.error(`  ${id}: ${res.status}, retry in ${w / 1000}s`);
      await new Promise((r) => setTimeout(r, w));
      continue;
    }
    throw new Error(`${id} (${l.who}): ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`${id}: gave up`);
}

// There is no audio decoder in node here, so the browser that is already in
// this toolchain does the measuring: fetch, decodeAudioData, read the length.
async function measure(ids) {
  const { port, close } = await serve();
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async (list) => {
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const res = {};
    for (const id of list) {
      const r = await fetch('./assets/voice/' + id + '.mp3');
      if (!r.ok) continue;
      const buf = await actx.decodeAudioData(await r.arrayBuffer());
      res[id] = Math.round(buf.duration * 1000) / 1000;
    }
    return res;
  }, ids);
  await browser.close();
  close();
  return out;
}

// --- run --------------------------------------------------------------------

const ids = (ONLY ? [ONLY] : Object.keys(LINES)).filter((id) => LINES[id]);
if (ONLY && !LINES[ONLY]) { console.error('no such line: ' + ONLY); process.exit(1); }

await mkdir(OUT, { recursive: true });
let manifest = { model: MODEL, format: FMT, lines: {} };
if (await exists(MANIFEST)) manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

if (!MEASURE_ONLY) {
  const todo = [];
  for (const id of ids) {
    const h = hashOf(id);
    const onDisk = await exists(join(OUT, id + '.mp3'));
    if (onDisk && manifest.lines[id]?.hash === h && !FORCE) continue;
    todo.push({ id, h, reason: !onDisk ? 'new' : (FORCE ? 'forced' : 'text changed') });
  }
  if (!todo.length) console.log('every line is current — nothing to record.');
  const chars = todo.reduce((n, t) => n + LINES[t.id].text.length, 0);
  if (DRY) {
    for (const t of todo) console.log(`  would record ${t.id} (${t.reason}) [${LINES[t.id].who}] "${LINES[t.id].text}"`);
    console.log(`\n${todo.length} lines, ${chars} characters`);
    process.exit(0);
  }
  if (todo.length && !process.env.ELEVENLABS_API_KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }
  for (const t of todo) {
    const buf = await tts(t.id);
    await writeFile(join(OUT, t.id + '.mp3'), buf);
    manifest.lines[t.id] = { who: LINES[t.id].who, hash: t.h, bytes: buf.length, dur: null };
    console.log(`  ${t.id.padEnd(10)} ${(buf.length / 1024).toFixed(0).padStart(4)} KB  ${LINES[t.id].who}`);
  }
}

const present = (await readdir(OUT)).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4));
const durs = await measure(present);
for (const [id, dur] of Object.entries(durs)) {
  manifest.lines[id] = { ...(manifest.lines[id] || { who: LINES[id]?.who, hash: LINES[id] ? hashOf(id) : null }), dur };
}
// A clip whose line has been deleted is dead weight in the manifest.
for (const id of Object.keys(manifest.lines)) if (!LINES[id]) delete manifest.lines[id];

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
const total = Object.values(manifest.lines).reduce((n, l) => n + (l.dur || 0), 0);
console.log(`\n${Object.keys(manifest.lines).length} lines, ${total.toFixed(1)}s of voice -> assets/voice/manifest.json`);
