#!/usr/bin/env node
// Can an image model draw a usable character sprite sheet?
//
//   node tools/spriteoff.mjs --dry
//   node tools/spriteoff.mjs
//   node tools/spriteoff.mjs --pixelize          # best sheets -> fal-ai/image2pixel
//
// The question is not "is this pretty". docs/asset-pack.md sets out what the
// engine needs, and most of it is mechanical: eight frames, the same character
// in each, feet on one baseline, figure on one column, hard edges, a limited
// palette. A sheet that is beautiful and fails the baseline rule is unusable,
// and a plain one that passes is not.
//
// Asking for the whole sheet in a single generation is deliberate. The obvious
// alternative — generate one frame, then edit it seven times — sounds more
// controlled and is worse: each edit is an independent roll at the character's
// identity. One image means one character by construction. What it risks
// instead is the grid, which is the thing to look at in the results.

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch } from './harness.mjs';
import { falRun, fetchBuf } from './fal.mjs';
import { balance, quiesce, settle } from './billing.mjs';

const OUT = join(ROOT, 'assets/spriteoff');
const INDEX = join(OUT, 'index.json');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

// --- the brief ---------------------------------------------------------------
// The character is described first and the sheet mechanics second, because a
// model that loses the character has produced nothing, whereas a model that
// gets the grid slightly wrong has produced something worth cutting up by hand.
//
// The background is asked for as flat magenta rather than transparent: almost
// nothing here returns real alpha, and a uniform key colour can be removed
// exactly, whereas a "white background" cannot be told from a white shirt.
const CHARACTER = [
  'The character: a young woman pirate. Red bandana tied over dark auburn hair, a dark red',
  'long coat open over a cream shirt, a gold sash at the waist, blue trousers, black boots.',
  'Small head, long legs, adult proportions — about one seventh of her height is head.',
].join(' ');

const SHEET = [
  'A character sprite sheet for a 1990s pixel-art point-and-click adventure game.',
  'ONE horizontal row of exactly 8 frames, showing a single complete walk cycle, side view,',
  'facing right. Leave a WIDE EMPTY GAP of flat background between every pair of frames — the',
  'figures must be clearly separated and must never touch or overlap.',
  CHARACTER,
  'The SAME character in all 8 frames: identical proportions, identical colours, identical',
  'clothing. Her feet rest on the same baseline in every frame and she is centred at the same',
  'height in every frame — only the legs, arms and body swing.',
  'STYLE: 256-colour pixel art, chunky visible square pixels, a tightly limited palette, hard',
  'aliased pixel edges with no anti-aliasing, a one-pixel dark outline around the whole figure,',
  'flat colour with one lighter step and one darker step per surface. Lit from the right.',
  'The background is one flat uniform magenta, absolutely plain, behind all 8 frames.',
  'NO text, no numbers, no labels, no frame borders, no grid lines, no boxes around the frames,',
  'no drop shadows, no ground line, no extra characters.',
].join(' ');

// --- the models ---------------------------------------------------------------
const MODELS = [
  { key: 'seedream', label: 'Seedream 4', id: 'fal-ai/bytedance/seedream/v4/text-to-image',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1 }) },
  { key: 'nano', label: 'Gemini 2.5 Flash Image', id: 'fal-ai/gemini-25-flash-image',
    build: (p) => ({ prompt: p, aspect_ratio: '16:9', num_images: 1, output_format: 'png' }) },
  { key: 'nano2', label: 'Nano Banana 2 Lite', id: 'google/nano-banana-2-lite',
    build: (p) => ({ prompt: p, aspect_ratio: '16:9', num_images: 1, output_format: 'png' }) },
  { key: 'mai', label: 'MAI Image 2.5', id: 'microsoft/mai-image-2.5',
    build: (p) => ({ prompt: p, aspect_ratio: '16:9', num_images: 1, output_format: 'png' }) },
  { key: 'flux2', label: 'FLUX 2 Pro', id: 'fal-ai/flux-2-pro',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1, output_format: 'png', enable_safety_checker: false }) },
  { key: 'recraft', label: 'Recraft V3 (pixel_art)', id: 'fal-ai/recraft/v3/text-to-image',
    // Recraft caps the prompt at 1000 characters and carries a native pixel-art
    // style, so it gets a compressed brief and the knob.
    short: true, knob: 'digital_illustration/pixel_art',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', style: 'digital_illustration/pixel_art' }) },
  { key: 'qwen', label: 'Qwen Image', id: 'fal-ai/qwen-image',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1, output_format: 'png' }) },
];

