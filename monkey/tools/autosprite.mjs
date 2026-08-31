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
// actually draws them — which removes a resampling step, but only down to the
// resolution the art was drawn at. Below that it is not asking for game-sized
// art, it is throwing away art that already exists, which is the mistake this
// directory has now made three times: baking a 3D mesh, downsampling the
// vector puppet, and re-extracting this cast at 80px because the room's pixel
// grid was read off a retired constant instead of measured off the plate.
// Measure both grids (tools/pixel-grid.mjs) and divide.
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
  frameCount: +opt('frames', 32),
  frameSize: +opt('size', 0),
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
// The style brief, in two halves.
//
// LOOK is how the pixels are made and is shared by everything — cast and props
// alike — because that is the whole reason to generate a prop here rather than
// repaint a vector blockout: a tin cup drawn by the same generator, on the same
// palette, with the same outline weight, sits in the scene instead of on it.
//
// FIGURE is anatomy, and only people get it. The first version of this had one
// blob including "small head, long legs", which is advice a cup cannot use.
const LOOK = [
  'HD pixel art game sprite. Chunky readable pixels, visible pixel grid, hard aliased',
  'edges, no blur, no gradients. Limited palette, clean dark outline, flat two-step',
  'shading lit warmly from the right. Flat background, no text.',
].join(' ');

const FIGURE = [
  'Side view facing right, full body.',
  'Small head, long legs, 1990s point-and-click adventure style.',
].join(' ');

