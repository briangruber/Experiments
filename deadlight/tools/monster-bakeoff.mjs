// Generates every monster candidate, verifies each, and promotes the winners.
//
//   TRIPO_API_KEY=... node tools/monster-bakeoff.mjs [--only watcher]
//                                                    [--promote] [--jobs 6]
//
// Tripo's auto-rigger is not deterministic. The same prompt run three times
// produced skeletons of 52, 62 and 78 bones — one animated beautifully, one
// tore the mesh into spaghetti, one folded it onto the floor. All three had
// immaculate bind poses, valid clips and correct bounds. Generating a monster
// is therefore a *sampling* problem, and this is the sampler: every candidate
// in the manifest is generated, rigged, given two test clips, and then posed
// and measured by tools/verify-rig.mjs. The one that survives gets promoted.
//
// `--promote` writes the winning task ids into assets/generation.json, so a
// following `node tools/generate.mjs` picks up the good rig and retargets the
// full clip set onto it rather than rolling the dice again.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MONSTERS } from './assets.manifest.mjs';
import { download, modelUrls, pollTask, retarget, rig, textToModel } from './tripo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'raw', 'bakeoff');
const STATE = path.join(ROOT, 'assets', 'generation.json');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const only = flag('only') ? new Set(flag('only').split(',')) : null;
const PROMOTE = args.includes('--promote');

/** Clips generated per candidate. `walk` is the one that exposes a bad rig
 *  fastest — big limb travel, and a spine that has to stay upright. */
const TEST_CLIPS = ['preset:walk', 'preset:idle'];

async function buildCandidate(monster, index) {
  const key = `${monster.key}${index + 1}`;
  const log = (msg) => console.log(`${key.padEnd(10)} ${msg}`);

  log('generating…');
  const meshTask = await textToModel(monster.candidates[index], {
    faceLimit: monster.faceLimit ?? 26000,
  });
  const mesh = await pollTask(meshTask);
  await download(modelUrls(mesh.output)[0].url, path.join(OUT, `${key}_mesh.glb`));

  log('rigging…');
  const rigTask = await rig(meshTask, { model: monster.rigModel });
  await pollTask(rigTask);

  const clips = [];
  for (const preset of TEST_CLIPS) {
    const name = preset.replace('preset:', '');
    const animTask = await retarget(rigTask, preset);
    const done = await pollTask(animTask);
    const file = `${key}_${name}.glb`;
    await download(modelUrls(done.output)[0].url, path.join(OUT, file));
    clips.push(path.join('assets', 'raw', 'bakeoff', file));
  }

  log('generated');
  return { monster: monster.key, key, index, meshTask, rigTask, clips };
}

/**
 * Score a candidate by posing it.
 *
 * Passing is not enough to pick by. Two candidates can both clear the bar and
 * be very different animals: a watcher that posed at 0.74 of its bind height
 * and one that posed at 0.94 both "passed", but the first walks in a permanent
 * half-crouch. So this reads verify-rig's JSON and ranks on how *close to
 * upright and undistorted* each rig stays — best candidate, not first.
 */
async function verifyCandidate(candidate) {
  let stdout = '';
  try {
    ({ stdout } = await run('node', [
      path.join(ROOT, 'tools/verify-rig.mjs'), '--json',
      ...candidate.clips,
      '--port', String(8130 + candidate.index * 2 + (candidate.key.length % 7)),
    ], { cwd: ROOT }));
  } catch (err) {
    stdout = err.stdout ?? '';
  }

  const records = stdout.trim().split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });

  const ok = records.length > 0 && records.every((r) => r.ok);
  // Distance from a perfect pose, summed over clips: how much shorter than
  // bind it ever gets, plus how far its spread strays from 1.
  const penalty = records.reduce(
    (sum, r) => sum + (1 - (r.height ?? 0)) + Math.abs(1 - (r.spread ?? 1)), 0,
  ) / Math.max(1, records.length);

  return { ...candidate, ok, penalty, records, bones: records[0]?.bones ?? 0 };
}

async function promote(winners) {
  const state = existsSync(STATE)
    ? JSON.parse(await readFile(STATE, 'utf8'))
    : { entries: {} };

  for (const win of winners) {
    state.entries[win.monster] = {
      taskId: win.meshTask,
      done: true,
      note: `bakeoff candidate ${win.key}, verified by tools/verify-rig.mjs`,
    };
    state.entries[`${win.monster}:rig`] = { taskId: win.rigTask, done: true };
    // Clear the old clip set: it belongs to whichever rig was there before.
    for (const id of Object.keys(state.entries)) {
      if (id.startsWith(`${win.monster}:anim`)) delete state.entries[id];
    }
  }

  state.updated = new Date().toISOString();
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`\npromoted ${winners.length} rig(s) into assets/generation.json`);
  console.log('now run: node tools/generate.mjs --only ' + winners.map((w) => w.monster).join(','));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const wanted = MONSTERS.filter((m) => !only || only.has(m.key));

  const jobs = wanted.flatMap((m) => m.candidates.map((_, i) => () => buildCandidate(m, i)));
  console.log(`generating ${jobs.length} candidate(s) across ${wanted.length} monster(s)\n`);

  const built = (await Promise.allSettled(jobs.map((j) => j()))).flatMap((r) => {
    if (r.status === 'fulfilled') return [r.value];
    console.error(`✗ candidate failed: ${r.reason.message}`);
    return [];
  });

  console.log('\nverifying rigs…\n');
  // Sequentially: each verify run starts a browser and a server of its own.
  const scored = [];
  for (const candidate of built) scored.push(await verifyCandidate(candidate));

  const winners = [];
  for (const monster of wanted) {
    const mine = scored.filter((c) => c.monster === monster.key)
      .sort((a, b2) => (a.ok === b2.ok ? a.penalty - b2.penalty : (a.ok ? -1 : 1)));
    for (const c of mine) {
      console.log(`${c.ok ? '✓' : '✗'} ${c.key}  ${c.bones} bones  score ${c.penalty.toFixed(3)}`);
      for (const r of c.records) {
        console.log(`      ${r.ok ? ' ' : '✗'} ${path.basename(r.file).padEnd(24)}` +
          `spread ×${r.spread ?? '?'}  height ×${r.height ?? '?'}${r.error ? `  ${r.error}` : ''}`);
      }
    }
    const winner = mine.find((c) => c.ok);
    if (winner) {
      winners.push(winner);
      console.log(`  → ${monster.key}: ${winner.key} wins\n`);
    } else {
      console.error(`  → ${monster.key}: NO CANDIDATE PASSED — rewrite the prompt\n`);
    }
  }

  if (PROMOTE && winners.length) await promote(winners);
  else if (!PROMOTE) console.log('re-run with --promote to pin the winners');

  if (winners.length < wanted.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
