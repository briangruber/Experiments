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
import { probe, isDead } from './mp4.mjs';

const OUT = join(ROOT, 'assets/loopoff');
const INDEX = join(OUT, 'index.json');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const DURATION = +opt('duration', 5);
// Veo bills by the second and a run that empties the account mid-matrix leaves
// no way to finish it. Refuse to submit below this.
const FLOOR = +opt('floor', 3);

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

// Drift is its own failure, separate from "does it move". A ship that travels
// across the frame cannot loop and, worse, defeats the playback crossfade: the
// two offset copies show the same ship in two places at once. The original
// prompt asked for a locked camera and said nothing entered or left the frame,
// but never forbade an object from translating inside it, which is exactly what
// the models did with "the moored ship rocks gently".
const DRIFT = [
  'Every moving thing returns to where it started. The ship is at anchor: it does not travel,',
  'sail, advance or move forward through the water, and its position in the frame never changes —',
  'it only rocks gently in place, tilting a little and settling back. Nothing slides, pans or',
  'drifts across the frame. The sea surface ripples in place without the water sliding sideways.',
  'At the end of the clip everything is exactly where it was at the start.',
].join(' ');

// The long prompt may itself be the problem. Every clause is another thing for
// the model to weigh, and a list of nine simultaneous motions plus three
// paragraphs of prohibitions is a lot of instruction for five seconds of
// picture. This is the same brief in one sentence.
const SIMPLE = 'Gentle looping animation: water ripples, clouds drift, the lantern flickers, '
  + 'smoke rises from the chimney. The camera is still.';

// Not every motion can loop, and asking for one that cannot is asking for the
// seam. A drifting cloud has to either leave the frame or reverse, and neither
// is subtle; chimney smoke has the same problem going up. What is left is
// motion that is either oscillatory — a rocking hull, a fluttering pennant, a
// guttering flame — or cyclic in place, like water. So the list is cut to
// those, and the ship is named first because a gentle rock is the thing the
// scene most needs and the thing the models were least willing to give.
const ROCK = 'The moored ship rocks gently from side to side, tilting and settling back in place. '
  + 'The water ripples. The lantern flame and the window light flicker. The camera is still.';

// Two ways to stop it, tested against each other rather than assumed. The
// closed variant hands the model its own first frame as the last frame, which
// forces the clip to return to its starting state. That is the thing that
// produced a completely static clip once before — but that was a first-last-
// frame model given identical frames and nothing else to go on, and there is
// now a motion check that catches it in seconds if it happens again.
const VARIANTS = {
  v1: { label: 'Original prompt', text: 'long', end: false },
  anchored: { label: 'Anti-drift prompt', text: 'drift', end: false },
  closed: { label: 'Anti-drift + closed loop', text: 'drift', end: true },
  // Prompt length and loop closure are separate levers, so they get separate
  // variants: without the open control there is no way to tell which of the
  // two did the work.
  simple: { label: 'Short prompt + closed loop', text: 'simple', end: true },
  'simple-open': { label: 'Short prompt, open loop', text: 'simple', end: false },
  // Loopable motions only, ship first.
  rock: { label: 'Rocking ship, closed loop', text: 'rock', end: true },
  'rock-open': { label: 'Rocking ship, open loop', text: 'rock', end: false },
};
const VARIANT = opt('variant', 'v1');
if (!VARIANTS[VARIANT]) { console.error(`unknown variant ${VARIANT} — one of ${Object.keys(VARIANTS)}`); process.exit(1); }
const V = VARIANTS[VARIANT];
const TEXT = { long: PROMPT, drift: `${PROMPT} ${DRIFT}`, simple: SIMPLE, rock: ROCK }[V.text];

