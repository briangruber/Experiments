// Generates every mesh in DEADLIGHT from Tripo.
//
//   TRIPO_API_KEY=... node tools/generate.mjs [--only creature,doll] [--jobs 6]
//
// Raw output lands in assets/raw/ (large — gitignored); `optimize.mjs` turns
// it into the assets/*.glb the game actually loads. Progress is recorded in
// assets/generation.json as it goes, so an interrupted run resumes instead of
// paying for the same meshes twice.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_MESHES, CREATURE } from './assets.manifest.mjs';
import { download, modelUrls, pollTask, retarget, rig, textToModel } from './tripo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'assets', 'raw');
const STATE = path.join(ROOT, 'assets', 'generation.json');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const only = flag('only') ? new Set(flag('only').split(',')) : null;
const JOBS = Number(flag('jobs', 6));
/** Re-run selected assets from scratch, ignoring (and paying for) the cache. */
const FORCE = args.includes('--force');

// ---------------------------------------------------------------- state

async function loadState() {
  if (!existsSync(STATE)) return { entries: {} };
  return JSON.parse(await readFile(STATE, 'utf8'));
}

let state;
let stateDirty = false;
async function flushState() {
  if (!stateDirty) return;
  stateDirty = false;
  state.updated = new Date().toISOString();
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

/** Record one finished artefact. `id` is a step key like "creature:rig". */
function record(id, patch) {
  state.entries[id] = { ...(state.entries[id] || {}), ...patch };
  stateDirty = true;
}

const log = (key, msg) => console.log(`${key.padEnd(16)} ${msg}`);

/**
 * Run a Tripo step with resume support: if the state file already has a
 * successful task id for this step, that task is polled instead of a new
 * (billable) one being submitted.
 */
async function step(id, submit) {
  const prior = state.entries[id];
  let taskId = prior?.taskId;
  if (taskId && prior?.done) return prior;

  if (!taskId) {
    taskId = await submit();
    record(id, { taskId, done: false });
    await flushState();
  }
  // Report on quarter *crossings*, not exact multiples — Tripo reports
  // progress in steps of three or four, so `pct % 25` almost never lands and
  // a twelve-minute job looks like it hung at "queued 0%".
  let lastQuarter = -1;
  const data = await pollTask(taskId, {
    onProgress: (status, pct) => {
      const quarter = Math.floor(pct / 25);
      if (quarter !== lastQuarter || status !== 'running') {
        lastQuarter = quarter;
        log(id, `${status} ${pct}%`);
      }
    },
  });
  record(id, { taskId, credits: data.credits_consumed, done: true });
  await flushState();
  return { taskId, output: data.output };
}

/** Poll a completed step again to get fresh signed URLs (they expire). */
async function outputOf(id) {
  const { taskId } = state.entries[id];
  return (await pollTask(taskId)).output;
}

async function fetchTo(id, file) {
  const dest = path.join(RAW, file);
  if (existsSync(dest) && state.entries[id]?.file === file) return dest;
  const urls = modelUrls(await outputOf(id));
  if (!urls.length) throw new Error(`${id}: task produced no model url`);
  await download(urls[0].url, dest);
  record(id, { file });
  await flushState();
  log(id, `saved raw/${file}`);
  return dest;
}

// ---------------------------------------------------------------- jobs

/** A plain textured prop or mannequin. */
async function meshJob(entry) {
  const id = entry.key;
  await step(id, () => textToModel(entry.prompt));
  await fetchTo(id, `${id}.glb`);
  record(id, { scale: entry.scale, tag: entry.tag ?? null, prompt: entry.prompt });
}

/**
 * The creature: generate → auto-rig → one retarget per animation.
 *
 * Each retarget is exported with geometry, so every clip arrives as a
 * self-contained skinned GLB. That is more bytes over the wire than asking
 * for all the clips at once, but the rig is identical across them, which
 * lets `optimize.mjs` merge the clips onto one mesh by node name — and it
 * degrades well: one failed animation costs one animation, not the creature.
 */
async function creatureJob() {
  const { key, prompt, animations, rigModel, faceLimit } = CREATURE;

  await step(key, () => textToModel(prompt, { faceLimit: faceLimit ?? 20000 }));
  await fetchTo(key, `${key}.glb`);
  log(key, 'mesh done, rigging…');

  const rigId = `${key}:rig`;
  await step(rigId, () => rig(state.entries[key].taskId, { model: rigModel }));
  await fetchTo(rigId, `${key}_rigged.glb`);
  log(key, 'rig done, retargeting…');

  const rigTask = state.entries[rigId].taskId;
  const clips = [];
  for (const [name, preset] of Object.entries(animations)) {
    const id = `${key}:anim:${name}`;
    try {
      await step(id, () => retarget(rigTask, preset));
      await fetchTo(id, `${key}_${name}.glb`);
      clips.push(name);
    } catch (err) {
      // A missing clip is survivable — the game falls back to `idle`.
      console.warn(`  ! ${name} (${preset}) failed: ${err.message}`);
    }
  }
  record(key, { scale: CREATURE.scale, clips, prompt });
  log(key, `clips: ${clips.join(', ') || 'none'}`);
}

// ---------------------------------------------------------------- driver

/** Run `tasks` with at most `limit` in flight; never rejects, collects errors. */
async function pool(tasks, limit) {
  const failures = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const { name, run } = tasks[i];
      try {
        await run();
        console.log(`✓ ${name}`);
      } catch (err) {
        failures.push({ name, error: err.message });
        console.error(`✗ ${name}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
  return failures;
}

async function main() {
  await mkdir(RAW, { recursive: true });
  state = await loadState();

  const wanted = (key) => !only || only.has(key);

  if (FORCE) {
    // Drop cached tasks for everything being regenerated — including the
    // creature's rig and per-animation sub-steps, which are keyed by prefix.
    for (const id of Object.keys(state.entries)) {
      if (wanted(id.split(':')[0])) delete state.entries[id];
    }
    stateDirty = true;
    await flushState();
  }
  const jobs = [
    ...ALL_MESHES.filter((m) => wanted(m.key)).map((m) => ({
      name: m.key,
      run: () => meshJob(m),
    })),
    ...(wanted(CREATURE.key) ? [{ name: CREATURE.key, run: creatureJob }] : []),
  ];

  console.log(`generating ${jobs.length} asset(s), ${JOBS} at a time\n`);
  const started = Date.now();
  // The creature is a three-stage chain and by far the longest job, so it goes
  // first and runs alongside the props rather than after them.
  jobs.reverse();
  const failures = await pool(jobs, JOBS);
  await flushState();

  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  const credits = Object.values(state.entries).reduce((n, e) => n + (e.credits || 0), 0);
  console.log(`\ndone in ${mins} min · ${credits} credits total`);
  if (failures.length) {
    console.error(`${failures.length} failed: ${failures.map((f) => f.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
