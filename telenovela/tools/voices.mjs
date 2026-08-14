#!/usr/bin/env node
// Record the cast. Every line in the episode's dialogue.js is spoken in
// Spanish by that character's voice, then measured, and the measurements are
// written back to the episode's dialogue-timing.js.
//
//   ELEVENLABS_API_KEY=... node tools/voices.mjs
//   node tools/voices.mjs --only dlg-4d --force
//   node tools/voices.mjs --measure-only        # re-measure what is on disk
//
// Two things come out of the measuring pass, and the piece needs both:
//
//   dur  the real length of the clip, which becomes the subtitle's length.
//        A subtitle that outlasts its own voice line looks like a bug; one
//        that undercuts it cannot be read.
//   env  a 30 Hz loudness envelope, quantised to one digit per frame, which
//        drives the beak. It is baked rather than measured live because the
//        offline video render has no wall clock to analyse against.
//
// There is no audio decoder in this environment, so both are measured by the
// headless browser that is already here: decodeAudioData, then read the PCM.

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'episodes/e01-corazon/voice');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('only', null);
const FORCE = args.includes('--force');
const MEASURE_ONLY = args.includes('--measure-only');

const FMT = 'mp3_44100_64';
const ENV_HZ = 30;

const { LINES, VOICES } = await import(new URL('../episodes/e01-corazon/dialogue.js', import.meta.url));

// --- generate ---------------------------------------------------------------

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function tts(line) {
  const v = VOICES[line.who];
  if (!v) throw new Error(`${line.id}: no voice cast for "${line.who}"`);
  const body = {
    text: line.es,
    model_id: 'eleven_multilingual_v2',
    language_code: 'es',
    voice_settings: {
      stability: v.stability,
      similarity_boost: 0.75,
      style: v.style,
      use_speaker_boost: true,
      speed: v.speed,
    },
  };
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${v.voice}?output_format=${FMT}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      const wait = 2 ** attempt * 1000;
      console.error(`  ${line.id}: ${res.status}, retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${line.id} (${line.who}): ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`${line.id}: gave up after retries`);
}

if (!MEASURE_ONLY) {
  if (!process.env.ELEVENLABS_API_KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }
  await mkdir(OUT, { recursive: true });
  let made = 0;
  for (const line of LINES) {
    if (ONLY && line.id !== ONLY) continue;
    const path = join(OUT, `${line.id}.mp3`);
    if (!FORCE && await exists(path)) { console.log(`  ${line.id}: exists`); continue; }
    const buf = await tts(line);
    await writeFile(path, buf);
    made++;
    console.log(`  ${line.id} (${line.who}): ${(buf.length / 1024).toFixed(0)} KB — ${line.es}`);
  }
  console.log(`\n${made} new clips`);
}

// --- measure ----------------------------------------------------------------

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const present = (await readdir(OUT)).filter((f) => f.endsWith('.mp3'));
const wanted = LINES.filter((l) => present.includes(`${l.id}.mp3`));
const missing = LINES.filter((l) => !present.includes(`${l.id}.mp3`));
if (missing.length) console.warn(`  not on disk, skipped: ${missing.map((l) => l.id).join(', ')}`);

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': extname(p) === '.mp3' ? 'audio/mpeg' : 'text/html' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/tools/voices.html`, { waitUntil: 'load' });

const measured = await page.evaluate(
  ([clips, hz]) => window.__measure(clips, hz),
  [wanted.map((l) => ({ id: l.id, url: `/episodes/e01-corazon/voice/${l.id}.mp3` })), ENV_HZ],
);
await browser.close();
server.close();

// --- write the timing table -------------------------------------------------

const byId = new Map(measured.map((m) => [m.id, m]));
const rows = wanted.map((l) => {
  const m = byId.get(l.id);
  return `  ${JSON.stringify(l.id)}: { dur: ${m.dur.toFixed(2)}, peak: ${m.peak.toFixed(2)}, env: ${JSON.stringify(m.env)} },`;
});

await writeFile(join(ROOT, 'episodes/e01-corazon/dialogue-timing.js'), `// GENERATED by tools/voices.mjs — do not edit.
//
// dur  clip length in real seconds; the subtitle is shown for exactly this long
// peak the clip's peak sample, so a quiet line can be normalised for the beak
// env  loudness at ${ENV_HZ} Hz, one digit per frame ('0' silent … '9' loudest),
//      which is what opens and closes the beak

export const ENV_HZ = ${ENV_HZ};

export const TIMING = {
${rows.join('\n')}
};
`);

const total = measured.reduce((a, m) => a + m.dur, 0);
console.log(`\nmeasured ${measured.length} clips, ${total.toFixed(1)}s of speech`);
for (const l of wanted) {
  const m = byId.get(l.id);
  console.log(`  ${l.id.padEnd(8)} ${l.who.padEnd(10)} ${m.dur.toFixed(2)}s  ${l.es}`);
}
