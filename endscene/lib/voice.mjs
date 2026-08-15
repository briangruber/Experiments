// Casting a voice, once, and keeping it.
//
// A character sheet cannot hold a voice. The obvious workaround is to chain the
// previous shot as a video reference and let the voice come across with
// everything else — and it does, but only if that character happened to be
// speaking in the previous shot. That holds for exactly as long as your scene
// is two shots of two people. It breaks the moment the camera cuts away from
// someone, and it never worked at all for a character who enters later. Voice
// continuity cannot ride on coverage.
//
// So voices are cast the way faces are: once, deliberately, into a committed
// asset. Each character is filmed alone saying a line that appears in no
// script — so a plate can never be mistaken for coverage — and the stripped
// audio is what gets passed as @AudioN from then on, whatever the shot before
// it contained.

import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { upload, run, download } from './fal.mjs';
import { nextTake, writeJSON, hash } from './store.mjs';

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// Six seconds clears the model's 1.8s floor for an audio reference with room
// to spare, and a longer line gives a truer print of the voice than a clipped
// greeting does.
export const PLATE_SECONDS = '6';

// The plate is shot at 480p because only the audio survives it. Resolution does
// not change how a voice comes out, and it is less than half the price.
export const PLATE_RESOLUTION = '480p';

export async function cast({
  dir, sheet, prompt, model, onLog, duration = PLATE_SECONDS, resolution = PLATE_RESOLUTION, meta = {},
}) {
  await mkdir(join(dir, 'takes'), { recursive: true });
  const take = await nextTake(dir);

  const input = {
    prompt,
    image_urls: [await upload(sheet)],
    resolution,
    duration,
    aspect_ratio: '16:9',
    generate_audio: true,
  };

  const res = await run(model, input, { onLog });
  const url = res.video?.url || res.data?.video?.url;
  if (!url) throw new Error(`no video in response: ${JSON.stringify(res).slice(0, 300)}`);

  const mp4 = join(dir, 'takes', `${take}.mp4`);
  const mp3 = join(dir, 'takes', `${take}.mp3`);
  await download(url, mp4);

  // Mono: a voice reference has no business carrying a stereo image, and it
  // halves the file for no loss.
  await exec(FFMPEG, ['-y', '-v', 'error', '-i', mp4, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', mp3]);

  const seconds = await durationOf(mp3);
  // The model's own floor for an audio reference. Discovering this during a
  // shoot costs a whole generation, so it is checked at the source.
  if (seconds < 1.8) {
    throw new Error(`voice sample is ${seconds.toFixed(2)}s, under the 1.8s minimum for an audio reference`);
  }

  await writeJSON(join(dir, 'takes', `${take}.json`), {
    take,
    kind: 'voice',
    model,
    prompt,
    input: { ...input, image_urls: ['<uploaded>'] },
    seconds,
    source: url,
    made_at: new Date().toISOString(),
    inputsHash: hash({ prompt, model, duration, resolution, ...meta }),
    ...meta,
  });

  return { take, mp4, mp3, seconds };
}

export async function durationOf(path) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path,
  ]);
  return Number(stdout.trim());
}
