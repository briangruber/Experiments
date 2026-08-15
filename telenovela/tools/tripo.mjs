#!/usr/bin/env node
// The Tripo pipeline, as a command instead of a folder of curl invocations.
//
//   node tools/tripo.mjs balance
//   node tools/tripo.mjs model esteban            # concept png -> textured mesh
//   node tools/tripo.mjs rig esteban              # check, then bind a skeleton
//   node tools/tripo.mjs anim esteban walk idle run
//   node tools/tripo.mjs status <task-id>
//
// Every task id it creates is appended to company/cast/models/provenance.json,
// so a character can be traced back to the picture it came from and rebuilt
// without guessing which of a dozen tasks was the good one.
//
// Two things this exists to prevent. The first is spending credits twice: each
// step checks for the file it would produce and refuses to re-run without
// --force, because a generation you already paid for is on disk. The second is
// spending them blind: --dry prints exactly what would be submitted.
//
// Model version: v3.0-20250812 is the newest the API accepts (probed — the
// studio's v3.1 is not exposed yet, and every v3.1-* string is rejected with
// code 2017). It is a large step up from the v2.5 the first cast was cut from.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONCEPT = join(ROOT, 'company/cast/concept');
const MODELS = join(ROOT, 'company/cast/models');
const SRC = join(MODELS, 'src');
const LEDGER = join(MODELS, 'provenance.json');

const API = 'https://api.tripo3d.ai/v2/openapi';
const VERSION = 'v3.0-20250812';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const FACE_LIMIT = +opt('faces', 20000);

const KEY = process.env.TRIPO_API_KEY;
if (!KEY) { console.error('TRIPO_API_KEY not set'); process.exit(1); }
const auth = { Authorization: `Bearer ${KEY}` };

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`${path}: code ${json.code} ${json.message || res.status} ${json.suggestion || ''}`);
  return json.data;
}

async function ledger(entry) {
  let log = [];
  if (await exists(LEDGER)) log = JSON.parse(await readFile(LEDGER, 'utf8'));
  log.push({ ...entry, at: new Date().toISOString() });
  await writeFile(LEDGER, JSON.stringify(log, null, 2) + '\n');
}

async function lookup(key, kind) {
  if (!(await exists(LEDGER))) return null;
  const log = JSON.parse(await readFile(LEDGER, 'utf8'));
  return [...log].reverse().find((e) => e.key === key && e.kind === kind) || null;
}

// --- tasks ------------------------------------------------------------------

async function submit(body) {
  if (DRY) { console.log('  would submit: ' + JSON.stringify(body)); return null; }
  const { task_id } = await api('/task', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return task_id;
}

// Tripo reports progress as it goes; a v3.0 generation is minutes, not seconds,
// so this prints rather than spinning silently.
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

// The output object moved around between model versions; take the first URL
// that is actually there rather than trusting one field name.
function modelUrl(d) {
  const o = d.output || {};
  return o.pbr_model || o.model || o.base_model || o.rigged_model || o.animated_model
    || d.result?.pbr_model?.url || d.result?.model?.url || null;
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A GLB that is really an error page will pass a length check but not this.
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'glTF') throw new Error(`not a GLB (magic ${JSON.stringify(magic)})`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  console.log(`  -> ${basename(path)}  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  return buf.length;
}

// --- commands ---------------------------------------------------------------

async function cmdBalance() {
  const d = await api('/user/balance');
  console.log(`  balance ${d.balance}  frozen ${d.frozen}`);
}

async function cmdModel(key) {
  const png = join(CONCEPT, `${key}.png`);
  if (!(await exists(png))) throw new Error(`no concept art at company/cast/concept/${key}.png — run tools/concept-art.mjs ${key}`);
  const out = join(SRC, `${key}.glb`);
  if (!FORCE && await exists(out)) { console.log(`  ${key}: already sculpted (--force to redo)`); return; }

  // Upload first: the token is what the task refers to.
  const form = new FormData();
  form.append('file', new Blob([await readFile(png)], { type: 'image/png' }), `${key}.png`);
  const up = DRY ? { image_token: '(dry)' } : await api('/upload/sts', { method: 'POST', body: form });
  console.log(`  ${key}: uploaded concept art`);

  const body = {
    type: 'image_to_model',
    file: { type: 'png', file_token: up.image_token },
    model_version: VERSION,
    face_limit: FACE_LIMIT,
    texture: true,
    pbr: true,
    texture_quality: 'detailed',
    auto_size: true,
  };
  const id = await submit(body);
  if (!id) return;
  const d = await wait(id, `${key} sculpt`);
  const url = modelUrl(d);
  if (!url) throw new Error(`${key}: task succeeded with no model url`);
  const bytes = await download(url, out);
  await ledger({ key, kind: 'model', task: id, version: VERSION, faces: FACE_LIMIT, concept: `concept/${key}.png`, bytes });
}

async function cmdRig(key) {
  const gen = await lookup(key, 'model');
  if (!gen) throw new Error(`${key}: no generation in the ledger — run 'model' first`);
  const out = join(SRC, `${key}-rigged.glb`);
  if (!FORCE && await exists(out)) { console.log(`  ${key}: already rigged (--force to redo)`); return; }

  // The check is cheap and tells you whether the bind is going to be worth
  // paying for; a bird that comes back riggable:false is a re-sculpt, not a retry.
  const checkId = await submit({ type: 'animate_prerigcheck', original_model_task_id: gen.task });
  if (!checkId) return;
  const check = await wait(checkId, `${key} rig check`);
  console.log(`  riggable=${check.output?.riggable} type=${check.output?.rig_type ?? '?'} topology=${check.output?.topology ?? '?'}`);
  if (check.output?.riggable === false) throw new Error(`${key}: not riggable`);

  const id = await submit({ type: 'animate_rig', original_model_task_id: gen.task, out_format: 'glb', spec: 'tripo' });
  const d = await wait(id, `${key} rig`);
  const bytes = await download(modelUrl(d), out);
  await ledger({ key, kind: 'rig', task: id, from: gen.task, bytes });
}

async function cmdAnim(key, clips) {
  const rig = await lookup(key, 'rig');
  if (!rig) throw new Error(`${key}: not rigged yet`);
  for (const clip of clips) {
    const out = join(SRC, `${key}-${clip}.glb`);
    if (!FORCE && await exists(out)) { console.log(`  ${key}-${clip}: already retargeted`); continue; }
    const id = await submit({
      type: 'animate_retarget', original_model_task_id: rig.task,
      animation: `preset:${clip}`, out_format: 'glb',
    });
    if (!id) continue;
    const d = await wait(id, `${key} ${clip}`);
    const bytes = await download(modelUrl(d), out);
    await ledger({ key, kind: 'anim', clip, task: id, from: rig.task, bytes });
  }
}

async function cmdStatus(id) {
  const d = await api(`/task/${id}`);
  console.log(JSON.stringify({ status: d.status, progress: d.progress, output: d.output }, null, 2));
}

try {
  switch (cmd) {
    case 'balance': await cmdBalance(); break;
    case 'model': await cmdModel(args[1]); break;
    case 'rig': await cmdRig(args[1]); break;
    case 'anim': await cmdAnim(args[1], args.slice(2).filter((a) => !a.startsWith('--'))); break;
    case 'status': await cmdStatus(args[1]); break;
    default:
      console.error('usage: node tools/tripo.mjs balance|model <key>|rig <key>|anim <key> <clip...>|status <id>');
      process.exit(1);
  }
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
