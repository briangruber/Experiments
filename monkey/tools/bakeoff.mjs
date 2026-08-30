#!/usr/bin/env node
// A style bake-off: the same harbour, drawn by several models in several hands.
//
//   node tools/bakeoff.mjs --dry           # print the matrix and the prompts
//   node tools/bakeoff.mjs                 # run it
//   node tools/bakeoff.mjs --styles cel --models flux2,seedream
//
// Why this exists as a tool rather than a handful of curl calls: the useful
// output is not the pictures, it is the comparison. A comparison is only worth
// anything if the thing that varies is the thing you meant to vary, so the
// subject text is shared verbatim across every tile and only the style block
// and the model change.
//
// Cost is measured, not quoted. fal exposes the account balance, so each tile
// reads it before and after and reports the difference. That is why the matrix
// runs strictly sequentially: two generations in flight at once cannot be told
// apart in a balance delta, and the wall-clock numbers would be inflated by
// each other's queueing besides. Slower to run, but the two columns the user
// asked for are then real numbers rather than remembered list prices.

import { writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch } from './harness.mjs';
import { falRun, fetchBuf } from './fal.mjs';

const OUT = join(ROOT, 'assets/bakeoff');
const INDEX = join(OUT, 'index.json');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');

// --- the subject ------------------------------------------------------------
// What the room contains and what the game needs from it. Shared by every tile.
//
// Three requirements a purely pictorial prompt will not meet on its own:
//
//   a clear walking band   the lower third must be unobstructed floor running
//                          the full width, or the character has nowhere to go
//   separated objects      props with space between them, because each one
//                          becomes a hotspot and overlapping hotspots fight
//   animatable elements    water, cloud, flame, smoke, a hanging sign — the
//                          video pass can only move what is already there
//
// And one prohibition: no lettering. Every model so far has returned "Jeavern",
// "TERA" and "TVL9RN" for the same sign, so any text a player must read is
// drawn by the engine over the art.
const SUBJECT = [
  'A background plate for a point-and-click adventure game: a moonlit wooden pier on a',
  'Caribbean pirate island at night, seen from a slightly raised three-quarter view so the',
  'boardwalk reads as a floor a character could walk around on.',
  'COMPOSITION, strictly: the bottom third of the frame is a wide wooden boardwalk running',
  'unbroken from the far left edge to the far right edge — flat, open, and completely clear',
  'of obstruction across its whole width. The front half of the boardwalk is empty. Every',
  'building and every prop sits behind that band, along its back edge.',
  'Right of centre, set back behind the boardwalk, a crooked timber-framed tavern with a',
  'heavily overhanging shingled roof, a stone chimney with smoke curling from it, and two',
  'windows glowing warm amber; a lit iron lantern hangs beside its door, and a blank wooden',
  'sign hangs from a wrought-iron arm.',
  'Spaced well apart along the back edge of the boardwalk, each fully visible and none',
  'overlapping another: an oak grog barrel with an iron spigot, a stack of cargo crates, and',
  'a coil of dark tarred rope.',
  'Behind and below the boardwalk, calm open water with the low moon breaking a reflection',
  'across it, and a two-masted pirate ship moored in the middle distance with pennants at',
  'its mastheads. Above, a deep night sky with the moon and a few drifting clouds.',
  'NO LETTERING ANYWHERE: the sign board is blank, the crates are blank, the ship is blank.',
  'No text, no letters, no numbers, no watermark, no signature.',
  'No people, no characters, no animals. No user interface, no border, no letterboxing, no',
  'split panels, no vignette, no title card.',
].join(' ');

// A compressed subject for the models that cap prompt length. Same content,
// fewer words; the tile records which one it was given so the sheet can say so.
const SUBJECT_SHORT = [
  'Background plate for a point-and-click adventure game: a moonlit wooden pier on a',
  'Caribbean pirate island at night, slightly raised three-quarter view.',
  'The bottom third is a wide wooden boardwalk running unbroken edge to edge, flat and',
  'completely clear; its front half is empty and every prop sits along its back edge.',
  'Right of centre, set back, a crooked leaning tavern with an overhanging shingled roof,',
  'a smoking stone chimney, two amber-lit windows, a lit iron lantern and a blank hanging',
  'sign. Spaced well apart on the boardwalk: a grog barrel with a spigot, a stack of',
  'crates, a coil of rope. Behind, moonlit water with a moored two-masted pirate ship.',
  'No text or lettering anywhere, no people, no UI, no border.',
].join(' ');

