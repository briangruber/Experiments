#!/usr/bin/env node
// Cast each character's voice once, and keep it.
//
//   node tools/voices.mjs                # any character without a plate
//   node tools/voices.mjs perpetua       # just one
//   node tools/voices.mjs --force        # recast
//   node tools/voices.mjs --dry          # print the prompts, call nothing
//
// A character sheet cannot carry a voice, and the obvious workaround —
// chaining the previous shot as a video reference — only carries one if that
// character happened to be speaking in it. That holds for exactly as long as
// your scene is two shots of two people. It breaks the moment the camera cuts
// away from someone, and it never worked at all for a character who enters
// later. Voice continuity cannot ride on coverage.
//
// So each character gets a plate: a few seconds of them alone, saying
// something that is not in any script, filmed for the sole purpose of having
// their voice on file. The audio is stripped off it and that mp3 becomes the
// character's voice from then on, passed as @AudioN into every shot they
// speak in, regardless of what the shot before it contained.
//
// The plates are company assets and are committed. Recasting is a decision,
// not a side effect of running a tool.
//
// Two economies worth knowing. The plate is shot at 480p because only the
// audio survives it — resolution does not change how the voice comes out, and
// 480p is less than half the price. And the plate is filmed in a deliberately
// dead room: no rain, no thunder, no music, nothing but the voice, because
// anything else on that track gets carried into every scene the sample is
// used in. A voice reference recorded over rain is a rain reference.

import { mkdir, writeFile, readFile, access, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upload, run, download } from './fal.mjs';
import SCENE from '../scenes/s01-testamento/scene.js';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFS = join(ROOT, 'refs');
const ENDPOINT = 'bytedance/seedance-2.5/reference-to-video';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const want = args.filter((a) => !a.startsWith('--'));

const exists = (p) => access(p).then(() => true, () => false);

// Six seconds: the sample has to clear the model's 1.8s floor for an audio
// reference with room to spare, and a longer line gives a truer print of the
// voice than a clipped greeting does.
const DURATION = '6';

function plate(key) {
  const c = SCENE.cast[key];
  return `A single continuous shot with no cuts. One character alone on screen, speaking directly to camera as if recording a screen test.

@Image1 is the character reference sheet for ${c.note} Match this character's face, plumage colour, costume and proportions exactly.

Medium close-up, head and shoulders, centred, facing the camera. Plain, quiet, softly lit neutral room with an out-of-focus dark background. The character looks into the lens and speaks calmly and clearly.

They speak the following line in Spanish, delivered ${c.direction}: "${c.line}"

They begin speaking almost immediately and the line is completely finished before the last second of the clip, which is held in silence.

${SCENE.style}

AUDIO: This is a voice recording session. The ONLY sound in the entire clip is this character's speaking voice, recorded clean and close as if on a studio microphone. Absolutely no background music, no score, no room ambience, no rain, no thunder, no wind, no footsteps, no props, no sound effects of any kind, and no other voices. Silence behind the voice. Nothing else may be audible at any point.`;
}

async function cast(key) {
  const mp4 = join(REFS, `voice-${key}.mp4`);
  const mp3 = join(REFS, `voice-${key}.mp3`);

  if (!FORCE && (await exists(mp3))) {
    console.log(`  ${key.padEnd(12)} already cast, skipping`);
    return mp3;
  }

  const prompt = plate(key);
  if (DRY) {
    console.log(`\n${'='.repeat(72)}\nvoice plate — ${SCENE.cast[key].name}\n${'='.repeat(72)}\n${prompt}\n`);
    return null;
  }

  const sheet = join(REFS, `${key}.png`);
  if (!(await exists(sheet))) throw new Error(`no character sheet for ${key} — run tools/refs.mjs first`);

  process.stdout.write(`  ${key.padEnd(12)} rolling… `);
  const started = Date.now();
  const res = await run(ENDPOINT, {
    prompt,
    image_urls: [await upload(sheet)],
    resolution: '480p',
    duration: DURATION,
    aspect_ratio: '16:9',
    generate_audio: true,
  });

  const url = res.video?.url || res.data?.video?.url;
  if (!url) throw new Error(`${key}: no video in response: ${JSON.stringify(res).slice(0, 300)}`);
  await download(url, mp4);

  // Strip the audio. Mono, because a voice reference has no business carrying
  // a stereo image, and it halves the file for no loss.
  await exec(FFMPEG, ['-y', '-v', 'error', '-i', mp4, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', mp3]);

  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp3]);
  const secs = Number(stdout.trim());
  // The model's own floor. A sample under it is rejected at submit time, and
  // finding that out during a shoot is a wasted generation.
  if (secs < 1.8) throw new Error(`${key}: sample is ${secs.toFixed(2)}s, under the 1.8s minimum for an audio reference`);

  await writeFile(
    join(REFS, `voice-${key}.json`),
    JSON.stringify({ character: key, line: SCENE.cast[key].line, direction: SCENE.cast[key].direction, seconds: secs, cast_at: new Date().toISOString(), prompt, source: url }, null, 2) + '\n',
  );

  console.log(`${secs.toFixed(1)}s  ${((await stat(mp3)).size / 1024).toFixed(0)} KB  in ${((Date.now() - started) / 1000).toFixed(0)}s  ->  refs/voice-${key}.mp3`);
  return mp3;
}

const keys = want.length ? want.filter((k) => SCENE.cast[k]) : Object.keys(SCENE.cast);
if (!keys.length) {
  console.error(`usage: node tools/voices.mjs [--force] [--dry] [${Object.keys(SCENE.cast).join('|')}]`);
  process.exit(1);
}

await mkdir(REFS, { recursive: true });
console.log(`\ncasting ${keys.length} voice(s) at 480p\n`);
for (const key of keys) await cast(key);
if (!DRY) console.log(`\nvoice plates in film/refs/`);
