#!/usr/bin/env node
// Ambience, one-shots and music, from ElevenLabs.
//
//   node tools/sound.mjs --dry
//   node tools/sound.mjs
//   node tools/sound.mjs --only dock-bed --force
//
// Three kinds of sound, and they are three kinds because they are used
// differently, not because they came from different endpoints:
//
//   BEDS      one per room, looping under everything, always playing.
//   ONE-SHOTS fired at random intervals on top of the bed. A bed alone is
//             wallpaper; what makes a place feel inhabited is that something
//             happens in it occasionally and you cannot predict when.
//   MUSIC     one theme, looping, quiet, and the first thing a player turns
//             off — so it is on its own channel with its own volume.
//
// A BED HAS TO LOOP SEAMLESSLY, and nothing generated does. The same problem
// the backdrop video had, and it is fixed the same way but at build time
// rather than at play time, because audio can be re-cut offline and video
// could not: the clip's tail is crossfaded onto its own head, and the piece
// that is left joins to itself. See loopify() for why that particular
// arrangement is the seamless one.

import { writeFile, readFile, mkdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const ONLY = opt('only', null);

const OUT = join(ROOT, 'assets/sound');
const MANIFEST = join(OUT, 'manifest.json');
const API = 'https://api.elevenlabs.io/v1';

// ffmpeg comes from the npm package rather than the system, which has none.
const FFMPEG = process.env.FFMPEG_PATH || '/opt/node22/lib/node_modules/ffmpeg-static/ffmpeg';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// Every sound says what it is for, not just what it sounds like. The prompts
// all end the same way for the same reason the sprite prompts do: a generator
// asked for "harbour at night" will cheerfully add seagulls, a fiddle and a
// man shouting, and two of those are already in the game.
const NOTHING_ELSE = 'Field recording, no music, no melody, no singing, no speech, no voices.';

const SOUNDS = {
  // --- beds ---------------------------------------------------------------
  'dock-bed': {
    kind: 'bed', room: 'dock', seconds: 22, bitrate: '56k',
    prompt: 'Calm night harbour ambience: small waves lapping steadily against wooden '
      + 'pilings and a stone quay, water moving under a jetty, a low distant sea swell, '
      + 'faint wind. Continuous and even throughout. ' + NOTHING_ELSE,
  },
  'galley-bed': {
    kind: 'bed', room: 'galley', seconds: 22, bitrate: '56k',
    prompt: 'Below decks on a wooden sailing ship at anchor: a wood fire burning steadily '
      + 'in an iron stove, gentle crackling, ship timbers creaking slowly, muffled water '
      + 'against the hull outside. Continuous and even throughout. ' + NOTHING_ELSE,
  },

  // --- one-shots ----------------------------------------------------------
  // Short, and deliberately not many. Four sounds heard rarely read as a place;
  // the same four heard often read as a loop.
  'dock-bell': {
    kind: 'shot', room: 'dock', seconds: 4, bitrate: '48k',
    prompt: 'A single distant harbour buoy bell, one slow clang across open water, '
      + 'with a long natural decay. ' + NOTHING_ELSE,
  },
  'dock-gull': {
    kind: 'shot', room: 'dock', seconds: 3, bitrate: '48k',
    prompt: 'One lone seagull crying twice, far away at night. ' + NOTHING_ELSE,
  },
  'dock-rope': {
    kind: 'shot', room: 'dock', seconds: 3, bitrate: '48k',
    prompt: 'A moored wooden boat shifting: one long rope creak and a soft knock of '
      + 'hull against a jetty. ' + NOTHING_ELSE,
  },
  'galley-pot': {
    kind: 'shot', room: 'galley', seconds: 3, bitrate: '48k',
    prompt: 'A single soft clatter of an iron pot lid settling on a stove. ' + NOTHING_ELSE,
  },
  'galley-creak': {
    kind: 'shot', room: 'galley', seconds: 4, bitrate: '48k',
    prompt: 'A wooden ship hull creaking and groaning once as it rolls, heard from '
      + 'below decks. ' + NOTHING_ELSE,
  },

  // --- music --------------------------------------------------------------
  // One theme for the whole game. It is asked for as sparse and slow because
  // it plays under dialogue for as long as somebody is stuck on a puzzle, and
  // anything with a hook becomes unbearable at minute nine.
  theme: {
    kind: 'music', seconds: 40, bitrate: '72k',
    prompt: 'A slow, wistful theme for a 1990s point-and-click pirate adventure game. '
      + 'Solo accordion with soft nylon-string guitar and a little upright bass, minor key, '
      + 'sea-shanty flavoured, unhurried and sparse, gentle and melancholy rather than '
      + 'jaunty. No drums, no percussion, no vocals. Loopable, even in mood throughout, '
      + 'with no build and no big ending.',
  },
};

// How much of the tail is folded back onto the head. Long enough that broadband
// noise averages out across the join, short enough that a one-off event near
// the end of the clip does not get ghosted over the beginning.
const CROSSFADE = 3;

// Which sound is being made, so loopify knows what to normalise it to.
let ID_IN_FLIGHT = null;

const hashOf = (id) => {
  const s = SOUNDS[id];
  return createHash('sha256')
    .update(JSON.stringify({ p: s.prompt, sec: s.seconds, br: s.bitrate, kind: s.kind, xf: CROSSFADE, lvl: LEVEL[s.kind] }))
    .digest('hex').slice(0, 16);
};

async function generate(id) {
  const s = SOUNDS[id];
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  // Music and sound effects are different endpoints with different shapes —
  // one takes milliseconds and the other seconds.
  const [url, body] = s.kind === 'music'
    ? [`${API}/music`, { prompt: s.prompt, music_length_ms: s.seconds * 1000 }]
    : [`${API}/sound-generation`, { text: s.prompt, duration_seconds: s.seconds }];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = (await res.text()).slice(0, 200);
    if (attempt === 4 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`${id}: ${res.status} ${text}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// Make a clip join to itself.
//
// Take the clip as head | middle | tail, where head and tail are CROSSFADE
// seconds long. The output is:
//
//     middle , crossfade(tail -> head)
//
// which starts at the original time CROSSFADE and ends one sample before it,
// having passed through the end of the clip on the way. So playing it round
// again continues from exactly where it stopped, and the only join is inside
// the crossfade, where two pieces of the same room tone are mixed.
//
// The obvious alternative — fade the whole clip in and out — is worse, not
// better: it turns a steady room tone into something that swells and dies
// every twenty seconds, which is far more noticeable than a join.
//
// Done sample by sample here rather than with ffmpeg's own `acrossfade`, which
// was tried first and leaves a step at the wrap about three times the size of
// the loudest ordinary sample-to-sample step in the clip — a faint tick, once
// a loop, forever. Whatever it does at its boundaries is not what this needs,
// and in PCM there is nothing to be wrong about: the last sample of the output
// is the one immediately before the first, by construction.
//
// Equal power rather than linear, because two pieces of uncorrelated noise
// mixed at half amplitude each are quieter than either, and a linear fade
// leaves an audible dip in the middle of the join.
async function decodePCM(path) {
  const raw = out => out;
  const { stdout } = await run(FFMPEG,
    ['-loglevel', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  return new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
}

const RATE = 44100;

// What each kind is normalised to, in 16-bit RMS.
//
// Generated clips come back at wildly different levels — the first pass had an
// ocean bed at RMS 164 and a fire bed at 1370, an eight-to-one difference
// between two sounds that are supposed to sit in the same place in the mix.
// Compensating for that with per-room playback volumes would be tuning the
// mixer to hide a fault in the assets, and it breaks the moment a clip is
// regenerated. So level is a property of the file.
//
// A constant gain, not a compressor and not loudnorm: it cannot alter the shape
// of the waveform, which means it cannot disturb the loop join computed below.
// Peaks are checked afterwards and the gain backed off if anything would clip,
// because a bed that distorts is worse than a bed that is quiet.
const LEVEL = { bed: 1100, music: 2600, shot: 3500 };
const PEAK_CEILING = 30000;

function normalise(pcm, target) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length);
  if (rms < 1) return { gain: 1, rms: 0 };
  let gain = target / rms;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  if (peak * gain > PEAK_CEILING) gain = PEAK_CEILING / peak;
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
  }
  return { gain: +gain.toFixed(2), rms: Math.round(rms * gain) };
}

async function loopify(rawBytes, out, bitrate) {
  const tmp = out + '.raw.mp3';
  await writeFile(tmp, rawBytes);
  const pcm = await decodePCM(tmp);
  const N = pcm.length, X = Math.round(CROSSFADE * RATE);
  if (N < X * 3) throw new Error(`too short to loop (${(N / RATE).toFixed(1)}s)`);
  const M = N - X;                       // output length
  const res = new Int16Array(M);
  res.set(pcm.subarray(X, N - X), 0);    // the middle, untouched
  const mid = N - 2 * X;
  for (let j = 0; j < X; j++) {
    const w = j / X;
    const a = Math.cos(w * Math.PI / 2);  // tail out
    const b = Math.sin(w * Math.PI / 2);  // head in
    res[mid + j] = Math.max(-32768, Math.min(32767,
      Math.round(pcm[N - X + j] * a + pcm[j] * b)));
  }
  const level = normalise(res, LEVEL[SOUNDS[ID_IN_FLIGHT].kind]);
  const pcmPath = out + '.loop.pcm';
  await writeFile(pcmPath, Buffer.from(res.buffer, res.byteOffset, res.length * 2));
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 's16le', '-ac', '1', '-ar', String(RATE),
    '-i', pcmPath, '-ac', '1', '-b:a', bitrate, out]);
  await unlink(tmp); await unlink(pcmPath);
  return { ...wrapStep(res), ...level };
}

// How big the step across the loop point is, against the ordinary steps inside
// the clip. Reported for every bed, because "it loops" is exactly the kind of
// claim that is easy to make and easy to be wrong about — the first version of
// this tool produced a clip whose wrap step was forty times its median, and
// nothing said so.
function wrapStep(pcm) {
  const n = pcm.length;
  const steps = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) steps[i - 1] = Math.abs(pcm[i] - pcm[i - 1]);
  const sorted = Array.from(steps).sort((a, b) => a - b);
  return {
    wrap: Math.abs(pcm[0] - pcm[n - 1]),
    median: sorted[n >> 1],
    p99: sorted[Math.floor(n * 0.99)],
  };
}

// A one-shot is not looped; it is trimmed of its silence and normalised, so a
// bell fires the instant it is asked for rather than a beat later.
async function trim(rawBytes, out, bitrate) {
  const tmp = out + '.raw.mp3';
  await writeFile(tmp, rawBytes);
  const trimmed = out + '.trim.mp3';
  await run(FFMPEG, [
    '-y', '-loglevel', 'error', '-i', tmp,
    '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,'
      + 'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse',
    '-ac', '1', '-ar', String(RATE), trimmed,
  ]);
  const pcm = Int16Array.from(await decodePCM(trimmed));
  const level = normalise(pcm, LEVEL.shot);
  const pcmPath = out + '.shot.pcm';
  await writeFile(pcmPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2));
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 's16le', '-ac', '1', '-ar', String(RATE),
    '-i', pcmPath, '-ac', '1', '-b:a', bitrate, out]);
  await unlink(tmp); await unlink(trimmed); await unlink(pcmPath);
  return level;
}

async function seconds(path) {
  const { stdout } = await run(FFMPEG, ['-i', path, '-hide_banner'], { encoding: 'utf8' })
    .catch((e) => ({ stdout: e.stderr || '' }));
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(stdout);
  return m ? +(+m[1] * 3600 + +m[2] * 60 + +m[3]).toFixed(2) : 0;
}

// --- main -------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
let manifest = { sounds: {} };
if (await exists(MANIFEST)) manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

const ids = Object.keys(SOUNDS).filter((id) => !ONLY || id === ONLY);
if (ONLY && !ids.length) throw new Error(`no sound called ${ONLY}`);

let made = 0, kept = 0, bytes = 0;
for (const id of ids) {
  const s = SOUNDS[id];
  const file = join(OUT, `${id}.mp3`);
  const want = hashOf(id);
  const have = manifest.sounds[id];
  if (!FORCE && have?.hash === want && (await exists(file))) {
    kept++; bytes += (await stat(file)).size;
    continue;
  }
  if (DRY) { console.log(`  would make ${id}  [${s.kind}, ${s.seconds}s]`); made++; continue; }
  process.stdout.write(`  ${id.padEnd(14)} ${s.kind.padEnd(6)} generating…`);
  const raw = await generate(id);
  let seam = null;
  ID_IN_FLIGHT = id;
  if (s.kind === 'shot') seam = await trim(raw, file, s.bitrate);
  else seam = await loopify(raw, file, s.bitrate);
  const size = (await stat(file)).size;
  const dur = await seconds(file);
  manifest.sounds[id] = { hash: want, kind: s.kind, room: s.room ?? null, dur, bytes: size, seam };
  bytes += size; made++;
  console.log(`\r  ${id.padEnd(14)} ${s.kind.padEnd(6)} ${dur}s  ${(size / 1024).toFixed(0)} KB`
    + `   rms ${seam?.rms} (gain x${seam?.gain})`
    + `${seam?.wrap !== undefined ? `, loop seam ${seam.wrap} vs a p99 step of ${seam.p99}` : ''}     `);
  if (seam?.wrap !== undefined && seam.wrap > seam.p99) {
    console.error(`  WARNING: ${id} has an audible step at the loop point`);
  }
}

if (!DRY) {
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n  ${made} made, ${kept} unchanged, ${(bytes / 1024 / 1024).toFixed(2)} MB total`);
  console.log(`  manifest -> assets/sound/manifest.json`);
} else {
  console.log(`\n  ${made} would be made, ${kept} unchanged`);
}