// Tighter still, for models that cap the prompt hard. Recraft stops at 1000
// characters, and a model that carries a native style knob needs fewer words
// spent on style anyway.
const SUBJECT_MICRO = [
  'Background plate for a point-and-click adventure game: a moonlit wooden pier on a',
  'Caribbean pirate island at night, slightly raised three-quarter view. The bottom third is',
  'a wide wooden boardwalk running unbroken edge to edge, flat and completely clear, its',
  'front half empty. Right of centre, set back, a crooked leaning tavern with an overhanging',
  'shingled roof, a smoking chimney, two amber-lit windows, a lit lantern and a blank hanging',
  'sign. Spaced apart on the boardwalk: a grog barrel, a stack of crates, a coil of rope.',
  'Behind, moonlit water and a moored two-masted pirate ship.',
  'No text, no people, no UI, no border.',
].join(' ');

// --- the hands --------------------------------------------------------------
// Each style ends in its own NOT list, because the prohibitions are what
// actually separate them: all three describe a painted harbour at night, and
// without them a modern model collapses all three into the same lush digital
// painting it defaults to.
const STYLES = {
  // The target. Bill Tiller's backgrounds for The Curse of Monkey Island were
  // painted like Saturday-morning cartoon art: every object carries a drawn ink
  // line, shading is stepped rather than blended, and the frame is composed to
  // read as flat shapes at 640x480. The thing to prompt hardest against is oil
  // impasto — ask a modern model for "painterly" and it returns loaded
  // brushwork, which is a fine-art tell that no 1997 background has.
  cel: {
    label: 'Cel — inked cartoon (CMI 1997)',
    text: [
      'STYLE: a hand-inked cel animation background painting, in the style of a 1997',
      'LucasArts cartoon adventure game. Every object is drawn with a confident dark ink',
      'outline of varying weight. Colour is laid in as flat cel shading — two or three',
      'stepped tones per surface, base and shadow and highlight, hard-edged shadow shapes,',
      'no blending. Bold simplified forms designed to read instantly at low resolution: a',
      'few wide planks rather than many fine ones, chunky silhouettes, large clean areas of',
      'unbroken colour. Saturated cartoon palette — deep indigo and teal night, hot amber',
      'lamplight, violet shadows, high chroma. Exaggerated storybook caricature: the tavern',
      'leans, its roof overhangs far too far, the barrel is fat and round; proportions are',
      'comic, not architectural. Crisp, clean, graphic and cheerful, flat cartoon lighting.',
      'NOT: no oil painting, no impasto, no visible thick brush strokes, no canvas texture,',
      'no fine-art rendering, no photorealism, no 3D render, no airbrushed realism, no',
      'muddy detail, no film grain, no lens flare, no depth of field blur.',
    ].join(' '),
    short: [
      'STYLE: hand-inked cel animation background from a 1997 LucasArts cartoon adventure',
      'game. Confident dark ink outlines on every object. Flat cel shading, two or three',
      'stepped tones per surface, hard-edged shadows, no blending. Bold simplified shapes',
      'that read at low resolution. Saturated cartoon palette: indigo night, hot amber',
      'lamplight, violet shadows. Exaggerated storybook caricature, leaning buildings.',
      'NOT: no oil painting, no impasto, no brush strokes, no photorealism, no 3D render.',
    ].join(' '),
    micro: [
      'Hand-inked cel animation background from a 1997 LucasArts cartoon adventure game: dark',
      'ink outlines on every object, flat stepped cel shading, hard-edged shadows, bold',
      'simplified shapes, saturated indigo night and hot amber lamplight, exaggerated',
      'storybook caricature. Not an oil painting: no impasto, no brush strokes, no photorealism.',
    ].join(' '),
    recraft: 'digital_illustration/2d_art_poster',
    ideogram: 'OLD_CARTOONS',
  },

  // The other 90s hand: painted cel backgrounds with no outline, held together
  // by shape design instead of line. Full Throttle, Broken Sword, Discworld.
  gouache: {
    label: 'Gouache — painted, no line (Full Throttle)',
    text: [
      'STYLE: a painted animation background in gouache and airbrush, in the style of',
      'mid-1990s CD-ROM adventure game art. Soft-edged painted forms with no ink outline,',
      'held together by flat graphic shape design rather than by line. Smooth airbrushed',
      'gradients inside each shape and crisp silhouettes between them. Restrained detail —',
      'a surface is described in a few strokes and then left alone. Rich saturated night',
      'palette: indigo sea, cobalt shadow, warm ochre lamplight. Slightly stylised',
      'proportions. Clean and poster-like, designed to sit quietly behind animated characters.',
      'NOT: no oil impasto, no visible loaded brush strokes, no canvas weave, no',
      'photorealism, no 3D render, no fine-art oil painting, no film grain, no blur.',
    ].join(' '),
    short: [
      'STYLE: painted gouache and airbrush animation background, mid-1990s CD-ROM adventure',
      'game art. Soft-edged painted forms, no ink outline, flat graphic shape design.',
      'Smooth airbrushed gradients within shapes, crisp silhouettes between them.',
      'Restrained detail. Saturated night palette: indigo sea, cobalt shadow, ochre lamp.',
      'NOT: no oil impasto, no loaded brush strokes, no canvas weave, no photorealism.',
    ].join(' '),
    micro: [
      'Painted gouache and airbrush animation background, mid-1990s CD-ROM adventure game art:',
      'soft-edged forms with no ink outline, flat graphic shape design, smooth airbrushed',
      'gradients, restrained detail, saturated indigo and cobalt night with ochre lamplight.',
      'Not an oil painting: no impasto, no brush strokes, no photorealism.',
    ].join(' '),
    recraft: 'digital_illustration/hand_drawn',
    ideogram: '90S_NOSTALGIA',
  },

  // The earlier era, and the one the reference image came from: 256-colour VGA.
  // Worth measuring because it is by far the cheapest style to keep consistent
  // across forty rooms, not only because it is period-correct.
  pixel: {
    label: 'Pixel — 256-colour VGA (MI2)',
    text: [
      'STYLE: 256-colour pixel art, in the style of an early-1990s VGA point-and-click',
      'adventure game. Chunky visible square pixels, a tightly limited hand-picked palette,',
      'ordered dithering for the gradients in the sky and the sea, hard aliased pixel edges,',
      'near-black outlines on the key objects. Low-resolution look with bold readable shapes',
      'and no wasted detail.',
      'NOT: no smooth shading, no anti-aliasing, no photorealism, no oil painting, no 3D',
      'render, no high-resolution detail, no modern digital painting, no blur.',
    ].join(' '),
    short: [
      'STYLE: 256-colour pixel art from an early-1990s VGA point-and-click adventure game.',
      'Chunky visible square pixels, tightly limited palette, ordered dithering in the sky',
      'and sea, hard aliased edges, near-black outlines. Bold readable low-resolution shapes.',
      'NOT: no smooth shading, no anti-aliasing, no photorealism, no 3D render, no blur.',
    ].join(' '),
    micro: [
      '256-colour pixel art from an early-1990s VGA point-and-click adventure game: chunky',
      'visible square pixels, a tightly limited palette, ordered dithering in the sky and sea,',
      'hard aliased edges, near-black outlines, bold low-resolution shapes.',
      'No smooth shading, no anti-aliasing, no photorealism.',
    ].join(' '),
    recraft: 'digital_illustration/pixel_art',
    ideogram: null,
  },
};

