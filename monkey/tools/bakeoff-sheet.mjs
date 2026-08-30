#!/usr/bin/env node
// Build the bake-off contact sheet: one self-contained page with every tile,
// its prompt, its measured cost and its measured time.
//
//   node tools/bakeoff-sheet.mjs
//
// The page is a static template with a single data hole in it, rather than a
// string built here, so the markup can be edited as markup and the generator
// stays a data-injection step.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const OUT = join(ROOT, 'assets/bakeoff');
const DIST = join(ROOT, 'dist');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const tiles = JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8'));

// Pull the prompt text straight out of the tool that ran the matrix, so the
// sheet cannot drift from what was actually submitted.
const src = await readFile(join(ROOT, 'tools/bakeoff.mjs'), 'utf8');

// Styles and models are described here for the reader, keyed to what the run
// recorded. The label is the run's; the note is what the tile is for.
const STYLE_NOTES = {
  cel: 'The target. Bill Tiller painted the Curse of Monkey Island backgrounds like Saturday-morning cartoon art: a drawn ink line on every object, shading stepped rather than blended, and the whole frame composed to read as flat shapes at 640×480. The hardest thing to prompt away from is oil impasto — ask a modern model for "painterly" and it hands back loaded brushwork, which is a fine-art tell no 1997 background has.',
  gouache: 'The other 90s hand — Full Throttle, Broken Sword, Discworld. Painted cel backgrounds with no outline at all, held together by flat shape design instead of line. Softer than cel, and still nothing like an oil painting.',
  pixel: 'The earlier era, and the one the reference image came from: 256-colour VGA. Worth measuring because it is by far the cheapest style to keep consistent across forty rooms, not only because it is period-correct.',
};

// What each model actually did with the brief. Written after looking at the
// tiles, and kept factual: the point of the sheet is that the reader judges the
// pictures, not that they take these notes on trust.
const MODEL_NOTES = {
  flux2: 'Took the style instruction literally in every hand — drawn ink line, stepped shading, a blank sign, and the boardwalk running the full width with its front half clear. At the named landscape_16_9 it returns only 1024x576, so a final plate needs an explicit larger size.',
  seedream: 'Followed both halves of the brief most closely: the period hand and the composition rules, with props spaced along the back edge and the front of the dock left walkable. Largest native output of the six at 2048x1152.',
  recraft: 'Its named styles are strong enough to overrule the brief — 2d_art_poster returned a mid-century travel poster in daylight, with no night, no ship and no moon. Also the only model here that caps prompt length at 1000 characters, so its tiles were given the compressed brief.',
  ideogram: 'Handsome pictures that do not meet the spec. OLD_CARTOONS landed on 1960s UPA rather than 1990s LucasArts and added a white border; 90S_NOSTALGIA produced a lovely painted night but reframed the dock into depth, wrote letters on the sign, and left a white blob at the right edge.',
  qwen: 'Ignored the flat-cel and pixel instructions alike and returned the same modern 3D-lit mobile-game jetty each time, receding into the distance — the opposite of the flat side-on staging a SCUMM room is built on. Comfortably the fastest and cheapest of the six.',
  nano: 'A clean, confident ink line, but a cooler and flatter palette with much less of the amber lamplight the room is lit by, and it drew a crescent moon where the brief asked for a low full one.',
};

const styles = {};
const models = {};
for (const t of tiles) {
  if (t.style !== 'incumbent') {
    styles[t.style] ??= { label: null, text: null, note: STYLE_NOTES[t.style] || '' };
  }
  models[t.model] ??= { label: t.label, note: MODEL_NOTES[t.model] || '' };
}

// Labels and the full style text come from the tool's own tables.
for (const key of Object.keys(styles)) {
  const m = src.match(new RegExp(`\\n  ${key}: \\{[\\s\\S]*?label: '([^']*)'[\\s\\S]*?text: \\[([\\s\\S]*?)\\]\\.join\\(' '\\)`));
  styles[key].label = m ? m[1] : key;
  styles[key].text = m ? m[2].split('\n').map((l) => l.trim().replace(/^'|',?$/g, '')).filter(Boolean).join(' ') : '';
}
const subj = src.match(/const SUBJECT = \[([\s\S]*?)\]\.join\(' '\)/);
const subject = subj ? subj[1].split('\n').map((l) => l.trim().replace(/^'|',?$/g, '')).filter(Boolean).join(' ') : '';

// The incumbent goes in as a tile so the comparison has a baseline that is
// actually in the build, not a remembered impression of it.
const incumbentPath = join(ROOT, 'assets/scene.jpg');
if (await exists(incumbentPath)) {
  const prov = JSON.parse(await readFile(join(ROOT, 'assets/provenance.json'), 'utf8')).filter((e) => e.kind === 'scene-still').pop();
  tiles.unshift({
    style: 'incumbent', model: 'shipped', label: 'FLUX 2 Pro — the oil-painting prompt',
    id: prov?.model || 'fal-ai/flux-2-pro', file: '__incumbent__', native: prov?.size || null,
    seconds: null, cost: null, prompt: prov?.prompt || '(not recorded)', knob: null,
  });
}

// The incumbent is added after the model table is built, so give it its own
// entry or it vanishes when the sheet is grouped by model.
models.shipped ??= { label: 'FLUX 2 Pro (shipped build)', note: 'The plate in the game today, generated from the earlier oil-painting prompt. Kept here as the baseline the three new hands are being measured against.' };

const images = {};
for (const t of tiles) {
  if (!t.file) continue;
  const path = t.file === '__incumbent__' ? incumbentPath : join(OUT, t.file);
  if (!(await exists(path))) { delete t.file; t.error = 'image missing on disk'; continue; }
  images[t.file] = 'data:image/jpeg;base64,' + (await readFile(path)).toString('base64');
}

// The run ledger holds the exact start-to-end balance delta. Summing per-tile
// deltas would undercount by whatever failed to settle, so prefer the ledger
// and fall back to the sum only if there is no ledger at all.
let spend = null;
try {
  const runs = JSON.parse(await readFile(join(OUT, 'runs.json'), 'utf8'));
  spend = +runs.reduce((a, r) => a + (r.spend || 0), 0).toFixed(4);
} catch {
  spend = +tiles.filter((t) => t.cost != null && t.style !== 'incumbent')
    .reduce((a, t) => a + t.cost, 0).toFixed(4);
}
const data = {
  tiles, styles, models, images, subject, spend,
  generatedAt: new Date().toISOString().slice(0, 10),
};

const html = (await readFile(join(ROOT, 'tools/bakeoff-sheet.html'), 'utf8'))
  .replace('/*__DATA__*/ null', JSON.stringify(data));

await mkdir(DIST, { recursive: true });
const out = join(DIST, 'bakeoff.html');
await writeFile(out, html);
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`sheet -> dist/bakeoff.html  ${mb} MB  ${tiles.filter((t) => t.file).length} tiles`);
if (+mb > 15) console.error('WARNING: over the artifact size ceiling');
