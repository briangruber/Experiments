#!/usr/bin/env node
// Generate the backdrop as a still, then animate it into a seamless loop.
//
//   node tools/scene.mjs still --dry
//   node tools/scene.mjs still            # FLUX 2 PRO, 16:9
//   node tools/scene.mjs loop             # the still -> a looping video
//
// This replaces the blockout-and-repaint route, and the reason is worth
// writing down. That route bought a geometric guarantee: the floor line could
// not move, so the walk polygons never needed re-authoring. It paid for the
// guarantee by handing the model a flat vector image to constrain itself to,
// and a constrained good model loses to an unconstrained better one. The
// dependency simply runs the other way: generate freely, then annotate what
// came back with the in-game editor. That is minutes per room, not hours, and
// the pictures are in a different class.
//
// The loop is the second half of the idea. Feeding the same frame as BOTH the
// first and last frame of a first-last-frame video model, with a prompt that
// asks only for ambient motion and forbids camera movement, returns a video
// whose end matches its beginning — so it plays forever without a seam. Water,
// clouds, a lantern flame and a swaying sign all move, and none of it is
// procedural code that has to be written, tuned and debugged per element.

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch } from './harness.mjs';
import { falRun, fetchBuf } from './fal.mjs';

// No usable image encoder in this toolchain — the bundled ffmpeg is a
// webm-only build — so the browser does the re-encode.
async function webCopy(pngBuf, quality = 0.86) {
  const browser = await launch();
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(async ([uri, q]) => {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri;
    });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', q);
  }, ['data:image/png;base64,' + pngBuf.toString('base64'), quality]);
  await browser.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const STILL_MODEL = opt('model', 'fal-ai/flux-2-pro');
const LOOP_MODEL = opt('video-model', 'fal-ai/wan-flf2v');
const SEED = opt('seed', null);

const ASSETS = join(ROOT, 'assets');
const STILL = join(ASSETS, 'scene.png');
// The still is the master the loop is generated from; the jpg is the copy that
// ships. A 3.7 MB PNG fallback has no business in a published page.
const STILL_WEB = join(ASSETS, 'scene.jpg');
const LOOP = join(ASSETS, 'scene.mp4');
const LEDGER = join(ASSETS, 'provenance.json');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// The prompt has to compose for a game, not for a picture. Three requirements
// a purely pictorial prompt will not meet on its own:
//
//   a clear walking band   the lower third must be unobstructed floor running
//                          the full width, or the character has nowhere to go
//   separated objects      props with space between them, because each one
//                          becomes a hotspot and overlapping hotspots fight
//   animatable elements    water, cloud, flame, smoke, a hanging sign — the
//                          video pass can only move what is already there
//
// And one prohibition: no lettering. Every model so far has returned "Jeavern",
// "TÉRA" and "TVL9RN" for the same sign, so any text a player must read is
// drawn by the engine over the art.
const STILL_PROMPT = [
  'A hand-painted background for a 1990s LucasArts point-and-click adventure game.',
  'A moonlit wooden pier on a Caribbean pirate island at night.',
  '',
  'COMPOSITION, strictly: the lower third of the frame is a wide wooden dock running',
  'unbroken from the left edge to the right edge, flat, empty and clear — a walkable',
  'boardwalk with nothing blocking it. Everything else sits above or behind that band.',
  'On the right stands a crooked timber-framed tavern with a shingled roof, a stone',
  'chimney with smoke curling from it, and two windows glowing warm amber; an iron',
  'lantern with a lit flame hangs from a bracket beside its door, and a blank wooden',
  'sign board hangs from a wrought-iron arm. Ranged along the dock with clear space',
  'between them: an oak grog barrel with an iron spigot, a stack of cargo crates, and',
  'a coil of dark tarred rope with a boat hook. Beyond the dock, calm open water with',
  'the moon low and its reflection breaking across the surface, and a two-masted',
  'sailing ship moored in the middle distance with a pennant at its masthead.',
  '',
  'STYLE: lush painted gouache and oil on board, visible directional brushwork, loaded',
  'impasto in the lights, thin scumbled darks, broken colour, soft lost-and-found edges.',
  'Cool blue-violet moonlight against warm amber lamplight. Deep transparent shadows',
  'that still hold colour. Atmospheric depth, the far water hazier than the foreground.',
  'Cinematic, inviting, slightly exaggerated storybook proportions.',
  '',
  'NEGATIVE: no people, no characters, no animals, no text, no lettering, no writing on',
  'the sign, no watermark, no UI, no border, no letterboxing, no split panels.',
].join(' ');