// --- the models -------------------------------------------------------------
// `build` is given the assembled prompt and the style record, so a model that
// has a native style knob can use it. Which knob was used is recorded per tile
// and printed on the sheet — showing each model at its best is the point, but
// only if the sheet says what "its best" was given.
const MODELS = [
  {
    key: 'flux2', label: 'FLUX 2 Pro', id: 'fal-ai/flux-2-pro',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1, output_format: 'jpeg', enable_safety_checker: false }),
  },
  {
    key: 'seedream', label: 'Seedream 4', id: 'fal-ai/bytedance/seedream/v4/text-to-image',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1 }),
  },
  {
    // Recraft caps the prompt, so it gets the short subject — recorded, so the
    // sheet does not silently compare a paragraph against a sentence.
    key: 'recraft', label: 'Recraft V3', id: 'fal-ai/recraft/v3/text-to-image',
    level: 'micro', maxPrompt: 1000,
    knob: (s) => s.recraft, knobName: 'style',
    build: (p, s) => ({ prompt: p, image_size: 'landscape_16_9', ...(s.recraft ? { style: s.recraft } : {}) }),
  },
  {
    key: 'ideogram', label: 'Ideogram V3', id: 'fal-ai/ideogram/v3',
    knob: (s) => s.ideogram, knobName: 'style_preset',
    build: (p, s) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1, ...(s.ideogram ? { style_preset: s.ideogram } : {}) }),
  },
  {
    key: 'qwen', label: 'Qwen Image', id: 'fal-ai/qwen-image',
    build: (p) => ({ prompt: p, image_size: 'landscape_16_9', num_images: 1, output_format: 'jpeg' }),
  },
  {
    key: 'nano', label: 'Gemini 2.5 Flash Image', id: 'fal-ai/gemini-25-flash-image',
    build: (p) => ({ prompt: p, aspect_ratio: '16:9', num_images: 1, output_format: 'jpeg' }),
  },
];

