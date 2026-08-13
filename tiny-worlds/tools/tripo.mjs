#!/usr/bin/env node
// Tripo asset pipeline for Tiny Worlds.
//
//   node tools/tripo.mjs                 # build everything in MANIFEST that is missing
//   node tools/tripo.mjs keeper lantern  # build only the named jobs
//
// Each job is text -> textured mesh, optionally rigged and retargeted onto a
// set of preset animations. Outputs land in assets/ as .glb. Every task id is
// recorded in assets/tripo.json so a rerun resumes instead of paying twice.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
// One ledger per concurrent run, so two parallel invocations cannot clobber
// each other's task ids.
const LEDGER = join(ASSETS, process.env.TRIPO_LEDGER || 'tripo.json');
const KEY = process.env.TRIPO_API_KEY;
const API = 'https://api.tripo3d.ai/v2/openapi';

if (!KEY) { console.error('TRIPO_API_KEY is not set'); process.exit(1); }

// A "clay toy on a shelf" read keeps every asset in the same diorama, which is
// what sells the miniature scale more than any single model does.
const LOOK = 'smooth matte clay toy, soft rounded forms, stylized low-poly game asset,'
  + ' flat pastel colours, no base, no text';

const MANIFEST = {
  keeper: {
    prompt: `A tiny chibi caretaker in a hooded cloak with a round lantern backpack,`
      + ` standing in a T-pose, two arms two legs, friendly face, ${LOOK}`,
    faceLimit: 12000,
    rig: true,
    // fall is a separate pose from jump: rising and descending look nothing
    // alike, and hurt covers being knocked off your feet.
    animations: ['idle', 'walk', 'run', 'jump', 'fall', 'hurt'],
  },
  gloom: {
    prompt: `A small round grumpy shadow creature standing in a T-pose, two`
      + ` stubby legs, two short arms, one big round glowing eye, fluffy dark`
      + ` fur, cute not scary, ${LOOK}`,
    faceLimit: 10000,
    rig: true,
    animations: ['idle', 'walk'],
  },
  house: {
    prompt: `A tiny round mushroom cottage with a round door, one window and a`
      + ` curved chimney, cosy fairytale home, ${LOOK}`,
    faceLimit: 8000,
  },
  lantern: {
    prompt: `An ornate stone beacon lantern on a short pillar, glass lamp housing,`
      + ` unlit, weathered carvings, ${LOOK}`,
    faceLimit: 8000,
  },
  tree: {
    prompt: `A single stylized round-canopy tree with a curved trunk, chunky`
      + ` leaf clusters, ${LOOK}`,
    faceLimit: 6000,
  },
  crystal: {
    prompt: `A cluster of tall faceted crystals growing from a small rock,`
      + ` translucent glowing shards, ${LOOK}`,
    faceLimit: 6000,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${path}: non-JSON ${res.status} ${text.slice(0, 200)}`); }
  if (json.code !== 0) throw new Error(`${path}: code ${json.code} ${json.message || ''} ${JSON.stringify(json.data || {}).slice(0, 200)}`);
  return json.data;
}

const submit = (body) => api('/task', { method: 'POST', body: JSON.stringify(body) }).then((d) => d.task_id);

async function wait(taskId, label) {
  let last = '';
  for (let i = 0; i < 600; i++) {
    const d = await api(`/task/${taskId}`);
    const line = `${d.status} ${d.progress ?? 0}%`;
    if (line !== last) { console.log(`  [${label}] ${line}`); last = line; }
    if (d.status === 'success') return d;
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(d.status)) {
      throw new Error(`[${label}] task ${taskId} ${d.status}: ${JSON.stringify(d.output || {}).slice(0, 200)}`);
    }
    await sleep(4000);
  }
  throw new Error(`[${label}] timed out`);
}

function modelUrl(task) {
  const o = task.output || {};
  const r = task.result || {};
  return o.pbr_model || o.model || o.base_model
    || r.pbr_model?.url || r.model?.url || r.base_model?.url || null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url.slice(0, 80)}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function loadLedger() {
  try { return JSON.parse(await readFile(LEDGER, 'utf8')); } catch { return {}; }
}
let ledger = await loadLedger();
const saveLedger = () => writeFile(LEDGER, JSON.stringify(ledger, null, 2) + '\n');

// Resume-aware step: if the ledger already holds a task id for this key we
// reuse it (Tripo keeps finished tasks around), otherwise we pay for a new one.
async function step(key, label, body) {
  ledger[key] ||= {};
  if (!ledger[key].taskId) {
    ledger[key].taskId = await submit(body);
    await saveLedger();
    console.log(`  [${label}] submitted ${ledger[key].taskId}`);
  } else {
    console.log(`  [${label}] resuming ${ledger[key].taskId}`);
  }
  const task = await wait(ledger[key].taskId, label);
  return task;
}

async function build(name, job) {
  console.log(`\n== ${name}`);
  const base = await step(`${name}:model`, `${name}/model`, {
    type: 'text_to_model',
    prompt: job.prompt,
    model_version: 'v2.5-20250123',
    face_limit: job.faceLimit ?? 8000,
    texture: true,
    pbr: true,
    auto_size: true,
  });

  if (!job.rig) {
    const out = join(ASSETS, `${name}.glb`);
    if (!existsSync(out)) await download(modelUrl(base), out);
    console.log(`  [${name}] -> assets/${name}.glb`);
    return;
  }

  const rig = await step(`${name}:rig`, `${name}/rig`, {
    type: 'animate_rig',
    original_model_task_id: ledger[`${name}:model`].taskId,
    out_format: 'glb',
    spec: 'tripo',
  });
  const rigOut = join(ASSETS, `${name}-rig.glb`);
  if (!existsSync(rigOut)) await download(modelUrl(rig), rigOut);
  console.log(`  [${name}] -> assets/${name}-rig.glb`);

  for (const anim of job.animations ?? []) {
    const task = await step(`${name}:${anim}`, `${name}/${anim}`, {
      type: 'animate_retarget',
      original_model_task_id: ledger[`${name}:rig`].taskId,
      animation: `preset:${anim}`,
      out_format: 'glb',
      bake_animation: true,
    });
    const out = join(ASSETS, `${name}-${anim}.glb`);
    if (!existsSync(out)) await download(modelUrl(task), out);
    console.log(`  [${name}] -> assets/${name}-${anim}.glb`);
  }
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = wanted.length ? wanted : Object.keys(MANIFEST);
await mkdir(ASSETS, { recursive: true });

const failures = [];
// Sequential on purpose: Tripo queues per-account anyway and a serial run keeps
// the ledger honest if the process is killed halfway.
for (const name of names) {
  const job = MANIFEST[name];
  if (!job) { console.error(`unknown job ${name}`); failures.push(name); continue; }
  try { await build(name, job); } catch (e) { console.error(`  !! ${name}: ${e.message}`); failures.push(name); }
}

const balance = await api('/user/balance').catch(() => null);
if (balance) console.log(`\ncredits left: ${balance.balance}`);
if (failures.length) { console.error(`\nfailed: ${failures.join(', ')}`); process.exit(1); }
console.log('\nall assets ready');
