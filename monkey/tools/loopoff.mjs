#!/usr/bin/env node
// The second bake-off: the same still, looped by several video models.
//
//   node tools/loopoff.mjs --dry
//   node tools/loopoff.mjs
//   node tools/loopoff.mjs --sources seedream --models minimax,kling
//
// Same discipline as tools/bakeoff.mjs — one prompt, shared verbatim, and only
// the model and the source still change — with two additions that matter for
// video and not for images.
//
// The first is that every clip is measured for motion before it is shown to
// anyone. This project has already shipped a backdrop video that was valid
// H.264, the right length, the right size and completely static, because the
// only available check was "did a file arrive". tools/mp4.mjs reads the
// per-frame byte sizes out of the stsz box, which measures movement without
// decoding, and a clip that comes back under the threshold is marked as a
// still on the sheet rather than quietly presented as an animation.
//
// The second is size. Nothing here can transcode — the only ffmpeg in the
// image is Playwright's VP8-only build, and Chromium refuses H.264 — so
// whatever a model returns is what has to be embedded in a page with a 16 MB
// ceiling. Every model is therefore asked for its smallest useful output
// (480p, five seconds), and the byte count is a reported column rather than an
// afterthought, because a clip too big to publish is a clip that loses.

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';
import { falRun, fetchBuf } from './fal.mjs';
import { probe, MOVES } from './mp4.mjs';

const OUT = join(ROOT, 'assets/loopoff');
const INDEX = join(OUT, 'index.json');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const DURATION = +opt('duration', 5);

// --- the sources ------------------------------------------------------------
// The two stills that won the image bake-off. Both are pixel art, which makes
// the interesting question narrower than "does it move": a video model that
// resamples or smooths its input will turn hard pixel edges to mush, and that
// is a specific failure to look for rather than a general impression.
const SOURCES = {
  seedream: { label: 'Seedream 4 · pixel', file: 'assets/bakeoff/pixel.seedream.jpg' },
  nano: { label: 'Gemini 2.5 Flash · pixel', file: 'assets/bakeoff/pixel.nano.jpg' },
};

// --- the prompt -------------------------------------------------------------
// Two prohibitions carry most of the weight. A camera move cannot loop, and
// anything that enters or leaves frame cannot either; everything asked for is
// a motion that returns to where it started on its own. The preservation
// paragraph is the pixel-art-specific half — without it a video model treats
// the aliased source as a low-quality input to be cleaned up.
const PROMPT = [
  'Ambient living-painting shot of this moonlit pirate harbour, as a seamless background loop',
  'for a 1990s point-and-click adventure game. Continuous gentle motion: the sea ripples and the',
  "moon's reflection glitters and breaks across it, clouds drift slowly across the night sky, the",
  'lantern flame flickers and its glow pulses on the timber, firelight wavers in the windows,',
  'smoke curls up from the chimney, the hanging sign sways slightly on its bracket, and the moored',
  'ship rocks gently with its pennants fluttering.',
  'Preserve the source artwork exactly: keep the pixel-art style, the hard aliased pixel edges and',
  'the limited palette. Do not smooth, blur, denoise, upscale, repaint or add detail. Do not change',
  'the composition, the colours, or any object in the scene.',
  'The camera is completely locked off: no pan, no zoom, no dolly, no parallax, no camera movement',
  'of any kind, no shot change. Nothing enters or leaves the frame. No people, no characters, no',
  'boats arriving, no text. Only water, air, light and cloth move.',
].join(' ');

// --- the models -------------------------------------------------------------
const MODELS = [
  {
    key: 'minimax', label: 'MiniMax Hailuo H3', id: 'minimax/h3/image-to-video',
    note: 'The model in the build today.',
    build: (uri) => ({ prompt: PROMPT, image_url: uri, duration: DURATION, resolution: '480P', prompt_expansion_mode: 'quality', enable_safety_checker: false }),
  },
  {
    key: 'seedance', label: 'Seedance 1 Lite', id: 'fal-ai/bytedance/seedance/v1/lite/image-to-video',
    build: (uri) => ({ prompt: PROMPT, image_url: uri, duration: String(DURATION), resolution: '480p', enable_safety_checker: false }),
  },
  {
    key: 'kling', label: 'Kling 2.5 Turbo Pro', id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    // This endpoint takes no resolution at all — prompt, image, duration,
    // negative prompt and cfg_scale are the whole surface — so it returns
    // 1080p whatever you ask for, and a five second clip lands near 15 MB.
    // That is a real constraint on using it, not a setting to fix.
    build: (uri) => ({ prompt: PROMPT, image_url: uri, duration: String(DURATION) }),
  },
  {
    key: 'wan', label: 'Wan 2.2 A14B', id: 'fal-ai/wan/v2.2-a14b/image-to-video',
    // Wan interpolates by default (interpolator_model 'film', and
    // adjust_fps_for_interpolation raising the result to 32 fps). Synthesised
    // in-between frames halve the change from one frame to the next, which
    // depresses the stsz motion measure for reasons that have nothing to do
    // with how much the picture actually moves. Turned off, so the number
    // compares like for like with the 24 fps clips.
    build: (uri) => ({
      prompt: PROMPT, image_url: uri, resolution: '480p',
      num_frames: 81, frames_per_second: 16,
      interpolator_model: 'none', adjust_fps_for_interpolation: false,
      video_quality: 'high', enable_safety_checker: false,
    }),
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
// Video charges land slower than image ones, so both windows are wider here.
async function quiesce(ms = 30000) {
  const t0 = Date.now();
  let last = await balance();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2500));
    const now = await balance();
    if (now != null && last != null && now === last) return now;
    last = now;
  }
  return last;
}
async function settle(before, ms = 45000) {
  if (before == null) return null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2500));
    const now = await balance();
    if (now != null && Math.abs(now - before) > 1e-9) return +(before - now).toFixed(6);
  }
  return null;
}