// --- measurement ------------------------------------------------------------

const KEY = () => process.env.FAL_KEY;

async function balance() {
  const r = await fetch('https://rest.alpha.fal.ai/billing/user_balance', { headers: { Authorization: `Key ${KEY()}` } });
  if (!r.ok) return null;
  const v = parseFloat(await r.text());
  return Number.isFinite(v) ? v : null;
}

// Billing lags the task, in both directions. Reading `before` while the
// PREVIOUS tile's charge is still landing smears one tile's cost onto the
// next, so wait for the balance to go quiet first — two equal reads — and only
// then start the clock.
async function quiesce(ms = 20000) {
  const t0 = Date.now();
  let last = await balance();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await balance();
    if (now != null && last != null && now === last) return now;
    last = now;
  }
  return last;
}

// And settles a moment after the task does, so poll rather than reading once
// and reporting a zero that is really a race. A tile whose cost never settles
// reports null and says so on the sheet, which is the honest answer.
async function settle(before, ms = 25000) {
  if (before == null) return null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 1500));
    const now = await balance();
    if (now != null && Math.abs(now - before) > 1e-9) return +(before - now).toFixed(6);
  }
  return null;
}

// No usable image encoder in this toolchain — the bundled ffmpeg is a
// webm-only build — so the browser does the re-encode and the downscale.
async function shrink(buf, mime, width = 1280, quality = 0.82) {
  const browser = await launch();
  const page = await browser.newPage();
  const out = await page.evaluate(async ([uri, w, q]) => {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri;
    });
    const s = Math.min(1, w / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', q), w: img.width, h: img.height };
  }, [`data:${mime};base64,` + buf.toString('base64'), width, quality]);
  await browser.close();
  return { buf: Buffer.from(out.data.split(',')[1], 'base64'), width: out.w, height: out.h };
}

// --- run --------------------------------------------------------------------

const pick = (list, csv, keyOf) => (csv ? list.filter((x) => csv.split(',').includes(keyOf(x))) : list);
const styleKeys = pick(Object.keys(STYLES), opt('styles', null), (k) => k);
const models = pick(MODELS, opt('models', null), (m) => m.key);

const SUBJECTS = { full: SUBJECT, short: SUBJECT_SHORT, micro: SUBJECT_MICRO };

function promptFor(model, styleKey) {
  const s = STYLES[styleKey];
  const level = model.level || 'full';
  const text = { full: s.text, short: s.short, micro: s.micro }[level];
  const prompt = `${SUBJECTS[level]} ${text}`;
  // Recraft answers an over-long prompt with a 422 that costs nothing but a
  // slot in the matrix, and the same mistake against a model that silently
  // truncates would cost a tile that looks fine and was drawn from half a
  // brief. Fail here, before the money.
  if (model.maxPrompt && prompt.length > model.maxPrompt) {
    throw new Error(`${model.key}/${styleKey}: prompt is ${prompt.length} chars, cap is ${model.maxPrompt}`);
  }
  return prompt;
}

