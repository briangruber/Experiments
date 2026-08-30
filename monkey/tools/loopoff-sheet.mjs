#!/usr/bin/env node
// Build a loop bake-off sheet: one page per source still, with every clip that
// still made, its measurements and its prompt.
//
//   node tools/loopoff-sheet.mjs                 # one page per source
//   node tools/loopoff-sheet.mjs --source nano
//
// One page per still rather than one page for everything, and the reason is a
// hard limit rather than a preference. Nothing in this toolchain can transcode
// — the only ffmpeg in the image is Playwright's VP8-only build and Chromium
// refuses H.264 — so each clip has to be embedded at exactly the size the
// model returned it. Eight of those is 21 MB against a 16 MB page ceiling that
// base64 already inflates a third past. Splitting by still keeps the
// comparison that is actually live (which model) inside one page.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const OUT = join(ROOT, 'assets/loopoff');
const DIST = join(ROOT, 'dist');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

// A single clip over this cannot share a page with three others. Kling returns
// 1080p whatever you ask — its endpoint has no resolution parameter at all —
// so it lands near 15 MB and is shown as a row of numbers rather than a video.
const MAX_CLIP = 6 * 1024 * 1024;
const MAX_PAGE = 15 * 1024 * 1024;

// index.json now holds several prompt/loop variants per source and model. A
// sheet shows one variant, named explicitly, so rebuilding a published page
// cannot quietly turn a four-tile comparison into a twelve-tile one.
const VARIANTS = (opt('variants', 'v1')).split(',');
// Ten rock clips is 16 MB of video, well past what one page can carry, so a
// sheet can select its models as well as its variant.
const ONLY = opt('models', null)?.split(',') || null;
const all = JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8'))
  .filter((c) => VARIANTS.includes(c.variant || 'v1'))
  .filter((c) => !ONLY || ONLY.includes(c.model));
const runs = await readFile(join(OUT, 'runs.json'), 'utf8').then(JSON.parse).catch(() => []);
const spendAll = +runs.reduce((a, r) => a + (r.spend || 0), 0).toFixed(4);

