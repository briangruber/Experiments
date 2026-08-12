#!/usr/bin/env node
// Tripo3D asset pipeline for the Skyline prototype.
//
//   TRIPO_API_KEY=... node tools/tripo.mjs gen hero "a stylized superhero…" --faces 20000 --rig
//   TRIPO_API_KEY=... node tools/tripo.mjs status <task_id>
//
// Submits a text-to-model task, polls until it finishes, downloads the GLB into
// assets/ and appends the prompt + task id to assets/manifest.json so every
// asset in the repo can be traced back to the request that produced it.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const API = 'https://api.tripo3d.ai/v2/openapi';
const KEY = process.env.TRIPO_API_KEY;
if (!KEY) { console.error('TRIPO_API_KEY is not set'); process.exit(2); }

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes('--' + name);

const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function post(body) {
  const res = await fetch(`${API}/task`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`task rejected (${json.code}): ${json.message || JSON.stringify(json)}`);
  return json.data.task_id;
}

async function poll(taskId, label) {
  let last = -1;
  for (;;) {
    const res = await fetch(`${API}/task/${taskId}`, { headers });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`poll failed (${json.code}): ${json.message}`);
    const d = json.data;
    if (d.progress !== last) {
      last = d.progress;
      console.log(`[${label}] ${d.status} ${d.progress ?? 0}%`);
    }
    if (d.status === 'success') return d;
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(d.status)) {
      throw new Error(`[${label}] task ${d.status}: ${JSON.stringify(d.output || {})}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

function modelUrl(data) {
  const o = data.output || {};
  const pick = (v) => (typeof v === 'string' ? v : v && v.url);
  return pick(o.pbr_model) || pick(o.model) || pick(o.base_model) || null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

async function note(entry) {
  const path = join(ASSETS, 'manifest.json');
  let man = { generator: 'tripo3d', assets: [] };
  try { man = JSON.parse(await readFile(path, 'utf8')); } catch { /* first asset */ }
  man.assets = man.assets.filter((a) => a.name !== entry.name).concat(entry);
  man.assets.sort((a, b) => a.name.localeCompare(b.name));
  await mkdir(ASSETS, { recursive: true });
  await writeFile(path, JSON.stringify(man, null, 2) + '\n');
}

const cmd = args[0];

if (cmd === 'status') {
  const d = await poll(args[1], 'task');
  console.log(JSON.stringify(d, null, 2));
} else if (cmd === 'gen') {
  const name = args[1];
  const prompt = args[2];
  if (!name || !prompt) { console.error('usage: gen <name> "<prompt>" [--faces N] [--rig] [--style S]'); process.exit(2); }

  const body = {
    type: 'text_to_model',
    prompt,
    texture: true,
    pbr: true,
    face_limit: +flag('faces', 10000),
  };
  const style = flag('style', '');
  if (style) body.style = style;

  console.log(`[${name}] submitting…`);
  const taskId = await post(body);
  console.log(`[${name}] task ${taskId}`);
  let data = await poll(taskId, name);
  let sourceTask = taskId;

  if (has('rig')) {
    try {
      console.log(`[${name}] rigging…`);
      const rigId = await post({
        type: 'animate_rig',
        original_model_task_id: taskId,
        out_format: 'glb',
        spec: 'mixamo',
      });
      data = await poll(rigId, `${name}:rig`);
      sourceTask = rigId;
    } catch (err) {
      console.warn(`[${name}] rigging failed, keeping the static mesh — ${err.message}`);
    }
  }

  const url = modelUrl(data);
  if (!url) throw new Error(`[${name}] no model in output: ${JSON.stringify(data.output)}`);
  const dest = join(ASSETS, `${name}.glb`);
  const bytes = await download(url, dest);
  await note({ name, prompt, task: sourceTask, rigged: has('rig') && sourceTask !== taskId, bytes });
  console.log(`[${name}] wrote assets/${name}.glb (${(bytes / 1024).toFixed(0)} KB)`);
} else {
  console.error('usage: tripo.mjs gen <name> "<prompt>" [--faces N] [--rig] | status <task_id>');
  process.exit(2);
}