if (DRY) {
  console.log(`${styleKeys.length} styles x ${models.length} models = ${styleKeys.length * models.length} generations\n`);
  for (const k of styleKeys) {
    for (const m of models) {
      const p = promptFor(m, k);
      const knob = m.knob?.(STYLES[k]);
      console.log(`${k.padEnd(8)} ${m.label.padEnd(24)} ${String(p.length).padStart(5)} chars ${(m.level||'full').padEnd(5)}  ${knob ? m.knobName + '=' + knob : ''}`);
    }
  }
  console.log(`\n--- subject (${SUBJECT.length} chars)\n${SUBJECT}`);
  for (const k of styleKeys) console.log(`\n--- style: ${k} (${STYLES[k].text.length} chars)\n${STYLES[k].text}`);
  process.exit(0);
}

if (!KEY()) { console.error('FAL_KEY not set'); process.exit(1); }
await mkdir(OUT, { recursive: true });

let tiles = [];
try { tiles = JSON.parse(await readFile(INDEX, 'utf8')); } catch {}
const done = new Set(tiles.filter((t) => t.file).map((t) => `${t.style}/${t.model}`));

const start = await balance();
console.log(`balance $${start?.toFixed(4) ?? '?'}  —  ${styleKeys.length * models.length} tiles\n`);

for (const styleKey of styleKeys) {
  for (const model of models) {
    const id = `${styleKey}/${model.key}`;
    if (done.has(id)) { console.log(`  ${id.padEnd(24)} already generated`); continue; }
    const prompt = promptFor(model, styleKey);
    const knob = model.knob?.(STYLES[styleKey]) || null;
    process.stdout.write(`  ${id.padEnd(24)} ...`);

    const before = await quiesce();
    const t0 = Date.now();
    let tile = { style: styleKey, model: model.key, label: model.label, id: model.id, prompt, promptChars: prompt.length, level: model.level || 'full', knob, knobName: knob ? model.knobName : null };
    try {
      const out = await falRun(model.id, model.build(prompt, STYLES[styleKey]), id);
      tile.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      const img = out.images?.[0] || out.image;
      if (!img?.url) throw new Error('no image in response: ' + JSON.stringify(out).slice(0, 200));
      const raw = await fetchBuf(img.url);
      const mime = /\.png(\?|$)/i.test(img.url) || img.content_type === 'image/png' ? 'image/png' : 'image/jpeg';
      const small = await shrink(raw, mime);
      const file = `${styleKey}.${model.key}.jpg`;
      await writeFile(join(OUT, file), small.buf);
      tile.file = file;
      tile.native = `${small.width}x${small.height}`;
      tile.bytes = small.buf.length;
      tile.cost = await settle(before);
      console.log(`\r  ${id.padEnd(24)} ${String(tile.seconds).padStart(5)}s  $${tile.cost?.toFixed(4) ?? '  ?   '}  ${tile.native}  ${(small.buf.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      tile.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      tile.error = e.message.slice(0, 300);
      tile.cost = await settle(before, 6000);
      console.log(`\r  ${id.padEnd(24)} FAILED  ${tile.error}`);
    }
    tiles = tiles.filter((t) => !(t.style === styleKey && t.model === model.key)).concat(tile);
    await writeFile(INDEX, JSON.stringify(tiles, null, 2) + '\n');
  }
}

// Per-tile deltas carry about one tile of billing lag even with the quiesce,
// so the run's own start-to-end delta is recorded separately. That number is
// exact; the per-tile ones are indicative, and the sheet says which is which.
const end = await quiesce();
const run = { startBalance: start, endBalance: end, spend: +(start - end).toFixed(4), at: new Date().toISOString() };
let runs = [];
try { runs = JSON.parse(await readFile(join(OUT, 'runs.json'), 'utf8')); } catch {}
await writeFile(join(OUT, 'runs.json'), JSON.stringify(runs.concat(run), null, 2) + '\n');
const ok = tiles.filter((t) => t.file);
console.log(`\n${ok.length}/${tiles.length} tiles  —  balance $${start?.toFixed(4)} -> $${end?.toFixed(4)}  (spent $${(start - end).toFixed(4)})`);
console.log('sheet: node tools/bakeoff-sheet.mjs');
