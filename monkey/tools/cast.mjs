#!/usr/bin/env node
// The cast, as 3D: concept image -> mesh -> rig -> animation clips.
//
//   node tools/cast.mjs concept bonny        # T-pose reference, via fal
//   node tools/cast.mjs model bonny          # Tripo image_to_model, textured
//   node tools/cast.mjs rig bonny            # auto-rig, Mixamo bone naming
//   node tools/cast.mjs anim bonny walk idle
//   node tools/cast.mjs balance
//
// This exists to answer one question: at this game's size — a 165px figure in
// a 720px frame, so a head about 35px across — does a rigged 3D character beat
// the procedural vector puppet? The puppet is deliberately vector because at
// 35px a drawn head still has a brow, eyes and a jaw that flaps, and a painted
// or modelled one is a coloured blob. A real skeleton buys real limbs and real
// weight; whether that is worth losing the face is a thing to look at, not to
// argue about.
//
// The rig is requested with Mixamo bone naming rather than Tripo's native
// spec, and that choice is the important one. It costs nothing and it buys two
// things: Mixamo's animation library retargets straight onto it, and the bones
// have standard names, so the walk cycle already tuned for the puppet — hip
// drop, weight shift, two-bone IK, trailing cloth — can be ported onto the
// skeleton by name instead of reverse-engineering a hierarchy.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { ROOT } from './harness.mjs';
import { falRun, fetchBuf } from './fal.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const SPEC = opt('spec', 'mixamo');
const RIG_VERSION = opt('rig-version', 'v1.0-20240301');   // humanoid, 90+ presets
const MODEL_VERSION = opt('model-version', 'v3.0-20250812');
const FACE_LIMIT = +opt('faces', 20000);

const CAST = join(ROOT, 'assets/cast');
const LEDGER = join(CAST, 'provenance.json');
const API = 'https://api.tripo3d.ai/v2/openapi';
const KEY = () => process.env.TRIPO_API_KEY;

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// What the character is. Written to match the protagonist the room already
// has, because a cast that does not match the game it is for proves nothing.
const SHEET = {
  bonny: 'A young woman pirate adventurer, the hero of a 1990s point-and-click adventure game. '
    + 'Deep red knee-length coat over a cream shirt, a gold sash at the waist, dark blue trousers '
    + 'and worn brown boots. A red bandana tied over auburn hair. Friendly, wry, capable face. '
    + 'Slightly stylised heroic proportions, clean readable silhouette.',
  grout: 'A large weary harbourmaster in his fifties, the obstacle character of a 1990s '
    + 'point-and-click adventure game. Heavy teal-blue naval coat, grey shirt, a broad leather belt, '
    + 'dark trousers and heavy boots. A brown tricorn hat and a short grey beard. Broad, immovable, '
    + 'tired. Slightly stylised heroic proportions, clean readable silhouette.',
};

// Everything about being a usable 3D source rather than a nice picture. A
// T-pose because the rigger wants limbs separated from the body; flat light
// because a cast shadow gets reconstructed as geometry.
const POSE = 'Full body in a strict T-pose: standing upright, facing the camera dead-on, both arms '
  + 'held straight out horizontally to the sides at shoulder height, palms down, legs straight and '
  + 'slightly apart, feet flat and fully visible. The entire figure inside the frame with a margin '
  + 'of empty space on all sides.';
const LOOK = 'Character reference sheet for 3D modelling: flat even studio lighting from the front, '
  + 'no harsh shadows, no cast shadow on the floor, no rim light, plain seamless light grey '
  + 'background. Crisp, clearly separated forms. No text, no watermark, no border, no grid.';

async function ledger(entry) {
  let log = [];
  if (await exists(LEDGER)) log = JSON.parse(await readFile(LEDGER, 'utf8'));
  log.push({ ...entry, at: new Date().toISOString() });
  await mkdir(CAST, { recursive: true });
  await writeFile(LEDGER, JSON.stringify(log, null, 2) + '\n');
}
async function lookup(key, kind) {
  if (!(await exists(LEDGER))) return null;
  const log = JSON.parse(await readFile(LEDGER, 'utf8'));
  return [...log].reverse().find((e) => e.key === key && e.kind === kind) || null;
}

// --- tripo ------------------------------------------------------------------

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init, headers: { Authorization: `Bearer ${KEY()}`, ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`${path}: code ${json.code} ${json.message || res.status} ${json.suggestion || ''}`);
  return json.data;
}

