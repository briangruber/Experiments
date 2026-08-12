#!/usr/bin/env node
// Tripo asset pipeline for Hop & Shop.
//
// Reads tools/assets.config.mjs, generates every asset that is not already in
// the ledger, and downloads the result into assets/. The ledger
// (assets/ledger.json) records the Tripo task id for each pipeline step keyed
// by a hash of that step's request, so re-running is free: an asset is only
// regenerated when its prompt or settings actually change.
//
//   node tools/tripo.mjs list            what would run, and what it costs
//   node tools/tripo.mjs run [name...]   generate (default: everything)
//   node tools/tripo.mjs redo <name>     forget an asset and rebuild it

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS } from './assets.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = join(ROOT, 'assets');
// One ledger file per asset, so several `run` processes can work on different
// assets at the same time without clobbering each other's records.
const LEDGER_DIR = join(ASSET_DIR, 'ledger');
const API = 'https://api.tripo3d.ai/v2/openapi';

const KEY = process.env.TRIPO_API_KEY;
if (!KEY) {
  console.error('TRIPO_API_KEY is not set.');
  process.exit(1);
}

const auth = { Authorization: `Bearer ${KEY}` };

// ---------------------------------------------------------------- api

async function api(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, body;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: { ...auth, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
      body = await res.json();
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (body.code === 0) return body.data;
    // A rig or retarget submitted the instant its input task reports success is
    // rejected as malformed for a few seconds while the source model settles,
    // so 1003 gets the same backoff as a rate limit rather than killing the run.
    if ((res.status === 429 || res.status >= 500 || body.code === 1003) && attempt < 5) {
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`tripo ${path}: ${body.code} ${body.message || ''} ${body.suggestion || ''}`);
  }
}

const submit = (body) => api('/task', { method: 'POST', body: JSON.stringify(body) }).then((d) => d.task_id);
const task = (id) => api(`/task/${id}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a task, printing progress on one line.
async function settle(id, label) {
  let last = -1;
  for (;;) {
    const t = await task(id);
    if (t.status === 'success') {
      process.stdout.write(`\r  ${label} ${'.'.repeat(20)} done\n`);
      return t;
    }
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(t.status)) {
      process.stdout.write('\n');
      throw new Error(`${label}: task ${id} ${t.status}`);
    }
    const pct = t.progress ?? 0;
    if (pct !== last) {
      process.stdout.write(`\r  ${label} ${String(pct).padStart(3)}%  `);
      last = pct;
    }
    await sleep(3000);
  }
}

// ---------------------------------------------------------------- ledger

const ledgerPath = (name) => join(LEDGER_DIR, `${name}.json`);

async function loadLedger(name) {
  const path = ledgerPath(name);
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveLedger(name, entry) {
  await mkdir(LEDGER_DIR, { recursive: true });
  await writeFile(ledgerPath(name), `${JSON.stringify(entry, null, 2)}\n`);
}

const hash = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);

// Run one pipeline step, reusing the recorded task id when the request is
// unchanged. `slot` namespaces the step within the asset (model / rig / walk).
const DEAD = ['failed', 'cancelled', 'banned', 'expired', 'unknown'];

async function step(entry, name, slot, body, label) {
  const key = hash(body);
  const prev = entry[slot];
  if (prev?.key === key && prev.task) {
    const t = await task(prev.task).catch(() => null);
    if (t?.status === 'success') {
      console.log(`  ${label} ${'.'.repeat(20)} cached`);
      return t;
    }
    // Still running from an earlier invocation: wait for it. Resubmitting would
    // pay twice, and Tripo rejects a second rig for a model that already has
    // one in flight, so abandoning it also breaks the run.
    if (t && !DEAD.includes(t.status)) return settle(prev.task, label);
  }
  const id = await submit(body);
  entry[slot] = { key, task: id };
  await saveLedger(name, entry);
  const t = await settle(id, label);
  return t;
}

// ---------------------------------------------------------------- download

// Tripo hands back pre-signed URLs that expire, so we always pull a fresh one
// from the task record rather than caching the link.
function modelUrl(t) {
  const o = t.output || {};
  return o.pbr_model || o.model || o.base_model || null;
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`http ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// ---------------------------------------------------------------- pipeline

const MODEL_VERSION = 'v3.0-20250812';

function genBody(a) {
  return {
    type: 'text_to_model',
    prompt: a.prompt,
    negative_prompt: a.negative ?? undefined,
    model_version: MODEL_VERSION,
    texture: true,
    pbr: true,
    texture_quality: 'detailed',
    face_limit: a.faces ?? 10000,
    auto_size: false,
    ...(a.style ? { style: a.style } : {}),
  };
}

async function build(a) {
  console.log(`\n${a.name}`);
  const entry = await loadLedger(a.name);
  const gen = await step(entry, a.name, 'model', genBody(a), 'model');

  // Static prop: one file and we are done.
  if (!a.rig) {
    await download(modelUrl(gen), join(ASSET_DIR, `${a.name}.glb`));
    return;
  }

  // Character: rig once, then retarget each animation onto the rigged mesh.
  const rig = await step(
    entry,
    a.name,
    'rig',
    { type: 'animate_rig', original_model_task_id: gen.task_id, out_format: 'glb', spec: 'tripo' },
    'rig',
  );
  await download(modelUrl(rig), join(ASSET_DIR, `${a.name}.glb`));

  for (const anim of a.animations) {
    const t = await step(
      entry,
      a.name,
      `anim:${anim}`,
      {
        type: 'animate_retarget',
        original_model_task_id: rig.task_id,
        animation: `preset:${anim}`,
        out_format: 'glb',
        bake_animation: true,
      },
      `anim ${anim}`,
    );
    await download(modelUrl(t), join(ASSET_DIR, `${a.name}.${anim}.glb`));
  }
}

// ---------------------------------------------------------------- cli

const [cmd = 'run', ...names] = process.argv.slice(2);
const wanted = names.length ? ASSETS.filter((a) => names.includes(a.name)) : ASSETS;

if (names.length && wanted.length !== names.length) {
  const known = new Set(ASSETS.map((a) => a.name));
  console.error(`unknown asset(s): ${names.filter((n) => !known.has(n)).join(', ')}`);
  process.exit(1);
}

if (cmd === 'list') {
  const { balance } = await api('/user/balance');
  console.log(`balance: ${balance} credits\n`);
  for (const a of ASSETS) {
    const done = existsSync(ledgerPath(a.name)) ? 'have' : ' new';
    const steps = a.rig ? 2 + a.animations.length : 1;
    console.log(`  [${done}] ${a.name.padEnd(20)} ${steps} step(s)`);
  }
} else if (cmd === 'redo') {
  for (const a of wanted) await saveLedger(a.name, {});
  for (const a of wanted) await build(a);
} else if (cmd === 'run') {
  const before = (await api('/user/balance')).balance;
  for (const a of wanted) await build(a);
  const after = (await api('/user/balance')).balance;
  console.log(`\nspent ${before - after} credits, ${after} remaining`);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