// What the video pass is allowed to do. The two prohibitions matter more than
// the list of motions: a camera move cannot loop, and anything that enters or
// leaves frame cannot loop either.
const LOOP_PROMPT = [
  'A seamlessly looping ambient shot of this painted harbour at night. Subtle, slow,',
  'continuous motion only: water rippling and the moon reflection shimmering across it,',
  'clouds drifting slowly across the sky, the lantern flame flickering, warm light',
  'wavering in the windows, smoke curling from the chimney, the hanging sign swaying',
  'very slightly, the moored ship rocking gently and its pennant fluttering.',
  'The camera is completely locked off — no pan, no zoom, no dolly, no parallax,',
  'no camera movement of any kind. Nothing enters or leaves the frame.',
  'No people, no characters, no text appearing. The painting itself does not change:',
  'only the water, air, light and cloth move.',
].join(' ');

async function ledger(entry) {
  let log = [];
  if (await exists(LEDGER)) log = JSON.parse(await readFile(LEDGER, 'utf8'));
  log.push({ ...entry, at: new Date().toISOString() });
  await writeFile(LEDGER, JSON.stringify(log, null, 2) + '\n');
}

async function still() {
  if ((await exists(STILL)) && !FORCE) { console.error('assets/scene.png exists — pass --force to redraw'); process.exit(1); }
  if (DRY) { console.log(`would POST ${STILL_MODEL}\n\n${STILL_PROMPT}`); return; }
  const input = {
    prompt: STILL_PROMPT,
    image_size: { width: 1920, height: 1080 },
    num_images: 1,
    output_format: 'png',
    enable_safety_checker: false,
  };
  if (SEED) input.seed = +SEED;
  const out = await falRun(STILL_MODEL, input, 'still');
  const img = out.images?.[0];
  if (!img?.url) throw new Error('no image: ' + JSON.stringify(out).slice(0, 400));
  const buf = await fetchBuf(img.url);
  await mkdir(ASSETS, { recursive: true });
  await writeFile(STILL, buf);
  await ledger({ kind: 'scene-still', file: 'assets/scene.png', model: STILL_MODEL, seed: out.seed ?? null, size: `${img.width}x${img.height}`, prompt: STILL_PROMPT });
  console.log(`still -> assets/scene.png  ${img.width}x${img.height}  ${(buf.length / 1024).toFixed(0)} KB`);
  const jpg = await webCopy(buf);
  await writeFile(STILL_WEB, jpg);
  console.log(`web copy -> assets/scene.jpg  ${(jpg.length / 1024).toFixed(0)} KB`);
}

async function loop() {
  if (!(await exists(STILL))) { console.error('no still yet — run: node tools/scene.mjs still'); process.exit(1); }
  if ((await exists(LOOP)) && !FORCE) { console.error('assets/scene.mp4 exists — pass --force to redraw'); process.exit(1); }
  if (DRY) { console.log(`would POST ${LOOP_MODEL} with the still as BOTH first and last frame\n\n${LOOP_PROMPT}`); return; }
  const uri = 'data:image/png;base64,' + (await readFile(STILL)).toString('base64');
  const out = await falRun(LOOP_MODEL, {
    prompt: LOOP_PROMPT,
    // The same frame at both ends. That is the whole trick: the model has to
    // arrive back where it started, so the last frame cuts to the first
    // without a seam.
    start_image_url: uri,
    end_image_url: uri,
    resolution: '720p',
    num_frames: 81,
    frames_per_second: 16,
    aspect_ratio: '16:9',
  }, 'loop');
  const url = out.video?.url || out.videos?.[0]?.url;
  if (!url) throw new Error('no video: ' + JSON.stringify(out).slice(0, 400));
  const buf = await fetchBuf(url);
  await writeFile(LOOP, buf);
  await ledger({ kind: 'scene-loop', file: 'assets/scene.mp4', model: LOOP_MODEL, from: 'assets/scene.png', frames: 81, fps: 16, prompt: LOOP_PROMPT });
  console.log(`loop -> assets/scene.mp4  ${(buf.length / 1024 / 1024).toFixed(2)} MB  (81f @ 16fps ≈ 5.1s)`);
}

if (cmd === 'still') await still();
else if (cmd === 'loop') await loop();
else { console.error('usage: node tools/scene.mjs <still|loop> [--dry] [--force] [--seed N]'); process.exit(1); }
