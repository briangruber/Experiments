// Shooting a shot.
//
// Resolves the reference stack the prompt builder asked for into real files,
// uploads them in exactly the order the prompt refers to them, and rolls.
//
// Shots within a scene are shot in order and a shot may reference the one
// before it, so shooting is deliberately serial. That is not a limitation of
// the implementation, it is the honest shape of the problem: you cannot fan out
// a scene whose continuity comes from the previous take.

import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { upload, run, download } from './fal.mjs';
import { nextTake, writeJSON, readJSON, exists, hash, selectedTake, listTakes } from './store.mjs';
import { buildShot } from './prompt.mjs';

// fal's storage is content-addressed only by accident, so we keep a ledger: a
// file that has not changed keeps its URL and is not re-uploaded. Reference
// sheets go up on every shot, and re-pushing two megabytes of costume each
// time is pure latency.
export async function uploader(cacheDir) {
  const path = join(cacheDir, 'uploads.json');
  const ledger = (await exists(path)) ? await readJSON(path, {}) : {};
  return async function put(file) {
    const digest = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16);
    if (ledger[file]?.digest === digest) return ledger[file].url;
    const url = await upload(file);
    ledger[file] = { digest, url };
    await writeJSON(path, ledger);
    return url;
  };
}

// Turns the abstract reference descriptors from buildShot into paths on disk.
// Kept separate so the UI can show a shot's reference stack — and cost — before
// anything is generated.
export function resolveRefs({ project, episode, scene, refs }) {
  const P = project.paths;
  const files = { images: [], audios: [], videos: [] };

  for (const r of refs.images) {
    files.images.push(
      r.kind === 'sheet' ? P.sheet(r.character, r.look) : P.plate(r.location, r.state),
    );
  }
  for (const r of refs.audios) files.audios.push(P.voiceAudio(r.character));
  for (const r of refs.videos) {
    files.videos.push(join(P.shot(episode, scene, r.shot), 'selected.mp4'));
  }
  return files;
}

export async function shootShot({
  project, episode, scene, shot, cast, location, model,
  resolution, put, onLog,
}) {
  const built = buildShot({ show: project.show, scene, shot, cast, location });
  const files = resolveRefs({ project, episode, scene: scene.id, refs: built });

  for (const f of [...files.images, ...files.audios, ...files.videos]) {
    if (!(await exists(f))) {
      throw new Error(`${shot.id}: missing reference ${f.replace(project.root + '/', '')}`);
    }
  }

  const dir = project.paths.shot(episode, scene.id, shot.id);
  await mkdir(join(dir, 'takes'), { recursive: true });
  const take = await nextTake(dir);

  const image_urls = [];
  for (const f of files.images) image_urls.push(await put(f));
  const audio_urls = [];
  for (const f of files.audios) audio_urls.push(await put(f));
  const video_urls = [];
  for (const f of files.videos) video_urls.push(await put(f));

  const input = {
    prompt: built.prompt,
    image_urls,
    ...(audio_urls.length ? { audio_urls } : {}),
    ...(video_urls.length ? { video_urls } : {}),
    resolution: resolution || project.show.resolution || '720p',
    duration: String(shot.duration),
    aspect_ratio: project.show.aspect_ratio || '16:9',
    // On: we want the diegetic layer — voices, weather, the sound of objects.
    // The prompt forbids music, and it costs the same either way.
    generate_audio: true,
  };

  const started = Date.now();
  const res = await run(model, input, { onLog });
  const url = res.video?.url || res.data?.video?.url;
  if (!url) throw new Error(`no video in response: ${JSON.stringify(res).slice(0, 400)}`);

  const file = join(dir, 'takes', `${take}.mp4`);
  await download(url, file);

  // With no seed, the prompt *is* the take — the only record of how a shot
  // that worked was got, and the only thing you can edit to try for it again.
  await writeJSON(join(dir, 'takes', `${take}.json`), {
    take,
    shot: shot.id,
    slate: shot.slate,
    shot_at: new Date().toISOString(),
    seconds_taken: Math.round((Date.now() - started) / 1000),
    model,
    input,
    references: {
      images: files.images.map((f) => f.replace(project.root + '/', '')),
      audios: files.audios.map((f) => f.replace(project.root + '/', '')),
      videos: files.videos.map((f) => f.replace(project.root + '/', '')),
    },
    seed: res.seed ?? res.data?.seed ?? null,
    source: url,
    inputsHash: hash({ prompt: built.prompt, refs: files, resolution: input.resolution, duration: input.duration }),
  });

  return { take, file, prompt: built.prompt };
}

// The selected take, published under a stable name. Chaining refers to
// `selected.mp4` rather than a take number so that changing your mind about
// shot one does not require rewriting shot two.
export async function publishSelected(dir) {
  const take = await selectedTake(dir);
  if (!take) return null;
  const takes = await listTakes(dir);
  const chosen = takes.find((t) => t.take === take && t.file);
  if (!chosen) return null;
  const target = join(dir, 'selected.mp4');
  await writeJSON(join(dir, 'selected.json'), { take, file: chosen.file });
  const { copyFile } = await import('node:fs/promises');
  await copyFile(chosen.file, target);
  return target;
}