const SHORT = [
  'Pixel-art character sprite sheet for a 1990s point-and-click adventure game: one row of 8',
  'frames, a single walk cycle, side view facing right, the same character in every frame with',
  'her feet on one baseline.',
  'A young woman pirate: red bandana, dark red coat over a cream shirt, gold sash, blue trousers,',
  'black boots. Small head, long legs.',
  'Chunky visible pixels, limited palette, hard aliased edges, one-pixel dark outline, flat colour.',
  'Flat uniform magenta background. No text, no borders, no grid lines, no shadows.',
].join(' ');

const promptFor = (m) => (m.short ? SHORT : SHEET);

if (DRY) {
  console.log(`${MODELS.length} models\n`);
  for (const m of MODELS) {
    const p = promptFor(m);
    console.log(`  ${m.label.padEnd(24)} ${String(p.length).padStart(5)} chars ${m.knob ? 'style=' + m.knob : ''}`);
    if (m.short && p.length > 1000) console.log('    !! over Recraft\'s 1000-char cap');
  }
  console.log(`\n--- sheet prompt (${SHEET.length} chars)\n${SHEET}`);
  console.log(`\n--- short prompt (${SHORT.length} chars)\n${SHORT}`);
  process.exit(0);
}

if (!process.env.FAL_KEY) { console.error('FAL_KEY not set'); process.exit(1); }
await mkdir(OUT, { recursive: true });
let rows = [];
try { rows = JSON.parse(await readFile(INDEX, 'utf8')); } catch {}
const done = FORCE ? new Set() : new Set(rows.filter((r) => r.file).map((r) => r.model));

const start = await balance();
console.log(`balance $${start?.toFixed(4) ?? '?'}  —  ${MODELS.length} sheets\n`);

for (const m of MODELS) {
  if (done.has(m.key)) { console.log(`  ${m.key.padEnd(12)} already generated`); continue; }
  process.stdout.write(`  ${m.key.padEnd(12)} ...`);
  const before = await quiesce();
  const t0 = Date.now();
  const row = { model: m.key, label: m.label, id: m.id, prompt: promptFor(m), knob: m.knob || null };
  try {
    const out = await falRun(m.id, m.build(promptFor(m)), m.key);
    row.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    const img = out.images?.[0] || out.image;
    if (!img?.url) throw new Error('no image: ' + JSON.stringify(out).slice(0, 200));
    const buf = await fetchBuf(img.url);
    const file = `${m.key}.png`;
    await writeFile(join(OUT, file), buf);
    row.file = file; row.bytes = buf.length; row.url = img.url;
    row.cost = await settle(before);
    console.log(`\r  ${m.key.padEnd(12)} ${String(row.seconds).padStart(5)}s  $${row.cost?.toFixed(4) ?? '  ?   '}  ${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    row.seconds = +((Date.now() - t0) / 1000).toFixed(1);
    row.error = e.message.slice(0, 240);
    row.cost = await settle(before, 6000);
    console.log(`\r  ${m.key.padEnd(12)} FAILED  ${row.error}`);
  }
  rows = rows.filter((r) => r.model !== m.key).concat(row);
  await writeFile(INDEX, JSON.stringify(rows, null, 2) + '\n');
}

const end = await quiesce();
let runs = [];
try { runs = JSON.parse(await readFile(join(OUT, 'runs.json'), 'utf8')); } catch {}
await writeFile(join(OUT, 'runs.json'), JSON.stringify(runs.concat({ startBalance: start, endBalance: end, spend: +(start - end).toFixed(4), at: new Date().toISOString() }), null, 2) + '\n');
console.log(`\n${rows.filter((r) => r.file).length}/${rows.length} sheets  —  spent $${(start - end).toFixed(4)}`);
