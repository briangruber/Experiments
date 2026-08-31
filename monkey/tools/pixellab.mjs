#!/usr/bin/env node
// PixelLab, which is built for the thing the general image models kept failing.
//
//   PIXELLAB_API_KEY=... node tools/pixellab.mjs balance
//   node tools/pixellab.mjs character bonny --dry
//   node tools/pixellab.mjs character bonny
//   node tools/pixellab.mjs animate bonny walk
//   node tools/pixellab.mjs sheet bonny
//
// Seven general models were asked for an eight-frame walk cycle and every one
// of them failed the same way: the character drifts between frames, because
// each frame is an independent roll at who she is. The frame counts came back
// as 8, 8, 8, 7, 6, 5 and 4 for one brief, heights varied up to 23%, and the
// backgrounds needed keying out of a gradient.
//
// This API is shaped so that cannot happen. A character is a persistent entity
// — create it once, then ask for animations OF it — so consistency is
// structural rather than something a prompt has to beg for. Four more things
// fall out of that, each of which was a failure documented above:
//
//   no_background      transparent output, so no magenta key, no gradient to
//                      fight, and no dark band left under the feet
//   outline            "single color black outline" is a first-class parameter
//   frame_count        4-16, honoured, rather than however many it felt like
//   8 directions       back-facing sprites, which is the one addition that
//                      stops turning upstage being merely a hidden face
//
// Sizes run 32-256, so the 48px figure docs/asset-pack.md asks for is native
// rather than something to downscale into.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ROOT } from './harness.mjs';

const API = 'https://api.pixellab.ai/v2';
const CAST = join(ROOT, 'assets/cast');
const LEDGER = join(CAST, 'pixellab.json');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

const KEY = () => process.env.PIXELLAB_API_KEY;
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// The cast, as briefs rather than as images. `view: 'side'` matters: this is a
// side-on room, and a character generated top-down cannot be turned into one.
const CHARACTERS = {
  bonny: {
    name: 'Bonny Quill',
    description: [
      'A young woman pirate for a 1990s point-and-click adventure game.',
      'Red bandana tied over dark auburn hair, a dark red long coat open over a cream shirt,',
      'a gold sash at the waist, blue trousers, black boots.',
      'Small head, long legs, adult proportions.',
    ].join(' '),
  },
  grout: {
    name: 'Harbourmaster Grout',
    description: [
      'A weathered old harbourmaster for a 1990s point-and-click adventure game.',
      'Dark blue tricorn hat, grey beard, a teal blue long coat over a grey shirt,',
      'a brown belt, dark trousers, heavy black boots. Stocky, stooped, adult proportions.',
    ].join(' '),
  },
};

