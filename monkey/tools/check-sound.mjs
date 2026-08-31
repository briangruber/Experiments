#!/usr/bin/env node
// The sound assets, as files.
//
//   node tools/check-sound.mjs
//
// Playback cannot be verified here — headless Chromium has no audio device, and
// autoplay is refused anyway — so this checks the things that can go wrong in
// the file and are inaudible in a code review: a bed that does not join to
// itself, a one-shot that starts with a second of silence, a clip that is
// silent all the way through, and a manifest that has drifted from what is on
// disk. All four have a shape you can measure.

import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || '/opt/node22/lib/node_modules/ffmpeg-static/ffmpeg';
const DIR = join(ROOT, 'assets/sound');
const RATE = 44100;

const fails = [];
const check = (name, ok, note = '') => {
  if (!ok) fails.push(name);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`);
};

let manifest;
try {
  manifest = JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8'));
} catch {
  console.log('  no sound assets — run tools/sound.mjs');
  process.exit(0);
}

const ids = Object.keys(manifest.sounds);
const files = (await readdir(DIR)).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4));
check('every clip in the manifest is on disk', ids.every((id) => files.includes(id)),
  `${ids.length} clips`);
check('every file on disk is in the manifest', files.every((f) => ids.includes(f)));

// A room with no bed is a silent room, and the game does not otherwise say so.
for (const room of ['dock', 'galley']) {
  const beds = ids.filter((id) => manifest.sounds[id].kind === 'bed' && manifest.sounds[id].room === room);
  const shots = ids.filter((id) => manifest.sounds[id].kind === 'shot' && manifest.sounds[id].room === room);
  check(`${room} has a bed and something to happen in it`, beds.length === 1 && shots.length >= 2,
    `${beds.length} bed, ${shots.length} one-shots`);
}
check('there is a theme', ids.some((id) => manifest.sounds[id].kind === 'music'));

async function pcm(id) {
  const { stdout } = await run(FFMPEG,
    ['-loglevel', 'error', '-i', join(DIR, `${id}.mp3`), '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  return new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
}

const measured = {};
for (const id of ids) {
  const d = await pcm(id);
  const n = d.length;
  let peak = 0, sum = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; }
  const rms = Math.sqrt(sum / n);
  const steps = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) steps[i - 1] = Math.abs(d[i] - d[i - 1]);
  const sorted = Array.from(steps).sort((a, b) => a - b);
  let lead = 0; while (lead < n && Math.abs(d[lead]) < 64) lead++;
  measured[id] = {
    kind: manifest.sounds[id].kind, seconds: +(n / RATE).toFixed(2), peak, rms: Math.round(rms),
    wrap: Math.abs(d[0] - d[n - 1]), p99: sorted[Math.floor(n * 0.99)],
    leadSilence: +(lead / RATE).toFixed(2),
  };
}

// A clip that generated to near-silence is the failure that looks like success:
// the file is there, the manifest is right, the bundle grows, and the room is
// as quiet as it was before.
check('nothing generated to silence', ids.every((id) => measured[id].rms > 60),
  ids.map((id) => `${id} ${measured[id].rms}`).join(', '));

// The beds sit in the same place in the mix, so they have to be at the same
// level. The first pass had an ocean bed at RMS 164 and a fire bed at 1370 —
// both "fine" by every other check here, and one of them inaudible under the
// other. Levels are normalised in the tool; this is the assertion that says so.
const beds = ids.filter((i) => manifest.sounds[i].kind === 'bed');
const loudest = Math.max(...beds.map((i) => measured[i].rms));
const quietest = Math.min(...beds.map((i) => measured[i].rms));
check('the room tones are at the same level', loudest <= quietest * 1.6,
  beds.map((i) => `${i} ${measured[i].rms}`).join(', '));

// The one that matters. A bed is played on loop forever, so the step across the
// join has to be no worse than the steps the clip already contains — otherwise
// it is a tick, once a loop, for as long as the player is in the room.
for (const id of ids.filter((i) => manifest.sounds[i].kind !== 'shot')) {
  const m = measured[id];
  check(`${id} joins to itself`, m.wrap <= m.p99,
    `step at the loop point ${m.wrap} against a 99th-percentile step of ${m.p99}`);
}

// A one-shot fires the moment it is asked for. Half a second of silence at the
// head of a bell means the bell rings half a second after whatever rang it.
for (const id of ids.filter((i) => manifest.sounds[i].kind === 'shot')) {
  check(`${id} starts immediately`, measured[id].leadSilence < 0.12,
    `${measured[id].leadSilence}s of silence at the head`);
}

const bytes = (await Promise.all(ids.map(async (id) => (await stat(join(DIR, `${id}.mp3`))).size)))
  .reduce((a, b) => a + b, 0);
check('small enough to inline in a published page', bytes < 1.5e6,
  `${(bytes / 1024 / 1024).toFixed(2)} MB (~${(bytes * 4 / 3 / 1024 / 1024).toFixed(2)} MB base64)`);

console.log('');
for (const id of ids) {
  const m = measured[id];
  console.log(`  ${id.padEnd(14)} ${m.kind.padEnd(6)} ${String(m.seconds).padStart(6)}s  rms ${String(m.rms).padStart(5)}`
    + `  peak ${String(m.peak).padStart(5)}${m.kind === 'shot' ? `  head ${m.leadSilence}s` : `  wrap ${m.wrap}/${m.p99}`}`);
}

console.log('');
if (fails.length) { console.error(`FAILED: ${fails.join(', ')}`); process.exit(1); }
console.log('sound assets ok (playback itself is unverifiable here — no audio device, and autoplay is refused)');
