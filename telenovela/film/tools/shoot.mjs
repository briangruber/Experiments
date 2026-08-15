#!/usr/bin/env node
// Shoot the scene, one shot at a time.
//
//   node tools/shoot.mjs                    # every shot that isn't in the can
//   node tools/shoot.mjs b-reverso          # just one
//   node tools/shoot.mjs --force            # reshoot regardless
//   node tools/shoot.mjs --res 480p         # block it cheap first
//   node tools/shoot.mjs --dry              # print the prompts, call nothing
//
// Shots are shot in order and a shot may reference the one before it, so this
// is deliberately serial. That is also the honest shape of the problem: you
// cannot fan out a scene whose continuity comes from the previous take.
//
// Every generation writes its prompt and its inputs next to the mp4. With no
// seed to re-roll, the prompt *is* the take — it is the only record of how a
// shot that worked was got, and the only thing you can edit to get it back.

import { mkdir, writeFile, readFile, access, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upload, run, download } from './fal.mjs';
import SCENE from '../scenes/s01-testamento/scene.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFS = join(ROOT, 'refs');
const SHOTS = join(ROOT, 'shots');
const ENDPOINT = 'bytedance/seedance-2.5/reference-to-video';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FORCE = flag('force');
const DRY = flag('dry');
const RES = opt('res', SCENE.resolution);
const only = args.filter((a) => !a.startsWith('--') && a !== RES);

const exists = (p) => access(p).then(() => true, () => false);

// fal's storage is content-addressed only by accident, so we keep our own
// ledger: a file that hasn't changed keeps its URL and isn't re-uploaded.
// Reference sheets go up on every shot, and re-pushing 2 MB of hen each time
// is pure latency.
const LEDGER = join(REFS, 'uploads.json');
const ledger = (await exists(LEDGER)) ? JSON.parse(await readFile(LEDGER, 'utf8')) : {};

async function put(path) {
  const digest = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 16);
  if (ledger[path]?.digest === digest) return ledger[path].url;
  const url = await upload(path);
  ledger[path] = { digest, url };
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
  return url;
}

async function shoot(shot) {
  const out = join(SHOTS, `${shot.id}.mp4`);
  if (!FORCE && (await exists(out))) {
    console.log(`  ${shot.slate} — already in the can, skipping`);
    return out;
  }

  const prompt = SCENE.buildPrompt(shot);

  if (DRY) {
    console.log(`\n${'='.repeat(72)}\n${shot.slate}  (${shot.duration}s, ${RES})\n${'='.repeat(72)}`);
    console.log(`images: ${shot.images.join(', ')}`);
    console.log(`voices: ${shot.audios.join(', ') || '—'}`);
    console.log(`videos: ${shot.videos.join(', ') || '—'}`);
    console.log(`\n${prompt}\n`);
    return null;
  }

  // Order matters and is the contract with buildPrompt: the Nth entry here is
  // @ImageN there. Uploading in the same loop the prompt was built from is
  // what keeps that true.
  process.stdout.write(`  ${shot.slate} — uploading references… `);
  const image_urls = [];
  for (const key of shot.images) image_urls.push(await put(join(REFS, `${key}.png`)));
  const audio_urls = [];
  for (const key of shot.audios) {
    const p = join(REFS, `voice-${key}.mp3`);
    if (!(await exists(p))) throw new Error(`${shot.id} needs ${key}'s voice — run tools/voices.mjs first`);
    audio_urls.push(await put(p));
  }
  const video_urls = [];
  for (const id of shot.videos) {
    const p = join(SHOTS, `${id}.mp4`);
    if (!(await exists(p))) throw new Error(`${shot.id} references ${id}, which has not been shot yet`);
    video_urls.push(await put(p));
  }
  console.log(`${image_urls.length} image(s), ${audio_urls.length} voice(s), ${video_urls.length} video(s)`);

  const input = {
    prompt,
    image_urls,
    ...(audio_urls.length ? { audio_urls } : {}),
    ...(video_urls.length ? { video_urls } : {}),
    resolution: RES,
    duration: shot.duration,
    aspect_ratio: SCENE.aspect_ratio,
    // On: we want the diegetic layer — voices, rain, thunder, paper. The
    // prompt forbids music, and it costs the same either way.
    generate_audio: true,
  };

  const started = Date.now();
  console.log(`  ${shot.slate} — rolling…`);
  const res = await run(ENDPOINT, input, { onLog: (m) => console.log(`      ${m}`) });

  const url = res.video?.url || res.data?.video?.url;
  if (!url) throw new Error(`no video in response: ${JSON.stringify(res).slice(0, 400)}`);
  await download(url, out);
  const bytes = (await stat(out)).size;

  // The sidecar is the provenance: prompt, references, settings and the seed
  // the model happened to use. The seed cannot be fed back in, but knowing
  // two takes differed is worth the line.
  await writeFile(
    join(SHOTS, `${shot.id}.json`),
    JSON.stringify(
      { id: shot.id, slate: shot.slate, shot_at: new Date().toISOString(), input, seed: res.seed ?? res.data?.seed ?? null, source: url },
      null, 2,
    ) + '\n',
  );

  console.log(`  ${shot.slate} — printed  ${(bytes / 1e6).toFixed(1)} MB  in ${((Date.now() - started) / 1000).toFixed(0)}s  ->  shots/${shot.id}.mp4\n`);
  return out;
}

const list = only.length ? SCENE.shots.filter((s) => only.includes(s.id)) : SCENE.shots;
if (!list.length) {
  console.error(`usage: node tools/shoot.mjs [--force] [--dry] [--res 480p|720p] [${SCENE.shots.map((s) => s.id).join('|')}]`);
  process.exit(1);
}

await mkdir(SHOTS, { recursive: true });
console.log(`\n${SCENE.title} — ${list.length} shot(s) at ${RES}\n`);
for (const shot of list) await shoot(shot);
if (!DRY) console.log(`shots in film/shots/`);