// --- the models -------------------------------------------------------------
// Dedicated first-last-frame endpoints. These are the models built for exactly
// the thing being attempted — handed the same frame twice, the clip has to
// return to where it started — so they are the interesting case rather than a
// workaround. Three things they share and the earlier four did not: they name
// their two frames themselves rather than reusing image_url, they generate
// audio unless told not to (useless for a background loop and it costs bytes),
// and none of them offers 480p. 720p is their floor.
const MODELS = [
  {
    key: 'flux3draft', label: 'FLUX.3 first-last (draft)', id: 'blackforestlabs/flux-3/first-last-frame-to-video/draft',
    startField: 'start_image_url', endField: 'end_image_url',
    build: (uri) => ({ prompt: TEXT, start_image_url: uri, duration: 5, aspect_ratio: 'auto', generate_audio: false }),
  },
  {
    key: 'flux3', label: 'FLUX.3 first-last', id: 'blackforestlabs/flux-3/first-last-frame-to-video',
    startField: 'start_image_url', endField: 'end_image_url',
    build: (uri) => ({ prompt: TEXT, start_image_url: uri, duration: 5, resolution: '720p', aspect_ratio: 'auto', generate_audio: false }),
  },
  {
    key: 'veo31lite', label: 'Veo 3.1 Lite first-last', id: 'fal-ai/veo3.1/lite/first-last-frame-to-video',
    startField: 'first_frame_url', endField: 'last_frame_url',
    // Its schema declares duration as a bare string with no enum; the endpoint
    // accepts exactly one value. The fast and full variants take 4s/6s/8s.
    build: (uri) => ({ prompt: TEXT, first_frame_url: uri, duration: '8s', resolution: '720p', aspect_ratio: 'auto', generate_audio: false }),
  },
  {
    key: 'veo31fast', label: 'Veo 3.1 Fast first-last', id: 'fal-ai/veo3.1/fast/first-last-frame-to-video',
    startField: 'first_frame_url', endField: 'last_frame_url',
    build: (uri) => ({ prompt: TEXT, first_frame_url: uri, duration: '4s', resolution: '720p', aspect_ratio: 'auto', generate_audio: false }),
  },
  {
    key: 'veo31', label: 'Veo 3.1 first-last', id: 'fal-ai/veo3.1/first-last-frame-to-video',
    startField: 'first_frame_url', endField: 'last_frame_url',
    build: (uri) => ({ prompt: TEXT, first_frame_url: uri, duration: '4s', resolution: '720p', aspect_ratio: 'auto', generate_audio: false }),
  },
  {
    key: 'minimax', label: 'MiniMax Hailuo H3', id: 'minimax/h3/image-to-video',
    note: 'The model in the build today.',
    endField: 'end_image_url',
    build: (uri) => ({ prompt: TEXT, image_url: uri, duration: DURATION, resolution: '480P', prompt_expansion_mode: 'quality', enable_safety_checker: false }),
  },
  {
    key: 'seedance', label: 'Seedance 1 Lite', id: 'fal-ai/bytedance/seedance/v1/lite/image-to-video',
    endField: 'end_image_url',
    build: (uri) => ({ prompt: TEXT, image_url: uri, duration: String(DURATION), resolution: '480p', enable_safety_checker: false }),
  },
  {
    key: 'kling', label: 'Kling 2.5 Turbo Pro', id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    // This endpoint takes no resolution at all — prompt, image, duration,
    // negative prompt and cfg_scale are the whole surface — so it returns
    // 1080p whatever you ask for, and a five second clip lands near 15 MB.
    // That is a real constraint on using it, not a setting to fix.
    endField: 'tail_image_url',
    build: (uri) => ({ prompt: TEXT, image_url: uri, duration: String(DURATION) }),
  },
  {
    key: 'wan', label: 'Wan 2.2 A14B', id: 'fal-ai/wan/v2.2-a14b/image-to-video',
    // Wan interpolates by default (interpolator_model 'film', and
    // adjust_fps_for_interpolation raising the result to 32 fps). Synthesised
    // in-between frames halve the change from one frame to the next, which
    // depresses the stsz motion measure for reasons that have nothing to do
    // with how much the picture actually moves. Turned off, so the number
    // compares like for like with the 24 fps clips.
    endField: 'end_image_url',
    build: (uri) => ({
      prompt: TEXT, image_url: uri, resolution: '480p',
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
  console.log(`variant ${VARIANT} (${V.label}) — ${sourceKeys.length} sources x ${models.length} models = ${sourceKeys.length * models.length} clips, ${DURATION}s each\n`);
  for (const s of sourceKeys) for (const m of models) {
    const end = V.end ? (m.endField ? `${m.endField}=source` : 'NO END-FRAME FIELD — open loop') : '';
    console.log(`  ${s.padEnd(10)} ${m.label.padEnd(22)} ${end}`);
  }
  console.log(`\n--- prompt (${TEXT.length} chars)\n${TEXT}`);
  process.exit(0);
}

if (!KEY()) { console.error('FAL_KEY not set'); process.exit(1); }
await mkdir(OUT, { recursive: true });

let clips = [];
try { clips = JSON.parse(await readFile(INDEX, 'utf8')); } catch {}
const key = (c) => `${c.source}/${c.model}/${c.variant || 'v1'}`;
const done = FORCE ? new Set() : new Set(clips.filter((c) => c.file).map(key));

const start = await balance();
console.log(`balance $${start?.toFixed(4) ?? '?'}  —  ${sourceKeys.length * models.length} clips, variant ${VARIANT} (${V.label})\n`);

for (const sk of sourceKeys) {
  const src = SOURCES[sk];
  const uri = 'data:image/jpeg;base64,' + (await readFile(join(ROOT, src.file))).toString('base64');
  for (const model of models) {
    const id = `${sk}/${model.key}/${VARIANT}`;
    if (done.has(id)) { console.log(`  ${id.padEnd(26)} already generated`); continue; }
    process.stdout.write(`  ${id.padEnd(26)} ...`);
    const before = await quiesce();
    if (before != null && before < FLOOR) {
      console.log(`\r  ${id.padEnd(26)} SKIPPED — balance $${before.toFixed(2)} is below the $${FLOOR} floor`);
      continue;
    }
    const t0 = Date.now();
    const clip = { source: sk, sourceLabel: src.label, model: model.key, label: model.label, id: model.id,
      variant: VARIANT, variantLabel: V.label, prompt: TEXT, closedLoop: !!V.end, duration: DURATION };
    try {
      const input = model.build(uri);
      if (V.end) {
        if (!model.endField) throw new Error(`${model.key} has no end-frame field; a closed loop is not possible here`);
        input[model.endField] = uri;
        // The whole point of this variant is the last frame. Paying for a clip
        // that quietly did not get one is the failure this tool exists to stop.
        const startField = model.startField || 'image_url';
        if (!input[startField]) throw new Error(`${model.key}: no start frame in ${startField}`);
        if (input[model.endField] !== input[startField]) throw new Error('end frame is not the same image as the start frame');
      }
      clip.sent = Object.keys(input).sort();
      clip.endFrame = V.end ? model.endField : null;
      const out = await falRun(model.id, input, id);
      clip.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      const url = out.video?.url || out.videos?.[0]?.url;
      if (!url) throw new Error('no video: ' + JSON.stringify(out).slice(0, 200));
      const buf = await fetchBuf(url);
      const file = VARIANT === 'v1' ? `${sk}.${model.key}.mp4` : `${sk}.${model.key}.${VARIANT}.mp4`;
      await writeFile(join(OUT, file), buf);
      const p = probe(buf);
      clip.file = file;
      clip.probe = p;
      clip.moves = !isDead(p.motion);
      clip.cost = await settle(before);
      console.log(`\r  ${id.padEnd(26)} ${String(clip.seconds).padStart(5)}s  $${clip.cost?.toFixed(4) ?? '  ?   '}  `
        + `${(buf.length / 1024 / 1024).toFixed(2)} MB  ${p.width}x${p.height}  ${p.seconds.toFixed(1)}s @${p.fps}fps  `
        + `activity ${String(p.motion ? p.motion.activity : 0).padStart(6)}  burst ${String(p.motion ? p.motion.burst : 0).padStart(5)}x`
        + `${clip.moves ? '' : '  <-- DEAD'}`
        + `${clip.endFrame ? '  [' + clip.endFrame + ' sent]' : ''}`);
    } catch (e) {
      clip.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      clip.error = e.message.slice(0, 300);
      clip.cost = await settle(before, 8000);
      console.log(`\r  ${id.padEnd(26)} FAILED  ${clip.error}`);
    }
    clips = clips.filter((c) => key(c) !== id).concat(clip);
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
