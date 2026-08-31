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
import { join, dirname } from 'node:path';
import { ROOT } from './harness.mjs';

const API = 'https://www.autosprite.io/api/v1';
const OUT = join(ROOT, 'assets/cast/autosprite');
const LEDGER = join(OUT, 'provenance.json');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

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

// The ledger is also the memory: a character created once should not be paid
// for twice because its id scrolled out of a terminal.
async function ledgerRows() {
  if (!(await exists(LEDGER))) return [];
  return JSON.parse(await readFile(LEDGER, 'utf8'));
}

async function lookup(key, kind) {
  return [...(await ledgerRows())].reverse().find((e) => e.key === key && e.kind === kind) || null;
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  return buf;
}

// Sheets are named by `kind`, and every character has a `walk` and an `idle`.
// Pulling a second character on top of a first therefore silently replaces the
// first one's source art with art of somebody else — which is exactly what
// happened here once already, Grout landing on Bonny's walk.png. Every pull
// goes under the character's own folder now, and the folder name comes from
// the character record rather than from whatever was typed on the command
// line, so it cannot drift.
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function folderFor(characterId) {
  const known = (await ledgerRows()).find((e) => e.kind === 'character' && e.characterId === characterId);
  if (known) return known.key;
  const list = await api('/characters?limit=100');
  const c = (list.characters || []).find((x) => x.id === characterId);
  if (!c) throw new Error(`no such character ${characterId}`);
  return slug(c.name).replace(/^(harbourmaster|captain|the)-/, '');
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

// The cast, as briefs. The style lives in the prompt because the API has no
// equivalent of the app's "Choose Vibe" — that picker is a prompt template on
// the UI side, and `usePromptTemplate` is a separate flag that applies
// AutoSprite's own generic one. So the pixel-art direction is stated outright,
// and stated the same way for every character, which is what keeps a cast
// looking like one cast.
// The app's "Choose Vibe" picker has no equivalent in the API — the create
// endpoint takes name, prompt, usePromptTemplate, isHumanoid,
// characterDescription and quality, and nothing else. So the vibe the picker
// would have set ("HD Pixel Art") is written into the prompt instead, in the
// same words for every character, because a cast reads as one cast only if the
// style sentence is literally identical across it.
//
// It is stated in terms of pixels rather than of eras: "chunky readable
// pixels, visible pixel grid" is a thing a generator can aim at, where "90s
// adventure game" on its own has produced smooth digital paintings of pirates
// every time this project has asked for it.
const STYLE = [
  'HD pixel art game sprite. Chunky readable pixels, visible pixel grid, hard aliased',
  'edges, no blur, no gradients. Limited palette, clean dark outline, flat two-step',
  'shading lit warmly from the right. Side view facing right, full body.',
  'Small head, long legs, 1990s point-and-click adventure style. Flat background, no text.',
].join(' ');

const CHARACTERS = {
  grout: {
    // The name has to be new: the API rejects a duplicate, and the first Grout
    // still exists in the account (kept on disk as grout-v1 in case this one
    // comes back worse).
    name: 'Grout, Harbourmaster',
    prompt: [
      'A stocky weathered old harbourmaster standing with arms folded, tired and unimpressed.',
      'Battered dark blue tricorn, grey hair, thick grey beard. Long teal-blue naval coat with',
      'brass buttons, grey shirt, brown belt, dark trousers, heavy black sea boots.',
      STYLE,
    ].join(' '),
  },
};

async function cmdCharacter(key) {
  const c = CHARACTERS[key];
  if (!c) throw new Error(`unknown character ${key} — one of ${Object.keys(CHARACTERS)}`);
  const prior = await lookup(key, 'character');
  if (prior && !FORCE) { console.log(`  ${key}: already created (${prior.characterId}) — --force to redo`); return; }
  // The cap is 600 characters and the API does not complain about a longer
  // one — it would simply be cut, mid-sentence, silently. This project has
  // already paid once for a prompt that was quietly truncated.
  if (c.prompt.length > 600) {
    throw new Error(`${key}: prompt is ${c.prompt.length} chars, the cap is 600`);
  }
  const body = {
    name: c.name,
    prompt: c.prompt,
    isHumanoid: true,
    // AutoSprite's own template is generic; the brief above is specific and
    // shared across the cast, so it does the work instead.
    usePromptTemplate: false,
    quality: opt('quality', 'pro'),
    characterDescription: c.prompt.slice(0, 1000),
  };
  if (DRY) { console.log(`  would POST /characters\n${JSON.stringify(body, null, 2)}`); return; }
  const d = await api('/characters', { method: 'POST', body });
  console.log(`  ${key}: ${d.id}  "${d.name}"`);
  await ledger({ kind: 'character', key, characterId: d.id, body, response: d });
  console.log(`  next: node tools/autosprite.mjs animate ${key}`);
}

// What this room actually asks of a character, rather than a full move set.
// Grout stands in the way, and then he does not: he takes the grog and slumps.
// The game currently makes him vanish at that moment, which is a placeholder
// for exactly this.
const ANIMATIONS = {
  // What this room asks of him, and no more. He stands in the way; he walks;
  // he takes the grog and drinks it; he slumps and sleeps. The sleeping loop
  // is not generated — the tail of "Fall asleep" is already a slumped man
  // breathing, and the atlas cuts that stretch out as its own looping clip.
  // Generation costs credits; slicing does not.
  grout: [
    { kind: 'idle', loop: true },
    { kind: 'walk', loop: true },
    {
      kind: 'custom', name: 'Drink',
      prompt: 'The old harbourmaster raises a tin cup to his mouth with both hands and drinks '
        + 'deeply, head tipping back, then lowers the cup and wipes his beard with the back '
        + 'of his hand. He stays standing in one place. Side view, facing right.',
      loop: false,
    },
    {
      kind: 'custom', name: 'Asleep', loop: true,
      // Two failures got this to the right shape of brief.
      //
      // "with his back against a post" drew a post, welded into all thirty-two
      // frames, in a room that has its own posts painted into the backdrop. A
      // character animation must contain the character and nothing else, and
      // that has to be refused outright — asking for a pose implies its
      // furniture unless the furniture is named and excluded.
      //
      // Then "he stands, then his knees give way and he slides down to sit"
      // drew two harbourmasters, the standing one and the seated one, in the
      // same frame — a video model given a before and an after will show you
      // both. So this asks for no transition at all: one continuous state, the
      // thing a loop actually is. The falling-over is carried by the dialogue,
      // which already pauses on `zzzzzz`, and what the room needs from the art
      // is simply a sleeping man who is still there.
      prompt: 'The old harbourmaster is fast asleep sitting on the ground with his legs out in '
        + 'front of him, chin down on his chest, tricorn tipped forward over his eyes, arms limp '
        + 'at his sides. He stays asleep in exactly this pose the whole time and only breathes '
        + 'slowly. One character alone: no post, no wall, no barrel, no furniture, no props. '
        + 'Side view, facing right.',
    },
  ],
};

async function cmdAnimate(key) {
  const ch = await lookup(key, 'character');
  if (!ch) throw new Error(`${key}: no character yet — run 'character ${key}' first`);
  let list = ANIMATIONS[key];
  if (!list) throw new Error(`${key}: no animation set defined`);
  // Regenerating one beat should not pay for the other three again.
  const only = opt('only', null);
  if (only) {
    list = list.filter((a) => (a.name || a.kind).toLowerCase() === only.toLowerCase());
    if (!list.length) throw new Error(`${key}: no animation named ${only}`);
  }
  const body = {
    animations: list,
    videoTier: opt('tier', 'turbo'),
    frameCount: +opt('frames', 25),
    // 256 matches the frames already in the cast, so the two characters end up
    // at the same pixel density rather than one looking softer than the other.
    frameSize: +opt('size', 256),
    removeBg: opt('bg', 'ultra'),
  };
  if (DRY) { console.log(`  would POST /characters/${ch.characterId}/spritesheets\n${JSON.stringify(body, null, 2)}`); return; }
  const d = await api(`/characters/${ch.characterId}/spritesheets`, { method: 'POST', body });
  // The response names them under `workflows`, not any of the obvious keys —
  // and an empty list here would mean the tool returns while the art is still
  // being made, so the shape is read rather than guessed at.
  const jobs = (d.workflows || d.jobIds || d.jobs || []).map((j) => (typeof j === 'string' ? j : j.jobId || j.id));
  if (!jobs.length) throw new Error(`no job ids in response: ${JSON.stringify(d).slice(0, 300)}`);
  console.log(`  ${key}: ${jobs.length || '?'} job(s) — ${JSON.stringify(d).slice(0, 200)}`);
  for (const j of jobs) await waitJob(j);
  await ledger({ kind: 'animations', key, characterId: ch.characterId, body, response: d });
  console.log(`  next: node tools/autosprite.mjs pull ${ch.characterId}`);
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
  // The character record carries no sheet ids; the listing endpoint does, and
  // returns the download URLs with them. (Documented as POST for generation,
  // it also answers GET with a list — checked rather than assumed.)
  const list = opt('sheets', null)
    ? { spritesheets: opt('sheets').split(',').map((id) => ({ id })) }
    : await api(`/characters/${characterId}/spritesheets`);
  const sheets = list.spritesheets || [];
  if (!sheets.length) { console.error('  no spritesheets on this character'); process.exit(1); }
  const who = await folderFor(characterId);
  const dir = join(OUT, who);
  await mkdir(dir, { recursive: true });
  console.log(`  ${who}/`);

  // Re-extracting at a different frame size ADDS sheets rather than replacing
  // them, so a character that has been regenerated once lists every kind
  // twice. Which of the two is the current one is not a matter of listing
  // order — it is the newer one — so the pull picks by timestamp and says what
  // it skipped, instead of writing both under names that differ by a hash and
  // leaving the atlas to be cut from whichever landed first.
  const newest = new Map();
  for (const row of sheets) {
    const key = `${row.kind}:${row.name || ''}`;
    const prev = newest.get(key);
    if (!prev || (row.createdAt || '') > (prev.createdAt || '')) newest.set(key, row);
  }
  const superseded = sheets.length - newest.size;
  if (superseded) console.log(`    (${superseded} superseded sheet(s) skipped — an older re-extraction)`);

  const seen = new Set();
  for (const row of newest.values()) {
    const s = row.sheetUrl ? row : await api(`/spritesheets/${row.id}`);
    // Custom animations all report kind "custom", so several of them would
    // collide on one filename the same way two characters collided on one
    // folder. The animation's own name is what distinguishes them.
    let base = s.kind === 'custom' && s.name ? slug(s.name) : (s.kind || row.id);
    if (seen.has(base)) base = `${base}-${row.id.slice(-6)}`;
    seen.add(base);
    const rel = `assets/cast/autosprite/${who}/${base}.png`;
    const png = await download(s.sheetUrl, join(dir, `${base}.png`));
    let atlas = null;
    if (s.atlasUrl) atlas = (await download(s.atlasUrl, join(dir, `${base}.atlas.json`))).length;
    console.log(`    ${base.padEnd(12)} ${s.frameCount} frames  ${s.frameWidth}x${s.frameHeight}  `
      + `${s.columns} cols  ${(png.length / 1024).toFixed(0)} KB${atlas ? ' +atlas' : ''}`);
    // The signed download URLs are stripped before the record is written. They
    // expire in a day, so they are worthless as a record, and they are a
    // read grant on the user's account that has no business in a committed
    // file — while carrying them made the ledger a hundred and fifty
    // kilobytes of dead query strings.
    const { sheetUrl, atlasUrl, thumbnailUrl, rmVideoBgUrl, ...meta } = s;
    await ledger({ kind: 'sheet', who, characterId, spritesheetId: row.id, meta, file: rel });
    const rows = Math.ceil((s.frameCount || 25) / (s.columns || 5));
    console.log(`      cut: node tools/sheet-cut.mjs ${rel} --name ${who}-${base} --grid ${s.columns}x${rows}`);
  }
}

try {
  switch (cmd) {
    case 'account': await cmdAccount(); break;
    case 'characters': await cmdCharacters(); break;
    case 'character': await cmdCharacter(args[1]); break;
    case 'animate': await cmdAnimate(args[1]); break;
    case 'regen': await cmdRegen(args[1]); break;
    case 'pull': await cmdPull(args[1]); break;
    default:
      console.error('usage: node tools/autosprite.mjs account|characters|character <key>'
        + '|animate <key>|regen <id>|pull <id>');
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
