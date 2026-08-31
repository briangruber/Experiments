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
const LOOP_MODEL = opt('video-model', 'minimax/h3/image-to-video');
// Feeding the same still as both first and last frame seemed clever and was
// not: it gave the model nothing to interpolate and returned 81 frames of a
// held image — valid H.264, right length, 0.8% inter-frame size, no motion.
// The seam is now handled at playback with a crossfade instead, so the video
// only has to move.
const END_FRAME = args.includes('--end-frame');
const SEED = opt('seed', null);
// 768P native comes back around 12 MB for six seconds, which base64s past the
// artifact's ceiling. The backdrop is a soft painting stretched to fill the
// frame, so it survives a lower native resolution better than the page
// survives being unloadable.

// A room's assets live under its own name, except the first one, which was
// written before there was a second and keeps its bare paths so nothing that
// already points at them has to move.
const ROOM = opt('room', 'dock');
const ASSETS = join(ROOT, 'assets');
const DIR = ROOM === 'dock' ? ASSETS : join(ASSETS, ROOM);
const STILL = join(DIR, 'scene.png');
// The still is the master the loop is generated from; the jpg is the copy that
// ships. A 3.7 MB PNG fallback has no business in a published page.
const STILL_WEB = join(DIR, 'scene.jpg');
const LOOP = join(DIR, 'scene.mp4');
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
// One entry per room. The composition rules above are not decoration — they
// are what makes a picture into a place a character can be in — so each room's
// prompt states its own walking band, its own separated props and its own
// animatable elements, and repeats the same style and the same prohibition on
// lettering so two rooms generated hours apart belong to one game.
const ROOMS = {
  galley: {
    still: [
      'A hand-painted background for a 1990s LucasArts point-and-click adventure game.',
      'The cramped galley below decks of a wooden pirate ship, lit by lamplight at night.',
      '',
      'COMPOSITION, strictly: the lower third of the frame is a wide planked deck floor',
      'running unbroken from the left edge to the right edge, flat, empty and clear — a',
      'walkable strip with nothing blocking it. Everything else sits above or behind it.',
      'On the left a black cast-iron cooking range with a fat belly and a stovepipe, a',
      'big pot on top with steam rising, its firebox door glowing orange, and a pair of',
      'leather bellows leaning against it. In the middle of the back wall a heavy',
      'scrubbed wooden mess table with a tin pepper pot standing on it, and above it a',
      'small brass ship\'s bell hanging from a bracket. On the right, curving ship\'s ribs',
      'and planking, a hanging oil lamp on a hook swinging slightly, a stack of barrels,',
      'and a low doorway with a companion ladder going up into darkness. High on the',
      'right, a heavy timber roof beam runs across under the deckhead with clear space',
      'above the barrels. Ranged with clear space between them so nothing overlaps.',
      '',
      'STYLE: lush painted gouache and oil on board, visible directional brushwork, loaded',
      'impasto in the lights, thin scumbled darks, broken colour, soft lost-and-found edges.',
      'Warm amber lamplight and firelight against deep blue-green shadow in the corners.',
      'Deep transparent shadows that still hold colour. Cramped, snug, smoky, cinematic,',
      'slightly exaggerated storybook proportions.',
      '',
      'NEGATIVE: no people, no characters, no animals, no cat, no text, no lettering, no',
      'writing, no watermark, no UI, no border, no letterboxing, no split panels.',
    ].join(' '),
    loop: [
      'Ambient living-painting shot of this ship\'s galley below decks. Continuous gentle',
      'motion: steam curls and rises from the pot, the firelight in the stove flickers and',
      'its orange glow pulses on the planking, the hanging oil lamp sways very slightly on',
      'its hook and its light shifts with it, and shadows breathe in the corners.',
      'The camera is completely locked off: no pan, no zoom, no dolly, no parallax, no',
      'camera movement of any kind, no shot change.',
      'Nothing enters or leaves the frame. No people, no characters, no animals, no text.',
      'The painting itself does not change — only steam, fire, light and shadow move.',
    ].join(' '),
  },
};

const STILL_PROMPT_DOCK = [
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
// the list of motions: a camera move cannot loop, and anything that entered or
// left frame could not either. Everything asked for is a thing that returns to
// where it started on its own.
const LOOP_PROMPT_DOCK = [
  'Ambient living-painting shot of this moonlit harbour. Continuous gentle motion:',
  'the sea swells and ripples with the moonlight glittering and breaking across its',
  'surface, clouds drift slowly across the night sky, the lantern flame flickers and',
  'its glow pulses on the timber, firelight wavers in the windows, smoke curls and',
  'rises from the chimney, the hanging sign sways slightly on its bracket, and the',
  'moored ship rocks gently with its pennants fluttering.',
  'The camera is completely locked off: no pan, no zoom, no dolly, no parallax, no',
  'camera movement of any kind, no shot change.',
  'Nothing enters or leaves the frame. No people, no characters, no boats arriving,',
  'no text. The painting itself does not change — only water, air, light and cloth move.',
].join(' ');

const STILL_PROMPT = ROOMS[ROOM]?.still ?? STILL_PROMPT_DOCK;
const LOOP_PROMPT = ROOMS[ROOM]?.loop ?? LOOP_PROMPT_DOCK;

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
  await mkdir(DIR, { recursive: true });
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
  const uri = 'data:image/jpeg;base64,' + (await readFile(STILL_WEB)).toString('base64');
  // Video models do not agree on what to call the picture you hand them, and a
  // wrong field name comes back as a validation error AFTER the queue has
  // taken the job. The first-last-frame family wants a start and an end and
  // speaks in lowercase resolutions; the image-to-video family wants one image
  // and shouts its resolutions.
  const firstLast = /first-last-frame/.test(LOOP_MODEL);
  const input = firstLast
    ? {
      prompt: LOOP_PROMPT,
      start_image_url: uri,
      end_image_url: uri,
      resolution: opt('resolution', '720p'),
    }
    : {
      prompt: LOOP_PROMPT,
      image_url: uri,
      duration: 6,
      resolution: opt('resolution', '480P'),
      prompt_expansion_mode: 'quality',
      enable_safety_checker: false,
      ...(END_FRAME ? { end_image_url: uri } : {}),
    };
  const out = await falRun(LOOP_MODEL, input, 'loop');
  const url = out.video?.url || out.videos?.[0]?.url;
  if (!url) throw new Error('no video: ' + JSON.stringify(out).slice(0, 400));
  const buf = await fetchBuf(url);
  await writeFile(LOOP, buf);
  await ledger({ kind: 'scene-loop', file: 'assets/scene.mp4', model: LOOP_MODEL, from: 'assets/scene.jpg', endFrame: END_FRAME, prompt: LOOP_PROMPT });
  console.log(`loop -> assets/scene.mp4  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  console.log('verify it actually moves: node tools/check-scene.mjs');
}

if (cmd === 'still') await still();
else if (cmd === 'loop') await loop();
else { console.error('usage: node tools/scene.mjs <still|loop> [--dry] [--force] [--seed N]'); process.exit(1); }
