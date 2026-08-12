// Tries several creature prompts through the full rig pipeline at once.
//
//   TRIPO_API_KEY=... node tools/creature-bakeoff.mjs
//
// Tripo's auto-rigger is the fussiest step in the whole asset pipeline, and it
// fails quietly: the bind pose looks perfect and the skin only tears once a
// bone moves, so a bad rig survives every check that does not actually play a
// clip. The first creature this project generated — "elongated spindly limbs,
// long clawed fingers" — rigged into spaghetti for exactly that reason. Thin,
// separated geometry gives the rigger nothing to attach a limb to.
//
// So rather than iterating one prompt at a time at four minutes a go, this
// runs candidates in parallel and writes each one out for inspection with
// tools/inspect.html. Prompt notes are inline below; they are the actual
// findings, and they are the point of keeping this file.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { download, modelUrls, pollTask, retarget, rig, textToModel } from './tripo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'raw', 'bakeoff');

const CANDIDATES = [
  {
    key: 'solid',
    // Solid, connected, mitten hands. The rigger wants a silhouette it can
    // segment into limbs, and fingers are where it loses the plot.
    prompt:
      'a tall gaunt humanoid horror creature standing upright in an A-pose, ' +
      'arms hanging down and slightly away from the body, solid connected ' +
      'limbs of even thickness, smooth featureless head, no separated ' +
      'fingers, closed simple hands, ashen grey skin, full body character ' +
      'model, symmetrical, clean topology, game character, T-pose reference, ' +
      'no base, no pedestal',
    faceLimit: 30000,
    spec: 'mixamo',
  },
  {
    key: 'bulk',
    // More mass again, and explicitly "human proportions" — the rigger is
    // fitting a human skeleton, so the further the body is from one the worse
    // the weights get.
    prompt:
      'an emaciated pale humanoid monster with human proportions standing ' +
      'straight in an A-pose, arms down at its sides, thick solid arms and ' +
      'legs, bald featureless head with a wide mouth, no eyes, mitten hands ' +
      'with no separate fingers, grey skin, single connected body mesh, ' +
      'front facing, game character model, no base, no pedestal',
    faceLimit: 30000,
    spec: 'tripo',
  },
];

/** The clip that exposes a bad rig fastest — big limb travel, long duration. */
const TEST_ANIMATIONS = ['preset:walk', 'preset:idle'];

async function candidate(entry) {
  const tag = entry.key.padEnd(6);
  const log = (msg) => console.log(`${tag} ${msg}`);

  log('generating…');
  const meshTask = await textToModel(entry.prompt, { faceLimit: entry.faceLimit });
  await pollTask(meshTask, { onProgress: (s, p) => p % 50 === 0 && log(`mesh ${s} ${p}%`) });
  const mesh = await pollTask(meshTask);
  await download(modelUrls(mesh.output)[0].url, path.join(OUT, `${entry.key}_mesh.glb`));

  log('rigging…');
  const rigTask = await rig(meshTask, { spec: entry.spec });
  await pollTask(rigTask, { onProgress: (s, p) => p % 50 === 0 && log(`rig ${s} ${p}%`) });

  for (const preset of TEST_ANIMATIONS) {
    const name = preset.replace('preset:', '');
    log(`retarget ${name}…`);
    const animTask = await retarget(rigTask, preset);
    const done = await pollTask(animTask);
    await download(modelUrls(done.output)[0].url, path.join(OUT, `${entry.key}_${name}.glb`));
  }

  log(`done → assets/raw/bakeoff/${entry.key}_*.glb  (mesh task ${meshTask}, rig task ${rigTask})`);
  return { key: entry.key, meshTask, rigTask };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const results = await Promise.allSettled(CANDIDATES.map(candidate));

  console.log('\ninspect each with:');
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.error(`  failed: ${r.reason.message}`);
      continue;
    }
    console.log(
      `  http://localhost:8080/tools/inspect.html` +
      `?file=../assets/raw/bakeoff/${r.value.key}_walk.glb&clip=0&t=0.8`,
    );
  }
  console.log('\nwinning prompt goes into tools/assets.manifest.mjs as CREATURE.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