const src = await readFile(join(ROOT, 'tools/loopoff.mjs'), 'utf8');
const pm = src.match(/const PROMPT = \[([\s\S]*?)\]\.join\(' '\)/);
const prompt = pm ? pm[1].split('\n').map((l) => l.trim().replace(/^["']|["'],?$/g, '')).filter(Boolean).join(' ') : '';

// Two pages need two names, or they are indistinguishable in a gallery.
const SOURCE_TITLES = {
  seedream: 'Seedream Harbour Loops',
  nano: 'Gemini Harbour Loops',
};

const SOURCE_NOTES = {
  seedream: 'Seedream 4 drew this one in the still bake-off: the closest of the six to a 1990s VGA adventure background, and the one that followed the composition brief exactly — boardwalk edge to edge, props spaced along its back edge, front half left walkable.',
  nano: 'Gemini 2.5 Flash Image drew this one. A cleaner, cooler read of the same brief, with a flatter palette and less of the amber lamplight — worth testing separately because a video model has less contrast and less texture to work with here.',
};
const MODEL_NOTES = {
  minimax: 'The model in the build today. The most expensive of the four per clip and by some way the slowest, and it moved the picture least.',
  seedance: 'The cheapest and among the fastest, and it moved the picture more than the incumbent did. Its endpoint also carries a camera_fixed flag that was deliberately left off here so every clip shares one set of instructions — worth trying on whichever model wins.',
  flux3draft: 'A dedicated first-last-frame endpoint, given the same image as both frames. Frozen — and the draft tier froze exactly as hard as the full one, so this is not a question of quality tier.',
  flux3: 'The full FLUX.3 first-last-frame endpoint, at nearly three times the draft price and a nearly identical result: a held still.',
  veo31lite: 'Veo 3.1 Lite. Its schema declares duration as a bare string with no enum and the endpoint accepts exactly one value, 8s. Frozen like the rest of its category.',
  veo31fast: 'Veo 3.1 Fast. Frozen. Submitting it without a last frame is rejected outright as a missing required field, so these endpoints cannot be run open-loop either.',
  veo31: 'Veo 3.1 at full price — $0.80 for four seconds — and it froze exactly as hard as the $0.30 draft tier. The failure does not track price or vendor.',
  kling: 'The strongest motion of the four, and unusable as-is for this: its endpoint takes no resolution parameter, so it returns 1080p whatever you ask, and a five-second clip lands near 15 MB — over the whole budget for a published page on its own.',
  wan: 'The smallest file and the fastest turnaround. Its first attempt scored 1.4% and looked like a held still; that was frame interpolation, which is on by default and halves the change between frames. With it off the same settings score around 20%.',
};

const bySource = {};
for (const c of all) (bySource[c.source] ??= []).push(c);
const wanted = opt('source', null) ? [opt('source', null)] : Object.keys(bySource);

await mkdir(DIST, { recursive: true });
for (const key of wanted) {
  const clips = bySource[key];
  if (!clips?.length) { console.error(`no clips for ${key}`); continue; }

  const sources = { [key]: { label: clips[0].sourceLabel, note: SOURCE_NOTES[key] || '' } };
  const multi = new Set(clips.map((c) => c.variant || 'v1')).size > 1;
  const models = {};
  for (const c of clips) {
    // Two tiles from the same model differing only by loop strategy have to be
    // told apart, or the sheet is unreadable.
    c.tileLabel = multi ? `${c.label} — ${c.variantLabel}` : c.label;
    models[c.model] ??= { label: c.label, note: MODEL_NOTES[c.model] || '' };
  }

  const videos = {};
  for (const c of clips) {
    if (!c.file) continue;
    const path = join(OUT, c.file);
    if (!(await exists(path))) { c.error = 'clip missing on disk'; delete c.file; continue; }
    if (c.probe.bytes > MAX_CLIP) { c.tooHeavy = true; continue; }
    videos[c.file] = 'data:video/mp4;base64,' + (await readFile(path)).toString('base64');
  }

  const stillPath = join(ROOT, 'assets/bakeoff', `pixel.${key}.jpg`);
  const stills = { [key]: 'data:image/jpeg;base64,' + (await readFile(stillPath)).toString('base64') };

  const spend = +clips.reduce((a, c) => a + (c.cost || 0), 0).toFixed(4);
  const data = {
    clips, sources, models, videos, stills, prompt,
    spend,
    // The run's own start-to-end balance delta covers every clip on every
    // page, and it is the only exact figure here; the per-clip deltas are
    // indicative. Both are passed so the page can say which is which.
    spendAll, clipsAll: all.filter((c) => c.file).length,
    generatedAt: new Date().toISOString().slice(0, 10),
  };

  // A sibling link is written in on a second pass, once both pages have URLs.
  const siblings = JSON.parse(await readFile(join(OUT, 'siblings.json'), 'utf8').catch(() => '{}'));
  data.sibling = siblings[Object.keys(bySource).find((k) => k !== key)] || null;

  const html = (await readFile(join(ROOT, 'tools/loopoff-sheet.html'), 'utf8'))
    // Two pages sharing a title are indistinguishable in a gallery, so a
    // sheet built off the default source/variant pairing must be named.
    .replace('__TITLE__', opt('title', SOURCE_TITLES[key] || `${key} Harbour Loops`))
    .replace('/*__DATA__*/ null', JSON.stringify(data));
  const out = join(DIST, `loopoff-${opt('out', key)}.html`);
  await writeFile(out, html);
  const bytes = Buffer.byteLength(html);
  const heavy = clips.filter((c) => c.tooHeavy).map((c) => c.model);
  console.log(`sheet -> dist/loopoff-${opt('out', key)}.html  ${(bytes / 1024 / 1024).toFixed(2)} MB  `
    + `${Object.keys(videos).length} playable, ${heavy.length ? heavy.join(',') + ' listed only' : 'all embedded'}`);
  if (bytes > MAX_PAGE) console.error(`  WARNING: over the ${MAX_PAGE / 1024 / 1024} MB budget`);
}
