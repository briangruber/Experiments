#!/usr/bin/env node
// AutoSprite, which returns the format docs/asset-pack.md asks for.
//
//   AUTOSPRITE_API_KEY=vspk_... node tools/autosprite.mjs account
//   node tools/autosprite.mjs characters
//   node tools/autosprite.mjs regen <characterId> --dry
//   node tools/autosprite.mjs regen <characterId>
//   node tools/autosprite.mjs pull <characterId>
//
// Two things in this API matter more than the generation quality, and both
// were invisible from the app's UI.
//
// `frameSize` takes 32-512, so frames can be asked for at the size the game
// actually draws them. Every previous route in this project produced art at
// some large size and reduced it, and reducing a smooth source to forty pixels
// is the single mistake this directory has now made twice — once baking a 3D
// mesh, once downsampling the vector puppet. Asking for 64 instead of 256
// removes the step entirely.
//
// `regenerate-spritesheets` re-extracts from the videos that were already
// generated, at a different frame count, frame size and background-removal
// setting, and it is FREE. So the 25-frame 256px sheets made in the app do not
// need regenerating at cost — they need re-extracting at game settings, which
// is the same videos read differently.

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const API = 'https://www.autosprite.io/api/v1';
const OUT = join(ROOT, 'assets/cast/autosprite');
const LEDGER = join(OUT, 'provenance.json');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');

const KEY = () => process.env.AUTOSPRITE_API_KEY;
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// What this game wants, as opposed to what the app's defaults give. The app
// made 25 frames at 256px; a 720p room draws the character about 150px tall,
// and a walk cycle is eight poses.
const GAME = {
  frameCount: +opt('frames', 8),
  frameSize: +opt('size', 64),
  // "ultra" is AI-powered removal. The generated sheets from other services
  // needed the background keyed by hand and still left a dark line under the
  // feet; paying nothing to have it done properly is an easy trade.
  removeBg: opt('bg', 'ultra'),
  sharpen: opt('sharpen', 'light'),
};

async function api(path, { method = 'GET', body, form } = {}) {
  if (!KEY()) throw new Error('AUTOSPRITE_API_KEY is not set');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-api-key': KEY(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function ledger(entry) {
  await mkdir(OUT, { recursive: true });
  let log = [];
  if (await exists(LEDGER)) log = JSON.parse(await readFile(LEDGER, 'utf8'));
  log.push({ ...entry, at: new Date().toISOString() });
  await writeFile(LEDGER, JSON.stringify(log, null, 2) + '\n');
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(OUT, { recursive: true });
  await writeFile(path, buf);
  return buf;
}

// Jobs report their internal steps, so this prints which one is running rather
// than an opaque spinner.
async function waitJob(jobId) {
  let last = '';
  for (let i = 0; i < 300; i++) {
    const d = await api(`/jobs/${jobId}`);
    const step = (d.steps || []).find((s) => s.status === 'running')?.label || d.status;
    const line = `${d.status} ${d.progress ? `${d.progress.completed}/${d.progress.total}` : ''} ${step || ''}`;
    if (line !== last) { process.stdout.write(`\r  ${jobId}: ${line.padEnd(46)}`); last = line; }
    if (d.status === 'succeeded') { process.stdout.write('\n'); return d; }
    if (d.status === 'failed') { process.stdout.write('\n'); throw new Error(`${jobId}: ${d.error || 'failed'}`); }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`${jobId}: timed out`);
}

// --- commands ---------------------------------------------------------------

async function cmdAccount() {
  const d = await api('/account');
  console.log('  ' + JSON.stringify(d));
}

async function cmdCharacters() {
  const d = await api(`/characters?limit=${+opt('limit', 20)}`);
  for (const c of d.characters || []) {
    console.log(`  ${c.id}  ${String(c.name).padEnd(24)} humanoid=${c.isHumanoid}  ${c.createdAt || ''}`);
  }
  if (!d.characters?.length) console.log('  (no characters)');
}

async function cmdRegen(characterId) {
  if (!characterId) throw new Error('need a character id — run `characters` first');
  const body = { ...GAME };
  if (DRY) {
    console.log(`  would POST /characters/${characterId}/regenerate-spritesheets`);
    console.log('  ' + JSON.stringify(body, null, 2).replace(/\n/g, '\n  '));
    console.log('  (free — re-extracts the existing videos, no credits)');
    return;
  }
  const d = await api(`/characters/${characterId}/regenerate-spritesheets`, { method: 'POST', body });
  console.log('  ' + JSON.stringify(d).slice(0, 300));
  const jobs = d.jobIds || d.jobs || (d.jobId ? [d.jobId] : []);
  for (const j of jobs) await waitJob(typeof j === 'string' ? j : j.jobId);
  await ledger({ kind: 'regenerate', characterId, body, response: d });
  console.log(`  now: node tools/autosprite.mjs pull ${characterId}`);
}

async function cmdPull(characterId) {
  if (!characterId) throw new Error('need a character id');
  // The sheet ids come from the character record or from a regenerate/animate
  // response; both shapes are accepted rather than assumed.
  const ids = opt('sheets', null)?.split(',')
    || (await api(`/characters/${characterId}`).catch(() => ({})))?.spritesheetIds
    || [];
  if (!ids.length) {
    console.error('  no spritesheet ids found on the character record.');
    console.error('  pass them directly:  --sheets ss_001,ss_002');
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });
  for (const id of ids) {
    const s = await api(`/spritesheets/${id}`);
    const base = `${s.kind || id}`;
    const png = await download(s.sheetUrl, join(OUT, `${base}.png`));
    let atlas = null;
    if (s.atlasUrl) {
      const a = await download(s.atlasUrl, join(OUT, `${base}.atlas.json`));
      atlas = a.length;
    }
    console.log(`  ${base.padEnd(10)} ${s.frameCount} frames  ${s.frameWidth}x${s.frameHeight}  `
      + `${s.columns} cols  ${(png.length / 1024).toFixed(0)} KB${atlas ? ' +atlas' : ''}`);
    await ledger({ kind: 'sheet', characterId, spritesheetId: id, meta: s, file: `assets/cast/autosprite/${base}.png` });
    const rows = Math.ceil(s.frameCount / s.columns);
    console.log(`    cut: node tools/sheet-cut.mjs assets/cast/autosprite/${base}.png `
      + `--name ${base} --grid ${s.columns}x${rows}`);
  }
}

try {
  switch (cmd) {
    case 'account': await cmdAccount(); break;
    case 'characters': await cmdCharacters(); break;
    case 'regen': await cmdRegen(args[1]); break;
    case 'pull': await cmdPull(args[1]); break;
    default:
      console.error('usage: node tools/autosprite.mjs account|characters|regen <id>|pull <id>');
      process.exit(1);
  }
} catch (e) {
  console.error(`\n${e.message}`);
  if (/AUTOSPRITE_API_KEY/.test(e.message)) {
    console.error('  The key is injected when the container starts, so a key added to the');
    console.error('  environment mid-session is not visible until the session is restarted.');
  }
  process.exit(1);
}