const STYLE = `${FIGURE} ${LOOK}`;

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

  // Props. `isHumanoid: false` is the only structural difference, and the
  // account already has towers and barracks made this way — the generator does
  // not insist on people.
  //
  // Worth it for exactly one prop so far: the tin cup is the only thing in the
  // room that changes state, so it is the only thing that cannot be painted
  // into the backdrop and has to hold up as a sprite in its own right. The
  // others are repainted vector blockouts (tools/props.mjs), which is a
  // different lineage and looks like one.
  cup: {
    humanoid: false,
    name: 'Tin Cup on a Nail',
    prompt: [
      'A single battered tin drinking cup, dented pewter grey with a dark rim, hanging by its',
      'curved handle from an iron nail. Seen from the side, hanging still.',
      'Just the cup and its nail, nothing else, no wall and no shadow.',
      LOOK,
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
    isHumanoid: c.humanoid !== false,
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

  // The cup hangs on a nail on the tavern wall and is the one prop in the room
  // that changes state, so it is the one that has to be a sprite rather than
  // paint. Asked for at 32 pixels a frame, not 512: its own art quantises at a
  // 128px grid, and the room draws it about 24 art pixels wide, so anything
  // larger is detail that would have to be thrown away again.
  cup: [
    {
      kind: 'custom', name: 'Sway', loop: true,
      prompt: 'A battered tin cup hanging from an iron nail, swinging very gently side to side, '
        + 'a slow small sway that returns to where it started. The nail does not move. '
        + 'Just the cup and the nail, nothing else, no wall and no shadow.',
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
  // There is no default frame size worth having. The right one is derived from
  // two measured grids — the backdrop's and the character art's own — and came
  // out 176 for one of this cast and 224 for the other. A default would only
  // ever be right by accident, and the accident it invited was 64, four times
  // below what the art is drawn on, which shipped a grainy cast.
  if (!GAME.frameSize) {
    throw new Error('regen needs --size, and it is derived rather than picked:\n'
      + '    figure wanted on the sheet = drawn height / backdrop pixel block\n'
      + '    frameSize = that / how much of its frame the figure fills\n'
      + '  measure both grids with tools/pixel-grid.mjs; see docs/asset-pack.md.');
  }
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
  // Newest is not always best. Every re-extraction is kept as a version, and
  // the background remover does not do the same job at every frame size — the
  // 152px pass left a soft grey smear under Grout's boots that the 176px pass
  // did not. `--at 176` takes that version of every sheet instead.
  const AT = +opt('at', 0);
  if (AT) {
    for (const [key, row] of newest) {
      const want = sheets.filter((s) => `${s.kind}:${s.name || ''}` === key && s.frameWidth === AT)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
      if (want) newest.set(key, want);
      else console.log(`    (no ${AT}px version of ${key} — keeping the newest)`);
    }
    console.log(`    taking the ${AT}px version of each sheet`);
  }

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

// Turn a generated sheet into a prop the room can draw.
//
// src/art/props.js wants one PNG per prop, sitting in a box the game chose, so
// that regenerating a prop never moves a hotspot. A sprite sheet is not that,
// so one frame is picked and written on its own.
//
// The frame picked is the one nearest the middle of the motion, not the first.
// This cup's animation is a sway, and its first frame is the cup at one end of
// its swing — a still cup hanging permanently at a tilt, which reads as a
// mistake rather than as a cup.
async function cmdProp(key) {
  const ch = await lookup(key, 'character');
  if (!ch) throw new Error(`${key}: no character yet — run 'character ${key}' first`);
  const dir = join(OUT, key);
  const sheets = (await ledgerRows()).filter((e) => e.kind === 'sheet' && e.characterId === ch.characterId);
  const meta = sheets[sheets.length - 1]?.meta;
  if (!meta) throw new Error(`${key}: no sheet pulled yet — run 'pull ${ch.characterId}'`);
  const file = join(dir, `${slug(meta.name || meta.kind)}.png`);
  const { launch, serve } = await import('./harness.mjs');
  const { port, close } = await serve();
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/tools/sheet-cut.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ready === true);
  const uri = 'data:image/png;base64,' + (await readFile(file)).toString('base64');
  const out = await page.evaluate(async ([u, cols, count]) => {
    const img = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
    const cw = img.width / cols, ch2 = img.height / Math.ceil(count / cols);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch2;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = false;
    const centres = [];
    for (let i = 0; i < count; i++) {
      x.clearRect(0, 0, cw, ch2);
      x.drawImage(img, -(i % cols) * cw, -Math.floor(i / cols) * ch2);
      const d = x.getImageData(0, 0, cw, ch2).data;
      let lo = 1e9, hi = -1, top = 1e9, bot = -1;
      for (let y = 0; y < ch2; y++) for (let px = 0; px < cw; px++) {
        if (d[(y * cw + px) * 4 + 3] > 40) {
          if (px < lo) lo = px; if (px > hi) hi = px;
          if (y < top) top = y; if (y > bot) bot = y;
        }
      }
      centres.push(hi < 0 ? null : { i, cx: (lo + hi) / 2, box: [lo, top, hi, bot] });
    }
    const live = centres.filter(Boolean);
    const mid = [...live.map((v) => v.cx)].sort((a, b) => a - b)[live.length >> 1];
    const pick = live.reduce((a, b) => (Math.abs(b.cx - mid) < Math.abs(a.cx - mid) ? b : a));
    x.clearRect(0, 0, cw, ch2);
    x.drawImage(img, -(pick.i % cols) * cw, -Math.floor(pick.i / cols) * ch2);
    return { url: c.toDataURL('image/png'), frame: pick.i, w: cw, h: ch2, box: pick.box, of: count };
  }, [uri, meta.columns, meta.frameCount]);
  await browser.close();
  await close();
  const dest = join(ROOT, `assets/props/${key}.png`);
  await mkdir(join(ROOT, 'assets/props'), { recursive: true });
  await writeFile(dest, Buffer.from(out.url.split(',')[1], 'base64'));
  const [bx, by, bx1, by1] = out.box;
  console.log(`  assets/props/${key}.png  ${out.w}x${out.h}  from frame ${out.frame + 1}/${out.of}`
    + ` (the one nearest the middle of the motion)`);
  console.log(`  the art occupies ${bx1 - bx + 1}x${by1 - by + 1} inside it, at ${bx},${by}`);
  console.log(`  draw it 1:1 — reducing it is the mistake this project keeps making`);
  await ledger({ kind: 'prop', key, characterId: ch.characterId, frame: out.frame, file: `assets/props/${key}.png` });
}

try {
  switch (cmd) {
    case 'account': await cmdAccount(); break;
    case 'characters': await cmdCharacters(); break;
    case 'character': await cmdCharacter(args[1]); break;
    case 'animate': await cmdAnimate(args[1]); break;
    case 'regen': await cmdRegen(args[1]); break;
    case 'pull': await cmdPull(args[1]); break;
    case 'prop': await cmdProp(args[1]); break;
    default:
      console.error('usage: node tools/autosprite.mjs account|characters|character <key>'
        + '|animate <key>|regen <id>|pull <id>|prop <key>');
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
