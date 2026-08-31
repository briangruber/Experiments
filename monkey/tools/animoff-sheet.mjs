#!/usr/bin/env node
// Build the animated sprite-sheet test bench.
//
//   node tools/animoff-sheet.mjs
//
// A still contact sheet cannot answer the question that matters. A character
// whose height varies eight percent between frames looks perfectly fine laid
// out in a row and pulses once it moves, and a sheet whose frames are cut in
// the wrong places only shows it as a stutter. So every sheet is shipped into
// the page and sliced there, live, by the same rules the real cutter uses.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const OUT = join(ROOT, 'assets/spriteoff');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const uri = async (p, mime) => `data:${mime};base64,` + (await readFile(p)).toString('base64');

const rows = JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8')).filter((r) => r.file);

// What each model actually drew. The brief asked for eight frames from all of
// them; these are the counts they returned, and they are the starting point
// rather than the answer — the page lets each be changed, because a sheet cut
// into the wrong number of slices animates like a stutter and that is worth
// being able to rule out by hand.
const FRAMES = { seedream: 8, nano: 8, nano2: 8, mai: 7, flux2: 6, recraft: 4, qwen: 5 };

const models = [];
for (const r of rows) {
  const raw = join(OUT, r.file);
  const px = join(OUT, r.file.replace(/\.png$/, '.px.png'));
  const mime = (await readFile(raw)).subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : 'image/jpeg';
  models.push({
    key: r.model, label: r.label, id: r.id,
    cost: r.cost ?? 0, seconds: r.seconds ?? 0,
    frames: FRAMES[r.model] ?? 8, fps: 10,
    sheet: await uri(raw, mime),
    pxSheet: (await exists(px)) ? await uri(px, 'image/png') : null,
  });
}

const data = {
  models,
  plate: await uri(join(ROOT, 'assets/scene.jpg'), 'image/jpeg'),
  generatedAt: new Date().toISOString().slice(0, 10),
};

const html = (await readFile(join(ROOT, 'tools/animoff-sheet.html'), 'utf8'))
  .replace('/*__DATA__*/ null', JSON.stringify(data));
await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist/animoff.html'), html);
const mb = Buffer.byteLength(html) / 1024 / 1024;
console.log(`bench -> dist/animoff.html  ${mb.toFixed(2)} MB  ${models.length} sheets`);
if (mb > 15) console.error('WARNING: over the artifact budget');