async function api(path, { method = 'POST', body, raw = false } = {}) {
  if (!KEY()) throw new Error('PIXELLAB_API_KEY is not set');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 400)}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function ledger(entry) {
  await mkdir(dirname(LEDGER), { recursive: true });
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

// Background jobs finish in minutes, not seconds, so this prints rather than
// spinning in silence.
async function wait(jobId, label) {
  let last = null;
  for (let i = 0; i < 240; i++) {
    const d = await api(`/background-jobs/${jobId}`, { method: 'GET' });
    const st = d.status || d.state;
    if (st !== last) { process.stdout.write(`\r  ${label}: ${st}      `); last = st; }
    if (['completed', 'success', 'succeeded'].includes(String(st).toLowerCase())) { process.stdout.write('\n'); return d; }
    if (['failed', 'error', 'cancelled'].includes(String(st).toLowerCase())) {
      process.stdout.write('\n');
      throw new Error(`${label}: ${st} ${JSON.stringify(d).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${label}: timed out`);
}

// --- commands ---------------------------------------------------------------

async function cmdBalance() {
  const d = await api('/balance', { method: 'GET' });
  console.log(`  credits ${d.credits}  subscription ${d.subscription ?? '—'}`);
}

async function cmdCharacter(key) {
  const c = CHARACTERS[key];
  if (!c) throw new Error(`unknown character ${key} — one of ${Object.keys(CHARACTERS)}`);
  const prior = await lookup(key, 'character');
  if (prior && !FORCE) { console.log(`  ${key}: already created (${prior.character_id}) — --force to redo`); return; }

  const body = {
    description: c.description,
    name: c.name,
    // A side-on room needs a side-on character; a top-down one cannot be
    // turned into one afterwards.
    view: 'side',
    image_size: { width: +opt('size', 64), height: +opt('size', 64) },
    no_background: true,
    outline: 'single color black outline',
    detail: 'medium detail',
    enhance_prompt: false,
  };
  if (DRY) { console.log(`  would POST /create-character-v3\n${JSON.stringify(body, null, 2)}`); return; }

  const d = await api('/create-character-v3', { body });
  console.log(`  ${key}: character ${d.character_id}  usage ${JSON.stringify(d.usage ?? {})}`);
  if (d.background_job_id) await wait(d.background_job_id, `${key} rotations`);
  await ledger({ key, kind: 'character', character_id: d.character_id, usage: d.usage ?? null, body });
}

async function cmdAnimate(key, action) {
  const ch = await lookup(key, 'character');
  if (!ch) throw new Error(`${key}: no character yet — run 'character ${key}' first`);
  const prior = await lookup(key, 'animation');
  if (prior?.action === action && !FORCE) { console.log(`  ${key}/${action}: already animated — --force to redo`); return; }

  const body = {
    character_id: ch.character_id,
    animation_name: action,
    action_description: action === 'walk' ? 'walking' : action,
    mode: 'v3',
    // Even, 4-16. Eight is a walk cycle; the general models could not be made
    // to return a fixed number at all.
    frame_count: +opt('frames', 8),
    directions: opt('directions', 'east,west,north,south').split(','),
    async_mode: true,
  };
  if (DRY) { console.log(`  would POST /animate-character\n${JSON.stringify(body, null, 2)}`); return; }

  const d = await api('/animate-character', { body });
  const jobs = d.background_job_ids || [];
  console.log(`  ${key}/${action}: ${jobs.length} job(s), directions ${(d.directions || []).join(',')}`);
  for (const [i, id] of jobs.entries()) await wait(id, `${key} ${action} ${i + 1}/${jobs.length}`);
  await ledger({ key, kind: 'animation', action, character_id: ch.character_id, jobs, body });
}

async function cmdSheet(key) {
  const ch = await lookup(key, 'character');
  if (!ch) throw new Error(`${key}: no character yet`);
  const buf = await api(`/characters/${ch.character_id}/spritesheet`, { method: 'GET', raw: true });
  // A sheet that is really an error page passes a length check and not this.
  if (buf.subarray(0, 4).toString('hex') !== '89504e47') {
    throw new Error(`not a PNG (${buf.subarray(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.')})`);
  }
  await mkdir(CAST, { recursive: true });
  const out = join(CAST, `${key}-pixellab.png`);
  await writeFile(out, buf);
  console.log(`  ${key}: sheet -> assets/cast/${key}-pixellab.png  ${(buf.length / 1024).toFixed(0)} KB`);
  console.log(`  next: node tools/sheet-cut.mjs assets/cast/${key}-pixellab.png --name ${key} --frames 8`);
  await ledger({ key, kind: 'sheet', character_id: ch.character_id, file: `assets/cast/${key}-pixellab.png`, bytes: buf.length });
}

try {
  switch (cmd) {
    case 'balance': await cmdBalance(); break;
    case 'character': await cmdCharacter(args[1]); break;
    case 'animate': await cmdAnimate(args[1], args[2] || 'walk'); break;
    case 'sheet': await cmdSheet(args[1]); break;
    default:
      console.error('usage: node tools/pixellab.mjs balance|character <key>|animate <key> <action>|sheet <key>');
      console.error(`characters: ${Object.keys(CHARACTERS).join(', ')}`);
      process.exit(1);
  }
} catch (e) {
  console.error(`\n${e.message}`);
  if (/PIXELLAB_API_KEY/.test(e.message)) {
    console.error('  Get a key at pixellab.ai, then: export PIXELLAB_API_KEY=...');
  }
  process.exit(1);
}