// --- run --------------------------------------------------------------------
const pick = (list, csv) => (csv ? list.filter((x) => csv.split(',').includes(x.key ?? x)) : list);
const sourceKeys = pick(Object.keys(SOURCES), opt('sources', null));
const models = pick(MODELS, opt('models', null));

if (DRY) {
  console.log(`${sourceKeys.length} sources x ${models.length} models = ${sourceKeys.length * models.length} clips, ${DURATION}s each\n`);
  for (const s of sourceKeys) for (const m of models) console.log(`  ${s.padEnd(10)} ${m.label.padEnd(22)} ${m.id}`);
  console.log(`\n--- prompt (${PROMPT.length} chars)\n${PROMPT}`);
  process.exit(0);
}

if (!KEY()) { console.error('FAL_KEY not set'); process.exit(1); }
await mkdir(OUT, { recursive: true });

let clips = [];
try { clips = JSON.parse(await readFile(INDEX, 'utf8')); } catch {}
const done = FORCE ? new Set() : new Set(clips.filter((c) => c.file).map((c) => `${c.source}/${c.model}`));

const start = await balance();
console.log(`balance $${start?.toFixed(4) ?? '?'}  —  ${sourceKeys.length * models.length} clips\n`);

for (const sk of sourceKeys) {
  const src = SOURCES[sk];
  const uri = 'data:image/jpeg;base64,' + (await readFile(join(ROOT, src.file))).toString('base64');
  for (const model of models) {
    const id = `${sk}/${model.key}`;
    if (done.has(id)) { console.log(`  ${id.padEnd(22)} already generated`); continue; }
    process.stdout.write(`  ${id.padEnd(22)} ...`);
    const before = await quiesce();
    const t0 = Date.now();
    const clip = { source: sk, sourceLabel: src.label, model: model.key, label: model.label, id: model.id, prompt: PROMPT, duration: DURATION };
    try {
      const out = await falRun(model.id, model.build(uri), id);
      clip.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      const url = out.video?.url || out.videos?.[0]?.url;
      if (!url) throw new Error('no video: ' + JSON.stringify(out).slice(0, 200));
      const buf = await fetchBuf(url);
      const file = `${sk}.${model.key}.mp4`;
      await writeFile(join(OUT, file), buf);
      const p = probe(buf);
      clip.file = file;
      clip.probe = p;
      clip.moves = !!p.motion && p.motion.ratio > MOVES;
      clip.cost = await settle(before);
      console.log(`\r  ${id.padEnd(22)} ${String(clip.seconds).padStart(5)}s  $${clip.cost?.toFixed(4) ?? '  ?   '}  `
        + `${(buf.length / 1024 / 1024).toFixed(2)} MB  ${p.width}x${p.height}  ${p.seconds.toFixed(1)}s @${p.fps}fps  `
        + `motion ${(p.motion ? p.motion.ratio * 100 : 0).toFixed(1)}%${clip.moves ? '' : '  <-- STILL'}`);
    } catch (e) {
      clip.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      clip.error = e.message.slice(0, 300);
      clip.cost = await settle(before, 8000);
      console.log(`\r  ${id.padEnd(22)} FAILED  ${clip.error}`);
    }
    clips = clips.filter((c) => !(c.source === sk && c.model === model.key)).concat(clip);
    await writeFile(INDEX, JSON.stringify(clips, null, 2) + '\n');
  }
}

const end = await quiesce();
const run = { startBalance: start, endBalance: end, spend: +(start - end).toFixed(4), at: new Date().toISOString() };
let runs = [];
try { runs = JSON.parse(await readFile(join(OUT, 'runs.json'), 'utf8')); } catch {}
await writeFile(join(OUT, 'runs.json'), JSON.stringify(runs.concat(run), null, 2) + '\n');

const ok = clips.filter((c) => c.file);
const mb = ok.reduce((a, c) => a + c.probe.bytes, 0) / 1024 / 1024;
console.log(`\n${ok.length}/${clips.length} clips  —  spent $${run.spend?.toFixed(4)}  —  ${mb.toFixed(1)} MB total `
  + `(~${(mb * 4 / 3).toFixed(1)} MB base64; a page can hold about 16)`);
const still = ok.filter((c) => !c.moves);
if (still.length) console.log(`WARNING: ${still.length} clip(s) contain no motion: ${still.map((c) => c.source + '/' + c.model).join(', ')}`);