async function submit(body) {
  if (DRY) { console.log('  would submit: ' + JSON.stringify(body)); return null; }
  const { task_id } = await api('/task', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return task_id;
}

async function wait(id, label) {
  let last = -1;
  for (let i = 0; i < 600; i++) {
    const d = await api(`/task/${id}`);
    if (d.progress !== last) { process.stdout.write(`\r  ${label}: ${d.status} ${d.progress ?? 0}%   `); last = d.progress; }
    if (d.status === 'success') { process.stdout.write('\n'); return d; }
    if (['failed', 'cancelled', 'banned', 'unknown'].includes(d.status)) {
      process.stdout.write('\n');
      throw new Error(`${label}: ${d.status} ${JSON.stringify(d.output || {})}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${label}: timed out`);
}

// The output field moved between model versions; take the first URL that is
// actually there rather than trusting one name.
const modelUrl = (d) => {
  const o = d.output || {};
  return o.pbr_model || o.model || o.base_model || o.rigged_model || o.animated_model
    || d.result?.pbr_model?.url || d.result?.model?.url || null;
};

async function download(url, path) {
  const buf = await fetchBuf(url);
  // A GLB that is really an error page passes a length check but not this.
  if (buf.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('not a GLB');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  console.log(`  -> ${basename(path)}  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  return buf.length;
}

// --- commands ---------------------------------------------------------------

async function cmdConcept(key) {
  const out = join(CAST, `${key}-concept.png`);
  if ((await exists(out)) && !FORCE) { console.error(`${out} exists — --force to redraw`); return; }
  const prompt = `${SHEET[key]} ${POSE} ${LOOK}`;
  if (DRY) { console.log(prompt); return; }
  const res = await falRun('fal-ai/flux-2-pro', {
    prompt, image_size: { width: 1024, height: 1024 }, num_images: 1,
    output_format: 'png', enable_safety_checker: false,
  }, `${key} concept`);
  const img = res.images?.[0];
  if (!img?.url) throw new Error('no image');
  const buf = await fetchBuf(img.url);
  await mkdir(CAST, { recursive: true });
  await writeFile(out, buf);
  await ledger({ key, kind: 'concept', file: `assets/cast/${key}-concept.png`, model: 'fal-ai/flux-2-pro', prompt });
  console.log(`concept -> assets/cast/${key}-concept.png  ${(buf.length / 1024).toFixed(0)} KB`);
}

async function cmdModel(key) {
  const png = join(CAST, `${key}-concept.png`);
  if (!(await exists(png))) throw new Error(`no concept — run: node tools/cast.mjs concept ${key}`);
  const out = join(CAST, `${key}.glb`);
  if ((await exists(out)) && !FORCE) { console.log(`  ${key}: already sculpted (--force to redo)`); return; }

  const form = new FormData();
  form.append('file', new Blob([await readFile(png)], { type: 'image/png' }), `${key}.png`);
  const up = DRY ? { image_token: '(dry)' } : await api('/upload/sts', { method: 'POST', body: form });
  console.log(`  ${key}: uploaded concept`);

  const id = await submit({
    type: 'image_to_model',
    file: { type: 'png', file_token: up.image_token },
    model_version: MODEL_VERSION,
    face_limit: FACE_LIMIT,
    texture: true, pbr: true, texture_quality: 'detailed', auto_size: true,
  });
  if (!id) return;
  const d = await wait(id, `${key} sculpt`);
  const bytes = await download(modelUrl(d), out);
  await ledger({ key, kind: 'model', task: id, version: MODEL_VERSION, faces: FACE_LIMIT, bytes });
}

async function cmdRig(key) {
  const gen = await lookup(key, 'model');
  if (!gen) throw new Error(`${key}: no model in the ledger — run 'model' first`);
  const out = join(CAST, `${key}-rigged.glb`);
  if ((await exists(out)) && !FORCE) { console.log(`  ${key}: already rigged (--force to redo)`); return; }

  // Cheap, and it says whether the bind is worth paying for: riggable:false is
  // a re-sculpt, not a retry.
  const checkId = await submit({ type: 'animate_prerigcheck', original_model_task_id: gen.task });
  if (!checkId) return;
  const check = await wait(checkId, `${key} rig check`);
  console.log(`  riggable=${check.output?.riggable} type=${check.output?.rig_type ?? '?'}`);
  if (check.output?.riggable === false) throw new Error(`${key}: not riggable`);

  const id = await submit({
    type: 'animate_rig', original_model_task_id: gen.task,
    out_format: 'glb', spec: SPEC, rig_type: 'biped', model_version: RIG_VERSION,
  });
  const d = await wait(id, `${key} rig (${SPEC})`);
  const bytes = await download(modelUrl(d), out);
  await ledger({ key, kind: 'rig', task: id, from: gen.task, spec: SPEC, rigVersion: RIG_VERSION, bytes });
}

async function cmdAnim(key, clips) {
  const rig = await lookup(key, 'rig');
  if (!rig) throw new Error(`${key}: not rigged yet`);
  for (const clip of clips) {
    const out = join(CAST, `${key}-${clip}.glb`);
    if ((await exists(out)) && !FORCE) { console.log(`  ${key}-${clip}: already retargeted`); continue; }
    const id = await submit({
      type: 'animate_retarget', original_model_task_id: rig.task,
      // The v1.0 humanoid rig namespaces its presets by rig type — `preset:walk`
      // is accepted by the queue and then fails during processing with an empty
      // error, which is a slow way to learn a naming convention.
      animation: `preset:biped:${clip}`, out_format: 'glb',
      // Strip the baked translation at the source rather than filtering
      // position tracks afterwards: a walk that travels walks out of frame,
      // because the game moves the character itself.
      animate_in_place: true,
      bake_animation: true,
    });
    if (!id) continue;
    const d = await wait(id, `${key} ${clip}`);
    const bytes = await download(modelUrl(d), out);
    await ledger({ key, kind: 'anim', clip, task: id, from: rig.task, bytes });
  }
}

if (!KEY() && cmd !== 'concept') { console.error('TRIPO_API_KEY not set'); process.exit(1); }
try {
  switch (cmd) {
    case 'balance': console.log(JSON.stringify(await api('/user/balance'))); break;
    case 'concept': await cmdConcept(args[1]); break;
    case 'model': await cmdModel(args[1]); break;
    case 'rig': await cmdRig(args[1]); break;
    case 'anim': await cmdAnim(args[1], args.slice(2).filter((a) => !a.startsWith('--'))); break;
    default:
      console.error('usage: node tools/cast.mjs balance|concept <key>|model <key>|rig <key>|anim <key> <clip...>');
      process.exit(1);
  }
} catch (e) { console.error(`\n${e.message}`); process.exit(1); }
